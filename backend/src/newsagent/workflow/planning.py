"""研究任务拆解、澄清、补查动作和查询约束。"""

import re
from time import monotonic
from typing import Literal, cast

from ..contracts import models as m
from ..llm.context import context
from ..llm.runner import ModelFailure, ModelRunner
from ..research.policy import MechanismPolicy
from ..runtime.budget import BudgetTracker
from ..runtime.events import EventBus
from ..runtime.manager import RunManager
from ..runtime.state import now, stable_id
from ..tools.search import canonical_url, normalize_query
from .drafts import ActionDraft, AssessDraft, PlanDraft

STAGES: dict[m.EventType, list[str]] = {
    "acquisition": ["announced", "agreement_signed", "regulatory_review", "approved", "closed"],
    "legal_case": ["filed", "hearing", "ruling", "appeal"],
    "policy": ["proposed", "approved", "enacted", "implemented"],
    "disaster": ["onset", "response", "recovery"],
    "election": ["campaign", "voting", "results", "certification"],
    "product": ["announced", "released"],
    "conflict": ["onset", "escalation", "negotiation", "resolution"],
    "other": [],
}


STAGE_LABEL = re.compile(r"^[a-z][a-z_]{1,31}$")


def stage_model(proposed: list[str], kind: m.EventType) -> list[str]:
    """阶段模型只允许简短的通用阶段标签（如 approved）。

    模型有时会写成带人名、日期的叙述句（未经检索的先验知识），直接展示会被用户当成事实，
    也无法与声明的 stage 字段对齐；出现任何不合格标签时整体改用事件类型的默认阶段。
    """
    labels = list(dict.fromkeys(s.strip().lower().replace(" ", "_") for s in proposed if s.strip()))
    if labels and len(labels) <= 8 and all(STAGE_LABEL.match(s) for s in labels):
        return labels
    return STAGES[kind]


async def assess(
    manager: RunManager,
    bus: EventBus,
    budget: BudgetTracker,
    llm: ModelRunner,
    policy: MechanismPolicy,
) -> None:
    state = bus.state
    prior = manager.store.events(state.id) if state.last_event_seq > 2 else []
    requested = any(event.type == "clarification.requested" for event in prior)
    answers = next(
        (
            event.data.model_dump()
            for event in reversed(prior)
            if event.type == "clarification.answered"
        ),
        {},
    )
    inputs = context(state) | {
        "event_hint": state.request.event_hint,
        "clarified": requested,
        "answers": answers,
        "seed_quotes": [ev.quote for ev in state.evidence if ev.round == 0],
    }
    draft = await llm.run("controller", "assess", inputs, AssessDraft)
    # 评测运行（带 exp: 标签）无人值守：不发起澄清，按模型给出的假设继续，并记录到日志
    unattended = any(tag.startswith("exp:") for tag in state.request.tags)
    if draft.clarifications and not requested and unattended:
        bus.emit(
            "log",
            {"level": "info", "message": "评测运行无人值守：跳过澄清，按任务理解中的假设继续"},
        )
    if draft.clarifications and not requested and not unattended:
        questions = [
            m.ClarificationQuestion(
                id=stable_id("q", "clarify", str(i)),
                text=q.text,
                options=q.options,
            )
            for i, q in enumerate(draft.clarifications[:3])
        ]
        started = monotonic()
        answer = await manager.clarify(
            bus,
            m.ClarificationRequest(
                id=stable_id("clar", state.id),
                questions=questions,
                asked_at=now(),
            ),
        )
        budget.pause_seconds += monotonic() - started
        if answer.answers:
            response = [
                {"question": q.text, "answer": a.answer}
                for q in questions
                for a in answer.answers
                if a.question_id == q.id
            ]
            draft = await llm.run(
                "controller",
                "assess",
                inputs
                | {
                    "clarified": True,
                    "answers": response,
                },
                AssessDraft,
            )
    zh = state.request.report_language == "zh"
    questions = [
        (item.text.strip(), item.priority) for item in draft.questions if item.text.strip()
    ]
    defaults = (
        ["关键阶段和当前进展是什么？", "有哪些背景和来源分歧？"]
        if zh
        else [
            "What are the key milestones and latest applicable status?",
            "What background and source disagreements matter?",
        ]
    )
    if not any(priority == "core" for _, priority in questions[:6]):
        questions.insert(0, (state.request.question, "core"))
    while len(questions) < 3:
        questions.append((defaults[(len(questions) - 1) % 2], "supporting"))
    task = m.TaskSpec(
        event_name=draft.event_name.strip() or state.title,
        event_type=draft.event_type,
        entities=draft.entities[:20],
        cutoff=state.request.cutoff,
        temporal_mode=state.request.temporal_mode,
        initial_window=policy.initial_window(
            state.request, draft.initial_window, manager.config.research.default_lookback_days
        ),
        stage_model=stage_model(draft.stage_model, draft.event_type) if policy.temporal else [],
        assumptions=draft.assumptions,
        questions=[
            m.SubQuestion(
                id=stable_id("q", str(i)),
                text=text,
                priority=cast(Literal["core", "supporting"], priority),
                status="open",
                answer_claim_ids=[],
            )
            for i, (text, priority) in enumerate(questions[:6])
        ],
    )
    bus.emit("task.assessed", task)


