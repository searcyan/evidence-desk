"""验证中断恢复时的所有权、应用预算和长事件流。"""

import asyncio

import pytest
from test_workflow import FakeLLM, manager, prepare_pool, request, wait_status

from newsagent.contracts import models as m
from newsagent.runtime.budget import BudgetExceeded, BudgetTracker
from newsagent.runtime.events import EventBus
from newsagent.runtime.manager import RunManager
from newsagent.runtime.state import empty_detail, initial_summary
from newsagent.runtime.store import Store
from newsagent.settings import Environment, Price, load_settings


def test_research_cannot_use_reserved_budget(tmp_path):
    config = load_settings()
    db = Store(tmp_path / "app.db")
    limits = config.budget_presets.small.model_copy(
        update={
            "max_tool_calls": 8,
            "max_llm_tokens": 1000,
            "max_cost_usd": 0.001,
            "reserve_ratio": 0.25,
        }
    )
    summary = initial_summary("run_test", request(), limits)
    db.create(summary)
    bus = EventBus(empty_detail(summary), db)
    budget = BudgetTracker(bus)
    for _ in range(6):
        budget.tool("search", True)
    with pytest.raises(BudgetExceeded):
        budget.tool("search", True)
    assert budget.tools_left(True) == 0
    assert budget.tools_left(False) == 2
    budget.tool("search", False)
    budget.tool("read", False)
    with pytest.raises(BudgetExceeded):
        budget.tool("read", False)
    price = Price(input=1, output=2)
    tokens, output = budget.model_limits(500, price, True)
    assert tokens == 750 and 0 < output <= 125
    budget.model_usage(1, 500, output, price)
    budget.flush(force=True)
    assert bus.state.usage.cost_usd <= 0.00075
    assert db.detail(summary.id).usage == budget.usage


def test_other_manager_tails_an_active_run(tmp_path):
    prepare_pool(tmp_path)

    async def scenario():
        owner = manager(tmp_path, FakeLLM(clarify=True))
        observer = manager(tmp_path, FakeLLM())
        summary = owner.start(request())
        bus = owner.bus(summary.id)
        await wait_status(bus, "awaiting_clarification")
        observer.recover()
        assert observer.bus(summary.id).state.status == "awaiting_clarification"
        q = bus.state.clarification.questions[0]
        owner.answer(
            summary.id,
            m.ClarificationAnswer(
                answers=[
                    m.ClarificationAnswerAnswersItem(question_id=q.id, answer="Orion"),
                ]
            ),
        )
        await owner.tasks[summary.id]
        assert observer.bus(summary.id).state == bus.state
        await owner.close()
        await observer.close()

    asyncio.run(scenario())


def test_large_stream_replays_all_events(tmp_path):
    async def workflow(mgr, bus):
        for index in range(1100):
            bus.emit("log", {"level": "debug", "message": f"记录 {index}"})
        mgr.finish(bus, "partial", "no_progress")

    async def scenario():
        env = Environment(newsagent_data_dir=tmp_path)
        raw = request().model_copy(update={"snapshot_id": None, "search_mode": "live"})
        mgr = RunManager(Store(tmp_path / "app.db"), env, load_settings(), workflow)
        summary = mgr.start(raw)
        bus = mgr.bus(summary.id)
        records = [record async for record in bus.stream(999)]
        assert bus.state.last_event_seq == 1102
        assert len(records) == 104
        assert records[0].startswith("id: 1000\n")
        assert records[-1] == "event: end\ndata: {}\n\n"
        await mgr.close()

    asyncio.run(scenario())
