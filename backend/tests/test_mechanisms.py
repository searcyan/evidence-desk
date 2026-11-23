"""验证停止顺序、来源计数、日期和近重复归并。"""

from pathlib import Path

import pytest

from newsagent.contracts import models as m
from newsagent.research.policy import MechanismPolicy
from newsagent.research.provenance import origin_groups
from newsagent.research.stopping import decide
from newsagent.research.verdicts import applicable, verdict
from newsagent.settings import Stopping
from newsagent.tools.dates import event_date
from newsagent.tools.local_index import LocalIndex
from newsagent.tools.search import Page
from newsagent.tools.storage import write_text


@pytest.mark.parametrize(
    ("inputs", "round_number", "seconds", "expected"),
    [
        ({}, 1, 1, ("continue_research", None)),
        ({"core_coverage": 1}, 1, 1, ("write_report", "questions_answered")),
        ({"no_progress_rounds": 2}, 2, 1, ("write_report", "no_progress")),
        ({"core_coverage": 1}, 3, 1, ("write_report", "budget_exhausted")),
        ({"budget_remaining_ratio": 0}, 1, 0, ("write_report", "time_limit")),
    ],
)
def test_stop(inputs, round_number, seconds, expected):
    signals = m.DecisionSignals.model_validate(
        {
            "core_coverage": 0,
            "open_high_gaps": 0,
            "new_independent_evidence": 0,
            "new_milestones": 0,
            "budget_remaining_ratio": 1,
            "no_progress_rounds": 0,
        }
        | inputs
    )
    settings = Stopping(
        core_coverage_threshold=0.8, no_progress_rounds_limit=2, min_round_budget_ratio=0.08
    )
    assert decide(signals, round_number, 3, settings, seconds)[:2] == expected


@pytest.mark.parametrize(
    ("source", "temporal", "action_count", "gap_count"),
    [
        (False, False, 2, 1),
        (True, False, 4, 4),
        (False, True, 5, 5),
        (True, True, 7, 7),
    ],
)
def test_policy(source, temporal, action_count, gap_count):
    policy = MechanismPolicy(m.Mechanisms(source_verification=source, temporal_planning=temporal))
    assert len(policy.actions) == action_count
    assert len(policy.gaps) == gap_count


def document(i, available=True, group=None):
    return m.SourceDocument(
        id=f"doc_{i}",
        url=f"https://source{i}.example/article",
        title=f"Article {i}",
        domain=f"source{i}.example",
        publisher=None,
        author=None,
        published_at="2024-01-01T00:00:00Z",
        published_at_source="metadata",
        retrieved_at="2024-06-01T00:00:00Z",
        provider="corpus",
        origin_group_id=group,
        is_original=False,
        attribution="Northwind 2024 release",
        available_at_cutoff=available,
        language="en",
        snippet="",
        round=1,
        action_id=None,
    )


def test_verdict_and_sources():
    docs = {
        d.id: d
        for d in [document(1, True, "og_a"), document(2, True, "og_a"), document(3, False, "og_b")]
    }
    evidence = {
        f"ev_{i}": m.Evidence(
            id=f"ev_{i}", document_id=f"doc_{i}", event_date=None, quote="A valid quote.", round=1
        )
        for i in range(1, 4)
    }
    support = [
        m.ClaimEvidenceLink(evidence_id=f"ev_{i}", relation="supports", note=None) for i in (1, 2)
    ]
    against = [m.ClaimEvidenceLink(evidence_id="ev_3", relation="contradicts", note=None)]
    assert verdict(support + against, evidence, docs, "as_of") == ("supported", {"og_a"})
    assert verdict(support + against, evidence, docs, "retrospective")[0] == "conflicting"
    assert verdict(against, evidence, docs, "retrospective")[0] == "contradicted"
    assert verdict(against, evidence, docs, "as_of")[0] == "insufficient"
    assert verdict([], evidence, docs, "as_of")[0] == "insufficient"


def test_reposts_form_one_group():
    docs = [document(i) for i in range(5)]
    groups = origin_groups(docs, [], lambda _: None)
    assert len(groups) == 1
    assert groups[0].document_ids == [doc.id for doc in docs]


def test_event_dates():
    assert event_date("late February 2024").end == "2024-02-29"
    assert event_date("2021年3月3日").start == "2021-03-03"
    assert event_date("2024-02").precision == "month"
    assert event_date("2022").precision == "year"
    assert applicable(event_date("2025-01-01"), "2024-06-30T00:00:00Z", "as_of", True) is False


def test_local_index_persists_and_filters(tmp_path: Path):
    pool = tmp_path / "documents.jsonl"
    docs = [
        Page(
            url=f"https://x.example/{i}",
            final_url=f"https://x.example/{i}",
            title="Arctic storm",
            text="Flooding following the arctic storm.",
            published_at=f"202{i}-01-01T00:00:00Z",
        )
        for i in range(4)
    ]
    write_text(pool, "".join(d.model_dump_json() + "\n" for d in docs))
    index = LocalIndex(pool)
    index.save()
    window = m.TimeWindow(start="2020-01-01", end="2021-02-01")
    result = index.search("arctic storm", window, 4, [])
    assert len(result) == 2
    assert LocalIndex(pool).search("arctic storm", window, 4, []) == result
    assert index.read(docs[-1].url) == docs[-1]