def action_key(kind: m.ActionType, params: m.ResearchActionParams) -> tuple[str, str, str]:
    if kind == "read":
        return (canonical_url(params.url or ""), "", "")
    window = params.window
    return (
        normalize_query(params.query or ""),
        window.start if window else "",
        window.end if window else "",
    )


async def plan(
    manager: RunManager,
    bus: EventBus,
    budget: BudgetTracker,
    llm: ModelRunner,
    policy: MechanismPolicy,
) -> list[m.ResearchAction]:
    state = bus.state
    task = state.task
    if task is None:
        return []
    rnd = state.research_round
    if any(item.round == rnd for item in state.plans):
        return [item for item in state.actions if item.round == rnd]
    feasible = {g.id: g for g in state.gaps if g.status == "open" and g.feasible}
    qids = {q.id for q in task.questions}
    claims = {c.id: c for c in state.claims}
    checked = {action_key(a.type, a.params) for a in state.actions if a.round < rnd}
    maximum = min(manager.config.research.max_actions_per_round, budget.tools_left(True))
    try:
        draft = await llm.run(
            "controller",
            "plan",
            context(state)
            | {
                "round": rnd,
                "max_actions": maximum,
                "permitted_actions": sorted(policy.actions),
                "searched": sorted(checked),
                "budget_remaining": budget.remaining_ratio(),
                "feasible_gaps": [
                    g.model_dump() | {"actions": policy.gap_actions(g.type)}
                    for g in sorted(
                        feasible.values(),
                        key=lambda g: (not g.affects_main_answer, g.priority != "high", g.id),
                    )
                ],
            },
            PlanDraft,
        )
    except ModelFailure:
        # 规划输出连续无效时不终止运行：退回控制器的默认动作（核心问题检索 / 缺口补查）
        bus.emit("log", {"level": "warning", "message": "规划输出无效，改用默认检索动作"})
        draft = PlanDraft(rationale="", source_strategy="", actions=[])
    selected: list[m.ResearchAction] = []

    def add(
        kind: m.ActionType,
        params: m.ResearchActionParams,
        rationale: str,
        qids_for_action: list[str],
        gap_id: str | None,
    ) -> None:
        if len(selected) >= maximum:
            return
        if kind == "read":
            if not (params.url or "").startswith(("http://", "https://")):
                return
        elif not (params.query or "").strip():
            return
        normalized = params.model_copy(
            update={
                "window": policy.action_window(kind, params, task, state.request),
            }
        )
        key = action_key(kind, normalized)
        if key in checked:
            return
        checked.add(key)
        selected.append(
            m.ResearchAction(
                id=stable_id("act", str(rnd), *key),
                type=kind,
                round=rnd,
                status="planned",
                gap_id=gap_id,
                question_ids=qids_for_action,
                rationale=rationale,
                params=normalized,
                result=None,
                started_at=None,
                finished_at=None,
            )
        )

    def search_params(query: str) -> m.ResearchActionParams:
        return m.ResearchActionParams(
            query=query[:400], window=None, date=None, url=None, claim_id=None
        )

    def add_proposal(item: ActionDraft) -> None:
        if item.type not in policy.actions:
            return
        gap = feasible.get(item.gap_id or "")
        if rnd > 1 and (gap is None or item.type not in policy.gap_actions(gap.type)):
            return
        params = item.params
        claim_id = params.claim_id if params.claim_id in claims else None
        if claim_id is None and gap and gap.claim_ids:
            claim_id = gap.claim_ids[0]
        claim = claims.get(claim_id or "")
        query = params.query
        date = params.date or (claim.event_date.start if claim and claim.event_date else None)
        if item.type in ("focus_date", "narrow_window") and date and query and date not in query:
            query = f"{query} {date}"
        add(
            item.type,
            params.model_copy(update={"claim_id": claim_id, "query": query, "date": date}),
            item.rationale,
            [key for key in item.question_ids if key in qids],
            gap.id if gap else None,
        )

    if rnd == 1:
        for q in (item for item in task.questions if item.priority == "core"):
            proposal = next(
                (
                    item
                    for item in draft.actions
                    if item.type == "search" and q.id in item.question_ids
                ),
                None,
            )
            if proposal:
                add_proposal(proposal)
            if not any(
                q.id in action.question_ids and action.type == "search" for action in selected
            ):
                add(
                    "search",
                    search_params(f"{task.event_name} {q.text}"),
                    "调查核心问题",
                    [q.id],
                    None,
                )
    for proposal in draft.actions:
        add_proposal(proposal)
    if rnd > 1 and not selected:
        for gap in sorted(feasible.values(), key=lambda g: (not g.affects_main_answer, g.priority)):
            kinds = policy.gap_actions(gap.type)
            if kinds:
                attempts = sum(a.gap_id == gap.id for a in state.actions)
                qualifier = "latest official record" if attempts else "source timeline"
                add(
                    kinds[0],
                    search_params(f"{task.event_name} {gap.description} {qualifier}"),
                    "补查当前证据缺口",
                    gap.question_ids,
                    gap.id,
                )
    for action in selected:
        bus.emit("action.upserted", action)
    windows = {
        (a.params.window.start, a.params.window.end): a.params.window
        for a in selected
        if a.params.window
    }
    bus.emit(
        "plan.created",
        m.ResearchPlan(
            round=rnd,
            created_at=now(),
            rationale=draft.rationale,
            source_strategy=draft.source_strategy,
            windows=list(windows.values()),
            action_ids=[a.id for a in selected],
        ),
    )
    return selected
