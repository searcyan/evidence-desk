# API 契约

> 前端（`frontend/`）与后端（`backend/`）之间唯一的接口约定。前端自带一个完全遵守本契约的 mock 后端（`npm run dev:mock`），可与真实后端无缝切换。

## 0. 事实来源与一致性

| 内容 | 位置 | 说明 |
|---|---|---|
| 数据结构（字段、类型、枚举） | `frontend/src/api/types.ts` | **唯一事实来源**，每个字段都有中文注释 |
| JSON Schema | `contracts/schema.json` | 由 types.ts 自动生成（`cd frontend && npm run contract:schema`），后端测试用它校验响应 |
| 示例数据 | `contracts/fixtures/*.json` | 由 mock 后端导出（`npm run contract:fixtures`）：一次完整运行的快照、事件流、运行列表、实验详情、配置 |

规则：
1. 后端 Pydantic 模型逐字段对应 types.ts，字段名用 snake_case，与 types.ts 完全一致。
2. **可空字段必须输出键、值为 `null`，不得省略**（Pydantic 用 `model_dump(mode="json")`，不要 `exclude_none`）。
3. 时间戳为 RFC 3339 且带时区（统一 UTC，`2024-05-01T08:00:00Z`）；日期为 `YYYY-MM-DD`。
4. 契约变更流程：先改 types.ts → 重新生成 schema 与 fixtures → 更新本文档 → 前后端各自适配。后端不得单方面增删字段（新增字段需先补进 types.ts）。

## 1. 通用约定

- 基础路径：`/api`。开发时后端监听 `127.0.0.1:8000`，前端 Vite 开发服务器把 `/api` 代理过去。
- 请求与响应均为 `application/json; charset=utf-8`（SSE 除外）。
- 错误响应统一格式（HTTP 4xx/5xx）：

```json
{ "error": { "type": "validation_error", "message": "人类可读说明", "details": null } }
```

  `type` 取值：`validation_error`(422) / `not_found`(404) / `conflict`(409，如对终态运行执行 cancel) / `rate_limited`(429) / `internal_error`(500)。FastAPI 默认的 422 结构需用异常处理器转换成上述格式。

- ID 格式：带类型前缀的短 ID，便于调试：`run_` / `q_` / `act_` / `tc_` / `doc_` / `og_` / `ev_` / `cl_` / `tl_` / `gap_` / `dec_` / `sec_` / `p_` / `s_` / `rf_` / `exp_`。例如 `run_8f3k2a`。ID 在单个运行内唯一即可（run id 全局唯一）。

## 2. 端点一览

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `/api/health` | 健康检查（数据库、LLM、搜索 key 是否配置） | – | `HealthResponse` |
| GET | `/api/config` | 前端渲染表单所需配置 | – | `AppConfig` |
| POST | `/api/runs` | 创建并启动一次研究 | `RunRequest` | `201` + `RunSummary` |
| GET | `/api/runs` | 运行列表，按 created_at 倒序 | query：`status`(可多值，逗号分隔)、`q`(标题/问题模糊搜索)、`limit`(默认 50)、`cursor` | `RunListResponse` |
| GET | `/api/runs/{run_id}` | 运行完整快照 | – | `RunDetail` |
| GET | `/api/runs/{run_id}/events` | 事件流（SSE） | query：`after`(seq，默认 0) | `text/event-stream` |
| POST | `/api/runs/{run_id}/clarification` | 回答澄清问题 | `ClarificationAnswer` | `RunSummary` |
| POST | `/api/runs/{run_id}/cancel` | 取消运行 | – | `RunSummary`；终态返回 409 |
| POST | `/api/runs/{run_id}/resume` | 从最近检查点恢复失败/中断的运行 | – | `RunSummary`；非 failed 返回 409 |
| DELETE | `/api/runs/{run_id}` | 删除运行（运行中先取消） | – | `204` |
| GET | `/api/runs/{run_id}/export` | 导出 | query：`format=md\|json` | md：`text/markdown`，附件下载；json：`RunDetail` |
| GET | `/api/experiments` | 实验列表 | – | `ExperimentSummary[]` |
| GET | `/api/experiments/{exp_id}` | 实验详情 | – | `ExperimentDetail` |

### 2.1 POST /api/runs 的校验与默认值

- `question` 去首尾空白后 1~2000 字符。
- `cutoff` 必须带时区；**不得晚于当前时间**（as_of 模式下的未来截止时间无意义），否则 422。
- `budget_preset = "custom"` 时，`budget` 必须给齐 `BudgetLimits` 全部字段；其他预设下 `budget` 中出现的字段覆盖预设值。最终生效的预算写入 `RunSummary.budget`。
- `search_mode = "snapshot"` 时 `snapshot_id` 必须存在于 `AppConfig.snapshots`。
- `search_mode = "corpus"` 仅用于评测（BrowseComp-Plus），corpus 不可用时 422。
- 创建后立即返回 `status: "queued"`，运行在后台异步执行。

### 2.2 澄清流程

