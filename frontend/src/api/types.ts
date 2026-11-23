/**
 * 前后端契约类型定义（唯一事实来源）。
 *
 * - 后端（Python / Pydantic）必须产出与这里完全一致的 JSON 结构；
 * - `npm run contract:schema` 会把本文件导出为 contracts/schema.json，供后端契约测试使用；
 * - 修改本文件 = 修改契约，必须同步更新 docs/api-contract.md 并重新导出 schema 与 fixtures。
 *
 * 约定：
 * - 所有字段名使用 snake_case；
 * - 时间戳一律为 RFC 3339 字符串且带时区（如 2024-05-01T08:00:00Z）；
 * - 日期（不含时间）为 YYYY-MM-DD；
 * - 可空字段显式写成 `T | null`，后端必须输出该键（值为 null），不得省略。
 */

// ───────────────────────── 基础类型 ─────────────────────────

/** RFC 3339 时间戳，带时区 */
export type ISODateTime = string;
/** YYYY-MM-DD */
export type ISODate = string;

export type Lang = 'en' | 'zh';

/** 运行状态。completed / partial / failed / cancelled 为终态 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_clarification'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

/** 工作流 7 个步骤，对应提案 Figure 1 */
export type Phase = 'assess' | 'plan' | 'collect' | 'verify' | 'update' | 'write' | 'review';

/**
 * 时间模式：
 * - as_of：只使用截止时间前已公开的信息（复现"当时能知道什么"）
 * - retrospective：回溯重建，可使用截止时间之后发布、但描述截止时间之前事件的资料
 */
export type TemporalMode = 'as_of' | 'retrospective';

/** 信息检索方式：live 实时搜索；snapshot 回放已录制的检索快照；corpus 本地语料库（BrowseComp-Plus） */
export type SearchMode = 'live' | 'snapshot' | 'corpus';

/** 2×2 实验中的两组机制开关 */
export interface Mechanisms {
  /** 来源规划与核实：溯源、转载归并、独立来源计数、trace_origin / corroborate 动作 */
  source_verification: boolean;
  /** 时间规划与核实：事件日期抽取、时间适用性检查、expand / narrow / focus_date 动作 */
  temporal_planning: boolean;
}

export type BudgetPreset = 'small' | 'medium' | 'large' | 'custom';

/** 预算上限。两个循环共享同一份预算，回到前面步骤不重置计数 */
export interface BudgetLimits {
  max_research_rounds: number;
  max_review_rounds: number;
  /** search + read 工具调用总数 */
  max_tool_calls: number;
  /** LLM 输入+输出 token 总数 */
  max_llm_tokens: number;
  max_seconds: number;
  /** 美元成本上限，null 表示不限制 */
  max_cost_usd: number | null;
  /** 为写报告与审查预留的预算比例（0~1），研究循环不得占用 */
  reserve_ratio: number;
}

export interface BudgetUsage {
  research_rounds: number;
  review_rounds: number;
  search_calls: number;
  read_calls: number;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  elapsed_seconds: number;
}

/** 日期引用：新闻里的事件日期经常只精确到月或年 */
export interface DateRef {
  start: ISODate;
  end: ISODate;
  precision: 'day' | 'month' | 'year' | 'range';
  /** 原文中的日期表述，如 "late March 2024" */
  text: string | null;
}

export interface TimeWindow {
  start: ISODate;
  end: ISODate;
}

// ───────────────────────── 请求 ─────────────────────────

export interface RunRequest {
  /** 用户的问题或事件描述 */
  question: string;
  /** 可选的事件名提示，帮助消歧 */
  event_hint: string | null;
  /** 信息截止时间 */
  cutoff: ISODateTime;
  temporal_mode: TemporalMode;
  /** 可选的新闻链接，作为种子文档 */
  seed_url: string | null;
  report_language: Lang;
  budget_preset: BudgetPreset;
  /** budget_preset 为 custom 时必填；否则可为 null（使用预设）或作为对预设的覆盖 */
  budget: Partial<BudgetLimits> | null;
  mechanisms: Mechanisms;
  search_mode: SearchMode;
  /** search_mode 为 snapshot 时必填 */
  snapshot_id: string | null;
  /** 模型配置档 id（见 AppConfig.model_profiles），null 用默认 */
  model_profile: string | null;
  tags: string[];
}

