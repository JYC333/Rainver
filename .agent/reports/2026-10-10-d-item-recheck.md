# 无人值守待决项复核（2026-10-10）

临时报告，不是权威文档。对照对象是
[2026-10-03 待决清单](2026-10-03-unattended-sweep-open-items.md)。
分类只描述当前代码做了什么，不代替产品决定。

本轮覆盖清单第 2.1、2.2 节，以及优先项里的 D28/D36、D30、D43、D52。
第 2.3–2.7 节和文末技术遗留还没逐条重读，不要把下面的表当成全量结论。

## 和快照不同的

| 编号 | 现在的代码 |
|---|---|
| D55 | 启用会把指定版本写成 `available`。`proposed` 和 `testing` 能通过 `status <> 'archived'` 的检查，然后进入只加载 `available` 的运行时。快照里「这两态从未生效」已经不成立。`server/src/modules/capabilities/proposalApplier.ts:164-173`、`300-312` |
| D86 | 再次导入仍返回已有导入记录，但查看者不是导入者时 `imported_resource_id` 为 null。他人私有副本的 id 不再出现在响应里。`server/src/modules/publications/service.ts:257-258`、`436-446` |

## 仍然成立，决定前值得先看

这些行号是 2026-10-10 读到的位置。

| 编号 | 当前行为 |
|---|---|
| D52 | `assertContainedPath` 先 `realpath`，`readFolderFile` 再按原路径 `readFile`。检查和读取不是同一次打开。`packages/folder-read/src/read.ts:48-55`、`320-338` |
| D28 / D36 | `policy_change` 只要求 `name` 和 `domain`，然后把任意 domain 插成 `status='active'`。`server/src` 里没有 `FROM policies` 或 `JOIN policies`。`server/src/modules/proposals/applierRegistry.ts:188-231` |
| D43 | 内容访问更新直接 `UPDATE` 目标表的 `visibility` 和 `access_level`，不生成记忆新版本。空间 owner 或 admin 可以改不是自己拥有的行；收紧时才要求所有者确认。agent 范围的记忆禁止放宽。`server/src/modules/contentAccess/service.ts:134-210`、`377-390` |
| D30 | `one_shot_docker` 的工作目录范围就是 `worktree`。`server/src/modules/runs/ephemeralSandbox.ts:23-28` |

## 2.1 权限与可见性：仍然成立

- **D5** 兴趣画像按已读的已标注条目计数，不排除同时出现在意外发现里的同一条目。`interestProfile/repository.ts:213-228`、`293-317`
- **D7** 每日简报 Activity 以 `space_shared` 写入摘要预览，不另查摘要本身是否可读。`sources/postProcessing/repository.ts:1299-1343`
- **D10** 没有 `project_id` 的自动化对空间成员可读；额外收紧只作用于 `autonomous_tick`。`automations/repository.ts:116-131`
- **D22** 个人条目的 canonical URI 在空间内唯一；当前用户读不到已有行时保存返回 409。`db/schema/sources.ts:129`，`sources/repository.ts:337-342`
- **D46** `PATCH /agents/default-assistant/settings` 写空间级设置，不查角色，也不校验 `default_project_id`。`agents/routes.ts:372-384`
- **D47** space 范围的 Skill 本地覆盖不做角色检查；project、folder、agent 只确认该 id 属于本空间。`capabilities/repository.ts:623-649`
- **D50** `proposal.decide` 对会话内对不上的 id 返回 404，文案列出该会话全部 pending 提案的 id 和标题，查询没有读取权限过滤。`proposals/proposalDecisionExecutor.ts:34-46`、`72-78`
- **D53** Home 的 `open_items` 按整个空间计数。`frontendSupport/service.ts:602-612`
- **D59** 兴趣画像事实层有内容可见性，没有连接同意或订阅门。`interestProfile/repository.ts:272-317`
- **D60** 默认检索对象类型来自已注册适配器，包含 `knowledge_item`。`runtimeContext/productionAcquisition.ts:86-93`
- **D74** 空间 owner 或 admin 可以在自己不是成员的项目里创建内容；项目读取只承认项目所有者或项目成员。`access/creationContext.ts:54-84`
- **D77** 每个项目一行公开摘要；未带状态的保存按 draft 覆盖该行。`projects/repository.ts:424-496`

## 2.2 门禁与资产生命周期：仍然成立

- **D11** 每回合 5 条上限不计 `follow_up_task`。`projectWork/projectWorkSystemActionExecutors.ts:36-57`，`runs/materializationService.ts:388-402`
- **D13** 维护产生的 `memory_update` 子提案在接受时缺少可用来源信任；`requires_operator_edit` 没有提案编辑路由。`memory/maintenanceArtifacts.ts:147-179`
- **D18** `deprecate_previous` 废弃同范围的其他 approved 版本，不跳过仍被 pin 的版本。`evolution/assetPromotionProposalApplier.ts:125-132`
- **D19** `testing` 可以回到 `draft`，原评估仍挂在该版本上。`evolution/assetRepository.ts:414-440`
- **D21** 项目内 Activity 整理出的记忆提案带用户范围和 `project_id`，应用时被拒绝。`activity/repository.ts:515-549`，`memory/memoryApplyRepository.ts:1300-1301`
- **D29** `PATCH /agents/:id` 和 `POST /agents/:id/config` 由所有者直接追加 `AgentVersion`。`agents/routes.ts:398-431`。`agents/` 内没有 `agent.config_update` 调用
- **D49** `task.plan.propose` 注册为 durable，`gate_class` 为空。`packages/protocol/src/systemActions.ts:480`、`553-568`
- **D54** `capability_update` 可以改导入技能版本里的 `normalized_skill` 和 `capability_definition`，不改 `content_hash`。`capabilities/proposalApplier.ts:96-131`
- **D56** 技能导入路由没有实例开关。`capabilities/routes.ts:193-200`。ADR 0009 仍写导入默认关闭
- **D84** 不带 `version_id` 的回滚在最近两个版本之间切换。`prompts/repository.ts:341-390`
- **D94** Review 和 Convert 每次都新建提案，服务端不合并已有 pending。`apps/web/src/modules/capabilities/CapabilitiesPage.tsx:124-139`

## 本轮没有逐条重读

D1–D4、D6、D8、D9、D12、D14–D17、D20、D23–D27、D31–D35、D37–D42、D44、D45、D48、D51、D58、D61–D73、D75–D83、D87–D93，以及清单第 4 节的技术遗留。快照里的描述在重读之前仍然只是 2026-10-03 的记录。
