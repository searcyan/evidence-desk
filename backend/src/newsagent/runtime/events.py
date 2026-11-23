"""校验、持久化并通知订阅者。"""

import asyncio
from collections.abc import AsyncIterator
from time import monotonic

from ..contracts import models as m
from .state import TERMINAL, apply_event, now
from .store import Store


class EventBus:
    def __init__(self, state: m.RunDetail, store: Store):
        self.state = state
        self.store = store
        self.changed = asyncio.Event()
        self.deleted = False

    def emit(
        self, kind: str, data: m.ContractModel | dict[str, object], at: str | None = None
    ) -> m.RunEvent:
        event = m.EVENT_ADAPTER.validate_python(
            {
                "type": kind,
                "data": data.model_dump() if isinstance(data, m.ContractModel) else data,
                "seq": self.state.last_event_seq + 1,
                "ts": at or now(),
                "run_id": self.state.id,
            }
        )
        updated = apply_event(self.state, event)
        self.store.append(event, updated)
        self.state = updated
        self.changed.set()
        self.changed = asyncio.Event()
        return event

    def checkpoint(self, step: str, round_number: int) -> None:
        self.store.checkpoint(self.state, step, round_number, now())

    def refresh(self) -> None:
        revision = self.store.revision(self.state.id)
        if revision is None:
            self.deleted = True
        elif revision > self.state.last_event_seq:
            for event in self.store.events(self.state.id, self.state.last_event_seq):
                self.state = apply_event(self.state, event)

    async def stream(self, after: int) -> AsyncIterator[str]:
        heartbeat = monotonic() + 15
        while True:
            revision = self.changed
            self.refresh()
            for event in self.store.events(self.state.id, after, limit=200):
                after = event.seq
                yield f"id: {event.seq}\nevent: {event.type}\ndata: {event.model_dump_json()}\n\n"
            if self.deleted:
                break
            if after < self.state.last_event_seq:
                continue
            if self.state.status in TERMINAL:
                break
            try:
                await asyncio.wait_for(
                    revision.wait(), timeout=min(1, max(0, heartbeat - monotonic()))
                )
            except TimeoutError:
                if monotonic() >= heartbeat:
                    yield ": ping\n\n"
                    heartbeat = monotonic() + 15
        yield "event: end\ndata: {}\n\n"
