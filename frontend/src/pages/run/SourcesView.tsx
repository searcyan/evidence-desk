/** 来源视图：按出处分组（同一出处的转载只计 1 个独立来源），或平铺全部文档 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ExternalLink, GitMerge, Info } from 'lucide-react';
import type { OriginGroup, SourceDocument } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { Card, EmptyState, Segmented } from '../../components/ui.tsx';
import { useRun } from './context.tsx';
import { DocMeta, EvidenceCard } from './EvidenceCard.tsx';

function DocRow({ d, root }: { d: SourceDocument; root?: boolean }) {
  const { t } = useI18n();
  const { evidenceByDoc, focus } = useRun();
  const evs = evidenceByDoc.get(d.id) ?? [];
  const focused = focus?.kind === 'document' && focus.id === d.id;
  const [open, setOpen] = useState(focused);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) {
      setOpen(true);
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focused]);
  return (
    <div ref={ref} className={clsx('rounded-lg px-3 py-2.5 transition-colors', focused ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-surface-2', d.available_at_cutoff === false && 'opacity-75')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {root && <span className="rounded bg-good-soft px-1 text-[10px] font-semibold text-good-text uppercase">{t('sources.root')}</span>}
            <a href={d.url} target="_blank" rel="noreferrer" className="group inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:text-accent-text">
              <span className="truncate">{d.title}</span>
              <ExternalLink className="size-3 shrink-0 opacity-40 group-hover:opacity-100" />
            </a>
          </div>
          <div className="mt-0.5">
            <DocMeta doc={d} />
          </div>
          <div className="mt-1 line-clamp-2 text-[13px] text-ink-2">{d.snippet}</div>
          {d.available_at_cutoff === false && <div className="mt-1 text-xs font-medium text-serious-text">{t('sources.afterCutoff')}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-ink-3">
          <span>{t('common.round', { n: d.round })}</span>
        </div>
      </div>
      {evs.length > 0 && (
        <>
          <button onClick={() => setOpen((o) => !o)} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline">
            <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} />
            {t('sources.evidenceCount', { n: evs.length })}
          </button>
          {open && (
            <div className="mt-2 flex flex-col gap-2">
              {evs.map((e) => (
                <EvidenceCard key={e.id} evidence={e} showDoc={false} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GroupCard({ g, docs }: { g: OriginGroup; docs: SourceDocument[] }) {
  const { t } = useI18n();
  const multi = docs.length > 1;
  const ordered = [...docs].sort((a, b) => (a.id === g.root_document_id ? -1 : b.id === g.root_document_id ? 1 : (a.published_at ?? '') < (b.published_at ?? '') ? -1 : 1));
  return (
    <Card padded={false} className="overflow-hidden">
      <div className={clsx('flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5', multi ? 'bg-accent-soft/40' : 'bg-surface-2/60')}>
        <div className="flex min-w-0 items-center gap-2">
          {multi && <GitMerge className="size-4 shrink-0 text-accent-text" />}
          <span className="truncate font-medium">{g.label}</span>
        </div>
        <span className={clsx('text-xs', multi ? 'font-medium text-accent-text' : 'text-ink-3')}>{multi ? t('sources.group', { docs: docs.length }) : t('sources.groupSingle')}</span>
        {multi && <div className="w-full text-xs text-ink-2">{g.reason}</div>}
      </div>
      <div className="flex flex-col gap-0.5 p-1.5">
        {ordered.map((d) => (
          <DocRow key={d.id} d={d} root={multi && d.id === g.root_document_id} />
        ))}
      </div>
    </Card>
  );
}

export function SourcesView() {
  const { t } = useI18n();
  const { run } = useRun();
  const grouping = run.request.mechanisms.source_verification;
  const [view, setView] = useState<'grouped' | 'flat'>(grouping ? 'grouped' : 'flat');
  const docMap = useMemo(() => new Map(run.documents.map((d) => [d.id, d])), [run.documents]);
  const ungrouped = run.documents.filter((d) => !d.origin_group_id);
  const groups = [...run.origin_groups].sort((a, b) => b.document_ids.length - a.document_ids.length);

  if (!run.documents.length)
    return (
      <Card>
        <EmptyState title={t('sources.empty')} />
      </Card>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="tnum text-sm text-ink-2">
          {grouping ? t('sources.summary', { docs: run.documents.length, groups: run.origin_groups.length }) : t('sources.summaryFlat', { docs: run.documents.length })}
        </div>
        {grouping && (
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'grouped', label: t('sources.groupedBy') },
              { value: 'flat', label: t('sources.flat') },
            ]}
          />
        )}
      </div>
      {!grouping && (
        <div className="flex gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
          {t('sources.ungrouped')}
        </div>
      )}
      {view === 'grouped' && grouping ? (
        <>
          {groups.map((g) => (
            <GroupCard key={g.id} g={g} docs={g.document_ids.map((id) => docMap.get(id)).filter((d): d is SourceDocument => !!d)} />
          ))}
          {ungrouped.length > 0 && (
            <Card padded={false} className="p-1.5">
              {ungrouped.map((d) => (
                <DocRow key={d.id} d={d} />
              ))}
            </Card>
          )}
        </>
      ) : (
        <Card padded={false} className="flex flex-col gap-0.5 p-1.5">
          {[...run.documents]
            .sort((a, b) => ((a.published_at ?? '') < (b.published_at ?? '') ? -1 : 1))
            .map((d) => (
              <DocRow key={d.id} d={d} />
            ))}
        </Card>
      )}
    </div>
  );
}
