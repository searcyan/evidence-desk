/**
 * 过程视图：先给出整体流程（理解任务 → 各轮检索核实 → 各版报告审查 → 结果），
 * 每个步骤是一张摘要卡片，点击后在右侧抽屉查看细节；下方是子问题与证据缺口的概况。
 */
import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CheckCircle2, ChevronRight, CircleDashed, Flag, GitBranch, ListChecks, Loader2, Search, ShieldCheck, XCircle } from 'lucide-react';
import type { ActionStatus, Decision, Gap, GapType, ResearchAction, ReviewResult, SubQuestion, TimeWindow } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtCost, fmtDate, fmtDuration, fmtPct, runDuration } from '../../lib/format.ts';
import { isTerminal } from '../../lib/fold.ts';
import { Badge, Card, Drawer, EmptyState, Segmented } from '../../components/ui.tsx';
import { ActionTypeTag, GapTypeTag, StatusBadge } from '../../components/badges.tsx';
import { stageLabel } from '../../lib/stages.ts';
import { useRun } from './context.tsx';

type Detail = { kind: 'task' } | { kind: 'round'; round: number } | { kind: 'review'; round: number } | { kind: 'result' } | { kind: 'gaps' };

function QuestionStatus({ q }: { q: SubQuestion }) {
  const { t } = useI18n();
  const tone = q.status === 'answered' ? 'good' : q.status === 'partial' ? 'warn' : q.status === 'unanswerable' ? 'critical' : 'neutral';
  return <Badge tone={tone}>{t(`question.status.${q.status}`)}</Badge>;
}

/* ───────────── 整体流程 ───────────── */

function Node({ step, label, icon, title, meta, chip, state, onClick }: { step: number; label: string; icon: ReactNode; title: ReactNode; meta?: ReactNode; chip?: ReactNode; state: 'done' | 'active' | 'warn'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'group relative flex min-w-0 flex-col gap-1.5 rounded-xl border bg-surface p-3 text-left transition-all hover:-translate-y-px hover:shadow-card',
        state === 'active' ? 'border-accent ring-2 ring-accent/15' : state === 'warn' ? 'border-serious/40' : 'border-line hover:border-line-strong',
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="tnum flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] text-ink-2">{step}</span>
          {icon}
          <span className="truncate">{label}</span>
        </span>
        <ChevronRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="line-clamp-2 text-[13px] leading-snug font-medium text-ink">{title}</div>
      {meta && <div className="tnum text-xs text-ink-3">{meta}</div>}
      {chip && <div className="mt-auto pt-1">{chip}</div>}
    </button>
  );
}

function DecisionChip({ d }: { d: Decision | undefined }) {
  const { t } = useI18n();
  if (!d) return null;
  const stop = d.kind === 'write_report' || d.kind === 'finish';
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', stop ? 'bg-good-soft text-good-text' : 'bg-accent-soft text-accent-text')}>
      <GitBranch className="size-3" />
      {t(`decision.${d.kind}`)}
    </span>
  );
}

