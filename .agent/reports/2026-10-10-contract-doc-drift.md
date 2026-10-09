# Web 契约与架构文档差异（2026-10-10）

临时报告，不是权威文档。只记录两边都读过、并且会改变界面分支或把文档说成当前行为的差异。没有生成客户端，也没有改校验。

Web 的 HTTP 调用集中在 `apps/web/src/api/client.ts`。`request()` 把 JSON 响应按调用方给出的类型断言；常规响应不跑协议 schema。协议侧的 zod 定义在 `packages/protocol/src/`。这和复用清单里「还没有生成客户端」一致。

## 会改界面分支的字段

这些在本轮又对过服务端读模型。

| 界面在用的字段 | Web 类型 | 服务端实际返回 |
|---|---|---|
| `Run.task_id`、`prompt_asset_key`、`prompt_version_id`、`prompt_content_hash` | `apps/web/src/types/api.ts` 约 1999–2019 行。详情和列表用它们链到任务或 prompt | `runToOut` 不写这些字段。`runs` 表也没有这四列。`server/src/modules/runs/runReadModel.ts:32-87`，`server/src/db/schema/runs.ts` |
| `Run.prompt`、`Run.instruction` | 类型允许字符串。列表和详情在有值时显示正文 | `runToOut` 固定写 `null`。表上有这两列，读模型不把正文放出来。`runReadModel.ts:58-62` |
| `Agent.source_template_id`、`source_template_version_id` | `api.ts` 约 2819 行。详情据此显示「来自模板」或「直接创建」 | `agents` 表和 `agentOut` 都没有这两列。`server/src` 搜不到 `source_template_id` |
| `Memory.approved_by`、`last_accessed_at` | `api.ts` 约 1386 行。详情页渲染 | 列在表上。`serializeMemoryRow` 的返回对象不含它们。`memory/repository.ts:484-498`。`MemoryOutSchema` 同样没有 |
| `CurrentUser.default_space_id` | `api.ts` 约 422 行。`SpaceContext` 把它当作首选 Space 的回退 | `CurrentUser` 没有该字段，`GET /api/v1/me` 原样返回。`auth/identity.ts:14`，`auth/routes.ts:272-276` |
| `conversation_backend_required` | 发送失败时读取 `error.code` 和 `setup_targets` | 协议定义了这个错误体（`packages/protocol/src/rooms.ts:453-457`）。服务端只在捕获时比较这个 code，没有构造它的地方 |

## 同名形状不一样

- `Memory.sensitivity_level`：协议必填，Web 类型可选。服务端序列化总会写出。
- `Session.user_id`、`Message.user_id`：协议可空，Web 类型是必填字符串。
- `KnowledgeItem.content`：Web 类型是字符串；summary 读取时服务端写 `null`。

## 协议或服务端有、Web 的 `Run` / `Session` / `Message` / `Proposal` 没声明

读模型会返回、当前这些页面不读的字段：`Run` 的 `root_run_id`、`run_group_id`、`delegation_id`；`Session.room_id`；`Message.sender_agent_id`、`discussion_id`；提案的 `provenance_entries`、`source_activity_id`、`project_id`。房间对话走协议里的 `RoomMessage`，那份类型含有消息上的这两项。

`apps/web/src/types/api.ts` 里手写接口大约 296 个。按名字对上协议 schema 后，至少 26 个是协议已有定义、Web 又声明了一遍。这是下限，对不上名字的没算。代表对包括 `Memory`、`Run`、`Proposal`、`Artifact`、`KnowledgeItem`、`Session`、`Message`、`NetworkProfileOut`、`ProjectSourceBinding`、`CustomSourceHandlerVersion`、`SourceHealth`、`ProjectOverview`。同文件里从 `@rainver/protocol` 再导出的类型是转发，不是第二份声明。

## 文档句子和代码不一致

