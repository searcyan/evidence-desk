"""由 TypeScript 接口契约映射的 API 模型。"""

from datetime import UTC, date, datetime
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    TypeAdapter,
    field_validator,
    model_serializer,
)


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


def normalize_datetime(value: str) -> str:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("时间戳必须带时区")
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


def normalize_date(value: str) -> str:
    return date.fromisoformat(value).isoformat()


ISODate = Annotated[str, AfterValidator(normalize_date)]
ISODateTime = Annotated[str, AfterValidator(normalize_datetime)]

ActionStatus = Literal["planned", "running", "done", "skipped", "failed"]
ActionType = Literal[
    "search", "read", "expand_window", "narrow_window", "focus_date", "trace_origin", "corroborate"
]
BudgetPreset = Literal["small", "medium", "large", "custom"]
Lang = Literal["en", "zh"]
SearchMode = Literal["live", "snapshot", "corpus"]
TemporalMode = Literal["as_of", "retrospective"]
BenchmarkId = Literal["open_tls", "deepresearch_bench", "browsecomp_plus", "manual"]
ConditionId = Literal["base", "source", "temporal", "full"]
Verdict = Literal["supported", "contradicted", "conflicting", "insufficient"]
StopReason = Literal[
    "questions_answered",
    "no_progress",
    "budget_exhausted",
    "time_limit",
    "review_passed",
    "review_unresolved",
    "cancelled",
    "error",
]
EventType = Literal[
    "acquisition", "legal_case", "policy", "disaster", "election", "product", "conflict", "other"
]
GapType = Literal[
    "missing_background",
    "missing_phase",
    "unclear_date",
    "conflict",
    "single_source",
    "unverified_origin",
    "unanswered_question",
]
ModelRole = Literal["controller", "extractor", "writer", "reviewer"]
Phase = Literal["assess", "plan", "collect", "verify", "update", "write", "review"]
RunStatus = Literal[
    "queued", "running", "awaiting_clarification", "completed", "partial", "failed", "cancelled"
]


class BudgetLimits(ContractModel):
    max_cost_usd: float | None = Field(ge=0)
    max_llm_tokens: int = Field(ge=1)
    max_research_rounds: int = Field(ge=1)
    max_review_rounds: int = Field(ge=0)
    max_seconds: int = Field(ge=1)
    max_tool_calls: int = Field(ge=1)
    reserve_ratio: float = Field(ge=0, lt=1)


class AppConfigBudgetPresets(ContractModel):
    large: BudgetLimits
    medium: BudgetLimits
    small: BudgetLimits


class Mechanisms(ContractModel):
    source_verification: bool
    temporal_planning: bool


class AppConfigDefaults(ContractModel):
    budget_preset: BudgetPreset
    mechanisms: Mechanisms
    report_language: Lang
    search_mode: SearchMode
    temporal_mode: TemporalMode


class ModelProfileRoles(ContractModel):
    controller: str
    extractor: str
    reviewer: str
    writer: str


class ModelProfile(ContractModel):
    id: str
    label: str
    provider: str
    roles: ModelProfileRoles


class AppConfigSearchProvidersItem(ContractModel):
    available: bool
    id: Literal["tavily", "exa", "corpus"]


class SnapshotInfo(ContractModel):
    created_at: ISODateTime
    entries: int
    id: str
    label: str


class AppConfig(ContractModel):
    budget_presets: AppConfigBudgetPresets
    default_model_profile: str
    defaults: AppConfigDefaults
    mode: Literal["live", "mock"]
    model_profiles: list[ModelProfile]
    search_providers: list[AppConfigSearchProvidersItem]
    snapshots: list[SnapshotInfo]
    version: str


class BudgetLevelPoint(ContractModel):
    benchmark: BenchmarkId
    budget_preset: Literal["small", "medium", "large"]
    condition: ConditionId
    mean_cost_usd: float
    metric_id: str
    metric_mean: float


class BudgetUsage(ContractModel):
    cost_usd: float
    elapsed_seconds: float
    input_tokens: int
    llm_calls: int
    output_tokens: int
    read_calls: int
    research_rounds: int
    review_rounds: int
    search_calls: int


class DateRef(ContractModel):
    end: ISODate
    precision: Literal["day", "month", "year", "range"]
    start: ISODate
    text: str | None


class VerdictRevision(ContractModel):
    at: ISODateTime
    reason: str
    round: int
    verdict: Verdict


class ClaimEvidenceLink(ContractModel):
    evidence_id: str
    note: str | None
    relation: Literal["supports", "contradicts", "context"]


