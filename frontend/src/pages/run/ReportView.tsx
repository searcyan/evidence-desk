/** 报告视图：逐句引用（悬停/点击查看原文）、审查问题标注、未解决问题、引用列表 */
import { Fragment } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CircleDashed, ExternalLink, FileText, HelpCircle, Loader2, ShieldCheck } from 'lucide-react';
import type { ReportParagraph, ReportSentence, ReviewFinding } from '../../api/types.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtDate, fmtDateTime } from '../../lib/format.ts';
import { isTerminal } from '../../lib/fold.ts';
import { Badge, Card, EmptyState, Popover } from '../../components/ui.tsx';
import { VerdictBadge } from '../../components/badges.tsx';
import { useRun } from './context.tsx';
import { DocMeta, EvidenceCard } from './EvidenceCard.tsx';

function Citation({ evId }: { evId: string }) {
  const { t } = useI18n();
  const { citeNum, evidence, claimsByEvidence } = useRun();
  const n = citeNum.get(evId);
  const ev = evidence(evId);
  if (!ev) return null;
  const claims = claimsByEvidence.get(evId) ?? [];
  return (
    <Popover
      width={400}
      trigger={
        <button className="tnum rounded-[3px] px-[2px] text-[10.5px] leading-none font-semibold text-accent-text transition-colors hover:bg-accent hover:text-accent-ink">
          {n}
        </button>
      }
    >
      <EvidenceCard evidence={ev} className="border-0 bg-transparent p-0" />
      {claims.length > 0 && (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{t('report.claim')}</div>
          <div className="flex flex-col gap-1.5">
            {claims.slice(0, 3).map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-[13px]">
                <VerdictBadge verdict={c.verdict} compact />
                <span className="text-ink-2">{c.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

function Sentence({ s, findings }: { s: ReportSentence; findings: ReviewFinding[] }) {
  const { t } = useI18n();
  const open = findings.filter((f) => f.status === 'open');
  // 句末最后一个字与引用上标不换行分开，避免引用编号单独落到下一行
  const cites = s.evidence_ids.length > 0;
  const head = cites ? s.text.slice(0, -1) : s.text;
  const sup = cites && (
    <span className="whitespace-nowrap">
      {s.text.slice(-1)}
      <sup className="ml-px">
        {s.evidence_ids.map((e, i) => (
          <Fragment key={e}>
            {i > 0 && <span className="text-[10px] text-ink-3">,</span>}
            <Citation evId={e} />
          </Fragment>
        ))}
      </sup>
    </span>
  );
  const text = (
    <span
      className={clsx(
        'rounded-sm transition-colors hover:bg-surface-3/70',
        open.length > 0 && 'underline decoration-serious decoration-wavy decoration-1 underline-offset-4',
      )}
    >
      {head}
    </span>
  );
  return (
    <>
      {open.length > 0 ? (
        <Popover width={320} trigger={text}>
          {open.map((f) => (
            <div key={f.id} className="flex gap-2 text-[13px]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-serious-text" />
              <div>
                <div className="font-medium">
                  {t(`report.finding.${f.type}`)} · {t(`report.severity.${f.severity}`)}
                </div>
                <div className="text-ink-2">{f.description}</div>
              </div>
            </div>
          ))}
        </Popover>
      ) : (
        text
      )}
      {sup}{' '}
    </>
  );
}

function Paragraph({ p, findingsBySentence, className }: { p: ReportParagraph; findingsBySentence: Map<string, ReviewFinding[]>; className?: string }) {
  return (
    <p className={clsx('leading-[1.8]', className)}>
      {p.sentences.map((s) => (
        <Sentence key={s.id} s={s} findings={findingsBySentence.get(s.id) ?? []} />
      ))}
    </p>
  );
}

/** 部分报告的原因归类：预算 / 时间截断、没有可核实的答案、其他 */
function partialKind(reason: string | null | undefined) {
  if (reason === 'budget_exhausted' || reason === 'time_limit') return 'budget';
  if (reason === 'review_unresolved') return 'unverified';
  return 'other';
}

export function ReportView() {
  const { t, lang } = useI18n();
  const { run, citeNum, docOfEvidence, evidence } = useRun();
  const r = run.report;

  if (!r) {
    const live = !isTerminal(run.status);
    return (
      <Card>
        <EmptyState
          icon={live ? <Loader2 className="size-8 animate-spin" /> : <FileText className="size-8" />}
          title={live ? (run.research_round > 0 ? t('run.researching', { n: run.research_round }) : t(`status.${run.status}`)) : t('run.noReport')}
          hint={live ? t('run.noReportYet') : run.error?.message}
        />
      </Card>
    );
  }

  const lastReview = run.reviews[run.reviews.length - 1];
  const findingsBySentence = new Map<string, ReviewFinding[]>();
  if (lastReview) for (const f of lastReview.findings) if (f.sentence_id) findingsBySentence.set(f.sentence_id, [...(findingsBySentence.get(f.sentence_id) ?? []), f]);
  // 收尾时后端会删去未通过核查的句子：徽章只看仍留在报告里的中 / 高严重度问题
  const shown = new Set([r.answer, ...r.sections.flatMap((s) => s.paragraphs)].flatMap((p) => p.sentences.map((s) => s.id)));
  const reviewOk =
    !!lastReview &&
    (lastReview.passed ||
      (isTerminal(run.status) &&
        !lastReview.findings.some((f) => f.status === 'open' && f.severity !== 'low' && (f.sentence_id === null || shown.has(f.sentence_id)))));
  const refs = [...citeNum.entries()].sort((a, b) => a[1] - b[1]);
  const answerSources = new Set(r.answer.sentences.flatMap((s) => s.evidence_ids).map((e) => docOfEvidence(e)?.id).filter(Boolean)).size;
  const writing = !isTerminal(run.status) && (run.phase === 'write' || run.phase === 'review');

  return (
    <div className="flex flex-col gap-5">
      {r.is_partial && (
        <div className="flex gap-3 rounded-xl border border-serious/40 bg-serious-soft px-4 py-3 text-sm">
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-serious-text" />
          <div>
            <div className="font-semibold text-serious-text">{t(`run.partial.${partialKind(r.stop_reason ?? run.stop_reason)}`)}</div>
            <div className="text-ink-2">{t(`run.partialHint.${partialKind(r.stop_reason ?? run.stop_reason)}`)}</div>
          </div>
        </div>
      )}

      <Card className="px-6 py-7 sm:px-10 sm:py-9" padded={false}>
        <article lang={r.language === 'zh' ? 'zh-CN' : 'en'} className="mx-auto max-w-[70ch] text-[15px] text-ink">
          <div className="tnum flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            <span>{t('report.version', { n: r.version })}</span>
            <span aria-hidden>·</span>
            <span>{fmtDateTime(r.generated_at, lang)}</span>
            {lastReview && (
              <>
                <span aria-hidden>·</span>
                <span className={clsx('inline-flex items-center gap-1 font-medium', reviewOk ? 'text-good-text' : 'text-serious-text')}>
                  {reviewOk ? <ShieldCheck className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                  {reviewOk ? t('report.verified') : t('report.reviewFailed')}
                </span>
              </>
            )}
            {writing && (
              <Badge tone="accent">
                <Loader2 className="size-3 animate-spin" />
                {t(`phase.${run.phase!}`)}
              </Badge>
            )}
          </div>
          <h2 className="mt-3 text-[24px] leading-snug font-semibold tracking-tight">{r.title}</h2>

          {/* 结论区：编辑排版风格，不用色块，靠字号、字重、留白与一条细强调线拉开层级 */}
          <section aria-label={t('report.answer')} className="mt-8 mb-10">
            <div className="mb-3 flex items-baseline gap-3">
              <span className="text-[11px] font-semibold tracking-[0.18em] text-accent-text uppercase">{t('report.answer')}</span>
              <span className="h-px flex-1 translate-y-[-3px] bg-line" />
              <span className="tnum text-[11px] text-ink-3">{t('report.answerMeta', { n: answerSources, date: fmtDate(run.request.cutoff, lang) })}</span>
            </div>
            <div className="border-l-2 border-accent pl-5">
              <Paragraph p={r.answer} findingsBySentence={findingsBySentence} className="text-[18.5px] leading-[1.75] font-medium tracking-[-0.005em] text-ink" />
            </div>
          </section>

          {r.sections.map((s) => (
            <section key={s.id} className="mt-7">
              <h3 className={clsx('mb-2 text-[17px] font-semibold', s.kind === 'uncertainty' && 'flex items-center gap-1.5')}>
                {s.kind === 'uncertainty' && <AlertTriangle className="size-4 text-serious-text" />}
                {s.title}
              </h3>
              {s.paragraphs.map((p) => (
                <Paragraph key={p.id} p={p} findingsBySentence={findingsBySentence} className="mb-3 text-ink" />
              ))}
            </section>
          ))}

          {r.open_questions.length > 0 && (
            <section className="mt-8 rounded-xl bg-surface-2 px-5 py-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <HelpCircle className="size-4 text-ink-3" />
                {t('report.openQuestions')}
              </h3>
              <ul className="space-y-1.5 text-[14px] text-ink-2">
                {r.open_questions.map((q, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-[9px] size-1 shrink-0 rounded-full bg-ink-3" />
                    <span>{q}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="mt-6 text-xs text-ink-3">{t('report.citationHint')}</p>
        </article>
      </Card>

      {refs.length > 0 && (
        <Card>
          <h3 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-2 uppercase">{t('report.references')}</h3>
          <ol className="flex flex-col gap-2.5">
            {refs.map(([evId, n]) => {
              const d = docOfEvidence(evId);
              const ev = evidence(evId);
              if (!d || !ev) return null;
              return (
                <Fragment key={evId}>
                  <li className="flex gap-3 text-sm">
                    <span className="tnum w-6 shrink-0 text-right font-semibold text-accent-text">[{n}]</span>
                    <div className="min-w-0">
                      <a href={d.url} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-1 font-medium hover:text-accent-text">
                        <span className="truncate">{d.title}</span>
                        <ExternalLink className="size-3 shrink-0 opacity-50 group-hover:opacity-100" />
                      </a>
                      <DocMeta doc={d} compact />
                      <div className="mt-0.5 line-clamp-1 text-xs text-ink-3">
                        “{ev.quote}” · {d.published_at ? fmtDate(d.published_at, lang) : ''}
                      </div>
                    </div>
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}
