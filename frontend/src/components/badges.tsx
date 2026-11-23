/** 业务语义徽标：运行状态、证据状态、实验条件、缺口类型、动作类型等。状态色始终配图标与文字 */
import clsx from 'clsx';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Clock,
  Compass,
  Crosshair,
  FileSearch,
  GitMerge,
  HelpCircle,
  Layers,
  Loader2,
  MessageCircleQuestion,
  MoveHorizontal,
  Search,
  ShieldCheck,
  Shrink,
  XCircle,
  Zap,
} from 'lucide-react';
import type { ActionType, ConditionId, GapType, Mechanisms, RunStatus, Verdict } from '../api/types.ts';
import { useI18n } from '../i18n/index.tsx';
import { conditionOf } from '../lib/format.ts';
import { Badge } from './ui.tsx';

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const { t } = useI18n();
  const map: Record<RunStatus, { tone: Parameters<typeof Badge>[0]['tone']; icon: React.ReactNode }> = {
    queued: { tone: 'neutral', icon: <Clock className="size-3.5" /> },
    running: { tone: 'accent', icon: <Loader2 className="size-3.5 animate-spin" /> },
    awaiting_clarification: { tone: 'warn', icon: <MessageCircleQuestion className="size-3.5" /> },
    completed: { tone: 'good', icon: <CheckCircle2 className="size-3.5" /> },
    partial: { tone: 'serious', icon: <CircleDashed className="size-3.5" /> },
    failed: { tone: 'critical', icon: <XCircle className="size-3.5" /> },
    cancelled: { tone: 'neutral', icon: <Ban className="size-3.5" /> },
  };
  const m = map[status];
  return (
    <Badge tone={m.tone} className={className}>
      {m.icon}
      {t(`status.${status}`)}
    </Badge>
  );
}

export const VERDICT_META: Record<Verdict, { tone: 'good' | 'critical' | 'serious' | 'neutral'; color: string; Icon: typeof CheckCircle2 }> = {
  supported: { tone: 'good', color: 'var(--good)', Icon: CheckCircle2 },
  contradicted: { tone: 'critical', color: 'var(--critical)', Icon: XCircle },
  conflicting: { tone: 'serious', color: 'var(--serious)', Icon: AlertTriangle },
  insufficient: { tone: 'neutral', color: 'var(--ink-3)', Icon: CircleHelp },
};

export function VerdictBadge({ verdict, compact, className }: { verdict: Verdict; compact?: boolean; className?: string }) {
  const { t } = useI18n();
  const m = VERDICT_META[verdict];
  return (
    <Badge tone={m.tone} className={className} title={t(`verdict.${verdict}.desc`)}>
      <m.Icon className="size-3.5" />
      {!compact && t(`verdict.${verdict}`)}
    </Badge>
  );
}

export const COND_COLOR: Record<ConditionId, string> = {
  base: 'var(--cond-base)',
  source: 'var(--cond-source)',
  temporal: 'var(--cond-temporal)',
  full: 'var(--cond-full)',
};

export function ConditionTag({ mechanisms, condition, withDesc }: { mechanisms?: Mechanisms; condition?: ConditionId; withDesc?: boolean }) {
  const { t } = useI18n();
  const c = condition ?? conditionOf(mechanisms!);
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-ink-2" title={t(`cond.${c}.desc`)}>
      <span className="size-2 rounded-full" style={{ background: COND_COLOR[c] }} />
      <span className="text-ink">{t(`cond.${c}`)}</span>
      {withDesc && <span className="text-ink-3">· {t(`cond.${c}.desc`)}</span>}
    </span>
  );
}

const GAP_ICON: Record<GapType, typeof Search> = {
  missing_background: MoveHorizontal,
  missing_phase: Layers,
  unclear_date: Clock,
  conflict: AlertTriangle,
  single_source: ShieldCheck,
  unverified_origin: GitMerge,
  unanswered_question: HelpCircle,
};

export function GapTypeTag({ type }: { type: GapType }) {
  const { t } = useI18n();
  const Icon = GAP_ICON[type];
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-2">
      <Icon className="size-3.5" />
      {t(`gap.${type}`)}
    </span>
  );
}

export const ACTION_ICON: Record<ActionType, typeof Search> = {
  search: Search,
  read: FileSearch,
  expand_window: MoveHorizontal,
  narrow_window: Shrink,
  focus_date: Crosshair,
  trace_origin: Compass,
  corroborate: ShieldCheck,
};

export function ActionTypeTag({ type }: { type: ActionType }) {
  const { t } = useI18n();
  const Icon = ACTION_ICON[type];
  const special = type !== 'search' && type !== 'read';
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', special ? 'bg-accent-soft text-accent-text' : 'bg-neutral-soft text-ink-2')}>
      <Icon className="size-3.5" />
      {t(`action.${type}`)}
    </span>
  );
}

export function LiveDot({ className }: { className?: string }) {
  return <span className={clsx('inline-block size-2 rounded-full bg-accent animate-pulse-dot', className)} />;
}

export { Zap };
