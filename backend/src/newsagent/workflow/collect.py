"""执行检索动作并从已读正文提取逐字证据。"""

import asyncio
from collections import Counter
from urllib.parse import urlsplit

from ..contracts import models as m
from ..llm.runner import ModelFailure, ModelRunner
from ..research.policy import MechanismPolicy
from ..runtime.budget import BudgetExceeded
from ..runtime.events import EventBus
from ..runtime.state import now, stable_id
from ..tools.dates import cutoff_availability, event_date, publication
from ..tools.retrieval import Retrieval, is_available
from ..tools.search import Page, Provider, SearchHit, canonical_url
from .drafts import EvidenceDraft


def literal_quote(quote: str, text: str) -> str | None:
    quote = " ".join(quote.split())
    return quote if quote and quote in " ".join(text.split()) else None


async def collect_page(
    bus: EventBus,
    retrieval: Retrieval,
    llm: ModelRunner,
    policy: MechanismPolicy,
    page: Page,
    provider: Provider,
    action: m.ResearchAction | None,
    hit: SearchHit | None,
) -> tuple[int, int]:
    state = bus.state
    url = canonical_url(page.final_url)
    key = stable_id("doc", url)
    original = next((doc for doc in state.documents if doc.id == key), None)
    if original and any(ev.document_id == key for ev in state.evidence):
        return 0, 0
    rnd = action.round if action else 0
    published = page.published_at
    source = page.published_at_source
    allowed = cutoff_availability(published, state.request.cutoff)
    mode = state.request.temporal_mode
    draft = EvidenceDraft(passages=[])
    if allowed is not False or mode == "retrospective":
        try:
            draft = await llm.run(
                "extractor",
                "evidence",
                {
                    "language": state.request.report_language,
                    "question": state.request.question,
                    "subquestions": [item.text for item in state.task.questions]
                    if state.task
                    else [],
                    "extract_provenance": policy.source,
                    "extract_event_dates": policy.temporal,
                    "title": page.title,
                    "url": url,
                    "published_at": published,
                    "text": page.text[:22_000],
                },
                EvidenceDraft,
            )
        except ModelFailure:
            bus.emit("log", {"level": "warning", "message": "正文证据抽取失败，保留来源记录"})
    # 并发抽取期间可能已有同一文档（重定向到相同页面）入库，重新确认
    original = original or next((doc for doc in bus.state.documents if doc.id == key), None)
    if not published and draft.publication_date and draft.publication_date in page.text:
        published = publication(draft.publication_date)
        if published:
            source = "content"
    provider_label: str = (
        "seed" if action is None else "cache" if provider in ("http", "cache") else provider
    )
    doc = original or m.SourceDocument.model_validate(
        {
            "id": key,
            "url": url,
            "title": page.title or (hit.title if hit else "") or url,
            "domain": urlsplit(url).hostname or "",
            "publisher": page.publisher,
            "author": page.author,
            "published_at": published,
            "published_at_source": source,
            "retrieved_at": now(),
            "provider": provider_label,
            "origin_group_id": None,
            "is_original": draft.is_original if policy.source else None,
            "attribution": draft.attribution if policy.source else None,
            "available_at_cutoff": cutoff_availability(published, state.request.cutoff),
            "language": page.language,
            "snippet": (hit.snippet if hit else page.text)[:360],
            "round": rnd,
            "action_id": action.id if action else None,
        }
    )
    if original is None:
        bus.emit("document.added", doc)
    if not is_available(doc, state.request):
        return int(original is None), 0
    existing = {ev.id for ev in bus.state.evidence}
    count = 0
    for item in draft.passages:
        quote = literal_quote(item.quote, page.text)
        if not quote:
            continue
        evidence_id = stable_id("ev", key, quote)
        if evidence_id in existing:
            continue
        existing.add(evidence_id)
        date = event_date(item.event_date_text, published) if policy.temporal else None
        bus.emit(
            "evidence.added",
            m.Evidence(id=evidence_id, document_id=key, quote=quote, event_date=date, round=rnd),
        )
        count += 1
    return int(original is None), count


