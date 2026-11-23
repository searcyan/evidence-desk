/**
 * 工作流示意（对应提案 Figure 1）：7 个步骤 + 两个决策点，左侧为研究循环、右侧为审查循环。
 * 步骤状态来自事件流：进入过的步骤显示完成，当前步骤高亮，旁边标注进入次数。
 */
import { useMemo } from 'react';
import clsx from 'clsx';
import { Check, CircleDot } from 'lucide-react';
import type { Phase } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { isTerminal } from '../../lib/fold.ts';
import { useRun } from './context.tsx';

const STEP_H = 46;
const DEC_H = 30;
const GAP = 6;

type Row = { kind: 'step'; phase: Phase; n: number } | { kind: 'decision'; id: 'decide' | 'finish' };
const ROWS: Row[] = [
  { kind: 'step', phase: 'assess', n: 1 },
  { kind: 'step', phase: 'plan', n: 2 },
  { kind: 'step', phase: 'collect', n: 3 },
  { kind: 'step', phase: 'verify', n: 4 },
  { kind: 'step', phase: 'update', n: 5 },
  { kind: 'decision', id: 'decide' },
  { kind: 'step', phase: 'write', n: 6 },
  { kind: 'step', phase: 'review', n: 7 },
  { kind: 'decision', id: 'finish' },
];

function rowTops() {
  const tops: number[] = [];
  let y = 0;
  for (const r of ROWS) {
    tops.push(y);
    y += (r.kind === 'step' ? STEP_H : DEC_H) + GAP;
  }
  return { tops, total: y - GAP };
}

export function WorkflowPanel() {
  const { t } = useI18n();
  const { run, events } = useRun();
  const terminal = isTerminal(run.status);

  const visits = useMemo(() => {
    const m = new Map<Phase, number>();
    for (const e of events) if (e.type === 'step.started') m.set(e.data.step, (m.get(e.data.step) ?? 0) + 1);
    // 事件尚未回放完成时，用快照推断至少到达过的步骤
    if (!m.size && run.phase) m.set(run.phase, 1);
    return m;
  }, [events, run.phase]);

  const lastDecision = run.decisions[run.decisions.length - 1];
  const { tops, total } = rowTops();
  const center = (i: number) => tops[i] + (ROWS[i].kind === 'step' ? STEP_H : DEC_H) / 2;

  const active = !terminal && run.status !== 'awaiting_clarification' ? run.phase : null;
  const researchRounds = run.research_round;
  const reviewRounds = run.review_round;

  return (
    <div className="relative px-6" style={{ height: total }}>
      {/* 研究循环：从"继续研究？"回到"规划调查" */}
      <LoopBracket side="left" top={center(1)} bottom={center(5)} label={researchRounds > 0 ? t('common.round', { n: researchRounds }) : t('workflow.researchLoop')} active={researchRounds > 1} />
      {/* 审查循环：从"可以结束？"回到"核实声明" */}
      <LoopBracket side="right" top={center(3)} bottom={center(8)} label={reviewRounds > 0 ? `${t('workflow.reviewLoop')} ${reviewRounds}` : t('workflow.reviewLoop')} active={reviewRounds > 1} />
      {ROWS.map((r, i) => {
        if (r.kind === 'decision') {
          const decided =
            r.id === 'decide'
              ? run.decisions.some((d) => d.kind === 'write_report')
              : terminal && (run.status === 'completed' || run.status === 'partial');
          const current = r.id === 'decide' ? active === 'update' && lastDecision?.kind !== 'write_report' : active === 'review';
          return (
            <div key={r.id} className="absolute inset-x-6 flex items-center justify-center" style={{ top: tops[i], height: DEC_H }}>
              <div
                className={clsx(
                  'flex h-[26px] items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
                  decided ? 'border-line-strong bg-surface text-ink-2' : current ? 'border-accent text-accent-text' : 'border-dashed border-line-strong text-ink-3',
                )}
              >
                <span className="size-1.5 rotate-45 bg-current" />
                {t(r.id === 'decide' ? 'workflow.decide' : 'workflow.finish')}
              </div>
            </div>
          );
        }
        const count = visits.get(r.phase) ?? 0;
        const isActive = active === r.phase;
        const done = count > 0 && !isActive;
        return (
          <div
            key={r.phase}
            className={clsx(
              'absolute inset-x-6 flex items-center gap-2.5 rounded-lg border px-2.5 transition-colors',
              isActive ? 'border-accent bg-accent-soft shadow-card' : done ? 'border-line bg-surface' : 'border-dashed border-line bg-transparent',
            )}
            style={{ top: tops[i], height: STEP_H }}
          >
            <span
              className={clsx(
                'tnum flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                isActive ? 'bg-accent text-accent-ink' : done ? 'bg-good-soft text-good-text' : 'bg-surface-3 text-ink-3',
              )}
            >
              {isActive ? <CircleDot className="size-3.5 animate-pulse-dot" /> : done ? <Check className="size-3.5" /> : r.n}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className={clsx('truncate text-[13px] font-medium', !done && !isActive && 'text-ink-3')}>{t(`phase.${r.phase}`)}</div>
              <div className="truncate text-[11px] text-ink-3">{t(`phase.${r.phase}.sub`)}</div>
            </div>
            {count > 1 && <span className="tnum shrink-0 rounded bg-surface-3 px-1 text-[10px] font-semibold text-ink-2">×{count}</span>}
          </div>
        );
      })}
    </div>
  );
}

function LoopBracket({ side, top, bottom, label, active }: { side: 'left' | 'right'; top: number; bottom: number; label: string; active: boolean }) {
  const color = active ? 'var(--accent)' : 'var(--line-strong)';
  return (
    <div className={clsx('absolute', side === 'left' ? 'left-0' : 'right-0')} style={{ top, height: bottom - top, width: 22 }}>
      <svg width="22" height={bottom - top} className="overflow-visible" aria-hidden>
        {side === 'left' ? (
          <>
            <path d={`M24 ${bottom - top} H8 a4 4 0 0 1 -4 -4 V4 a4 4 0 0 1 4 -4 H22`} fill="none" stroke={color} strokeWidth="1.5" />
            <path d="M18 -3.5 L23 0 L18 3.5" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <path d={`M-2 ${bottom - top} H14 a4 4 0 0 0 4 -4 V4 a4 4 0 0 0 -4 -4 H0`} fill="none" stroke={color} strokeWidth="1.5" />
            <path d="M4 -3.5 L-1 0 L4 3.5" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </svg>
      <span
        className={clsx('absolute top-1/2 text-[10px] font-semibold tracking-wide whitespace-nowrap uppercase', active ? 'text-accent-text' : 'text-ink-3')}
        style={{
          transform: `translateY(-50%) rotate(${side === 'left' ? -90 : 90}deg) translateY(${side === 'left' ? -6 : -6}px)`,
          transformOrigin: 'center',
          writingMode: 'horizontal-tb',
          background: 'var(--surface)',
          padding: '0 3px',
          left: side === 'left' ? -12 : undefined,
          right: side === 'right' ? -12 : undefined,
        }}
      >
        {label}
      </span>
    </div>
  );
}
