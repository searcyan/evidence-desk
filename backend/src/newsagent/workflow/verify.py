"""将证据核实为原子声明，并维护时间线、答案覆盖和缺口。"""

from collections.abc import Iterable
from itertools import batched

from ..contracts import models as m
from ..llm.context import context
from ..llm.runner import ModelFailure, ModelRunner
from ..research.gaps import detect_gaps
from ..research.policy import MechanismPolicy
from ..research.provenance import normalize, origin_groups
from ..research.verdicts import applicable, verdict
from ..runtime.events import EventBus
from ..runtime.state import now, stable_id
from ..tools.retrieval import Retrieval
from .drafts import ClaimDraft, ClaimsDraft, ConflictDraft, RelationsDraft, UpdateDraft


async def verify(
    bus: EventBus,
    llm: ModelRunner,
    policy: MechanismPolicy,
    retrieval: Retrieval,
    *,
    target_ids: Iterable[str] = (),
    research: bool = True,
) -> None:
    if policy.source:
        if retrieval.local_path:
            await retrieval.local()
        old = {group.id: group for group in bus.state.origin_groups}
        for group in origin_groups(bus.state.documents, bus.state.origin_groups, retrieval.page):
            if old.get(group.id) != group:
                bus.emit("origin_group.upserted", group)
    state = bus.state
    targets = set(target_ids)
    rnd = state.research_round
    evidence = {item.id: item for item in state.evidence}
    docs = {doc.id: doc for doc in state.documents}
    claims = {claim.id: claim for claim in state.claims}
    linked = {link.evidence_id for claim in state.claims for link in claim.links}
    candidates = [
        item
        for item in state.evidence
        if item.id not in linked
        and (item.round == rnd or (rnd == 1 and item.round == 0) or not research)
    ]
    base = context(state)
    qids = {q.id for q in state.task.questions} if state.task else set()
    stages = set(state.task.stage_model) if state.task else set()
    relevant: set[tuple[str, str]] = set()

    def add(draft: ClaimDraft, permitted: set[str]) -> str | None:
        item = evidence.get(draft.evidence_id)
        if item is None or item.id not in permitted or not draft.text.strip():
            return None
        doc = docs.get(item.document_id)
        if doc is None:
            return None
        date = policy.claim_date(draft.event_date_text, item, doc)
        stage = draft.stage if draft.stage in stages else None
        canonical = stable_id(
            "cl",
            normalize(draft.text),
            normalize(draft.subject),
            stage or "",
            date.start if date else "",
        )
        match = claims.get(draft.existing_id or "") or claims.get(canonical)
        if match and (
            match.stage != stage
            or (match.event_date and date and match.event_date.start != date.start)
            or normalize(match.subject) != normalize(draft.subject)
        ):
            match = None
        key = match.id if match else canonical
        link = m.ClaimEvidenceLink(evidence_id=item.id, relation=draft.relation, note=None)
        valid_qids = [q for q in draft.question_ids if q in qids]
        if match:
            claims[key] = match.model_copy(
                update={
                    "links": [old for old in match.links if old.evidence_id != item.id] + [link],
                    "question_ids": list(dict.fromkeys([*match.question_ids, *valid_qids])),
                }
            )
        else:
            claims[key] = m.Claim(
                id=key,
                text=draft.text,
                subject=draft.subject,
                stage=stage,
                event_date=date,
                question_ids=valid_qids,
                verdict="insufficient",
                rationale="",
                links=[link],
                independent_sources=0,
                applicable_at_cutoff=None,
                history=[],
                first_round=rnd,
                updated_round=rnd,
            )
        relevant.add((key, item.id))
        return key

    for batch in batched(candidates, 10):
        try:
            output = await llm.run(
                "extractor",
                "claims",
                base
                | {
                    "new_evidence": [item.model_dump() for item in batch],
                    "existing_claims": [
                        {
                            "id": item.id,
                            "text": item.text,
                            "stage": item.stage,
                            "date": item.event_date.start if item.event_date else None,
                        }
                        for item in list(claims.values())[-30:]
                    ],
                    "stages": sorted(stages),
                },
                ClaimsDraft,
                research=research,
            )
        except ModelFailure:
            bus.emit("log", {"level": "warning", "message": "跳过无效的声明抽取结果"})
            continue
        permitted = {item.id for item in batch}
        for draft in output.claims:
            key = add(draft, permitted)
            if key is None:
                continue
            added = claims[key]
            for old in state.claims:
                if (
                    old.id != key
                    and set(old.question_ids).intersection(added.question_ids)
                    and old.stage == added.stage
                    and normalize(old.subject) == normalize(added.subject)
                ):
                    relevant.add((old.id, draft.evidence_id))

    for claim in claims.values():
        if claim.id in targets:
            relevant.update((claim.id, link.evidence_id) for link in claim.links)
    for batch in batched(sorted(relevant), 20):
        pairs = [
            {
                "claim_id": cid,
                "evidence_id": eid,
                "claim": claims[cid].text,
                "stage": claims[cid].stage,
                "quote": evidence[eid].quote,
            }
            for cid, eid in batch
            if eid in evidence
        ]
        if not pairs:
            continue
        try:
            output = await llm.run(
                "reviewer",
                "relations",
                {"language": state.request.report_language, "pairs": pairs},
                RelationsDraft,
                research=research,
            )
        except ModelFailure:
            output = RelationsDraft(links=[])
        judged = {(item.claim_id, item.evidence_id): item for item in output.links}
        for cid, eid in batch:
            claim = claims[cid]
            links = [item for item in claim.links if item.evidence_id != eid]
            assessment = judged.get((cid, eid))
            if assessment is None:
                # 未完成独立核实的抽取关系保留为上下文。
                if any(item.evidence_id == eid for item in claim.links):
                    links.append(
                        m.ClaimEvidenceLink(
                            evidence_id=eid, relation="context", note="关系尚未核实"
                        )
                    )
            elif assessment.relation != "irrelevant":
                links.append(
                    m.ClaimEvidenceLink(
                        evidence_id=eid, relation=assessment.relation, note=assessment.note
                    )
                )
            claims[cid] = claim.model_copy(update={"links": links})

    rationales: dict[str, str] = {}
    for item in list(claims.values()):
        initial, _ = verdict(item.links, evidence, docs, state.request.temporal_mode)
        if initial != "conflicting" or (
            item.id not in targets and all(cid != item.id for cid, _ in relevant)
        ):
            continue
        inputs = {
            "language": state.request.report_language,
            "claim": item.model_dump(),
            "evidence": [
                evidence[link.evidence_id].model_dump()
                for link in item.links
                if link.evidence_id in evidence
            ],
        }
        try:
            resolution = await llm.run(
                "reviewer", "conflict", inputs, ConflictDraft, research=research
            )
        except ModelFailure:
            continue
        rationales[item.id] = resolution.reason
        if resolution.same_assertion:
            continue
        replaced: set[str] = set()
        permitted = {link.evidence_id for link in item.links}
        for alternative in resolution.alternatives:
            other = add(alternative, permitted)
            if other is not None and other != item.id:
                replaced.add(alternative.evidence_id)
        if replaced:
            claims[item.id] = item.model_copy(
                update={
                    "links": [link for link in item.links if link.evidence_id not in replaced],
                }
            )

    previous = {c.id: c for c in state.claims}
    for item in claims.values():
        current, sources = verdict(item.links, evidence, docs, state.request.temporal_mode)
        known = any(
            link.relation == "supports"
            and docs[evidence[link.evidence_id].document_id].available_at_cutoff is True
            for link in item.links
            if link.evidence_id in evidence and evidence[link.evidence_id].document_id in docs
        )
        old = previous.get(item.id)
        history = item.history
        if old and old.verdict != current:
            history = [
                *history,
                m.VerdictRevision(
                    verdict=old.verdict, reason=old.rationale, round=old.updated_round, at=now()
                ),
            ]
        why = rationales.get(item.id) or (old.rationale if old and old.verdict == current else None)
        if not why:
            why = {
                "supported": f"{len(sources)} 个独立来源提供支持",
                "contradicted": "存在反驳证据，目前没有可用支持证据",
                "conflicting": "可用证据同时支持和反驳该声明",
                "insufficient": "尚缺乏可用且相关的核实证据",
            }[current]
        updated = item.model_copy(
            update={
                "verdict": current,
                "independent_sources": len(sources),
                "rationale": why,
                "applicable_at_cutoff": applicable(
                    item.event_date, state.request.cutoff, state.request.temporal_mode, known
                ),
                "history": history,
            }
        )
        if updated != old:
            bus.emit("claim.upserted", updated.model_copy(update={"updated_round": rnd}))


