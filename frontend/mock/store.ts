/**
 * mock 后端的内存存储与回放引擎。
 * 每个运行持有：快照（由事件折叠得到）、事件日志、待回放脚本、SSE 订阅者。
 */
import type {
  AppConfig,
  BudgetLimits,
  ClarificationAnswer,
  RunDetail,
  RunEvent,
  RunRequest,
  RunSummary,
} from '../src/api/types.ts';
import { applyEvent, emptyDetail, isTerminal, toSummary } from '../src/lib/fold.ts';
import { buildScenario, DEMO_CUTOFF, DEMO_QUESTION_EN, DEMO_QUESTION_ZH, type ScriptItem } from './scenario.ts';

export const BUDGET_PRESETS: AppConfig['budget_presets'] = {
  small: { max_research_rounds: 3, max_review_rounds: 1, max_tool_calls: 30, max_llm_tokens: 300000, max_seconds: 300, max_cost_usd: 0.3, reserve_ratio: 0.25 },
  medium: { max_research_rounds: 5, max_review_rounds: 2, max_tool_calls: 60, max_llm_tokens: 800000, max_seconds: 600, max_cost_usd: 0.8, reserve_ratio: 0.25 },
  large: { max_research_rounds: 8, max_review_rounds: 3, max_tool_calls: 120, max_llm_tokens: 2000000, max_seconds: 1200, max_cost_usd: 2.0, reserve_ratio: 0.2 },
};

export const CONFIG: AppConfig = {
  mode: 'mock',
  version: '0.1.0-mock',
  model_profiles: [
    { id: 'default', label: 'DeepSeek V3 (all roles)', provider: 'api.deepseek.com', roles: { controller: 'deepseek-chat', extractor: 'deepseek-chat', writer: 'deepseek-chat', reviewer: 'deepseek-chat' } },
    { id: 'mixed', label: 'Qwen extractor + DeepSeek writer', provider: 'dashscope.aliyuncs.com', roles: { controller: 'deepseek-chat', extractor: 'qwen-plus', writer: 'deepseek-chat', reviewer: 'qwen-max' } },
  ],
  default_model_profile: 'default',
  search_providers: [
    { id: 'tavily', available: true },
    { id: 'exa', available: true },
    { id: 'corpus', available: false },
  ],
  snapshots: [{ id: 'snap_opentls_dev', label: 'Open-TLS dev pool (frozen)', created_at: '2026-11-10T09:00:00Z', entries: 4812 }],
  budget_presets: BUDGET_PRESETS,
  defaults: {
    temporal_mode: 'as_of',
    report_language: 'en',
    budget_preset: 'medium',
    mechanisms: { source_verification: true, temporal_planning: true },
    search_mode: 'live',
  },
};

type Subscriber = (ev: RunEvent) => void;

interface RunRecord {
  detail: RunDetail;
  events: RunEvent[];
  script: ScriptItem[];
  cursor: number;
  timer: ReturnType<typeof setTimeout> | null;
  paused: boolean;
  subscribers: Set<Subscriber>;
  /** 回放时事件 ts 取脚本虚拟时间（种子数据）还是真实时间（实时运行） */
  live: boolean;
}

const runs = new Map<string, RunRecord>();
const SPEED = Number(process.env.MOCK_SPEED ?? '1'); // >1 加速回放

