/** 声明视图：按证据状态筛选，展示独立来源数、时间适用性、修订历史与关联证据 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, CalendarClock, ChevronDown, History, Users } from 'lucide-react';
import type { Claim, Verdict } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtDateRef } from '../../lib/format.ts';
import { Card, EmptyState, Segmented } from '../../components/ui.tsx';
import { VERDICT_META, VerdictBadge } from '../../components/badges.tsx';
import { stageLabel } from '../../lib/stages.ts';
import { useRun } from './context.tsx';
import { EvidenceCard } from './EvidenceCard.tsx';

const VERDICTS: Verdict[] = ['supported', 'conflicting', 'contradicted', 'insufficient'];

function VerdictBar({ claims }: { claims: Claim[] }) {
  const { t } = useI18n();
  const total = claims.length || 1;
  return (
    <div>
      <div className="flex h-2 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="verdict distribution">
        {VERDICTS.map((v) => {
          const n = claims.filter((c) => c.verdict === v).length;
          return n ? <div key={v} style={{ width: `${(n / total) * 100}%`, background: VERDICT_META[v].color }} title={`${t(`verdict.${v}`)}: ${n}`} /> : null;
        })}
      </div>
    </div>
  );
}

function ClaimCard({ c, focused }: { c: Claim; focused: boolean }) {
  const { t, lang } = useI18n();
  const { evidence, run } = useRun();
  const [open, setOpen] = useState(focused);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) {
      setOpen(true);
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focused]);
  const qLabels = c.question_ids.map((id) => run.task?.questions.findIndex((q) => q.id === id)).filter((i) => i != null && i >= 0) as number[];

  return (
    <div ref={ref} className={clsx('scroll-mt-4 px-5 py-4 transition-colors', focused && 'bg-accent-soft/40')}>
      <div className="flex items-start gap-3">
        <VerdictBadge verdict={c.verdict} compact className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] leading-relaxed font-medium">{c.text}</div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
            {c.event_date && (
              <span className="tnum inline-flex items-center gap-1">
                <CalendarClock className="size-3.5 text-ink-3" />
                {fmtDateRef(c.event_date, lang)}
              </span>
            )}
            {c.stage && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium">{stageLabel(c.stage, lang)}</span>}
            <span className="inline-flex items-center gap-1" title={t('claims.independentTitle')}>
              <Users className="size-3.5 text-ink-3" />
              {t('claims.independent', { n: c.independent_sources })}
            </span>
            <span className={clsx(c.applicable_at_cutoff === false && 'text-serious-text', c.applicable_at_cutoff == null && 'text-ink-3')}>
              {c.applicable_at_cutoff === true ? t('claims.applicable') : c.applicable_at_cutoff === false ? t('claims.notApplicable') : t('claims.applicableUnknown')}
            </span>
            {qLabels.length > 0 && <span className="text-ink-3">{qLabels.map((i) => `Q${i + 1}`).join(' · ')}</span>}
            {c.history.length > 0 && (
              <span className="inline-flex items-center gap-1 text-accent-text">
                <History className="size-3.5" />
                {t('claims.revised')}
              </span>
            )}
          </div>
          {/* 已支持的声明理由只是「N 个独立来源提供支持」，与上方来源数重复，不再显示 */}
          {c.rationale && (c.verdict !== 'supported' || c.history.length > 0) && <p className="mt-2 text-sm text-ink-2">{c.rationale}</p>}

          {c.history.length > 0 && (
            <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2">
              <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{t('claims.history')}</div>
              <ol className="flex flex-wrap items-center gap-1.5 text-xs">
                {c.history.map((h, i) => (
                  <li key={i} className="flex items-center gap-1.5" title={h.reason}>
                    <VerdictBadge verdict={h.verdict} />
                    <span className="text-ink-3">{t('common.round', { n: h.round })}</span>
                    <ArrowRight className="size-3 text-ink-3" />
                  </li>
                ))}
                <li className="flex items-center gap-1.5">
                  <VerdictBadge verdict={c.verdict} />
                  <span className="text-ink-3">{t('common.round', { n: c.updated_round })}</span>
                </li>
              </ol>
              {c.history[c.history.length - 1]?.reason && <div className="mt-1.5 text-xs text-ink-2">{c.history[c.history.length - 1].reason}</div>}
            </div>
          )}

          <button onClick={() => setOpen((o) => !o)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-accent-text">
            <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} />
            {t('claims.evidence')} ({c.links.length})
          </button>
          {open && (
            <div className="mt-2 flex flex-col gap-2">
              {c.links.map((l) => {
                const ev = evidence(l.evidence_id);
                return ev ? <EvidenceCard key={l.evidence_id} evidence={ev} relation={l.relation} note={l.note} /> : null;
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ClaimsView() {
  const { t } = useI18n();
  const { run, focus } = useRun();
  const [filter, setFilter] = useState<Verdict | 'all'>('all');
  const [sort, setSort] = useState<'round' | 'date'>('date');
  const claims = useMemo(() => {
    const list = run.claims.filter((c) => filter === 'all' || c.verdict === filter);
    return [...list].sort((a, b) =>
      sort === 'round'
        ? b.updated_round - a.updated_round
        : (a.event_date?.start ?? '9999') < (b.event_date?.start ?? '9999')
          ? -1
          : 1,
    );
  }, [run.claims, filter, sort]);

  if (!run.claims.length)
    return (
      <Card>
        <EmptyState title={t('claims.empty')} />
      </Card>
    );

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <VerdictBar claims={run.claims} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1">
            {(['all', ...VERDICTS] as const).map((v) => {
              const n = v === 'all' ? run.claims.length : run.claims.filter((c) => c.verdict === v).length;
              return (
                <button
                  key={v}
                  onClick={() => setFilter(v)}
                  disabled={n === 0}
                  className={clsx('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors disabled:opacity-40', filter === v ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-surface-2')}
                >
                  {v !== 'all' && <span className="size-2 rounded-full" style={{ background: VERDICT_META[v].color }} />}
                  {v === 'all' ? t('common.all') : t(`verdict.${v}`)}
                  <span className="tnum opacity-70">{n}</span>
                </button>
              );
            })}
          </div>
          <Segmented
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'date', label: t('claims.sortDate') },
              { value: 'round', label: t('claims.sortRound') },
            ]}
          />
        </div>
      </Card>
      <Card padded={false} className="divide-y divide-line overflow-hidden">
        {claims.map((c) => (
          <ClaimCard key={c.id} c={c} focused={focus?.kind === 'claim' && focus.id === c.id} />
        ))}
      </Card>
    </div>
  );
}
