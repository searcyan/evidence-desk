"""模型提议结构的容错规整：日期精度、可空参数、超长列表、错放字段。"""

from newsagent.workflow.drafts import (
    ActionDraft,
    AssessDraft,
    ClaimsDraft,
    EvidenceDraft,
    SentenceDraft,
)


def action(params: dict) -> ActionDraft:
    return ActionDraft.model_validate(
        {"type": "search", "rationale": "r", "question_ids": [], "params": params}
    )


def test_partial_dates_are_normalized():
    draft = action(
        {
            "query": "x",
            "date": "2011",
            "window": {"start": "2011", "end": "2012-02"},
        }
    )
    assert draft.params.date is None
    assert draft.params.window is not None
    assert (draft.params.window.start, draft.params.window.end) == ("2011-01-01", "2012-02-29")
    assert action({"query": "x", "date": "2023-02-06T10:00:00Z"}).params.date == "2023-02-06"


def test_missing_nullable_params_are_filled():
    params = action({"query": "x"}).params
    assert params.url is None and params.claim_id is None and params.window is None


def test_overlong_lists_are_truncated():
    evidence = EvidenceDraft.model_validate({"passages": [{"quote": str(i)} for i in range(14)]})
    assert [p.quote for p in evidence.passages] == [str(i) for i in range(8)]
    claim = {
        "text": "t",
        "subject": "s",
        "question_ids": [],
        "evidence_id": "e",
        "relation": "supports",
    }
    assert len(ClaimsDraft.model_validate({"claims": [claim] * 25}).claims) == 20


def test_misplaced_publication_date_is_hoisted():
    draft = EvidenceDraft.model_validate(
        {"passages": [{"quote": "q", "publication_date": "2019-07-01"}]}
    )
    assert draft.publication_date == "2019-07-01"


def test_sentence_without_citations_and_window_timestamp():
    assert SentenceDraft.model_validate({"text": "Unclear."}).evidence_ids == []
    assess = AssessDraft.model_validate(
        {
            "event_name": "e",
            "event_type": "other",
            "entities": [],
            "questions": [],
            "stage_model": [],
            "assumptions": [],
            "initial_window": {"start": "2016-02", "end": "2017-04-07T23:59:59Z"},
        }
    )
    assert assess.initial_window is not None
    assert (assess.initial_window.start, assess.initial_window.end) == (
        "2016-02-01",
        "2017-04-07",
    )


def test_section_paragraph_shapes_keep_every_sentence():
    from newsagent.workflow.drafts import SectionDraft

    s = {"text": "句子", "evidence_ids": ["e1"], "claim_ids": []}
    shapes = {
        "nested": [[s, s]],
        "sentences_key": [{"sentences": [s, s]}],
        # 重写时模型把句子直接平铺在 paragraphs 里：此前会被当成两个空段落，整章丢失
        "flat": [s, s],
        "report_shaped": [{"id": "p1", "sentences": [dict(s, id="s1"), dict(s, id="s2")]}],
        "strings": [["句子", "句子"]],
    }
    for name, paragraphs in shapes.items():
        draft = SectionDraft.model_validate(
            {"title": "t", "kind": "analysis", "paragraphs": paragraphs}
        )
        assert sum(len(p) for p in draft.paragraphs) == 2, name
