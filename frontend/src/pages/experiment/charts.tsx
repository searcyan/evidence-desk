/**
 * 实验图表（手写 SVG，遵循 dataviz 规范）：
 * - 条件配色固定：base 灰 / source 蓝 / temporal 橙 / full 青（已用校验器验证）；
 * - 细柱（≤24px，顶部 4px 圆角，底部直角）、2px 线、≥8px 标记点并带 2px 表面色描边；
 * - 每个图都有图例、悬停提示与表格视图。
 */
import { useRef, useState, type ReactNode } from 'react';
import type { BudgetLevelPoint, ConditionId, ConditionResult, MetricDef } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtCost, fmtNum } from '../../lib/format.ts';
import { COND_COLOR } from '../../components/badges.tsx';
import { Segmented } from '../../components/ui.tsx';
import { useWidth } from '../../lib/useWidth.ts';

export const CONDS: ConditionId[] = ['base', 'source', 'temporal', 'full'];

export function fmtMetric(v: number | null | undefined, def: MetricDef | undefined, lang: 'en' | 'zh') {
  if (v == null) return '—';
  if (!def) return fmtNum(v, lang, 3);
  if (def.unit === 'ratio') return v.toFixed(3);
  if (def.unit === 'usd') return fmtCost(v);
  if (def.unit === 'seconds') return `${Math.round(v)}s`;
  return fmtNum(v, lang, 1);
}

export function Legend({ conds = CONDS }: { conds?: ConditionId[] }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
      {conds.map((c) => (
        <span key={c} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: COND_COLOR[c] }} />
          {t(`cond.${c}`)}
        </span>
      ))}
    </div>
  );
}

/** 图表容器：标题 + 图/表切换 + 悬停提示层 */
export function ChartFrame({ title, hint, table, children, legend = true, legendConds }: { title: ReactNode; hint?: ReactNode; table: ReactNode; children: (setTip: (tip: Tip | null) => void) => ReactNode; legend?: boolean; legendConds?: ConditionId[] }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  return (
    <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {hint && <p className="text-xs text-ink-3">{hint}</p>}
        </div>
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'chart', label: t('common.chart') },
            { value: 'table', label: t('common.table') },
          ]}
        />
      </div>
      {mode === 'chart' ? (
        <>
          {legend && (
            <div className="mt-2 mb-3">
              <Legend conds={legendConds} />
            </div>
          )}
          <div
            ref={box}
            className="relative"
            onMouseMove={(e) => {
              if (!tip || !box.current) return;
              const r = box.current.getBoundingClientRect();
              setTip({ ...tip, x: e.clientX - r.left, y: e.clientY - r.top });
            }}
            onMouseLeave={() => setTip(null)}
          >
            {children((tp) => {
              if (!tp || !box.current) return setTip(null);
              setTip(tp);
            })}
            {tip && (
              <div
                className="pointer-events-none absolute z-10 min-w-[160px] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop"
                style={{ left: Math.min(tip.x + 14, (box.current?.clientWidth ?? 400) - 180), top: tip.y + 14 }}
              >
                {tip.content}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="mt-3 overflow-x-auto">{table}</div>
      )}
    </div>
  );
}

export interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => n <= s) ?? 10;
  return step * p;
}

/**
 * 直接标注的简单避让：依次尝试右、左、上、下四个位置，选第一个不与已放置标签和点重叠的位置。
 */
