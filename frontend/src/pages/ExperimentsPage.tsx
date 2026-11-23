/** 实验列表 */
import { Link } from 'react-router';
import { ArrowRight, FlaskConical } from 'lucide-react';
import { useExperiments } from '../api/hooks.ts';
import { useI18n } from '../i18n/index.tsx';
import { fmtDate } from '../lib/format.ts';
import { Badge, Card, EmptyState, Kbd, Loading, PageHeader } from '../components/ui.tsx';
import { COND_COLOR } from '../components/badges.tsx';

export function ExperimentsPage() {
  const { t, lang } = useI18n();
  const q = useExperiments();
  return (
    <div className="mx-auto max-w-[1100px] px-5 py-8 lg:px-8">
      <PageHeader title={t('exp.title')} subtitle={t('exp.subtitle')} />
      {q.isLoading ? (
        <Loading label={t('common.loading')} />
      ) : !q.data?.length ? (
        <Card>
          <EmptyState icon={<FlaskConical className="size-8" />} title={t('exp.empty').split('`')[0]} hint={<Kbd>newsagent eval run</Kbd>} />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data.map((e) => (
            <Link key={e.id} to={`/experiments/${e.id}`} className="group rounded-xl border border-line bg-surface p-5 shadow-card transition-colors hover:border-line-strong">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold group-hover:text-accent-text">{e.name}</div>
                  <div className="mt-0.5 font-mono text-xs text-ink-3">{e.id}</div>
                </div>
                <Badge tone={e.status === 'completed' ? 'good' : e.status === 'failed' ? 'critical' : 'accent'}>{t(`exp.status.${e.status}`)}</Badge>
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {e.benchmarks.map((b) => (
                  <span key={b} className="rounded-md bg-surface-3 px-2 py-0.5 text-xs text-ink-2">
                    {t(`exp.benchmark.${b}`)}
                  </span>
                ))}
              </div>
              <div className="tnum mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    {e.conditions.map((c) => (
                      <span key={c} className="size-2 rounded-full" style={{ background: COND_COLOR[c] }} title={t(`cond.${c}`)} />
                    ))}
                  </span>
                  {t('exp.tasks', { n: e.task_count })} · {t('exp.repeats', { n: e.repeats })} · {t(`new.preset.${e.budget_preset}`)}
                </span>
                <span className="flex items-center gap-1 text-ink-3">
                  {fmtDate(e.created_at, lang)}
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
