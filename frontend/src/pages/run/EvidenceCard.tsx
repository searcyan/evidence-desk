/** 证据卡：原文引用 + 来源元数据（发布日期、是否原始来源、截止时间后发布等） */
import clsx from 'clsx';
import { AlertTriangle, BadgeCheck, ExternalLink, Link2 } from 'lucide-react';
import type { ClaimEvidenceLink, Evidence, SourceDocument } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtDate, fmtDateRef } from '../../lib/format.ts';
import { useRun } from './context.tsx';

export function DocMeta({ doc, compact }: { doc: SourceDocument; compact?: boolean }) {
  const { t, lang } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
      <span className="font-medium text-ink-2">{doc.publisher ?? doc.domain}</span>
      <span title={t(`sources.dateSource.${doc.published_at_source}`)} className="tnum">
        {doc.published_at ? t('report.publishedAt', { date: fmtDate(doc.published_at, lang) }) : t('sources.dateSource.unknown')}
      </span>
      {doc.is_original && (
        <span className="inline-flex items-center gap-0.5 text-good-text">
          <BadgeCheck className="size-3.5" />
          {t('report.original')}
        </span>
      )}
      {doc.available_at_cutoff === false && (
        <span className="inline-flex items-center gap-0.5 text-serious-text">
          <AlertTriangle className="size-3.5" />
          {t('report.afterCutoff')}
        </span>
      )}
      {!compact && doc.attribution && <span>· {t('sources.attribution', { who: doc.attribution })}</span>}
    </div>
  );
}

export function EvidenceCard({ evidence, relation, note, showDoc = true, className }: { evidence: Evidence; relation?: ClaimEvidenceLink['relation']; note?: string | null; showDoc?: boolean; className?: string }) {
  const { t, lang } = useI18n();
  const { doc, citeNum, goto } = useRun();
  const d = doc(evidence.document_id);
  const n = citeNum.get(evidence.id);
  const barColor = relation === 'contradicts' ? 'var(--critical)' : relation === 'supports' ? 'var(--good)' : 'var(--line-strong)';
  return (
    <div className={clsx('rounded-lg border border-line bg-surface-2/60 p-3', className)}>
      <div className="flex gap-3">
        <div className="w-[3px] shrink-0 rounded-full" style={{ background: barColor }} />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
            {relation && (
              <span className={clsx('font-semibold', relation === 'supports' ? 'text-good-text' : relation === 'contradicts' ? 'text-critical-text' : 'text-ink-3')}>
                {t(`claims.relation.${relation}`)}
              </span>
            )}
            {n && <span className="tnum rounded bg-accent-soft px-1 font-semibold text-accent-text">[{n}]</span>}
            {evidence.event_date && <span className="tnum text-ink-3">{fmtDateRef(evidence.event_date, lang)}</span>}
            <span className="font-mono text-[11px] text-ink-3">{evidence.id}</span>
          </div>
          <blockquote className="text-[13.5px] leading-relaxed text-ink">“{evidence.quote}”</blockquote>
          {note && <div className="mt-1.5 text-xs text-serious-text italic">{note}</div>}
          {showDoc && d && (
            <div className="mt-2 border-t border-line pt-2">
              <a href={d.url} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-1 text-[13px] font-medium text-ink hover:text-accent-text">
                <span className="truncate">{d.title}</span>
                <ExternalLink className="size-3 shrink-0 opacity-50 group-hover:opacity-100" />
              </a>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <DocMeta doc={d} compact />
                <button onClick={() => goto('sources', { kind: 'document', id: d.id })} className="inline-flex shrink-0 items-center gap-0.5 text-xs text-accent-text hover:underline">
                  <Link2 className="size-3" />
                  {t('report.showInSources')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
