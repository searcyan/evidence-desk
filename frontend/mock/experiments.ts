/** mock 实验数据：确定性伪随机生成，结构与 evaluation-spec.md 一致（数值仅为演示，非真实结果） */
import type {
  BenchmarkId,
  BudgetLevelPoint,
  ConditionId,
  ConditionResult,
  ExperimentDetail,
  MetricDef,
  TaskResult,
} from '../src/api/types.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const CONDITIONS: ConditionId[] = ['base', 'source', 'temporal', 'full'];

export const METRIC_DEFS: MetricDef[] = [
  { id: 'date_f1', benchmark: 'open_tls', label: 'Date F1', description: 'F1 between predicted and reference milestone dates.', higher_is_better: true, unit: 'ratio', primary: true },
  { id: 'ar1_f1', benchmark: 'open_tls', label: 'AR-1 F1', description: 'Date-aligned ROUGE-1 F1.', higher_is_better: true, unit: 'ratio', primary: false },
  { id: 'ar2_f1', benchmark: 'open_tls', label: 'AR-2 F1', description: 'Date-aligned ROUGE-2 F1.', higher_is_better: true, unit: 'ratio', primary: false },
  { id: 'race_overall', benchmark: 'deepresearch_bench', label: 'RACE overall', description: 'Reference-based report quality (judge model).', higher_is_better: true, unit: 'score', primary: true },
  { id: 'race_comprehensiveness', benchmark: 'deepresearch_bench', label: 'Comprehensiveness', description: 'RACE dimension.', higher_is_better: true, unit: 'score', primary: false },
  { id: 'race_depth', benchmark: 'deepresearch_bench', label: 'Depth', description: 'RACE dimension.', higher_is_better: true, unit: 'score', primary: false },
  { id: 'race_instruction', benchmark: 'deepresearch_bench', label: 'Instruction following', description: 'RACE dimension.', higher_is_better: true, unit: 'score', primary: false },
  { id: 'race_readability', benchmark: 'deepresearch_bench', label: 'Readability', description: 'RACE dimension.', higher_is_better: true, unit: 'score', primary: false },
  { id: 'fact_citation_accuracy', benchmark: 'deepresearch_bench', label: 'Citation accuracy', description: 'FACT: share of citations supported by the cited page.', higher_is_better: true, unit: 'ratio', primary: false },
  { id: 'fact_effective_citations', benchmark: 'deepresearch_bench', label: 'Effective citations', description: 'FACT: supported citations per task.', higher_is_better: true, unit: 'count', primary: false },
  { id: 'accuracy', benchmark: 'browsecomp_plus', label: 'Accuracy', description: 'Answer accuracy judged against the gold answer.', higher_is_better: true, unit: 'ratio', primary: true },
  { id: 'evidence_recall', benchmark: 'browsecomp_plus', label: 'Evidence recall', description: 'Share of gold evidence documents retrieved during the run.', higher_is_better: true, unit: 'ratio', primary: false },
  { id: 'ndcg_at_10', benchmark: 'browsecomp_plus', label: 'nDCG@10', description: 'Ranking quality of retrieved documents.', higher_is_better: true, unit: 'ratio', primary: false },
  { id: 'search_calls', benchmark: 'browsecomp_plus', label: 'Search calls', description: 'Search calls per task.', higher_is_better: false, unit: 'count', primary: false },
  { id: 'status_accuracy', benchmark: 'manual', label: 'Status accuracy', description: 'Event status at the cutoff matches the annotated reference.', higher_is_better: true, unit: 'ratio', primary: true },
  { id: 'citation_support', benchmark: 'manual', label: 'Citation support', description: 'Share of claim–citation pairs supported by the cited passage.', higher_is_better: true, unit: 'ratio', primary: false },
  { id: 'factual_correctness', benchmark: 'manual', label: 'Factual correctness', description: 'Agreement of assessed claims with checked reference facts.', higher_is_better: true, unit: 'ratio', primary: false },
  { id: 'temporal_error_rate', benchmark: 'manual', label: 'Temporal error rate', description: 'Wrong dates, confused stages, or evidence unavailable at the cutoff.', higher_is_better: false, unit: 'ratio', primary: false },
  { id: 'provenance_accuracy', benchmark: 'manual', label: 'Provenance accuracy', description: 'Share of "independent" reports that truly are independent.', higher_is_better: true, unit: 'ratio', primary: false },
];

