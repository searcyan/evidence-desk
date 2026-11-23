"""研究质量与报告交付的回归测试：日期解析、阶段模型、时间线收录、审查修复与交付清理。"""

import asyncio

import pytest
from test_workflow import FakeLLM, manager, prepare_pool, request

from newsagent.tools.dates import event_date
from newsagent.workflow.planning import STAGES, stage_model

ANCHOR = "2026-10-08T00:00:00+00:00"


@pytest.mark.parametrize(
    ("text", "start", "precision"),
    [
        ("1900年、2000年", "1900-01-01", "year"),  # 多个日期取第一个，不能变成公元 26 年
        ("2026年9月30日", "2026-09-30", "day"),
        ("March 3, 2021", "2021-03-03", "day"),
        ("2026年11月", "2026-11-01", "month"),
        ("1859", "1859-01-01", "year"),
    ],
)
def test_event_date_parses_plausible_dates(text, start, precision):
    parsed = event_date(text, ANCHOR)
    assert parsed is not None
    assert (parsed.start, parsed.precision) == (start, precision)


@pytest.mark.parametrize(
    "text",
    ["截至2026年11月23日", "As of November 2026", "26-10-08", "0026-10-08"],
)
def test_event_date_rejects_states_and_guesses(text):
    # "截至…"描述状态而非事件；短数字串和不合理年份不作为事件日期
    assert event_date(text, ANCHOR) is None


def test_stage_model_rejects_narrative_labels():
    narrative = ["历史背景:1859年黎曼提出", "2024年阶段性突破:某团队得出下界估计"]
    assert stage_model(narrative, "other") == STAGES["other"] == []
    assert stage_model(["Announced", "regulatory review", "closed"], "acquisition") == [
        "announced",
        "regulatory_review",
        "closed",
    ]
    assert stage_model([], "acquisition") == STAGES["acquisition"]


class TimelineLLM(FakeLLM):
    """update 返回指定的时间线行。"""

    def __init__(self, rows):
        super().__init__()
        self.rows = rows

    async def run(self, role, name, inputs, schema, *, research=True):
        result = await super().run(role, name, inputs, schema, research=research)
        if name == "update":
            claim = inputs["claims"][0]["id"]
            rows = [
                {"title": f"Row {i}", "summary": "", "claim_ids": [claim]} for i in range(self.rows)
            ]
            return schema.model_validate(result.model_dump() | {"timeline": rows})
        return result


@pytest.mark.parametrize(("rows", "expected"), [(0, 0), (2, 1)])
def test_timeline_only_model_selected_events_once(tmp_path, rows, expected):
    prepare_pool(tmp_path)

    async def scenario():
        mgr = manager(tmp_path, TimelineLLM(rows))
        summary = mgr.start(request())
        await mgr.tasks[summary.id]
        state = mgr.bus(summary.id).state
        # 未被选入时间线的声明不再自动补入；同一声明只出现在一个条目里
        assert len(state.timeline) == expected
        await mgr.close()

    asyncio.run(scenario())


class ReviewLLM(FakeLLM):
    """写 4 句答案；审查对后 3 句报中等问题，fixed_after 轮之后不再报。"""

    def __init__(self, fixed_after: int | None):
        super().__init__()
        self.fixed_after = fixed_after
        self.reviews = 0

    async def run(self, role, name, inputs, schema, *, research=True):
        if name == "write" and inputs["claims"]:
            self.writes += 1
            item = inputs["claims"][0]
            ref = item["links"][0]["evidence_id"]
            sentences = [
                {"text": f"Sentence {i}.", "evidence_ids": [ref], "claim_ids": [item["id"]]}
                for i in range(4)
            ]
            return schema.model_validate(
                {"title": "Orion", "answer": sentences, "sections": [], "open_questions": []}
            )
        if name == "review":
            self.reviews += 1
            if self.fixed_after is not None and self.reviews > self.fixed_after:
                return schema.model_validate({"findings": []})
            ids = [entry["sentence"]["id"] for entry in inputs["batch"]][1:]
            findings = [
                {
                    "type": "unsupported_citation",
                    "severity": "medium",
                    "sentence_id": sid,
                    "description": "引文没有支持这句话",
                }
                for sid in ids
            ]
            return schema.model_validate({"findings": findings})
        return await super().run(role, name, inputs, schema, research=research)


def test_medium_findings_trigger_repair(tmp_path):
    prepare_pool(tmp_path)

    async def scenario():
        llm = ReviewLLM(fixed_after=1)
        mgr = manager(tmp_path, llm)
        summary = mgr.start(request())
        await mgr.tasks[summary.id]
        state = mgr.bus(summary.id).state
        # 只有中等问题也要重写一次，第二轮审查通过
        assert llm.writes == 2 and len(state.reviews) == 2
        assert state.reviews[-1].passed
        assert state.status == "completed" and not state.report.is_partial
        assert len(state.report.answer.sentences) == 4
        await mgr.close()

    asyncio.run(scenario())


def test_unresolved_sentences_removed_before_delivery(tmp_path):
    prepare_pool(tmp_path)

    async def scenario():
        llm = ReviewLLM(fixed_after=None)
        mgr = manager(tmp_path, llm)
        summary = mgr.start(request())
        await mgr.tasks[summary.id]
        state = mgr.bus(summary.id).state
        # 修复轮次用完仍未通过：删掉被判为无依据的句子，只交付核查通过的内容
        assert len(state.reviews) == 2 and not state.reviews[-1].passed
        assert [s.text for s in state.report.answer.sentences] == ["Sentence 0."]
        assert state.status == "completed" and not state.report.is_partial
        # 审查器的内部意见不进入给用户看的开放问题
        assert not any("引文" in q for q in state.report.open_questions)
        await mgr.close()

    asyncio.run(scenario())


def test_gap_rules_focus_on_answer_claims_and_events(tmp_path):
    from newsagent.contracts import models as m
    from newsagent.research.gaps import detect_gaps
    from newsagent.research.policy import MechanismPolicy

    prepare_pool(tmp_path)

    async def finished():
        mgr = manager(tmp_path, FakeLLM())
        summary = mgr.start(request())
        await mgr.tasks[summary.id]
        state = mgr.bus(summary.id).state
        await mgr.close()
        return state

    state = asyncio.run(finished())
    policy = MechanismPolicy(m.Mechanisms(source_verification=True, temporal_planning=True))
    claim = state.claims[0]
    assert state.task is not None

    def kinds(claim_update: dict, answered: bool) -> set[str]:
        questions = [
            q.model_copy(update={"answer_claim_ids": [claim.id] if answered else []})
            for q in state.task.questions
        ]
        task = state.task.model_copy(update={"questions": questions})
        variant = state.model_copy(
            update={"task": task, "gaps": [], "claims": [claim.model_copy(update=claim_update)]}
        )
        return {g.type for g in detect_gaps(variant, policy) if claim.id in g.claim_ids}

    # 支撑答案的单一来源声明才记"单一来源"；只是相关、未用于答案的声明不记
    assert "single_source" in kinds({}, answered=True)
    assert "single_source" not in kinds({}, answered=False)
    # 状态陈述（无阶段、无事件日期）不算"日期不清"；有阶段却没日期的事件才算
    assert "unclear_date" not in kinds({"event_date": None, "stage": None}, answered=True)
    assert "unclear_date" in kinds({"event_date": None, "stage": "announced"}, answered=True)
    assert "unclear_date" not in kinds({"event_date": None, "stage": "announced"}, answered=False)
