"""集中管理四种实验条件允许的动作、缺口和时间行为。"""

from datetime import timedelta

from ..contracts import models as m
from ..tools.dates import day, event_date

GAP_ACTIONS: dict[m.GapType, tuple[m.ActionType, ...]] = {
    "unanswered_question": ("search",),
    "missing_background": ("expand_window",),
    "missing_phase": ("focus_date", "search"),
    "unclear_date": ("focus_date",),
    "conflict": ("trace_origin", "focus_date"),
    "single_source": ("corroborate",),
    "unverified_origin": ("trace_origin",),
}


class MechanismPolicy:
    def __init__(self, mechanisms: m.Mechanisms):
        self.source = mechanisms.source_verification
        self.temporal = mechanisms.temporal_planning
        self.actions: set[m.ActionType] = {"search", "read"}
        self.gaps: set[m.GapType] = {"unanswered_question"}
        if self.source:
            self.actions.update(("trace_origin", "corroborate"))
            self.gaps.update(("single_source", "unverified_origin", "conflict"))
        if self.temporal:
            self.actions.update(("expand_window", "narrow_window", "focus_date"))
            self.gaps.update(("missing_background", "missing_phase", "unclear_date", "conflict"))

    def gap_actions(self, kind: m.GapType) -> list[m.ActionType]:
        return [action for action in GAP_ACTIONS[kind] if action in self.actions]

    def initial_window(
        self, request: m.RunRequest, suggested: m.TimeWindow | None, lookback: int
    ) -> m.TimeWindow:
        cutoff = day(request.cutoff)
        start = max(cutoff.toordinal() - lookback, 1)
        fallback = m.TimeWindow(start=cutoff.fromordinal(start).isoformat(), end=cutoff.isoformat())
        return self.window(suggested, fallback, request) if self.temporal else fallback

    def window(
        self, value: m.TimeWindow | None, fallback: m.TimeWindow, request: m.RunRequest
    ) -> m.TimeWindow:
        if value is None:
            return fallback
        end = min(value.end, request.cutoff[:10]) if request.temporal_mode == "as_of" else value.end
        return m.TimeWindow(start=value.start, end=end) if value.start <= end else fallback

    def action_window(
        self,
        kind: m.ActionType,
        params: m.ResearchActionParams,
        task: m.TaskSpec,
        request: m.RunRequest,
    ) -> m.TimeWindow | None:
        if kind == "read" or request.search_mode == "corpus":
            return None
        default = task.initial_window
        if not self.temporal:
            return default
        if kind in ("focus_date", "narrow_window") and params.date:
            focus = day(params.date)
            start = focus.fromordinal(max(1, focus.toordinal() - 3))
            end = focus.fromordinal(min(3_652_059, focus.toordinal() + 3))
            return self.window(
                m.TimeWindow(start=start.isoformat(), end=end.isoformat()), default, request
            )
        if kind == "expand_window" and params.window is None:
            before = day(default.start)
            span = max(30, (day(default.end) - before).days)
            start = before.fromordinal(max(1, before.toordinal() - span))
            end = before - timedelta(days=1) if before.toordinal() > 1 else before
            return m.TimeWindow(start=start.isoformat(), end=end.isoformat())
        return self.window(params.window, default, request)

    def claim_date(
        self, text: str | None, evidence: m.Evidence, document: m.SourceDocument
    ) -> m.DateRef | None:
        if self.temporal:
            return event_date(text, document.published_at) or evidence.event_date
        return event_date(document.published_at[:10] if document.published_at else None)