// ───────────────────────── 任务理解 ─────────────────────────

export interface SubQuestion {
  id: string;
  text: string;
  /** core 决定主答案；supporting 为补充背景 */
  priority: 'core' | 'supporting';
  status: 'open' | 'partial' | 'answered' | 'unanswerable';
  /** 回答该问题的声明 id */
  answer_claim_ids: string[];
}

export type EventType =
  | 'acquisition'
  | 'legal_case'
  | 'policy'
  | 'disaster'
  | 'election'
  | 'product'
  | 'conflict'
  | 'other';

export interface TaskSpec {
  event_name: string;
  event_type: EventType;
  entities: string[];
  questions: SubQuestion[];
  cutoff: ISODateTime;
  temporal_mode: TemporalMode;
  initial_window: TimeWindow;
  /** 该类事件的典型阶段序列，如收购：announced → agreement_signed → regulatory_review → approved → closed */
  stage_model: string[];
  /** 任务理解时做出的假设（未向用户澄清的部分） */
  assumptions: string[];
}

export interface ClarificationQuestion {
  id: string;
  text: string;
  /** 可选的候选答案，前端渲染为可点选项；用户也可自由输入 */
  options: string[];
}

export interface ClarificationRequest {
  id: string;
  questions: ClarificationQuestion[];
  asked_at: ISODateTime;
}

export interface ClarificationAnswer {
  answers: { question_id: string; answer: string }[];
}

// ───────────────────────── 研究规划与执行 ─────────────────────────

export type ActionType =
  | 'search'
  | 'read'
  | 'expand_window'
  | 'narrow_window'
  | 'focus_date'
  | 'trace_origin'
  | 'corroborate';

export type ActionStatus = 'planned' | 'running' | 'done' | 'skipped' | 'failed';

export interface ResearchAction {
  id: string;
  round: number;
  type: ActionType;
  status: ActionStatus;
  /** 该动作针对的证据缺口；首轮初始检索可为 null */
  gap_id: string | null;
  question_ids: string[];
  rationale: string;
  params: {
    query: string | null;
    window: TimeWindow | null;
    date: ISODate | null;
    url: string | null;
    claim_id: string | null;
  };
  result: {
    documents_added: number;
    evidence_added: number;
    /** 与已有证据重复（同源转载或内容重复）的文档数，不计入独立进展 */
    duplicates: number;
    note: string | null;
  } | null;
  started_at: ISODateTime | null;
  finished_at: ISODateTime | null;
}

export interface ResearchPlan {
  round: number;
  created_at: ISODateTime;
  rationale: string;
  windows: TimeWindow[];
  source_strategy: string;
  action_ids: string[];
}

export interface ToolCall {
  id: string;
  action_id: string | null;
  tool: 'search' | 'read';
  provider: 'tavily' | 'exa' | 'corpus' | 'http' | 'cache';
  /** search 为查询串，read 为 URL */
  input: string;
  ok: boolean;
  result_count: number | null;
  duration_ms: number;
  /** 命中检索快照/缓存 */
  cached: boolean;
  error: string | null;
  at: ISODateTime;
}

// ───────────────────────── 来源与证据 ─────────────────────────

export interface SourceDocument {
  id: string;
  url: string;
  title: string;
  domain: string;
  publisher: string | null;
  author: string | null;
  published_at: ISODateTime | null;
  /** 发布时间的来源：页面元数据 / 搜索 API / 正文推断 / 未知 */
  published_at_source: 'metadata' | 'search_api' | 'content' | 'unknown';
  retrieved_at: ISODateTime;
  provider: 'tavily' | 'exa' | 'corpus' | 'seed' | 'cache';
  /** 转载归并后的来源组 id；启用 source_verification 时每篇文档最终都属于一个组（允许单文档组），未启用时为 null */
  origin_group_id: string | null;
  /** 是否为原始来源（如官方公告原文）；未知为 null */
  is_original: boolean | null;
  /** 文中声明的出处，如 "according to Reuters" */
  attribution: string | null;
  /** 截止时间时是否已公开；无法判断为 null */
  available_at_cutoff: boolean | null;
  language: string | null;
  snippet: string;
  round: number;
  action_id: string | null;
}

