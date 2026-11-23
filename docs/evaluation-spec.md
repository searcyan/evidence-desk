# 评测设计

> 评测代码位于 `backend/src/newsagent/eval/`，结果写入 `data/experiments/<exp_id>/`，前端"实验评估"页通过 `/api/experiments*` 读取（结构见 `ExperimentDetail`）。

## 1. 总体原则

1. **生成与评分分离**：`eval run` 只负责产出（运行 Agent、保存报告、时间线和检索日志），`eval grade` 负责打分，`eval aggregate` 负责汇总。评分成本单独计入 `grading_cost_usd`。
2. **可续跑**：以（benchmark, task_id, condition, repeat）为键，已完成的组合不重跑。
3. **冻结后再测试**：pilot 阶段确定预算档位、停止阈值、prompt、路由规则，冻结后记录到 manifest；测试集上不再调参。
4. **防泄漏**：参考答案和参考时间线绝不进入 Agent 输入；开发集与测试集按事件/主题划分。
5. **结果分开报告**：三个 benchmark 测的是不同任务，不合并成一个总分。子集结果必须标注为子集。

## 2. 目录与文件

```
data/benchmarks/
  open_tls/               # 从 CHRONOS 仓库获取的 Open-TLS 数据
  deepresearch_bench/     # 官方仓库数据
  browsecomp_plus/        # 官方 queries、qrels、corpus
  manual/cases.jsonl      # 人工构造案例（§6）
  splits/<benchmark>.json # {"dev": [...task_ids], "test": [...task_ids]}，由固定随机种子生成，生成后不再覆盖
data/experiments/<exp_id>/
  manifest.json           # ExperimentSummary + 冻结信息（见 §7）
  outputs/<benchmark>/<task_id>/<condition>/r<repeat>.json   # run_id、报告、时间线、检索日志、用量
  grades/<benchmark>/<task_id>/<condition>/r<repeat>.json    # 各指标分数 + 评分用量
  tasks.jsonl             # TaskResult，每行一条
  summary.json            # ExperimentDetail（API 直接返回此文件内容）
```

## 3. Open-TLS（主评测）

- **来源**：CHRONOS 仓库（https://github.com/Alibaba-NLP/CHRONOS）。
- **输入映射**：`question` = 官方查询，`cutoff` = 主题目录名中的日期（官方 freshness 上限），`temporal_mode = retrospective`，`report_language = en`（详见 §10.2）。
- **输出映射**：取运行结果的 `timeline`，每个条目 → `(date.start, title + ". " + summary)`。日期数量截断到与参考时间线相同（TLS 评测的标准做法），优先保留 `is_milestone` 条目，再按关联声明的独立来源数排序。
- **指标**：
  - `date_f1`：预测日期集合与参考日期集合的 F1（主指标）。
  - `ar1_f1`、`ar2_f1`：按日期对齐的 ROUGE-1 / ROUGE-2 F1（alignment-based ROUGE，Martschat & Markert 2018），使用 `tilse` 实现，与 CHRONOS 评测脚本一致。
- **检索方式**：受控对比用 snapshot 模式（先用 live 模式在 record 划分上录制文档池并冻结，见 §10.3 第 6 条）；另外可以单独报告一组 live 模式结果作为演示。

## 4. DeepResearch Bench

- **来源**：https://github.com/Ayanami0730/deep_research_bench。共 100 个博士级研究任务（中英各半），**大多不是新闻事件**，因此只选与时事/事件相关的子集，在报告中注明子集规则和任务 id。
- **输入映射**：`question` = 任务 prompt，`cutoff` = 运行当天，`temporal_mode = retrospective`，`report_language` 跟随任务语言，`search_mode = live`。
- **输出映射**：导出 Markdown 报告（`export_md.py`），引用以 `[n]` 标注，文末列出 URL，满足官方评测输入格式。
- **指标**：
  - RACE：`race_overall`（主指标）、`race_comprehensiveness`、`race_depth`、`race_instruction`、`race_readability`。
  - FACT：`fact_citation_accuracy`（引用支持率）、`fact_effective_citations`（每任务有效引用数）。
