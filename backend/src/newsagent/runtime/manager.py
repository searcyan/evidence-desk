"""调度研究任务，处理澄清、取消和重启恢复。"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import BinaryIO
from urllib.parse import urlsplit

from ..api.errors import conflict, invalid, not_found
from ..contracts import models as m
from ..settings import Configuration, Environment
from .events import EventBus
from .ownership import acquire
from .state import TERMINAL, empty_detail, initial_summary, new_id, now, to_summary
from .store import Store

Workflow = Callable[["RunManager", EventBus], Awaitable[None]]


class RunManager:
    def __init__(
        self, store: Store, environment: Environment, config: Configuration, workflow: Workflow
    ):
        self.store, self.config, self.workflow = store, config, workflow
        self.root = store.path.parent
        self.slots = asyncio.Semaphore(environment.newsagent_max_concurrent_runs)
        self.clarification_timeout = environment.clarification_timeout_seconds
        self.cache_hours = environment.newsagent_cache_hours
        self.buses: dict[str, EventBus] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.answers: dict[str, asyncio.Future[m.ClarificationAnswer]] = {}
        self.closing = False

    def recover(self) -> None:
        for summary in self.store.list(["queued", "running", "awaiting_clarification"], limit=-1):
            lease = self.ownership(summary.id)
            if lease is None:
                continue
            with lease:
                bus = self.bus(summary.id)
                if bus.state.status in TERMINAL:
                    continue
                bus.emit("run.error", {"type": "interrupted", "message": "进程中断，可恢复运行"})
                self.finish(bus, "failed", "error")

    def ownership(self, run_id: str) -> BinaryIO | None:
        return acquire(self.root / "locks" / f"{run_id}.lock")

    def bus(self, run_id: str) -> EventBus:
        if run_id not in self.buses:
            state = self.store.detail(run_id)
            if state is None:
                raise not_found("运行不存在")
            self.buses[run_id] = EventBus(state, self.store)
        bus = self.buses[run_id]
        if run_id not in self.tasks:
            bus.refresh()
            if bus.deleted:
                raise not_found("运行不存在")
        return bus

    def start(self, request: m.RunRequest) -> m.RunSummary:
        if datetime.fromisoformat(request.cutoff) > datetime.now(UTC):
            raise invalid("截止时间不得晚于当前时间")
        if request.seed_url:
            try:
                url = urlsplit(request.seed_url)
                if url.scheme not in ("http", "https") or not url.hostname or url.username:
                    raise ValueError
            except ValueError as exc:
                raise invalid("种子链接必须为 HTTP 或 HTTPS URL") from exc
        if request.search_mode == "snapshot":
            from ..tools.local_index import snapshot_infos

            if request.snapshot_id not in {item.id for item in snapshot_infos(self.root)}:
                raise invalid("检索快照不存在")
        if (
            request.search_mode == "corpus"
            and not (self.root / "benchmarks/browsecomp_plus/corpus/corpus.sqlite").is_file()
        ):
            raise invalid("本地评测语料未配置")
        try:
            limits = self.config.budget(request)
            self.config.profile(request.model_profile)
        except ValueError as exc:
            raise invalid("模型配置或预算无效，自定义预算须填写所有上限") from exc
        summary = initial_summary(new_id("run"), request, limits)
        lease = self.ownership(summary.id)
        if lease is None:
            raise conflict("运行正在创建，请重试")
        try:
            self.store.create(summary)
            bus = EventBus(empty_detail(summary), self.store)
            self.buses[summary.id] = bus
            self.spawn(bus, lease)
        except BaseException:
            lease.close()
            raise
        return summary

    def spawn(self, bus: EventBus, lease: BinaryIO) -> None:
        run_id = bus.state.id
        task = asyncio.create_task(self.execute(bus), name=run_id)
        self.tasks[run_id] = task

        def cleanup(finished: asyncio.Task[None]) -> None:
            lease.close()
            if self.tasks.get(run_id) is finished:
                self.tasks.pop(run_id, None)

        task.add_done_callback(cleanup)

    async def execute(self, bus: EventBus) -> None:
        try:
            async with self.slots:
                bus.emit("run.status", {"status": "running", "phase": None})
                await self.workflow(self, bus)
        except asyncio.CancelledError:
            if self.closing and bus.state.status not in TERMINAL:
                bus.emit("run.error", {"type": "interrupted", "message": "服务关闭，可恢复运行"})
                self.finish(bus, "failed", "error")
            raise
        except Exception as exc:  # noqa: BLE001
            import logging

            logging.getLogger(__name__).error(
                "研究运行异常 %s %s", bus.state.id, type(exc).__name__
            )
            if bus.state.status not in TERMINAL:
                bus.emit("run.error", {"type": "workflow_error", "message": "研究运行异常"})
                self.finish(bus, "failed", "error")

    def finish(self, bus: EventBus, status: m.RunStatus, reason: m.StopReason) -> None:
        metered = self.store.metered(bus.state.id)
        if metered and metered != bus.state.usage:
            bus.emit("budget.updated", metered)
        if bus.state.clarification:
            bus.emit("clarification.answered", {"answers": []})
        if bus.state.report and status == "cancelled":
            bus.emit(
                "report.updated",
                bus.state.report.model_copy(
                    update={
                        "is_partial": True,
                        "stop_reason": reason,
                    }
                ),
            )
        bus.emit("run.finished", {"status": status, "stop_reason": reason, "finished_at": now()})

    async def clarify(
        self, bus: EventBus, request: m.ClarificationRequest
    ) -> m.ClarificationAnswer:
        bus.emit("clarification.requested", request)
        bus.emit("run.status", {"status": "awaiting_clarification", "phase": "assess"})
        future = asyncio.get_running_loop().create_future()
        self.answers[bus.state.id] = future
        try:
            return await asyncio.wait_for(future, self.clarification_timeout)
        except TimeoutError:
            answer = m.ClarificationAnswer(answers=[])
            bus.emit("clarification.answered", answer)
            bus.emit("log", {"level": "info", "message": "澄清超时，按默认假设继续"})
            bus.emit("run.status", {"status": "running", "phase": "assess"})
            return answer
        finally:
            self.answers.pop(bus.state.id, None)

    def answer(self, run_id: str, answer: m.ClarificationAnswer) -> m.RunSummary:
        bus = self.bus(run_id)
        future = self.answers.get(run_id)
        request = bus.state.clarification
        if request is None or future is None or future.done():
            raise conflict("当前运行没有待回复的澄清请求")
        received = [item.question_id for item in answer.answers]
        expected = {item.id for item in request.questions}
        if (
            len(received) != len(expected)
            or set(received) != expected
            or any(not item.answer.strip() for item in answer.answers)
        ):
            raise invalid("请为每个澄清问题提交一个非空答案")
        bus.emit("clarification.answered", answer)
        bus.emit("run.status", {"status": "running", "phase": "assess"})
        future.set_result(answer)
        return to_summary(bus.state)

    async def cancel(self, run_id: str) -> m.RunSummary:
        bus = self.bus(run_id)
        if bus.state.status in TERMINAL:
            raise conflict("运行已结束")
        task = self.tasks.get(run_id)
        if task is None:
            lease = self.ownership(run_id)
            if lease is None:
                raise conflict("请在启动该运行的本地进程中取消")
            with lease:
                bus.refresh()
                if bus.state.status in TERMINAL:
                    raise conflict("运行已结束")
                self.finish(bus, "cancelled", "cancelled")
        else:
            task.cancel()
            self.finish(bus, "cancelled", "cancelled")
            await asyncio.gather(task, return_exceptions=True)
        return to_summary(bus.state)

    def resume(self, run_id: str) -> m.RunSummary:
        bus = self.bus(run_id)
        if bus.state.status != "failed":
            raise conflict("只有失败或中断的运行可以恢复")
        lease = self.ownership(run_id)
        if lease is None:
            raise conflict("该运行正由其他本地进程处理")
        try:
            bus.refresh()
            if bus.state.status != "failed":
                raise conflict("只有失败或中断的运行可以恢复")
            bus.emit("run.status", {"status": "queued", "phase": None})
            summary = to_summary(bus.state)
            self.spawn(bus, lease)
        except BaseException:
            lease.close()
            raise
        return summary

    async def delete(self, run_id: str) -> None:
        bus = self.bus(run_id)
        if bus.state.status not in TERMINAL:
            await self.cancel(run_id)
        self.store.delete(run_id)
        bus.deleted = True
        bus.changed.set()
        self.buses.pop(run_id, None)

    async def close(self) -> None:
        self.closing = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
