/**
 * mock 演示场景：虚构事件"Northwind Robotics 收购 Helios Sensors"（公司、网站均为虚构）。
 * 刻意覆盖提案中的各类难点：同源转载、只精确到月的日期、把"美国审批通过"误报为"交易完成"的冲突、
 * 被时间窗口截断的背景、截止时间之后的报道、审查发现引用不支持并修复。
 *
 * 场景产出一个按时间排列的事件脚本（ScriptItem[]），由 store.ts 负责回放。
 */
import type {
  BudgetLimits,
  BudgetUsage,
  Claim,
  ClaimEvidenceLink,
  DateRef,
  Decision,
  DecisionSignals,
  Evidence,
  Gap,
  Lang,
  OriginGroup,
  Report,
  ReportParagraph,
  ResearchAction,
  ReviewFinding,
  RunEvent,
  RunRequest,
  SourceDocument,
  SubQuestion,
  TaskSpec,
  TimelineEntry,
  ToolCall,
  Verdict,
} from '../src/api/types.ts';

type EventOf<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;
export type ScriptItem =
  | { kind: 'event'; delay: number; type: RunEvent['type']; data: unknown; at: number }
  | { kind: 'pause' };

export const DEMO_CUTOFF = '2024-06-30T23:59:59Z';
export const DEMO_QUESTION_EN =
  'Has Northwind Robotics completed its acquisition of Helios Sensors, and which approvals were still pending?';
export const DEMO_QUESTION_ZH = 'Northwind Robotics 对 Helios Sensors 的收购完成了吗？还有哪些审批没有通过？';

// ───────────────────────── 脚本构造器 ─────────────────────────

