/** 新建研究：主界面只保留问题、截止时间、时间模式和报告语言；预算、机制与高级选项收进设置弹窗 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import { ArrowUp, CalendarClock, SlidersHorizontal } from 'lucide-react';
import { useConfig, useCreateRun } from '../api/hooks.ts';
import { ApiError } from '../api/client.ts';
import type { BudgetLimits, BudgetPreset, Lang, Mechanisms, RunRequest, SearchMode, TemporalMode } from '../api/types.ts';
import { useI18n } from '../i18n/index.tsx';
import { conditionOf, fmtCompact, fmtCost } from '../lib/format.ts';
import { Button, Dialog, Field, Segmented, Select, Switch, TextInput } from '../components/ui.tsx';
import { ConditionTag } from '../components/badges.tsx';

/** 示例问题针对 mock 后端的虚构场景，只在 mock 模式下显示 */
const EXAMPLES: { en: string; zh: string; cutoff: string }[] = [
  {
    en: 'Has Northwind Robotics completed its acquisition of Helios Sensors, and which approvals were still pending?',
    zh: 'Northwind Robotics 对 Helios Sensors 的收购完成了吗？还有哪些审批没有通过？',
    cutoff: '2024-06-30T23:59',
  },
  {
    en: 'What was the status of the EU review of the Northwind–Helios deal in early May 2024?',
    zh: '2024 年 5 月初，欧盟对 Northwind–Helios 交易的审查进展如何？',
    cutoff: '2024-05-05T00:00',
  },
  { en: 'Northwind deal?', zh: '那次收购？', cutoff: '2024-06-30T23:59' },
];

/** datetime-local（按 UTC 解释）↔ RFC 3339 */
const toInput = (iso: string) => iso.slice(0, 16);
const fromInput = (v: string) => `${v.slice(0, 16)}:00Z`;
const nowInput = () => new Date().toISOString().slice(0, 16);

const CHIP = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-ink transition-colors';