/** 来源组：同一原始出处的多篇报道归为一组，只算一个独立来源 */
export interface OriginGroup {
  id: string;
  label: string;
  root_document_id: string | null;
  document_ids: string[];
  reason: string;
}

/** 证据：原文段落，逐字引用 */
export interface Evidence {
  id: string;
  document_id: string;
  quote: string;
  event_date: DateRef | null;
  round: number;
}

// ───────────────────────── 声明核实 ─────────────────────────

/**
 * 证据状态：描述证据对声明的支持程度，不等于"真/假"。
 * - supported：有独立证据支持且无有效反驳
 * - contradicted：可靠证据反驳
 * - conflicting：证据之间存在真实冲突（已排除主体/日期/条件不一致造成的假冲突）
 * - insufficient：证据不足
 */
export type Verdict = 'supported' | 'contradicted' | 'conflicting' | 'insufficient';

export interface ClaimEvidenceLink {
  evidence_id: string;
  relation: 'supports' | 'contradicts' | 'context';
  note: string | null;
}

export interface VerdictRevision {
  verdict: Verdict;
  reason: string;
  round: number;
  at: ISODateTime;
}

export interface Claim {
  id: string;
  /** 原子声明，使用报告语言 */
  text: string;
  subject: string;
  /** 对应 TaskSpec.stage_model 中的阶段，无则 null */
  stage: string | null;
  event_date: DateRef | null;
  question_ids: string[];
  verdict: Verdict;
  rationale: string;
  links: ClaimEvidenceLink[];
  /** 支持该声明的独立来源组数量 */
  independent_sources: number;
  /** 截止时间时是否成立/可知；null 为无法判断 */
  applicable_at_cutoff: boolean | null;
  /** 判定修订历史（不含当前），按时间先后 */
  history: VerdictRevision[];
  first_round: number;
  updated_round: number;
}

export interface TimelineEntry {
  id: string;
  date: DateRef;
  title: string;
  summary: string;
  stage: string | null;
  claim_ids: string[];
  /** 由关联声明聚合 */
  verdict: Verdict;
  is_milestone: boolean;
}

export type GapType =
  | 'missing_background'
  | 'missing_phase'
  | 'unclear_date'
  | 'conflict'
  | 'single_source'
  | 'unverified_origin'
  | 'unanswered_question';

export interface Gap {
  id: string;
  type: GapType;
  description: string;
  question_ids: string[];
  claim_ids: string[];
  priority: 'high' | 'medium' | 'low';
  affects_main_answer: boolean;
  /** 是否存在可行的检索路径 */
  feasible: boolean;
  status: 'open' | 'in_progress' | 'resolved' | 'abandoned';
  opened_round: number;
  closed_round: number | null;
  resolution: string | null;
}

// ───────────────────────── 控制决策 ─────────────────────────

export type StopReason =
  | 'questions_answered'
  | 'no_progress'
  | 'budget_exhausted'
  | 'time_limit'
  | 'review_passed'
  | 'review_unresolved'
  | 'cancelled'
  | 'error';

export interface DecisionSignals {
  /** core 问题已回答比例 0~1 */
  core_coverage: number;
  open_high_gaps: number;
  /** 上一轮新增的独立证据（新来源组）数 */
  new_independent_evidence: number;
  new_milestones: number;
  /** 扣除预留后剩余预算比例 0~1 */
  budget_remaining_ratio: number;
  /** 连续无进展轮数 */
  no_progress_rounds: number;
}

export interface Decision {
  id: string;
  kind: 'continue_research' | 'write_report' | 'repair_report' | 'reverify' | 'finish';
  round: number;
  reason: string;
  stop_reason: StopReason | null;
  signals: DecisionSignals;
  at: ISODateTime;
}

// ───────────────────────── 报告 ─────────────────────────