function placeLabels(pts: { x: number; y: number; text: string }[], bounds: { w: number; h: number }) {
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  return pts.map((p) => {
    const w = p.text.length * 6.6 + 4;
    const h = 14;
    const cands = [
      { x: p.x + 10, y: p.y - h / 2, anchor: 'start' as const },
      { x: p.x - 10 - w, y: p.y - h / 2, anchor: 'end' as const },
      { x: p.x - w / 2, y: p.y - 12 - h, anchor: 'middle' as const },
      { x: p.x - w / 2, y: p.y + 10, anchor: 'middle' as const },
    ];
    const ok = cands.find((c) => {
      const box = { x: c.x, y: c.y, w, h };
      if (box.x < 0 || box.x + w > bounds.w || box.y < 0 || box.y + h > bounds.h) return false;
      return !placed.some((b) => overlaps(box, b)) && !pts.some((q) => overlaps(box, { x: q.x - 6, y: q.y - 6, w: 12, h: 12 }));
    }) ?? cands[0];
    placed.push({ x: ok.x, y: ok.y, w, h });
    const tx = ok.anchor === 'start' ? ok.x : ok.anchor === 'end' ? ok.x + w - 4 : ok.x + w / 2;
    return { tx, ty: ok.y + 11, anchor: ok.anchor };
  });
}