/** 每个指标在 base 条件下的均值，以及来源/时间机制带来的增量 */
const EFFECTS: Record<string, { base: number; src: number; tmp: number; sd: number; scale?: number }> = {
  date_f1: { base: 0.31, src: 0.01, tmp: 0.07, sd: 0.08 },
  ar1_f1: { base: 0.082, src: 0.004, tmp: 0.011, sd: 0.02 },
  ar2_f1: { base: 0.021, src: 0.002, tmp: 0.004, sd: 0.008 },
  race_overall: { base: 38.5, src: 1.6, tmp: 1.1, sd: 4, scale: 100 },
  race_comprehensiveness: { base: 37.2, src: 1.2, tmp: 1.8, sd: 4.5, scale: 100 },
  race_depth: { base: 35.9, src: 1.9, tmp: 1.0, sd: 4.2, scale: 100 },
  race_instruction: { base: 42.1, src: 0.6, tmp: 0.4, sd: 3.5, scale: 100 },
  race_readability: { base: 40.3, src: 0.3, tmp: 0.2, sd: 3.0, scale: 100 },
  fact_citation_accuracy: { base: 0.71, src: 0.08, tmp: 0.02, sd: 0.07 },
  fact_effective_citations: { base: 14.2, src: 2.1, tmp: 1.3, sd: 4, scale: 60 },
  accuracy: { base: 0.18, src: 0.03, tmp: 0.0, sd: 0.38 },
  evidence_recall: { base: 0.34, src: 0.06, tmp: 0.01, sd: 0.15 },
  ndcg_at_10: { base: 0.22, src: 0.03, tmp: 0.0, sd: 0.1 },
  search_calls: { base: 9.5, src: 3.2, tmp: 1.4, sd: 2.5, scale: 60 },
  status_accuracy: { base: 0.54, src: 0.08, tmp: 0.17, sd: 0.45 },
  citation_support: { base: 0.78, src: 0.09, tmp: 0.02, sd: 0.08 },
  factual_correctness: { base: 0.81, src: 0.04, tmp: 0.05, sd: 0.08 },
  temporal_error_rate: { base: 0.27, src: -0.02, tmp: -0.13, sd: 0.08 },
  provenance_accuracy: { base: 0.58, src: 0.27, tmp: 0.0, sd: 0.12 },
};

const COST = { base: 0.052, source: 0.071, temporal: 0.076, full: 0.094 } as Record<ConditionId, number>;
const TASKS: Record<BenchmarkId, number> = { open_tls: 20, deepresearch_bench: 12, browsecomp_plus: 30, manual: 24 };
const BINARY = new Set(['accuracy', 'status_accuracy']);

function genTasks(seed: number, benchmarks: BenchmarkId[], repeats: number, runLinks: Record<string, string>): TaskResult[] {
  const r = rng(seed);
  const out: TaskResult[] = [];
  for (const b of benchmarks) {
    const defs = METRIC_DEFS.filter((m) => m.benchmark === b);
    for (let t = 1; t <= TASKS[b]; t++) {
      const difficulty = gauss(r) * 0.6; // 任务难度在条件之间共享，形成配对结构
      for (const c of CONDITIONS) {
        for (let rep = 1; rep <= repeats; rep++) {
          const metrics: Record<string, number | null> = {};
          const useSrc = c === 'source' || c === 'full';
          const useTmp = c === 'temporal' || c === 'full';
          for (const d of defs) {
            const e = EFFECTS[d.id];
            const mean = e.base + (useSrc ? e.src : 0) + (useTmp ? e.tmp : 0);
            if (BINARY.has(d.id)) {
              metrics[d.id] = r() < clamp01(mean - difficulty * 0.15) ? 1 : 0;
            } else {
              const v = mean + (difficulty * 0.5 + gauss(r) * 0.6) * e.sd;
              metrics[d.id] = e.scale ? Math.max(0, Math.round(v * 10) / 10) : r3(clamp01(v));
            }
          }
          const failed = r() < 0.025;
          const partial = !failed && r() < 0.08;
          const cost = COST[c] * (1 + gauss(r) * 0.18) * (b === 'deepresearch_bench' ? 2.4 : 1);
          const key = `${b}:${t}:${c}:${rep}`;
          out.push({
            task_id: `${b === 'open_tls' ? 'otls' : b === 'deepresearch_bench' ? 'drb' : b === 'browsecomp_plus' ? 'bcp' : 'man'}_${String(t).padStart(3, '0')}`,
            benchmark: b,
            condition: c,
            repeat: rep,
            run_id: runLinks[key] ?? null,
            status: failed ? 'failed' : partial ? 'partial' : 'completed',
            metrics: failed ? Object.fromEntries(defs.map((d) => [d.id, null])) : metrics,
            cost_usd: r3(Math.max(0.01, cost) * 1000) / 1000,
            tokens: Math.round(260000 * (COST[c] / 0.052) * (1 + gauss(r) * 0.2)),
            seconds: Math.round(210 * (COST[c] / 0.052) * (1 + gauss(r) * 0.25)),
          });
        }
      }
    }
  }
  return out;
}

