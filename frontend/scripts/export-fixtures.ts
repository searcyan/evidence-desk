/**
 * 导出契约示例数据到 contracts/fixtures/，并用 contracts/schema.json 自检。
 * 用固定的 run id 与起始时间，保证每次导出结果完全一致（可提交到仓库、供后端契约测试使用）。
 *
 * 用法：npm run contract:schema && npm run contract:fixtures
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import type { RunDetail, RunEvent, RunRequest, RunSummary } from '../src/api/types.ts';
import { applyEvent, emptyDetail, toSummary } from '../src/lib/fold.ts';
import { buildScenario, DEMO_CUTOFF, DEMO_QUESTION_EN } from '../mock/scenario.ts';
import { BUDGET_PRESETS, CONFIG } from '../mock/store.ts';
import { buildExperiments } from '../mock/experiments.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'contracts/fixtures');
mkdirSync(outDir, { recursive: true });

const START = Date.parse('2026-11-20T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function runFixture(id: string, req: RunRequest, extra: { failAt?: 'collect' } = {}) {
  const budget = { ...BUDGET_PRESETS[req.budget_preset === 'custom' ? 'medium' : req.budget_preset] };
  const summary: RunSummary = {
    id,
    title: req.question,
    status: 'queued',
    phase: null,
    request: req,
    budget,
    usage: { research_rounds: 0, review_rounds: 0, search_calls: 0, read_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, elapsed_seconds: 0 },
    created_at: iso(START),
    started_at: null,
    finished_at: null,
    stop_reason: null,
    counts: { documents: 0, claims: 0, timeline_entries: 0, open_gaps: 0 },
  };
  let detail: RunDetail = emptyDetail(summary);
  const events: RunEvent[] = [];
  for (const item of buildScenario({ req, budget, start: START + 400, ...extra })) {
    if (item.kind === 'pause') continue;
    const ev = { seq: events.length + 1, run_id: id, ts: iso(item.at), type: item.type, data: item.data } as RunEvent;
    events.push(ev);
    detail = applyEvent(detail, ev);
  }
  return { summary: toSummary(detail), detail, events };
}

const baseReq: RunRequest = {
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
};

const full = runFixture('run_demo01', baseReq);
const partial = runFixture('run_demo02', { ...baseReq, budget_preset: 'small', mechanisms: { source_verification: false, temporal_planning: false } });
const failed = runFixture('run_demo03', baseReq, { failAt: 'collect' });
const clarify = runFixture('run_demo04', { ...baseReq, question: 'Northwind deal?' });
const experiments = buildExperiments({ full: 'run_demo01', partial: 'run_demo02' });

const files: Record<string, { data: unknown; type: string; array?: boolean }> = {
  'run_snapshot.json': { data: full.detail, type: 'RunDetail' },
  'run_events.json': { data: full.events, type: 'RunEvent', array: true },
  'run_partial_snapshot.json': { data: partial.detail, type: 'RunDetail' },
  'run_partial_events.json': { data: partial.events, type: 'RunEvent', array: true },
  'run_failed_snapshot.json': { data: failed.detail, type: 'RunDetail' },
  'run_failed_events.json': { data: failed.events, type: 'RunEvent', array: true },
  'run_clarification_events.json': { data: clarify.events, type: 'RunEvent', array: true },
  'run_request.json': { data: baseReq, type: 'RunRequest' },
  'run_list.json': { data: { items: [full.summary, partial.summary, failed.summary], next_cursor: null }, type: 'RunListResponse' },
  'config.json': { data: { ...CONFIG, mode: 'live', version: '0.1.0' }, type: 'AppConfig' },
  'health.json': { data: { status: 'ok', checks: { database: { ok: true, detail: null }, llm: { ok: true, detail: null }, tavily: { ok: true, detail: null }, exa: { ok: false, detail: 'EXA_API_KEY not set' } } }, type: 'HealthResponse' },
  'experiments.json': { data: experiments.map(({ metric_defs: _m, results: _r, tasks: _t, budget_levels: _b, ...s }) => s), type: 'ExperimentSummary', array: true },
  'experiment_detail.json': { data: { ...experiments[1] }, type: 'ExperimentDetail' },
};

// ── 用 schema 校验 ──
const schema = JSON.parse(readFileSync(resolve(root, 'contracts/schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema, 'contract');
let failures = 0;
for (const [name, f] of Object.entries(files)) {
  const validate = ajv.getSchema(`contract#/definitions/${f.type}`);
  if (!validate) throw new Error(`schema has no definition ${f.type}`);
  const items = f.array ? (f.data as unknown[]) : [f.data];
  for (const [i, item] of items.entries()) {
    if (!validate(item)) {
      failures += 1;
      console.error(`✗ ${name}[${i}] (${f.type})`, JSON.stringify(validate.errors?.slice(0, 3), null, 2));
      break;
    }
  }
  writeFileSync(resolve(outDir, name), JSON.stringify(f.data, null, 2) + '\n');
}

// ── 不变式：事件折叠 == 快照 ──
for (const fx of [full, partial, failed]) {
  let d = emptyDetail({ ...fx.summary, status: 'queued', phase: null, started_at: null, finished_at: null, stop_reason: null, title: fx.detail.request.question, usage: { research_rounds: 0, review_rounds: 0, search_calls: 0, read_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, elapsed_seconds: 0 }, counts: { documents: 0, claims: 0, timeline_entries: 0, open_gaps: 0 } });
  for (const ev of fx.events) d = applyEvent(d, ev);
  if (JSON.stringify(d) !== JSON.stringify(fx.detail)) {
    failures += 1;
    console.error(`✗ fold(events) != snapshot for ${fx.detail.id}`);
  }
}

if (failures) {
  console.error(`\n${failures} contract check(s) failed`);
  process.exit(1);
}
console.log(`✓ wrote ${Object.keys(files).length} fixtures to contracts/fixtures (all valid against schema.json)`);