class Claim(ContractModel):
    applicable_at_cutoff: bool | None
    event_date: DateRef | None
    first_round: int
    history: list[VerdictRevision]
    id: str
    independent_sources: int
    links: list[ClaimEvidenceLink]
    question_ids: list[str]
    rationale: str
    stage: str | None
    subject: str
    text: str
    updated_round: int
    verdict: Verdict


class ClarificationAnswerAnswersItem(ContractModel):
    answer: str
    question_id: str


class ClarificationAnswer(ContractModel):
    answers: list[ClarificationAnswerAnswersItem]


class ClarificationQuestion(ContractModel):
    id: str
    options: list[str]
    text: str


class ClarificationRequest(ContractModel):
    asked_at: ISODateTime
    id: str
    questions: list[ClarificationQuestion]


class ConditionResultCompletion(ContractModel):
    completed: int
    failed: int
    partial: int


class CostStat(ContractModel):
    grading_cost_usd: float
    mean_cost_usd: float
    mean_seconds: float
    mean_tokens: float
    mean_tool_calls: float
    total_cost_usd: float


class MetricStat(ContractModel):
    mean: float
    n: int
    std: float


class ConditionResult(ContractModel):
    benchmark: BenchmarkId
    completion: ConditionResultCompletion
    condition: ConditionId
    cost: CostStat
    metrics: dict[str, MetricStat]


class DecisionSignals(ContractModel):
    budget_remaining_ratio: float
    core_coverage: float
    new_independent_evidence: int
    new_milestones: int
    no_progress_rounds: int
    open_high_gaps: int


class Decision(ContractModel):
    at: ISODateTime
    id: str
    kind: Literal["continue_research", "write_report", "repair_report", "reverify", "finish"]
    reason: str
    round: int
    signals: DecisionSignals
    stop_reason: StopReason | None


class Evidence(ContractModel):
    document_id: str
    event_date: DateRef | None
    id: str
    quote: str
    round: int


class ExperimentSummary(ContractModel):
    benchmarks: list[BenchmarkId]
    budget_preset: BudgetPreset
    conditions: list[ConditionId]
    created_at: ISODateTime
    id: str
    model_profile: str
    name: str
    notes: str | None
    repeats: int
    status: Literal["running", "completed", "failed"]
    task_count: int


class MetricDef(ContractModel):
    benchmark: BenchmarkId
    description: str
    higher_is_better: bool
    id: str
    label: str
    primary: bool
    unit: Literal["ratio", "score", "count", "usd", "seconds"]


class TaskResult(ContractModel):
    benchmark: BenchmarkId
    condition: ConditionId
    cost_usd: float
    metrics: dict[str, float | None]
    repeat: int
    run_id: str | None
    seconds: float
    status: Literal["completed", "partial", "failed"]
    task_id: str
    tokens: int


class ExperimentDetail(ExperimentSummary):
    budget_levels: list[BudgetLevelPoint]
    metric_defs: list[MetricDef]
    results: list[ConditionResult]
    tasks: list[TaskResult]


class Gap(ContractModel):
    affects_main_answer: bool
    claim_ids: list[str]
    closed_round: int | None
    description: str
    feasible: bool
    id: str
    opened_round: int
    priority: Literal["high", "medium", "low"]
    question_ids: list[str]
    resolution: str | None
    status: Literal["open", "in_progress", "resolved", "abandoned"]
    type: GapType


class HealthResponseChecksValue(ContractModel):
    detail: str | None
    ok: bool


class HealthResponse(ContractModel):
    checks: dict[str, HealthResponseChecksValue]
    status: Literal["ok", "degraded"]


class OriginGroup(ContractModel):
    document_ids: list[str]
    id: str
    label: str
    reason: str
    root_document_id: str | None


class ReportSentence(ContractModel):
    claim_ids: list[str]
    evidence_ids: list[str]
    id: str
    text: str


class ReportParagraph(ContractModel):
    id: str
    sentences: list[ReportSentence]


class ReportSection(ContractModel):
    id: str
    kind: Literal["answer", "background", "timeline_analysis", "analysis", "uncertainty", "other"]
    paragraphs: list[ReportParagraph]
    title: str


class Report(ContractModel):
    answer: ReportParagraph
    generated_at: ISODateTime
    is_partial: bool
    language: Lang
    open_questions: list[str]
    sections: list[ReportSection]
    stop_reason: StopReason | None
    title: str
    version: int


class TimeWindow(ContractModel):
    end: ISODate
    start: ISODate