function aggregate(tasks: TaskResult[], benchmarks: BenchmarkId[]): ConditionResult[] {
  const out: ConditionResult[] = [];
  for (const b of benchmarks) {
    const defs = METRIC_DEFS.filter((m) => m.benchmark === b);
    for (const c of CONDITIONS) {
      const rows = tasks.filter((t) => t.benchmark === b && t.condition === c);
      const metrics: ConditionResult['metrics'] = {};
      for (const d of defs) {
        const vals = rows.map((t) => t.metrics[d.id]).filter((v): v is number => v != null);
        const mean = vals.reduce((a, v) => a + v, 0) / Math.max(vals.length, 1);
        const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(vals.length - 1, 1));
        metrics[d.id] = { mean: r3(mean), std: r3(sd), n: vals.length };
      }
      const n = Math.max(rows.length, 1);
      const total = rows.reduce((a, t) => a + t.cost_usd, 0);
      out.push({
        benchmark: b,
        condition: c,
        metrics,
        cost: {
          mean_cost_usd: r3((total / n) * 1000) / 1000,
          mean_tokens: Math.round(rows.reduce((a, t) => a + t.tokens, 0) / n),
          mean_seconds: Math.round(rows.reduce((a, t) => a + t.seconds, 0) / n),
          mean_tool_calls: Math.round((22 * COST[c]) / 0.052),
          total_cost_usd: Math.round(total * 100) / 100,
          grading_cost_usd: Math.round(total * (b === 'deepresearch_bench' ? 0.6 : 0.15) * 100) / 100,
        },
        completion: {
          completed: rows.filter((t) => t.status === 'completed').length,
          partial: rows.filter((t) => t.status === 'partial').length,
          failed: rows.filter((t) => t.status === 'failed').length,
        },
      });
    }
  }
  return out;
}

function budgetLevels(): BudgetLevelPoint[] {
  const pts: BudgetLevelPoint[] = [];
  const levels = [
    { p: 'small' as const, q: { base: 0.27, full: 0.33 }, c: { base: 0.031, full: 0.048 } },
    { p: 'medium' as const, q: { base: 0.31, full: 0.39 }, c: { base: 0.052, full: 0.094 } },
    { p: 'large' as const, q: { base: 0.32, full: 0.41 }, c: { base: 0.083, full: 0.171 } },
  ];
  for (const l of levels) {
    for (const c of ['base', 'full'] as const) {
      pts.push({ benchmark: 'open_tls', condition: c, budget_preset: l.p, metric_id: 'date_f1', metric_mean: l.q[c], mean_cost_usd: l.c[c] });
    }
  }
  return pts;
}

export function buildExperiments(seeded: Record<string, string>): ExperimentDetail[] {
  const mainBench: BenchmarkId[] = ['open_tls', 'deepresearch_bench', 'browsecomp_plus', 'manual'];
  const mainTasks = genTasks(7608, mainBench, 3, {});
  const pilotBench: BenchmarkId[] = ['open_tls', 'manual'];
  const pilotTasks = genTasks(42, pilotBench, 1, {
    'manual:1:full:1': seeded.full,
    'manual:1:base:1': seeded.partial,
  }).filter((t) => Number(t.task_id.slice(-3)) <= 5);
  return [
    {
      id: 'exp_main',
      name: '2×2 mechanism ablation — test split',
      created_at: '2026-11-18T02:00:00Z',
      status: 'completed',
      benchmarks: mainBench,
      conditions: CONDITIONS,
      model_profile: 'default',
      budget_preset: 'medium',
      repeats: 3,
      task_count: Object.values(TASKS).reduce((a, b) => a + b, 0),
      notes: 'MOCK DATA for UI development. DeepResearch Bench uses a substitute judge (not leaderboard-comparable); subset of 12 current-events tasks.',
      metric_defs: METRIC_DEFS.filter((m) => mainBench.includes(m.benchmark)),
      results: aggregate(mainTasks, mainBench),
      tasks: mainTasks,
      budget_levels: budgetLevels(),
    },
    {
      id: 'exp_pilot',
      name: 'Pilot — 5 dev tasks per benchmark',
      created_at: '2026-11-12T08:30:00Z',
      status: 'completed',
      benchmarks: pilotBench,
      conditions: CONDITIONS,
      model_profile: 'default',
      budget_preset: 'small',
      repeats: 1,
      task_count: 10,
      notes: 'MOCK DATA. Used to estimate runtime and cost before freezing budget caps.',
      metric_defs: METRIC_DEFS.filter((m) => pilotBench.includes(m.benchmark)),
      results: aggregate(pilotTasks, pilotBench),
      tasks: pilotTasks,
      budget_levels: [],
    },
  ];
}
