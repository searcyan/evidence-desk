"""通过显式开关验证真实供应商、报告引用和模型计量。"""

import asyncio
import json
import os

import pytest
from test_workflow import request

from newsagent.runtime.manager import RunManager
from newsagent.runtime.store import Store
from newsagent.settings import Environment, env_value, load_settings
from newsagent.tools.search import canonical_url
from newsagent.tools.storage import file_key, read_json
from newsagent.workflow.controller import run_workflow


@pytest.mark.live
def test_small_live_task(tmp_path):
    config = load_settings()
    if os.environ.get("NEWSAGENT_LIVE_TEST") != "1":
        pytest.skip("未启用真实供应商测试")
    if not env_value(config.profile(None).api_key_env) or not (
        env_value("TAVILY_API_KEY") or env_value("EXA_API_KEY")
    ):
        pytest.skip("需要模型密钥及至少一家搜索服务密钥")

    async def scenario():
        body = request().model_copy(
            update={
                "question": "Which regulatory approvals were required before Microsoft closed its "
                "acquisition of Activision Blizzard in October 2023?",
                "cutoff": "2023-11-01T23:59:59Z",
                "search_mode": "live",
                "snapshot_id": None,
                "budget_preset": "small",
                "temporal_mode": "retrospective",
            }
        )
        mgr = RunManager(
            Store(tmp_path / "app.db"),
            Environment(newsagent_data_dir=tmp_path),
            config,
            run_workflow,
        )
        try:
            summary = mgr.start(body)
            await asyncio.wait_for(mgr.tasks[summary.id], timeout=300)
            state = mgr.bus(summary.id).state
            assert state.report is not None and state.evidence
            docs = {d.id: d for d in state.documents}
            for evidence in state.evidence:
                fname = file_key(canonical_url(docs[evidence.document_id].url)) + ".json"
                path = tmp_path / "retrieval" / state.id / "pages" / fname
                assert evidence.quote in " ".join(read_json(path)["value"]["text"].split())
            log = tmp_path / "logs" / f"{state.id}.jsonl"
            entries = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            assert sum(item["input_tokens"] for item in entries) == state.usage.input_tokens
            assert sum(item["output_tokens"] for item in entries) == state.usage.output_tokens
            assert sum(item["cost_usd"] for item in entries) == pytest.approx(state.usage.cost_usd)
        finally:
            await mgr.close()

    asyncio.run(scenario())
