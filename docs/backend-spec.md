# 后端设计

> 本文档描述后端的架构、工作流、核心算法与配置。配套文档：[API 契约](api-contract.md)、[评测设计](evaluation-spec.md)。

---

## 1. 系统定位

一个**基于证据的新闻事件研究 Agent**。用户给出事件/问题、信息截止时间（cutoff）和可选新闻链接，系统自主检索、阅读、核实，输出一份逐句带引用的报告，内容包括答案、时间线、支撑证据和未解决问题。

研究价值在三个机制，也是 2×2 实验的对象：

1. **自适应时间规划**：根据证据缺口扩大/缩小时间窗口、聚焦某个日期，并检查信息在截止时间是否适用。
2. **来源核实**：追溯原始出处，把转载归为同一来源组，按独立来源计数。
3. **基于缺口的继续/停止决策**：在共享预算下，判断再搜一轮是否值得。

### 1.1 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 控制流 | **代码驱动的显式状态机**，每个步骤内调用 LLM 产出结构化结果 | 不用"一个大 Agent 自由调用工具"：实验需要可控的机制开关、可审计的预算计量、可复现的行为。"Agent 根据缺口选择动作"体现在 plan 步骤由 LLM 输出结构化动作列表，再由代码执行 |
| 预算 | 由代码强制执行，LLM 只能建议 | 停止策略必须可冻结、可复现 |
| 状态 | 事件溯源：所有状态变化都表现为事件，快照 = 事件折叠 | 前端实时展示、断点恢复、调试回放共用一套机制 |
| LLM 接入 | PydanticAI + OpenAI 兼容接口（base_url 可配） | 可接入任意 OpenAI 兼容服务（DeepSeek / Qwen / OpenRouter 等）；PydanticAI 提供类型化输出与用量统计 |
| 受控对比 | 本地文档池 + BM25 索引（snapshot 模式） | 2×2 各条件检索同一冻结文档池，排除实时搜索结果漂移带来的干扰 |
| 存储 | SQLite + 磁盘缓存 | 只在本地运行，零运维 |

### 1.2 非目标

- 不做用户系统/鉴权（仅本地运行，监听 127.0.0.1）。
- 不做分布式任务队列；单进程 asyncio 后台任务即可。
- 不追求通用 Deep Research；聚焦新闻事件的时间线与进展状态。

---

## 2. 技术栈

| 用途 | 选型 | 备注 |
|---|---|---|
| 语言 | Python ≥ 3.12 | |
| 包管理 | uv | `uv sync` 一键安装；锁文件 `uv.lock` 入库 |
| Web | FastAPI + uvicorn | SSE 由 StreamingResponse 实现 |
| LLM | pydantic-ai（OpenAI 兼容端点） | 结构化输出、重试与用量统计；`llm/openai_compat.py` 另有一个直连实现，供测试与排障 |
| 数据校验 | pydantic v2、pydantic-settings | |
| 搜索 | Tavily、Exa 官方 REST 接口（httpx） | 统一超时、缓存、服务切换和预算计量 |
| 网页正文 | 检索服务自带正文优先，回退 `httpx` + `trafilatura` | |
| 日期 | `htmldate`（发布时间）、`dateparser`（事件日期文本标准化） | |
| 本地检索 | 项目内 BM25 倒排索引；BrowseComp-Plus 语料用 SQLite FTS5 | 用于 snapshot 文档池与 corpus 模式 |
| 存储 | SQLite（标准库 `sqlite3`），WAL 模式 | 不使用 ORM |
| 模板 | Jinja2 | prompt 模板 |
| 评测 | tilse、nltk、pyrouge、numpy、scipy、pyarrow | Open-TLS 对齐 ROUGE、统计检验、读取官方 parquet |
| 测试 | pytest、jsonschema | |
| 代码质量 | ruff（lint + format）、pyright（basic） | |

---

## 3. 目录结构

