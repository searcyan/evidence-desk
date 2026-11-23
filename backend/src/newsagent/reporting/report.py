"""组装报告、逐句核查并保留审查修复历史。"""

from itertools import batched

from pydantic import TypeAdapter

from ..contracts import models as m
from ..llm.context import context
from ..llm.runner import ModelFailure, ModelRunner
from ..runtime.events import EventBus
from ..runtime.state import now, stable_id
from ..tools.retrieval import is_available
from ..workflow.drafts import FindingDraft, ReportDraft, ReviewDraft, SentenceDraft

FINDINGS = TypeAdapter(list[FindingDraft])


def available_quotes(state: m.RunDetail) -> dict[str, m.Evidence]:
    docs = {doc.id for doc in state.documents if is_available(doc, state.request)}
    return {ev.id: ev for ev in state.evidence if ev.document_id in docs}


def report_sentences(report: m.Report) -> list[m.ReportSentence]:
    return [
        *report.answer.sentences,
        *(
            s
            for section in report.sections
            for paragraph in section.paragraphs
            for s in paragraph.sentences
        ),
    ]


def safe_fallback(state: m.RunDetail) -> ReportDraft:
    quotes = available_quotes(state)
    claims = [
        claim
        for claim in state.claims
        if claim.verdict == "supported" and claim.applicable_at_cutoff is not False
    ]
    supported: list[SentenceDraft] = []
    for claim in claims:
        link = next(
            (
                link
                for link in claim.links
                if link.relation == "supports" and link.evidence_id in quotes
            ),
            None,
        )
        if link:
            quote = quotes[link.evidence_id]
            supported.append(
                SentenceDraft(text=quote.quote, evidence_ids=[quote.id], claim_ids=[claim.id])
            )
        if len(supported) == 3:
            break
    return ReportDraft(title=state.title, answer=supported, sections=[], open_questions=[])


def build_report(state: m.RunDetail, draft: ReportDraft) -> tuple[m.Report, list[FindingDraft]]:
    language = state.request.report_language
    zh = language == "zh"
    version = state.report.version + 1 if state.report else 1
    evidence = {ev.id: ev for ev in state.evidence}
    allowed = available_quotes(state)
    eligible_claims = {c.id: c for c in state.claims if c.applicable_at_cutoff is not False}
    findings: list[FindingDraft] = []

    def paragraph(items: list[SentenceDraft], key: str) -> m.ReportParagraph:
        sentences = []
        for i, sentence in enumerate(items[:40]):
            text = sentence.text.strip()
            if not text:
                continue
            sid = stable_id("s", str(version), key, str(i))
            refs = list(dict.fromkeys(eid for eid in sentence.evidence_ids if eid in allowed))
            claims = list(
                dict.fromkeys(cid for cid in sentence.claim_ids if cid in eligible_claims)
            )
            invalid = set(sentence.evidence_ids) - allowed.keys()
            for eid in sorted(invalid):
                kind = "unavailable_at_cutoff" if eid in evidence else "unsupported_citation"
                findings.append(
                    FindingDraft(
                        type=kind,
                        severity="high",
                        sentence_id=sid,
                        description="引用不存在或在截止时间前不可用",
                    )
                )
            if not refs:
                findings.append(
                    FindingDraft(
                        type="unsupported_citation",
                        severity="high",
                        sentence_id=sid,
                        description="事实表述缺少可用引用",
                    )
                )
            sentences.append(
                m.ReportSentence(id=sid, text=text, evidence_ids=refs, claim_ids=claims)
            )
        return m.ReportParagraph(id=stable_id("p", str(version), key), sentences=sentences)

    answer = paragraph(draft.answer, "answer")
    sections = [
        m.ReportSection(
            id=stable_id("sec", str(version), str(index)),
            kind=section.kind,
            title=section.title,
            paragraphs=[
                paragraph(items, f"{index}.{i}") for i, items in enumerate(section.paragraphs)
            ],
        )
        for index, section in enumerate(draft.sections[:10])
        if section.kind != "answer"
    ]
    questions = (
        [q.text for q in state.task.questions if q.status != "answered"]
        if state.task
        else [
            state.request.question,
        ]
    )
    # 只给用户看未答的子问题和写作者归纳的开放问题；内部缺口（单一来源、日期不清等）
    # 是研究过程的工作清单，描述往往就是声明原文，放进报告会让人误以为结论也存疑
    open_questions = list(dict.fromkeys([*questions, *draft.open_questions]))
    if open_questions and not any(s.kind == "uncertainty" for s in sections):
        sections.append(
            m.ReportSection(
                id=stable_id("sec", str(version), "uncertainty"),
                kind="uncertainty",
                title="不确定性" if zh else "Uncertainty",
                paragraphs=[],
            )
        )
    if not answer.sentences:
        findings.append(
            FindingDraft(
                type="omission",
                severity="high",
                sentence_id=None,
                description="缺少有证据支持的直接答案",
            )
        )
    return m.Report(
        version=version,
        language=language,
        title=draft.title or state.title,
        generated_at=now(),
        is_partial=True,
        answer=answer,
        sections=sections,
        open_questions=open_questions,
        stop_reason=None,
    ), findings


