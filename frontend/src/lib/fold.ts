/**
 * 事件折叠：把 RunEvent 依次应用到 RunDetail 上，严格实现 docs/api-contract.md §3.2。
 * 前端实时视图与 mock 后端共用这一实现，保证"快照 = 事件折叠"。
 * 所有函数均为不可变更新（返回新对象），便于 React 渲染。
 */
import type { RunDetail, RunEvent, RunSummary } from '../api/types.ts';

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** 由 RunSummary 构造一个空的 RunDetail（运行刚创建时的快照） */
export function emptyDetail(summary: RunSummary): RunDetail {
  return {
    ...summary,
    task: null,
    clarification: null,
    research_round: 0,
    review_round: 0,
    plans: [],
    actions: [],
    tool_calls: [],
    documents: [],
    origin_groups: [],
    evidence: [],
    claims: [],
    timeline: [],
    gaps: [],
    decisions: [],
    report: null,
    reviews: [],
    error: null,
    last_event_seq: 0,
  };
}

export function toSummary(d: RunDetail): RunSummary {
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    phase: d.phase,
    request: d.request,
    budget: d.budget,
    usage: d.usage,
    created_at: d.created_at,
    started_at: d.started_at,
    finished_at: d.finished_at,
    stop_reason: d.stop_reason,
    counts: d.counts,
  };
}

export function applyEvent(run: RunDetail, ev: RunEvent): RunDetail {
  // 重复或乱序事件直接忽略（断线重连时可能收到）
  if (ev.seq <= run.last_event_seq) return run;
  const r: RunDetail = { ...run, last_event_seq: ev.seq };

  switch (ev.type) {
    case 'run.status':
      r.status = ev.data.status;
      r.phase = ev.data.phase;
      // 恢复运行时重新进入 queued：清除上次中断留下的错误
      if (ev.data.status === 'queued') r.error = null;
      if (ev.data.status === 'running' && !r.started_at) r.started_at = ev.ts;
      break;
    case 'step.started':
      r.phase = ev.data.step;
      if (ev.data.step === 'plan') r.research_round = ev.data.round;
      if (ev.data.step === 'review') r.review_round = ev.data.round;
      break;
    case 'step.completed':
      break;
    case 'task.assessed':
      r.task = ev.data;
      r.title = ev.data.event_name;
      break;
    case 'clarification.requested':
      r.clarification = ev.data;
      break;
    case 'clarification.answered':
      r.clarification = null;
      break;
    case 'question.updated':
      if (r.task) r.task = { ...r.task, questions: upsert(r.task.questions, ev.data) };
      break;
    case 'plan.created':
      r.plans = [...r.plans, ev.data];
      break;
    case 'action.upserted':
      r.actions = upsert(r.actions, ev.data);
      break;
    case 'tool.called':
      r.tool_calls = [...r.tool_calls, ev.data];
      break;
    case 'document.added':
      r.documents = [...r.documents, ev.data];
      r.counts = { ...r.counts, documents: r.counts.documents + 1 };
      break;
    case 'origin_group.upserted': {
      const g = ev.data;
      r.origin_groups = upsert(r.origin_groups, g);
      const ids = new Set(g.document_ids);
      r.documents = r.documents.map((d) => (ids.has(d.id) ? { ...d, origin_group_id: g.id } : d));
      break;
    }
    case 'evidence.added':
      r.evidence = [...r.evidence, ev.data];
      break;
    case 'claim.upserted':
      r.claims = upsert(r.claims, ev.data);
      r.counts = { ...r.counts, claims: r.claims.length };
      break;
    case 'timeline.upserted':
      r.timeline = upsert(r.timeline, ev.data).sort((a, b) =>
        a.date.start < b.date.start ? -1 : a.date.start > b.date.start ? 1 : 0,
      );
      r.counts = { ...r.counts, timeline_entries: r.timeline.length };
      break;
    case 'timeline.removed':
      r.timeline = r.timeline.filter((t) => t.id !== ev.data.id);
      r.counts = { ...r.counts, timeline_entries: r.timeline.length };
      break;
    case 'gap.upserted':
      r.gaps = upsert(r.gaps, ev.data);
      r.counts = {
        ...r.counts,
        open_gaps: r.gaps.filter((g) => g.status === 'open' || g.status === 'in_progress').length,
      };
      break;
    case 'decision.made':
      r.decisions = [...r.decisions, ev.data];
      break;
    case 'budget.updated':
      r.usage = ev.data;
      break;
    case 'report.updated':
      r.report = ev.data;
      break;
    case 'review.completed':
      r.reviews = [...r.reviews, ev.data];
      break;
    case 'log':
      break;
    case 'run.finished':
      r.status = ev.data.status;
      r.stop_reason = ev.data.stop_reason;
      r.finished_at = ev.data.finished_at;
      r.phase = null;
      break;
    case 'run.error':
      r.error = ev.data;
      break;
    default: {
      // 穷尽检查：契约新增事件类型时这里会报类型错误
      const _never: never = ev;
      void _never;
    }
  }
  return r;
}

export const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
