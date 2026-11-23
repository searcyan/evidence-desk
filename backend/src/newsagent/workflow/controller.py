"""以显式状态机运行研究和共享预算的报告审查循环。"""

from collections.abc import Awaitable, Callable
from time import monotonic

import httpx

from ..contracts import models as m
from ..llm.runner import LLM, ModelFailure, ModelRunner
from ..reporting.report import (
    build_report,
    finish_report,
    mark_report,
    report_sentences,
    review_report,
    safe_fallback,
    write_report,
)
from ..research.policy import MechanismPolicy
from ..research.stopping import decide
from ..runtime.budget import BudgetExceeded, BudgetTracker
from ..runtime.events import EventBus
from ..runtime.manager import RunManager
from ..runtime.state import new_id, now
from ..tools.retrieval import Retrieval, proxy_configured
from .collect import collect, collect_page
from .planning import assess, plan
from .verify import update, verify


def progress(state: m.RunDetail) -> tuple[set[str], set[str], set[str], dict[str, str]]:
    core = {q.id for q in state.task.questions if q.priority == "core"} if state.task else set()
    docs = {doc.id: doc.origin_group_id or doc.id for doc in state.documents}
    evidence = {item.id: docs.get(item.document_id) for item in state.evidence}
    claims = [c for c in state.claims if core.intersection(c.question_ids)]
    sources = {
        group
        for c in claims
        for link in c.links
        if link.relation == "supports" and (group := evidence.get(link.evidence_id)) is not None
    }
    milestones = {t.stage or t.id for t in state.timeline if t.is_milestone}
    open_gaps = {
        g.id for g in state.gaps if g.priority == "high" and g.status in ("open", "in_progress")
    }
    return sources, milestones, open_gaps, {c.id: c.verdict for c in claims}