- **评测模型**：官方使用 Gemini 系列作为评委；本项目使用替代评委（见 §10.3），结果**与排行榜不可比**，只用于条件间对比。

## 5. BrowseComp-Plus

- **来源**：https://github.com/texttron/BrowseComp-Plus。固定语料库 + 人工核实的证据文档标注（qrels）。
- **运行方式**：`search_mode = corpus`，**禁用外网搜索**；在官方语料上建 BM25 索引（SQLite FTS5，见 §10.3）。
- **输入映射**：`question` = 问题，`cutoff` = 运行当天，`temporal_mode = retrospective`。只测适用的机制：source 条件下的 corroborate / trace_origin 有意义；时间动作在该数据上大多不适用，照常运行但单独说明。
- **输出**：最终答案（取报告 answer 段落第一句；另外让 writer 额外输出一个 `short_answer` 字段，只在 eval 中使用，不进入契约），以及检索日志（每次 search 返回的 doc_id 排序列表、读取过的 doc_id）。
- **指标**：
  - `accuracy`：答案正确率（主指标），用官方评测 prompt 做 LLM 评判。
  - `evidence_recall`：运行过程中检索到的文档覆盖证据文档的比例（官方 Recall 定义优先）。
  - `ndcg_at_10`：按文档首次出现顺序合并的检索结果列表，对照 qrels 计算 nDCG@10。
  - 同时记录 `search_calls`。

## 6. 人工构造案例（manual）

- **规模**：目标 20~30 个案例，覆盖四类情形（候选草稿与标注流程见 `docs/manual-cases/`）：
  1. 旧闻新发（新发布的文章描述旧事件）
  2. 同源转载（多家网站转载同一公告）
  3. 状态演变（宣布 → 获批 → 完成，或计划被撤回）
  4. 说法冲突（报道互相矛盾，或后续发了更正）
- **标注格式**（`cases.jsonl` 每行）：

```json
{
  "case_id": "m_001", "category": "evolving_state",
  "question": "...", "cutoff": "2024-06-30T23:59:59Z", "temporal_mode": "as_of",
  "reference_facts": [{"id": "f1", "text": "...", "event_date": "2024-03-12", "stage": "announced", "available_by": "2024-03-12"}],
  "reference_status_at_cutoff": "approved_not_closed",
  "provenance": [{"urls": ["...", "..."], "origin": "company press release", "independent": false}],
  "annotators": ["A", "B"], "disagreements_resolved": true
}
```

- 两名标注者独立标注，再对齐分歧；保留双方原始标注以便计算一致率。
- **指标**：
  - `citation_support`：在被评估的（声明句，引用）对中，被所引段落支持的比例。先用 LLM 评判全部对，再人工抽查 ≥ 20% 校准评委。
  - `factual_correctness`：报告中可核对的声明与参考事实一致的比例；无法判定的单列，不计入分母。
  - `temporal_error_rate`：事件日期错误、阶段混淆、引用截止时间时尚不可得的证据，三类错误合计占比。
  - `provenance_accuracy`：系统判定"独立"的报道中真正独立的比例。
  - `status_accuracy`：截止时间时的事件状态判断是否与 `reference_status_at_cutoff` 一致（主指标）。
- **记忆检查**：每个案例在中途某个检查点强制中断再恢复，检验恢复后证据、时间线、预算是否一致（应完全一致），以及摘要中的 id 能否回溯到原始证据；另外统计重复检索率（规范化后重复的查询 / 全部查询）。

## 7. 实验设计

- **Pilot**：每个 benchmark 取 5 个开发任务，用 full 条件跑 small / medium / large 三档预算，估算耗时与成本 → 确定测试规模、子集规则、task id 和预算上限，写入 manifest 后冻结。
- **2×2 对比**：base / source / temporal / full 四个条件，使用同一模型配置档、同一检索资源（snapshot 或 corpus）、同一预算上限。每个测试任务每个条件重复运行（默认 2 次）。
- **预算扫描**：在 Open-TLS 上对 base 与 full 两个条件各跑三档预算，产出 `budget_levels`，画质量-成本曲线。
- **统计**：报告均值、标准差（重复之间）、任务层面的波动；条件间做配对比较（按任务取重复均值后做配对 bootstrap，给出 95% 置信区间），样本量小时如实说明。
- **manifest 冻结信息**：git commit、settings.yaml 哈希、prompts 目录哈希、模型 id、数据集版本/提交号、snapshot id、评委模型与评测脚本版本、split 文件哈希。