function Journey({ onOpen }: { onOpen: (d: Detail) => void }) {
  const { t } = useI18n();
  const { run } = useRun();
  const terminal = isTerminal(run.status);
  const researching = !terminal && !!run.phase && ['plan', 'collect', 'verify', 'update'].includes(run.phase);
  const reporting = !terminal && (run.phase === 'write' || run.phase === 'review');
  const task = run.task;
  const answered = task?.questions.filter((q) => q.status === 'answered').length ?? 0;

  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(172px,1fr))] gap-2.5">
          <Node
            step={1}
            label={t('phase.assess')}
            icon={<ListChecks className="size-3.5" />}
            title={task?.event_name ?? t('process.node.assessing')}
            meta={task ? t('process.node.questions', { n: task.questions.length, a: answered }) : undefined}
            state={task ? 'done' : 'active'}
            onClick={() => onOpen({ kind: 'task' })}
          />
        {run.plans.length > 0 && (
          <>
              {run.plans.map((p) => {
                const actions = run.actions.filter((a) => a.round === p.round);
                const docs = actions.reduce((n, a) => n + (a.result?.documents_added ?? 0), 0);
                const claims = run.claims.filter((c) => c.first_round === p.round).length;
                const decision = run.decisions.find((d) => d.round === p.round && (d.kind === 'continue_research' || d.kind === 'write_report'));
                const active = researching && p.round === run.research_round;
                return (
                  <Node
                    key={p.round}
                    step={1 + p.round}
                    label={t('common.round', { n: p.round })}
                    icon={active ? <Loader2 className="size-3.5 animate-spin text-accent-text" /> : <Search className="size-3.5" />}
                    title={p.rationale}
                    meta={t('process.node.found', { actions: actions.length, docs, claims })}
                    chip={<DecisionChip d={decision} />}
                    state={active ? 'active' : 'done'}
                    onClick={() => onOpen({ kind: 'round', round: p.round })}
                  />
                );
              })}
          </>
        )}
        {(run.reviews.length > 0 || reporting) && (
          <>
              {run.reviews.map((rv) => {
                const issues = rv.findings.filter((f) => f.severity !== 'low').length;
                const decision = run.decisions.find((d) => d.round === rv.round && (d.kind === 'reverify' || d.kind === 'repair_report' || d.kind === 'finish'));
                return (
                  <Node
                    key={rv.round}
                    step={1 + run.plans.length + rv.round}
                    label={t('process.node.review', { n: rv.round })}
                    icon={rv.passed ? <ShieldCheck className="size-3.5 text-good-text" /> : <ShieldCheck className="size-3.5 text-serious-text" />}
                    title={rv.passed ? t('process.node.passed') : t('process.node.findings', { n: issues })}
                    meta={rv.findings.length > issues ? t('process.node.lowFindings', { n: rv.findings.length - issues }) : undefined}
                    chip={<DecisionChip d={decision} />}
                    state={rv.passed ? 'done' : 'warn'}
                    onClick={() => onOpen({ kind: 'review', round: rv.round })}
                  />
                );
              })}
              {reporting && (
                <Node
                  step={2 + run.plans.length + run.reviews.length}
                  label={t(`phase.${run.phase!}`)}
                  icon={<Loader2 className="size-3.5 animate-spin text-accent-text" />}
                  title={t('process.node.writing')}
                  state="active"
                  onClick={() => onOpen({ kind: 'result' })}
                />
              )}
          </>
        )}
        {terminal && (
          <>
              <Node
                step={2 + run.plans.length + run.reviews.length}
                label={t('process.stage.result')}
                icon={<Flag className="size-3.5" />}
                title={<StatusBadge status={run.status} />}
                meta={`${fmtDuration(runDuration(run))} · ${fmtCost(run.usage.cost_usd)}`}
                chip={run.stop_reason ? <span className="text-[11px] text-ink-3">{t(`stop.${run.stop_reason}`)}</span> : undefined}
                state={run.status === 'completed' ? 'done' : 'warn'}
                onClick={() => onOpen({ kind: 'result' })}
              />
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────── 概况卡片 ───────────── */

function QuestionsPanel({ onOpen }: { onOpen: (d: Detail) => void }) {
  const { t } = useI18n();
  const { run } = useRun();
  const qs = run.task?.questions ?? [];
  const answered = qs.filter((q) => q.status === 'answered').length;
  return (
    <Card padded={false}>
      <PanelHead title={t('process.subquestions')} right={qs.length ? t('process.answeredOf', { a: answered, n: qs.length }) : undefined} onMore={() => onOpen({ kind: 'task' })} />
      {qs.length ? (
        <ol className="divide-y divide-line">
          {qs.map((q, i) => (
            <li key={q.id} className="flex items-start gap-3 px-5 py-2.5">
              <span className="tnum pt-0.5 text-xs font-semibold text-ink-3">Q{i + 1}</span>
              <div className="min-w-0 flex-1 text-sm leading-relaxed">
                {q.text}
                {q.priority === 'core' && <span className="ml-1.5 text-[11px] font-semibold text-accent-text">{t('question.priority.core')}</span>}
              </div>
              <QuestionStatus q={q} />
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title={t('process.noRounds')} />
      )}
    </Card>
  );
}

function GapsPanel({ onOpen }: { onOpen: (d: Detail) => void }) {
  const { t } = useI18n();
  const { run } = useRun();
  const byType = useMemo(() => {
    const m = new Map<GapType, { open: number; total: number }>();
    for (const g of run.gaps) {
      const v = m.get(g.type) ?? { open: 0, total: 0 };
      v.total += 1;
      if (g.status === 'open' || g.status === 'in_progress') v.open += 1;
      m.set(g.type, v);
    }
    return [...m.entries()].sort((a, b) => b[1].open - a[1].open);
  }, [run.gaps]);
  const resolved = run.gaps.filter((g) => g.status === 'resolved').length;
  return (
    <Card padded={false}>
      <PanelHead title={t('process.gaps')} right={t('process.gapsSummary', { open: run.counts.open_gaps, resolved })} onMore={run.gaps.length ? () => onOpen({ kind: 'gaps' }) : undefined} />
      {byType.length ? (
        <ul className="flex flex-col gap-2.5 px-5 pb-4">
          {byType.map(([type, v]) => (
            <li key={type} className="flex items-center gap-3 text-sm">
              <span className="w-[128px] shrink-0">
                <GapTypeTag type={type} />
              </span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
                <span className="block h-full rounded-full bg-serious/70" style={{ width: `${(v.open / v.total) * 100}%` }} />
              </span>
              <span className="tnum w-[52px] shrink-0 text-right text-xs text-ink-2">
                {v.open} / {v.total}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('process.gapsEmpty')} />
      )}
    </Card>
  );
}

function PanelHead({ title, right, onMore }: { title: string; right?: string; onMore?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
      <h3 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">{title}</h3>
      <div className="flex items-center gap-3 text-xs text-ink-3">
        {right && <span className="tnum">{right}</span>}
        {onMore && (
          <button type="button" onClick={onMore} className="inline-flex items-center gap-0.5 font-medium text-accent-text hover:underline">
            {t('process.details')}
            <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ───────────── 抽屉中的细节 ───────────── */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <h4 className="mb-2 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">{title}</h4>
      {children}
    </section>
  );
}

function TaskDetail() {
  const { t, lang } = useI18n();
  const { run } = useRun();
  const task = run.task;
  if (!task) return <EmptyState title={t('process.node.assessing')} />;
  return (
    <>
      <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-ink-3">{t('process.eventType')}</dt>
          <dd>{t(`eventType.${task.event_type}`)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">{t('process.window')}</dt>
          <dd className="tnum">
            {fmtDate(task.initial_window.start, lang)} – {fmtDate(task.initial_window.end, lang)}
          </dd>
        </div>
      </dl>
      <Section title={t('process.subquestions')}>
        <ol className="flex flex-col gap-2">
          {task.questions.map((q, i) => (
            <li key={q.id} className="flex items-start gap-3 rounded-lg border border-line px-3 py-2">
              <span className="tnum pt-0.5 text-xs font-semibold text-ink-3">Q{i + 1}</span>
              <div className="min-w-0 flex-1 text-sm">{q.text}</div>
              <QuestionStatus q={q} />
            </li>
          ))}
        </ol>
      </Section>
      {task.entities.length > 0 && (
        <Section title={t('process.entities')}>
          <div className="flex flex-wrap gap-1.5">
            {task.entities.map((e) => (
              <span key={e} className="rounded-md bg-surface-3 px-2 py-0.5 text-xs">
                {e}
              </span>
            ))}
          </div>
        </Section>
      )}
      {task.stage_model.length > 0 && (
        <Section title={t('process.stageModel')}>
          <div className="flex flex-wrap items-center gap-1 text-sm text-ink-2">
            {task.stage_model.map((s, i) => (
              <span key={s}>
                {stageLabel(s, lang)}
                {i < task.stage_model.length - 1 && <span className="mx-1.5 text-ink-3">→</span>}
              </span>
            ))}
          </div>
        </Section>
      )}
      {task.assumptions.length > 0 && (
        <Section title={t('process.assumptions')}>
          <ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">
            {task.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

const STATUS_ICON: Record<ActionStatus, ReactNode> = {
  planned: <CircleDashed className="size-4 text-ink-3" />,
  running: <Loader2 className="size-4 animate-spin text-accent-text" />,
  done: <CheckCircle2 className="size-4 text-good-text" />,
  skipped: <CircleDashed className="size-4 text-ink-3" />,
  failed: <XCircle className="size-4 text-critical-text" />,
};

function ActionRow({ a }: { a: ResearchAction }) {
  const { t, lang } = useI18n();
  const { run } = useRun();
  const calls = run.tool_calls.filter((c) => c.action_id === a.id);
  const gap = a.gap_id ? run.gaps.find((g) => g.id === a.gap_id) : null;
  return (
    <li className="flex gap-3 py-2.5">
      <span className="pt-0.5" title={t(`actionStatus.${a.status}`)}>
        {STATUS_ICON[a.status]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <ActionTypeTag type={a.type} />
          <span className="text-sm">{a.rationale}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-3">
          {a.params.query && <span className="font-mono text-ink-2">“{a.params.query}”</span>}
          {a.params.window && (
            <span className="tnum">
              {fmtDate(a.params.window.start, lang)} – {fmtDate(a.params.window.end, lang)}
            </span>
          )}
          {a.params.date && <span className="tnum">@ {fmtDate(a.params.date, lang)}</span>}
          {gap && (
            <span>
              → <GapTypeTag type={gap.type} />
            </span>
          )}
        </div>
        {a.result && (
          <div className="tnum mt-1 text-xs text-ink-2">
            {t('process.result', { docs: a.result.documents_added, ev: a.result.evidence_added, dup: a.result.duplicates })}
            {a.result.note && <span className="text-ink-3"> — {a.result.note}</span>}
          </div>
        )}
      </div>
      {calls.length > 0 && <span className="tnum shrink-0 text-xs text-ink-3">{t('process.calls', { n: calls.length })}</span>}
    </li>
  );
}

function WindowStrip({ windows, extent, cutoff }: { windows: TimeWindow[]; extent: [number, number]; cutoff: string }) {
  const { t } = useI18n();
  const [a, b] = extent;
  const x = (d: string) => ((new Date(`${d.slice(0, 10)}T00:00:00Z`).getTime() - a) / (b - a)) * 100;
  return (
    <div className="relative h-5 rounded bg-surface-3" title={t('process.windowTitle')}>
      {windows.map((w, i) => (
        <div key={i} className="absolute inset-y-1 rounded-sm bg-accent/70" style={{ left: `${x(w.start)}%`, width: `${Math.max(x(w.end) - x(w.start), 0.8)}%` }} />
      ))}
      <div className="absolute inset-y-0 w-[2px] bg-ink-2" style={{ left: `${x(cutoff)}%` }} />
    </div>
  );
}

function DecisionCard({ d }: { d: Decision }) {
  const { t } = useI18n();
  const s = d.signals;
  const stop = d.kind === 'write_report' || d.kind === 'finish';
  return (
    <div className={clsx('rounded-lg border px-3 py-2.5', stop ? 'border-good/40 bg-good-soft/40' : 'border-accent/30 bg-accent-soft/40')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <GitBranch className="size-4 text-ink-2" />
        <span className="font-semibold">{t(`decision.${d.kind}`)}</span>
        {d.stop_reason && <Badge tone="outline">{t(`stop.${d.stop_reason}`)}</Badge>}
      </div>
      <div className="mt-1 text-sm text-ink-2">{d.reason}</div>
      <dl className="tnum mt-2 grid grid-cols-3 gap-2 text-xs">
        {(
          [
            ['core_coverage', fmtPct(s.core_coverage)],
            ['open_high_gaps', s.open_high_gaps],
            ['new_independent_evidence', s.new_independent_evidence],
            ['new_milestones', s.new_milestones],
            ['budget_remaining_ratio', fmtPct(s.budget_remaining_ratio)],
            ['no_progress_rounds', s.no_progress_rounds],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="truncate text-ink-3">{t(`process.signals.${k}`)}</dt>
            <dd className="font-semibold text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RoundDetail({ round }: { round: number }) {
  const { t } = useI18n();
  const { run } = useRun();
  const p = run.plans.find((x) => x.round === round);
  const extent = useMemo<[number, number]>(() => {
    const ds = [run.request.cutoff, ...run.plans.flatMap((x) => x.windows.flatMap((w) => [w.start, w.end])), ...(run.task ? [run.task.initial_window.start] : [])].map((d) => new Date(`${d.slice(0, 10)}T00:00:00Z`).getTime());
    const min = Math.min(...ds);
    const max = Math.max(...ds);
    const pad = (max - min) * 0.04 || 86400000 * 7;
    return [min - pad, max + pad];
  }, [run.plans, run.request.cutoff, run.task]);
  if (!p) return null;
  const actions = p.action_ids.map((id) => run.actions.find((a) => a.id === id)).filter((a): a is ResearchAction => !!a);
  const decision = run.decisions.find((d) => d.round === p.round && (d.kind === 'continue_research' || d.kind === 'write_report'));
  return (
    <>
      <p className="mb-5 text-sm text-ink-2">{p.rationale}</p>
      <Section title={t('process.strategy')}>
        <p className="text-sm text-ink-2">{p.source_strategy}</p>
      </Section>
      <Section title={t('process.windows')}>
        <WindowStrip windows={p.windows} extent={extent} cutoff={run.request.cutoff} />
      </Section>
      <Section title={t('process.actions')}>
        <ul className="divide-y divide-line">
          {actions.map((a) => (
            <ActionRow key={a.id} a={a} />
          ))}
        </ul>
      </Section>
      {decision && (
        <Section title={t('process.decision')}>
          <DecisionCard d={decision} />
        </Section>
      )}
    </>
  );
}

function ReviewDetail({ rv }: { rv: ReviewResult }) {
  const { t } = useI18n();
  const { run } = useRun();
  const decision = run.decisions.find((d) => d.round === rv.round && (d.kind === 'reverify' || d.kind === 'repair_report' || d.kind === 'finish'));
  const order = { high: 0, medium: 1, low: 2 };
  const findings = [...rv.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <>
      <Section title={t('process.findings')}>
        {findings.length === 0 ? (
          <div className="text-sm text-ink-3">{t('report.noFindings')}</div>
        ) : (
          <ul className="flex flex-col gap-3">
            {findings.map((f) => (
              <li key={f.id} className="flex items-start gap-2.5 text-[13px]">
                <Badge tone={f.severity === 'high' ? 'critical' : f.severity === 'medium' ? 'serious' : 'neutral'}>{t(`report.severity.${f.severity}`)}</Badge>
                <span className="min-w-0 flex-1 pt-0.5 leading-relaxed">
                  <span className="font-medium">{t(`report.finding.${f.type}`)}</span> <span className="text-ink-2">{f.description}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {decision && (
        <Section title={t('process.decision')}>
          <DecisionCard d={decision} />
        </Section>
      )}
    </>
  );
}

function ResultDetail() {
  const { t } = useI18n();
  const { run } = useRun();
  const finals = run.decisions.filter((d) => d.kind === 'write_report' || d.kind === 'finish');
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <StatusBadge status={run.status} />
        {run.stop_reason && <span className="text-ink-2">{t(`stop.${run.stop_reason}`)}</span>}
        <span className="tnum text-ink-3">
          {fmtDuration(runDuration(run))} · {fmtCost(run.usage.cost_usd)}
        </span>
      </div>
      {finals.map((d) => (
        <div key={d.id} className="mb-3">
          <DecisionCard d={d} />
        </div>
      ))}
    </>
  );
}

function GapRow({ g }: { g: Gap }) {
  const { t } = useI18n();
  const tone = g.status === 'resolved' ? 'good' : g.status === 'abandoned' ? 'neutral' : g.status === 'in_progress' ? 'accent' : 'warn';
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1 text-sm">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <GapTypeTag type={g.type} />
          <span className={clsx('text-[11px] font-semibold', g.priority === 'high' ? 'text-critical-text' : g.priority === 'medium' ? 'text-serious-text' : 'text-ink-3')}>{t(`report.severity.${g.priority}`)}</span>
          <span className="tnum text-[11px] text-ink-3">
            R{g.opened_round}
            {g.closed_round != null && ` → R${g.closed_round}`}
          </span>
        </div>
        {g.claim_ids.length > 0 ? (
          // 声明类缺口的描述就是声明原文：标明是"相关声明"，避免被误读为对结论的质疑
          <div className="leading-relaxed text-ink-2">
            <span className="mr-1.5 text-xs text-ink-3">{t('gap.relatedClaim')}</span>
            {g.description}
          </div>
        ) : (
          <div className="leading-relaxed">{g.description}</div>
        )}
        {g.resolution && <div className="mt-1 text-xs text-ink-2">↳ {g.resolution}</div>}
      </div>
      <Badge tone={tone}>{t(`gapStatus.${g.status}`)}</Badge>
    </li>
  );
}

function GapsDetail() {
  const { t } = useI18n();
  const { run } = useRun();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const gaps = run.gaps.filter((g) => filter === 'all' || g.status === 'open' || g.status === 'in_progress');
  return (
    <>
      <Segmented
        size="sm"
        className="mb-3"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'open', label: t('gapStatus.open') },
          { value: 'all', label: t('common.all') },
        ]}
      />
      {gaps.length ? (
        <ul className="divide-y divide-line">
          {gaps.map((g) => (
            <GapRow key={g.id} g={g} />
          ))}
        </ul>
      ) : (
        <EmptyState title={t('process.gapsEmpty')} />
      )}
    </>
  );
}

export function ProcessView() {
  const { t } = useI18n();
  const { run } = useRun();
  const [detail, setDetail] = useState<Detail | null>(null);

  const title = (d: Detail): string => {
    switch (d.kind) {
      case 'task':
        return t('process.task');
      case 'round':
        return t('common.round', { n: d.round });
      case 'review':
        return t('process.node.review', { n: d.round });
      case 'result':
        return t('process.stage.result');
      case 'gaps':
        return t('process.gaps');
    }
  };
  const review = detail?.kind === 'review' ? run.reviews.find((r) => r.round === detail.round) : undefined;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">{t('process.journey')}</h3>
          <span className="text-xs text-ink-3">{t('process.clickHint')}</span>
        </div>
        <Journey onOpen={setDetail} />
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <QuestionsPanel onOpen={setDetail} />
        <GapsPanel onOpen={setDetail} />
      </div>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail ? title(detail) : ''} subtitle={detail?.kind === 'task' ? run.task?.event_name : undefined}>
        {detail?.kind === 'task' && <TaskDetail />}
        {detail?.kind === 'round' && <RoundDetail round={detail.round} />}
        {review && <ReviewDetail rv={review} />}
        {detail?.kind === 'result' && <ResultDetail />}
        {detail?.kind === 'gaps' && <GapsDetail />}
      </Drawer>
    </div>
  );
}