/** 报告以"句"为最小单元挂引用，便于逐句核查引用支持度 */
export interface ReportSentence {
  id: string;
  text: string;
  evidence_ids: string[];
  claim_ids: string[];
}

export interface ReportParagraph {
  id: string;
  sentences: ReportSentence[];
}

export interface ReportSection {
  id: string;
  kind: 'answer' | 'background' | 'timeline_analysis' | 'analysis' | 'uncertainty' | 'other';
  title: string;
  paragraphs: ReportParagraph[];
}

export interface ReviewFinding {
  id: string;
  type:
    | 'unsupported_citation'
    | 'temporal_error'
    | 'stage_confusion'
    | 'omission'
    | 'unavailable_at_cutoff'
    | 'other';
  severity: 'high' | 'medium' | 'low';
  sentence_id: string | null;
  description: string;
  status: 'open' | 'fixed' | 'wontfix';
}

export interface ReviewResult {
  round: number;
  passed: boolean;
  findings: ReviewFinding[];
  at: ISODateTime;
}

export interface Report {
  version: number;
  language: Lang;
  title: string;
  generated_at: ISODateTime;
  is_partial: boolean;
  /** 一段话的直接答案 */
  answer: ReportParagraph;
  sections: ReportSection[];
  open_questions: string[];
  stop_reason: StopReason | null;
}

// ───────────────────────── 运行 ─────────────────────────

export interface RunError {
  type: string;
  message: string;
}

export interface RunSummary {
  id: string;
  /** 运行标题：任务理解后为事件名，之前为问题截断 */
  title: string;
  status: RunStatus;
  phase: Phase | null;
  request: RunRequest;
  budget: BudgetLimits;
  usage: BudgetUsage;
  created_at: ISODateTime;
  started_at: ISODateTime | null;
  finished_at: ISODateTime | null;
  stop_reason: StopReason | null;
  counts: {
    documents: number;
    claims: number;
    timeline_entries: number;
    open_gaps: number;
  };
}

/** 运行完整快照。前端先取快照，再从 last_event_seq 之后订阅事件流增量更新 */
export interface RunDetail extends RunSummary {
  task: TaskSpec | null;
  clarification: ClarificationRequest | null;
  research_round: number;
  review_round: number;
  plans: ResearchPlan[];
  actions: ResearchAction[];
  tool_calls: ToolCall[];
  documents: SourceDocument[];
  origin_groups: OriginGroup[];
  evidence: Evidence[];
  claims: Claim[];
  timeline: TimelineEntry[];
  gaps: Gap[];
  decisions: Decision[];
  report: Report | null;
  reviews: ReviewResult[];
  error: RunError | null;
  last_event_seq: number;
}

export interface RunListResponse {
  items: RunSummary[];
  next_cursor: string | null;
}

// ───────────────────────── 事件流（SSE） ─────────────────────────

interface EventBase<T extends string, D> {
  /** 单个运行内从 1 开始严格递增 */
  seq: number;
  run_id: string;
  ts: ISODateTime;
  type: T;
  data: D;
}

export type RunEvent =
  | EventBase<'run.status', { status: RunStatus; phase: Phase | null }>
  | EventBase<'step.started', { step: Phase; round: number }>
  | EventBase<'step.completed', { step: Phase; round: number; duration_ms: number }>
  | EventBase<'task.assessed', TaskSpec>
  | EventBase<'clarification.requested', ClarificationRequest>
  | EventBase<'clarification.answered', ClarificationAnswer>
  | EventBase<'question.updated', SubQuestion>
  | EventBase<'plan.created', ResearchPlan>
  | EventBase<'action.upserted', ResearchAction>
  | EventBase<'tool.called', ToolCall>
  | EventBase<'document.added', SourceDocument>
  | EventBase<'origin_group.upserted', OriginGroup>
  | EventBase<'evidence.added', Evidence>
  | EventBase<'claim.upserted', Claim>
  | EventBase<'timeline.upserted', TimelineEntry>
  | EventBase<'timeline.removed', { id: string }>
  | EventBase<'gap.upserted', Gap>
  | EventBase<'decision.made', Decision>
  | EventBase<'budget.updated', BudgetUsage>
  | EventBase<'report.updated', Report>
  | EventBase<'review.completed', ReviewResult>
  | EventBase<'log', { level: 'debug' | 'info' | 'warning' | 'error'; message: string }>
  | EventBase<
      'run.finished',
      { status: RunStatus; stop_reason: StopReason | null; finished_at: ISODateTime }
    >
  | EventBase<'run.error', RunError>;