async def collect(
    bus: EventBus,
    retrieval: Retrieval,
    llm: ModelRunner,
    policy: MechanismPolicy,
    actions: list[m.ResearchAction],
) -> None:
    sem = asyncio.Semaphore(retrieval.config.research.action_concurrency)
    existing = {canonical_url(d.url) for d in bus.state.documents}
    evidence_by_id = {e.id: e for e in bus.state.evidence}
    docs = {d.id: d for d in bus.state.documents}
    claims = {c.id: c for c in bus.state.claims}
    completed = {"done", "failed", "skipped"}
    active = [a for a in actions if a.status not in completed]

    async def search(action: m.ResearchAction) -> tuple[list[SearchHit], Provider | None]:
        async with sem:
            if action.type == "read":
                return ([SearchHit(url=action.params.url)] if action.params.url else []), None
            claim = claims.get(action.params.claim_id or "")
            linked = (
                [
                    docs[evidence_by_id[link.evidence_id].document_id]
                    for link in claim.links
                    if link.evidence_id in evidence_by_id
                    and evidence_by_id[link.evidence_id].document_id in docs
                ]
                if claim
                else []
            )
            excluded = (
                sorted({doc.domain for doc in linked}) if action.type == "corroborate" else []
            )
            if action.type == "trace_origin":
                origins = list(dict.fromkeys(doc.attribution for doc in linked if doc.attribution))
                if origins:
                    action = action.model_copy(
                        update={
                            "params": action.params.model_copy(
                                update={
                                    "query": f"{origins[0]} original {action.params.query or ''}",
                                }
                            )
                        }
                    )
            return await retrieval.search(action, excluded, True)

    active = [
        a.model_copy(update={"status": "running", "started_at": a.started_at or now()})
        for a in active
    ]
    for action in active:
        bus.emit("action.upserted", action)
    hits = await asyncio.gather(*(search(a) for a in active), return_exceptions=True)
    processed: Counter[str] = Counter()
    duplicates: Counter[str] = Counter()
    evidence: Counter[str] = Counter()
    failures: set[str] = set()
    pending: list[tuple[m.ResearchAction, SearchHit, Provider | None]] = []
    for action, result in zip(active, hits, strict=True):
        if isinstance(result, BaseException):
            failures.add(action.id)
            continue
        results, provider = result
        for hit in results:
            try:
                uri = canonical_url(hit.url)
                if not uri.startswith(("http://", "https://")) or not urlsplit(uri).hostname:
                    continue
            except ValueError:
                continue
            if uri in existing:
                duplicates[action.id] += 1
                continue
            if len(pending) >= retrieval.config.research.max_reads_per_round:
                break
            existing.add(uri)
            pending.append((action, hit, provider))

    async def read(
        item: tuple[m.ResearchAction, SearchHit, Provider | None],
    ) -> tuple[Page, Provider]:
        action, hit, provider = item
        async with sem:
            return await retrieval.read(hit.url, hit, provider, action.id, True)

    pages = await asyncio.gather(*(read(item) for item in pending), return_exceptions=True)
    halted: BudgetExceeded | None = None
    readable = []
    for (action, hit, _), result in zip(pending, pages, strict=True):
        if isinstance(result, BaseException):
            failures.add(action.id)
            continue
        readable.append((action, hit, result))

    async def extract(item: tuple[m.ResearchAction, SearchHit, tuple[Page, Provider]]):
        action, hit, (page, reader) = item
        async with sem:
            return await collect_page(bus, retrieval, llm, policy, page, reader, action, hit)

    # 各页面的证据抽取相互独立，并发执行（并发度与读取相同）
    extracted = await asyncio.gather(*(extract(item) for item in readable), return_exceptions=True)
    for (action, _, _), outcome in zip(readable, extracted, strict=True):
        if isinstance(outcome, BudgetExceeded):
            halted = halted or outcome
            continue
        if isinstance(outcome, BaseException):
            raise outcome
        count, passages = outcome
        processed[action.id] += count
        evidence[action.id] += passages
        duplicates[action.id] += int(count == 0)
    for action in active:
        ok = action.id not in failures or processed[action.id] > 0
        bus.emit(
            "action.upserted",
            action.model_copy(
                update={
                    "status": "done" if ok else "failed",
                    "finished_at": now(),
                    "result": m.ResearchActionResult(
                        documents_added=processed[action.id],
                        evidence_added=evidence[action.id],
                        duplicates=duplicates[action.id],
                        note=None if ok else "检索或正文读取失败",
                    ),
                }
            ),
        )
    if halted:
        raise halted
