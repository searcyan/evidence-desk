"""验证审查额度用尽和中断前状态恢复。"""

import asyncio

from test_workflow import FakeLLM, manager, prepare_pool, request


def test_failed_review_returns_partial_report(tmp_path):
    prepare_pool(tmp_path)

    async def scenario():
        mgr = manager(tmp_path, FakeLLM(repair=True))
        body = request().model_copy(update={"budget_preset": "small"})
        summary = mgr.start(body)
        await mgr.tasks[summary.id]
        state = mgr.bus(summary.id).state
        assert state.status == "partial" and state.report.is_partial
        assert state.stop_reason == "review_unresolved"
        assert state.report.open_questions
        assert len(state.reviews) == 1
        assert all(
            "fake_wrong_id" not in sentence.evidence_ids
            for sentence in state.report.answer.sentences
        )
        await mgr.close()

    asyncio.run(scenario())


def test_recover_unowned_running_row(tmp_path):
    from newsagent.runtime.events import EventBus
    from newsagent.runtime.state import empty_detail, initial_summary

    prepare_pool(tmp_path)
    mgr = manager(tmp_path, FakeLLM())
    summary = initial_summary("run_abrupt", request(), mgr.config.budget_presets.medium)
    mgr.store.create(summary)
    bus = EventBus(empty_detail(summary), mgr.store)
    bus.emit("run.status", {"status": "running", "phase": "collect"})
    mgr.recover()
    restored = mgr.bus(summary.id).state
    assert restored.status == "failed"
    assert restored.error.type == "interrupted"
    assert mgr.store.detail(summary.id) == restored