## 8. CLI

```bash
newsagent eval run --exp <exp_id> --benchmark open_tls --split test \
  --conditions base,source,temporal,full --repeats 2 --budget medium \
  --search-mode snapshot --snapshot <snapshot_id> --concurrency 2
newsagent eval grade --exp <exp_id> [--benchmark ...]
newsagent eval aggregate --exp <exp_id>      # 生成 tasks.jsonl 与 summary.json
newsagent eval pilot --benchmark open_tls --n 5
```

- 每个评测运行都是普通的运行（会出现在 `/api/runs` 中，tags 带 `exp:<exp_id>`、`cond:<condition>`），因此在前端可以逐个打开查看推理过程。
- `aggregate` 输出的 `metric_defs` 需标明各指标的 benchmark、方向、单位，以及是否为主指标（前端据此渲染）。

## 9. 预期与如实报告

如实报告有限的提升、负面结果和成本上升。summary 中保留失败任务（status = failed），不得剔除；局限性（页面无法访问、溯源不确定、参考事实不完整、评委误差）写入实验 notes。

## 10. 数据接入、评分协议与实现差异

### 10.1 数据准备（可复现）

原始数据先人工下载到 `data/benchmarks/_src/`（三个官方仓库的 git 浅克隆：`_src/CHRONOS`、`_src/deep_research_bench`、`_src/BrowseComp-Plus`，地址见本节末尾）与 `data/benchmarks/_hf/`（BrowseComp-Plus 的 HuggingFace parquet：`Tevatron/browsecomp-plus` 的查询分片 `data/test-00000-of-00006.parquet` 放入 `_hf/queries/`，`Tevatron/browsecomp-plus-corpus` 的 `data/train-0000{0..6}-of-00007.parquet` 共 7 个分片放入 `_hf/corpus/`；HF 单连接较慢，建议用 `curl -C - --retry 20` 并行断点续传），然后执行：

```bash
uv run newsagent eval prepare --benchmark open_tls
uv run newsagent eval prepare --benchmark deepresearch_bench
uv run newsagent eval prepare --benchmark browsecomp_plus   # 解密查询 + 构建语料 FTS5 索引
uv run newsagent eval prepare --benchmark manual            # 需先完成 docs/manual-cases 的双人标注
```

`prepare` 生成 `data/benchmarks/splits/<benchmark>.json`（含划分规则与随机种子 7608）。划分一经生成即冻结，再次运行只校验不覆盖。

### 10.2 各 benchmark 的评分协议

| 基准 | 输入映射 | 评分（与官方实现的对应关系） |
|---|---|---|
| Open-TLS | 查询取 CHRONOS `news_keywords.py` 的官方查询；截止时间取主题目录名中的日期（官方 freshness 上限）；回溯模式 | 与 CHRONOS `evaluation.py` 一致：参考时间线合并为 tilse `GroundTruth`，预测日期数截断到参考日期并集大小；Date F1 为日期集合 F1；AR-1/AR-2 为 `align_date_content_costs_many_to_one` 的 ROUGE-1/2 F1 |
| DeepResearch Bench | 时事子集（正则规则见 splits 文件）；回溯模式 | RACE：官方逐任务评分标准 + 官方参考报告 + 官方 `generate_merged_score_prompt`，按维度权重求加权平均，最终分 = target / (target + reference)，0.5 表示与参考报告持平。FACT：以被引网页为参考、官方 validate 提示词判定 supported / unsupported / unknown；引用准确率 = supported / (supported + unsupported)，有效引用数 = supported 数 |
| BrowseComp-Plus | 固定语料，禁用外网搜索 | 答案：官方 `GRADER_TEMPLATE` 判定 correct = yes/no；Recall = 运行中检索到的文档 ∩ 证据文档（`qrel_evidence.txt`）/ 证据文档数 |
| manual | 仅 `disagreements_resolved = true` 的案例 | 评委对照双人核实的参考事实打分，结果经人工复核 |

