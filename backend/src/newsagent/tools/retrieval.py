"""运行内的搜索、读取、预算计量与缓存。"""

import asyncio
import json
import os
from collections import Counter
from collections.abc import Awaitable, Callable
from pathlib import Path
from time import monotonic, time
from typing import Literal
from urllib.parse import urlsplit

import httpx

from ..contracts import models as m
from ..runtime.budget import BudgetExceeded, BudgetTracker
from ..runtime.events import EventBus
from ..runtime.state import new_id, now
from ..settings import Configuration, env_value
from .corpus_index import CORPUS_DIR, CorpusIndex, open_corpus
from .local_index import LocalIndex, open_index
from .reader import read_public
from .search import Page, Provider, SearchHit, WebSearch, canonical_url, normalize_query
from .storage import file_key, read_json, write_json

NETWORK_FAILURES = (httpx.HTTPError, OSError, ValueError, KeyError, TypeError, TimeoutError)


class Retrieval:
    def __init__(
        self,
        bus: EventBus,
        tracker: BudgetTracker,
        config: Configuration,
        client: httpx.AsyncClient,
        direct: httpx.AsyncClient,
        cache_hours: float,
    ):
        self.bus, self.tracker, self.config = bus, tracker, config
        self.root = bus.store.path.parent
        self.run_cache = self.root / "retrieval" / bus.state.id
        self.direct = direct
        self.cache_seconds = cache_hours * 3600
        self.providers: dict[str, WebSearch] = {}
        for provider in ("tavily", "exa"):
            if key := env_value(provider.upper() + "_API_KEY"):
                name: Literal["tavily", "exa"] = "tavily" if provider == "tavily" else "exa"
                self.providers[provider] = WebSearch(client, name, key)
        request = bus.state.request
        self.local_path = (
            self.root / CORPUS_DIR
            if request.search_mode == "corpus"
            else (
                self.root / "snapshots" / (request.snapshot_id or "") / "documents.jsonl"
                if request.search_mode == "snapshot"
                else None
            )
        )
        self.index: LocalIndex | CorpusIndex | None = None
        self.index_lock = asyncio.Lock()
        self.failed_domains: Counter[str] = Counter()

    async def local(self) -> LocalIndex | CorpusIndex:
        async with self.index_lock:
            if self.index is None:
                if self.local_path is None:
                    raise RuntimeError("未配置本地语料")
                path = self.local_path
                if self.bus.state.request.search_mode == "corpus":
                    self.index = await asyncio.to_thread(open_corpus, path)
                else:
                    self.index = await asyncio.to_thread(open_index, path)
            return self.index

    def cached(self, path: Path, permanent: bool = False) -> object | None:
        try:
            item = read_json(path)
            if permanent or time() - item["at"] <= self.cache_seconds:
                return item["value"]
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    def tool_event(
        self,
        action_id: str | None,
        operation: Literal["search", "read"],
        provider: Provider,
        value: str,
        started: float,
        count: int | None,
        *,
        cached: bool = False,
        error: str | None = None,
    ) -> None:
        self.bus.emit(
            "tool.called",
            m.ToolCall(
                id=new_id("tc"),
                action_id=action_id,
                tool=operation,
                provider=provider,
                input=value,
                ok=error is None,
                result_count=count,
                duration_ms=int((monotonic() - started) * 1000),
                cached=cached,
                error=error,
                at=now(),
            ),
        )

    async def search(
        self, action: m.ResearchAction, excluded: list[str], research: bool
    ) -> tuple[list[SearchHit], Provider]:
        output = self.run_cache / f"{action.id}.json"
        if output.is_file():
            recorded = read_json(output)
            return [SearchHit.model_validate(hit) for hit in recorded["hits"]], recorded["provider"]

        def record(hits: list[SearchHit], provider: Provider) -> None:
            write_json(output, {"provider": provider, "hits": [hit.model_dump() for hit in hits]})

        query = action.params.query or ""
        window = action.params.window
        count = self.config.research.search_results_per_query
        if self.local_path:
            self.tracker.tool("search", research)
            started = monotonic()
            try:
                async with asyncio.timeout(self.tracker.seconds_left(research)):
                    index = await self.local()
                    hits = await asyncio.to_thread(index.search, query, window, count, excluded)
                self.tool_event(
                    action.id, "search", "corpus", query, started, len(hits), cached=True
                )
                record(hits, "corpus")
                return hits, "corpus"
            except NETWORK_FAILURES as exc:
                self.tool_event(
                    action.id, "search", "corpus", query, started, None, error="本地检索失败"
                )
                raise ValueError("本地检索失败") from exc

        order = (
            self.config.research.verification_order
            if action.type in ("trace_origin", "corroborate")
            else self.config.research.news_order
        )
        for name in order:
            provider = self.providers.get(name)
            if provider is None:
                continue
            started = monotonic()
            key = json.dumps(
                [
                    name,
                    normalize_query(query),
                    window.model_dump() if window else None,
                    count,
                    sorted(excluded),
                ],
                ensure_ascii=False,
                sort_keys=True,
            )
            path = self.root / "cache/search" / (file_key(key) + ".json")
            self.tracker.tool("search", research)
            try:
                cached = self.cached(path)
                if isinstance(cached, list):
                    hits = [SearchHit.model_validate(item) for item in cached]
                else:
                    async with asyncio.timeout(self.tracker.seconds_left(research)):
                        hits = await provider.search(query, window, count, excluded)
                    write_json(path, {"at": time(), "value": [hit.model_dump() for hit in hits]})
                self.tool_event(
                    action.id,
                    "search",
                    "cache" if cached is not None else provider.name,
                    query,
                    started,
                    len(hits),
                    cached=cached is not None,
                )
                record(hits, provider.name)
                return hits, provider.name
            except NETWORK_FAILURES:
                self.tool_event(
                    action.id,
                    "search",
                    provider.name,
                    query,
                    started,
                    None,
                    error="搜索服务调用失败",
                )
                self.bus.emit(
                    "log",
                    {"level": "warning", "message": f"{provider.name} 搜索失败，尝试备用服务"},
                )
        raise ValueError("没有可用的实时搜索服务")

    async def read(
        self,
        url: str,
        hit: SearchHit | None,
        provider: Provider | None,
        action_id: str | None,
        research: bool,
    ) -> tuple[Page, Provider]:
        url = canonical_url(url)
        saved_path = self.run_cache / "pages" / (file_key(url) + ".json")
        if saved_path.is_file():
            saved = read_json(saved_path)
            return Page.model_validate(saved["value"]), saved["provider"]

        def preserve(page: Page, name: Provider) -> None:
            data = {"provider": name, "value": page.model_dump()}
            write_json(saved_path, data)
            final = self.run_cache / "pages" / (file_key(canonical_url(page.final_url)) + ".json")
            if final != saved_path:
                write_json(final, data)

        started = monotonic()
        if self.local_path:
            self.tracker.tool("read", research)
            try:
                async with asyncio.timeout(self.tracker.seconds_left(research)):
                    page = (await self.local()).read(url)
                self.tool_event(action_id, "read", "corpus", url, started, 1, cached=True)
                preserve(page, "corpus")
                return page, "corpus"
            except NETWORK_FAILURES as exc:
                self.tool_event(
                    action_id, "read", "corpus", url, started, None, error="本地正文读取失败"
                )
                raise ValueError("本地正文读取失败") from exc

        path = self.root / "cache/pages" / (file_key(url) + ".json")
        publication_hint = hit.published_at if hit else None

        def with_hint(page: Page) -> Page:
            if page.published_at is None and publication_hint:
                return page.model_copy(
                    update={"published_at": publication_hint, "published_at_source": "search_api"}
                )
            return page

        cached = self.cached(path)
        if cached is not None:
            self.tracker.tool("read", research)
            self.tool_event(action_id, "read", "cache", url, started, 1, cached=True)
            page = with_hint(Page.model_validate(cached))
            preserve(page, "cache")
            return page, "cache"

        service = self.providers.get(provider or "")
        services: list[tuple[Provider, Callable[[str], Awaitable[Page]]]] = (
            [(service.name, service.read)] if service else []
        )
        via_proxy = proxy_configured()
        services.append(("http", lambda target: read_public(self.direct, target, via_proxy)))
        domain = urlsplit(url).hostname or ""
        if self.failed_domains[domain] >= 2:
            # 同一域名已连续失败两次（付费墙 / 拒绝爬虫）：不再尝试读取，直接用搜索摘要兜底
            services = []
        # 一个 URL 的读取只计一次工具调用，内部回退（检索服务 → 直接读取 → 摘要）不重复计费
        self.tracker.tool("read", research)
        for name, read in services:
            if self.tracker.seconds_left(research) <= 0:
                raise BudgetExceeded("time_limit")
            started = monotonic()
            try:
                async with asyncio.timeout(self.tracker.seconds_left(research)):
                    page = with_hint(await read(url))
                value = {"at": time(), "value": page.model_dump()}
                write_json(path, value)
                final = (
                    self.root / "cache/pages" / (file_key(canonical_url(page.final_url)) + ".json")
                )
                if final != path:
                    write_json(final, value)
                self.tool_event(action_id, "read", name, url, started, 1)
                preserve(page, name)
                return page, name
            except NETWORK_FAILURES:
                self.tool_event(action_id, "read", name, url, started, None, error="正文读取失败")
        if services:
            self.failed_domains[domain] += 1
        snippet = hit.snippet.strip() if hit else ""
        if hit and len(snippet) >= 200:
            # 正文不可读时退而使用搜索服务返回的原文摘要（真实原文片段），发布时间来自搜索 API
            page = Page(
                url=url,
                final_url=url,
                title=hit.title,
                text=snippet,
                published_at=hit.published_at,
                published_at_source="search_api" if hit.published_at else "unknown",
            )
            self.tool_event(action_id, "read", "cache", url, monotonic(), 1, cached=True)
            preserve(page, "cache")
            return page, "cache"
        raise ValueError("未取得可用正文")

    def page(self, document: m.SourceDocument) -> Page | None:
        key = file_key(canonical_url(document.url)) + ".json"
        saved = self.run_cache / "pages" / key
        if saved.is_file():
            return Page.model_validate(read_json(saved)["value"])
        if self.index:
            try:
                return self.index.read(document.url)
            except KeyError:
                return None
        data = self.cached(self.root / "cache/pages" / key, permanent=True)
        if isinstance(data, dict):
            return Page.model_validate(data)
        return None


def proxy_configured() -> bool:
    return any(
        os.environ.get(name) for name in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
    )


def is_available(document: m.SourceDocument, request: m.RunRequest) -> bool:
    return request.temporal_mode != "as_of" or document.available_at_cutoff is True