export function NewRunPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const config = useConfig();
  const create = useCreateRun();
  const prefill = (location.state as { request?: RunRequest } | null)?.request;

  const [question, setQuestion] = useState(prefill?.question ?? '');
  const [eventHint, setEventHint] = useState(prefill?.event_hint ?? '');
  const [seedUrl, setSeedUrl] = useState(prefill?.seed_url ?? '');
  const [cutoff, setCutoff] = useState(prefill ? toInput(prefill.cutoff) : nowInput());
  const [mode, setMode] = useState<TemporalMode>(prefill?.temporal_mode ?? 'as_of');
  const [reportLang, setReportLang] = useState<Lang>(prefill?.report_language ?? lang);
  const [preset, setPreset] = useState<BudgetPreset>(prefill?.budget_preset ?? 'medium');
  const [custom, setCustom] = useState<BudgetLimits | null>(null);
  const [mech, setMech] = useState<Mechanisms>(prefill?.mechanisms ?? { source_verification: true, temporal_planning: true });
  const [settings, setSettings] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>(prefill?.search_mode ?? 'live');
  const [snapshotId, setSnapshotId] = useState(prefill?.snapshot_id ?? '');
  const [modelProfile, setModelProfile] = useState(prefill?.model_profile ?? '');
  const [tags, setTags] = useState(prefill?.tags.join(', ') ?? '');

  // 配置加载后应用默认值（仅在没有预填时）
  useEffect(() => {
    const d = config.data?.defaults;
    if (!d || prefill) return;
    setMode(d.temporal_mode);
    setPreset(d.budget_preset);
    setMech(d.mechanisms);
    setSearchMode(d.search_mode);
  }, [config.data, prefill]);

  const presets = config.data?.budget_presets;
  const customBudget: BudgetLimits | null = custom ?? presets?.medium ?? null;
  const cond = conditionOf(mech);
  const cutoffIso = fromInput(cutoff);
  const cutoffFuture = new Date(cutoffIso).getTime() > Date.now() + 60_000;
  const canSubmit = question.trim().length > 0 && !!cutoff && !cutoffFuture && !(searchMode === 'snapshot' && !snapshotId);
  const mock = config.data?.mode === 'mock';

  const submit = async () => {
    const req: RunRequest = {
      question: question.trim(),
      event_hint: eventHint.trim() || null,
      cutoff: cutoffIso,
      temporal_mode: mode,
      seed_url: seedUrl.trim() || null,
      report_language: reportLang,
      budget_preset: preset,
      budget: preset === 'custom' ? customBudget : null,
      mechanisms: mech,
      search_mode: searchMode,
      snapshot_id: searchMode === 'snapshot' ? snapshotId || null : null,
      model_profile: modelProfile || null,
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
    };
    try {
      const run = await create.mutateAsync(req);
      navigate(`/runs/${run.id}`);
    } catch {
      /* 错误在下方展示 */
    }
  };

  const err = create.error as ApiError | null;

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-[840px]">
        <h1 className="text-center text-[30px] font-semibold tracking-tight">{t('new.title')}</h1>
        <p className="mx-auto mt-2 max-w-xl text-center text-[15px] text-ink-2">{t('new.subtitle')}</p>

        <form
          className="mt-8 rounded-2xl border border-line-strong/70 bg-surface shadow-card transition-shadow focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/10"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <label htmlFor="q" className="sr-only">
            {t('new.question')}
          </label>
          <textarea
            id="q"
            rows={3}
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t('new.questionPlaceholder')}
            className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[16px] leading-relaxed outline-none placeholder:text-ink-3"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) void submit();
            }}
          />
          <div className="flex flex-wrap items-center gap-2 px-3 pt-1 pb-3">
            <label className={clsx(CHIP, 'pr-1.5', cutoffFuture && 'border-critical/50 text-critical-text')} title={t('new.cutoffHint')}>
              <CalendarClock className="size-3.5 shrink-0 text-ink-3" />
              <span className="text-ink-3">{t('new.cutoffShort')}</span>
              <input type="datetime-local" value={cutoff} max={nowInput()} onChange={(e) => setCutoff(e.target.value)} className="tnum w-[142px] bg-transparent text-ink outline-none" aria-label={t('new.cutoff')} />
              <span className="text-[11px] text-ink-3">UTC</span>
              <button type="button" onClick={() => setCutoff(nowInput())} className="rounded px-1 text-[11px] font-medium text-accent-text hover:bg-accent-soft">
                {t('new.cutoffNow')}
              </button>
            </label>
            <Segmented<TemporalMode>
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'as_of', label: t('new.asOf'), title: t('new.asOfDesc') },
                { value: 'retrospective', label: t('new.retro'), title: t('new.retroDesc') },
              ]}
            />
            <Segmented<Lang>
              size="sm"
              value={reportLang}
              onChange={setReportLang}
              options={[
                { value: 'zh', label: '中文', title: t('new.language') },
                { value: 'en', label: 'EN', title: t('new.language') },
              ]}
            />
            <button type="button" onClick={() => setSettings(true)} className={clsx(CHIP, 'hover:border-line-strong hover:bg-surface-2')}>
              <SlidersHorizontal className="size-3.5 text-ink-3" />
              <span>{t('new.settings')}</span>
              <span className="text-ink-3">·</span>
              <span className="font-normal text-ink-2">{t('new.settingsSummary', { preset: t(`new.preset.${preset}`) })}</span>
              {cond !== 'full' && <ConditionTag condition={cond} />}
            </button>
            <Button type="submit" variant="primary" className="ml-auto" disabled={!canSubmit} loading={create.isPending} icon={<ArrowUp className="size-4" />}>
              {create.isPending ? t('new.submitting') : t('new.submit')}
            </Button>
          </div>
        </form>

        {cutoffFuture && <div className="mt-2 px-1 text-xs text-critical-text">{t('new.cutoffFuture')}</div>}
        {err && (
          <div className="mt-3 rounded-lg border border-critical/30 bg-critical-soft px-4 py-3 text-sm text-critical-text">
            <span className="font-semibold">{err.type}</span> — {err.message}
          </div>
        )}

        {mock && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setQuestion(lang === 'zh' ? ex.zh : ex.en);
                  setCutoff(ex.cutoff);
                }}
                className="max-w-[300px] truncate rounded-full border border-line px-2.5 py-1 text-xs text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink"
              >
                {lang === 'zh' ? ex.zh : ex.en}
              </button>
            ))}
          </div>
        )}

        <ol className="mt-10 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-ink-3">
          {(['new.how1', 'new.how2', 'new.how3', 'new.how4'] as const).map((k, i) => (
            <li key={k} className="flex items-center gap-2">
              {i > 0 && <span className="text-line-strong">→</span>}
              {t(k)}
            </li>
          ))}
        </ol>
      </div>

      <Dialog
        open={settings}
        onClose={() => setSettings(false)}
        title={t('new.settings')}
        subtitle={t('new.settingsHint')}
        width={680}
        footer={
          <Button variant="primary" onClick={() => setSettings(false)}>
            {t('common.done')}
          </Button>
        }
      >
        <div className="flex flex-col gap-6">
          <section className="grid gap-4 sm:grid-cols-2">
            <Field label={t('new.eventHint')} htmlFor="hint">
              <TextInput id="hint" value={eventHint} onChange={(e) => setEventHint(e.target.value)} placeholder={t('new.eventHintPlaceholder')} />
            </Field>
            <Field label={t('new.seedUrl')} htmlFor="seed">
              <TextInput id="seed" type="url" value={seedUrl} onChange={(e) => setSeedUrl(e.target.value)} placeholder={t('new.seedUrlPlaceholder')} />
            </Field>
          </section>

          <div className="flex flex-col gap-3">
            <Field label={t('new.budget')} hint={t('new.budgetHint')}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(['small', 'medium', 'large', 'custom'] as BudgetPreset[]).map((p) => {
                  const b = p === 'custom' ? null : presets?.[p];
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPreset(p)}
                      className={clsx('rounded-lg border p-3 text-left transition-colors', preset === p ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-line-strong hover:bg-surface-2')}
                    >
                      <div className="text-sm font-semibold">{t(`new.preset.${p}`)}</div>
                      {b ? (
                        <div className="tnum mt-1 space-y-0.5 text-xs text-ink-2">
                          <div>
                            {b.max_research_rounds} {t('common.rounds')} · {b.max_tool_calls} {t('budget.toolCalls')}
                          </div>
                          <div>
                            {fmtCompact(b.max_llm_tokens, lang)} tok · {b.max_cost_usd != null ? fmtCost(b.max_cost_usd) : t('budget.unlimited')}
                          </div>
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-ink-2">{t('new.customHint')}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </Field>
            {preset === 'custom' && customBudget && <CustomBudget value={customBudget} onChange={setCustom} />}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-[13px] font-medium">{t('new.mechanisms')}</div>
                <div className="text-xs text-ink-3">{t('new.mechanismsHint')}</div>
              </div>
              <div className="flex items-center gap-2 text-xs text-ink-3">
                {t('new.condition')}: <ConditionTag condition={cond} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MechCard label={t('new.mech.source')} desc={t('new.mech.sourceDesc')} checked={mech.source_verification} onChange={(v) => setMech({ ...mech, source_verification: v })} />
              <MechCard label={t('new.mech.temporal')} desc={t('new.mech.temporalDesc')} checked={mech.temporal_planning} onChange={(v) => setMech({ ...mech, temporal_planning: v })} />
            </div>
          </div>

          <section className="grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <Field label={t('new.searchMode')}>
              <Select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)}>
                <option value="live">{t('new.search.live')}</option>
                <option value="snapshot" disabled={!config.data?.snapshots.length}>
                  {t('new.search.snapshot')}
                </option>
                <option value="corpus" disabled={!config.data?.search_providers.find((p) => p.id === 'corpus')?.available}>
                  {t('new.search.corpus')}
                </option>
              </Select>
            </Field>
            {searchMode === 'snapshot' && (
              <Field label={t('new.snapshot')}>
                <Select value={snapshotId} onChange={(e) => setSnapshotId(e.target.value)}>
                  <option value="">—</option>
                  {config.data?.snapshots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('new.model')}>
              <Select value={modelProfile} onChange={(e) => setModelProfile(e.target.value)}>
                {config.data?.model_profiles.map((m) => (
                  <option key={m.id} value={m.id === config.data?.default_model_profile ? '' : m.id}>
                    {m.label}
                    {m.id === config.data?.default_model_profile ? ` (${t('sys.default')})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.tags')}>
              <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('new.tagsPlaceholder')} />
            </Field>
          </section>
        </div>
      </Dialog>
    </div>
  );
}

function MechCard({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={clsx('flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors', checked ? 'border-accent/50 bg-accent-soft/50' : 'border-line-strong hover:bg-surface-2')}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        <div className="mt-0.5 text-xs text-ink-2">{desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </label>
  );
}

function CustomBudget({ value, onChange }: { value: BudgetLimits; onChange: (b: BudgetLimits) => void }) {
  const { t } = useI18n();
  const fields = useMemo(
    () =>
      [
        ['max_research_rounds', t('budget.rounds'), 1],
        ['max_review_rounds', t('budget.reviews'), 1],
        ['max_tool_calls', t('budget.toolCalls'), 5],
        ['max_llm_tokens', t('budget.tokens'), 50000],
        ['max_seconds', `${t('budget.seconds')} (s)`, 60],
        ['max_cost_usd', `${t('budget.cost')} ($)`, 0.1],
        ['reserve_ratio', t('budget.reserve'), 0.05],
      ] as [keyof BudgetLimits, string, number][],
    [t],
  );
  return (
    <div className="grid gap-3 rounded-lg bg-surface-2 p-3 sm:grid-cols-4">
      {fields.map(([k, label, step]) => (
        <Field key={k} label={<span className="text-xs">{label}</span>}>
          <TextInput
            type="number"
            min={0}
            step={step}
            value={value[k] ?? ''}
            onChange={(e) => onChange({ ...value, [k]: e.target.value === '' ? null : Number(e.target.value) })}
            className="tnum h-8"
          />
        </Field>
      ))}
    </div>
  );
}
