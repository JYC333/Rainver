# 无人值守待决项复核（2026-10-10）

临时报告，不是权威文档。对照对象是
[2026-10-03 待决清单](2026-10-03-unattended-sweep-open-items.md)。
分类只描述当前代码做了什么，不代替产品决定。

本轮覆盖清单第 2.1–2.7 节和文末技术遗留。和快照不同的条目又对过当前文件。
其余条目的行号来自同一次阅读，决定前如果要改代码，先打开对应行。

## 和快照不同的

| 编号 | 现在的代码 |
|---|---|
| D4 能力提案 | Run 的 `proposed_changes` 只接受记忆、知识、主张、关系、后续任务和 code patch。`capability_*` 不在这组里，Run 产出不再生成能力提案。`server/src/modules/runs/materializationService.ts:53-67` |
| D55 | 启用会把指定版本写成 `available`。`proposed` 和 `testing` 能通过 `status <> 'archived'` 的检查，然后进入只加载 `available` 的运行时。快照里「这两态从未生效」已经不成立。`server/src/modules/capabilities/proposalApplier.ts:164-173`、`300-312` |
| D86 | 再次导入仍返回已有导入记录，但查看者不是导入者时 `imported_resource_id` 为 null。他人私有副本的 id 不再出现在响应里。`server/src/modules/publications/service.ts:257-258`、`436-446` |
| D23 | 停用的 Provider 留在「Owned by me」里，并显示 Disabled。这份列表只排除 `manageable === false`。`apps/web/src/modules/providers/ModelProvidersPage.tsx:41`、`321-325`，`ProviderCard.tsx:143` |
| D31 | 出口审批在提案空间和请求空间不一致时返回 404。`SECURITY_AND_ACCESS_BOUNDARIES.md` 8a 现在要求这次核对。同节开头仍写这些路由会忽略请求的 `space_id`。`proposals/applyService.ts:110`，文档 676–697 行 |
| D32 | 会话 cookie 的 `Secure` 只在 `FRONTEND_URL` 为 https 时设置，安全边界文档与此一致。`auth/authCookie.ts:14-16`，文档 1103–1106 行 |
| D42 | Codex 不读 `RAINVER_STRICT_SANDBOX`。守护进程把副本 `config.toml` 的 `sandbox_mode` 写成 `workspace-write`。延迟登记里已经没有这条未核对问题。`packages/host-daemon/src/codexStrictSandbox.ts:9-14` |
| D44 | OpenCode 登录仍只丢掉 `ANTHROPIC_`、`CLAUDE_`、`CODEX_`、`OPENAI_`、`OPENCODE_`、`GEMINI_`、`GOOGLE_` 这 7 个前缀。注释和 B67 现在描述的就是这套封闭前缀加白名单，不再写「所有厂商密钥」。`packages/host-daemon/src/providerBinding.ts:78-104`，`.agent/BOUNDARIES.md` B67 |

## 仍然成立，决定前值得先看

这些行号是 2026-10-10 读到的位置。

| 编号 | 当前行为 |
|---|---|
| D52 | `assertContainedPath` 先 `realpath`，`readFolderFile` 再按原路径 `readFile`。检查和读取不是同一次打开。`realpath` 失败时函数直接返回，不拒绝。`packages/folder-read/src/read.ts:48-55`、`320-338` |
| D28 / D36 | `policy_change` 只要求 `name` 和 `domain`，然后把任意 domain 插成 `status='active'`。`server/src` 里没有 `FROM policies` 或 `JOIN policies`。`server/src/modules/proposals/applierRegistry.ts:188-231` |
| D43 | 内容访问更新直接 `UPDATE` 目标表的 `visibility` 和 `access_level`，不生成记忆新版本。空间 owner 或 admin 可以改不是自己拥有的行；收紧时才要求所有者确认。agent 范围的记忆禁止放宽。`server/src/modules/contentAccess/service.ts:134-210`、`377-390` |
| D30 | `one_shot_docker` 的工作目录范围就是 `worktree`。`server/src/modules/runs/ephemeralSandbox.ts:23-28`。`RUNS_AND_OUTPUTS.md` 365–370 行仍写每个 Run 一个容器 |
| D1 | 空间 admin 可以更新任意 Automation，包括 `config_json` 里的 prompt。带项目的 `agent_run` 还允许项目写者更新。随后的运行仍记在 Automation 的 `owner_user_id` 名下。普通 member 改不了别人的个人 Automation。`policy/decisionCore.ts:501-519`，`automations/service.ts:281-287` |
| D2 | 晋升到 system 会改全局 `current_system_version_id`，同一次更新不清除版本行上的 `space_id`。`evolution/assetPromotionProposalApplier.ts:117-140` |
| D3 | 分组 Agent Run 的创建把 `trigger_origin` 写成 `manual`。已出席来源只有这一个值，无人值守写入门把它当成有人在场。`runs/repository.ts:592`，`policy/decisionCore.ts:347`。房间里的领域事件续跑从 `rooms/service.ts:1088` 进入 |
| D4 persona | Run 物化出的 `memory_update` 不写 `required_owner_user_id`。审批只在这个字段存在时才限定为 Agent 所有者。`runs/materializationService.ts:613-623`，`proposals/applyService.ts:1042-1054`。带 `project_id` 的提案里，项目所有者在审批时被当成 owner。`applyService.ts:1098-1107` |
| D85 | 能读共享 Activity 的人可以把它整理成记忆提案。提案由操作者创建，记忆的 `owner_user_id` 取 Activity 所有者，可见性是 private，风险级别写成 low。`activity/repository.ts:515-550`、`630-641`。带 `project_id` 的这条在应用时仍会因用户记忆不能带项目而失败，见 D21 |
| D88 | 生产环境的 `rebuild_rainver` 只拉镜像并 `up -d --no-deps`，没有维护门、备份或迁移。`deployer/scripts/rebuild.sh:31-45` |

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