export type RunEventType = RunEvent['type'];

// ───────────────────────── 系统配置 ─────────────────────────

export type ModelRole = 'controller' | 'extractor' | 'writer' | 'reviewer';

export interface ModelProfile {
  id: string;
  label: string;
  /** OpenAI 兼容接口的 base_url 主机名，仅用于展示，不含密钥 */
  provider: string;
  roles: Record<ModelRole, string>;
}

export interface SnapshotInfo {
  id: string;
  label: string;
  created_at: ISODateTime;
  entries: number;
}

export interface AppConfig {
  /** mock 表示前端连的是 mock 后端 */
  mode: 'live' | 'mock';
  version: string;
  model_profiles: ModelProfile[];
  default_model_profile: string;
  search_providers: { id: 'tavily' | 'exa' | 'corpus'; available: boolean }[];
  snapshots: SnapshotInfo[];
  budget_presets: Record<Exclude<BudgetPreset, 'custom'>, BudgetLimits>;
  defaults: {
    temporal_mode: TemporalMode;
    report_language: Lang;
    budget_preset: BudgetPreset;
    mechanisms: Mechanisms;
    search_mode: SearchMode;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: Record<string, { ok: boolean; detail: string | null }>;
}

// ───────────────────────── 实验评估 ─────────────────────────

export type BenchmarkId = 'open_tls' | 'deepresearch_bench' | 'browsecomp_plus' | 'manual';

/** 2×2 条件：base 基础工作流；source 仅来源机制；temporal 仅时间机制；full 两者都开 */
export type ConditionId = 'base' | 'source' | 'temporal' | 'full';

export interface MetricDef {
  id: string;
  benchmark: BenchmarkId;
  label: string;
  description: string;
  higher_is_better: boolean;
  unit: 'ratio' | 'score' | 'count' | 'usd' | 'seconds';
  /** 是否为该 benchmark 的主指标 */
  primary: boolean;
}

export interface MetricStat {
  mean: number;
  std: number;
  n: number;
}

export interface CostStat {
  mean_cost_usd: number;
  mean_tokens: number;
  mean_seconds: number;
  mean_tool_calls: number;
  total_cost_usd: number;
  /** 评分（LLM judge）成本，与生成成本分开 */
  grading_cost_usd: number;
}

export interface ConditionResult {
  benchmark: BenchmarkId;
  condition: ConditionId;
  metrics: Record<string, MetricStat>;
  cost: CostStat;
  completion: { completed: number; partial: number; failed: number };
}

export interface TaskResult {
  task_id: string;
  benchmark: BenchmarkId;
  condition: ConditionId;
  repeat: number;
  run_id: string | null;
  status: 'completed' | 'partial' | 'failed';
  metrics: Record<string, number | null>;
  cost_usd: number;
  tokens: number;
  seconds: number;
}

/** 预算档位扫描点，用于质量-成本权衡曲线 */
export interface BudgetLevelPoint {
  benchmark: BenchmarkId;
  condition: ConditionId;
  budget_preset: Exclude<BudgetPreset, 'custom'>;
  metric_id: string;
  metric_mean: number;
  mean_cost_usd: number;
}

export interface ExperimentSummary {
  id: string;
  name: string;
  created_at: ISODateTime;
  status: 'running' | 'completed' | 'failed';
  benchmarks: BenchmarkId[];
  conditions: ConditionId[];
  model_profile: string;
  budget_preset: BudgetPreset;
  repeats: number;
  task_count: number;
  notes: string | null;
}

export interface ExperimentDetail extends ExperimentSummary {
  metric_defs: MetricDef[];
  results: ConditionResult[];
  tasks: TaskResult[];
  budget_levels: BudgetLevelPoint[];
}