async def update(
    bus: EventBus, llm: ModelRunner, policy: MechanismPolicy, *, research: bool = True
) -> None:
    state = bus.state
    if state.task is None:
        return
    claims = {c.id: c for c in state.claims if c.applicable_at_cutoff is not False}
    data = (
        await llm.run("extractor", "update", context(state), UpdateDraft, research=research)
        if claims
        else UpdateDraft(timeline=[], answers=[])
    )
    answers = {item.question_id: item for item in data.answers}
    for question in state.task.questions:
        output = answers.get(question.id)
        ids = (
            []
            if output is None
            else list(
                dict.fromkeys(
                    cid
                    for cid in output.answer_claim_ids
                    if cid in claims
                    and claims[cid].verdict == "supported"
                    and question.id in claims[cid].question_ids
                )
            )
        )
        status = "answered" if ids and output and output.complete else "partial" if ids else "open"
        changed = question.model_copy(update={"status": status, "answer_claim_ids": ids})
        if changed != question:
            bus.emit("question.updated", changed)

    # 时间线只收模型挑出的"发生过的事件"；不再把其余声明逐条补进来，
    # 否则"截至某日仍未…"之类的状态陈述、定义和背景常识会挂着发布日期混进时间线。
    # 同一条声明只进入第一个包含它的条目，避免同一件事在多个时间点重复出现。
    timeline: dict[str, m.TimelineEntry] = {}
    placed: set[str] = set()
    for row in data.timeline:
        title, summary = row.title, row.summary
        groups: dict[tuple[str, str | None], list[m.Claim]] = {}
        for cid in dict.fromkeys(row.claim_ids):
            if cid in placed:
                continue
            placed.add(cid)
            claim = claims.get(cid)
            if claim and claim.event_date and claim.verdict in ("supported", "conflicting"):
                groups.setdefault((claim.event_date.start, claim.stage), []).append(claim)
        for (_, stage), group in groups.items():
            cids = sorted(c.id for c in group)
            date = group[0].event_date
            if date is None:
                continue
            key = stable_id("tl", *cids)
            split = len(groups) > 1
            timeline[key] = m.TimelineEntry(
                id=key,
                date=date,
                title=group[0].text if split else title,
                summary="" if split else summary,
                stage=stage,
                claim_ids=cids,
                verdict="conflicting"
                if any(c.verdict == "conflicting" for c in group)
                else "supported",
                is_milestone=stage in state.task.stage_model,
            )
    previous = {item.id: item for item in state.timeline}
    for item in previous.values():
        if item.id not in timeline:
            bus.emit("timeline.removed", {"id": item.id})
    for key, item in timeline.items():
        if previous.get(key) != item:
            bus.emit("timeline.upserted", item)
    for gap in detect_gaps(bus.state, policy):
        bus.emit("gap.upserted", gap)