class ResearchActionParams(ContractModel):
    claim_id: str | None
    date: ISODate | None
    query: str | None
    url: str | None
    window: TimeWindow | None


class ResearchActionResult(ContractModel):
    documents_added: int
    duplicates: int
    evidence_added: int
    note: str | None


class ResearchAction(ContractModel):
    finished_at: ISODateTime | None
    gap_id: str | None
    id: str
    params: ResearchActionParams
    question_ids: list[str]
    rationale: str
    result: ResearchActionResult | None
    round: int
    started_at: ISODateTime | None
    status: ActionStatus
    type: ActionType


class ResearchPlan(ContractModel):
    action_ids: list[str]
    created_at: ISODateTime
    rationale: str
    round: int
    source_strategy: str
    windows: list[TimeWindow]


class ReviewFinding(ContractModel):
    description: str
    id: str
    sentence_id: str | None
    severity: Literal["high", "medium", "low"]
    status: Literal["open", "fixed", "wontfix"]
    type: Literal[
        "unsupported_citation",
        "temporal_error",
        "stage_confusion",
        "omission",
        "unavailable_at_cutoff",
        "other",
    ]


class ReviewResult(ContractModel):
    at: ISODateTime
    findings: list[ReviewFinding]
    passed: bool
    round: int


class RunSummaryCounts(ContractModel):
    claims: int
    documents: int
    open_gaps: int
    timeline_entries: int


class RunRequestBudget(ContractModel):
    max_cost_usd: float | None = None
    max_llm_tokens: int | None = None
    max_research_rounds: int | None = None
    max_review_rounds: int | None = None
    max_seconds: int | None = None
    max_tool_calls: int | None = None
    reserve_ratio: float | None = None

    @model_serializer(mode="wrap")
    def serialize_supplied_fields(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, object]:
        return {key: value for key, value in handler(self).items() if key in self.model_fields_set}


