/** 系统页：健康检查、模型配置、检索服务、快照与预算预设 */
import { CheckCircle2, XCircle } from 'lucide-react';
import { useConfig, useHealth } from '../api/hooks.ts';
import type { ModelRole } from '../api/types.ts';
import { useI18n } from '../i18n/index.tsx';
import { fmtCompact, fmtCost, fmtDate, fmtDuration } from '../lib/format.ts';
import { Badge, Card, EmptyState, Loading, PageHeader, SectionTitle } from '../components/ui.tsx';

const ROLES: ModelRole[] = ['controller', 'extractor', 'writer', 'reviewer'];

export function SystemPage() {
  const { t, lang } = useI18n();
  const config = useConfig();
  const health = useHealth();
  if (config.isLoading) return <Loading label={t('common.loading')} />;
  const c = config.data;
  return (
    <div className="mx-auto max-w-[1100px] px-5 py-8 lg:px-8">
      <PageHeader title={t('sys.title')} subtitle={t('sys.subtitle')} right={c && <Badge tone={c.mode === 'mock' ? 'warn' : 'good'}>{t('sys.mode')}: {c.mode} · v{c.version}</Badge>} />
      {!c ? (
        <Card>
          <EmptyState icon={<XCircle className="size-8 text-critical-text" />} title={t('common.backendDown')} hint={t('common.backendDownHint')} />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <SectionTitle right={health.data && <Badge tone={health.data.status === 'ok' ? 'good' : 'warn'}>{health.data.status}</Badge>}>{t('sys.health')}</SectionTitle>
            <ul className="flex flex-col gap-2">
              {Object.entries(health.data?.checks ?? {}).map(([k, v]) => (
                <li key={k} className="flex items-center gap-2 text-sm">
                  {v.ok ? <CheckCircle2 className="size-4 text-good-text" /> : <XCircle className="size-4 text-critical-text" />}
                  <span className="font-medium">{k}</span>
                  <span className="text-ink-3">{v.detail}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <SectionTitle>{t('sys.providers')}</SectionTitle>
            <ul className="flex flex-col gap-2">
              {c.search_providers.map((p) => (
                <li key={p.id} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{p.id}</span>
                  <Badge tone={p.available ? 'good' : 'neutral'}>{p.available ? t('sys.available') : t('sys.unavailable')}</Badge>
                </li>
              ))}
            </ul>
            <div className="mt-5">
              <SectionTitle>{t('sys.snapshots')}</SectionTitle>
              {c.snapshots.length ? (
                <ul className="flex flex-col gap-2">
                  {c.snapshots.map((s) => (
                    <li key={s.id} className="text-sm">
                      <div className="font-medium">{s.label}</div>
                      <div className="tnum text-xs text-ink-3">
                        <span className="font-mono">{s.id}</span> · {fmtDate(s.created_at, lang)} · {t('sys.entries', { n: s.entries })}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-ink-3">{t('common.none')}</div>
              )}
            </div>
          </Card>
          <Card className="lg:col-span-2">
            <SectionTitle>{t('sys.models')}</SectionTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-2">
                    <th className="py-2 pr-3 font-medium" />
                    {ROLES.map((r) => (
                      <th key={r} className="px-3 py-2 font-medium">
                        {t(`sys.role.${r}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.model_profiles.map((m) => (
                    <tr key={m.id} className="border-b border-line last:border-0">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium">
                          {m.label} {m.id === c.default_model_profile && <Badge tone="accent">{t('sys.default')}</Badge>}
                        </div>
                        <div className="text-xs text-ink-3">{m.provider}</div>
                      </td>
                      {ROLES.map((r) => (
                        <td key={r} className="px-3 py-2.5 font-mono text-xs">
                          {m.roles[r]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card className="lg:col-span-2">
            <SectionTitle>{t('sys.presets')}</SectionTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-2">
                    <th className="py-2 pr-3 font-medium" />
                    <th className="px-3 py-2 text-right font-medium">{t('budget.rounds')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('budget.reviews')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('budget.toolCalls')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('budget.tokens')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('budget.seconds')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('budget.cost')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('budget.reserve')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(['small', 'medium', 'large'] as const).map((p) => {
                    const b = c.budget_presets[p];
                    return (
                      <tr key={p} className="tnum border-b border-line last:border-0">
                        <td className="py-2 pr-3 font-medium">{t(`new.preset.${p}`)}</td>
                        <td className="px-3 py-2 text-right">{b.max_research_rounds}</td>
                        <td className="px-3 py-2 text-right">{b.max_review_rounds}</td>
                        <td className="px-3 py-2 text-right">{b.max_tool_calls}</td>
                        <td className="px-3 py-2 text-right">{fmtCompact(b.max_llm_tokens, lang)}</td>
                        <td className="px-3 py-2 text-right">{fmtDuration(b.max_seconds)}</td>
                        <td className="px-3 py-2 text-right">{b.max_cost_usd != null ? fmtCost(b.max_cost_usd) : t('budget.unlimited')}</td>
                        <td className="px-3 py-2 text-right">{Math.round(b.reserve_ratio * 100)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
