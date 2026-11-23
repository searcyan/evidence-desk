/** 运行列表：状态筛选 + 文本搜索，表格展示 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import clsx from 'clsx';
import { History, Plus, Search } from 'lucide-react';
import { useRuns } from '../api/hooks.ts';
import type { RunStatus } from '../api/types.ts';
import { useI18n } from '../i18n/index.tsx';
import { fmtCost, fmtDate, fmtDuration, fmtRelative, runDuration } from '../lib/format.ts';
import { Button, Card, EmptyState, Loading, PageHeader, TextInput } from '../components/ui.tsx';
import { ConditionTag, StatusBadge } from '../components/badges.tsx';

const STATUS_FILTERS: (RunStatus | 'all')[] = ['all', 'running', 'awaiting_clarification', 'completed', 'partial', 'failed', 'cancelled'];

export function RunsPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [status, setStatus] = useState<RunStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const runs = useRuns({ status: status === 'all' ? undefined : [status], q: q.trim() || undefined });
  const items = runs.data?.items ?? [];

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-8 lg:px-8">
      <PageHeader
        title={t('runs.title')}
        subtitle={t('runs.subtitle')}
        right={
          <Link to="/">
            <Button variant="primary" icon={<Plus className="size-4" />}>
              {t('nav.new')}
            </Button>
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('runs.filterPlaceholder')} className="pl-9" />
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={clsx('h-8 rounded-full px-3 text-[13px] font-medium transition-colors', status === s ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-surface-2')}
            >
              {s === 'all' ? t('common.all') : t(`status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <Card padded={false} className="overflow-hidden">
        {runs.isLoading ? (
          <Loading label={t('common.loading')} />
        ) : !items.length ? (
          <EmptyState icon={<History className="size-8" />} title={q || status !== 'all' ? t('runs.emptyFiltered') : t('runs.empty')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-xs font-medium text-ink-2">
                  <th className="px-4 py-2.5">{t('runs.col.run')}</th>
                  <th className="px-3 py-2.5">{t('runs.col.status')}</th>
                  <th className="px-3 py-2.5">{t('runs.col.cutoff')}</th>
                  <th className="px-3 py-2.5">{t('runs.col.condition')}</th>
                  <th className="px-3 py-2.5">{t('runs.col.findings')}</th>
                  <th className="px-3 py-2.5 text-right">{t('runs.col.cost')}</th>
                  <th className="px-3 py-2.5 text-right">{t('runs.col.duration')}</th>
                  <th className="px-4 py-2.5 text-right">{t('runs.col.created')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} onClick={() => navigate(`/runs/${r.id}`)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="max-w-[360px] px-4 py-3">
                      <Link to={`/runs/${r.id}`} className="block truncate font-medium hover:text-accent-text" onClick={(e) => e.stopPropagation()}>
                        {r.title}
                      </Link>
                      {/* 评测任务带 eval:<长哈希> 标签，只显示可读的标签，并限制在本列内 */}
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden text-xs text-ink-3">
                        <span className="shrink-0 font-mono">{r.id}</span>
                        {r.request.tags
                          .filter((tag) => !tag.startsWith('eval:'))
                          .slice(0, 2)
                          .map((tag) => (
                            <span key={tag} className="max-w-[120px] truncate rounded bg-surface-3 px-1 text-[11px]">
                              {tag}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="tnum px-3 py-3 whitespace-nowrap text-ink-2">
                      {fmtDate(r.request.cutoff, lang)}
                      <div className="text-xs text-ink-3">{t(`mode.${r.request.temporal_mode}`)}</div>
                    </td>
                    <td className="px-3 py-3">
                      <ConditionTag mechanisms={r.request.mechanisms} />
                    </td>
                    <td className="tnum px-3 py-3 whitespace-nowrap text-ink-2">{t('runs.findings', { docs: r.counts.documents, claims: r.counts.claims })}</td>
                    <td className="tnum px-3 py-3 text-right text-ink-2">{fmtCost(r.usage.cost_usd)}</td>
                    <td className="tnum px-3 py-3 text-right text-ink-2">{fmtDuration(runDuration(r))}</td>
                    <td className="tnum px-4 py-3 text-right whitespace-nowrap text-ink-3">{fmtRelative(r.created_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
