"""将核实后的状态映射为可行动的证据缺口。"""

from ..contracts import models as m
from ..runtime.state import stable_id
from ..tools.dates import day
from .policy import MechanismPolicy


def detect_gaps(state: m.RunDetail, policy: MechanismPolicy) -> list[m.Gap]:
    task = state.task
    if task is None:
        return []
    previous = {g.id: g for g in state.gaps}
    detected: dict[str, m.Gap] = {}
    core = {q.id for q in task.questions if q.priority == "core"}
    round_number = state.research_round

    def add(
        kind: m.GapType,
        key: str,
        description: str,
        qids: list[str],
        cids: list[str],
        *,
        high: bool = False,
    ) -> None:
        if kind not in policy.gaps:
            return
        gap_id = stable_id("gap", kind, key)
        old = previous.get(gap_id)
        attempts = {
            a.round for a in state.actions if a.gap_id == gap_id and a.status in ("done", "failed")
        }
        feasible = bool(policy.gap_actions(kind)) and len(attempts) < 2
        detected[gap_id] = m.Gap(
            id=gap_id,
            type=kind,
            description=description,
            question_ids=qids,
            claim_ids=cids,
            priority="high" if high else "medium",
            affects_main_answer=bool(core.intersection(qids)),
            feasible=feasible,
            status="open" if feasible else "abandoned",
            opened_round=old.opened_round if old else round_number,
            closed_round=None
            if feasible
            else ((old.closed_round if old else None) or round_number),
            resolution=None if feasible else "该缺口已尝试两轮或当前条件下没有可用动作",
        )

    for q in task.questions:
        if q.status in ("open", "partial", "unanswerable"):
            add("unanswered_question", q.id, q.text, [q.id], [], high=q.priority == "core")

    dates = [item.event_date.start for item in state.evidence if item.event_date]
    if dates and 0 <= (day(min(dates)) - day(task.initial_window.start)).days < 7:
        add(
            "missing_background",
            "initial",
            "证据接近初始窗口起点，可能缺少早期背景",
            sorted(core),
            [],
        )
    appeared = {item.stage for item in state.timeline}
    for i, stage in enumerate(task.stage_model):
        if stage not in appeared and appeared.intersection(task.stage_model[i + 1 :]):
            add("missing_phase", stage, f"缺少阶段记录：{stage}", sorted(core), [], high=True)

    docs = {doc.id: doc for doc in state.documents}
    evidence_docs = {ev.id: docs[ev.document_id] for ev in state.evidence if ev.document_id in docs}
    original_groups = {group.id for group in state.origin_groups if group.root_document_id}
    # 声明类缺口只针对真正支撑 core 问题答案的声明；背景、定义类声明证据薄弱不影响结论
    answer_claims = {
        cid for q in task.questions if q.priority == "core" for cid in q.answer_claim_ids
    }
    for claim in state.claims:
        qids = claim.question_ids
        main = bool(core.intersection(qids))
        if claim.verdict == "conflicting":
            add("conflict", claim.id, claim.text, qids, [claim.id], high=True)
        if not main or claim.id not in answer_claims:
            continue
        # 日期不清只针对事件：有阶段（宣布、获批…）却没有日期，或日期只精确到年；
        # "截至某日仍未…"之类的状态陈述和定义本来就没有事件日期，不算缺口
        vague = claim.event_date is not None and claim.event_date.precision == "year"
        undated_event = claim.event_date is None and claim.stage is not None
        if vague or undated_event:
            add("unclear_date", claim.id, claim.text, qids, [claim.id])
        support = [
            evidence_docs[link.evidence_id]
            for link in claim.links
            if link.relation == "supports" and link.evidence_id in evidence_docs
        ]
        original = any(d.is_original or d.origin_group_id in original_groups for d in support)
        if claim.verdict == "supported" and claim.independent_sources == 1 and not original:
            add("single_source", claim.id, claim.text, qids, [claim.id])
        if support and all(doc.attribution for doc in support) and not original:
            add("unverified_origin", claim.id, claim.text, qids, [claim.id])

    for item in previous.values():
        if item.id not in detected and item.status in ("open", "in_progress", "abandoned"):
            detected[item.id] = item.model_copy(
                update={
                    "status": "resolved",
                    "closed_round": round_number,
                    "resolution": "新证据已填补缺口",
                }
            )
    return [item for item in detected.values() if item != previous.get(item.id)]