1. assess 步骤判定请求有歧义 → 发出 `clarification.requested` 事件，`run.status` 变为 `awaiting_clarification`，快照的 `clarification` 字段非空。
2. 前端弹窗，用户提交 `POST /clarification`。
3. 后端发出 `clarification.answered`，`clarification` 置回 `null`，状态回到 `running`，继续 assess。
4. 等待超过 `CLARIFICATION_TIMEOUT_SECONDS`（默认 1800）未回答：按 TaskSpec.assumptions 中的默认假设继续执行，并发一条 `log` 事件说明。
5. 澄清只允许发生在 assess 步骤，每个运行最多一次。

## 3. 事件流（SSE）

### 3.1 线格式

```
id: 42
event: claim.upserted
data: {"seq":42,"run_id":"run_8f3k2a","ts":"2024-05-01T08:00:03Z","type":"claim.upserted","data":{...}}

```

- `id` = `seq`；`event` = `type`；`data` = 完整的 `RunEvent` JSON（单行）。
- 每 15 秒发送一次心跳注释行 `: ping`。
- 连接建立后，先**回放**该运行中 `seq > after` 的全部历史事件，再推送实时事件。
- 运行到达终态、且所有事件都已发送后，发送 `event: end\ndata: {}\n\n` 并关闭连接。对已终态的运行请求事件流：回放完后立刻发 `end`。
- 前端用 fetch 流读取（非 EventSource），断线后用 `after=<最后收到的 seq>` 重连，因此 `Last-Event-ID` 请求头可选支持。
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。

### 3.2 快照 = 事件折叠（核心不变式）

**`GET /runs/{id}` 返回的快照，必须等于对该运行全部事件依次应用下表规则的结果。**前端正是这样维护实时状态的：先取快照，再从 `last_event_seq` 之后订阅事件，逐条应用。

| 事件 | 对快照的作用 |
|---|---|
| `run.status` | 设置 `status`、`phase`；首次进入 running 时设置 `started_at`（取事件 ts）；status 为 `queued`（恢复运行）时 `error = null` |
| `step.started` | 设置 `phase = step`；step 为 plan 时 `research_round = round`；step 为 review 时 `review_round = round` |
| `step.completed` | 无状态变化（仅用于活动日志与耗时展示） |
| `task.assessed` | `task = data`；`title = data.event_name` |
| `clarification.requested` | `clarification = data` |
| `clarification.answered` | `clarification = null` |
| `question.updated` | 在 `task.questions` 中按 id 替换 |
| `plan.created` | 追加到 `plans` |
| `action.upserted` | 在 `actions` 中按 id 替换，不存在则追加 |
| `tool.called` | 追加到 `tool_calls` |
| `document.added` | 追加到 `documents`；`counts.documents += 1` |
| `origin_group.upserted` | 在 `origin_groups` 中按 id 替换或追加；**同时把组内每个文档的 `origin_group_id` 设为该组 id** |
| `evidence.added` | 追加到 `evidence` |
| `claim.upserted` | 在 `claims` 中按 id 替换或追加；`counts.claims = claims.length` |
| `timeline.upserted` | 在 `timeline` 中按 id 替换或追加，然后按 `date.start` 升序排序；`counts.timeline_entries = timeline.length` |
| `timeline.removed` | 按 id 删除；更新计数 |
| `gap.upserted` | 在 `gaps` 中按 id 替换或追加；`counts.open_gaps = 状态为 open 或 in_progress 的数量` |
| `decision.made` | 追加到 `decisions` |
| `budget.updated` | `usage = data`（全量覆盖） |
| `report.updated` | `report = data` |
| `review.completed` | 追加到 `reviews` |
| `log` | 无状态变化 |
| `run.finished` | 设置 `status`、`stop_reason`、`finished_at`；`phase = null` |
| `run.error` | `error = data` |

每应用一条事件，`last_event_seq = seq`。

后端用同一套折叠逻辑维护内存中的 `RunDetail`，并把事件追加写入数据库（见 [后端设计](backend-spec.md) §5），因此快照与事件天然一致，契约测试直接验证"折叠事件 == 快照"。

### 3.3 事件发送规范

- `budget.updated`：每次 LLM 调用或工具调用结束后发送，频率不超过每秒 2 次（合并发送）。
- 实体变化必须发 upsert 事件，事件里带**完整实体**，不发增量补丁。
- 一个步骤的事件顺序：`step.started` → 若干实体事件 → `step.completed`。
- 运行结束顺序：`report.updated`(最终版) → `run.finished`。失败时：`run.error` → `run.finished(status=failed)`。
- `log` 用于给人看的过程说明（如"搜索返回 8 条结果，其中 5 条与已有来源重复"），level 为 info 时前端会在活动日志里展示，应简短。

## 4. 导出

`GET /runs/{id}/export?format=md` 生成 Markdown 报告：标题、截止时间与模式、答案、各章节（句末以 `[1][2]` 标注引用）、时间线表格、未解决问题、停止原因、参考来源列表（编号对应引用，含 URL、发布方、发布日期、是否原始来源）。文件名 `report-<run_id>.md`。

## 5. 实验数据

实验由评测 CLI 离线批量运行（见 [评测设计](evaluation-spec.md)），结果写入 `data/experiments/<exp_id>/`；`/api/experiments*` 端点只读这些结果文件，不负责启动实验。`ExperimentDetail.tasks` 中每条带 `run_id` 的任务结果，前端可以跳转到对应运行详情页。