export class HttpError extends Error {
  status: number;
  type: string;
  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveBudget(req: RunRequest): BudgetLimits {
  if (req.budget_preset === 'custom') {
    const b = req.budget ?? {};
    const keys: (keyof BudgetLimits)[] = ['max_research_rounds', 'max_review_rounds', 'max_tool_calls', 'max_llm_tokens', 'max_seconds', 'max_cost_usd', 'reserve_ratio'];
    for (const k of keys) if (!(k in b)) throw new HttpError(422, 'validation_error', `budget.${k} is required for custom preset`);
    return b as BudgetLimits;
  }
  return { ...BUDGET_PRESETS[req.budget_preset], ...(req.budget ?? {}) };
}

function validate(req: RunRequest) {
  if (!req.question || !req.question.trim()) throw new HttpError(422, 'validation_error', 'question is required');
  if (req.question.length > 2000) throw new HttpError(422, 'validation_error', 'question is too long');
  if (!/T.*(Z|[+-]\d{2}:\d{2})$/.test(req.cutoff ?? '')) throw new HttpError(422, 'validation_error', 'cutoff must be an RFC 3339 timestamp with timezone');
  if (new Date(req.cutoff).getTime() > Date.now() + 60_000) throw new HttpError(422, 'validation_error', 'cutoff must not be in the future');
  if (req.search_mode === 'snapshot' && !CONFIG.snapshots.some((s) => s.id === req.snapshot_id)) throw new HttpError(422, 'validation_error', 'unknown snapshot_id');
  if (req.search_mode === 'corpus') throw new HttpError(422, 'validation_error', 'corpus mode is unavailable (no local corpus configured)');
}

function emit(rec: RunRecord, type: RunEvent['type'], data: unknown, ts: string) {
  const ev = { seq: rec.events.length + 1, run_id: rec.detail.id, ts, type, data } as RunEvent;
  rec.events.push(ev);
  rec.detail = applyEvent(rec.detail, ev);
  rec.subscribers.forEach((fn) => fn(ev));
}

function step(rec: RunRecord) {
  rec.timer = null;
  while (rec.cursor < rec.script.length) {
    const item = rec.script[rec.cursor];
    if (item.kind === 'pause') {
      rec.paused = true;
      rec.cursor += 1;
      return;
    }
    if (rec.live && item.delay > 0 && !(item as { _waited?: boolean })._waited) {
      (item as { _waited?: boolean })._waited = true;
      rec.timer = setTimeout(() => step(rec), item.delay / SPEED);
      return;
    }
    rec.cursor += 1;
    const ts = rec.live ? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') : new Date(item.at).toISOString().replace(/\.\d{3}Z$/, 'Z');
    emit(rec, item.type, item.data, ts);
    if (rec.detail.status && isTerminal(rec.detail.status) && item.type === 'run.finished') return;
  }
}

function makeRecord(req: RunRequest, opts: { createdAt: number; live: boolean; failAt?: 'collect'; cancelAt?: 'round2' }): RunRecord {
  validate(req);
  const budget = resolveBudget(req);
  const id = newId('run');
  const created = new Date(opts.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const summary: RunSummary = {
    id,
    title: req.question.length > 80 ? `${req.question.slice(0, 80)}…` : req.question,
    status: 'queued',
    phase: null,
    request: req,
    budget,
    usage: { research_rounds: 0, review_rounds: 0, search_calls: 0, read_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, elapsed_seconds: 0 },
    created_at: created,
    started_at: null,
    finished_at: null,
    stop_reason: null,
    counts: { documents: 0, claims: 0, timeline_entries: 0, open_gaps: 0 },
  };
  const rec: RunRecord = {
    detail: emptyDetail(summary),
    events: [],
    script: buildScenario({ req, budget, start: opts.createdAt + 400, failAt: opts.failAt, cancelAt: opts.cancelAt }),
    cursor: 0,
    timer: null,
    paused: false,
    subscribers: new Set(),
    live: opts.live,
  };
  runs.set(id, rec);
  return rec;
}

// ───────────────────────── 对外接口 ─────────────────────────

export function createRun(req: RunRequest): RunSummary {
  const rec = makeRecord(req, { createdAt: Date.now(), live: true });
  rec.timer = setTimeout(() => step(rec), 400 / SPEED);
  return toSummary(rec.detail);
}

export function listRuns(status?: string[], q?: string): RunSummary[] {
  let items = [...runs.values()].map((r) => toSummary(r.detail));
  if (status?.length) items = items.filter((r) => status.includes(r.status));
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((r) => r.title.toLowerCase().includes(needle) || r.request.question.toLowerCase().includes(needle));
  }
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function getRun(id: string): RunRecord {
  const rec = runs.get(id);
  if (!rec) throw new HttpError(404, 'not_found', `run ${id} not found`);
  return rec;
}

export function answerClarification(id: string, body: ClarificationAnswer): RunSummary {
  const rec = getRun(id);
  if (rec.detail.status !== 'awaiting_clarification' || !rec.paused) throw new HttpError(409, 'conflict', 'run is not awaiting clarification');
  const next = rec.script[rec.cursor];
  if (next?.kind === 'event' && next.type === 'clarification.answered') next.data = { answers: body.answers ?? [] };
  rec.paused = false;
  step(rec);
  return toSummary(rec.detail);
}

export function cancelRun(id: string): RunSummary {
  const rec = getRun(id);
  if (isTerminal(rec.detail.status)) throw new HttpError(409, 'conflict', 'run already finished');
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = null;
  rec.cursor = rec.script.length;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  emit(rec, 'log', { level: 'warning', message: 'Run cancelled by user.' }, now);
  emit(rec, 'run.finished', { status: 'cancelled', stop_reason: 'cancelled', finished_at: now }, now);
  return toSummary(rec.detail);
}

export function resumeRun(id: string): RunSummary {
  const rec = getRun(id);
  if (rec.detail.status !== 'failed') throw new HttpError(409, 'conflict', 'only failed runs can be resumed');
  throw new HttpError(409, 'conflict', 'mock backend cannot resume runs');
}

export function deleteRun(id: string) {
  const rec = getRun(id);
  if (rec.timer) clearTimeout(rec.timer);
  rec.subscribers.clear();
  runs.delete(id);
}

export function subscribe(id: string, fn: Subscriber): () => void {
  const rec = getRun(id);
  rec.subscribers.add(fn);
  return () => rec.subscribers.delete(fn);
}

// ───────────────────────── 种子数据 ─────────────────────────

/** 立即回放完整脚本（澄清自动作答），生成历史运行 */
function seed(req: Partial<RunRequest>, hoursAgo: number, extra: { failAt?: 'collect'; cancelAt?: 'round2' } = {}) {
  const full: RunRequest = {
    question: DEMO_QUESTION_EN,
    event_hint: null,
    cutoff: DEMO_CUTOFF,
    temporal_mode: 'as_of',
    seed_url: null,
    report_language: 'en',
    budget_preset: 'medium',
    budget: null,
    mechanisms: { source_verification: true, temporal_planning: true },
    search_mode: 'live',
    snapshot_id: null,
    model_profile: null,
    tags: [],
    ...req,
  };
  const rec = makeRecord(full, { createdAt: Date.now() - hoursAgo * 3600_000, live: false, ...extra });
  while (rec.cursor < rec.script.length) {
    step(rec);
    if (rec.paused) rec.paused = false;
  }
  return rec.detail.id;
}

export const SEEDED: Record<string, string> = {};

export function seedRuns() {
  if (runs.size) return;
  SEEDED.cancelled = seed({ mechanisms: { source_verification: true, temporal_planning: false }, tags: ['demo'] }, 70, { cancelAt: 'round2' });
  SEEDED.failed = seed({ question: 'What is the current status of the Northwind–Helios merger review in the EU?', tags: ['demo'] }, 52, { failAt: 'collect' });
  SEEDED.partial = seed({ budget_preset: 'small', mechanisms: { source_verification: false, temporal_planning: false }, tags: ['exp:exp_pilot', 'cond:base'] }, 30);
  SEEDED.zh = seed({ question: DEMO_QUESTION_ZH, report_language: 'zh', temporal_mode: 'retrospective', tags: ['demo'] }, 20);
  SEEDED.full = seed({ tags: ['exp:exp_pilot', 'cond:full'] }, 6);
}