```
backend/
  pyproject.toml
  uv.lock
  .env.example                 # 所有环境变量及说明，不含真实密钥
  config/
    settings.yaml              # 模型配置档、价格表、预算预设、停止阈值、检索参数
  scripts/
    set-keys.ps1               # 交互式写入 .env（输入不回显）
  src/newsagent/
    main.py                    # FastAPI 应用工厂与全部 HTTP 端点
    cli.py                     # typer CLI：serve / run / snapshot / eval
    settings.py                # 读取 .env 与 settings.yaml
    api/errors.py              # 统一错误格式
    contracts/models.py        # 与 frontend/src/api/types.ts 逐字段对应的 Pydantic 模型
    runtime/
      manager.py               # RunManager：创建、调度、澄清、取消、恢复
      state.py                 # RunState 初始值与事件折叠 apply_event()
      events.py                # EventBus：校验、持久化、广播
      store.py                 # SQLite 持久化（事件与运行摘要同事务写入）
      budget.py                # BudgetTracker：预检、计费、节流
      ownership.py             # 本地文件锁，区分活跃任务与已中断任务
      fake.py                  # 按契约样例回放事件（--fixture-mode）
    workflow/
      controller.py            # 显式状态机主循环（研究循环 + 审查循环）
      planning.py              # assess / plan：任务拆解、澄清、补查动作
      collect.py               # 执行检索动作、读取正文、抽取逐字证据
      verify.py                # 声明核实、时间线、答案覆盖与缺口
      drafts.py                # 模型输出结构及校验前的确定性规整
    research/
      policy.py                # MechanismPolicy：四个条件允许的动作、缺口与时间行为
      gaps.py                  # 缺口检测
      stopping.py              # 继续/停止决策
      provenance.py            # 转载归并、原始来源判定
      verdicts.py              # 证据状态聚合（纯函数）
    reporting/
      report.py                # 报告组装、逐句核查、审查修复与交付清理
      export_md.py             # Markdown 导出
    llm/
      runner.py                # 统一 LLM 调用：选模型、结构化输出、重试、计量
      pydantic_provider.py     # PydanticAI 适配器
      openai_compat.py         # OpenAI 兼容直连实现
      context.py               # ContextBuilder（记忆层）
      prompts/                 # *.md.j2 模板
    tools/
      search.py                # Tavily / Exa 适配器
      retrieval.py             # 运行内的搜索、读取、缓存、服务切换与计量
      reader.py                # 网页正文回退读取
      dates.py                 # 发布时间、事件日期与截止时间
      local_index.py           # 快照文档池与 BM25 检索
      corpus_index.py          # BrowseComp-Plus 语料 FTS5 检索
      storage.py               # 缓存与实验文件的原子写入
    eval/
      prepare.py               # 整理官方数据、冻结 dev/test 划分
      benchmarks.py            # 各 benchmark 的任务读取（参考答案与研究输入隔离）
      generate.py              # 冻结实验输入、生成可续跑的任务结果
      grade.py                 # 独立评分
      official.py              # 按官方协议实现的评分
      official/                # 官方提示词原文（附 NOTICE）
      metrics.py               # 时间线、检索指标与置信区间
      aggregate.py             # 汇总 summary.json / statistics.json
  tests/                       # 单元、契约、集成与 live 测试（见 §16）
data/                          # 运行数据，不入库
  app.db
  cache/pages/  cache/search/
  logs/<run_id>.jsonl
  snapshots/<snapshot_id>/
  experiments/<exp_id>/
  benchmarks/<benchmark>/
```

---

## 4. 配置

### 4.1 环境变量（`.env`）

完整列表见 `backend/.env.example`：

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` | 研究模型的 OpenAI 兼容端点与密钥（`ark-flash` 档） |
| `JUDGE_BASE_URL` / `JUDGE_API_KEY` | 评委模型端点与密钥（`judge` 档）；默认研究模型档 `minimax-m3` 也使用这组端点 |
| `TAVILY_API_KEY` / `EXA_API_KEY` | 检索服务密钥 |
| `NEWSAGENT_DATA_DIR` | 数据目录，默认 `../data` |
| `NEWSAGENT_HOST` / `NEWSAGENT_PORT` | 监听地址，默认 `127.0.0.1:8000` |
| `NEWSAGENT_MAX_CONCURRENT_RUNS` | 同时执行的运行数，默认 2 |
| `NEWSAGENT_MAX_LLM_INFLIGHT` | 进程级同时在途的模型请求上限，默认 4 |
| `NEWSAGENT_CACHE_HOURS` | live 模式搜索缓存有效期，默认 24 小时 |
| `CLARIFICATION_TIMEOUT_SECONDS` | 澄清等待超时，默认 1800 秒 |
| `LOG_LEVEL` | 日志级别 |
| `HTTPS_PROXY` / `ALL_PROXY` | 可选，境外检索服务与网页读取经代理访问 |

每个模型配置档通过 `base_url_env` / `api_key_env` 指定读取哪组环境变量。密钥**只**从环境变量读取，不写进 yaml、日志或任何 API 响应；`/api/config` 中的 `provider` 字段只输出 base_url 的主机名。

### 4.2 settings.yaml

`backend/config/settings.yaml` 是可复现实验配置，评测时其哈希写入 manifest。主要字段：

| 字段 | 内容 |
|---|---|
| `model_profiles` | 模型配置档：端点环境变量、四个角色（controller / extractor / writer / reviewer）对应的模型、结构化输出模式（`tool` / `native` / `prompted`，可按角色用 `role_output` 覆盖）、透传参数 `extra_body` |
| `default_model_profile` | 默认研究模型档（`minimax-m3`）；评分使用 `judge` 档 |
| `prices_usd_per_mtok` | 每百万 token 的等价单价，用于预算上限与成本统计（供应商不返回费用） |
| `budget_presets` | small / medium / large 三档预算 |
| `stopping` | 停止阈值（§11.2） |
| `research` | 基线回溯天数、每轮动作与读取上限、检索并发、实时检索服务的路由顺序 |
| `defaults` | 新建运行的默认参数 |

预算预设与停止阈值：

```yaml
budget_presets:
  small:  { max_research_rounds: 3, max_review_rounds: 1, max_tool_calls: 30,  max_llm_tokens: 300000,  max_seconds: 900,  max_cost_usd: 0.30, reserve_ratio: 0.25 }
  medium: { max_research_rounds: 5, max_review_rounds: 2, max_tool_calls: 60,  max_llm_tokens: 800000,  max_seconds: 1800, max_cost_usd: 0.80, reserve_ratio: 0.25 }
  large:  { max_research_rounds: 8, max_review_rounds: 3, max_tool_calls: 120, max_llm_tokens: 2000000, max_seconds: 3600, max_cost_usd: 2.00, reserve_ratio: 0.20 }

