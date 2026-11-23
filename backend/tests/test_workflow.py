"""使用本地文档运行完整工作流，覆盖审查修复和恢复。"""

import asyncio
import json

import httpx
from test_contract import fixture, validates

from newsagent.contracts import models as m
from newsagent.runtime.manager import RunManager
from newsagent.runtime.store import Store
from newsagent.settings import Environment, load_settings
from newsagent.tools.search import Page
from newsagent.tools.storage import write_json, write_text
from newsagent.workflow.controller import run_with_model

QUOTE = "Orion announced the Aurora acquisition on March 3, 2021."


class FakeLLM:
    def __init__(self, clarify=False, repair=False, block=None):
        self.clarify = clarify
        self.repair = repair
        self.block = block
        self.updates = 0
        self.writes = 0

    async def run(self, role, name, inputs, schema, *, research=True):
        result = {}
        if name == "assess":
            ambiguous = self.clarify and not inputs.get("clarified")
            result = {
                "event_name": "Orion Aurora acquisition",
                "event_type": "other",
                "entities": ["Orion", "Aurora"],
                "questions": [{"text": inputs["question"], "priority": "core"}],
                "stage_model": ["announced"],
                "assumptions": [],
                "initial_window": {"start": "2024-01-01", "end": "2024-06-30"},
                "clarifications": [{"text": "Which event?", "options": ["Orion acquisition"]}]
                if ambiguous
                else [],
            }
        elif name == "plan":
            result = {
                "rationale": "Search original notices",
                "source_strategy": "News",
                "actions": [],
            }
        elif name == "evidence":
            if self.block:
                self.block.set()
                await asyncio.Future()
            result = {
                "passages": [
                    {"quote": QUOTE, "event_date_text": "2021-03-03"},
                    {"quote": "A sentence invented by the test."},
                ],
                "attribution": "Orion Aurora acquisition release",
                "is_original": False,
            }
        elif name == "claims":
            key = inputs["task"]["questions"][0]["id"]
            result = {
                "claims": [
                    {
                        "text": "Orion announced the Aurora acquisition.",
                        "subject": "Orion",
                        "stage": "announced",
                        "event_date_text": "2021-03-03",
                        "question_ids": [key],
                        "evidence_id": ev["id"],
                        "relation": "supports",
                        "existing_id": (inputs["existing_claims"] or [{}])[0].get("id"),
                    }
                    for ev in inputs["new_evidence"]
                ]
            }
        elif name == "relations":
            result = {
                "links": [
                    {
                        "claim_id": item["claim_id"],
                        "evidence_id": item["evidence_id"],
                        "relation": "supports",
                        "note": "The quote describes the announcement.",
                    }
                    for item in inputs["pairs"]
                ]
            }
        elif name == "update":
            self.updates += 1
            claim = inputs["claims"][0]
            result = {
                "timeline": [
                    {
                        "title": "Announcement",
                        "summary": claim["text"],
                        "claim_ids": [claim["id"]],
                    }
                ],
                "answers": [
                    {
                        "question_id": inputs["task"]["questions"][0]["id"],
                        "answer_claim_ids": [claim["id"]],
                        "complete": self.updates > 1,
                    }
                ],
            }
        elif name == "write":
            self.writes += 1
            if not inputs["claims"]:
                return schema.model_validate(
                    {"title": "Orion", "answer": [], "sections": [], "open_questions": []}
                )
            item = inputs["claims"][0]
            refs = (
                ["fake_wrong_id"]
                if self.repair and self.writes == 1
                else [
                    item["links"][0]["evidence_id"],
                ]
            )
            result = {
                "title": "Orion and Aurora",
                "answer": [
                    {
                        "text": "Orion announced the acquisition on March 3, 2021.",
                        "evidence_ids": refs,
                        "claim_ids": [item["id"]],
                    }
                ],
                "sections": [],
                "open_questions": [],
                "short_answer": "March 3, 2021",
            }
        elif name == "review":
            result = {"findings": []}
        elif name == "official":
            # 官方协议评分：按输出结构返回固定结果
            kind = schema.__name__
            if kind == "RaceOutput":
                item = {
                    "criterion": "c1",
                    "analysis": "",
                    "article_1_score": 7,
                    "article_2_score": 6,
                }
                result = {
                    dim: [item]
                    for dim in (
                        "comprehensiveness",
                        "insight",
                        "instruction_following",
                        "readability",
                    )
                }
            elif kind == "FactOutput":
                result = {"results": [{"idx": 1, "result": "supported"}]}
            else:
                result = {
                    "extracted_final_answer": "March 3, 2021",
                    "reasoning": "",
                    "correct": "yes",
                }
        elif name == "grade":
            keys = inputs.get("metrics", [])
            scores = {key: (82.0 if key.startswith("race_") else 1.0) for key in keys}
            scores.update({p["id"]: 1 for p in inputs.get("pairs", [])})
            if inputs.get("correct_answer"):
                scores["accuracy"] = 1.0
            result = {"metrics": scores}
        return schema.model_validate(result)


