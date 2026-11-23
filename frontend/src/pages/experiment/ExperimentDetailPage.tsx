/** 实验详情：按 benchmark 切换，展示 2×2 矩阵、各指标小多图、质量-成本、预算扫描、成本与逐任务结果 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import clsx from 'clsx';
import { ArrowLeft, ExternalLink, Info } from 'lucide-react';
import { useExperiment } from '../../api/hooks.ts';
import type { BenchmarkId, ConditionId, ConditionResult, ExperimentDetail, MetricDef } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtCompact, fmtCost, fmtDate, fmtDuration } from '../../lib/format.ts';
import { Badge, Card, EmptyState, Loading, SectionTitle, Tabs, TextInput } from '../../components/ui.tsx';
import { COND_COLOR } from '../../components/badges.tsx';
import { BudgetSweep, ChartFrame, CONDS, fmtMetric, MetricBars, QualityCost } from './charts.tsx';

function Matrix({ def, results }: { def: MetricDef; results: ConditionResult[] }) {
  const { t, lang } = useI18n();
  const get = (c: ConditionId) => results.find((r) => r.condition === c)?.metrics[def.id];
  const base = get('base')?.mean ?? 0;
  const cell = (c: ConditionId) => {
    const v = get(c);
    if (!v) return <td className="p-4 text-ink-3">—</td>;
    const delta = v.mean - base;
    const good = def.higher_is_better ? delta > 0 : delta < 0;
    return (
      <td className="p-1.5">
        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-ink-2">
            <span className="size-2 rounded-full" style={{ background: COND_COLOR[c] }} />
            {t(`cond.${c}`)}
          </div>
          <div className="tnum text-[22px] font-semibold">{fmtMetric(v.mean, def, lang)}</div>
          <div className="tnum flex items-center justify-between gap-2 text-xs">
            <span className="text-ink-3">± {fmtMetric(v.std, def, lang)}</span>
            {c !== 'base' && (
              <span className={clsx('font-semibold', delta === 0 ? 'text-ink-3' : good ? 'text-good-text' : 'text-critical-text')}>
                Δ {delta >= 0 ? '+' : '−'}
                {fmtMetric(Math.abs(delta), def, lang)}
              </span>
            )}
          </div>
        </div>
      </td>
    );
  };
  return (
    <Card>
      <SectionTitle>{t('exp.matrix', { metric: def.label })}</SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] table-fixed text-sm">
          <thead>
            <tr className="text-xs text-ink-3">
              <th className="w-[110px]" />
              <th className="pb-1 font-medium">{t('exp.temporalOff')}</th>
              <th className="pb-1 font-medium">{t('exp.temporalOn')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th className="pr-2 text-left text-xs font-medium text-ink-3">{t('exp.sourceOff')}</th>
              {cell('base')}
              {cell('temporal')}
            </tr>
            <tr>
              <th className="pr-2 text-left text-xs font-medium text-ink-3">{t('exp.sourceOn')}</th>
              {cell('source')}
              {cell('full')}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">{t('exp.matrixHint')}</p>
    </Card>
  );
}

function MetricsTable({ defs, results }: { defs: MetricDef[]; results: ConditionResult[] }) {
  const { t, lang } = useI18n();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-ink-2">
          <th className="py-2 pr-3 font-medium" />
          {CONDS.map((c) => (
            <th key={c} className="px-3 py-2 text-right font-medium">
              {t(`cond.${c}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {defs.map((d) => (
          <tr key={d.id} className="border-b border-line last:border-0">
            <td className="py-2 pr-3">
              {d.label}
              {!d.higher_is_better && <span className="ml-1 text-xs text-ink-3">↓</span>}
            </td>
            {CONDS.map((c) => {
              const v = results.find((r) => r.condition === c)?.metrics[d.id];
              return (
                <td key={c} className="tnum px-3 py-2 text-right">
                  {fmtMetric(v?.mean, d, lang)}
                  <span className="text-xs text-ink-3"> ±{fmtMetric(v?.std, d, lang)}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CostCards({ results }: { results: ConditionResult[] }) {
  const { t, lang } = useI18n();
  return (
    <Card>
      <SectionTitle>{t('exp.cost')}</SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-2">
              <th className="py-2 pr-3 font-medium" />
              <th className="px-3 py-2 text-right font-medium">{t('exp.meanCost')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('exp.meanTokens')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('exp.meanTime')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('exp.grading')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('exp.completion')}</th>
            </tr>
          </thead>
          <tbody>
            {CONDS.map((c) => {
              const r = results.find((x) => x.condition === c);
              if (!r) return null;
              return (
                <tr key={c} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: COND_COLOR[c] }} />
                      {t(`cond.${c}`)}
                    </span>
                  </td>
                  <td className="tnum px-3 py-2 text-right">{fmtCost(r.cost.mean_cost_usd)}</td>
                  <td className="tnum px-3 py-2 text-right">{fmtCompact(r.cost.mean_tokens, lang)}</td>
                  <td className="tnum px-3 py-2 text-right">{fmtDuration(r.cost.mean_seconds)}</td>
                  <td className="tnum px-3 py-2 text-right">{fmtCost(r.cost.grading_cost_usd)}</td>
                  <td className="tnum px-3 py-2 text-right">
                    <span className="text-good-text">{r.completion.completed}</span> / <span className="text-serious-text">{r.completion.partial}</span> / <span className="text-critical-text">{r.completion.failed}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TaskTable({ exp, bench, primary }: { exp: ExperimentDetail; bench: BenchmarkId; primary: MetricDef }) {
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const tasks = exp.tasks.filter((x) => x.benchmark === bench && (!q || x.task_id.includes(q)));
    const byTask = new Map<string, Record<ConditionId, { vals: number[]; runs: string[]; failed: number }>>();
    for (const x of tasks) {
      const rec = byTask.get(x.task_id) ?? ({} as Record<ConditionId, { vals: number[]; runs: string[]; failed: number }>);
      const cell = rec[x.condition] ?? { vals: [], runs: [], failed: 0 };
      const v = x.metrics[primary.id];
      if (v != null) cell.vals.push(v);
      if (x.status === 'failed') cell.failed += 1;
      if (x.run_id) cell.runs.push(x.run_id);
      rec[x.condition] = cell;
      byTask.set(x.task_id, rec);
    }
    return [...byTask.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [exp.tasks, bench, q, primary.id]);

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3">
        <h3 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">
          {t('exp.taskTable')} <span className="normal-case">· {primary.label}</span>
        </h3>
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('exp.taskFilter')} className="h-8 max-w-[200px]" />
      </div>
      <div className="max-h-[420px] overflow-auto border-t border-line">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="sticky top-0 bg-surface-2">
            <tr className="text-left text-xs text-ink-2">
              <th className="px-5 py-2 font-medium">{t('exp.col.task')}</th>
              {CONDS.map((c) => (
                <th key={c} className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: COND_COLOR[c] }} />
                    {t(`cond.${c}`)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, rec]) => (
              <tr key={id} className="border-t border-line">
                <td className="px-5 py-1.5 font-mono text-xs">{id}</td>
                {CONDS.map((c) => {
                  const cell = rec[c];
                  if (!cell) return <td key={c} className="px-3 py-1.5 text-right text-ink-3">—</td>;
                  const mean = cell.vals.length ? cell.vals.reduce((a, v) => a + v, 0) / cell.vals.length : null;
                  return (
                    <td key={c} className="tnum px-3 py-1.5 text-right">
                      {cell.runs[0] ? (
                        <Link to={`/runs/${cell.runs[0]}`} className="inline-flex items-center gap-1 text-accent-text hover:underline" title={t('exp.viewRun')}>
                          {fmtMetric(mean, primary, lang)}
                          <ExternalLink className="size-3" />
                        </Link>
                      ) : (
                        fmtMetric(mean, primary, lang)
                      )}
                      {cell.failed > 0 && <span className="ml-1 text-xs text-critical-text">✕{cell.failed}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ExperimentDetailPage() {
  const { expId = '' } = useParams();
  const { t, lang } = useI18n();
  const q = useExperiment(expId);
  const [bench, setBench] = useState<BenchmarkId | null>(null);

  if (q.isLoading) return <Loading label={t('common.loading')} />;
  if (!q.data)
    return (
      <div className="mx-auto max-w-xl px-5 py-16">
        <Card>
          <EmptyState title={t('common.notFound')} hint={(q.error as Error | null)?.message} />
        </Card>
      </div>
    );

  const exp = q.data;
  const b = bench ?? exp.benchmarks[0];
  const defs = exp.metric_defs.filter((d) => d.benchmark === b);
  const primary = defs.find((d) => d.primary) ?? defs[0];
  const results = exp.results.filter((r) => r.benchmark === b);
  const sweep = exp.budget_levels.filter((p) => p.benchmark === b);
  const sweepDef = sweep.length ? defs.find((d) => d.id === sweep[0].metric_id) : undefined;

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-6 lg:px-8">
      <Link to="/experiments" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink">
        <ArrowLeft className="size-3.5" />
        {t('nav.experiments')}
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{exp.name}</h1>
          <div className="tnum mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
            <span className="font-mono text-xs text-ink-3">{exp.id}</span>
            <span>{fmtDate(exp.created_at, lang)}</span>
            <span>
              {t('exp.model')}: {exp.model_profile}
            </span>
            <span>
              {t('exp.budget')}: {t(`new.preset.${exp.budget_preset}`)}
            </span>
            <span>{t('exp.tasks', { n: exp.task_count })}</span>
            <span>{t('exp.repeats', { n: exp.repeats })}</span>
          </div>
        </div>
        <Badge tone={exp.status === 'completed' ? 'good' : exp.status === 'failed' ? 'critical' : 'accent'}>{t(`exp.status.${exp.status}`)}</Badge>
      </div>
      {exp.notes && (
        <div className="mb-5 flex gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>
            <span className="font-medium">{t('exp.notes')}:</span> {exp.notes}
          </span>
        </div>
      )}

      <Tabs className="mb-2" value={b} onChange={setBench} tabs={exp.benchmarks.map((x) => ({ value: x, label: t(`exp.benchmark.${x}`) }))} />
      <p className="mb-5 text-sm text-ink-3">{t(`exp.benchmark.${b}.desc`)}</p>

      {primary && (
        <div className="flex flex-col gap-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <Matrix def={primary} results={results} />
            <ChartFrame title={t('exp.qualityCost')} hint={t('exp.qualityCostHint')} table={<CostTable def={primary} results={results} />}>
              {(setTip) => <QualityCost def={primary} results={results} setTip={setTip} />}
            </ChartFrame>
          </div>

          <ChartFrame title={t('exp.metrics')} table={<MetricsTable defs={defs} results={results} />}>
            {(setTip) => (
              <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {defs.map((d) => (
                  <MetricBars key={d.id} def={d} results={results} setTip={setTip} />
                ))}
              </div>
            )}
          </ChartFrame>

          {sweep.length > 0 && sweepDef && (
            <ChartFrame title={`${t('exp.budgetSweep')} — ${sweepDef.label}`} hint={t('exp.budgetSweepHint')} legendConds={CONDS.filter((c) => sweep.some((p) => p.condition === c))} table={<SweepTable def={sweepDef} exp={exp} bench={b} />}>
              {(setTip) => <BudgetSweep def={sweepDef} points={sweep} setTip={setTip} />}
            </ChartFrame>
          )}

          <CostCards results={results} />
          <TaskTable exp={exp} bench={b} primary={primary} />
        </div>
      )}
    </div>
  );
}

function CostTable({ def, results }: { def: MetricDef; results: ConditionResult[] }) {
  const { t, lang } = useI18n();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-ink-2">
          <th className="py-2 font-medium" />
          <th className="px-3 py-2 text-right font-medium">{def.label}</th>
          <th className="px-3 py-2 text-right font-medium">{t('exp.meanCost')}</th>
        </tr>
      </thead>
      <tbody>
        {CONDS.map((c) => {
          const r = results.find((x) => x.condition === c);
          return (
            <tr key={c} className="border-b border-line last:border-0">
              <td className="py-2">{t(`cond.${c}`)}</td>
              <td className="tnum px-3 py-2 text-right">{fmtMetric(r?.metrics[def.id]?.mean, def, lang)}</td>
              <td className="tnum px-3 py-2 text-right">{fmtCost(r?.cost.mean_cost_usd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SweepTable({ def, exp, bench }: { def: MetricDef; exp: ExperimentDetail; bench: BenchmarkId }) {
  const { t, lang } = useI18n();
  const pts = exp.budget_levels.filter((p) => p.benchmark === bench);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-ink-2">
          <th className="py-2 font-medium" />
          <th className="px-3 py-2 font-medium">{t('exp.budget')}</th>
          <th className="px-3 py-2 text-right font-medium">{def.label}</th>
          <th className="px-3 py-2 text-right font-medium">{t('exp.meanCost')}</th>
        </tr>
      </thead>
      <tbody>
        {pts.map((p) => (
          <tr key={`${p.condition}-${p.budget_preset}`} className="border-b border-line last:border-0">
            <td className="py-2">{t(`cond.${p.condition}`)}</td>
            <td className="px-3 py-2">{t(`new.preset.${p.budget_preset}`)}</td>
            <td className="tnum px-3 py-2 text-right">{fmtMetric(p.metric_mean, def, lang)}</td>
            <td className="tnum px-3 py-2 text-right">{fmtCost(p.mean_cost_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
