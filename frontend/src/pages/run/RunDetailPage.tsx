/** 运行详情页：头部信息与操作、左栏（工作流 / 预算 / 活动日志）、右侧标签页 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import { AlertOctagon, ArrowLeft, Ban, Download, FileJson, FileText, MessageCircleQuestion, MoreHorizontal, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useLiveRun, useRunActions } from '../../api/hooks.ts';
import { api } from '../../api/client.ts';
import { useI18n } from '../../i18n/index.tsx';
import { fmtDateTime, fmtDuration, runDuration } from '../../lib/format.ts';
import { isTerminal } from '../../lib/fold.ts';
import { Button, Card, ConfirmDialog, EmptyState, IconButton, Loading, Menu, SectionTitle, Tabs } from '../../components/ui.tsx';
import { ConditionTag, LiveDot, StatusBadge } from '../../components/badges.tsx';
import { RunProvider, type Focus, type RunTab } from './context.tsx';
import { WorkflowPanel } from './WorkflowPanel.tsx';
import { ActivityFeed, BudgetPanel } from './SidePanels.tsx';
import { ReportView } from './ReportView.tsx';
import { TimelineView } from './TimelineView.tsx';
import { ClaimsView } from './ClaimsView.tsx';
import { SourcesView } from './SourcesView.tsx';
import { ProcessView } from './ProcessView.tsx';
import { ClarificationDialog } from './ClarificationDialog.tsx';

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { run, events, connection, isLoading, error } = useLiveRun(runId);
  const actions = useRunActions(runId);
  const [tab, setTab] = useState<RunTab | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [, setTick] = useState(0);

  // 运行中每秒刷新一次耗时显示
  useEffect(() => {
    if (!run || isTerminal(run.status)) return;
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [run]);

  const goto = useCallback((tb: RunTab, f: Focus = null) => {
    setTab(tb);
    setFocus(f);
    // 宽屏下标签页内容区自己滚动；窄屏下整页滚动
    document.getElementById('run-content')?.scrollTo({ top: 0, behavior: 'smooth' });
    document.getElementById('main-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  if (isLoading) return <Loading label={t('common.loading')} />;
  if (error || !run)
    return (
      <div className="mx-auto max-w-xl px-5 py-16">
        <Card>
          <EmptyState icon={<AlertOctagon className="size-8" />} title={t('common.notFound')} hint={(error as Error | null)?.message} action={<Link to="/runs"><Button>{t('common.back')}</Button></Link>} />
        </Card>
      </div>
    );

  const terminal = isTerminal(run.status);
  const activeTab: RunTab = tab ?? (run.report ? 'report' : 'process');
  const live = connection === 'open' && !terminal;

  return (
    <RunProvider run={run} events={events} focus={focus} goto={goto}>
      {/* 宽屏：页面本身不滚动，头部固定，左栏与右侧内容各自滚动 */}
      <div className="flex flex-col lg:h-full lg:overflow-hidden">
        {/* 头部 */}
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-4 lg:px-7">
          <Link to="/runs" className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink">
            <ArrowLeft className="size-3.5" />
            {t('nav.runs')}
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-[min(100%,420px)] flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusBadge status={run.status} />
                <span className={clsx('inline-flex items-center gap-1.5 text-xs', live ? 'text-accent-text' : 'text-ink-3')}>
                  {live && <LiveDot />}
                  {connection !== 'idle' && t(`run.connection.${connection}`)}
                </span>
                <span className="font-mono text-xs text-ink-3">{run.id}</span>
              </div>
              <h1 className="text-[20px] leading-snug font-semibold tracking-tight">{run.title}</h1>
              {run.task && run.request.question !== run.title && <p className="mt-0.5 max-w-3xl text-sm text-ink-2">{run.request.question}</p>}
              <div className="tnum mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-ink-2">
                <span>
                  <span className="text-ink-3">{t('run.cutoff')} </span>
                  {fmtDateTime(run.request.cutoff, lang, { utc: true })} · {t(`mode.${run.request.temporal_mode}`)}
                </span>
                <ConditionTag mechanisms={run.request.mechanisms} withDesc />
                <span>
                  <span className="text-ink-3">{t('run.duration')} </span>
                  {fmtDuration(runDuration(run))}
                </span>
                <span className="uppercase">{run.request.report_language}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!terminal && (
                <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setConfirm('cancel')}>
                  {t('run.cancel')}
                </Button>
              )}
              {run.status === 'failed' && (
                <Button icon={<RotateCcw className="size-4" />} loading={actions.resume.isPending} onClick={() => actions.resume.mutate()}>
                  {t('run.resume')}
                </Button>
              )}
              <Menu
                trigger={(p) => (
                  <Button icon={<Download className="size-4" />} {...p}>
                    {t('run.export')}
                  </Button>
                )}
                items={[
                  { label: t('run.exportMd'), icon: <FileText className="size-4" />, href: api.exportUrl(run.id, 'md'), onSelect: () => {} },
                  { label: t('run.exportJson'), icon: <FileJson className="size-4" />, href: api.exportUrl(run.id, 'json'), onSelect: () => {} },
                ]}
              />
              <Menu
                trigger={(p) => (
                  <IconButton label="More" {...p}>
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                )}
                items={[
                  { label: t('run.rerun'), icon: <RefreshCw className="size-4" />, onSelect: () => navigate('/', { state: { request: run.request } }) },
                  { label: t('run.delete'), icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setConfirm('delete') },
                ]}
              />
            </div>
          </div>
          {actions.resume.error && <div className="mt-3 text-sm text-critical-text">{(actions.resume.error as Error).message}</div>}

        {run.error && (
          <div className="mt-3 flex gap-3 rounded-xl border border-critical/30 bg-critical-soft px-4 py-3 text-sm">
            <AlertOctagon className="mt-0.5 size-4 shrink-0 text-critical-text" />
            <div>
              <div className="font-semibold text-critical-text">
                {t('run.error')} · <span className="font-mono text-xs">{run.error.type}</span>
              </div>
              <div className="text-ink-2">{run.error.message}</div>
            </div>
          </div>
        )}
        {run.status === 'awaiting_clarification' && run.clarification && (
          <div className="mt-3 flex items-center gap-3 rounded-xl border border-warn/50 bg-warn-soft px-4 py-3 text-sm">
            <MessageCircleQuestion className="size-4 shrink-0 text-warn-text" />
            <span className="font-medium text-warn-text">{t('run.awaiting')}</span>
          </div>
        )}

        </div>

        <div className="grid lg:min-h-0 lg:flex-1 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="order-2 flex flex-col gap-5 border-line px-5 py-5 lg:order-none lg:overflow-y-auto lg:border-r lg:px-5">
            <Card padded={false} className="py-4">
              <div className="px-5">
                <SectionTitle>{t('run.workflow')}</SectionTitle>
              </div>
              <WorkflowPanel />
            </Card>
            <Card>
              <SectionTitle>{t('run.budget')}</SectionTitle>
              <BudgetPanel />
            </Card>
            <ActivityFeed />
          </aside>

          <section className="order-1 flex min-w-0 flex-col lg:order-none lg:min-h-0">
            <Tabs
              className="shrink-0 px-5 lg:px-7"
              value={activeTab}
              onChange={(v) => goto(v)}
              tabs={[
                { value: 'report', label: t('run.tab.report'), dot: !terminal && (run.phase === 'write' || run.phase === 'review') },
                { value: 'timeline', label: t('run.tab.timeline'), count: run.timeline.length || null },
                { value: 'claims', label: t('run.tab.claims'), count: run.claims.length || null },
                { value: 'sources', label: t('run.tab.sources'), count: run.documents.length || null },
                { value: 'process', label: t('run.tab.process'), dot: !terminal && !!run.phase && run.phase !== 'write' && run.phase !== 'review' },
              ]}
            />
            <div id="run-content" className="px-5 py-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-7">
              <div className="mx-auto max-w-[1080px]">
                {activeTab === 'report' && <ReportView />}
                {activeTab === 'timeline' && <TimelineView />}
                {activeTab === 'claims' && <ClaimsView />}
                {activeTab === 'sources' && <SourcesView />}
                {activeTab === 'process' && <ProcessView />}
              </div>
            </div>
          </section>
        </div>
      </div>

      {run.status === 'awaiting_clarification' && run.clarification && (
        <ClarificationDialog key={run.clarification.id} request={run.clarification} submitting={actions.clarify.isPending} onSubmit={(answers) => actions.clarify.mutate({ answers })} />
      )}
      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        title={t('run.cancel')}
        body={t('run.cancelConfirm')}
        confirmLabel={t('run.cancel')}
        cancelLabel={t('common.back')}
        danger
        loading={actions.cancel.isPending}
        onConfirm={() => actions.cancel.mutate(undefined, { onSettled: () => setConfirm(null) })}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title={t('run.delete')}
        body={t('run.deleteConfirm')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={actions.remove.isPending}
        onConfirm={() => actions.remove.mutate(undefined, { onSuccess: () => navigate('/runs') })}
      />
    </RunProvider>
  );
}
