"""测试同一交易不同阶段的声明拆分与基线日期。"""

import asyncio

import httpx
from test_mechanisms import document
from test_workflow import request

from newsagent.contracts import models as m
from newsagent.research.policy import MechanismPolicy
from newsagent.runtime.budget import BudgetTracker
from newsagent.runtime.events import EventBus
from newsagent.runtime.state import empty_detail, initial_summary
from newsagent.runtime.store import Store
from newsagent.settings import load_settings
from newsagent.tools.retrieval import Retrieval
from newsagent.workflow.verify import verify


class StageModel:
    async def run(self, role, name, inputs, schema, *, research=True):
        base = {"subject": "Orion", "question_ids": ["q_main"], "existing_id": None}
        claim = base | {
            "text": "The Orion acquisition closed",
            "stage": "closed",
            "event_date_text": "2024-05-01",
        }
        if name == "claims":
            data = {
                "claims": [
                    claim
                    | {
                        "evidence_id": evidence["id"],
                        "relation": "supports",
                    }
                    for evidence in inputs["new_evidence"]
                ]
            }
        elif name == "relations":
            data = {
                "links": [
                    {
                        "claim_id": pair["claim_id"],
                        "evidence_id": pair["evidence_id"],
                        "relation": "contradicts"
                        if pair["evidence_id"] == "ev_approval"
                        else "supports",
                        "note": "Approval and closure are distinct.",
                    }
                    for pair in inputs["pairs"]
                ]
            }
        elif name == "conflict":
            data = {
                "same_assertion": False,
                "reason": "Different stages and dates.",
                "alternatives": [
                    base
                    | {
                        "text": "Regulators approved the Orion acquisition",
                        "stage": "approved",
                        "event_date_text": "2024-04-15",
                        "relation": "supports",
                        "evidence_id": "ev_approval",
                    },
                ],
            }
        else:
            raise AssertionError(name)
        return schema.model_validate(data)


def test_approval_and_closure_split(tmp_path):
    async def scenario():
        config = load_settings()
        req = request().model_copy(
            update={
                "mechanisms": m.Mechanisms(source_verification=False, temporal_planning=True),
            }
        )
        db = Store(tmp_path / "app.db")
        summary = initial_summary("run_stage", req, config.budget_presets.small)
        db.create(summary)
        bus = EventBus(empty_detail(summary), db)
        bus.emit(
            "task.assessed",
            m.TaskSpec(
                event_name="Orion acquisition",
                event_type="acquisition",
                entities=["Orion"],
                cutoff=req.cutoff,
                temporal_mode="as_of",
                stage_model=["approved", "closed"],
                initial_window=m.TimeWindow(start="2024-01-01", end="2024-06-30"),
                assumptions=[],
                questions=[
                    m.SubQuestion(
                        id="q_main",
                        text="Did Orion close?",
                        priority="core",
                        status="open",
                        answer_claim_ids=[],
                    )
                ],
            ),
        )
        bus.emit("step.started", {"step": "plan", "round": 1})
        early = document(1, True)
        late = document(2, True)
        for doc in (early, late):
            bus.emit("document.added", doc)
        prior = m.Evidence(
            id="ev_approval",
            document_id=early.id,
            quote="The regulators approved on April 15.",
            event_date=None,
            round=1,
        )
        after = m.Evidence(
            id="ev_closure",
            document_id=late.id,
            quote="Orion closed on May 1.",
            event_date=None,
            round=1,
        )
        for entry in (prior, after):
            bus.emit("evidence.added", entry)
        async with httpx.AsyncClient() as client:
            replay = Retrieval(bus, BudgetTracker(bus), config, client, client, 24)
            await verify(bus, StageModel(), MechanismPolicy(req.mechanisms), replay)
        assert {c.stage: c.verdict for c in bus.state.claims} == {
            "approved": "supported",
            "closed": "supported",
        }
        base = MechanismPolicy(m.Mechanisms(source_verification=False, temporal_planning=False))
        temporal = MechanismPolicy(req.mechanisms)
        assert base.claim_date("2021-04-15", prior, early).start == "2024-01-01"
        assert temporal.claim_date("2021-04-15", prior, early).start == "2021-04-15"

    asyncio.run(scenario())
