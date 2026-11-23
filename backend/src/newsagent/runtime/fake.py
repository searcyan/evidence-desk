"""使用契约样例回放完整工作流。"""

import asyncio
import json

from ..settings import ROOT
from .events import EventBus
from .manager import RunManager
from .state import now


async def fake_workflow(manager: RunManager, bus: EventBus) -> None:
    fixture = ROOT.parent / "contracts/fixtures/run_events.json"
    events = json.loads(fixture.read_text(encoding="utf-8"))
    for event in events:
        await asyncio.sleep(0.025)
        kind, data = event["type"], event["data"]
        if kind == "run.status":
            continue
        if kind == "run.finished":
            data["finished_at"] = now()
        bus.emit(kind, data)
        if kind == "step.completed":
            bus.checkpoint(data["step"], data["round"])