class RunRequest(ContractModel):
    budget: RunRequestBudget | None
    budget_preset: BudgetPreset
    cutoff: ISODateTime
    event_hint: str | None
    mechanisms: Mechanisms
    model_profile: str | None
    question: str = Field(min_length=1, max_length=2000)
    report_language: Lang
    search_mode: SearchMode
    seed_url: str | None
    snapshot_id: str | None
    tags: list[str]
    temporal_mode: TemporalMode

    @field_validator("question", mode="before")
    @classmethod
    def strip_question(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class RunSummary(ContractModel):
    budget: BudgetLimits
    counts: RunSummaryCounts
    created_at: ISODateTime
    finished_at: ISODateTime | None
    id: str
    phase: Phase | None
    request: RunRequest
    started_at: ISODateTime | None
    status: RunStatus
    stop_reason: StopReason | None
    title: str
    usage: BudgetUsage


class SourceDocument(ContractModel):
    action_id: str | None
    attribution: str | None
    author: str | None
    available_at_cutoff: bool | None
    domain: str
    id: str
    is_original: bool | None
    language: str | None
    origin_group_id: str | None
    provider: Literal["tavily", "exa", "corpus", "seed", "cache"]
    published_at: ISODateTime | None
    published_at_source: Literal["metadata", "search_api", "content", "unknown"]
    publisher: str | None
    retrieved_at: ISODateTime
    round: int
    snippet: str
    title: str
    url: str


class RunError(ContractModel):
    message: str
    type: str


class SubQuestion(ContractModel):
    answer_claim_ids: list[str]
    id: str
    priority: Literal["core", "supporting"]
    status: Literal["open", "partial", "answered", "unanswerable"]
    text: str


class TaskSpec(ContractModel):
    assumptions: list[str]
    cutoff: ISODateTime
    entities: list[str]
    event_name: str
    event_type: EventType
    initial_window: TimeWindow
    questions: list[SubQuestion]
    stage_model: list[str]
    temporal_mode: TemporalMode


class TimelineEntry(ContractModel):
    claim_ids: list[str]
    date: DateRef
    id: str
    is_milestone: bool
    stage: str | None
    summary: str
    title: str
    verdict: Verdict


class ToolCall(ContractModel):
    action_id: str | None
    at: ISODateTime
    cached: bool
    duration_ms: int
    error: str | None
    id: str
    input: str
    ok: bool
    provider: Literal["tavily", "exa", "corpus", "http", "cache"]
    result_count: int | None
    tool: Literal["search", "read"]


class RunDetail(RunSummary):
    actions: list[ResearchAction]
    claims: list[Claim]
    clarification: ClarificationRequest | None
    decisions: list[Decision]
    documents: list[SourceDocument]
    error: RunError | None
    evidence: list[Evidence]
    gaps: list[Gap]
    last_event_seq: int
    origin_groups: list[OriginGroup]
    plans: list[ResearchPlan]
    report: Report | None
    research_round: int
    review_round: int
    reviews: list[ReviewResult]
    task: TaskSpec | None
    timeline: list[TimelineEntry]
    tool_calls: list[ToolCall]


class RunListResponse(ContractModel):
    items: list[RunSummary]
    next_cursor: str | None


class RunStatusEventData(ContractModel):
    phase: Phase | None
    status: RunStatus


class RunStatusEvent(ContractModel):
    data: RunStatusEventData
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["run.status"]


class StepStartedEventData(ContractModel):
    round: int
    step: Phase


class StepStartedEvent(ContractModel):
    data: StepStartedEventData
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["step.started"]


class StepCompletedEventData(ContractModel):
    duration_ms: int
    round: int
    step: Phase


class StepCompletedEvent(ContractModel):
    data: StepCompletedEventData
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["step.completed"]


class TaskAssessedEvent(ContractModel):
    data: TaskSpec
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["task.assessed"]


class ClarificationRequestedEvent(ContractModel):
    data: ClarificationRequest
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["clarification.requested"]


class ClarificationAnsweredEvent(ContractModel):
    data: ClarificationAnswer
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["clarification.answered"]


class QuestionUpdatedEvent(ContractModel):
    data: SubQuestion
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["question.updated"]


class PlanCreatedEvent(ContractModel):
    data: ResearchPlan
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["plan.created"]


class ActionUpsertedEvent(ContractModel):
    data: ResearchAction
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["action.upserted"]


class ToolCalledEvent(ContractModel):
    data: ToolCall
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["tool.called"]


class DocumentAddedEvent(ContractModel):
    data: SourceDocument
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["document.added"]


class OriginGroupUpsertedEvent(ContractModel):
    data: OriginGroup
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["origin_group.upserted"]


class EvidenceAddedEvent(ContractModel):
    data: Evidence
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["evidence.added"]


class ClaimUpsertedEvent(ContractModel):
    data: Claim
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["claim.upserted"]


class TimelineUpsertedEvent(ContractModel):
    data: TimelineEntry
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["timeline.upserted"]


class TimelineRemovedEventData(ContractModel):
    id: str


class TimelineRemovedEvent(ContractModel):
    data: TimelineRemovedEventData
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["timeline.removed"]


class GapUpsertedEvent(ContractModel):
    data: Gap
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["gap.upserted"]


class DecisionMadeEvent(ContractModel):
    data: Decision
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["decision.made"]


class BudgetUpdatedEvent(ContractModel):
    data: BudgetUsage
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["budget.updated"]


class ReportUpdatedEvent(ContractModel):
    data: Report
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["report.updated"]


class ReviewCompletedEvent(ContractModel):
    data: ReviewResult
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["review.completed"]


class LogEventData(ContractModel):
    level: Literal["debug", "info", "warning", "error"]
    message: str


class LogEvent(ContractModel):
    data: LogEventData
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["log"]


class RunFinishedEventData(ContractModel):
    finished_at: ISODateTime
    status: RunStatus
    stop_reason: StopReason | None


class RunFinishedEvent(ContractModel):
    data: RunFinishedEventData
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["run.finished"]


class RunErrorEvent(ContractModel):
    data: RunError
    run_id: str
    seq: int
    ts: ISODateTime
    type: Literal["run.error"]


RunEvent = Annotated[
    RunStatusEvent
    | StepStartedEvent
    | StepCompletedEvent
    | TaskAssessedEvent
    | ClarificationRequestedEvent
    | ClarificationAnsweredEvent
    | QuestionUpdatedEvent
    | PlanCreatedEvent
    | ActionUpsertedEvent
    | ToolCalledEvent
    | DocumentAddedEvent
    | OriginGroupUpsertedEvent
    | EvidenceAddedEvent
    | ClaimUpsertedEvent
    | TimelineUpsertedEvent
    | TimelineRemovedEvent
    | GapUpsertedEvent
    | DecisionMadeEvent
    | BudgetUpdatedEvent
    | ReportUpdatedEvent
    | ReviewCompletedEvent
    | LogEvent
    | RunFinishedEvent
    | RunErrorEvent,
    Field(discriminator="type"),
]
EVENT_ADAPTER = TypeAdapter(RunEvent)
