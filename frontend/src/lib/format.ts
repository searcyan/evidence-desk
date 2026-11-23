/** 格式化工具：日期、时长、成本、紧凑数字等，均按界面语言本地化 */
import type { ConditionId, DateRef, Lang, Mechanisms, RunSummary } from '../api/types.ts';

const loc = (lang: Lang) => (lang === 'zh' ? 'zh-CN' : 'en-US');

export function fmtDateTime(iso: string | null | undefined, lang: Lang, opts: { utc?: boolean } = {}) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(loc(lang), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: opts.utc ? 'UTC' : undefined,
    timeZoneName: opts.utc ? 'short' : undefined,
  }).format(new Date(iso));
}

/** 只显示日期；ISO 时间戳按 UTC 取日期，避免时区导致日期偏移 */
export function fmtDate(iso: string | null | undefined, lang: Lang) {
  if (!iso) return '—';
  const d = iso.length <= 10 ? new Date(`${iso}T00:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat(loc(lang), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
}

export function fmtMonth(iso: string, lang: Lang) {
  return new Intl.DateTimeFormat(loc(lang), { year: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${iso.slice(0, 10)}T00:00:00Z`),
  );
}

export function fmtDateRef(ref: DateRef | null | undefined, lang: Lang) {
  if (!ref) return '—';
  switch (ref.precision) {
    case 'day':
      return fmtDate(ref.start, lang);
    case 'month':
      return fmtMonth(ref.start, lang);
    case 'year':
      return ref.start.slice(0, 4);
    case 'range':
      return `${fmtDate(ref.start, lang)} – ${fmtDate(ref.end, lang)}`;
  }
}

export function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtMs(ms: number) {
  return ms < 1000 ? `${ms}ms` : fmtDuration(ms / 1000);
}

export function fmtCost(usd: number | null | undefined) {
  if (usd == null) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtCompact(n: number | null | undefined, lang: Lang = 'en') {
  if (n == null) return '—';
  return new Intl.NumberFormat(loc(lang), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function fmtNum(n: number | null | undefined, lang: Lang = 'en', digits = 0) {
  if (n == null) return '—';
  return new Intl.NumberFormat(loc(lang), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
}

export function fmtPct(ratio: number | null | undefined, digits = 0) {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtRelative(iso: string | null | undefined, lang: Lang) {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(loc(lang), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(iso, lang);
}

export function conditionOf(m: Mechanisms): ConditionId {
  if (m.source_verification && m.temporal_planning) return 'full';
  if (m.source_verification) return 'source';
  if (m.temporal_planning) return 'temporal';
  return 'base';
}

/** 运行时长：进行中按当前时间计算 */
export function runDuration(r: Pick<RunSummary, 'started_at' | 'finished_at' | 'usage'>) {
  if (r.started_at && r.finished_at) return (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000;
  if (r.started_at) return (Date.now() - new Date(r.started_at).getTime()) / 1000;
  return r.usage.elapsed_seconds;
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