stopping:
  core_coverage_threshold: 0.8     # core 问题回答比例达到即可考虑停止
  no_progress_rounds_limit: 2      # 连续无进展轮数
  min_round_budget_ratio: 0.08     # 剩余（扣除预留）不足一轮估算成本时停止

research:
  default_lookback_days: 3650      # base 条件的检索窗口 [cutoff - N, cutoff]，即只受截止时间约束
  max_actions_per_round: 6
  search_results_per_query: 8
  max_reads_per_round: 10
  action_concurrency: 4
  news_order: [tavily, exa]        # 新闻检索的服务顺序
  verification_order: [exa, tavily]  # 溯源 / 佐证检索的服务顺序
```

停止阈值与 prompt 在 pilot 后冻结，不在测试集上调参。

---

## 5. 持久化

### 5.1 SQLite 表

```sql
runs(
  id TEXT PRIMARY KEY, created_at TEXT, status TEXT, title TEXT,
  request_json TEXT,           -- RunRequest
  summary_json TEXT,           -- 最新 RunSummary（列表页直接读，避免折叠）
  last_event_seq INTEGER
);
events(
  run_id TEXT, seq INTEGER, ts TEXT, type TEXT, data_json TEXT,
  PRIMARY KEY (run_id, seq)
);
checkpoints(
  run_id TEXT, seq INTEGER, step TEXT, round INTEGER, state_json TEXT, created_at TEXT,
  PRIMARY KEY (run_id, seq)
);
```

- 事件表只追加。`RunDetail` 由内存中的 `RunState` 提供；进程重启后对每个非终态运行，用"最近检查点 + 其后事件"重建，状态标为 `failed`（error.type = `interrupted`），用户可调用 resume 继续。
- 写事件与更新 `runs.summary_json` 在同一事务中完成。

### 5.2 磁盘缓存

- `cache/search/<sha256>.json`：key = `sha256(provider | 规范化查询 | 参数 JSON)`，value = 原始搜索结果 + 时间戳。live 模式默认命中缓存 24 小时内的结果（可关闭），节省额度。
- `cache/pages/<sha256(url)>.json`：正文、标题、元数据、发布时间、抓取时间。
- `snapshots/<id>/`：冻结的文档池（`documents.jsonl`）+ BM25 索引 + `manifest.json`（创建时间、来源运行、文档数）。见 §8.4。

---

## 6. 运行时架构

```
API ──POST /runs──▶ RunManager ──spawn──▶ WorkflowController (asyncio.Task)
                        │                        │ emit(event)
                        │                        ▼
                        │                    EventBus ──▶ apply_event(RunState)  内存快照
                        │                        ├──────▶ store.append(event)    SQLite
                        │                        └──────▶ subscribers            SSE 连接
API ◀──GET /runs/{id}── RunState（内存）/ store（终态运行）
```

- **RunManager**：用 `asyncio.Semaphore(MAX_CONCURRENT_RUNS)` 限制并发，超出的运行保持 queued。负责取消（设置取消标志 + `task.cancel()`，控制器在 `CancelledError` 中收尾：发 `run.finished(status=cancelled, stop_reason=cancelled)`）、恢复（从检查点重建 RunState 后重新 spawn）。
- **EventBus.emit(type, data)**：分配 seq、构造 RunEvent、调用 `apply_event` 更新内存 RunState、持久化、广播给订阅者（每个 SSE 连接一个 `asyncio.Queue`）。**所有状态修改必须经由 emit**，禁止直接改 RunState 中属于 RunDetail 的字段。
- **apply_event**：纯函数，严格实现 api-contract.md §3.2 的折叠表，有单元测试覆盖。
- **RunState**：`RunDetail` 字段 + 内部字段（不对外暴露）：
  - `searched_queries: set[str]`、`searched_windows: list[TimeWindow]`：避免重复检索
  - `page_refs: dict[doc_id, cache_key]`
  - `round_metrics: list[RoundMetrics]`：每轮新增独立证据数、新增里程碑、解决的缺口、核心声明判定变化
  - `pending_actions`、`next_step`：用于检查点恢复
- **检查点**：每个步骤结束时把 RunState 序列化写入 checkpoints 表（只保留最近 5 个）。恢复时 usage 计数沿用检查点值，**不重置**。

---

## 7. 工作流状态机

```
assess → plan → collect → verify → update → decide ─┬─ continue → plan（research_round + 1）
                                                    └─ write → write → review → finalize ─┬─ finish → 结束
                                                                                          ├─ repair_report → write
                                                                                          └─ reverify → verify → update → write