/** 单指标四条件细柱图（用于小多图） */
export function MetricBars({ def, results, setTip }: { def: MetricDef; results: ConditionResult[]; setTip: (t: Tip | null) => void }) {
  const { t, lang } = useI18n();
  const [ref, W] = useWidth<HTMLDivElement>(220);
  const H = 128;
  const top = 18;
  const bottom = 22;
  const vals = CONDS.map((c) => results.find((r) => r.condition === c)?.metrics[def.id]);
  const max = niceMax(Math.max(...vals.map((v) => v?.mean ?? 0)) * 1.1);
  const band = W / CONDS.length;
  const bw = Math.min(24, band * 0.5);
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom);
  const best = def.higher_is_better ? Math.max(...vals.map((v) => v?.mean ?? -Infinity)) : Math.min(...vals.map((v) => v?.mean ?? Infinity));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="truncate text-[13px] font-medium" title={def.description}>
          {def.label}
        </div>
        <div className="shrink-0 text-[10px] text-ink-3">{def.primary ? t('exp.primary') : !def.higher_is_better ? t('exp.lowerBetter') : ''}</div>
      </div>
      <div ref={ref}>
      <svg width={W} height={H} className="block" role="img" aria-label={def.label}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--grid)" strokeWidth={1} />
        ))}
        <text x={0} y={y(max) - 4} fontSize={10} fill="var(--ink-3)">
          {fmtMetric(max, def, lang)}
        </text>
        {CONDS.map((c, i) => {
          const v = vals[i];
          if (!v) return null;
          const x = i * band + band / 2 - bw / 2;
          const yy = y(v.mean);
          const h = Math.max(H - bottom - yy, 1);
          const r = Math.min(4, h);
          const isBest = v.mean === best;
          return (
            <g
              key={c}
              onMouseEnter={(e) =>
                setTip({
                  x: e.nativeEvent.offsetX,
                  y: e.nativeEvent.offsetY,
                  content: (
                    <>
                      <div className="mb-1 flex items-center gap-1.5 font-semibold">
                        <span className="size-2 rounded-sm" style={{ background: COND_COLOR[c] }} />
                        {t(`cond.${c}`)} · {def.label}
                      </div>
                      <div className="tnum text-ink-2">
                        {fmtMetric(v.mean, def, lang)} ± {fmtMetric(v.std, def, lang)} <span className="text-ink-3">(n={v.n})</span>
                      </div>
                    </>
                  ),
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              <rect x={i * band} y={top} width={band} height={H - top - bottom} fill="transparent" />
              <path d={`M${x},${H - bottom} V${yy + r} a${r},${r} 0 0 1 ${r},${-r} H${x + bw - r} a${r},${r} 0 0 1 ${r},${r} V${H - bottom} Z`} fill={COND_COLOR[c]} />
              {isBest && (
                <text x={x + bw / 2} y={yy - 4} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--ink)">
                  {fmtMetric(v.mean, def, lang)}
                </text>
              )}
              <text x={i * band + band / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
                {t(`cond.${c}`)}
              </text>
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H - bottom} y2={H - bottom} stroke="var(--axis)" strokeWidth={1} />
      </svg>
      </div>
    </div>
  );
}

/** 质量-成本散点：四个条件各一点，直接标注 */
export function QualityCost({ def, results, setTip }: { def: MetricDef; results: ConditionResult[]; setTip: (t: Tip | null) => void }) {
  const { t, lang } = useI18n();
  const [ref, W] = useWidth<HTMLDivElement>(520);
  const H = 260;
  const m = { l: 48, r: 24, t: 16, b: 36 };
  const pts = CONDS.map((c) => {
    const r = results.find((x) => x.condition === c);
    return r ? { c, x: r.cost.mean_cost_usd, y: r.metrics[def.id]?.mean ?? 0, sd: r.metrics[def.id]?.std ?? 0, r } : null;
  }).filter((p): p is NonNullable<typeof p> => !!p);
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = 0;
  const x1 = niceMax(Math.max(...xs) * 1.15);
  const yPad = (Math.max(...ys) - Math.min(...ys)) * 0.6 || Math.max(...ys) * 0.1 || 0.1;
  const y0 = Math.max(0, Math.min(...ys) - yPad);
  const y1 = Math.max(...ys) + yPad;
  const X = (v: number) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const xt = [0, x1 / 4, x1 / 2, (3 * x1) / 4, x1];
  const yt = [y0, (y0 + y1) / 2, y1];
  const labels = placeLabels(
    pts.map((p) => ({ x: X(p.x), y: Y(p.y), text: t(`cond.${p.c}`) })),
    { w: W, h: H - m.b },
  );
  return (
    <div ref={ref}>
    <svg width={W} height={H} className="block" role="img" aria-label="quality vs cost">
      {yt.map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} stroke="var(--grid)" />
          <text x={m.l - 6} y={Y(v) + 3} textAnchor="end" fontSize={10} fill="var(--ink-3)" className="tnum">
            {fmtMetric(v, def, lang)}
          </text>
        </g>
      ))}
      {xt.map((v) => (
        <text key={v} x={X(v)} y={H - m.b + 16} textAnchor="middle" fontSize={10} fill="var(--ink-3)" className="tnum">
          {fmtCost(v)}
        </text>
      ))}
      <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="var(--axis)" />
      <text x={W - m.r} y={H - 4} textAnchor="end" fontSize={10} fill="var(--ink-3)">
        {t('exp.meanCost')} →
      </text>
      <text x={m.l} y={m.t - 4} fontSize={10} fill="var(--ink-3)">
        ↑ {def.label}
      </text>
      {pts.map((p, i) => (
        <g
          key={p.c}
          onMouseEnter={(e) =>
            setTip({
              x: e.nativeEvent.offsetX,
              y: e.nativeEvent.offsetY,
              content: (
                <>
                  <div className="mb-1 flex items-center gap-1.5 font-semibold">
                    <span className="size-2 rounded-full" style={{ background: COND_COLOR[p.c] }} />
                    {t(`cond.${p.c}`)}
                  </div>
                  <div className="tnum text-ink-2">
                    {def.label}: {fmtMetric(p.y, def, lang)} ± {fmtMetric(p.sd, def, lang)}
                  </div>
                  <div className="tnum text-ink-2">
                    {t('exp.meanCost')}: {fmtCost(p.x)}
                  </div>
                </>
              ),
            })
          }
          onMouseLeave={() => setTip(null)}
        >
          <circle cx={X(p.x)} cy={Y(p.y)} r={14} fill="transparent" />
          <circle cx={X(p.x)} cy={Y(p.y)} r={6} fill={COND_COLOR[p.c]} stroke="var(--surface)" strokeWidth={2} />
          <text x={labels[i].tx} y={labels[i].ty} textAnchor={labels[i].anchor} fontSize={11} fill="var(--ink)" fontWeight={500}>
            {t(`cond.${p.c}`)}
          </text>
        </g>
      ))}
    </svg>
    </div>
  );
}

/** 预算扫描：每个条件一条线（x=成本，y=指标），点标注预算档位 */
export function BudgetSweep({ def, points, setTip }: { def: MetricDef; points: BudgetLevelPoint[]; setTip: (t: Tip | null) => void }) {
  const { t, lang } = useI18n();
  const [ref, W] = useWidth<HTMLDivElement>(520);
  const H = 260;
  const m = { l: 48, r: 56, t: 16, b: 36 };
  const conds = CONDS.filter((c) => points.some((p) => p.condition === c));
  const x1 = niceMax(Math.max(...points.map((p) => p.mean_cost_usd)) * 1.1);
  const ys = points.map((p) => p.metric_mean);
  const pad = (Math.max(...ys) - Math.min(...ys)) * 0.3 || 0.05;
  const y0 = Math.max(0, Math.min(...ys) - pad);
  const y1 = Math.max(...ys) + pad;
  const X = (v: number) => m.l + (v / x1) * (W - m.l - m.r);
  const Y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const order = { small: 0, medium: 1, large: 2 };
  return (
    <div ref={ref}>
    <svg width={W} height={H} className="block" role="img" aria-label="budget sweep">
      {[y0, (y0 + y1) / 2, y1].map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} stroke="var(--grid)" />
          <text x={m.l - 6} y={Y(v) + 3} textAnchor="end" fontSize={10} fill="var(--ink-3)">
            {fmtMetric(v, def, lang)}
          </text>
        </g>
      ))}
      {[0, x1 / 2, x1].map((v) => (
        <text key={v} x={X(v)} y={H - m.b + 16} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
          {fmtCost(v)}
        </text>
      ))}
      <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="var(--axis)" />
      <text x={W - m.r} y={H - 4} textAnchor="end" fontSize={10} fill="var(--ink-3)">
        {t('exp.meanCost')} →
      </text>
      {conds.map((c) => {
        const ps = points.filter((p) => p.condition === c).sort((a, b) => order[a.budget_preset] - order[b.budget_preset]);
        const last = ps[ps.length - 1];
        return (
          <g key={c}>
            <polyline points={ps.map((p) => `${X(p.mean_cost_usd)},${Y(p.metric_mean)}`).join(' ')} fill="none" stroke={COND_COLOR[c]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {ps.map((p) => (
              <g
                key={p.budget_preset}
                onMouseEnter={(e) =>
                  setTip({
                    x: e.nativeEvent.offsetX,
                    y: e.nativeEvent.offsetY,
                    content: (
                      <>
                        <div className="mb-1 font-semibold">
                          {t(`cond.${c}`)} · {t(`new.preset.${p.budget_preset}`)}
                        </div>
                        <div className="tnum text-ink-2">
                          {def.label}: {fmtMetric(p.metric_mean, def, lang)}
                        </div>
                        <div className="tnum text-ink-2">
                          {t('exp.meanCost')}: {fmtCost(p.mean_cost_usd)}
                        </div>
                      </>
                    ),
                  })
                }
                onMouseLeave={() => setTip(null)}
              >
                <circle cx={X(p.mean_cost_usd)} cy={Y(p.metric_mean)} r={12} fill="transparent" />
                <circle cx={X(p.mean_cost_usd)} cy={Y(p.metric_mean)} r={4.5} fill={COND_COLOR[c]} stroke="var(--surface)" strokeWidth={2} />
                <text x={X(p.mean_cost_usd)} y={Y(p.metric_mean) + 16} textAnchor="middle" fontSize={9} fill="var(--ink-3)">
                  {p.budget_preset[0].toUpperCase()}
                </text>
              </g>
            ))}
            {last && (
              <text x={X(last.mean_cost_usd) + 8} y={Y(last.metric_mean) + 4} fontSize={11} fontWeight={500} fill="var(--ink)">
                {t(`cond.${c}`)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
    </div>
  );
}
