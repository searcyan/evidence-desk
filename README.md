# Evidence Desk

**基于证据的新闻事件研究 Agent。** 给出一个事件或问题和信息截止时间（可附一篇新闻链接），Agent 会自主检索、阅读并核实来源，输出一份**逐句带引用**的研究报告，包含直接答案、事件时间线、支撑证据和未解决问题。

本项目最初为香港大学 COMP7608B 课程项目。

## 核心机制

| 机制 | 作用 |
|---|---|
| **自适应时间规划** | 根据证据缺口扩大/缩小检索窗口、聚焦具体日期；区分发布日期与事件日期；检查每条信息在截止时间是否已公开 |
| **来源核实** | 追溯原始出处，把转载归为同一来源组，按独立来源计数，而不是按网页数 |
| **基于缺口的继续/停止决策** | 在共享预算下，根据未答问题、冲突、单一来源等缺口判断是否值得再检索一轮 |

两种时间模式：

- **as-of**：只使用截止时间前已公开的信息，回答"在当时看来事态如何"；
- **回溯（retrospective）**：使用截止时间前发生的全部事件，回答"事件到某日为止的完整经过"。

三个机制可以分别开关，构成 base / source / temporal / full 四个实验条件，用于消融对比。

## 系统架构

```
┌──────────────────────────┐   REST + SSE    ┌──────────────────────────────────────────────┐
│  前端 React + Vite + TS  │ ◀────────────▶ │  后端 FastAPI                                │
│  新建研究 / 运行详情      │   /api/*        │  RunManager ─▶ 工作流状态机（asyncio）       │
│  运行列表 / 实验评估      │                 │    assess → plan → collect → verify → update │
│  系统状态                 │                 │    → decide ⟲ → write → review ⟲ → finish    │
└──────────────────────────┘                 │  EventBus：事件溯源，快照 = 事件折叠          │
                                             │  SQLite 存储 · 磁盘缓存 · 本地 BM25 快照     │
                                             └──────────────┬───────────────────────────────┘
                                                            │
                                  OpenAI 兼容模型服务 · Tavily · Exa · 网页正文
```

- **代码驱动的显式状态机**：模型在每个步骤内产出结构化结果，控制流、预算与停止策略由代码执行，行为可审计、可复现。
- **事件溯源**：所有状态变化都是事件；前端实时展示、断点恢复与调试回放共用一套机制。
- **共享预算**：工具调用、token、时间、成本四个维度由代码强制约束，研究循环与审查循环共用同一预算，并为写作与审查预留额度。
- **可复现检索**：实时检索结果可冻结为本地快照，各实验条件在同一文档池上检索。

## 功能

| 页面 | 内容 |
|---|---|
| 新建研究 | 问题输入、截止时间（UTC）、时间模式、报告语言；设置中可指定事件名与起始文章、预算预设或自定义预算、机制开关、检索方式与模型配置 |
| 运行详情 | 工作流进度、预算仪表与活动日志；标签页：**报告**（结论与章节，悬停查看引用原文）、**时间线**（阶段进展与按年分组的事件）、**声明**（证据状态、独立来源数、截止时间适用性、修订历史）、**来源**（按出处分组，转载只计 1 个独立来源）、**过程**（每一步的计划、动作、决策信号与审查发现） |
| 澄清 | 请求有歧义时弹出对话框，可点选候选答案或自由输入 |
| 运行列表 | 状态筛选与搜索，显示条件、成本、耗时 |
| 实验评估 | 2×2 条件矩阵、各指标对比、质量-成本散点、预算扫描曲线、逐任务结果；所有图表可切换为表格 |
| 系统 | 健康检查、模型配置、检索服务、快照、预算预设 |

另外支持中英双语界面、浅色/深色主题、Markdown 与 JSON 导出、窄屏布局、SSE 断线重连。

## 仓库结构

