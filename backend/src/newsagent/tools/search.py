"""统一两家实时搜索服务的参数与结果。"""

from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from pydantic import BaseModel

from ..contracts import models as m
from .dates import publication

Provider = Literal["tavily", "exa", "corpus", "http", "cache"]
PublicationSource = Literal["metadata", "search_api", "content", "unknown"]


class SearchHit(BaseModel):
    url: str
    title: str = ""
    snippet: str = ""
    published_at: str | None = None
    score: float | None = None
    doc_id: str | None = None


class Page(BaseModel):
    url: str
    final_url: str
    title: str
    text: str
    published_at: str | None = None
    published_at_source: PublicationSource = "unknown"
    author: str | None = None
    publisher: str | None = None
    language: str | None = None
    doc_id: str | None = None


def normalize_query(value: str) -> str:
    return " ".join(value.casefold().split())


def canonical_url(value: str) -> str:
    url = urlsplit(value)
    query = sorted(
        (k, v)
        for k, v in parse_qsl(url.query, keep_blank_values=True)
        if not k.startswith("utm_") and k not in ("fbclid", "gclid")
    )
    return urlunsplit(
        (url.scheme.lower(), url.netloc.lower(), url.path or "/", urlencode(query), "")
    )


# 社交、视频与问答站点：不是新闻来源，读取它们只会浪费工具预算
BLOCKED_DOMAINS = (
    "linkedin.com",
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "pinterest.com",
    "reddit.com",
    "quora.com",
)


def blocked(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return any(host == d or host.endswith("." + d) for d in BLOCKED_DOMAINS)


def is_redirect(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host.startswith(("www.google.", "google.")) and parts.path == "/url":
        return True
    # Tavily 自有的公司知识页不是新闻来源
    return host.endswith("tavily.com")


class WebSearch:
    def __init__(self, client: httpx.AsyncClient, name: Literal["tavily", "exa"], key: str):
        self.client = client
        self.name: Literal["tavily", "exa"] = name
        self.headers = (
            {"Authorization": f"Bearer {key}"}
            if name == "tavily"
            else {
                "x-api-key": key,
            }
        )

    async def request(self, endpoint: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        result = await self.client.post(
            f"https://api.{self.name}.{'com' if self.name == 'tavily' else 'ai'}/{endpoint}",
            headers=self.headers,
            json=payload,
        )
        result.raise_for_status()
        return result.json()["results"]

    async def search(
        self, query: str, window: m.TimeWindow | None, count: int, exclude: list[str]
    ) -> list[SearchHit]:
        if self.name == "tavily":
            payload: dict[str, Any] = {
                "query": query[:400],
                "topic": "news",
                "max_results": count,
                "exclude_domains": [*exclude, *BLOCKED_DOMAINS],
            }
            if window:
                payload.update(start_date=window.start, end_date=window.end)
        else:
            payload = {
                "query": query,
                "type": "auto",
                "numResults": count,
                "excludeDomains": [*exclude, *BLOCKED_DOMAINS],
                "contents": {"highlights": True},
            }
            if window:
                payload.update(
                    startPublishedDate=f"{window.start}T00:00:00Z",
                    endPublishedDate=f"{window.end}T23:59:59Z",
                )
        hits = []
        for item in await self.request("search", payload):
            # 过滤搜索引擎跳转链接（无法读取正文，也不是真实来源）
            if item.get("url") and not is_redirect(item["url"]) and not blocked(item["url"]):
                hits.append(
                    SearchHit(
                        url=item["url"],
                        title=item.get("title") or "",
                        snippet=item.get("content") or " ".join(item.get("highlights") or []),
                        published_at=publication(
                            item.get("published_date") or item.get("publishedDate")
                        ),
                        score=item.get("score"),
                    )
                )
        return hits

    async def read(self, url: str) -> Page:
        if self.name == "tavily":
            results = await self.request(
                "extract",
                {
                    "urls": [url],
                    "format": "text",
                },
            )
        else:
            results = await self.request(
                "contents", {"urls": [url], "text": {"maxCharacters": 60000}}
            )
        if not results:
            raise ValueError("检索服务未返回正文")
        item = results[0]
        text = item.get("raw_content") or item.get("text") or ""
        if not text.strip() or len(text.encode()) > 2_000_000:
            raise ValueError("正文为空或超过大小限制")
        published = publication(item.get("published_date") or item.get("publishedDate"))
        return Page(
            url=url,
            final_url=item.get("url") or url,
            title=item.get("title") or "",
            text=text,
            published_at=published,
            published_at_source="search_api" if published else "unknown",
            author=item.get("author"),
        )
