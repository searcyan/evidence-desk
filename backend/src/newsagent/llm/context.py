"""按任务相关性整理模型输入，保留证据与声明的可追溯 ID。

设计要点：
- 声明只保留判断与写作所需的字段（精简格式），核心问题相关的声明优先；
- include_quotes 时，证据原文**跟随被选中的声明**挑选（每条声明优先取支持证据），并截短单条原文，
  保证模型看到的每条声明都有对应的原文可引用；
- 时间线以精简格式完整给出（上限 120 条），避免按日期截断丢失后期事件。
"""

from ..contracts import models as m

QUOTE_CHARS = 600


def _claim_row(claim: m.Claim) -> dict[str, object]:
    return {
        "id": claim.id,
        "text": claim.text,
        "verdict": claim.verdict,
        "stage": claim.stage,
        "event_date": claim.event_date.model_dump() if claim.event_date else None,
        "independent_sources": claim.independent_sources,
        "applicable_at_cutoff": claim.applicable_at_cutoff,
        "question_ids": claim.question_ids,
        "links": [
            {"evidence_id": link.evidence_id, "relation": link.relation} for link in claim.links
        ],
    }


def context(
    state: m.RunDetail, *, include_quotes: bool = False, max_chars: int = 24_000
) -> dict[str, object]:
    core = {q.id for q in state.task.questions if q.priority == "core"} if state.task else set()
    ranked = sorted(
        state.claims,
        key=lambda c: (
            not bool(core.intersection(c.question_ids)),
            c.verdict != "supported",
            -c.independent_sources,
        ),
    )
    claims: list[dict[str, object]] = []
    used = 0
    for item in ranked:
        row = _claim_row(item)
        used += len(str(row))
        if used > max_chars:
            break
        claims.append(row)
    result: dict[str, object] = {
        "language": state.request.report_language,
        "question": state.request.question,
        "cutoff": state.request.cutoff,
        "temporal_mode": state.request.temporal_mode,
        "task": state.task.model_dump() if state.task else None,
        "claims": claims,
        "open_gaps": [
            {"id": g.id, "type": g.type, "description": g.description, "priority": g.priority}
            for g in state.gaps
            if g.status == "open"
        ][:25],
        "timeline": [
            {
                "id": t.id,
                "date": t.date.start,
                "precision": t.date.precision,
                "title": t.title,
                "verdict": t.verdict,
                "claim_ids": t.claim_ids,
            }
            for t in state.timeline
        ][:120],
    }
    if include_quotes:
        evidence = {item.id: item for item in state.evidence}
        quotes: dict[str, dict[str, object]] = {}
        budget = 0
        for item in ranked[: len(claims)]:
            links = sorted(item.links, key=lambda link: link.relation != "supports")
            for link in links[:2]:
                ev = evidence.get(link.evidence_id)
                if ev is None or ev.id in quotes:
                    continue
                quote = ev.quote[:QUOTE_CHARS]
                budget += len(quote)
                if budget > max_chars:
                    break
                quotes[ev.id] = {
                    "id": ev.id,
                    "document_id": ev.document_id,
                    "quote": quote,
                    "event_date": ev.event_date.model_dump() if ev.event_date else None,
                }
            if budget > max_chars:
                break
        result["evidence"] = list(quotes.values())
    return result