## 2.3–2.7 与技术遗留：仍然成立

安全与运维：D6 私网 Git 地址可以通过（`projectFolders/repositoryUrl.ts:16-28`）。D38 能力晋升没有测试通过门（`docs/THREAT_MODEL.md:95`）。D39 没有按工作区的 `cleanup_after_days`。D40 没有 `CredentialAccessLog` 和 `ContentReadTrace`，现有表是 `content_access_logs`。D45 终态 Run 仍可上传 diff 和输出（`hosts/routes.ts:877-922`）。D48 重新认证 cookie 不绑定会话，登出不清除（`auth/reauth.ts:45`）。D58 `ollama` 一律算本地 Provider（`retrieval/egress/egressPolicy.ts:87`）。D61 调度器原始异常经 `/api/v1/status` 给到空间 owner 和 admin（`scheduler/registry.ts:290`）。D62 带 `statusCode` 的 5xx 把 `error.message` 当作 detail（`routeUtils/common.ts:89-102`）。D73 会话续期只改数据库，cookie 不重签（`auth/identity.ts:120-136`）。

文档与代码：D27 非所有者读取产物时，传入的 Project Folder 上下文被忽略（`artifacts/repository.ts:142-166`，`ARTIFACTS.md:35-40`）。D34 任务派发的 Run 带有 `retrieval.brief` 和 `retrieval.search`（`tasks/repository.ts:1088-1111`）。D35 没有 worker 时 `jobs_worker` 和 `jobs_queue` 都是 degraded，状态文档与此一致。D37 `check_private_memory_placement()` 仍只出现在 `docs/POLICY_AND_PRIVACY_BOUNDARIES.md:373-375`。

执行与数据：D8 审批后的节点 Run 记在审批人名下（`automations/workflowExecutionService.ts:230`）。D9 07:00 UTC 的摘要用这次触发的 UTC 日，日报用该档期的本地日历日。D12 执行图对账失败被吞掉，完成门仍提交（`runs/finalizationService.ts:277-285`）。D14 不能外发的 embedding 认领会占住队头（`retrieval/embedding/service.ts:95-96`）。D15 并发回填段可以一起超过 `max_items`（`sources/sourceBackfillExecutionService.ts:224-249`）。D16 超过 64KiB 的单行被截断（`sessions/conversationInputResourceService.ts:83-98`）。D17 CLI 租约过期时间是 2 小时（`runtimeContext/continuity/cliContinuity.ts:224-233`）。D20 标注重试耗尽后停在 failed，出口关闭时离开的条目不回队列。D26 提议状态的导入跳过 `unknown_account` 分录。D70 回合读模型包含上一次尝试的事件（`runs/turnReadModel.ts:160-172`）。D71 撤销跨项目分享可以删掉笔记在目标集合里的位置（`knowledge/spaceObjectProjectShares.ts:126-143`）。D72 全量维护扫描在截断后仍推进游标（`memory/maintenance.ts:73-74`）。D75 手工 drain 不与后台后处理互斥（`sources/postProcessing/service.ts:784`）。D76 重排预算按 2000 字，LLM 回退最多发 600 字。D78 `restore_workspace` 在发送事务内执行（`agents/routes.ts:1003-1028`）。D79 `kind=action` 的计划节点走普通 Agent Run（`plans/repository.ts:717-809`）。D80 evolution 的待处理计数只含 evolution 类提案，列表接口列出全部可见 pending。D81 研究重试沿用基础尝试的语义查询。D82 没有快照的历史日期会现场生成并消耗当天备用池。D87 协议把单计划 attempts 限在 200，服务端返回全部尝试（`packages/protocol/src/researchDiscovery.ts:132`）。D90 导入里的 open、close、commodity 立即生效。

协议字段：D64 `inquiry_thread` 仍被服务端和数据库拒绝。D65–D69 与契约报告相同：`conversation_backend_required` 没有抛出点，`Run.task_id` / `prompt_*`、`source_template_id`、记忆的 `approved_by` 和 `last_accessed_at`、`CurrentUser.default_space_id` 都不返回。D83 插件提案包装器固定返回 `result_type: knowledge_item`（`plugins/host/context.ts:203`）。

前端：D24 复制失败仍提示已复制。D25 注册表 Agent 的 Login 在安装未声明登录探测时返回 422。D51 TimePage 仍是开发中占位。D63 `information_digest` 和 `autonomous_tick` 显示为 agent run，后者保存项目绑定会 422。D89 隐藏最后一种可见边会让全部边重新出现（`GraphView.tsx:468-475`）。D91 新对话不发送页面上的逐 Agent 后端选择。D92 记忆页只有默认的前 50 条。D93 来源频道首次加载失败显示 “Source not found”。

技术遗留：overflow 之后对旧 binding 调用 `rotateMissingVendorState` 仍返回 409，续接仍用旧会话（`runtimeContext/continuity/cliContinuity.ts:186-193`）。多通道 workflow 的复数 id 修复点已不在 `sources/monitoringCoordinator.ts`，而在 `projectResearch/orchestrator.ts:743-748`；只存了单数 id 的旧数据在增量触发时仍会 409。`GitStatus` 没有 `truncated`。能力导入不拿预览时的 `package_hash` 比对。Usage 的单会话平均值把 summary 级 token 除以完整访问的会话数。`createTask` 不检查归档。`probe_domain_budget` 上限是 3。`memory.cross_space_read` 仍只出现在 `POLICY_ENFORCEMENT_INVENTORY.md`。