```

每个步骤：发 `step.started` → 执行 → 发实体事件 → 发 `step.completed` → 写检查点 → 检查取消与预算。下面逐步说明，"LLM:" 标出该步调用的模型角色与输出模型。

### 7.1 assess：理解任务

- 输入：RunRequest；有 seed_url 时先读取种子文档（provider = `seed`，作为第 0 轮文档）。
- LLM: controller → `AssessOutput { needs_clarification: bool, clarification_questions: [ClarificationQuestion], task: TaskSpec }`
  - 拆出 3~6 个子问题，至少 1 个 core，且第一个 core 问题就是用户问题本身；推断 event_type 并给出 stage_model（每类事件的默认阶段表放在代码常量中，LLM 可调整）；给出初始窗口与假设。
  - 规划发生在检索之前：子问题、实体、假设不得预设请求和种子链接里没有的具体人名、结果、日期、数字（prompt 约束），否则模型的先验会被当成待查事实、把研究带偏。
  - stage_model 只允许 2~6 个 snake_case 英文通用阶段标签（`^[a-z][a-z_]{1,31}$`，最多 8 个）；出现任何不合格标签（叙述句、含日期或人名）时整体改用事件类型的默认阶段表（`other` 为空，前端不显示阶段条）。
  - 触发澄清的情形：指代不明（"那家公司"）、同名事件多个、问题缺少可判定的对象。只要能做出合理假设就不澄清，而是写进 assumptions。
- 澄清流程见 api-contract.md §2.2。收到答案后带着答案再调一次 assess。
- 事件：`task.assessed`。
- base 条件下 `initial_window` 固定为 `[cutoff - default_lookback_days, cutoff]`（默认 3650 天，即不做时间规划、只受截止时间约束）。

### 7.2 plan：规划调查

- 第 1 轮：根据子问题生成初始检索动作（每个 core 问题至少 1 条 search）。
- 第 2 轮起：输入 = 开放缺口（按优先级排序）+ 已检索查询/窗口 + 预算余量。
- LLM: controller → `PlanOutput { rationale, windows: [TimeWindow], source_strategy, actions: [ActionDraft] }`，ActionDraft = `{type, gap_id, question_ids, rationale, query?, window?, date?, url?, claim_id?}`。
- 代码校验与修正：
  - 过滤掉当前机制不允许的动作类型（§14）；
  - 去掉与 `searched_queries` 规范化后重复的查询；
  - 截断到 `max_actions_per_round` 条，并受剩余工具调用预算约束；
  - as_of 模式下窗口的 end 不得晚于 cutoff。
- 事件：`plan.created`，以及每个动作的 `action.upserted(status=planned)`。

### 7.3 collect：收集证据

- 按动作并发执行（`action_concurrency`），每个动作：`action.upserted(running)` → 工具调用（每次发 `tool.called`）→ `action.upserted(done/failed, result)`。
- 动作语义（具体检索参数见 §8）：
  - `search`：按 query + window 搜索。
  - `read`：读取指定 URL。
  - `expand_window`：把检索窗口向前（或向后）延伸，用同一子问题的查询在新区间重搜。
  - `narrow_window` / `focus_date`：在某个日期 ±3 天内针对性检索（查询中加入日期表述）。
  - `trace_origin`：对某声明/文档，提取其 attribution（如"据路透社""公司公告称"），检索原始出处（官方新闻稿、监管文件、首发媒体）。
  - `corroborate`：为某声明寻找不同来源组的独立报道（查询排除已有域名，或换 provider）。
- 搜索结果先按 URL 去重、按发布时间过滤（as_of 模式：published_at 晚于 cutoff 的结果仍入库但标记 `available_at_cutoff=false`，不进入证据），然后按相关性取前 `max_reads_per_round` 条读取正文。
- 读取后：确定 `published_at`（优先页面元数据 htmldate，其次搜索 API，再次正文推断）→ 发 `document.added`。
- LLM: extractor → 每篇文档抽取与任务相关的**逐字引用段落**（`EvidenceOutput { passages: [{quote, event_date_text?}] }`），代码校验 quote 确为原文子串（允许空白差异；不是子串的丢弃），用 dateparser 把 event_date_text 标准化为 DateRef → 发 `evidence.added`。
- 预算：每次 LLM/工具调用后更新 BudgetTracker 并节流发出 `budget.updated`。

### 7.4 verify：核实声明与时间

见 §9。产出 `claim.upserted`、`origin_group.upserted`，并在 verdict 变化时把旧状态追加到 claim.history。

### 7.5 update：更新研究状态

- 由声明生成/更新时间线：LLM（extractor）从 supported/conflicting 声明中**只挑出发生过的离散事件**（宣布、发表、裁决、发布等），合并成时间线条目（`TimelineOutput`）；"截至某日仍未……"之类的状态陈述、定义、背景常识不进时间线（它们写进报告）。代码不再把未被选中的声明逐条补入；同一声明只进入第一个包含它的条目。代码负责 id 稳定（同一组声明对应同一条目，用声明集合的哈希做匹配键）、排序、聚合 verdict（条目内声明全部 supported → supported；任一 conflicting → conflicting；以此类推）。`is_milestone`：对应 stage_model 中阶段的条目。
- 更新子问题状态（LLM controller 判断每个问题是否已被 supported 声明回答，代码校验 `answer_claim_ids` 存在）→ `question.updated`。
- 缺口检测（§10）→ `gap.upserted`。
- 计算本轮 RoundMetrics。

### 7.6 decide：继续还是写报告

见 §11，产出 `decision.made`。

### 7.7 write：撰写报告

见 §12.1，产出 `report.updated`。

### 7.8 review：审查报告

见 §12.2，产出 `review.completed`，然后由 finalize 决策（§11.3）。

### 7.9 结束

- 发最终 `report.updated`（`is_partial` 与 `stop_reason` 已填）→ `run.finished`。
- status 判定见 §11.3「运行状态」：删去未通过核查的句子后，直接答案仍有可核实内容，且没有"被预算 / 时间截断而 core 问题未答"的情形 → `completed`；否则 → `partial`；未产出任何报告的异常 → `failed`。
- 运行级 `stop_reason`（RunSummary / Report / run.finished 中）表示**整个运行为何结束**：completed → `review_passed`；partial → 限制性原因（`budget_exhausted` / `time_limit` / `no_progress` / `review_unresolved`）；cancelled → `cancelled`；failed → `error`。研究循环为何结束记录在 `write_report` 决策的 `Decision.stop_reason` 中（`questions_answered` / `no_progress` / `budget_exhausted` / `time_limit`）。
- 任意步骤抛出未处理异常：发 `run.error`；若已有可用证据，**尽量写出 partial 报告**（跳过审查），再发 `run.finished(failed 或 partial)`。

---

## 8. 工具层

### 8.1 统一接口

```python
class SearchHit(BaseModel):
    url: str; title: str; snippet: str
    published_at: datetime | None; provider: str; score: float | None