### 10.3 与官方协议的差异

1. **评委模型**：所有 LLM 评分使用 GLM-5.3-Flash；研究模型为 MiniMax-M3（不同模型，不构成自评）。DeepResearch Bench 官方评委为 Gemini，BrowseComp-Plus 官方评委为 Qwen3-32B，因此**分数不可与官方排行榜直接比较**，只用于 2×2 条件对比。
2. **tilse ROUGE**：使用 tilse 自带的 Python 重实现（`rouge_computation="reimpl"`），而非官方默认的 Perl ROUGE-1.5.5（Windows 下依赖难以满足）。tilse 作者说明重实现与原版近似，数值可能有小幅偏差。
3. **RACE 文章清洗**：官方用 LLM 去掉文中引用；本实现确定性地删除 `[n]` 标记与参考来源小节。
4. **FACT 陈述抽取**：官方由 LLM 从正文抽取 (statement, URL) 对；本系统报告本身逐句挂引用，直接用结构化引用生成陈述-URL 对。参考网页取运行时实际读到的正文（官方用 Jina 重新抓取）。
5. **BrowseComp-Plus 检索器**：SQLite FTS5 BM25（porter 词干、k1=1.2、b=0.75，全文索引），官方基线为 Pyserini BM25（k1=0.9、b=0.4）。
6. **受控对比的检索快照**：Open-TLS 与 DeepResearch Bench 先在 `record` 划分（dev ∪ test）上用实时搜索录制文档池（full 条件 medium 预算 + base 条件 small 预算各一次），冻结为快照后，四个条件都在同一快照上检索。这既保证了条件之间检索资源一致，也控制了免费检索额度的消耗。
7. **基线条件的时间窗口**：base 条件不做任何时间规划，检索窗口为 [截止时间 − 10 年, 截止时间]，相当于只受截止时间约束，避免固定短窗口人为压低长时间线任务上的基线表现。
8. **快照录制模型**：快照文档池（`otls_pool`、`drb_pool`）由使用 DeepSeek V4.1 Flash（`ark-flash` 档）的系统录制，只作为检索资源，四个条件共用，不影响条件间对比；所有计分运行均使用 MiniMax-M3（关闭思考模式）。
9. **MiniMax-M3 的结构化输出适配**：该模型在 tool 模式下常漏调工具或在参数中混入 XML 标签、不支持 native json_schema，因此所有角色使用 prompted 模式；它还会忽略 schema 中的列表上限，故 (a) 校验前把超长列表截断为前 N 项，(b) 在规划、证据抽取和声明抽取提示词中写明数量上限（规划 ≤ 每轮动作上限、证据 ≤ 8 段、声明每条证据 ≤ 2 条且每批 ≤ 20 条），避免输出超过单次 4096 token 上限被截断。
10. **模型输出容错**：日期精度与可空参数规整、规划连续无效时退回默认检索动作、超时归为可重试错误；所有模型请求使用流式（部分网关约 60 秒断开非流式长连接，会导致长评分输出失败）。容错只影响输出解析，不改变研究策略与停止阈值，且只在 dev 集上验证。
11. **评委思考 token 不计入成本**：glm-5.3-flash 默认开启思考且无法关闭（传 `thinking: disabled` 返回 500）；网关返回的 `completion_tokens` 不含 `reasoning_tokens`，因此评分成本按正文 token 计算，会低估实际消耗。

上游入口为 [CHRONOS](https://github.com/Alibaba-NLP/CHRONOS)、[DeepResearch Bench](https://github.com/Ayanami0730/deep_research_bench)、[BrowseComp-Plus](https://github.com/texttron/BrowseComp-Plus)。官方提示词原文位于 `backend/src/newsagent/eval/official/`（附许可说明）。

`statistics.json` 保存任务层面波动和按任务配对的 bootstrap 结果，样本不足两条时置信区间为 `null`。`summary.json` 与前端契约保持逐字段一致。
