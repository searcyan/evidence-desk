"""共享预算的预检、计费和节流。"""

import asyncio
from time import monotonic

from ..contracts import models as m
from ..settings import Price
from .events import EventBus


class BudgetExceeded(Exception):
    def __init__(self, reason: m.StopReason = "budget_exhausted"):
        super().__init__(reason)
        self.reason: m.StopReason = reason


class BudgetTracker:
    def __init__(self, bus: EventBus):
        self.bus = bus
        self.limits = bus.state.budget
        recovered = bus.store.metered(bus.state.id)
        self.usage = recovered or bus.state.usage
        self.base_seconds = self.usage.elapsed_seconds
        self.started = monotonic()
        self.pause_seconds = 0.0
        self.last_emit = 0.0
        self.lock = asyncio.Lock()
        # 已发出但尚未返回的模型请求所预扣的 token 与成本，防止并发请求合计超出上限
        self.reserved_tokens = 0
        self.reserved_cost = 0.0

    @property
    def elapsed(self) -> float:
        return self.base_seconds + monotonic() - self.started - self.pause_seconds

    def fraction(self, research: bool) -> float:
        return 1 - self.limits.reserve_ratio if research else 1.0

    def seconds_left(self, research: bool) -> float:
        return max(0.0, self.limits.max_seconds * self.fraction(research) - self.elapsed)

    def tools_left(self, research: bool) -> int:
        return max(
            0,
            int(self.limits.max_tool_calls * self.fraction(research))
            - self.usage.search_calls
            - self.usage.read_calls,
        )

    def tokens_left(self, research: bool) -> int:
        return max(
            0,
            int(self.limits.max_llm_tokens * self.fraction(research))
            - self.usage.input_tokens
            - self.usage.output_tokens
            - self.reserved_tokens,
        )

    def cost_left(self, research: bool) -> float:
        limit = self.limits.max_cost_usd
        return (
            float("inf")
            if limit is None
            else max(
                0,
                limit * self.fraction(research) - self.usage.cost_usd - self.reserved_cost,
            )
        )

    def remaining_ratio(self, research: bool = True) -> float:
        fraction = self.fraction(research)
        ratios = [
            self.tools_left(research) / (self.limits.max_tool_calls * fraction),
            self.tokens_left(research) / (self.limits.max_llm_tokens * fraction),
            self.seconds_left(research) / (self.limits.max_seconds * fraction),
        ]
        cost = self.limits.max_cost_usd
        if cost is not None and cost > 0:
            ratios.append(self.cost_left(research) / (cost * fraction))
        return min(ratios)

    def update(self, **changes: object) -> None:
        self.usage = self.usage.model_copy(update=changes)
        self.flush()

    def flush(self, force: bool = False) -> None:
        self.usage = self.usage.model_copy(
            update={
                "elapsed_seconds": round(
                    min(self.limits.max_seconds, self.elapsed),
                    3,
                )
            }
        )
        self.bus.store.save_meter(self.bus.state.id, self.usage)
        if force or monotonic() - self.last_emit >= 0.5:
            self.bus.emit("budget.updated", self.usage)
            self.last_emit = monotonic()

    def tool(self, operation: str, research: bool) -> None:
        if self.seconds_left(research) <= 0:
            raise BudgetExceeded("time_limit")
        if not self.tools_left(research):
            raise BudgetExceeded()
        counts = (
            {"search_calls": self.usage.search_calls + 1}
            if operation == "search"
            else {
                "read_calls": self.usage.read_calls + 1,
            }
        )
        self.update(**counts)

    def model_limits(self, estimate: int, price: Price, research: bool) -> tuple[int, int]:
        if self.seconds_left(research) <= 0:
            raise BudgetExceeded("time_limit")
        total = self.tokens_left(research)
        cost = self.cost_left(research)
        if estimate >= total or estimate * price.input / 1_000_000 > cost:
            raise BudgetExceeded()
        # 评分（RACE 等）需要较长的结构化输出；研究阶段沿用 4096 上限
        max_output = min(4096 if research else 16384, total - estimate)
        if price.output and cost != float("inf"):
            max_output = min(
                max_output, int((cost * 1_000_000 - estimate * price.input) / price.output)
            )
        if max_output < 32:
            raise BudgetExceeded()
        return total, max_output

    def reserve(self, tokens: int, cost: float) -> tuple[int, float]:
        """在锁内调用：预扣一次请求可能消耗的最大 token 与成本。"""
        self.reserved_tokens += tokens
        self.reserved_cost += cost
        return tokens, cost

    def release(self, reservation: tuple[int, float]) -> None:
        self.reserved_tokens = max(0, self.reserved_tokens - reservation[0])
        self.reserved_cost = max(0.0, self.reserved_cost - reservation[1])

    def model_usage(
        self, requests: int, input_tokens: int, output_tokens: int, price: Price
    ) -> None:
        u = self.usage
        self.update(
            llm_calls=u.llm_calls + requests,
            input_tokens=u.input_tokens + input_tokens,
            output_tokens=u.output_tokens + output_tokens,
            cost_usd=u.cost_usd + (input_tokens * price.input + output_tokens * price.output) / 1e6,
        )