class Script {
  items: ScriptItem[] = [];
  private t = 0;
  private pending = 0;
  usage: BudgetUsage = {
    research_rounds: 0,
    review_rounds: 0,
    search_calls: 0,
    read_calls: 0,
    llm_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    elapsed_seconds: 0,
  };
  private tc = 0;
  private start: number;
  constructor(start: number, initialUsage?: BudgetUsage) {
    this.start = start;
    if (initialUsage) this.usage = { ...initialUsage };
  }
  /** 当前虚拟时间对应的 ISO 时间戳 */
  now(): string {
    return new Date(this.start + this.t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  wait(ms: number) {
    this.t += ms;
    this.pending += ms;
  }
  emit<T extends RunEvent['type']>(type: T, data: EventOf<T>['data']) {
    this.items.push({ kind: 'event', delay: this.pending, type, data, at: this.start + this.t });
    this.pending = 0;
  }
  pause() {
    this.items.push({ kind: 'pause' });
  }
  /** 计入一次 LLM 调用，并发出 budget.updated */
  llm(inTok: number, outTok: number, ms = 900) {
    this.wait(ms);
    const u = this.usage;
    u.llm_calls += 1;
    u.input_tokens += inTok;
    u.output_tokens += outTok;
    u.cost_usd = round4(u.input_tokens * 0.27e-6 + u.output_tokens * 1.1e-6);
    u.elapsed_seconds = Math.round(this.t / 1000);
    this.emit('budget.updated', { ...u });
  }
  tool(actionId: string | null, tool: 'search' | 'read', provider: ToolCall['provider'], input: string, count: number | null, ms = 700, ok = true, error: string | null = null) {
    this.wait(ms);
    this.tc += 1;
    if (tool === 'search') this.usage.search_calls += 1;
    else this.usage.read_calls += 1;
    this.usage.elapsed_seconds = Math.round(this.t / 1000);
    this.emit('tool.called', {
      id: `tc_${String(this.tc).padStart(3, '0')}`,
      action_id: actionId,
      tool,
      provider,
      input,
      ok,
      result_count: count,
      duration_ms: ms,
      cached: false,
      error,
      at: this.now(),
    });
    this.emit('budget.updated', { ...this.usage });
  }
  log(message: string, level: 'info' | 'warning' | 'error' | 'debug' = 'info') {
    this.emit('log', { level, message });
  }
  step<T>(step: EventOf<'step.started'>['data']['step'], round: number, fn: () => T): T {
    const t0 = this.t;
    this.emit('step.started', { step, round });
    const r = fn();
    this.wait(150);
    this.emit('step.completed', { step, round, duration_ms: this.t - t0 });
    return r;
  }
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

const day = (d: string, text: string | null = null): DateRef => ({ start: d, end: d, precision: 'day', text });
const month = (m: string, text: string | null = null): DateRef => {
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { start: `${m}-01`, end: `${m}-${String(last).padStart(2, '0')}`, precision: 'month', text };
};

// ───────────────────────── 场景素材 ─────────────────────────

interface DocSeed {
  id: string;
  url: string;
  title: string;
  domain: string;
  publisher: string;
  published_at: string;
  original: boolean;
  attribution: string | null;
  snippet: string;
}

const DOCS: Record<string, DocSeed> = {
  d1: { id: 'doc_01', url: 'https://newsroom.northwind-robotics.example/2024/01/15/northwind-to-acquire-helios', title: 'Northwind Robotics to Acquire Helios Sensors for $2.1 Billion', domain: 'newsroom.northwind-robotics.example', publisher: 'Northwind Robotics', published_at: '2024-01-15T13:00:00Z', original: true, attribution: null, snippet: 'Northwind Robotics today announced it has entered into a definitive agreement to acquire Helios Sensors…' },
  d2: { id: 'doc_02', url: 'https://globalwire.example/business/northwind-helios-deal', title: 'Northwind Robotics agrees to buy Helios Sensors in $2.1 billion deal', domain: 'globalwire.example', publisher: 'GlobalWire', published_at: '2024-01-15T14:12:00Z', original: false, attribution: 'Northwind Robotics press release', snippet: 'Northwind Robotics has agreed to buy Helios Sensors for about $2.1 billion in cash, the company said on Monday…' },
  d3: { id: 'doc_03', url: 'https://marketbeat-daily.example/m-and-a/northwind-helios', title: 'Northwind to buy Helios Sensors for $2.1B', domain: 'marketbeat-daily.example', publisher: 'MarketBeat Daily', published_at: '2024-01-16T07:40:00Z', original: false, attribution: 'GlobalWire', snippet: 'Northwind Robotics has agreed to buy Helios Sensors for about $2.1 billion in cash…' },
  d4: { id: 'doc_04', url: 'https://techjournal.example/2024/01/16/helios-acquisition-what-we-know', title: 'Helios Sensors acquisition: what we know', domain: 'techjournal.example', publisher: 'TechJournal', published_at: '2024-01-16T10:05:00Z', original: false, attribution: 'Northwind Robotics press release', snippet: 'According to the company announcement, the all-cash transaction is valued at roughly $2.1 billion…' },
  d5: { id: 'doc_05', url: 'https://eurobiz.example/competition/northwind-helios-closer-look', title: 'EU regulators take a closer look at Northwind–Helios deal', domain: 'eurobiz.example', publisher: 'EuroBiz', published_at: '2024-05-02T09:30:00Z', original: false, attribution: null, snippet: 'In March, the European Commission opened an in-depth investigation into the deal…' },
  d6: { id: 'doc_06', url: 'https://techledger.example/deals/northwind-closes-helios', title: 'Northwind closes Helios purchase', domain: 'techledger.example', publisher: 'TechLedger', published_at: '2024-04-05T16:20:00Z', original: false, attribution: null, snippet: 'Northwind has completed its purchase of Helios Sensors after clearing its final regulatory hurdle…' },
  d7: { id: 'doc_07', url: 'https://newsroom.northwind-robotics.example/2024/07/09/northwind-completes-helios', title: 'Northwind Robotics Completes Acquisition of Helios Sensors', domain: 'newsroom.northwind-robotics.example', publisher: 'Northwind Robotics', published_at: '2024-07-09T12:00:00Z', original: true, attribution: null, snippet: 'Northwind Robotics today announced that it has completed its acquisition of Helios Sensors…' },
  d8: { id: 'doc_08', url: 'https://ec-press.example/presscorner/2024/03/18/ip-24-1520', title: 'Commission opens in-depth investigation into proposed acquisition of Helios Sensors by Northwind Robotics', domain: 'ec-press.example', publisher: 'European Commission (press corner)', published_at: '2024-03-18T10:00:00Z', original: true, attribution: null, snippet: 'The European Commission has opened an in-depth investigation to assess the proposed acquisition…' },
  d9: { id: 'doc_09', url: 'https://harborft.example/companies/tech/northwind-advanced-talks-helios', title: 'Northwind in advanced talks to buy sensor maker Helios', domain: 'harborft.example', publisher: 'Harbor Financial Times', published_at: '2023-11-08T18:45:00Z', original: false, attribution: 'people familiar with the matter', snippet: 'Northwind Robotics is in advanced talks to acquire Helios Sensors, according to people familiar…' },
  d10: { id: 'doc_10', url: 'https://antitrustwatch.example/us/hsr-waiting-period-northwind-helios', title: 'US waiting period expires for Northwind–Helios deal', domain: 'antitrustwatch.example', publisher: 'AntitrustWatch', published_at: '2024-04-03T08:15:00Z', original: false, attribution: 'FTC early termination notices', snippet: 'The waiting period under the Hart-Scott-Rodino Act expired on April 2…' },
  d11: { id: 'doc_11', url: 'https://globalwire.example/business/helios-shareholders-approve', title: 'Helios shareholders approve Northwind takeover', domain: 'globalwire.example', publisher: 'GlobalWire', published_at: '2024-02-20T19:02:00Z', original: false, attribution: null, snippet: 'Helios shareholders voted overwhelmingly on Tuesday to approve the takeover…' },
  d12: { id: 'doc_12', url: 'https://ec-press.example/presscorner/2024/06/12/ip-24-3311', title: 'Commission clears acquisition of Helios Sensors by Northwind Robotics, subject to conditions', domain: 'ec-press.example', publisher: 'European Commission (press corner)', published_at: '2024-06-12T11:00:00Z', original: true, attribution: null, snippet: 'The European Commission has approved, under the EU Merger Regulation, the proposed acquisition…' },
  d13: { id: 'doc_13', url: 'https://eurobiz.example/competition/eu-approves-northwind-helios-remedies', title: "EU approves Northwind's Helios deal with licensing remedies", domain: 'eurobiz.example', publisher: 'EuroBiz', published_at: '2024-06-12T15:30:00Z', original: false, attribution: 'European Commission', snippet: "Under the remedies, Northwind must license Helios' lidar patents to rival manufacturers…" },
  d14: { id: 'doc_14', url: 'https://newsroom.northwind-robotics.example/2024/06/13/northwind-welcomes-eu-approval', title: 'Northwind Welcomes EU Approval of Helios Acquisition', domain: 'newsroom.northwind-robotics.example', publisher: 'Northwind Robotics', published_at: '2024-06-13T09:00:00Z', original: true, attribution: null, snippet: 'With all required regulatory approvals now obtained, Northwind expects the transaction to close in the third quarter…' },
};

const EVIDENCE: Record<string, { doc: keyof typeof DOCS; quote: string; date: DateRef | null }> = {
  e1: { doc: 'd1', quote: 'Northwind Robotics today announced it has entered into a definitive agreement to acquire Helios Sensors in an all-cash transaction valued at approximately $2.1 billion.', date: day('2024-01-15', 'today') },
  e2: { doc: 'd1', quote: 'The transaction is expected to close in the second half of 2024, subject to regulatory approvals and approval by Helios shareholders.', date: null },
  e3: { doc: 'd2', quote: 'Northwind Robotics has agreed to buy Helios Sensors for about $2.1 billion in cash, the company said on Monday.', date: day('2024-01-15', 'on Monday') },
  e4: { doc: 'd5', quote: 'In March, the European Commission opened an in-depth investigation into the deal, citing concerns about the supply of lidar components.', date: month('2024-03', 'In March') },
  e5: { doc: 'd5', quote: 'The review is ongoing, and a decision is not expected before June.', date: day('2024-05-02') },
  e6: { doc: 'd6', quote: 'Northwind has completed its purchase of Helios Sensors after clearing its final regulatory hurdle in the United States.', date: month('2024-04') },
  e7: { doc: 'd7', quote: 'Northwind Robotics today announced that it has completed its acquisition of Helios Sensors.', date: day('2024-07-09', 'today') },
  e8: { doc: 'd8', quote: 'The European Commission has opened an in-depth investigation to assess the proposed acquisition of Helios Sensors by Northwind Robotics.', date: day('2024-03-18') },
  e9: { doc: 'd9', quote: 'Northwind Robotics is in advanced talks to acquire Helios Sensors, according to people familiar with the matter.', date: day('2023-11-08') },
  e10: { doc: 'd10', quote: "The waiting period under the Hart-Scott-Rodino Act expired on April 2, clearing the deal in the United States. The European Commission's review remains pending.", date: day('2024-04-02', 'April 2') },
  e11: { doc: 'd11', quote: 'Helios shareholders voted overwhelmingly on Tuesday to approve the takeover by Northwind Robotics.', date: day('2024-02-20', 'on Tuesday') },
  e12: { doc: 'd12', quote: 'The European Commission has approved, under the EU Merger Regulation, the proposed acquisition of Helios Sensors by Northwind Robotics. The approval is conditional on full compliance with commitments offered by Northwind.', date: day('2024-06-12') },
  e13: { doc: 'd13', quote: "Under the remedies, Northwind must license Helios' lidar patents to rival manufacturers on fair terms for ten years.", date: day('2024-06-12') },
  e14: { doc: 'd14', quote: 'With all required regulatory approvals now obtained, Northwind expects the transaction to close in the third quarter of 2024.', date: day('2024-06-13') },
};

const evId = (k: string) => `ev_${k.slice(1).padStart(2, '0')}`;

// ───────────────────────── 场景构建 ─────────────────────────

export interface ScenarioOptions {
  req: RunRequest;
  budget: BudgetLimits;
  start: number;
  /** 失败演示：在第 1 轮 collect 中途报错 */
  failAt?: 'collect';
  /** 取消演示：第 2 轮开始时取消 */
  cancelAt?: 'round2';
}

/** 是否需要先澄清：问题过短（英文少于 4 个词且中文少于 8 个字） */
export function needsClarification(q: string): boolean {
  const words = q.trim().split(/\s+/).filter(Boolean).length;
  const cjk = (q.match(/[一-鿿]/g) ?? []).length;
  return words < 4 && cjk < 8;
}

export function buildScenario(opts: ScenarioOptions): ScriptItem[] {
  const { req, start } = opts;
  const lang: Lang = req.report_language;
  const L = (en: string, zh: string) => (lang === 'zh' ? zh : en);
  const src = req.mechanisms.source_verification;
  const tmp = req.mechanisms.temporal_planning;
  const asOf = req.temporal_mode === 'as_of';
  const small = req.budget_preset === 'small';
  const s = new Script(start);
  const cutoff = DEMO_CUTOFF;

  // 实体状态（用于构造 upsert 事件）
  const docs = new Map<string, SourceDocument>();
  const claims = new Map<string, Claim>();
  const gaps = new Map<string, Gap>();
  const questions = new Map<string, SubQuestion>();
  let actionSeq = 0;
  let decisionSeq = 0;
  const groupOf = new Map<string, string>(); // doc key -> group id

  s.emit('run.status', { status: 'running', phase: 'assess' });
  s.log(L('Run started. Mock backend: this demo always narrates a fictional acquisition.', '运行开始。当前为 mock 后端：演示始终讲述一个虚构的收购事件。'));

  // ── assess ──
  const clarify = needsClarification(req.question);
  s.step('assess', 0, () => {
    if (req.seed_url) {
      s.tool(null, 'read', 'http', req.seed_url, 1, 600);
    }
    s.llm(2600, 700, 1400);
    if (clarify) {
      s.emit('clarification.requested', {
        id: 'clr_1',
        questions: [
          {
            id: 'cq_1',
            text: L('Which acquisition are you asking about?', '你问的是哪一起收购？'),
            options: ['Northwind Robotics – Helios Sensors (2024)', L('Another deal (please specify)', '其他交易（请说明）')],
          },
          {
            id: 'cq_2',
            text: L('Should the status be assessed at the cutoff you set, or with hindsight?', '状态按你设定的截止时间判断，还是允许事后回溯？'),
            options: [L('At the cutoff (as of)', '按截止时间（as of）'), L('With hindsight', '允许回溯')],
          },
        ],
        asked_at: s.now(),
      });
      s.emit('run.status', { status: 'awaiting_clarification', phase: 'assess' });
      s.pause();
      s.emit('clarification.answered', { answers: [] }); // 实际答案由 store 在回放时替换
      s.emit('run.status', { status: 'running', phase: 'assess' });
      s.llm(1800, 600, 1000);
    }
    const qs: SubQuestion[] = [
      { id: 'q_1', text: L('Had the acquisition been completed as of the cutoff? If not, what stage was it in?', '截至截止时间，收购是否已完成？若未完成，处于哪个阶段？'), priority: 'core', status: 'open', answer_claim_ids: [] },
      { id: 'q_2', text: L('Which regulatory and shareholder approvals had been obtained, and when?', '已经获得了哪些监管和股东批准，分别在什么时候？'), priority: 'core', status: 'open', answer_claim_ids: [] },
      { id: 'q_3', text: L('When and on what terms was the deal announced?', '交易何时宣布，条款是什么？'), priority: 'supporting', status: 'open', answer_claim_ids: [] },
      { id: 'q_4', text: L('What preceded the announcement?', '宣布之前发生了什么？'), priority: 'supporting', status: 'open', answer_claim_ids: [] },
    ];
    qs.forEach((q) => questions.set(q.id, q));
    const task: TaskSpec = {
      event_name: L("Northwind Robotics' acquisition of Helios Sensors", 'Northwind Robotics 收购 Helios Sensors'),
      event_type: 'acquisition',
      entities: ['Northwind Robotics', 'Helios Sensors', 'European Commission', 'US FTC'],
      questions: qs,
      cutoff,
      temporal_mode: req.temporal_mode,
      initial_window: tmp ? { start: '2024-01-01', end: '2024-06-30' } : { start: '2024-01-02', end: '2024-06-30' },
      stage_model: ['talks', 'announced', 'shareholder_approval', 'regulatory_review', 'regulatory_approval', 'closed'],
      assumptions: [
        L('"Completed" means the transaction has legally closed, not merely been approved.', '"完成"指交易已在法律上交割，而不仅是获批。'),
        L('Status is assessed using only information public by June 30, 2024.', '仅使用 2024 年 6 月 30 日前已公开的信息判断状态。'),
      ],
    };
    if (!asOf) task.assumptions[1] = L('Later publications may be used to reconstruct events up to the cutoff.', '可以使用之后发布的资料来重建截止时间之前的事件。');
    s.emit('task.assessed', task);
  });

  // ── 公共工具函数 ──
  const addDoc = (k: keyof typeof DOCS, round: number, actionId: string, provider: SourceDocument['provider'] = 'tavily') => {
    const d = DOCS[k];
    const available = d.published_at <= cutoff;
    const doc: SourceDocument = {
      id: d.id,
      url: d.url,
      title: d.title,
      domain: d.domain,
      publisher: d.publisher,
      author: null,
      published_at: d.published_at,
      published_at_source: d.original ? 'metadata' : 'search_api',
      retrieved_at: s.now(),
      provider,
      origin_group_id: null,
      is_original: src ? d.original : null,
      attribution: src ? d.attribution : null,
      available_at_cutoff: available,
      language: 'en',
      snippet: d.snippet,
      round,
      action_id: actionId,
    };
    docs.set(k, doc);
    s.tool(actionId, 'read', provider === 'exa' ? 'exa' : 'tavily', d.url, 1, 450);
    s.emit('document.added', doc);
    return doc;
  };
  const addEvidence = (k: keyof typeof EVIDENCE, round: number) => {
    const e = EVIDENCE[k];
    const ev: Evidence = { id: evId(k), document_id: DOCS[e.doc].id, quote: e.quote, event_date: tmp ? e.date : null, round };
    s.emit('evidence.added', ev);
  };
  const group = (id: string, label: string, keys: (keyof typeof DOCS)[], root: keyof typeof DOCS | null, reason: string) => {
    if (!src) return;
    keys.forEach((k) => groupOf.set(k, id));
    const g: OriginGroup = { id, label, root_document_id: root ? DOCS[root].id : null, document_ids: keys.map((k) => DOCS[k].id), reason };
    s.emit('origin_group.upserted', g);
  };
  /** 独立来源数：开启来源核实按来源组计，否则按文档计 */
  const indep = (evKeys: string[]) => {
    const docKeys = evKeys.map((e) => EVIDENCE[e].doc);
    return src ? new Set(docKeys.map((d) => groupOf.get(d) ?? d)).size : new Set(docKeys).size;
  };
  const upsertClaim = (
    id: string,
    round: number,
    fields: { text: string; stage: string | null; date: DateRef | null; qs: string[]; verdict: Verdict; rationale: string; links: [string, ClaimEvidenceLink['relation'], string?][]; applicable?: boolean | null },
    revisionReason?: string,
  ) => {
    const prev = claims.get(id);
    const supports = fields.links.filter((l) => l[1] === 'supports').map((l) => l[0]);
    const c: Claim = {
      id,
      text: fields.text,
      subject: 'Northwind Robotics',
      stage: tmp ? fields.stage : null,
      event_date: tmp ? fields.date : null,
      question_ids: fields.qs,
      verdict: fields.verdict,
      rationale: fields.rationale,
      links: fields.links.map(([e, relation, note]) => ({ evidence_id: evId(e), relation, note: note ?? null })),
      independent_sources: indep(supports),
      applicable_at_cutoff: fields.applicable === undefined ? true : fields.applicable,
      history: prev
        ? prev.verdict !== fields.verdict
          ? [...prev.history, { verdict: prev.verdict, reason: revisionReason ?? '', round: prev.updated_round, at: s.now() }]
          : prev.history
        : [],
      first_round: prev?.first_round ?? round,
      updated_round: round,
    };
    claims.set(id, c);
    s.emit('claim.upserted', c);
  };
  const tl = (e: TimelineEntry) => s.emit('timeline.upserted', e);
  const openGap = (g: Omit<Gap, 'status' | 'closed_round' | 'resolution'>) => {
    const full: Gap = { ...g, status: 'open', closed_round: null, resolution: null };
    gaps.set(g.id, full);
    s.emit('gap.upserted', full);
  };
  const closeGap = (id: string, round: number, status: 'resolved' | 'abandoned', resolution: string) => {
    const g = gaps.get(id);
    if (!g) return;
    const next: Gap = { ...g, status, closed_round: round, resolution, feasible: status === 'resolved' ? g.feasible : false };
    gaps.set(id, next);
    s.emit('gap.upserted', next);
  };
  const progressGap = (id: string) => {
    const g = gaps.get(id);
    if (!g) return;
    const next: Gap = { ...g, status: 'in_progress' };
    gaps.set(id, next);
    s.emit('gap.upserted', next);
  };
  const updQ = (id: string, status: SubQuestion['status'], claimIds: string[]) => {
    const q = { ...questions.get(id)!, status, answer_claim_ids: claimIds };
    questions.set(id, q);
    s.emit('question.updated', q);
  };
  const decide = (kind: Decision['kind'], round: number, reason: string, signals: DecisionSignals, stop: Decision['stop_reason'] = null) => {
    decisionSeq += 1;
    s.emit('decision.made', { id: `dec_${decisionSeq}`, kind, round, reason, stop_reason: stop, signals, at: s.now() });
  };
  /** 机制关闭时，把专用动作降级为普通搜索 */
  const actType = (t: ResearchAction['type']): ResearchAction['type'] => {
    if ((t === 'trace_origin' || t === 'corroborate') && !src) return 'search';
    if ((t === 'expand_window' || t === 'narrow_window' || t === 'focus_date') && !tmp) return 'search';
    return t;
  };
  const mkAction = (round: number, type: ResearchAction['type'], rationale: string, p: Partial<ResearchAction['params']>, gapId: string | null, qIds: string[]): ResearchAction => {
    actionSeq += 1;
    const t = actType(type);
    return {
      id: `act_${String(actionSeq).padStart(2, '0')}`,
      round,
      type: t,
      status: 'planned',
      gap_id: gapId,
      question_ids: qIds,
      rationale,
      params: {
        query: p.query ?? null,
        window: t === type ? (p.window ?? null) : null,
        date: t === type ? (p.date ?? null) : null,
        url: p.url ?? null,
        claim_id: p.claim_id ?? null,
      },
      result: null,
      started_at: null,
      finished_at: null,
    };
  };
  const runAction = (a: ResearchAction, found: (keyof typeof DOCS)[], dupes: number, evs: (keyof typeof EVIDENCE)[], note: string | null = null) => {
    const started: ResearchAction = { ...a, status: 'running', started_at: s.now() };
    s.emit('action.upserted', started);
    const provider = a.type === 'trace_origin' || a.type === 'corroborate' ? 'exa' : 'tavily';
    s.tool(a.id, 'search', provider, a.params.query ?? '', found.length + dupes + 2, 800);
    for (const k of found) addDoc(k, a.round, a.id, provider);
    if (found.length) s.llm(3800 * found.length, 500 * found.length, 700);
    for (const e of evs) {
      const doc = docs.get(EVIDENCE[e].doc);
      if (asOf && doc && doc.available_at_cutoff === false) continue;
      addEvidence(e, a.round);
    }
    s.emit('action.upserted', {
      ...started,
      status: 'done',
      finished_at: s.now(),
      result: { documents_added: found.length, evidence_added: evs.length, duplicates: dupes, note },
    });
  };
  const plan = (round: number, rationale: string, windows: { start: string; end: string }[], strategy: string, actions: ResearchAction[]) => {
    s.llm(5200 + round * 1800, 900, 1300);
    s.emit('plan.created', { round, created_at: s.now(), rationale, windows, source_strategy: strategy, action_ids: actions.map((a) => a.id) });
    actions.forEach((a) => s.emit('action.upserted', a));
  };

  // ════════════════ 第 1 轮 ════════════════
  s.usage.research_rounds = 1;
  const r1 = [
    mkAction(1, 'search', L('Find the original announcement and deal terms.', '查找原始公告与交易条款。'), { query: 'Northwind Robotics Helios Sensors acquisition', window: { start: '2024-01-01', end: '2024-06-30' } }, null, ['q_1', 'q_3']),
    mkAction(1, 'search', L('Identify regulatory reviews of the deal.', '识别该交易涉及的监管审查。'), { query: 'Northwind Helios regulatory review antitrust', window: { start: '2024-01-01', end: '2024-06-30' } }, null, ['q_2']),
    mkAction(1, 'search', L('Check whether the deal has closed.', '核查交易是否已交割。'), { query: 'Northwind Helios deal closed completed', window: { start: '2024-01-01', end: '2024-06-30' } }, null, ['q_1']),
  ];
  s.step('plan', 1, () =>
    plan(1, L('Start from the announcement, then look for regulatory milestones and any report of closing.', '先从交易公告入手，再查找监管里程碑与任何关于交割的报道。'), [{ start: '2024-01-01', end: '2024-06-30' }], L('Prefer company press releases and regulator notices; use news reports for corroboration.', '优先使用公司新闻稿和监管机构公告；新闻报道用于佐证。'), r1),
  );

  const failNow = opts.failAt === 'collect';
  s.step('collect', 1, () => {
    runAction(r1[0], ['d1', 'd2', 'd3', 'd4'], 0, ['e1', 'e2', 'e3']);
    if (failNow) return;
    s.log(L('3 of 4 announcement articles share near-identical text.', '4 篇公告报道中有 3 篇文本几乎相同。'));
    runAction(r1[1], ['d5'], 1, ['e4', 'e5']);
    runAction(r1[2], ['d6', 'd7'], 2, ['e6', 'e7']);
    if (asOf) s.log(L('Excluded 1 document published after the cutoff (2024-07-09) from evidence.', '已将 1 篇截止时间之后（2024-07-09）发布的文档排除在证据之外。'), 'warning');
  });
  if (failNow) {
    s.wait(600);
    s.tool(r1[1].id, 'search', 'tavily', r1[1].params.query ?? '', null, 300, false, 'HTTP 401 Unauthorized');
    s.emit('run.error', { type: 'provider_error', message: L('Search provider rejected the request: HTTP 401 Unauthorized (check TAVILY_API_KEY).', '搜索服务拒绝请求：HTTP 401 Unauthorized（请检查 TAVILY_API_KEY）。') });
    s.emit('run.finished', { status: 'failed', stop_reason: 'error', finished_at: s.now() });
    return s.items;
  }

  s.step('verify', 1, () => {
    group('og_01', L('Northwind press release (Jan 15, 2024)', 'Northwind 新闻稿（2024-01-15）'), ['d1', 'd2', 'd3', 'd4'], 'd1', L('Near-identical text; all attribute the company announcement.', '文本几乎相同，均注明来自公司公告。'));
    group('og_02', 'EuroBiz (May 2)', ['d5'], null, L('Independent reporting.', '独立报道。'));
    group('og_03', 'TechLedger (Apr 5)', ['d6'], null, L('Independent reporting; no attribution given.', '独立报道，未注明出处。'));
    group('og_04', L('Northwind press release (Jul 9, after cutoff)', 'Northwind 新闻稿（7 月 9 日，截止后）'), ['d7'], 'd7', L('Original source.', '原始来源。'));
    s.llm(9800, 1600, 1500);
    upsertClaim('cl_01', 1, { text: L('Northwind agreed to acquire Helios Sensors for about $2.1 billion in cash.', 'Northwind 同意以约 21 亿美元现金收购 Helios Sensors。'), stage: 'announced', date: day('2024-01-15'), qs: ['q_3'], verdict: 'supported', rationale: L('Stated in the original press release and repeated by republications.', '原始新闻稿明确说明，其余为转载。'), links: [['e1', 'supports'], ['e3', 'supports']] });
    upsertClaim('cl_02', 1, { text: L('Closing was expected in the second half of 2024, subject to regulatory and shareholder approval.', '交易预计于 2024 年下半年交割，前提是获得监管和股东批准。'), stage: null, date: null, qs: ['q_1'], verdict: 'supported', rationale: L('Explicit in the press release.', '新闻稿中明确说明。'), links: [['e2', 'supports']] });
    upsertClaim('cl_03', 1, { text: L('The European Commission opened an in-depth investigation into the deal.', '欧盟委员会对该交易展开深入调查。'), stage: 'regulatory_review', date: month('2024-03', 'In March'), qs: ['q_2'], verdict: 'supported', rationale: L('Reported by EuroBiz; exact date not given.', 'EuroBiz 报道，未给出具体日期。'), links: [['e4', 'supports']] });
    s.llm(6200, 900, 1100);
    upsertClaim('cl_04', 1, { text: L('Northwind completed the acquisition in April 2024.', 'Northwind 于 2024 年 4 月完成收购。'), stage: 'closed', date: month('2024-04'), qs: ['q_1'], verdict: 'conflicting', rationale: L('TechLedger reports completion, but EuroBiz reports in May that the EU review is still ongoing. Subjects and stages match, so this is a genuine conflict.', 'TechLedger 称已完成，但 EuroBiz 在 5 月报道欧盟审查仍在进行。主体与阶段一致，属于真实冲突。'), links: [['e6', 'supports'], ['e5', 'contradicts']] });
    if (!asOf) {
      upsertClaim('cl_11', 1, { text: L('Northwind completed the acquisition on July 9, 2024.', 'Northwind 于 2024 年 7 月 9 日完成收购。'), stage: 'closed', date: day('2024-07-09'), qs: ['q_1'], verdict: 'supported', rationale: L('Company announcement; event occurs after the cutoff, so it does not describe the state at the cutoff.', '公司公告；事件发生在截止时间之后，不能描述截止时间时的状态。'), links: [['e7', 'supports']], applicable: false });
    }
  });

  s.step('update', 1, () => {
    s.llm(4800, 1100, 1000);
    tl({ id: 'tl_01', date: day('2024-01-15'), title: L('Deal announced', '交易宣布'), summary: L('Definitive agreement to acquire Helios for ~$2.1B in cash; closing expected H2 2024.', '签署最终协议，以约 21 亿美元现金收购 Helios；预计 2024 年下半年交割。'), stage: tmp ? 'announced' : null, claim_ids: ['cl_01', 'cl_02'], verdict: 'supported', is_milestone: true });
    tl({ id: 'tl_02', date: tmp ? month('2024-03', 'In March') : day('2024-05-02'), title: L('EU in-depth investigation', '欧盟深入调查'), summary: L('The European Commission opens a Phase II review over lidar supply concerns.', '欧盟委员会因激光雷达供应担忧启动第二阶段审查。'), stage: tmp ? 'regulatory_review' : null, claim_ids: ['cl_03'], verdict: 'supported', is_milestone: true });
    tl({ id: 'tl_x1', date: tmp ? month('2024-04') : day('2024-04-05'), title: L('Reported completion (disputed)', '报道称已完成（存疑）'), summary: L('One outlet reports the deal closed; contradicted by later reporting.', '一家媒体报道交易已完成，与后续报道矛盾。'), stage: tmp ? 'closed' : null, claim_ids: ['cl_04'], verdict: 'conflicting', is_milestone: false });
    updQ('q_3', 'answered', ['cl_01']);
    updQ('q_1', 'partial', ['cl_02']);
    updQ('q_2', 'partial', ['cl_03']);
    if (tmp) openGap({ id: 'gap_01', type: 'unclear_date', description: L('The EU investigation date is only known to the month (March 2024).', '欧盟调查的日期只精确到月（2024 年 3 月）。'), question_ids: ['q_2'], claim_ids: ['cl_03'], priority: 'medium', affects_main_answer: true, feasible: true, opened_round: 1 });
    if (src || tmp) openGap({ id: 'gap_02', type: 'conflict', description: L('A report of completion in April conflicts with May reporting that the EU review is ongoing.', '4 月"已完成"的报道与 5 月"欧盟审查仍在进行"的报道相互冲突。'), question_ids: ['q_1'], claim_ids: ['cl_04'], priority: 'high', affects_main_answer: true, feasible: true, opened_round: 1 });
    if (tmp) openGap({ id: 'gap_03', type: 'missing_background', description: L('Earliest evidence is the January 15 announcement; the search window may have cut off earlier developments.', '最早的证据是 1 月 15 日的公告，检索窗口可能截断了更早的进展。'), question_ids: ['q_4'], claim_ids: [], priority: 'medium', affects_main_answer: false, feasible: true, opened_round: 1 });
    if (tmp) openGap({ id: 'gap_04', type: 'missing_phase', description: L('Regulatory review appears but no shareholder approval was found, although the press release requires it.', '已出现监管审查，但未找到股东批准，而新闻稿说明需要股东批准。'), question_ids: ['q_2'], claim_ids: [], priority: 'high', affects_main_answer: true, feasible: true, opened_round: 1 });
    openGap({ id: 'gap_05', type: 'unanswered_question', description: L('No evidence yet on the outcome of the EU review.', '尚无关于欧盟审查结果的证据。'), question_ids: ['q_2', 'q_1'], claim_ids: [], priority: 'high', affects_main_answer: true, feasible: true, opened_round: 1 });
  });

  decide('continue_research', 1, L('Core coverage 0/2 with 3 open high-priority gaps; 63% of research budget remains.', '核心问题覆盖 0/2，有 3 个高优先级缺口未解决；研究预算剩余 63%。'), { core_coverage: 0, open_high_gaps: 3, new_independent_evidence: src ? 3 : 6, new_milestones: 2, budget_remaining_ratio: 0.63, no_progress_rounds: 0 });

  if (opts.cancelAt === 'round2') {
    s.wait(800);
    s.emit('run.finished', { status: 'cancelled', stop_reason: 'cancelled', finished_at: s.now() });
    return s.items;
  }

  // ════════════════ 第 2 轮 ════════════════
  s.usage.research_rounds = 2;
  const r2 = [
    mkAction(2, 'focus_date', L('Pin down the exact date of the EU investigation.', '确定欧盟启动调查的具体日期。'), { query: 'European Commission in-depth investigation Helios Sensors March 2024', date: '2024-03-15', window: { start: '2024-03-01', end: '2024-03-31' } }, tmp ? 'gap_01' : null, ['q_2']),
    mkAction(2, 'trace_origin', L('Trace the source of the "completed in April" report.', '追溯"4 月已完成"报道的来源。'), { query: 'Northwind Helios US clearance April 2024 Hart-Scott-Rodino', claim_id: 'cl_04' }, src || tmp ? 'gap_02' : null, ['q_1']),
    mkAction(2, 'expand_window', L('Extend the window backwards to capture pre-announcement background.', '向前扩展检索窗口，补全宣布前的背景。'), { query: 'Northwind Robotics Helios talks', window: { start: '2023-09-01', end: '2024-01-14' } }, tmp ? 'gap_03' : null, ['q_4']),
    mkAction(2, 'search', L('Find the Helios shareholder vote.', '查找 Helios 股东投票。'), { query: 'Helios shareholders vote Northwind takeover' }, tmp ? 'gap_04' : null, ['q_2']),
  ];
  s.step('plan', 2, () =>
    plan(2, L('Target the open gaps: resolve the completion conflict at its source, fix the EU date, recover background and the missing shareholder phase.', '针对开放缺口：从源头解决"已完成"冲突、确定欧盟调查日期、补全背景与缺失的股东批准阶段。'), tmp ? [{ start: '2023-09-01', end: '2024-01-14' }, { start: '2024-03-01', end: '2024-03-31' }] : [{ start: '2024-01-02', end: '2024-06-30' }], L('Prefer regulator notices for dates; trace attributions to their originals.', '日期以监管机构公告为准；按署名追溯原始出处。'), r2),
  );
  s.step('collect', 2, () => {
    ['gap_01', 'gap_02', 'gap_03', 'gap_04'].forEach(progressGap);
    runAction(r2[0], ['d8'], 2, ['e8']);
    runAction(r2[1], ['d10'], 1, ['e10']);
    if (tmp) runAction(r2[2], ['d9'], 0, ['e9']);
    else runAction(r2[2], [], 3, [], L('Fixed window: nothing new before the announcement is reachable.', '固定窗口：无法检索到宣布之前的新内容。'));
    runAction(r2[3], ['d11'], 1, ['e11']);
  });
  s.step('verify', 2, () => {
    group('og_05', L('European Commission (Mar 18)', '欧盟委员会（3 月 18 日）'), ['d8'], 'd8', L('Original regulator notice.', '监管机构原始公告。'));
    group('og_06', 'AntitrustWatch (Apr 3)', ['d10'], null, L('Independent; cites FTC notices.', '独立来源，引用 FTC 公告。'));
    if (tmp) group('og_07', 'Harbor Financial Times (Nov 8, 2023)', ['d9'], null, L('Single report citing anonymous sources.', '单一报道，引用匿名消息源。'));
    group('og_08', 'GlobalWire (Feb 20)', ['d11'], null, L('Independent reporting.', '独立报道。'));
    s.llm(11200, 1900, 1600);
    upsertClaim('cl_03', 2, { text: L('The European Commission opened an in-depth investigation into the deal.', '欧盟委员会对该交易展开深入调查。'), stage: 'regulatory_review', date: day('2024-03-18'), qs: ['q_2'], verdict: 'supported', rationale: L('Confirmed by the Commission notice dated March 18, 2024.', '经 2024 年 3 月 18 日欧盟委员会公告确认。'), links: [['e8', 'supports'], ['e4', 'supports']] });
    s.llm(7400, 1300, 1200);
    upsertClaim('cl_04', 2, { text: L('Northwind completed the acquisition in April 2024.', 'Northwind 于 2024 年 4 月完成收购。'), stage: 'closed', date: month('2024-04'), qs: ['q_1'], verdict: 'contradicted', rationale: L('Traced to the US HSR waiting-period expiry on April 2, which is a US clearance, not closing; the EU review was still pending in May. TechLedger conflated two stages — a reporting error, not a historical change.', '追溯发现源头是 4 月 2 日美国 HSR 等待期届满，属于美国审批通过而非交割；5 月欧盟审查仍未结束。TechLedger 混淆了两个阶段——属于报道错误，而非事件变化。'), links: [['e6', 'context', L('Conflates US clearance with closing', '将美国审批通过误作交割')], ['e10', 'contradicts'], ['e5', 'contradicts']] }, L('Original source shows only US clearance.', '原始来源只显示美国审批通过。'));
    upsertClaim('cl_05', 2, { text: L('The US HSR waiting period expired on April 2, 2024, clearing the deal in the United States.', '美国 HSR 等待期于 2024 年 4 月 2 日届满，交易在美国获批。'), stage: 'regulatory_approval', date: day('2024-04-02', 'April 2'), qs: ['q_2'], verdict: 'supported', rationale: L('AntitrustWatch, citing FTC notices.', 'AntitrustWatch 报道，引用 FTC 公告。'), links: [['e10', 'supports']] });
    upsertClaim('cl_06', 2, { text: L('Helios shareholders approved the takeover on February 20, 2024.', 'Helios 股东于 2024 年 2 月 20 日批准收购。'), stage: 'shareholder_approval', date: day('2024-02-20', 'on Tuesday'), qs: ['q_2'], verdict: 'supported', rationale: L('GlobalWire report of the vote.', 'GlobalWire 对投票的报道。'), links: [['e11', 'supports']] });
    if (tmp) upsertClaim('cl_07', 2, { text: L('Northwind was reported to be in advanced talks to acquire Helios in November 2023.', '据报道，Northwind 在 2023 年 11 月就收购 Helios 进行深入谈判。'), stage: 'talks', date: day('2023-11-08'), qs: ['q_4'], verdict: 'supported', rationale: L('Single report based on anonymous sources.', '基于匿名消息源的单一报道。'), links: [['e9', 'supports']] });
  });
  s.step('update', 2, () => {
    s.llm(5600, 1200, 1000);
    s.emit('timeline.removed', { id: 'tl_x1' });
    if (tmp) tl({ id: 'tl_00', date: day('2023-11-08'), title: L('Talks reported', '传出谈判消息'), summary: L('Harbor Financial Times reports advanced talks, citing anonymous sources.', 'Harbor Financial Times 援引匿名消息源报道双方深入谈判。'), stage: 'talks', claim_ids: ['cl_07'], verdict: 'supported', is_milestone: true });
    tl({ id: 'tl_03', date: day('2024-02-20'), title: L('Shareholders approve', '股东批准'), summary: L('Helios shareholders approve the takeover.', 'Helios 股东批准收购。'), stage: tmp ? 'shareholder_approval' : null, claim_ids: ['cl_06'], verdict: 'supported', is_milestone: true });
    tl({ id: 'tl_02', date: day('2024-03-18'), title: L('EU in-depth investigation', '欧盟深入调查'), summary: L('The European Commission opens a Phase II review over lidar supply concerns.', '欧盟委员会因激光雷达供应担忧启动第二阶段审查。'), stage: tmp ? 'regulatory_review' : null, claim_ids: ['cl_03'], verdict: 'supported', is_milestone: true });
    tl({ id: 'tl_04', date: day('2024-04-02'), title: L('US clearance', '美国审批通过'), summary: L('HSR waiting period expires; the EU review remains pending.', 'HSR 等待期届满；欧盟审查仍未结束。'), stage: tmp ? 'regulatory_approval' : null, claim_ids: ['cl_05'], verdict: 'supported', is_milestone: true });
    if (tmp) {
      closeGap('gap_01', 2, 'resolved', L('Commission notice dates the opening to March 18, 2024.', '欧盟委员会公告确认启动日期为 2024 年 3 月 18 日。'));
      closeGap('gap_03', 2, 'resolved', L('Found a November 2023 report of talks.', '找到 2023 年 11 月的谈判报道。'));
      closeGap('gap_04', 2, 'resolved', L('Shareholder approval on February 20, 2024.', '2024 年 2 月 20 日股东批准。'));
    }
    if (src || tmp) closeGap('gap_02', 2, 'resolved', L('The completion report conflated US clearance with closing; claim marked contradicted.', '"已完成"报道混淆了美国审批通过与交割；该声明已标记为被反驳。'));
    if (tmp) updQ('q_4', 'answered', ['cl_07']);
    updQ('q_2', 'partial', ['cl_03', 'cl_05', 'cl_06']);
    if (src && tmp) openGap({ id: 'gap_06', type: 'single_source', description: L('The November 2023 talks report relies on a single anonymous-sourced account.', '2023 年 11 月的谈判报道仅依赖一篇匿名消息源报道。'), question_ids: ['q_4'], claim_ids: ['cl_07'], priority: 'medium', affects_main_answer: false, feasible: true, opened_round: 2 });
  });

  if (small) {
    decide('write_report', 2, L('Research budget nearly exhausted (6% left after reserve); writing with the evidence collected so far.', '研究预算即将耗尽（扣除预留后剩 6%）；用已收集的证据撰写报告。'), { core_coverage: 0, open_high_gaps: 1, new_independent_evidence: 4, new_milestones: 3, budget_remaining_ratio: 0.06, no_progress_rounds: 0 }, 'budget_exhausted');
    return finishWithReport(s, opts, L, { partial: true, src, tmp, asOf });
  }

  decide('continue_research', 2, L('Core coverage 0/2; the EU outcome is still unknown (1 high-priority gap); 41% of research budget remains.', '核心问题覆盖 0/2；欧盟审查结果仍未知（1 个高优先级缺口）；研究预算剩余 41%。'), { core_coverage: 0, open_high_gaps: 1, new_independent_evidence: tmp ? 4 : 3, new_milestones: 3, budget_remaining_ratio: 0.41, no_progress_rounds: 0 });

  // ════════════════ 第 3 轮 ════════════════
  s.usage.research_rounds = 3;
  const r3 = [
    mkAction(3, 'search', L('Find the EU decision.', '查找欧盟审查结论。'), { query: 'European Commission decision Northwind Helios June 2024' }, 'gap_05', ['q_2', 'q_1']),
    mkAction(3, 'search', L('Check closing status before the cutoff.', '核查截止时间前的交割状态。'), { query: 'Northwind Helios closing expected timeline', window: { start: '2024-06-01', end: '2024-06-30' } }, 'gap_05', ['q_1']),
    ...(src && tmp ? [mkAction(3, 'corroborate', L('Seek independent confirmation of the November 2023 talks.', '为 2023 年 11 月的谈判报道寻找独立佐证。'), { query: 'Northwind Helios talks November 2023', claim_id: 'cl_07' }, 'gap_06', ['q_4'])] : []),
  ];
  s.step('plan', 3, () =>
    plan(3, L('Only the EU outcome and the closing status remain; verify both from primary sources.', '只剩欧盟审查结果与交割状态未明；均从一手来源核实。'), [{ start: '2024-06-01', end: '2024-06-30' }], L('Regulator decision notice plus company statement; one independent outlet for corroboration.', '监管机构决定公告加公司声明；再用一家独立媒体佐证。'), r3),
  );
  s.step('collect', 3, () => {
    progressGap('gap_05');
    runAction(r3[0], ['d12', 'd13'], 2, ['e12', 'e13']);
    runAction(r3[1], ['d14'], 1, ['e14']);
    if (r3[2]) {
      progressGap('gap_06');
      runAction(r3[2], [], 2, [], L('Only republications of the same anonymous-sourced report.', '只找到同一篇匿名消息源报道的转载。'));
    }
  });
  s.step('verify', 3, () => {
    group('og_09', L('European Commission decision (Jun 12)', '欧盟委员会决定（6 月 12 日）'), ['d12', 'd13'], 'd12', L('EuroBiz attributes the Commission decision; different sites, same origin.', 'EuroBiz 注明来自欧盟委员会决定；网站不同，出处相同。'));
    group('og_10', L('Northwind statement (Jun 13)', 'Northwind 声明（6 月 13 日）'), ['d14'], 'd14', L('Original source.', '原始来源。'));
    s.llm(9400, 1700, 1500);
    upsertClaim('cl_08', 3, { text: L('The European Commission approved the acquisition on June 12, 2024, subject to commitments.', '欧盟委员会于 2024 年 6 月 12 日附条件批准该收购。'), stage: 'regulatory_approval', date: day('2024-06-12'), qs: ['q_2'], verdict: 'supported', rationale: L('Commission decision notice.', '欧盟委员会决定公告。'), links: [['e12', 'supports'], ['e13', 'context']] });
    upsertClaim('cl_09', 3, { text: L('The remedy requires Northwind to license Helios lidar patents to rivals for ten years.', '补救措施要求 Northwind 在十年内向竞争对手许可 Helios 的激光雷达专利。'), stage: null, date: day('2024-06-12'), qs: ['q_2'], verdict: 'supported', rationale: L('Detail reported by EuroBiz from the decision.', 'EuroBiz 根据决定内容报道的细节。'), links: [['e13', 'supports']] });
    upsertClaim('cl_10', 3, { text: L('As of mid-June 2024, all required approvals had been obtained and closing was expected in Q3 2024.', '截至 2024 年 6 月中旬，已获得全部所需批准，预计 2024 年第三季度交割。'), stage: 'regulatory_approval', date: day('2024-06-13'), qs: ['q_1'], verdict: 'supported', rationale: L('Company statement, consistent with the Commission decision.', '公司声明，与欧盟委员会决定一致。'), links: [['e14', 'supports'], ['e12', 'supports']] });
  });
  s.step('update', 3, () => {
    s.llm(5200, 1100, 900);
    tl({ id: 'tl_05', date: day('2024-06-12'), title: L('EU conditional approval', '欧盟附条件批准'), summary: L('Commission clears the deal subject to ten-year lidar patent licensing commitments.', '欧盟委员会批准交易，附带十年激光雷达专利许可承诺。'), stage: tmp ? 'regulatory_approval' : null, claim_ids: ['cl_08', 'cl_09'], verdict: 'supported', is_milestone: true });
    tl({ id: 'tl_06', date: day('2024-06-13'), title: L('Closing expected in Q3', '预计第三季度交割'), summary: L('Northwind says all approvals are in hand; transaction not yet closed.', 'Northwind 表示已获得全部批准；交易尚未交割。'), stage: null, claim_ids: ['cl_10'], verdict: 'supported', is_milestone: false });
    closeGap('gap_05', 3, 'resolved', L('EU approval on June 12, 2024; closing expected in Q3.', '欧盟于 2024 年 6 月 12 日批准；预计第三季度交割。'));
    if (src && tmp) closeGap('gap_06', 3, 'abandoned', L('No independent confirmation found after a targeted search; reported with caveat.', '定向检索后仍未找到独立佐证；在报告中注明保留意见。'));
    updQ('q_1', 'answered', ['cl_10', 'cl_04']);
    updQ('q_2', 'answered', ['cl_03', 'cl_05', 'cl_06', 'cl_08']);
  });
  decide('write_report', 3, L('All core questions answered and no feasible high-priority gaps remain.', '所有核心问题均已回答，且没有可行的高优先级缺口。'), { core_coverage: 1, open_high_gaps: 0, new_independent_evidence: 2, new_milestones: 1, budget_remaining_ratio: 0.27, no_progress_rounds: 0 }, 'questions_answered');

  return finishWithReport(s, opts, L, { partial: false, src, tmp, asOf });
}

// ───────────────────────── 报告与审查 ─────────────────────────

type LFn = (en: string, zh: string) => string;
let pSeq = 0;
const para = (sentences: [string, string[], string[]][]): ReportParagraph => {
  pSeq += 1;
  return {
    id: `p_${pSeq}`,
    sentences: sentences.map(([text, evs, cls], i) => ({ id: `s_${pSeq}_${i + 1}`, text, evidence_ids: evs.map(evId), claim_ids: cls })),
  };
};

function buildReport(L: LFn, lang: Lang, version: number, at: string, o: { partial: boolean; fixed: boolean; tmp: boolean }): Report {
  pSeq = 0;
  const answer = o.partial
    ? para([
        [L('As of June 30, 2024, the evidence collected shows the acquisition had been announced and cleared in the United States, but it does not establish whether the EU review had concluded.', '截至 2024 年 6 月 30 日，已收集的证据表明该收购已宣布并在美国获批，但无法确定欧盟审查是否已有结论。'), ['e1', 'e10'], ['cl_01', 'cl_05']],
        [L('An April report that the deal had closed is contradicted by the original sources.', '4 月有报道称交易已完成，但与原始来源矛盾。'), ['e10', 'e5'], ['cl_04']],
      ])
    : para([
        [L('As of June 30, 2024, Northwind Robotics had not yet completed its acquisition of Helios Sensors.', '截至 2024 年 6 月 30 日，Northwind Robotics 尚未完成对 Helios Sensors 的收购。'), ['e14'], ['cl_10']],
        [L('All required approvals had been obtained — US clearance on April 2 and conditional EU approval on June 12 — and Northwind expected the deal to close in the third quarter of 2024.', '所需批准均已获得——美国于 4 月 2 日放行，欧盟于 6 月 12 日附条件批准——Northwind 预计交易在 2024 年第三季度交割。'), o.fixed ? ['e10', 'e12', 'e14'] : ['e12', 'e14'], ['cl_05', 'cl_08', 'cl_10']],
        [L('An April report that the deal had already closed is contradicted by the original sources.', '4 月"交易已完成"的报道与原始来源矛盾。'), ['e10', 'e5'], ['cl_04']],
      ]);
  const sections: Report['sections'] = [
    {
      id: 'sec_bg',
      kind: 'background',
      title: L('Background', '背景'),
      paragraphs: [
        para([
          ...(o.tmp ? [[L('Talks were first reported in November 2023, based on anonymous sources.', '双方谈判最早于 2023 年 11 月见报，消息来自匿名人士。'), ['e9'], ['cl_07']] as [string, string[], string[]]] : []),
          [L('On January 15, 2024, Northwind announced a definitive agreement to acquire Helios for about $2.1 billion in cash.', '2024 年 1 月 15 日，Northwind 宣布签署最终协议，以约 21 亿美元现金收购 Helios。'), ['e1'], ['cl_01']],
          [L('The company expected the transaction to close in the second half of 2024, subject to regulatory and shareholder approval.', '公司预计交易在 2024 年下半年交割，前提是获得监管和股东批准。'), ['e2'], ['cl_02']],
        ]),
      ],
    },
    {
      id: 'sec_tl',
      kind: 'timeline_analysis',
      title: L('Approval timeline', '审批时间线'),
      paragraphs: [
        para([
          [L('Helios shareholders approved the takeover on February 20.', 'Helios 股东于 2 月 20 日批准收购。'), ['e11'], ['cl_06']],
          [L('On March 18, the European Commission opened an in-depth investigation, citing concerns about the supply of lidar components.', '3 月 18 日，欧盟委员会以激光雷达组件供应担忧为由启动深入调查。'), ['e8', 'e4'], ['cl_03']],
          [L('In the United States, the HSR waiting period expired on April 2.', '在美国，HSR 等待期于 4 月 2 日届满。'), ['e10'], ['cl_05']],
          ...(o.partial
            ? []
            : ([
                [L('On June 12, the Commission approved the deal subject to commitments, including ten-year licensing of Helios lidar patents to rivals.', '6 月 12 日，欧盟委员会附条件批准交易，条件包括十年内向竞争对手许可 Helios 激光雷达专利。'), ['e12', 'e13'], ['cl_08', 'cl_09']],
              ] as [string, string[], string[]][])),
        ]),
      ],
    },
    {
      id: 'sec_an',
      kind: 'analysis',
      title: L('Assessing the conflicting report', '对冲突报道的评估'),
      paragraphs: [
        para([
          [L('The April 5 report of completion appears to have conflated US clearance with closing: the US event it describes matches the HSR expiry, while the EU review was still pending in May.', '4 月 5 日"已完成"的报道似乎把美国放行当成了交割：它描述的美国事件与 HSR 等待期届满一致，而 5 月时欧盟审查仍未结束。'), ['e6', 'e10', 'e5'], ['cl_04']],
          [L('The four January articles republish the same press release, so they count as one independent source.', '1 月的四篇报道转载的是同一份新闻稿，因此只算一个独立来源。'), ['e1', 'e3'], ['cl_01']],
        ]),
      ],
    },
    {
      id: 'sec_unc',
      kind: 'uncertainty',
      title: L('Uncertainty and limits', '不确定性与局限'),
      paragraphs: [
        para(
          o.partial
            ? [
                [L('The research budget ran out before the outcome of the EU review could be established; no source in the collected evidence reports a decision.', '研究预算在确定欧盟审查结果之前耗尽；已收集证据中没有任何来源报道审查结论。'), [], []],
              ]
            : [
                ...(o.tmp ? [[L('The November 2023 talks report rests on a single anonymous-sourced account and could not be independently confirmed.', '2023 年 11 月的谈判报道仅基于一篇匿名消息源报道，未能获得独立佐证。'), ['e9'], ['cl_07']] as [string, string[], string[]]] : []),
                [L('Whether closing occurred on schedule falls after the cutoff and is outside the scope of this report.', '交易是否按计划交割发生在截止时间之后，不在本报告范围内。'), [], []],
              ],
        ),
      ],
    },
  ];
  return {
    version,
    language: lang,
    title: L("Northwind Robotics' acquisition of Helios Sensors: status as of June 30, 2024", 'Northwind Robotics 收购 Helios Sensors：截至 2024 年 6 月 30 日的进展'),
    generated_at: at,
    is_partial: o.partial,
    answer,
    sections,
    open_questions: o.partial
      ? [L('Outcome of the European Commission review', '欧盟委员会审查的结果'), L('Whether all approvals were in hand by the cutoff', '截止时间前是否已获得全部批准')]
      : [L('Exact closing date (after the cutoff)', '确切交割日期（在截止时间之后）'), ...(o.tmp ? [L('Independent confirmation of the November 2023 talks', '2023 年 11 月谈判的独立佐证')] : [])],
    stop_reason: null,
  };
}

function finishWithReport(s: Script, opts: ScenarioOptions, L: LFn, o: { partial: boolean; src: boolean; tmp: boolean; asOf: boolean }): ScriptItem[] {
  const lang = opts.req.report_language;
  // 写作
  s.step('write', 1, () => {
    s.llm(18500, 3600, 2400);
    s.emit('report.updated', buildReport(L, lang, 1, s.now(), { partial: o.partial, fixed: false, tmp: o.tmp }));
  });
  // 审查 1
  s.usage.review_rounds = 1;
  const f1: ReviewFinding = o.partial
    ? { id: 'rf_1', type: 'omission', severity: 'high', sentence_id: null, description: L('Core question q_2 (EU outcome) is not answered.', '核心问题 q_2（欧盟审查结果）未得到回答。'), status: 'open' }
    : { id: 'rf_1', type: 'unsupported_citation', severity: 'high', sentence_id: 's_1_2', description: L('"US clearance on April 2" is not supported by the cited passages (ev_12, ev_14).', '"美国于 4 月 2 日放行"未被所引段落（ev_12、ev_14）支持。'), status: 'open' };
  const f2: ReviewFinding = { id: 'rf_2', type: 'omission', severity: 'low', sentence_id: 's_1_2', description: L('The answer does not mention the shareholder approval date.', '答案部分没有提及股东批准日期。'), status: 'open' };
  s.step('review', 1, () => {
    s.llm(14200, 1500, 2000);
    s.emit('review.completed', { round: 1, passed: false, findings: [f1, f2], at: s.now() });
  });
  if (o.partial) {
    const sig: DecisionSignals = { core_coverage: 0, open_high_gaps: 1, new_independent_evidence: 0, new_milestones: 0, budget_remaining_ratio: 0.02, no_progress_rounds: 0 };
    s.emit('decision.made', { id: 'dec_9', kind: 'finish', round: 1, reason: L('Review found an unresolved omission, but review rounds (1/1) and budget are exhausted. Delivering a partial report.', '审查发现未解决的遗漏，但审查轮数（1/1）与预算均已用尽，交付部分报告。'), stop_reason: 'review_unresolved', signals: sig, at: s.now() });
    const r = buildReport(L, lang, 1, s.now(), { partial: true, fixed: false, tmp: o.tmp });
    r.stop_reason = 'budget_exhausted';
    s.emit('report.updated', r);
    s.emit('run.finished', { status: 'partial', stop_reason: 'budget_exhausted', finished_at: s.now() });
    return s.items;
  }
  const sig: DecisionSignals = { core_coverage: 1, open_high_gaps: 0, new_independent_evidence: 0, new_milestones: 0, budget_remaining_ratio: 0.21, no_progress_rounds: 0 };
  s.emit('decision.made', { id: 'dec_8', kind: 'repair_report', round: 1, reason: L('One high-severity finding (unsupported citation) with evidence already available; rewriting the affected sentence.', '有 1 个高严重度问题（引用不支持），所需证据已在库中；重写相关句子。'), stop_reason: null, signals: sig, at: s.now() });
  s.step('write', 2, () => {
    s.llm(16800, 3400, 2200);
    s.emit('report.updated', buildReport(L, lang, 2, s.now(), { partial: false, fixed: true, tmp: o.tmp }));
  });
  s.usage.review_rounds = 2;
  s.step('review', 2, () => {
    s.llm(13900, 1300, 1800);
    s.emit('review.completed', { round: 2, passed: true, findings: [{ ...f1, status: 'fixed' }, { ...f2, status: 'wontfix' }], at: s.now() });
  });
  s.emit('decision.made', { id: 'dec_9', kind: 'finish', round: 2, reason: L('Review passed: no high-severity findings remain.', '审查通过：不再有高严重度问题。'), stop_reason: null, signals: { ...sig, budget_remaining_ratio: 0.17 }, at: s.now() });
  const final = buildReport(L, lang, 2, s.now(), { partial: false, fixed: true, tmp: o.tmp });
  final.stop_reason = 'review_passed';
  s.emit('report.updated', final);
  s.emit('run.finished', { status: 'completed', stop_reason: 'review_passed', finished_at: s.now() });
  return s.items;
}