**`agent.config_update`。** 代码是所有者直接追加版本：`PATCH /api/v1/agents/:agentId` 与 `POST /api/v1/agents/:agentId/config`（`agents/routes.ts:398-431`）。`server/src/modules/agents/` 里没有 `agent.config_update`，也没有 `agents/service.ts`。

同一仓库里的文档互相矛盾，代码站在直接写入这一边：

- `.agent/architecture/PROPOSALS.md` 149–152 行写没有 `agent_config_update` 提案路由，与代码一致。160–161 行又写执行配置提案使用 `agent.config_update`。
- `.agent/modules/agents.md` 497–509 行写两条路径都是所有者直接改。677–678 行的不变量仍写「发布后的执行配置变更只能走提案」。
- `.agent/modules/policy.md` 122 行和 `.agent/architecture/POLICY_ENFORCEMENT_INVENTORY.md` 312 行把执行点写成提案创建前的 `enforce()`。
- `packages/protocol/src/policy.ts:258-268` 仍把该动作标成 `wired_direct`，描述是创建提案。

**持久化策略。** `POLICY_ENFORCEMENT_INVENTORY.md` 的 Policy Effect Contract 把 `memory.private_placement`、`run.user_private_scope` 写成可以通过 `policy_change` 生效的 domain，并把 `memory.cross_space_read` 写成会读策略行。`applyPolicyChangeProposal` 不限制 domain（`proposals/applierRegistry.ts:188-231`）。这三个名字在 `server/` 里都没有。跨空间记忆拒绝是 `decisionCore.ts` 里的硬不变量，不读 `policies` 表。

**私有记忆只能放在个人 Space。** `docs/POLICY_AND_PRIVACY_BOUNDARIES.md` 371–375 行写由 `check_private_memory_placement()` 拒绝。仓库里没有这个函数。`docs/SPACE_MODEL.md` 写任何 Space 都可以有私有内容，与当前写入路径一致：private 要求 `owner_user_id`，不要求个人 Space（`memory/memoryApplyRepository.ts:1152-1154`）。

**`one_shot_docker`。** `.agent/architecture/RUNS_AND_OUTPUTS.md` 365–370 行写它是独立容器：默认断网、只读根、丢掉 capabilities、失败不降级成 worktree。`workingDirScopeForLevel` 把该级别映射为 `worktree`（`runs/ephemeralSandbox.ts:28`）。

**任务派发拿到检索动作。** `SYSTEM_ACTIONS.md` 写观众范围解决前不得把检索动作放进场景许可。`DISPATCH_BASE_TOOL_ALLOWANCE` 含 `retrieval.brief` 和 `retrieval.search`，任务派发写入这份名单（`systemActions/scenarioToolAllowance.ts:136-148`，`tasks/repository.ts:1092`）。房间名单 `ROOM_PROJECT_TOOL_ALLOWANCE` 仍然没有检索项。

**完成门。** `EXECUTION_MODEL.md` 写完成门要等 reconcile 提交。`finalizationService` 先写 `run_finalized`，reconcile 失败被吞掉，然后仍标记完成门已提交（`runs/finalizationService.ts:236-285`）。

**技能导入默认关闭。** ADR 0009 第 2 节写导入默认关闭。`POST /api/v1/skill-sources/import` 直接导入（`capabilities/routes.ts:193-198`）。转换成能力时仍然只产生停用草稿。

## 抽查后与代码一致的文档

- `SECURITY_AND_ACCESS_BOUNDARIES.md` 8a 表格：提案空间和请求空间不一致时 404。`applyService.ts:110`
- 会话 cookie 的 `Secure` 只在 `FRONTEND_URL` 为 https 时设置。`auth/authCookie.ts:14-16`。当前 `auth.md` 没有「始终 Secure」这句
- `ARTIFACTS.md` 里抽到的列表、summary 导出和 reader 文档格式，与 `artifacts/routes.ts`、`artifacts/repository.ts` 一致
- `PROPOSALS.md` 149–152 行、`agents.md` 497–517 行：配置变更直接追加版本
