/** 运行详情左栏：预算消耗与活动日志 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertOctagon,
  CheckCircle2,
  FileText,
  Flag,
  GitBranch,
  ListChecks,
  MessageCircleQuestion,
  PenLine,
  Play,
  Search,
  ShieldAlert,
  Waypoints,
} from 'lucide-react';
import type { RunEvent } from '../../api/types.ts';
import { useI18n, type TFn } from '../../i18n/index.tsx';
import { fmtCompact, fmtCost, fmtDuration } from '../../lib/format.ts';
import { Meter, Segmented } from '../../components/ui.tsx';
import { useRun } from './context.tsx';

export function BudgetPanel() {
  const { t, lang } = useI18n();
  const { run } = useRun();
  const u = run.usage;
  const b = run.budget;
  const tools = u.search_calls + u.read_calls;
  const tokens = u.input_tokens + u.output_tokens;
  // 研究循环每一项最多用到 (1 - 预留比例)，剩余部分留给写作与审查；研究轮数不受预留限制
  const research = 1 - b.reserve_ratio;
  const markTitle = t('budget.reserveMark', { p: Math.round(b.reserve_ratio * 100) });
  return (
    <div className="flex flex-col gap-3">
      <Meter label={t('budget.rounds')} value={u.research_rounds} max={b.max_research_rounds} display={`${u.research_rounds} / ${b.max_research_rounds}`} />
      <Meter label={t('budget.toolCalls')} value={tools} max={b.max_tool_calls} display={`${tools} / ${b.max_tool_calls}`} mark={research} markTitle={markTitle} />
      <Meter label={t('budget.tokens')} value={tokens} max={b.max_llm_tokens} display={`${fmtCompact(tokens, lang)} / ${fmtCompact(b.max_llm_tokens, lang)}`} mark={research} markTitle={markTitle} />
      <Meter label={t('budget.seconds')} value={u.elapsed_seconds} max={b.max_seconds} display={`${fmtDuration(u.elapsed_seconds)} / ${fmtDuration(b.max_seconds)}`} mark={research} markTitle={markTitle} />
      <Meter label={t('budget.cost')} value={u.cost_usd} max={b.max_cost_usd} display={`${fmtCost(u.cost_usd)} / ${b.max_cost_usd != null ? fmtCost(b.max_cost_usd) : t('budget.unlimited')}`} mark={research} markTitle={markTitle} />
      <div className="tnum flex flex-col gap-1 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-3">
        <span>{t('budget.callsSummary', { search: u.search_calls, read: u.read_calls, llm: u.llm_calls })}</span>
        <span className="flex items-start gap-1.5">
          <span className="mt-[3px] h-2.5 w-[2px] shrink-0 rounded-full bg-ink-2" aria-hidden />
          {t('budget.reserveLegend', { p: Math.round(b.reserve_ratio * 100) })}
        </span>
      </div>
    </div>
  );
}

const KEY_TYPES = new Set<RunEvent['type']>([
  'task.assessed',
  'clarification.requested',
  'clarification.answered',
  'plan.created',
  'claim.upserted',
  'gap.upserted',
  'decision.made',
  'report.updated',
  'review.completed',
  'run.finished',
  'run.error',
  'log',
]);

function describe(ev: RunEvent, t: TFn): { icon: React.ReactNode; text: string; tone?: 'muted' | 'warn' | 'error' | 'good' } | null {
  const ic = 'size-3.5';
  switch (ev.type) {
    case 'step.started':
      return { icon: <Play className={ic} />, text: t('activity.step.started', { step: t(`phase.${ev.data.step}`) }), tone: 'muted' };
    case 'step.completed':
      return null;
    case 'task.assessed':
      return { icon: <ListChecks className={ic} />, text: t('activity.task.assessed', { name: ev.data.event_name }) };
    case 'clarification.requested':
      return { icon: <MessageCircleQuestion className={ic} />, text: t('activity.clarification.requested'), tone: 'warn' };
    case 'clarification.answered':
      return { icon: <MessageCircleQuestion className={ic} />, text: t('activity.clarification.answered') };
    case 'plan.created':
      return { icon: <Waypoints className={ic} />, text: t('activity.plan.created', { n: ev.data.round, count: ev.data.action_ids.length }) };
    case 'tool.called':
      return { icon: <Search className={ic} />, text: t('activity.tool.called', { tool: ev.data.tool, input: ev.data.input }), tone: ev.data.ok ? 'muted' : 'error' };
    case 'document.added':
      return { icon: <FileText className={ic} />, text: t('activity.document.added', { title: ev.data.title }), tone: 'muted' };
    case 'claim.upserted':
      return { icon: <CheckCircle2 className={ic} />, text: t('activity.claim.upserted', { verdict: t(`verdict.${ev.data.verdict}`), text: ev.data.text }), tone: ev.data.verdict === 'supported' ? undefined : 'warn' };
    case 'gap.upserted':
      return { icon: <ShieldAlert className={ic} />, text: t('activity.gap.upserted', { status: t(`gapStatus.${ev.data.status}`), type: t(`gap.${ev.data.type}`) }), tone: ev.data.status === 'resolved' ? 'good' : undefined };
    case 'decision.made':
      return { icon: <GitBranch className={ic} />, text: `${t('activity.decision.made', { kind: t(`decision.${ev.data.kind}`) })} — ${ev.data.reason}` };
    case 'report.updated':
      return { icon: <PenLine className={ic} />, text: t('activity.report.updated', { n: ev.data.version }) };
    case 'review.completed':
      return { icon: <ListChecks className={ic} />, text: t('activity.review.completed', { n: ev.data.round, result: ev.data.passed ? t('report.reviewPassed') : t('report.reviewFailed') }), tone: ev.data.passed ? 'good' : 'warn' };
    case 'run.finished':
      return { icon: <Flag className={ic} />, text: t('activity.run.finished', { status: t(`status.${ev.data.status}`) }), tone: ev.data.status === 'completed' ? 'good' : 'warn' };
    case 'run.error':
      return { icon: <AlertOctagon className={ic} />, text: t('activity.run.error', { message: ev.data.message }), tone: 'error' };
    case 'timeline.removed':
      return { icon: <GitBranch className={ic} />, text: t('activity.timeline.removed'), tone: 'muted' };
    case 'log':
      return { icon: <span className="size-1.5 rounded-full bg-current" />, text: ev.data.message, tone: ev.data.level === 'warning' ? 'warn' : ev.data.level === 'error' ? 'error' : 'muted' };
    default:
      return null;
  }
}

export function ActivityFeed() {
  const { t } = useI18n();
  const { events } = useRun();
  const [filter, setFilter] = useState<'key' | 'all'>('key');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const rows = useMemo(() => {
    const out: { ev: RunEvent; d: NonNullable<ReturnType<typeof describe>> }[] = [];
    for (const ev of events) {
      if (filter === 'key' && !KEY_TYPES.has(ev.type)) continue;
      const d = describe(ev, t);
      if (d) out.push({ ev, d });
    }
    return out;
  }, [events, filter, t]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">{t('run.activity')}</h3>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'key', label: t('run.activityFilterKey') },
            { value: 'all', label: t('run.activityFilterAll') },
          ]}
        />
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[360px] overflow-y-auto rounded-lg border border-line bg-surface-2/50"
      >
        {!rows.length ? (
          <div className="px-3 py-6 text-center text-xs text-ink-3">{t('run.activityEmpty')}</div>
        ) : (
          <ol className="divide-y divide-line">
            {rows.map(({ ev, d }) => (
              <li key={ev.seq} className="flex gap-2 px-2.5 py-1.5 text-xs">
                <span className="tnum w-[52px] shrink-0 pt-px text-[11px] text-ink-3">{ev.ts.slice(11, 19)}</span>
                <span
                  className={clsx(
                    'mt-0.5 flex size-3.5 shrink-0 items-center justify-center',
                    d.tone === 'error' ? 'text-critical-text' : d.tone === 'warn' ? 'text-serious-text' : d.tone === 'good' ? 'text-good-text' : d.tone === 'muted' ? 'text-ink-3' : 'text-accent-text',
                  )}
                >
                  {d.icon}
                </span>
                <span className={clsx('min-w-0 break-words', d.tone === 'muted' ? 'text-ink-2' : 'text-ink')}>{d.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