class Controller:
    def __init__(
        self,
        manager: RunManager,
        bus: EventBus,
        budget: BudgetTracker,
        llm: ModelRunner,
        retrieval: Retrieval,
    ):
        self.manager, self.bus, self.budget, self.llm = manager, bus, budget, llm
        self.retrieval = retrieval
        self.policy = MechanismPolicy(bus.state.request.mechanisms)

    async def step[T](self, phase: m.Phase, round_number: int, fn: Callable[[], Awaitable[T]]) -> T:
        start = monotonic()
        self.bus.emit("step.started", {"step": phase, "round": round_number})
        if phase == "plan":
            self.budget.update(research_rounds=max(self.budget.usage.research_rounds, round_number))
        elif phase == "review":
            self.budget.update(review_rounds=max(self.budget.usage.review_rounds, round_number))
        result = await fn()
        self.budget.flush()
        self.bus.emit(
            "step.completed",
            {
                "step": phase,
                "round": round_number,
                "duration_ms": int((monotonic() - start) * 1000),
            },
        )
        self.bus.checkpoint(phase, round_number)
        return result

    def signals(
        self, prior: tuple[set[str], set[str], set[str], dict[str, str]], previous_stalls: int
    ) -> m.DecisionSignals:
        state = self.bus.state
        core = [q for q in state.task.questions if q.priority == "core"] if state.task else []
        sources, milestones, _, verdicts = progress(state)
        old_sources, old_milestones, old_gaps, old_verdicts = prior
        resolved = any(g.id in old_gaps and g.status == "resolved" for g in state.gaps)
        changed = any(
            cid in old_verdicts and old_verdicts[cid] != value for cid, value in verdicts.items()
        )
        new_sources = len(sources - old_sources)
        new_milestones = len(milestones - old_milestones)
        return m.DecisionSignals(
            core_coverage=sum(q.status == "answered" for q in core) / len(core) if core else 0,
            open_high_gaps=sum(
                g.status == "open" and g.priority == "high" and g.feasible for g in state.gaps
            ),
            new_independent_evidence=new_sources,
            new_milestones=new_milestones,
            budget_remaining_ratio=self.budget.remaining_ratio(),
            no_progress_rounds=0
            if (new_sources or new_milestones or resolved or changed)
            else previous_stalls + 1,
        )

    def decision(
        self,
        kind: str,
        reason: m.StopReason | None,
        message: str,
        signals: m.DecisionSignals,
        rnd: int,
    ) -> None:
        self.bus.emit(
            "decision.made",
            m.Decision.model_validate(
                {
                    "id": new_id("dec"),
                    "kind": kind,
                    "stop_reason": reason,
                    "reason": message,
                    "signals": signals,
                    "round": rnd,
                    "at": now(),
                }
            ),
        )

    async def assess(self) -> None:
        request = self.bus.state.request
        if request.seed_url and not any(doc.round == 0 for doc in self.bus.state.documents):
            try:
                page, provider = await self.retrieval.read(request.seed_url, None, None, None, True)
                await collect_page(
                    self.bus, self.retrieval, self.llm, self.policy, page, provider, None, None
                )
            except ValueError:
                self.bus.emit("log", {"level": "warning", "message": "种子链接暂无法读取"})
        await assess(self.manager, self.bus, self.budget, self.llm, self.policy)

    async def research(self) -> tuple[m.StopReason, m.DecisionSignals]:
        state = self.bus.state
        decisions = [d for d in state.decisions if d.kind in ("continue_research", "write_report")]
        if decisions and decisions[-1].kind == "write_report":
            return decisions[-1].stop_reason or "no_progress", decisions[-1].signals
        previous_stalls = decisions[-1].signals.no_progress_rounds if decisions else 0
        round_number = decisions[-1].round + 1 if decisions else 1
        baseline = progress(state)
        signals = self.signals(baseline, previous_stalls)
        try:
            if state.task is None:
                await self.step("assess", 0, self.assess)
            while round_number <= state.budget.max_research_rounds:
                current = self.bus.state
                before = self.bus.store.before_round(current.id, round_number)
                baseline = progress(before or current)
                existing = [a for a in current.actions if a.round == round_number]
                if any(p.round == round_number for p in current.plans):
                    actions = existing
                else:
                    actions = await self.step(
                        "plan",
                        round_number,
                        lambda: plan(
                            self.manager,
                            self.bus,
                            self.budget,
                            self.llm,
                            self.policy,
                        ),
                    )
                checkpoint = self.bus.store.last_checkpoint(current.id)
                verified = checkpoint in (("verify", round_number), ("update", round_number))
                try:
                    if not verified and checkpoint != ("collect", round_number):
                        await self.step(
                            "collect",
                            round_number,
                            lambda actions=actions: collect(
                                self.bus,
                                self.retrieval,
                                self.llm,
                                self.policy,
                                actions,
                            ),
                        )
                    if not verified:
                        await self.step(
                            "verify",
                            round_number,
                            lambda: verify(
                                self.bus,
                                self.llm,
                                self.policy,
                                self.retrieval,
                            ),
                        )
                    if checkpoint != ("update", round_number):
                        await self.step(
                            "update",
                            round_number,
                            lambda: update(
                                self.bus,
                                self.llm,
                                self.policy,
                            ),
                        )
                except ModelFailure:
                    self.bus.emit("log", {"level": "warning", "message": "本轮部分核实步骤未完成"})
                signals = self.signals(baseline, previous_stalls)
                settings = self.manager.config.stopping
                kind, reason, note = decide(
                    signals,
                    round_number,
                    current.budget.max_research_rounds,
                    settings,
                    self.budget.seconds_left(True)
                    / (current.budget.max_seconds * self.budget.fraction(True)),
                )
                self.decision(kind, reason, note, signals, round_number)
                if reason:
                    return reason, signals
                previous_stalls = signals.no_progress_rounds
                round_number += 1
        except BudgetExceeded as error:
            signals = self.signals(baseline, previous_stalls)
            self.decision(
                "write_report",
                error.reason,
                "研究预算不足，转入写作",
                signals,
                self.bus.state.research_round,
            )
            return error.reason, signals
        return "budget_exhausted", signals

    async def run(self) -> None:
        try:
            research_stop, signals = await self.research()
            await self.reporting(research_stop, signals)
            if self.bus.state.report is None:
                draft = safe_fallback(self.bus.state)
                report, _ = build_report(self.bus.state, draft)
                self.bus.emit("report.updated", report)
            self.budget.flush(force=True)
            answered = finish_report(self.bus)
            reason = self.final_reason(research_stop, answered)
            partial = reason != "review_passed"
            mark_report(self.bus, reason, partial)
            self.manager.finish(self.bus, "partial" if partial else "completed", reason)
        except ModelFailure as error:
            self.bus.emit("run.error", {"type": "model_error", "message": str(error)})
            self.budget.flush(force=True)
            if self.bus.state.evidence:
                report, _ = build_report(self.bus.state, safe_fallback(self.bus.state))
                self.bus.emit("report.updated", report)
                finish_report(self.bus)
                mark_report(self.bus, "review_unresolved", True)
                self.manager.finish(self.bus, "partial", "review_unresolved")
            else:
                self.manager.finish(self.bus, "failed", "error")

    async def reporting(
        self, research_stop: m.StopReason, signals: m.DecisionSignals
    ) -> m.StopReason:
        state = self.bus.state
        limit = state.budget.max_review_rounds
        last = state.reviews[-1] if state.reviews else None
        number = last.round + 1 if last else 1
        if last and state.report and last.passed and state.report.generated_at <= last.at:
            return self.finish_reason(research_stop)
        try:
            if not state.report or (last and state.report.generated_at <= last.at):
                if number > limit and state.report:
                    return "review_unresolved"
                await self.step("write", number, lambda: write_report(self.bus, self.llm))
            while number <= limit:
                passed = await self.step(
                    "review",
                    number,
                    lambda: review_report(self.bus, self.llm),
                )
                last = self.bus.state.reviews[-1]
                if passed:
                    reason = self.finish_reason(research_stop)
                    self.decision("finish", reason, "审查通过，输出报告", signals, number)
                    return reason
                # 未通过就修：中等问题超限同样导致不通过，只修 high 会让这类报告一次不修就收尾
                high = [
                    item
                    for item in last.findings
                    if item.severity == "high" and item.status == "open"
                ]
                if number >= limit or not self.budget.seconds_left(False):
                    break
                report = self.bus.state.report
                targets = {
                    f.sentence_id
                    for f in high
                    if f.type
                    in (
                        "unsupported_citation",
                        "temporal_error",
                        "stage_confusion",
                        "unavailable_at_cutoff",
                    )
                }
                claim_ids = (
                    {
                        cid
                        for sentence in report_sentences(report)
                        if sentence.id in targets
                        for cid in sentence.claim_ids
                    }
                    if report
                    else set()
                )
                number += 1
                if claim_ids:
                    self.decision(
                        "reverify", None, "复核审查问题涉及的声明与证据", signals, last.round
                    )
                    rnd = self.bus.state.research_round
                    await self.step(
                        "verify",
                        rnd,
                        lambda claim_ids=claim_ids: verify(
                            self.bus,
                            self.llm,
                            self.policy,
                            self.retrieval,
                            target_ids=claim_ids,
                            research=False,
                        ),
                    )
                    await self.step(
                        "update",
                        rnd,
                        lambda: update(
                            self.bus,
                            self.llm,
                            self.policy,
                            research=False,
                        ),
                    )
                else:
                    self.decision("repair_report", None, "按审查问题重写报告", signals, last.round)
                await self.step("write", number, lambda: write_report(self.bus, self.llm))
        except BudgetExceeded as error:
            self.decision("finish", error.reason, "审查或写作预算已用尽", signals, number)
            return error.reason
        self.decision(
            "finish",
            "review_unresolved",
            "仍有审查问题未解决，删去未通过核查的句子后输出",
            signals,
            max(number, 1),
        )
        return "review_unresolved"

    def final_reason(self, research_stop: m.StopReason, answered: bool) -> m.StopReason:
        """决定运行是 completed 还是 partial。

        审查未通过的句子已在 finish_report 中删除，交付的报告只含核查通过的内容，
        因此 partial 只表示两种真实缺陷：直接答案没有任何可核实的句子；
        或研究被预算 / 时间截断时核心问题仍未查清（用更大预算重跑可以改善）。
        "已查尽但公开信息不足"不算缺陷，由报告正文如实说明。
        """
        if not answered:
            return "review_unresolved"
        if self.core_answered() or research_stop not in ("budget_exhausted", "time_limit"):
            return "review_passed"
        return research_stop

    def core_answered(self) -> bool:
        task = self.bus.state.task
        return bool(task) and all(
            q.status == "answered" for q in task.questions if q.priority == "core"
        )

    def finish_reason(self, research_stop: m.StopReason) -> m.StopReason:
        task = self.bus.state.task
        if task and all(q.status == "answered" for q in task.questions if q.priority == "core"):
            return "review_passed"
        return (
            research_stop
            if research_stop in ("no_progress", "time_limit", "budget_exhausted")
            else "review_unresolved"
        )


async def run_workflow(manager: RunManager, bus: EventBus) -> None:
    await run_with_model(manager, bus)


async def run_with_model(
    manager: RunManager, bus: EventBus, model_override: ModelRunner | None = None
) -> None:
    budget = BudgetTracker(bus)
    llm = LLM(
        manager.config.profile(bus.state.request.model_profile),
        manager.config.prices_usd_per_mtok,
        budget,
        manager.root / "logs" / f"{bus.state.id}.jsonl",
    )
    async with (
        httpx.AsyncClient(timeout=15) as client,
        httpx.AsyncClient(
            timeout=15,
            # 有代理时走代理（国内访问境外站点需要）；无代理时按 IP 直连
            trust_env=proxy_configured(),
            limits=httpx.Limits(max_keepalive_connections=0),
        ) as direct,
    ):
        retrieval = Retrieval(bus, budget, manager.config, client, direct, manager.cache_hours)
        try:
            await Controller(manager, bus, budget, model_override or llm, retrieval).run()
        finally:
            await llm.close()