class SearchProvider(Protocol):
    name: str
    async def search(self, query: str, *, start: date | None, end: date | None,
                     max_results: int) -> list[SearchHit]: ...

class Page(BaseModel):
    url: str; final_url: str; title: str; text: str
    published_at: datetime | None; published_at_source: str
    author: str | None; publisher: str | None; language: str | None

class ContentReader(Protocol):
    async def read(self, url: str) -> Page: ...
```

### 8.2 实时搜索（live）

- Tavily：`topic="news"`，传入起止日期；Exa：`start_published_date` / `end_published_date`，需要正文时请求 contents.text。参数以官方文档为准。
- **路由**（`tools/retrieval.py`）：默认 Tavily 做新闻检索，Exa 做"找原始出处 / 语义相似报道"（trace_origin、corroborate），顺序由 settings.yaml 的 `news_order` / `verification_order` 配置。一个 provider 失败时自动切换到另一个，并发 `log` 事件说明。
- 搜索 API 的日期过滤不可靠：一律以读取正文后确定的 published_at 为准做截止时间判断。
- 读取正文：provider 自带的正文优先，失败回退 httpx + trafilatura（超时 15s，限制 2MB，User-Agent 用通用客户端名）。读不到的页面记一次失败的 `tool.called`，不重试超过 1 次。

### 8.3 缓存与录制

- 所有 search/read 经过 `cache.py`。live 模式下若 `record_snapshot_id` 非空（评测时使用），把读到的文档追加进该快照的文档池。

### 8.4 本地索引（snapshot 与 corpus 模式）

- `LocalIndexProvider` 同时实现 SearchProvider 与 ContentReader：BM25 检索文档池，按 published_at 做日期过滤，read 直接返回池中正文。
- snapshot：文档池来自录制（§8.3），用于 2×2 受控对比——四个条件面对同一冻结文档池。
- corpus：文档池来自 BrowseComp-Plus 官方语料，**禁用外网搜索**。
- CLI：`newsagent snapshot build --id <snapshot_id> --from-runs <run_id> ...`、`newsagent snapshot from-experiments --exp <exp_id> ... --id <snapshot_id>` 与 `newsagent snapshot list`。

---

## 9. 核实模块

### 9.1 声明抽取与去重

- LLM: extractor → 从本轮新证据抽取**原子声明**（一条声明只断言一件事：谁、做了什么/处于什么状态、何时）：`ClaimDraft { text, subject, stage?, event_date_text?, question_ids, evidence_id, relation }`。
- 与已有声明去重：先做规范化文本比较，再把候选与已有声明列表一起交给 LLM 判断"是否同一断言"（批量，一次最多 30 条），合并后把证据链接挂到已有声明上。
- 声明文本使用 report_language；证据 quote 保持原文语言。

### 9.2 来源归并（research/provenance.py，仅 source_verification 开启时）

- 近重复检测：正文 5-gram shingle 的 Jaccard ≥ 0.6，或标题高度相似且发布时间相差 < 48h → 候选同组。
- attribution 抽取：LLM extractor 从正文抽取"据 X 报道 / X 公告称"，同一 attribution 指向的文档归同组，并尝试把 attribution 对应的原始文档设为 root（`is_original=true`）。
- 不同域名本身**不**证明独立。
- 未开启时：每篇文档视作独立来源（`origin_group_id=null`，独立来源数按文档计）。

### 9.3 关系判定

- LLM: reviewer 角色（与写作者分离）→ 对每个（声明，证据）对判定 `supports / contradicts / context / irrelevant`，并给出简短理由。批量调用，每批 ≤ 20 对。
- 冲突检查：当声明同时有 supports 与 contradicts 时，再调一次 LLM 检查双方的**主体、日期、条件**是否一致：
  - 不一致（例如一方说 3 月"同意收购"，另一方说 6 月"完成收购"）→ 不是冲突，拆分为两个带不同 stage/event_date 的声明；
  - 一致但说法相反 → 真实冲突，判为 conflicting；若能区分"历史变化"与"报道错误"，写入 rationale。

### 9.4 证据状态聚合（research/verdicts.py，纯函数）

```
可用证据 = 关系为 supports/contradicts，且（as_of 模式下）所属文档 available_at_cutoff != false
S = 支持证据所属的来源组集合（未开启来源核实时按文档计）
C = 反驳证据所属的来源组集合

