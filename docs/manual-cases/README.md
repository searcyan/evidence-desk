# 人工评测案例：标注指南

`cases.draft.jsonl` 是 16 个由 LLM 辅助起草的候选案例（`draft_by` 字段），覆盖四类评测情形。**草稿中的事实、日期和状态都必须由两名标注者独立核实**，核实前不计入任何评测结果。

| 类别 | 考察点 | 案例数 |
|---|---|---|
| `evolving_state` | 并购 / 监管事件在截止时间所处的阶段（宣布、审查、获批、交割、终止） | 6 |
| `post_cutoff_leakage` | 截止时间之后才发生的进展（"旧闻新发"的反面）：系统不得把截止后的信息当作当时状态 | 4 |
| `same_source` | 多家媒体转载同一份官方通告或通讯社稿件，独立来源数应按原始出处计 | 3 |
| `conflicting_claims` | 截止时间前报道相互矛盾或随后更正 | 3 |

## 标注流程

1. 两名标注者（A、B）**各自独立**核对每个案例：
   - `reference_facts` 中每条事实的 `text`、`event_date`、`stage`、`available_by`（截止时间前是否已公开）是否属实；
   - `reference_status_at_cutoff` 是否准确描述截止时间时的状态；
   - `provenance` 中标注的原始出处是否正确。
   每条至少附 1 个可访问的来源 URL，记入 `sources` 字段。
2. 各自在副本中修改，保存为 `cases.A.jsonl` 和 `cases.B.jsonl`。
3. 对照两份标注，逐项讨论分歧并达成一致，生成 `cases.jsonl`：
   - `annotators` 填写两人的代号，例如 `["A", "B"]`；
   - 把 `disagreements_resolved` 设为 `true`；
   - 在 `adjudication_notes` 中记录分歧及处理方式。
4. 运行 `uv run newsagent eval prepare --benchmark manual`，将 `cases.jsonl` 复制到 `data/benchmarks/manual/`；然后按 [评测设计](../evaluation-spec.md) 的命令运行实验。

评测加载器只读取 `disagreements_resolved: true` 的案例。保留 A、B 两份原始标注，用于报告标注一致率。