async def write_report(bus: EventBus, llm: ModelRunner) -> None:
    state = bus.state
    prior = state.reviews[-1] if state.reviews else None
    draft = await llm.run(
        "writer",
        "write",
        context(state, include_quotes=True)
        | {
            "previous_report": state.report.model_dump() if state.report else None,
            "findings": [f.model_dump() for f in prior.findings if f.status == "open"]
            if prior
            else [],
        },
        ReportDraft,
        research=False,
    )
    report, findings = build_report(state, draft)
    bus.store.save_report_checks(state.id, report.version, FINDINGS.dump_json(findings).decode())
    if draft.short_answer:
        bus.store.set_short_answer(state.id, draft.short_answer)
    bus.emit("report.updated", report)


async def review_report(bus: EventBus, llm: ModelRunner) -> bool:
    state = bus.state
    report = state.report
    if report is None:
        return False
    quotes = available_quotes(state)
    sentences = report_sentences(report)
    claims = {c.id: c for c in state.claims}
    initial = FINDINGS.validate_json(bus.store.report_checks(state.id, report.version))
    kinds = {s.id: "answer" for s in report.answer.sentences} | {
        s.id: section.kind
        for section in report.sections
        for p in section.paragraphs
        for s in p.sentences
    }
    for sentence in sentences:
        if any(eid not in quotes for eid in sentence.evidence_ids):
            initial.append(
                FindingDraft(
                    type="unavailable_at_cutoff",
                    severity="high",
                    sentence_id=sentence.id,
                    description="有引用在截止时不可用",
                )
            )
        if not sentence.evidence_ids and kinds.get(sentence.id) != "uncertainty":
            # 挂了声明却没有引用 → 高；其他无引用句（过渡、说明）→ 中，由审查器进一步判断
            initial.append(
                FindingDraft(
                    type="unsupported_citation",
                    severity="high" if sentence.claim_ids else "medium",
                    sentence_id=sentence.id,
                    description="缺少引用",
                )
            )
        if any(
            claims[cid].applicable_at_cutoff is False for cid in sentence.claim_ids if cid in claims
        ):
            initial.append(
                FindingDraft(
                    type="temporal_error",
                    severity="high",
                    sentence_id=sentence.id,
                    description="声明发生于截止时间之后",
                )
            )
    base = context(state, max_chars=10_000)
    found = list(initial)
    for batch in batched(sentences, 12):
        ids = {s.id for s in batch}
        payload = [
            {
                "sentence": s.model_dump(),
                "cited_quotes": [
                    quotes[eid].model_dump() for eid in s.evidence_ids if eid in quotes
                ],
            }
            for s in batch
        ]
        try:
            result = await llm.run(
                "reviewer",
                "review",
                base
                | {
                    "batch": payload,
                    "full_report_text": [s.text for s in sentences],
                },
                ReviewDraft,
                research=False,
            )
            found.extend(
                item
                for item in result.findings
                if item.sentence_id is None or item.sentence_id in ids
            )
        except ModelFailure:
            found.append(
                FindingDraft(
                    type="other", severity="high", sentence_id=None, description="报告审查未能完成"
                )
            )
    unique = {
        (item.type, item.sentence_id, item.description if item.sentence_id is None else ""): item
        for item in found
    }
    open_findings = [
        m.ReviewFinding(
            id=stable_id(
                "rf", str(state.review_round), item.type, item.sentence_id or "", item.description
            ),
            type=item.type,
            severity=item.severity,
            sentence_id=item.sentence_id,
            description=item.description,
            status="open",
        )
        for item in unique.values()
    ]
    # 通过条件：无高严重度问题，且中等问题不超过 max(2, 句子数的 10%)（pilot 前在开发任务上校准后冻结）
    medium_limit = max(2, len(sentences) // 10)
    passed = (
        not any(f.severity == "high" for f in open_findings)
        and sum(f.severity == "medium" for f in open_findings) <= medium_limit
    )
    previous = state.reviews[-1].findings if state.reviews else []
    addressed = (
        []
        if not passed
        else [
            item.model_copy(update={"status": "fixed"})
            for item in previous
            if item.status == "open"
        ]
    )
    bus.emit(
        "review.completed",
        m.ReviewResult(
            round=state.review_round, passed=passed, findings=[*open_findings, *addressed], at=now()
        ),
    )
    return passed


# 交付前删除的句子：审查判定为事实性缺陷（高或中严重度）且修复轮次内未能修好
REJECT_TYPES = {
    "unsupported_citation",
    "unavailable_at_cutoff",
    "temporal_error",
    "stage_confusion",
    "other",
}


def finish_report(bus: EventBus) -> bool:
    """删去未通过核查的句子，返回直接答案是否仍有可核实的内容。

    只展示通过核查的句子：与其标出"这句可能不对"，不如不说；
    低严重度（措辞不够精确）保留。
    """
    report = bus.state.report
    if report is None:
        return False
    review = bus.state.reviews[-1] if bus.state.reviews else None
    reviewed = review is not None and review.at >= report.generated_at
    open_findings = (
        [f for f in review.findings if f.status == "open"] if reviewed and review else []
    )
    rejected = {
        f.sentence_id
        for f in open_findings
        if f.severity in ("high", "medium") and f.type in REJECT_TYPES
    }
    quotes = available_quotes(bus.state)

    def clean(paragraph: m.ReportParagraph, uncertainty: bool = False) -> m.ReportParagraph:
        # 无引用的句子只在"不确定性"章节保留（用平实语言说明哪些事尚不清楚）
        sentences = [
            s
            for s in paragraph.sentences
            if s.id not in rejected
            and (s.evidence_ids or (uncertainty and not s.claim_ids))
            and all(eid in quotes for eid in s.evidence_ids)
        ]
        return paragraph.model_copy(update={"sentences": sentences})

    answer = clean(report.answer)
    answered = any(s.evidence_ids for s in answer.sentences)
    if not answered:
        text = (
            "现有证据不足以给出可核实的答案。"
            if report.language == "zh"
            else "The available evidence is insufficient to give a verified answer."
        )
        answer = answer.model_copy(
            update={
                "sentences": [
                    m.ReportSentence(
                        id=stable_id("s", "insufficient"),
                        text=text,
                        claim_ids=[],
                        evidence_ids=[],
                    )
                ]
            }
        )
    sections = [
        s.model_copy(
            update={
                "paragraphs": [
                    p
                    for p in (clean(p, s.kind == "uncertainty") for p in s.paragraphs)
                    if p.sentences
                ]
            }
        )
        for s in report.sections
    ]
    sections = [s for s in sections if s.paragraphs or s.kind == "uncertainty"]
    bus.emit("report.updated", report.model_copy(update={"answer": answer, "sections": sections}))
    return answered


def mark_report(bus: EventBus, reason: m.StopReason, partial: bool) -> None:
    report = bus.state.report
    if report is not None:
        bus.emit(
            "report.updated",
            report.model_copy(update={"stop_reason": reason, "is_partial": partial}),
        )