if |S| > 0 and |C| == 0:   verdict = supported
elif |S| == 0 and |C| > 0: verdict = contradicted
elif |S| > 0 and |C| > 0:  verdict = conflicting   # 已经过 9.3 冲突检查后仍然对立
else:                      verdict = insufficient
independent_sources = |S|
```

- 判定变化时：把旧的 `{verdict, reason, round, at}` 追加进 `history`，再更新当前值。
- `supported` 只表示"有证据支持"，报告中不得表述为"已证实为真"。

### 9.5 时间适用性

- `applicable_at_cutoff`：
  - as_of：声明的 event_date.start ≤ cutoff，且至少有一条支持证据来自截止时间前已公开的文档 → true；event_date 晚于 cutoff → false；日期未知 → null。
  - retrospective：只看 event_date ≤ cutoff。
- 仅 temporal_planning 开启时：抽取并标准化 event_date，区分"发布日期"与"事件日期"（新发布的文章描述旧事件），对声明做阶段识别（stage）。
- 未开启时：event_date 取证据所属文档的发布日期（这正是提案指出的典型错误来源，作为基线）。

---

## 10. 缺口检测（research/gaps.py）

update 步骤运行检测规则，同类型同对象的缺口不重复开启（以 type + 关联 id 做去重键），已解决的缺口改为 resolved 并填 resolution。

| 缺口类型 | 检测规则 | 优先级 | 对应动作（受机制开关限制） |
|---|---|---|---|
| unanswered_question | 子问题状态为 open/partial | core 问题 high，否则 medium | search |
| missing_background | 最早的相关证据日期距窗口起点 < 7 天（说明窗口可能截断了背景），或 assess 标记需要背景 | medium | expand_window |
| missing_phase | stage_model 中某阶段既无时间线条目，且后续阶段已出现（例如有"完成"却没有"获批"） | high | search（带阶段关键词）/ focus_date |
| unclear_date | 答案依据（answer_claim_ids）中的**事件类**声明日期只精确到年，或有阶段（stage）却没有日期；"截至某日仍未……"等状态陈述和定义没有事件日期属正常，不记缺口 | medium | focus_date |
| conflict | 存在 conflicting 声明 | high | trace_origin + focus_date |
| single_source | 被 core 问题选为答案依据（answer_claim_ids）的 supported 声明 independent_sources == 1 且来源非原始；背景、定义类声明不记 | medium | corroborate |
| unverified_origin | 答案依据声明的支持证据都带 attribution，但原始出处未入库 | medium | trace_origin |

- `affects_main_answer`：关联到 core 问题或 core 问题所需的声明时为 true。
- `feasible`：同一缺口已尝试 ≥ 2 轮仍未解决，或对应动作类型在当前机制下不可用 → false（标记为 abandoned 并说明原因）。
- plan 步骤只从 `open` 且 `feasible` 的缺口中选，优先 `affects_main_answer && priority=high`。

---

## 11. 预算与停止策略

### 11.1 BudgetTracker（runtime/budget.py）

- 统计 BudgetUsage 全部字段；成本 = token × 价格表。
- `remaining_ratio()` = 各维度（工具调用、token、时间、成本）中**最紧**的剩余比例。
- 研究循环可用额度 = 总额 ×（1 − reserve_ratio）；写作与审查可以动用预留部分。
- 每次调用前做预检：若本次调用会让研究循环超出可用额度，则拒绝执行并抛出 `BudgetExceeded`，由控制器转入 write。
- LLM 调用设置 `UsageLimits` 作为第二道保险。

### 11.2 研究循环决策（research/stopping.py）

计算 DecisionSignals 后，按顺序判断：

1. 剩余研究额度 < `min_round_budget_ratio`，或已达 `max_research_rounds` → write，stop_reason = `budget_exhausted`（时间维度触发时为 `time_limit`）
2. `core_coverage ≥ threshold` 且 `open_high_gaps`（只计 feasible 的）== 0 → write，`questions_answered`
3. `no_progress_rounds ≥ no_progress_rounds_limit` → write，`no_progress`
4. 否则 → continue_research

"有进展"的定义（任一满足即可）：新增独立来源组且支持 core 相关声明；新增里程碑条目；解决了一个 high 缺口；core 声明 verdict 发生变化。**仅重复已有证据的文档不算进展。**

Decision.reason 由代码模板生成（可读、可复现），不由 LLM 生成。

### 11.3 审查后决策（finalize）

1. 审查通过 → finish（运行级 stop_reason 见 §7.9）
2. 有 high 级问题，且 review_round < max_review_rounds、预算允许：
   - 问题类型为 unsupported_citation / temporal_error / stage_confusion / unavailable_at_cutoff 且涉及证据本身 → reverify（回到 verify，只针对相关声明）
   - 否则（表述、遗漏）→ repair_report（带着问题清单重写）
3. 否则 → finish。

修复触发条件是"审查未通过"（中等问题超限同样触发），不只看 high；只有涉及证据本身的 high 问题走 reverify，其余走 repair_report。

交付清理（finish_report）：最后一轮审查中仍为 open 的高 / 中严重度事实性问题（unsupported_citation / unavailable_at_cutoff / temporal_error / stage_confusion / other）对应的句子从报告中删除；无引用的句子只在 uncertainty 章节保留。交付的报告因此只含通过核查的句子，审查器的内部意见不写入 open_questions。

运行状态（final_reason）：清理后直接答案没有可核实的句子 → `partial` / `review_unresolved`；研究被预算或时间截断（`budget_exhausted` / `time_limit`）且 core 问题未答 → `partial` / 对应原因；其余（含"已查尽但公开信息不足"，由正文如实说明）→ `completed` / `review_passed`。子问题提示词明确：有充分证据表明"尚未发生 / 仍未解决"也算完整回答。

---

## 12. 写作与审查

### 12.1 写作

- LLM: writer → `Report`（结构见契约）。输入：任务、子问题及状态、按时间排序的声明表（id、文本、verdict、日期、独立来源数、适用性）、时间线、证据 quote（仅限被引用候选的）、开放缺口。
- 写作约束（写进 prompt，并由代码校验）：
  - 每个陈述事实的句子必须有 ≥ 1 个 evidence_id；纯过渡句可以没有。
  - 引用的 evidence 必须存在，且 as_of 模式下必须截止时间前可用（代码校验，不合格的引用剔除并记一条 review finding）。
  - 引用 conflicting / insufficient 声明时必须使用限定语（"有报道称……但……"、"尚无证据表明……"）。
  - 区分阶段：不得把"宣布"写成"完成"。
  - 章节：answer（必有）、background、timeline_analysis、analysis、uncertainty（有开放缺口或冲突时必有）。
  - 带引用的句子不得加入引文没有说的细节、数字、定性或推论（审查最常见的 unsupported_citation 来源）；超出来源的判断要么不写，要么写成不带引用的不确定性句。
  - `Report.open_questions` = 未答子问题 + 写作者归纳的开放问题；内部缺口（单一来源、日期不清等）是研究工作清单，不进入报告。
- 重写模式：额外输入上一版报告与审查问题清单，version + 1。

### 12.2 审查

审查逐句进行，四类检查：

1. **引用支持**（LLM reviewer）：句子 vs 其引用的 quote，判定是否被支持 → `unsupported_citation`。
2. **时间与阶段**（代码 + LLM）：句中日期与关联声明 event_date 一致；阶段用词与声明 stage 一致 → `temporal_error` / `stage_confusion`。
3. **截止时间可用性**（代码）：引用的文档 published_at ≤ cutoff（as_of 模式）→ `unavailable_at_cutoff`。
4. **遗漏**（LLM reviewer）：core 问题是否都有回答；supported 的里程碑是否都被提及 → `omission`。

`passed` = 无 high 级问题且 medium 级 ≤ max(2, 句子数的 10%)。审查提示词明确了严重度标定（high 仅限改变核心答案或把错误事实当作已确立的情形），每批最多报告 6 条最严重的问题；通过阈值在开发任务上校准后冻结。审查器与写作者使用不同的 prompt（角色分离），可以配置不同模型。

---

## 13. 记忆层与上下文工程（llm/context.py）

对应提案"外部运行时层维护记忆"的设计：

- 记忆的权威存储就是 RunState（计划、已检索区间与查询、开放问题、原始证据、来源关系、时间线、预算使用）。模型本身不保存任何跨调用记忆。
- `ContextBuilder.build(role, step, budget_tokens)` 为每次 LLM 调用组装上下文：
  - 固定部分：任务、子问题状态、截止时间与模式、预算余量；
  - 摘要部分：声明表（一行一条：id | 文本 | verdict | 日期 | 来源数）、开放缺口、已检索查询与窗口列表（用于避免重复检索）；
  - 按需加载：只有 verify / write / review 步骤才加载相关声明的证据原文 quote。
- 摘要必须保留 id、日期条件与分歧，确保压缩后仍能回溯到原始证据。
- 上下文超出 budget_tokens 时的裁剪顺序：先删 supporting 问题相关的声明 → 再删已解决的缺口 → 最后截断低优先级证据。
- 评估项（见 evaluation-spec.md）：恢复后状态一致性、摘要可回溯性、重复检索率。

---

## 14. 机制开关（2×2 条件）

| 行为 | base | source | temporal | full |
|---|---|---|---|---|
| 初始窗口 | 固定 lookback | 固定 lookback | LLM 规划 | LLM 规划 |
| 可用动作 | search, read | + trace_origin, corroborate | + expand_window, narrow_window, focus_date | 全部 |
| 来源归并 / 独立来源计数 | 否（按文档计） | 是 | 否 | 是 |
| 事件日期抽取 / 阶段识别 | 否（用发布日期） | 否 | 是 | 是 |
| 缺口类型 | unanswered_question | + single_source, unverified_origin, conflict | + missing_background, missing_phase, unclear_date, conflict | 全部 |
| 截止时间文档过滤（as_of） | 是 | 是 | 是 | 是 |
| 基础引用检查（引用存在、可用） | 是 | 是 | 是 | 是 |
| 研究循环与停止策略 | 是 | 是 | 是 | 是 |

由 `RunRequest.mechanisms` 控制；实现上用一个 `MechanismPolicy` 对象集中判断，禁止在各模块里散落 if 判断。

---

## 15. LLM 调用层（llm/runner.py）

- 统一入口：`await llm.run(role, prompt_name, inputs, output_type) -> output`，内部：渲染 Jinja2 模板 → 选择角色对应的模型 → PydanticAI Agent 结构化输出 → 记录用量与成本 → 更新 BudgetTracker。
- 结构化输出模式按配置档的 `structured_output` 选择（tool / native / prompted），可用 `role_output` 按角色覆盖；`extra_body` 透传供应商参数（如关闭思考模式）。兼容不支持 JSON Schema 严格模式的 OpenAI 兼容供应商。
- 一律流式请求：部分网关会在约 60 秒无数据时断开非流式连接，长输出（RACE 评分、写作）会被截断。HTTP 读超时 900 秒；研究调用另受运行时间预算约束。
- 校验失败时带纠正提示重试 ≤ 2 次；429 指数退避 ≤ 8 次，其他网络错误 / 5xx / 超时 ≤ 3 次，退避上限 60 秒加抖动。退避时间计入 `pause_seconds`，不占运行时间预算；被拒绝的请求不计为一次模型调用。
- 进程级在途请求上限 `NEWSAGENT_MAX_LLM_INFLIGHT`（默认 4），避免触发账号级限流。
- 模型提议结构（`workflow/drafts.py`）在校验前做确定性规整：时间戳截为日期、只到年 / 月的窗口补成期初 / 期末、单点日期精度不足时置空、可空参数补 null、超长列表截断为前 N 项。规划连续无效时退回默认检索动作，不终止运行。
- prompt 模板用英文编写（模型表现更稳定），通过 `{{ report_language }}` 变量控制输出语言。
- 每次调用写一行 JSONL 调试日志（`data/logs/<run_id>.jsonl`：角色、模板、token、耗时、是否重试、错误摘要），不记录密钥。
- 测试中用假模型（`tests/test_workflow.py` 的 `FakeLLM`）替换真实模型。

---

## 16. 测试策略

| 测试文件 | 内容 | 网络/密钥 |
|---|---|---|
| `test_contract.py` | 用 `contracts/schema.json` 校验 HTTP 响应与每个事件；`run_events.json` 依次折叠等于 `run_snapshot.json`；后端事件流折叠结果等于 `GET /runs/{id}`；分页 | 否 |
| `test_runtime.py` | 中断恢复时的任务所有权、预算延续、长事件流 | 否 |
| `test_workflow.py` | 假模型 + 本地文档池跑完整流程，覆盖审查修复与恢复 | 否 |
| `test_mechanisms.py` | 停止决策顺序、来源计数、日期标准化、近重复归并 | 否 |
| `test_stage_conflict.py` | 同一交易不同阶段的声明拆分、基线条件的日期行为 | 否 |
| `test_review_limits.py` | 审查额度用尽后的 partial 报告、中断前状态恢复 | 否 |
| `test_research_quality.py` | 日期解析、阶段模型、时间线收录、审查修复与交付清理 | 否 |
| `test_drafts.py` | 模型输出的校验前规整（日期精度、可空参数、超长列表、错放字段） | 否 |
| `test_providers.py` | 检索与模型适配器的请求格式、降级与用量 | 否 |
| `test_evaluation.py` | 上游格式小样本上的四个条件、续跑、评分与汇总 | 否 |
| `test_live.py` | 真实供应商冒烟测试（`NEWSAGENT_LIVE_TEST=1` 且 `pytest -m live`，默认跳过） | 是 |

本地检查命令：`uv run ruff check && uv run pyright && uv run pytest`。

---

## 17. 运行方式

```bash
cd backend
uv sync
cp .env.example .env               # 填入密钥，或运行 scripts/set-keys.ps1
uv run newsagent serve             # 监听 127.0.0.1:8000
```

另开终端运行前端：`cd frontend && npm run dev`，浏览器打开 http://localhost:5173。

CLI 入口（`newsagent = "newsagent.cli:app"`）：

| 命令 | 说明 |
|---|---|
| `serve [--fixture-mode]` | 启动 API 服务；`--fixture-mode` 回放契约样例，不需要密钥 |
| `run <question> --cutoff ... --budget ...` | 命令行执行一次研究，打印进度并输出报告 |
| `snapshot build / from-experiments / list` | 从运行或实验构建冻结快照、列出快照 |
| `eval prepare / run / pilot / grade / aggregate` | 评测流水线，见 [评测设计](evaluation-spec.md) |

## 18. 实现说明

- 历史截止时间（as_of）模式下，发布时间未知的文档仍保留在来源页，但报告及证据引用只使用已知在截止时间前公开的来源。
- Pydantic 模型保留 API 契约原字段；写入事件时重新校验实际序列化载荷，SQLite 重放与 SSE 使用同一折叠表。
- 检索与正文阶段的运行内副本用于恢复，费用计量独立持久化，中断后不会重置。
- 在同一数据目录中，API 可以查看评测 CLI 正在写入的运行事件；任务所有权由本地文件锁保护，运行中的澄清与取消由启动该任务的进程处理。
- 调试日志只记录用量与错误摘要，不保存模型原始输出。
