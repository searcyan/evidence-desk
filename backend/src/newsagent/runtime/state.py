"""运行状态的初始值与事件折叠。"""

from datetime import UTC, datetime
from typing import Protocol
from uuid import uuid4

from ..contracts import models as m

TERMINAL = {"completed", "partial", "failed", "cancelled"}


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def stable_id(prefix: str, *parts: str) -> str:
    from hashlib import sha256

    return f"{prefix}_{sha256(chr(0).join(parts).encode()).hexdigest()[:16]}"


def initial_summary(
    run_id: str, request: m.RunRequest, budget: m.BudgetLimits, created_at: str | None = None
) -> m.RunSummary:
    return m.RunSummary(
        id=run_id,
        title=request.question[:120],
        status="queued",
        phase=None,
        request=request,
        budget=budget,
        usage=m.BudgetUsage(
            research_rounds=0,
            review_rounds=0,
            search_calls=0,
            read_calls=0,
            llm_calls=0,
            input_tokens=0,
            output_tokens=0,
            cost_usd=0,
            elapsed_seconds=0,
        ),
        created_at=created_at or now(),
        started_at=None,
        finished_at=None,
        stop_reason=None,
        counts=m.RunSummaryCounts(documents=0, claims=0, timeline_entries=0, open_gaps=0),
    )


def empty_detail(summary: m.RunSummary) -> m.RunDetail:
    return m.RunDetail(
        **summary.model_dump(),
        task=None,
        clarification=None,
        research_round=0,
        review_round=0,
        plans=[],
        actions=[],
        tool_calls=[],
        documents=[],
        origin_groups=[],
        evidence=[],
        claims=[],
        timeline=[],
        gaps=[],
        decisions=[],
        report=None,
        reviews=[],
        error=None,
        last_event_seq=0,
    )


def to_summary(state: m.RunDetail) -> m.RunSummary:
    return m.RunSummary.model_validate(state.model_dump(include=set(m.RunSummary.model_fields)))


class Identified(Protocol):
    @property
    def id(self) -> str: ...


def upsert[T: Identified](items: list[T], item: T) -> list[T]:
    for index, value in enumerate(items):
        if value.id == item.id:
            return [*items[:index], item, *items[index + 1 :]]
    return [*items, item]


def apply_event(state: m.RunDetail, event: m.RunEvent) -> m.RunDetail:
    if event.seq <= state.last_event_seq:
        return state
    changes: dict[str, object] = {"last_event_seq": event.seq}
    counts: dict[str, int] = {}
    match event.type:
        case "run.status":
            changes.update(status=event.data.status, phase=event.data.phase)
            # 恢复运行时重新进入 queued：清除上次中断留下的错误，避免完成后仍显示报错
            if event.data.status == "queued":
                changes["error"] = None
            if event.data.status == "running" and state.started_at is None:
                changes["started_at"] = event.ts
        case "step.started":
            changes["phase"] = event.data.step
            if event.data.step == "plan":
                changes["research_round"] = event.data.round
            elif event.data.step == "review":
                changes["review_round"] = event.data.round
        case "task.assessed":
            changes.update(task=event.data, title=event.data.event_name)
        case "clarification.requested":
            changes["clarification"] = event.data
        case "clarification.answered":
            changes["clarification"] = None
        case "question.updated":
            if state.task:
                changes["task"] = state.task.model_copy(
                    update={
                        "questions": upsert(state.task.questions, event.data),
                    }
                )
        case "plan.created":
            changes["plans"] = [*state.plans, event.data]
        case "action.upserted":
            changes["actions"] = upsert(state.actions, event.data)
        case "tool.called":
            changes["tool_calls"] = [*state.tool_calls, event.data]
        case "document.added":
            changes["documents"] = [*state.documents, event.data]
            counts["documents"] = state.counts.documents + 1
        case "origin_group.upserted":
            changes["origin_groups"] = upsert(state.origin_groups, event.data)
            members = set(event.data.document_ids)
            changes["documents"] = [
                doc.model_copy(update={"origin_group_id": event.data.id})
                if doc.id in members
                else doc
                for doc in state.documents
            ]
        case "evidence.added":
            changes["evidence"] = [*state.evidence, event.data]
        case "claim.upserted":
            claims = upsert(state.claims, event.data)
            changes["claims"] = claims
            counts["claims"] = len(claims)
        case "timeline.upserted":
            timeline = sorted(upsert(state.timeline, event.data), key=lambda item: item.date.start)
            changes["timeline"] = timeline
            counts["timeline_entries"] = len(timeline)
        case "timeline.removed":
            timeline = [item for item in state.timeline if item.id != event.data.id]
            changes["timeline"] = timeline
            counts["timeline_entries"] = len(timeline)
        case "gap.upserted":
            gaps = upsert(state.gaps, event.data)
            changes["gaps"] = gaps
            counts["open_gaps"] = sum(gap.status in ("open", "in_progress") for gap in gaps)
        case "decision.made":
            changes["decisions"] = [*state.decisions, event.data]
        case "budget.updated":
            changes["usage"] = event.data
        case "report.updated":
            changes["report"] = event.data
        case "review.completed":
            changes["reviews"] = [*state.reviews, event.data]
        case "run.finished":
            changes.update(
                status=event.data.status,
                stop_reason=event.data.stop_reason,
                finished_at=event.data.finished_at,
                phase=None,
            )
        case "run.error":
            changes["error"] = event.data
    if counts:
        changes["counts"] = state.counts.model_copy(update=counts)
    return state.model_copy(update=changes)
