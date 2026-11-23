# AGENTS.md

面向在本仓库中工作的开发者与编码 Agent 的开发约定。项目概览与运行方式见 [README](README.md)。

## 阅读顺序

修改后端前依次阅读：

1. [docs/backend-spec.md](docs/backend-spec.md)：架构、模块、算法、配置
2. [docs/api-contract.md](docs/api-contract.md)：接口契约、SSE 语义、"快照 = 事件折叠"不变式
3. `frontend/src/api/types.ts`：所有数据结构的唯一事实来源
4. [docs/evaluation-spec.md](docs/evaluation-spec.md)：评测流水线与评分协议

`frontend/mock/`（尤其是 `plugin.ts` 的路由与 SSE 实现、`scenario.ts` 的事件顺序）是后端行为的可运行参考；契约文档未写明的细节以它为准。

## 契约

- 后端输出必须通过 `contracts/schema.json` 校验。Schema 中的对象均为 `additionalProperties: false`，多字段或少字段都会校验失败；可空字段输出 `null`，不得省略。
- 契约变更流程：先改 `frontend/src/api/types.ts` → 在 `frontend/` 下执行 `npm run contract:schema` 与 `npm run contract:fixtures` → 更新 `docs/api-contract.md` → 前后端各自适配。`contracts/` 下的文件不要手改。
- `contracts/fixtures/` 的用途：
  - `run_snapshot.json` + `run_events.json`：完整运行（3 轮研究、审查修复后通过），用于折叠测试与 `--fixture-mode` 回放
  - `run_partial_*`、`run_failed_*`、`run_clarification_events.json`：部分完成、失败、澄清三条分支
  - `run_request.json`、`run_list.json`、`config.json`、`health.json`、`experiments.json`、`experiment_detail.json`：各端点的响应示例

## 编码规则

- 代码注释、文档、日志说明文字使用**中文**；标识符与 prompt 模板使用英文。
- 所有 RunState 变化都必须经过 `EventBus.emit`，不允许绕过事件直接修改快照。
- 机制开关的判断集中在 `research/policy.py` 的 `MechanismPolicy`，不要在各模块中散落条件判断。
- 模型输出容错放在 `workflow/drafts.py` 的校验前规整里（日期、可空字段、列表上限），不要靠放宽契约模型解决。
- 预算由代码强制执行；停止阈值与 prompt 在 pilot 后冻结，不得在测试集上调参。
- 不确定的外部 API 细节（Tavily / Exa / PydanticAI / 各 benchmark 数据格式）以官方文档和实际数据为准；与设计文档冲突时，在文档中记录差异与处理方式。

## 密钥

- 密钥只从环境变量读取，不得出现在代码、日志、API 响应或提交中。`backend/.env` 已被 `.gitignore` 忽略。
- 使用 `backend/scripts/set-keys.ps1` 在本地终端写入密钥；自动化工具只检查变量"是否已设置"，不读取或打印明文。

## 提交前检查

```bash
cd backend && uv run ruff check && uv run pyright && uv run pytest
cd frontend && npm run build
```

改了后端代码需要重启 `newsagent serve` 才生效。

## 评测运行

- 同一时间只运行一个评测进程：研究模型与评委可能共用同一服务的限流额度。
- 不要对同一实验 ID 并行启动两个进程，否则会互相写入占位输出。
- 实验 manifest 记录代码提交与配置、提示词、评测代码的哈希；这些信息变化后同一实验 ID 会拒绝续跑，需要使用新的实验 ID。
