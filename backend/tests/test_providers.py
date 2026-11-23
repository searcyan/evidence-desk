"""测试实时适配器的请求契约、降级和模型用量。"""

import asyncio
import json

import httpx
from pydantic import BaseModel
from test_workflow import FakeLLM, manager, request

from newsagent.contracts import models as m
from newsagent.llm.openai_compat import Usage, complete_http
from newsagent.runtime.budget import BudgetTracker
from newsagent.settings import load_settings
from newsagent.tools.retrieval import Retrieval


def test_provider_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "test-token")
    monkeypatch.setenv("EXA_API_KEY", "test-token")
    calls = []

    def respond(req):
        calls.append(req.url.host)
        data = json.loads(req.content)
        if req.url.host == "api.tavily.com":
            assert data["topic"] == "news"
            assert data["start_date"] == "2024-01-01"
            return httpx.Response(503)
        assert data["numResults"] == 8
        assert data["startPublishedDate"] == "2024-01-01T00:00:00Z"
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "url": "https://news.example/orion",
                        "title": "Orion",
                        "publishedDate": "2024-01-02",
                    }
                ]
            },
        )

    async def scenario():
        state = request().model_copy(update={"search_mode": "live", "snapshot_id": None})
        mgr = manager(tmp_path, FakeLLM())
        summary = mgr.start(state)
        task = mgr.tasks[summary.id]
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        bus = mgr.bus(summary.id)
        meter = BudgetTracker(bus)
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            retriever = Retrieval(bus, meter, mgr.config, http, http, 24)
            action = m.ResearchAction(
                id="act_test",
                round=1,
                type="search",
                status="running",
                gap_id=None,
                rationale="Find Orion",
                question_ids=[],
                result=None,
                started_at=None,
                finished_at=None,
                params=m.ResearchActionParams(
                    query="Orion acquisition",
                    url=None,
                    date=None,
                    claim_id=None,
                    window=m.TimeWindow(start="2024-01-01", end="2024-06-01"),
                ),
            )
            hits, provider = await retriever.search(action, [], True)
        assert provider == "exa" and hits[0].title == "Orion"
        assert calls == ["api.tavily.com", "api.exa.ai"]
        assert [tool.ok for tool in bus.state.tool_calls] == [False, True]
        assert meter.usage.search_calls == 2

    asyncio.run(scenario())


class Output(BaseModel):
    value: str


def test_http_model_tool_output():
    profile = load_settings().profile(None).model_copy(update={"structured_output": "tool"})

    def respond(req):
        body = json.loads(req.content)
        assert req.url.path.endswith("/chat/completions")
        assert body["max_tokens"] == 100
        assert body["tool_choice"]["function"]["name"] == "submit_result"
        assert body["tools"][0]["function"]["parameters"]["properties"]["value"]["type"] == "string"
        return httpx.Response(
            200,
            json={
                "usage": {"prompt_tokens": 23, "completion_tokens": 8},
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "function": {"arguments": '{"value":"ok"}'},
                                }
                            ],
                        }
                    }
                ],
            },
        )

    async def scenario():
        usage = Usage()
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await complete_http(
                client, profile, "test", "deepseek-chat", "Return JSON", Output, 100, usage
            )
        assert result.value == "ok"
        assert usage.total_tokens == 31

    asyncio.run(scenario())