def prepare_pool(root):
    pages = [
        Page(
            url=f"https://press{i}.example/orion",
            final_url=f"https://press{i}.example/orion",
            title="Orion Aurora acquisition",
            text=QUOTE + " This was included in the release.",
            published_at="2024-06-30T22:00:00Z" if i == 5 else "2024-04-02T12:00:00Z",
            published_at_source="metadata",
            doc_id=str(i),
        )
        for i in range(6)
    ]
    path = root / "snapshots/news"
    write_text(path / "documents.jsonl", "".join(p.model_dump_json() + "\n" for p in pages))
    write_json(
        path / "manifest.json",
        {
            "info": {
                "id": "news",
                "label": "News fixture",
                "created_at": "2024-07-01T00:00:00Z",
                "entries": 6,
            }
        },
    )
    return pages


def request():
    return m.RunRequest.model_validate(
        fixture("run_request")
        | {
            "question": "When did Orion announce the Aurora acquisition?",
            "cutoff": "2024-06-30T20:00:00Z",
            "search_mode": "snapshot",
            "snapshot_id": "news",
        }
    )


def manager(root, fake, clarification_timeout=120):
    async def workflow(mgr, bus):
        await run_with_model(mgr, bus, fake)

    return RunManager(
        Store(root / "app.db"),
        Environment(
            newsagent_data_dir=root,
            clarification_timeout_seconds=clarification_timeout,
        ),
        load_settings(),
        workflow,
    )


async def wait_status(bus, status):
    async with asyncio.timeout(10):
        while bus.state.status != status:
            await bus.changed.wait()


def test_full_workflow_asks_repairs_and_uses_only_local_data(tmp_path, monkeypatch):
    prepare_pool(tmp_path)

    async def blocked(*args, **kwargs):
        raise AssertionError("本地快照不应访问网络")

    monkeypatch.setattr(httpx.AsyncClient, "send", blocked)

    async def scenario():
        fake = FakeLLM(clarify=True, repair=True)
        mgr = manager(tmp_path, fake)
        summary = mgr.start(request())
        bus = mgr.bus(summary.id)
        await wait_status(bus, "awaiting_clarification")
        q = bus.state.clarification.questions[0]
        mgr.answer(
            summary.id,
            m.ClarificationAnswer(
                answers=[
                    m.ClarificationAnswerAnswersItem(question_id=q.id, answer="Orion acquisition"),
                ]
            ),
        )
        await mgr.tasks[summary.id]
        detail = bus.state
        assert detail.status == "completed", detail.error
        assert detail.research_round >= 2
        assert detail.review_round == 2
        assert not detail.reviews[0].passed and detail.reviews[1].passed
        assert any(d.kind == "reverify" for d in detail.decisions)
        assert detail.report.version == 2
        assert [d.available_at_cutoff for d in detail.documents].count(False) == 1
        assert all(
            next(d for d in detail.documents if d.id == e.document_id).available_at_cutoff is True
            for e in detail.evidence
        )
        assert all(e.quote == QUOTE for e in detail.evidence)
        assert len(detail.origin_groups[0].document_ids) == 6
        assert any(g.type == "single_source" for g in detail.gaps)
        assert detail.claims[0].independent_sources == 1
        assert detail.timeline[0].date.start == "2021-03-03"
        assert detail.usage.search_calls + detail.usage.read_calls <= int(
            detail.budget.max_tool_calls * (1 - detail.budget.reserve_ratio)
        )
        assert detail.decisions[1].signals.new_independent_evidence == 0
        assert detail.decisions[1].signals.new_milestones == 0
        validates("RunDetail", json.loads(detail.model_dump_json()))
        validates("Report", json.loads(detail.report.model_dump_json()))
        await mgr.close()

    asyncio.run(scenario())


def test_resume_preserves_unflushed_tool_usage(tmp_path):
    prepare_pool(tmp_path)

    async def scenario():
        entered = asyncio.Event()
        first = manager(tmp_path, FakeLLM(block=entered))
        summary = first.start(request())
        await asyncio.wait_for(entered.wait(), 10)
        before = first.store.metered(summary.id)
        await first.close()
        second = manager(tmp_path, FakeLLM())
        second.recover()
        assert second.bus(summary.id).state.error.type == "interrupted"
        second.resume(summary.id)
        await second.tasks[summary.id]
        result = second.bus(summary.id).state
        assert result.status in ("completed", "partial"), result.error
        # 恢复后完成的运行不应再带着上次中断的错误
        assert result.error is None
        assert result.usage.read_calls >= before.read_calls
        assert result.report is not None
        assert second.store.detail(summary.id) == result
        await second.close()

    asyncio.run(scenario())


def test_clarification_timeout(tmp_path):
    prepare_pool(tmp_path)

    async def scenario():
        mgr = manager(tmp_path, FakeLLM(clarify=True), clarification_timeout=0)
        summary = mgr.start(request())
        await mgr.tasks[summary.id]
        state = mgr.bus(summary.id).state
        assert state.report and state.clarification is None
        events = mgr.store.events(summary.id)
        assert sum(ev.type == "clarification.requested" for ev in events) == 1
        assert any(ev.type == "clarification.answered" and not ev.data.answers for ev in events)
        await mgr.close()

    asyncio.run(scenario())
