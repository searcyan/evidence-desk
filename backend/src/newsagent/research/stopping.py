"""用冻结的信号和阈值决策。"""

from typing import Literal

from ..contracts import models as m
from ..settings import Stopping


def decide(
    signals: m.DecisionSignals,
    round_number: int,
    maximum: int,
    settings: Stopping,
    time_left: float,
) -> tuple[Literal["continue_research", "write_report"], m.StopReason | None, str]:
    if signals.budget_remaining_ratio < settings.min_round_budget_ratio or round_number >= maximum:
        if time_left <= 0 or time_left < settings.min_round_budget_ratio:
            return "write_report", "time_limit", "研究时间预算不足，转入写作"
        return "write_report", "budget_exhausted", "已到达研究轮数或预算上限，转入写作"
    if signals.core_coverage >= settings.core_coverage_threshold and signals.open_high_gaps == 0:
        return "write_report", "questions_answered", "核心问题已覆盖，且没有可处理的高优先级缺口"
    if signals.no_progress_rounds >= settings.no_progress_rounds_limit:
        return "write_report", "no_progress", "连续多轮未增加独立证据或推进研究"
    return "continue_research", None, "继续调查仍可处理的证据缺口"