```
├── backend/                  # Python 后端：API、工作流、检索、评测 CLI 与测试
│   ├── config/settings.yaml  # 模型配置档、价格表、预算预设、停止阈值
│   ├── scripts/set-keys.ps1  # 交互式写入密钥
│   └── src/newsagent/
├── frontend/                 # React + Vite + TypeScript 前端
│   ├── src/api/types.ts      # 接口数据结构的唯一事实来源
│   └── mock/                 # 内置 mock 后端（Vite 插件），演绎一个虚构事件
├── contracts/
│   ├── schema.json           # 由 types.ts 生成的 JSON Schema
│   └── fixtures/             # 由 mock 后端导出的示例数据
└── docs/                     # 设计文档（见下文「文档」）
```

## 快速开始

### 环境要求

- Python 3.12+ 与 [uv](https://docs.astral.sh/uv/)
- Node.js 20+
- 一个 OpenAI 兼容的模型服务，以及 [Tavily](https://tavily.com/) 或 [Exa](https://exa.ai/) 检索服务的 API Key

### 不需要密钥的体验方式

```bash
cd frontend
npm ci
npm run dev:mock        # 只运行前端与内置 mock 后端，打开 http://localhost:5173
```

mock 后端演绎的是一个**虚构**事件（"Northwind Robotics 收购 Helios Sensors"），覆盖转载归并、日期精化、误报溯源、窗口扩展、截止时间后信息排除、审查修复等情形。输入很短的问题（如 "Northwind deal?"）会触发澄清，选择小预算会得到部分报告。

### 连接真实后端

1. 安装后端依赖：

   ```bash
   cd backend
   uv sync
   ```

2. 配置密钥。复制 `backend/.env.example` 为 `backend/.env` 并填写，或在 PowerShell 中运行交互脚本（输入不回显，回车保留原值）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File backend\scripts\set-keys.ps1
   ```

3. 启动后端（默认监听 `127.0.0.1:8000`）：

   ```bash
   uv run newsagent serve
   ```

4. 另开终端启动前端，打开 http://localhost:5173 ：

   ```bash
   cd frontend
   npm ci
   npm run dev
   ```

前端开发服务器会把 `/api` 代理到 `127.0.0.1:8000`。`uv run newsagent serve --fixture-mode` 可以在不配置密钥的情况下回放示例运行。若系统设置了 `HTTPS_PROXY`，境外检索服务与网页读取会自动经代理访问。

## 配置

| 位置 | 内容 |
|---|---|
| `backend/.env` | 模型端点与密钥、检索服务密钥、端口、并发、缓存时长等，完整列表见 `backend/.env.example` |
| `backend/config/settings.yaml` | 模型配置档（四个角色对应的模型、结构化输出模式）、等价单价、预算预设（small / medium / large）、停止阈值、检索参数 |

默认研究模型档为 `minimax-m3`，评分使用独立的 `judge` 档（GLM-5.3-Flash）。任何 OpenAI 兼容服务都可以通过新增模型配置档接入。密钥只从环境变量读取，不会写入日志或 API 响应。

## 命令行

以下命令在 `backend/` 下执行：

```bash
# 执行一次研究并输出 Markdown 报告
uv run newsagent run "Which approvals did Microsoft obtain before closing the Activision Blizzard acquisition?" \
  --cutoff 2023-11-01T23:59:59Z --budget small --output ../data/report.md

# 用已有运行读到的正文构建冻结快照，并在快照上复现检索
uv run newsagent snapshot build --id news-pool --from-runs <run_id> --from-runs <run_id>
uv run newsagent snapshot list
uv run newsagent run "..." --cutoff ... --search-mode snapshot --snapshot news-pool
```

snapshot 与 corpus 模式下检索与正文读取都在本地完成，不访问外网检索服务。small 预算的典型运行约 1–2 分钟，medium 约 4–7 分钟。

## 评测

评测覆盖三个公开基准和一组人工构造案例，按 2×2 条件做消融对比：

| 基准 | 任务 | 主指标 |
|---|---|---|
| [Open-TLS](https://github.com/Alibaba-NLP/CHRONOS) | 新闻时间线摘要 | Date F1、AR-1/AR-2 F1 |
| [DeepResearch Bench](https://github.com/Ayanami0730/deep_research_bench)（时事子集） | 研究报告 | RACE、FACT 引用准确率 |
| [BrowseComp-Plus](https://github.com/texttron/BrowseComp-Plus) | 固定语料上的检索问答 | 答案正确率、证据召回 |
| 人工案例 | 状态演变、截止后信息泄漏、同源转载、说法冲突 | 截止时状态准确率 |

基本流程（详见 [评测设计](docs/evaluation-spec.md) 第 10 节）：

```bash
# 1. 整理官方数据并冻结 dev/test 划分（原始数据需先下载到 data/benchmarks/_src 与 _hf）
uv run newsagent eval prepare --benchmark open_tls
# 2. 在 record 划分上用实时检索录制文档池，冻结为快照
uv run newsagent eval run --exp rec_otls_full --benchmark open_tls --split record --conditions full --repeats 1 --budget medium --search-mode live --judge-profile judge
uv run newsagent eval run --exp rec_otls_base --benchmark open_tls --split record --conditions base --repeats 1 --budget small --search-mode live --judge-profile judge
uv run newsagent snapshot from-experiments --exp rec_otls_full --exp rec_otls_base --id otls_pool
# 3. 正式评测：四个条件共用同一快照
uv run newsagent eval run --exp otls_test --benchmark open_tls --split test --repeats 2 --budget medium --search-mode snapshot --snapshot otls_pool --judge-profile judge --concurrency 4
uv run newsagent eval grade --exp otls_test
```

- 相同实验 ID 会跳过已保存的组合；冻结信息（代码提交、配置与提示词哈希、模型、数据集哈希、快照、评委）不一致时拒绝续跑。
- 同一时间只运行一个评测进程，不要对同一实验 ID 并行启动两个进程。`--concurrency` 控制同时进行的运行数，`NEWSAGENT_MAX_LLM_INFLIGHT` 限制进程内同时在途的模型请求。
- 结果写入 `data/experiments/<exp_id>/`，可在前端「实验评估」页查看。
- 人工案例草稿位于 `docs/manual-cases/`，需按其中的说明完成双人标注后才计入评测。

## 开发

```bash
cd backend
uv run ruff check
uv run pyright
uv run pytest
```

测试默认不需要网络与密钥。验证真实供应商时同时配置模型与检索密钥，然后：

```powershell
$env:NEWSAGENT_LIVE_TEST = '1'
uv run pytest -m live
```

前端构建检查：`cd frontend && npm run build`。

**接口契约**：`frontend/src/api/types.ts` 是数据结构的唯一事实来源，后端输出必须通过 `contracts/schema.json` 校验。修改 types.ts 后执行：

```bash
cd frontend
npm run contract:schema     # 重新生成 contracts/schema.json
npm run contract:fixtures   # 重新导出 fixtures，并校验 schema 与折叠不变式
```

然后同步更新 [API 契约](docs/api-contract.md)。更多开发约定见 [AGENTS.md](AGENTS.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [后端设计](docs/backend-spec.md) | 架构、工作流状态机、核实与缺口算法、预算与停止策略、配置 |
| [API 契约](docs/api-contract.md) | 端点、SSE 语义、"快照 = 事件折叠"不变式 |
| [评测设计](docs/evaluation-spec.md) | 基准适配、指标、实验设计、与官方协议的差异 |
| [人工案例标注指南](docs/manual-cases/README.md) | 候选案例与双人标注流程 |

## 已知局限

- 评测分数取决于冻结的语料、评委模型与指标实现；评委模型与官方不同，分数**不可与官方排行榜直接比较**，只用于条件间对比。
- 有付费墙、发布日期缺失或来源不明确的事件可能只得到部分报告。as-of 模式只引用发布时间已知且早于截止时间的资料。
- `supported` 只表示"有证据支持"，不等于"已证实为真"。
- 等价成本按配置中的单价估算；评委模型的思考 token 不计入评分成本，会低估实际消耗。
- 调试日志只记录用量与错误摘要，不保存模型原始输出。
- 仅面向本地单用户运行：没有用户系统与鉴权，服务默认只监听 127.0.0.1。

## 许可证

[MIT](LICENSE)。`backend/src/newsagent/eval/official/` 中的官方评测提示词遵循各自上游项目的许可，见该目录下的 NOTICE。
