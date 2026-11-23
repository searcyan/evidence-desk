"""受大小和超时限制的公开网页正文回退读取。"""

import asyncio
from ipaddress import ip_address, ip_network
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup

from .dates import publication
from .search import Page

MAX_BYTES = 2_000_000


# Clash/Surge 等代理的 fake-ip 模式会把域名解析到 198.18.0.0/15，经代理访问时视为公网
FAKE_IP = (ip_network("198.18.0.0/15"), ip_network("2001:2::/48"))


async def public_target(url: str, via_proxy: bool = False) -> tuple[str, str, str]:
    parts = urlsplit(url)
    hostname = parts.hostname
    if (
        parts.scheme not in ("http", "https")
        or not hostname
        or parts.username
        or parts.port not in (None, 80, 443)
        or hostname.endswith(".local")
    ):
        raise ValueError("只允许公开 HTTP 网页")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    records = await asyncio.get_running_loop().getaddrinfo(hostname, port, type=1)
    addresses = [address[0] for _, _, _, _, address in records]

    def allowed(address: str) -> bool:
        ip = ip_address(address)
        return ip.is_global or (via_proxy and any(ip in net for net in FAKE_IP))

    if not addresses or not all(allowed(str(address)) for address in addresses):
        raise ValueError("目标地址不在公网")
    ip = str(addresses[0])
    target = f"[{ip}]" if ":" in ip else ip
    return (
        urlunsplit((parts.scheme, f"{target}:{port}", parts.path, parts.query, "")),
        parts.netloc,
        hostname,
    )


def extract(url: str, final_url: str, html: str) -> Page:
    soup = BeautifulSoup(html, "html.parser")

    def meta(*keys: str) -> str | None:
        for key in keys:
            tag = soup.find("meta", attrs={"property": key}) or soup.find(
                "meta", attrs={"name": key}
            )
            value = tag.get("content") if tag else None
            if isinstance(value, str) and value.strip():
                return value
        return None

    published = publication(meta("article:published_time", "datePublished", "date", "pubdate"))
    title = meta("og:title") or (soup.title.get_text(strip=True) if soup.title else "")
    publisher, author = meta("og:site_name"), meta("author", "article:author")
    language = soup.html.get("lang") if soup.html else None
    text = ""
    try:
        from htmldate import find_date  # type: ignore
        from trafilatura import bare_extraction  # type: ignore
    except ImportError:
        pass
    else:
        document = bare_extraction(html, url=final_url, with_metadata=True)
        if document is not None:
            # 不同版本的 trafilatura 可能返回 Document 对象或 dict，统一按属性/键读取
            def field(name: str) -> str | None:
                value = (
                    document.get(name)
                    if isinstance(document, dict)
                    else getattr(document, name, None)
                )
                return value if isinstance(value, str) and value else None

            text = field("text") or ""
            title, publisher = field("title") or title, field("sitename") or publisher
            author, language = field("author") or author, field("language") or language
        published = published or publication(
            find_date(html, extensive_search=False, original_date=True)
        )
    if not text:
        for node in soup.select("script, style, nav, footer, header, aside, form"):
            node.decompose()
        body = soup.find("article") or soup.find("main") or soup.body or soup
        text = body.get_text("\n", strip=True)
    if not text:
        raise ValueError("未提取到网页正文")
    return Page(
        url=url,
        final_url=final_url,
        title=title,
        text=text,
        published_at=published,
        published_at_source="metadata" if published else "unknown",
        publisher=publisher,
        author=author,
        language=language if isinstance(language, str) else None,
    )


async def read_public(client: httpx.AsyncClient, url: str, via_proxy: bool = False) -> Page:
    """读取公开网页。

    无代理时按本地解析出的公网 IP 直连（防止 DNS 重绑定）；
    配置了代理时，本地解析只用于拒绝内网地址，请求按主机名交给代理远程解析，
    以免本地 DNS 污染导致境外站点连到错误 IP。
    """
    current = url
    async with asyncio.timeout(20):
        for _ in range(5):
            target, host, hostname = await public_target(current, via_proxy)
            request_url = current if via_proxy else target
            async with client.stream(
                "GET",
                request_url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; NewsAgent/0.1)"}
                | ({} if via_proxy else {"Host": host}),
                extensions={} if via_proxy else {"sni_hostname": hostname},
                follow_redirects=False,
            ) as response:
                if response.is_redirect and "location" in response.headers:
                    current = urljoin(current, response.headers["location"])
                    continue
                response.raise_for_status()
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_BYTES:
                        raise ValueError("网页超过大小限制")
                html = content.decode(response.encoding or "utf-8", errors="replace")
                return await asyncio.to_thread(extract, url, current, html)
    raise ValueError("网页重定向次数过多")
