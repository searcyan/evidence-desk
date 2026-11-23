/** 时间线视图：阶段进展 + 时间轴概览（同日事件合并为一个点，可点击定位）+ 按年份分组的纵向条目 */
import { Fragment, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Flag, Star } from 'lucide-react';
import type { DateRef, Lang, TimelineEntry } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtDateRef, fmtMonth } from '../../lib/format.ts';
import { stageLabel } from '../../lib/stages.ts';
import { Card, EmptyState } from '../../components/ui.tsx';
import { VERDICT_META, VerdictBadge } from '../../components/badges.tsx';
import { useRun } from './context.tsx';
import { useWidth } from '../../lib/useWidth.ts';
import { EvidenceCard } from './EvidenceCard.tsx';

const DAY = 86400000;
const ts = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).getTime();
const mid = (e: TimelineEntry) => (ts(e.date.start) + ts(e.date.end)) / 2;
const jump = (id: string) => document.getElementById(`tl-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

/** 条目左侧的日期：年份已作为分组标题，这里只显示月日 */
function shortDate(ref: DateRef, lang: Lang) {
  const d = new Date(`${ref.start}T00:00:00Z`);
  if (ref.precision === 'day') return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  if (ref.precision === 'month') return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', timeZone: 'UTC' }).format(d);
  if (ref.precision === 'year') return ref.start.slice(0, 4);
  return fmtDateRef(ref, lang);
}

function StageProgress() {
  const { t, lang } = useI18n();
  const { run } = useRun();
  const stages = run.task?.stage_model ?? [];
  if (!stages.length) return null;
  const reached = new Set(run.claims.filter((c) => c.verdict === 'supported' && c.stage && c.applicable_at_cutoff !== false).map((c) => c.stage!));
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <h3 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">{t('timeline.stages')}</h3>
      <ol className="flex flex-wrap items-center gap-y-2">
        {stages.map((s, i) => {
          const ok = reached.has(s);
          return (
            <li key={s} className="flex items-center">
              <span
                className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium', ok ? 'border-good/40 bg-good-soft text-good-text' : 'border-dashed border-line-strong text-ink-3')}
                title={ok ? t('timeline.stageReached') : t('timeline.stageMissing')}
              >
                <span className={clsx('size-1.5 rounded-full', ok ? 'bg-good' : 'bg-line-strong')} />
                {stageLabel(s, lang)}
              </span>
              {i < stages.length - 1 && <span className={clsx('mx-1 h-px w-5', ok && reached.has(stages[i + 1]) ? 'bg-good' : 'bg-line-strong')} />}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Overview({ entries, cutoff }: { entries: TimelineEntry[]; cutoff: string }) {
  const { t, lang } = useI18n();
  const [ref, W] = useWidth<HTMLDivElement>(700);
  const H = 76;
  const AXIS = 40;
  const pad = 20;
  const lo = Math.min(...entries.map((e) => ts(e.date.start)));
  const hi = Math.max(ts(cutoff), ...entries.map((e) => ts(e.date.end)));
  const raw = Math.max(hi - lo, 30 * DAY);
  // 两端各留 4% 余量，避免点贴边或与截止线重叠
  const min = lo - raw * 0.04;
  const max = hi + raw * 0.04;
  const span = max - min;
  const x = (d: number) => pad + ((d - min) / span) * (W - pad * 2);

  // 刻度：跨度短时按月、跨度长时按年，按可用宽度选择间隔，避免标签重叠
  const months = span / (30.4 * DAY);
  const maxTicks = Math.max(1, Math.floor((W - pad * 2) / (lang === 'zh' ? 84 : 64)));
  const stepMonths = [1, 2, 3, 6].find((m) => months / m <= maxTicks);
  const ticks: number[] = [];
  const s = new Date(min);
  if (stepMonths) {
    const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
    while (cur.getTime() <= max) {
      ticks.push(cur.getTime());
      cur.setUTCMonth(cur.getUTCMonth() + stepMonths);
    }
  } else {
    const yearTicks = Math.max(1, Math.floor((W - pad * 2) / 52));
    const stepYears = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((y) => months / 12 / y <= yearTicks) ?? 1000;
    for (let y = Math.ceil((s.getUTCFullYear() + 1) / stepYears) * stepYears; Date.UTC(y, 0, 1) <= max; y += stepYears) ticks.push(Date.UTC(y, 0, 1));
  }
  const tickLabel = (tk: number) => (stepMonths ? fmtMonth(new Date(tk).toISOString(), lang) : String(new Date(tk).getUTCFullYear()));

  // 相距不足 14px 的事件合并成一个点，点内显示数量
  const clusters = useMemo(() => {
    const sorted = [...entries].sort((a, b) => mid(a) - mid(b));
    const out: { x: number; items: TimelineEntry[] }[] = [];
    for (const e of sorted) {
      const px = pad + ((mid(e) - min) / span) * (W - pad * 2);
      const last = out[out.length - 1];
      if (last && px - last.x < 14) {
        last.items.push(e);
        last.x = (last.x * (last.items.length - 1) + px) / last.items.length;
      } else out.push({ x: px, items: [e] });
    }
    return out;
  }, [entries, min, span, W]);

  const cx = x(ts(cutoff));
  const nearRight = cx > W - 80;
  return (
    <Card padded={false} className="px-4 pt-2">
      <div ref={ref}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="timeline overview">
          <line x1={pad} x2={W - pad} y1={AXIS} y2={AXIS} stroke="var(--axis)" strokeWidth={1} />
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={x(tk)} x2={x(tk)} y1={AXIS - 3} y2={AXIS + 3} stroke="var(--axis)" />
              <text x={x(tk)} y={AXIS + 22} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
                {tickLabel(tk)}
              </text>
            </g>
          ))}
          {/* 精度不足一天的条目画成淡色区间 */}
          {entries
            .filter((e) => e.date.precision !== 'day')
            .map((e) => (
              <rect key={`r-${e.id}`} x={x(ts(e.date.start))} y={AXIS - 3} width={Math.max(x(ts(e.date.end)) - x(ts(e.date.start)), 4)} height={6} rx={3} fill={VERDICT_META[e.verdict].color} opacity={0.18} />
            ))}
          <line x1={cx} x2={cx} y1={18} y2={AXIS + 8} stroke="var(--ink-2)" strokeWidth={1.25} strokeDasharray="3 2" />
          <text x={cx} y={12} textAnchor={nearRight ? 'end' : 'middle'} dx={nearRight ? 4 : 0} fontSize={11} fill="var(--ink-2)" fontWeight={600}>
            {t('timeline.cutoff')}
          </text>
          {clusters.map((c) => {
            const n = c.items.length;
            const color = c.items.some((e) => e.verdict === 'conflicting') ? VERDICT_META.conflicting.color : VERDICT_META[c.items[0].verdict].color;
            return (
              <g key={c.items[0].id} className="cursor-pointer" onClick={() => jump(c.items[0].id)}>
                <title>{c.items.map((e) => `${fmtDateRef(e.date, lang)} — ${e.title}`).join('\n')}</title>
                <circle cx={c.x} cy={AXIS} r={n > 1 ? 8 : 5} fill={color} stroke="var(--surface)" strokeWidth={2} />
                {n > 1 && (
                  <text x={c.x} y={AXIS + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">
                    {n}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </Card>
  );
}

function Entry({ e, last }: { e: TimelineEntry; last: boolean }) {
  const { t, lang } = useI18n();
  const { claim, evidence, focus } = useRun();
  const [open, setOpen] = useState(false);
  const m = VERDICT_META[e.verdict];
  const claims = e.claim_ids.map(claim).filter(Boolean);
  const focused = focus?.kind === 'claim' && e.claim_ids.includes(focus.id);
  return (
    <li id={`tl-${e.id}`} className="relative grid scroll-mt-4 grid-cols-[76px_24px_minmax(0,1fr)] gap-x-3">
      <div className="pt-3.5 text-right">
        <div className="tnum text-[13px] font-semibold whitespace-nowrap">{shortDate(e.date, lang)}</div>
        {e.date.precision !== 'day' && <div className="text-[11px] text-ink-3">{t(`timeline.precision.${e.date.precision}`)}</div>}
      </div>
      <div className="relative flex justify-center">
        {!last && <div className="absolute top-6 bottom-0 w-px bg-line-strong" />}
        <span className="relative z-10 mt-3 flex size-6 items-center justify-center rounded-full border-2 border-surface" style={{ background: m.color }}>
          {e.is_milestone ? <Star className="size-3 fill-white text-white" /> : <m.Icon className="size-3.5 text-white" />}
        </span>
      </div>
      <div className={clsx('mb-3 rounded-xl border bg-surface px-4 py-3.5 shadow-card transition-colors', focused ? 'border-accent ring-2 ring-accent/20' : 'border-line')}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="leading-snug font-semibold">{e.title}</div>
            {e.summary && e.summary !== e.title && <div className="mt-1 text-sm leading-relaxed text-ink-2">{e.summary}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {e.stage && <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">{stageLabel(e.stage, lang)}</span>}
            <VerdictBadge verdict={e.verdict} compact />
          </div>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-accent-text">
          <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} />
          {t('timeline.claims', { n: claims.length })}
        </button>
        {open && (
          <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
            {claims.map((c) => (
              <div key={c!.id}>
                <div className="mb-1.5 flex items-start gap-2 text-sm">
                  <VerdictBadge verdict={c!.verdict} compact />
                  <span>{c!.text}</span>
                </div>
                <div className="flex flex-col gap-2 pl-7">
                  {c!.links.map((l) => {
                    const ev = evidence(l.evidence_id);
                    return ev ? <EvidenceCard key={l.evidence_id} evidence={ev} relation={l.relation} note={l.note} /> : null;
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** 年份分组标题（与条目共用三列网格，保持竖线连贯） */
function YearRow({ year }: { year: string }) {
  return (
    <li className="grid grid-cols-[76px_24px_minmax(0,1fr)] items-center gap-x-3 pt-2 pb-2">
      <div className="tnum text-right text-[15px] font-semibold text-ink">{year}</div>
      <div className="flex justify-center">
        <span className="size-2 rounded-full bg-ink-3" />
      </div>
      <span />
    </li>
  );
}

function EntryList({ items, lastIsEnd }: { items: TimelineEntry[]; lastIsEnd: boolean }) {
  return (
    <>
      {items.map((e, i) => {
        const year = e.date.start.slice(0, 4);
        const newYear = i === 0 || items[i - 1].date.start.slice(0, 4) !== year;
        return (
          <Fragment key={e.id}>
            {newYear && <YearRow year={year} />}
            <Entry e={e} last={lastIsEnd && i === items.length - 1} />
          </Fragment>
        );
      })}
    </>
  );
}

export function TimelineView() {
  const { t, lang } = useI18n();
  const { run } = useRun();
  const cutoff = run.request.cutoff;
  const entries = run.timeline;
  const { before, after } = useMemo(() => {
    const c = cutoff.slice(0, 10);
    return { before: entries.filter((e) => e.date.start <= c), after: entries.filter((e) => e.date.start > c) };
  }, [entries, cutoff]);

  return (
    <div className="flex flex-col gap-4">
      <StageProgress />
      {!entries.length ? (
        <Card>
          <EmptyState title={t('timeline.empty')} />
        </Card>
      ) : (
        <>
          <Overview entries={entries} cutoff={cutoff} />
          <ol className="mt-1">
            <EntryList items={before} lastIsEnd={!after.length} />
            <li className="mb-3 grid grid-cols-[76px_24px_minmax(0,1fr)] items-center gap-x-3">
              <div className="tnum text-right text-xs font-semibold whitespace-nowrap text-ink-2">{shortDate({ start: cutoff.slice(0, 10), end: cutoff.slice(0, 10), precision: 'day', text: '' }, lang)}</div>
              <div className="flex justify-center">
                <Flag className="size-4 text-ink-2" />
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-2 uppercase">
                {t('timeline.cutoff')}
                <span className="h-px flex-1 border-t border-dashed border-ink-3" />
              </div>
            </li>
            <EntryList items={after} lastIsEnd />
          </ol>
        </>
      )}
    </div>
  );
}
