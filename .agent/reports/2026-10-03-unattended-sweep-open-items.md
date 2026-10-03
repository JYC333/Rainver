# 无人值守审计与修复：待决定与未完成事项

临时报告，不是权威文档（见 `.agent/INDEX.md` §7）。工作经过见同目录的
`2026-10-03-unattended-sweep-summary.md`。

本文是 2026-09-28 至 2026-10-03 那轮审计与修复留下的未完事项。代码位置以
2026-10-03 `dev` 分支为准。编号 D1–D94 沿用工作过程中的编号；D33 和 D41 已经修复，所以不列出。

文档里写的规则凡是代码没做到的，都**保留了规则原文**，记在本文里，等你决定是改代码还是改规则。

## 1. 建议优先看的

| 编号 | 一句话 |
|---|---|
| D52 | 读取 Folder 文件时，realpath 检查和实际读取之间有时间窗口，可能被利用读到服务器环境变量 |
| D28 / D36 | `policy_change` 提案可以写入任意 domain，而 `policies` 表没有任何代码读取，审批通过的策略不起作用 |
| D43 | 内容访问 API 可以原地修改记忆的可见性，绕过了 ADR 0003 的提案流程 |
| D85 | 非所有者可以把共享 Activity 整合进所有者的私有记忆，并且自己批准 |
| D1 | 非所有者可以改写他人 Automation 的 prompt，之后的运行仍然记在所有者名下 |
| D3 | Room 的后续回合以 `manual` 运行，绕过了无人值守写入门 |
| D4 | Run 产出的能力提案和 persona 提案，审批人要求可以被绕过 |
| D88 | 生产环境的 `rebuild_rainver` 不经过维护门、备份和迁移 |
| D30 | `one_shot_docker` 隔离级别承诺了每个 Run 一个容器，实际只是 worktree |
| D2 | 带 `space_id` 的 system 作用域资产，到底是本 Space 的默认值，还是实例级内置 |

## 2. 待决定

### 2.1 权限、可见性与数据隔离

**D1 非所有者修改 Automation**（`server/src/modules/automations/service.ts:207`）
非所有者可以改写他人 Automation 的 prompt，之后的运行仍然以所有者身份执行。
选项：禁止非所有者修改；或者允许修改，但把责任转给修改者，并撤销所有者的凭证授权。

**D4 Run 产出的能力提案与 persona 提案的审批人**（`server/src/modules/capabilities/proposalApplier.ts:96`、`server/src/modules/proposals/applyService.ts:1034`）
- 能力提案：Run 产出的 `capability_*` 提案绕过了 owner 审批要求，而且 Project owner 可以批准 Space 级的能力变更。
- persona 提案："只有 Agent owner 能决定 persona 或 agent 作用域"这一点依赖 payload 里的字段，Run 输出生成的 `memory_update` 可以绕过它。

需要定的是：这两类提案分别由谁审批。

**D5 意外发现条目的阅读是否计入兴趣画像**（`server/src/modules/interestProfile/repository.ts:206`）
B54 和"兴趣画像不得读取意外发现信号"这两条规则互相冲突，需要取舍。

**D7 每日 briefing 的 Activity 预览**（`server/src/modules/sources/postProcessing/`）
Space 内所有成员都能看到每日 briefing 的 Activity 记录，而它可能引用私有 digest 的预览文本。现有测试把这当作有意的设计；当时的修复因此回退了这一部分。

**D10 Space 级 Automation 的可见性**（`server/src/modules/automations/routes.ts:20`）
既不属于任何 Project、也不是 tick 的 Automation，比如成员个人的 information_digest 计划，目前全员可见。
选项：保持全员可见；非管理员只能看自己的和自己能读的 Project 的；只隐藏个人 digest 计划。

**D22 URL 已被一个自己读不到的条目占用**（`server/src/db/schema/sources.ts:129`）
目前保存时返回 409。另一种做法是给这位成员一份自己的副本或访问权限，但这需要按所有者建唯一索引，要做迁移。

**D43 内容访问 API 原地修改记忆可见性**（`server/src/modules/contentAccess/service.ts:196`）
这个 API 直接修改 `memory_entries.visibility/access_level`：
- 不生成新版本，也不留溯源记录；
- admin 可以放宽他人记忆的可见范围；
- 个人范围的记忆可以被改成 `space_shared`，而 applier 本身会拒绝这种写入。

选项：(a) 在 B10 和 ADR 0003 里把它列为命名例外；(b) 改为走提案并生成新版本；(c) 保留 API，但加放置校验，并且只允许所有者放宽。

**D46 默认助手设置**（`server/src/modules/agents/routes.ts:371`）
`PATCH /agents/default-assistant/settings` 写的是 Space 级设置，但没有角色检查，也不校验 `default_project_id`。
选项：要求 owner 或 admin；改为按用户设置；校验 Project 可读。

**D47（含 D57）Skill 本地覆盖层**（`server/src/modules/capabilities/repository.ts:626`）
- space 范围：没有角色门槛。
- project、folder、agent 范围：只检查对象存在。因此任何成员都能探测 id，也能写别人的私有 Agent。

选项：space 范围要求 owner 或 admin，project 范围要求可写，agent 范围要求可改；或者声明 space 范围就是有意开放的。

**D50 Agent 工具里的待处理提案列表**（`server/src/modules/proposals/proposalDecisionExecutor.ts:34`）
`proposal.list_pending` 和 `proposal.decide` 返回的 404 文本，会列出会话内所有待处理提案，不按指示人的读权限过滤。
选项：套用 `proposalReadSql`；或者只排除仅限所有者的提案。

**D53 Home 的 open_items 计数**（`server/src/modules/frontendSupport/service.ts:599`）
这是全 Space 的计数，会受到任意成员 `library_status` 的影响。
选项：按查看者自己的状态计数；套用摘要的"至少 3 名成员"匿名门槛；或者在 B56 下记为已接受的例外。

**D59 兴趣画像事实层**（`server/src/modules/interestProfile/repository.ts:286`）
已经加了内容可见性门，但还没加连接同意或订阅门。可选：计数时也要求当前仍在订阅。

**D60 Runtime Context 的默认检索带入 knowledge_item**（`server/src/modules/runtimeContext/productionAcquisition.ts:88`）
这和 B24 的文字冲突。
选项：除非策略或 Setup 开启，否则排除知识域；或者修改 B24，豁免受治理的相关性检索。

**D74 写权限比读权限宽**（`server/src/modules/access/creationContext.ts:68`）
Space owner 或 admin 可以在自己不是成员的 Project 里创建内容，但读权限随后会把这些内容隐藏起来。
这是有意的吗？选项：创建时要求 Project 可读；或者给 Project 读权限加一个 Space 管理员分支。

**D77 公开摘要草稿覆盖已批准的版本**（`server/src/modules/projects/repository.ts:459`）
Project 写者保存草稿时会覆盖唯一的已批准摘要，使它下线。而按规定，撤销发布需要 owner 级权限。
选项：(a) 已批准状态下写入任何状态都要求 owner 级；(b) 草稿和已发布文本分开存储；(c) 写者的草稿只更新草稿字段。

**D85 非所有者整合共享 Activity**（`server/src/modules/activity/repository.ts:512`）
能读共享 Activity 的非所有者，可以把它整合进所有者的私有用户记忆，并且自己批准。
选项：(a) 变更路径要求 `owner_user_id` 是本人；(b) 把提案的所有者或主体改成操作者；(c) 保持现状。

**D86 重复导入同一发布**（`server/src/modules/publications/service.ts:257`）
会以 201 返回另一个成员的私有副本 id。
选项：返回 409"已被他人导入"；对非导入者返回 null；改为按用户导入。

### 2.2 授权门、审批与资产生命周期

**D2 system 作用域资产**（`server/src/modules/evolution/assetPromotionProposalApplier.ts:125`、`server/src/modules/prompts/repository.ts`）
带 `space_id` 的 system 版本，到底是本 Space 的默认值，还是实例级内置？下面几个问题都取决于这个答案：
- Space 的 owner 或 admin 可以通过晋升改写实例级共享资产；
- 把某个 Space 的 system 版本部署到 system 作用域会写出全局 ref；
- 启动时同步内置 prompt，会悄悄撤销管理员在 system 作用域做的回滚或晋升。

**D3 Room 后续回合的触发来源**（`server/src/modules/runs/repository.ts:578`）
研究完成、委派结果、讨论 wave 这些后续回合以 `trigger_origin='manual'` 运行，因此绕过了无人值守写入门。需要定的是：它们算不算 manual。

**D11 follow_up_task 是否受"每回合 5 个"的上限约束**（`server/src/modules/projectWork/projectWorkSystemActionExecutors.ts:69`）
目前 followUpTaskReconciler 不限数量。
选项：在 ADR 0017 和 B70 里写明豁免；或者同样设上限，超出的留作待处理卡片。

**D13 Memory 维护包生成的 memory_update 子提案永远无法接受**（`server/src/modules/memory/maintenanceArtifacts.ts:173`）
需要补一条已注册的 provenance，问题是带什么信任级别：
- (a) `internal_system`：会把 user_confirmed 的记忆降级；
- (b) 接受时追加接受人的 user_confirmation；
- (c) 沿用旧记忆的信任级别。

另外，`requires_operator_edit` 子提案没有编辑入口。

**D18 资产晋升 deprecate_previous 会废弃仍被 pin 引用的版本**（`server/src/modules/evolution/assetPromotionProposalApplier.ts:125`）
废弃之后，解析这些 pin 立即返回 422。
选项：跳过被 pin 引用的版本；归档这些 pin；把 pin 指向新版本；拒绝这次晋升。

**D19 已评估的版本可以退回 draft 改内容**（`server/src/modules/evolution/assetRepository.ts:427`）
改完后还能用旧的评估和旧的提案晋升。
选项：禁止从 candidate 或 testing 退回 draft，改为建子版本；在评估和晋升 payload 里记录内容哈希，应用时校验；退回 draft 时作废该版本的评估和待处理晋升。

**D21 Project 内 Activity 整理出的 memory 提案永远无法应用**（`server/src/modules/activity/repository.ts:535`）
选项：(a) 改为 Project 作用域的共享记忆；(b) 让 applier 把 user 作用域提案上的 `project_id` 只当作受众限制，这需要改规范 applier；(c) 去掉 `project_id`，但会扩大可见范围，没有采用。

**D29 Agent 配置修改不经审批**（`server/src/modules/agents/routes.ts:397-431`）
PROPOSALS.md、policy.md 和 agents.md 都写着：修改要经过 `agent.config_update` 策略门，发布后只能走提案。
但实际上，`PATCH /agents/:id` 和 `POST /agents/:id/config` 都由 owner 直接写 AgentVersion，没有任何门槛。

**D49 `task.plan.propose` 的门类别**（`packages/protocol/src/systemActions.ts:475`）
它注册为 durable，且没有 gate_class；而 ADR 0017 把 plan_review 称为方向门。
选项：在注册表里表达"条件性提案"这类动作；或者修改 ADR 0017 和 SYSTEM_ACTIONS，说明条件性提案不算注册表里的提案动作。

**D54 capability_update 可以覆盖导入的 Skill**（`server/src/modules/capabilities/proposalApplier.ts:115`）
它能覆盖导入 Skill 版本的 `normalized_skill` 和 `capability_definition`，而 `content_hash` 和包快照不变。
选项：对 imported_skill 拒绝这些键；渲染时对照包快照校验；或者等暂停中的 capability-shrink 计划。

**D55 capability_enable 不看版本状态**（`server/src/modules/capabilities/proposalApplier.ts:164`）
`proposed` 和 `testing` 状态从未生效。
选项：在 applier 里加状态迁移表；或者把 B20 改写为代码实际的"draft → 审批 → 启用"。

**D56 Skill 导入没有开关**（`server/src/modules/capabilities/routes.ts:174`）
ADR 0009 写的是"导入默认关闭"，但导入路由没有开关。
选项：加一个默认关闭的实例开关；或者把 ADR 0009 改为"导入的 Skill 默认未审核且停用"。

**D84 不带 version_id 的回滚会来回摆动**（`server/src/modules/prompts/repository.ts:370`）
它会在最近的两个版本之间来回切换。
选项：加一个"回滚自"标记列（要迁移），沿链回溯；当前引用本身就是回滚时，要求提供 version_id；接受这种摆动。

**D94 Capabilities 的 Review/Convert 会重复建提案**（`apps/web/src/modules/capabilities/CapabilitiesPage.tsx:128`，服务端不查重）
选项：返回已有的待处理提案（幂等）；返回 409；在上面任一做法之外，前端在提案待处理时禁用按钮（需要新文案）。

### 2.3 安全与运维

**D6 `repo_url` 是否禁止私网地址**（`server/src/modules/projectFolders/repositoryUrl.ts`）
要考虑局域网里的 Git 服务器。

**D30 one_shot_docker 隔离级别**（`server/src/modules/runs/orchestrationService.ts`、`ephemeralSandbox.ts:28`）
RUNS_AND_OUTPUTS.md 承诺每个 Run 一个容器：默认断网、只读根目录、去掉 capabilities、有资源限制、不降级。
但代码只把这个级别映射为 worktree。

**D31 出网授权审批**（`server/src/modules/proposals/routes.ts:132-146`）
SECURITY_AND_ACCESS_BOUNDARIES §8a 说，审批路由不得校验 `proposal.space_id` 与请求的 Space 一致。
但代码会校验，不一致时返回 404，这可能挡住从个人 Space 发起的审批。

**D32 会话 Cookie 的 Secure 属性**（`server/src/modules/auth/authCookie.ts:15`）
文档说总是设置 Secure，代码只在 `FRONTEND_URL` 是 https 时才设置。

**D38 Capability 晋升的测试门**（威胁模型 Threat 4）
要求晋升前必须通过测试，但代码里既没有测试表，也没有这道门。

**D39 日志保留**（威胁模型 Threat 11）
按工作区配置 `cleanup_after_days` 的控制不存在。

**D40 审计表**（威胁模型 Threat 10）
作为审计证据列出的 CredentialAccessLog、ContentReadTrace 两张表都不存在。

**D44 OpenCode 主机登录时的环境变量清洗**（`packages/host-daemon/src/providerBinding.ts:81`）
只覆盖 7 个前缀，而注释和 B67 写的是"所有厂商密钥"。
选项：扩充到 `*_API_KEY` 和已知厂商的前缀；保持封闭集合，改写说明；记入 deferred register。

**D45 Run 结束后主机仍可上传**（`server/src/modules/hosts/routes.ts:877`）
主机在 Run 结束后仍然可以上传 diff 和输出。
选项：上传时要求 Run 尚未终止；再绑定当前的 launch_id；把它视为可信主机模型内的行为，接受。

**D48 重新认证授权是无状态的签名 Cookie**（`server/src/modules/auth/reauth.ts:45`）
服务端不消费它，它不绑定会话，登出时也不清除。
选项：绑定会话，并记录已用过的 nonce；登出时清除；或者接受现状，改写 auth.md。

**D52 Folder 文件读取的 TOCTOU**（`packages/folder-read/src/read.ts:46`）
realpath 检查和实际读取之间有时间窗口。验证者认为严重度应为 medium：Project 写者可以借内置主机，经由符号链接读到 `/proc/self/environ`。
修复者认为可靠的修法很难跨平台实现，所以没有修。
需要先定校验机制：像 openat 那样逐级打开，或者用文件描述符复核。

**D58 ollama 一律算作本地 Provider**（`server/src/modules/retrieval/egress/egressPolicy.ts:86`）
`provider_type=ollama` 一律归为 local_provider，不看 base_url。
选项：按 URL 判断，这会收紧 Docker 或托管 Ollama 的出网；或者在 SOURCE_CONNECTOR_CONSENT 里记录这个按类型的例外。

**D61 调度器的原始异常文本**（`server/src/modules/scheduler/registry.ts:288`）
它会通过 `/api/v1/status` 和实例告警暴露给所有 Space owner。
选项：`last_error` 仅限实例管理员可见；把失败归一为稳定的错误码；或者两者都做。

**D62 5xx 返回 error.message**（`server/src/modules/routeUtils/common.ts:79`）
`sendRouteError` 对 5xx 把 `error.message` 作为 detail 返回，违反 errorEnvelope 约定。
选项：500 及以上一律用固定 detail，但会丢掉有用的 502 Provider 信息；或者修改约定，逐条审查 5xx 文本。

**D73 会话滑动续期**（`server/src/modules/auth/identity.ts:123`）
续期只发生在数据库里，Cookie 从不重新签发。需要在固定会话和滑动会话之间二选一：
- 转发 getSession 的 Set-Cookie；
- 或者关闭续期，让数据库的过期时间和 Cookie 一致，同时尊重"不记住我"。

**D88 生产环境的 rebuild_rainver**（`deployer/scripts/rebuild.sh:33`）
它拉新镜像并重建 server 和 frontend，不经过维护门、备份、迁移和排空。
选项：(a) 生产环境拒绝执行，引导到实例更新或 `start.sh --prod`；(b) 复用 `update.sh` 的各个阶段；(c) 保留为"只换镜像"的逃生口，并在 deployment.md 里写明。

### 2.4 文档规则与代码不一致（规则原文已保留）

**D27 Project Folder 产物的读取上下文**（ARTIFACTS.md:35；`server/src/modules/artifacts/repository.ts:114`）
文档说非 owner 读取或导出时，必须提供匹配的 Project Folder 上下文；代码忽略这个上下文，但仍会按产物自身的 `project_folder_id` 做访问检查。很可能只是文档过时了。

**D28 / D36 持久化的策略不生效**（`server/src/modules/proposals/applierRegistry.ts:188`）
- `policy_change` 提案只要求 name 和 domain，任何 domain 都会被写入为生效策略；
- `PolicyEffectCatalog` 不存在；
- server/src 里没有任何代码读取 `policies` 表；
- 因此 TWO_PERSON_DOGFOODING_RC 的停止条件 4 恒成立。

相关文档：POLICY_ENFORCEMENT_INVENTORY.md 的 "Policy Effect Contract"，以及 docs/POLICY_AND_PRIVACY_BOUNDARIES.md。

**D34 Task 派发的 Run 被授予检索动作**
Task 派发的 Run 拿到了 `retrieval.brief` 和 `retrieval.search`。这和 SYSTEM_ACTIONS.md 的规则"查看者范围问题解决前，不得给场景授予检索动作"冲突。

**D35 无 worker 时的服务状态**
无 worker 时，`jobs_worker` 和 `jobs_queue` 报 degraded。文档已经按代码改了；如果想要 error 状态，需要改代码。

**D37 私有记忆的放置**
文档说 `visibility=private` 只允许放在个人 Space，由 `check_private_memory_placement()` 保证，但这个函数不存在。而 docs/SPACE_MODEL.md 说任何 Space 都可以有私有内容。需要定的是：缺了守卫，还是规则已经废止？

**D42 codex-acp 的沙箱设置转发**
deferred-register 里已经关闭的 Codex sandbox 行被删除了，其中还有一项核对没做："codex-acp 是否转发 config.toml 的沙箱设置"。如果要保留为待办，需要重新加一行。

### 2.5 执行、调度与数据正确性

**D8 Workflow 审批检查点之后的节点 Run 记在谁名下**（`server/src/modules/automations/workflowExecutionService.ts:227`）
目前记在审批人名下。

**D9 每日 digest 和每日捕获报告代表哪一天**（`server/src/modules/informationDigest/automationTarget.ts:279`、`server/src/modules/dailyReports/scheduler.ts:52`）
07:00 UTC 生成当天快照，所以当天 07:00 之后的条目永远进不了任何 digest。
选项：改为汇总前一个完整的 UTC 日；或者改为汇总触发前的 24 小时。

**D12 Run 结算时执行图的 reconcile 失败**（`server/src/modules/runs/finalizationReconcilerRegistry.ts:284`）
EXECUTION_MODEL.md 说完成闸门要等 reconcile 提交；finalizationService 却把它当作尽力而为，失败后 Task 永远不结算。
选项：(a) 任何 reconciler 失败都阻止闸门，并重试整个 agent_run；(b) 只让 registry reconciler 阻止闸门，再由定期扫描捡起没过闸门的结算；(c) 每个 reconciler 单独的重试标记。

**D14 embedding 认领队列头部被占住**（`server/src/modules/retrieval/embedding/service.ts:95`）
不允许外发的 chunk 一直占着认领队列的头部。Source 默认是 internal_only，所以这种情况很常见。
选项：标记为策略跳过，同意或目的地变化时再重置（要改 schema）；在认领 SQL 里按 Source 的 egress 策略过滤；单个任务内循环多批，直到找到可用的 chunk。

**D15 多个 segment 并发回填会超出 max_items**（`server/src/modules/sources/sourceBackfillExecutionService.ts:211`）
共享预算如何分配，文档没有规定。
选项：每个 plan 同时只跑一个 segment；为运行中的 segment 预留全部剩余额度；每次续页都重新检查预算。

**D16 输入资源里超过 64KB 的单行读不完整**（`server/src/modules/sessions/conversationInputResourceService.ts:83`）
选项：给 `input_resource.read` 加列或字节偏移（改协议）；附加时拒绝这类资源；把长行折成虚拟行（行号会与文件不一致）。

**D17 残留的 CLI 执行租约**（`server/src/modules/runtimeContext/continuity/cliContinuity.ts:225`）
持有者崩溃后残留的租约，会让下一个 Run 最多卡 2 小时。
选项：租约记录持有它的 Run，持有者结束后可以接管；缩短 TTL 并用心跳续期；等待设上限，并返回可重试的错误。

**D20 Source 标注永久失败**（`server/src/modules/sourceAnnotation/service.ts:119`）
因 provider 故障耗尽重试后，标注会永久停在 failed；egress 关闭期间被跳过的条目也回不来。
选项：同一 Space 下次批次成功后重新入队；provider 或 egress 设置变化时重新入队；给管理员一个重试操作。

**D26 记账导入时跳过 unknown_account 条目**（`plugins/official/finance_ledger/server/src/domain/importExportService.ts:108`）
选项：整次导入全部拒绝（全有或全无）；或者保留部分导入，改为按条目而不是按文件去重。

**D70 回合读模型显示上一次尝试的状态**（`server/src/modules/runs/turnReadModel.ts:165`）
会显示上一次尝试的错误和仍在"运行中"的工具调用。
选项：给 `host_thread_events` 加 attempt_number（要迁移），只取最新一次尝试；只过滤 `run_events`；保留旧尝试但折叠显示。

**D71 撤销跨 Project 共享可能删掉笔记的最后一个位置**（`server/src/modules/knowledge/spaceObjectProjectShares.ts:126`）
选项：笔记有其他位置之前，以 422 拒绝撤销；或者删除前自动把笔记放进所属 Project 的笔记文件夹。

**D72 全量扫描维护任务漏掉被截断的发现**（`server/src/modules/memory/maintenance.ts:73`）
被 `max_findings` 截断的发现会被跳过。
选项：截断时不推进游标；全量扫描任务不设每页上限；在任务上记录截断，而不是标记为完成。

**D75 后处理规则的手动 run/drain 与后台任务没有互斥**（`server/src/modules/sources/postProcessing/service.ts:765`）
同一个游标可能被处理两次，LLM 费用翻倍。两个手动接口目前前端还没有接入。
选项：手动路径复用 `hasInFlightRun`，运行中时返回 409；每条规则用咨询锁串行；加部分唯一索引。

**D76 重排预算和实际发送的长度不一致**（`server/src/modules/retrieval/searchService.ts:1587`）
预算按每个候选 2000 字符算，LLM 兜底时实际只发不超过 600 字符。候选数达到 24 个及以上时，后一半只剩标题。
这是排序质量上的取舍。选项：把兜底片段提到 2000 字符；没有原生重排时按 600 字符算预算；保持不变。

**D78 直接聊天的 restore_workspace**（`server/src/modules/agents/routes.ts:996`）
它在发送事务内执行主机侧的恢复，事务回滚撤销不了，重试会得到 409。
选项：把 `changed:false` 视为幂等成功；提交后再恢复（需要派发门）；前端在失败时重置勾选。

**D79 Plan 里的 action 节点**（`server/src/modules/plans/repository.ts:674`）
Plan 调度器把 `kind='action'` 节点当成普通的 LLM Agent Run 执行，而图校验和 WorkflowExecution 都把它当作确定性的处理器。
选项：调度器改走 `actionNodeHandlerRegistry`；或者 Plan 里不允许 action 节点。

**D80 Evolution 的待处理提案计数和列表范围不一致**（`server/src/modules/evolution/repository.ts:75`）
汇总里的 `pending_proposals` 只数 evolution 类提案，而 `/evolution/proposals` 列出所有可见的待处理提案。需要选：以哪一边为准。

**D81 研究重试丢失原始意图**（`server/src/modules/research/queryPlanning/adaptiveQueryOrchestrator.ts:218`）
重试仍以基础尝试的查询作为语义意图，所以 narrow() 无法恢复之前 broaden 时丢掉的限定词。
选项：在策略或计划上持久化原始意图；或者重试时重跑一次意图规划（多一次模型调用）。

**D82 摘要接口对历史日期生成快照**（`server/src/modules/informationDigest/routes.ts:30`）
没有快照的历史日期，也会生成快照，并消耗当天的候补池。
选项：历史日期没有快照时只读返回空；或者生成快照但不消耗池。

**D87 研究查询计划的 attempts 上限**（`packages/protocol/src/researchDiscovery.ts:153`）
协议限制最多 200 个，服务端却没有上限。手动重试足够多次后，每次策略响应都会校验失败。
选项：超出上限的重试返回 409；去掉 `.max(200)`；只返回最近 N 轮。

**D90 记账导入中提议状态的结构性指令立即生效**（`plugins/official/finance_ledger/server/src/domain/importExportService.ts:299`）
处于提议状态的 close 指令会立即关闭账户，open 和 commodity 也一样。
选项：保持立即生效，并写进文档；或者推迟到过账时生效，作废时回滚。

### 2.6 协议里声明了、服务端没有实现

每一条的选项都是同一类：补上实现，或者删掉字段和对应的界面分支。

- **D64**：协议允许 `inquiry_thread` 对象类型，但服务端映射和数据库的 CHECK 约束都拒绝它（`server/src/modules/ontology/objectProfileSubtypeKeys.ts`）。要支持它需要一次迁移。
- **D65**：`conversation_backend_required` 错误在协议和前端里都有声明和处理，但服务端从不抛出（`packages/protocol/src/rooms.ts:435`）。
- **D66**：前端 `Run.task_id/prompt_*` 字段，服务端从不返回，所以"打开关联任务"永远不显示（`apps/web/src/types/api.ts:2250`）。
- **D67**：`source_template_id` 从不存储，也从不返回，所以从模板创建的 Agent 会显示"直接创建"（`apps/web/src/types/api.ts:3050`）。
- **D68**：记忆的 `approved_by/last_accessed_at` 从不返回，界面上总是显示"-"（`server/src/modules/memory/repository.ts:70`）。
- **D69**：`CurrentUser.default_space_id` 从不返回，SpaceContext 里对应的分支是死代码（`apps/web/src/types/api.ts:563`）。
- **D83**：插件提案 applier 对记账提案返回 `result_type "knowledge_item"`（`server/src/modules/plugins/host/context.ts:203`）。目前没有生产来源，走不到这条路径。

### 2.7 前端交互与界面文案（修复需要新文案）

- **D23**：停用的 Provider 会从列表里消失，无法再启用（`apps/web/src/modules/providers/components/ProviderCard.tsx:124`）。选项：列出所有者自己停用的 Provider；或者去掉开关，停用即删除。
- **D24**：邀请链接和管理员重置链接复制失败时，一次性链接会丢失，界面还误报"已复制"（`apps/web/src/modules/space_settings/SpaceSettingsPage.tsx:100`）。选项：在界面上直接显示链接（重置链接标为机密）；或者先检查剪贴板可用，再生成链接。
- **D25**：Agent 选择器里的 Login 对 registry Agent 必然返回 422（`apps/web/src/modules/command_center/HostExecutionTargetPicker.tsx:437`）。选项：在执行目标数据里加上登录选项（改协议）；改成跳转 Command Center；点击时再拉取主机能力。
- **D51**：TimePage 占位页缺"计划中"字样，也没有模块文档的引用（`apps/web/src/modules/time/TimePage.tsx:22`）。
- **D63**：Automations 页把 information_digest 和 autonomous_tick 都显示为"agent run"，还显示一个必然失败的 Project 绑定编辑器（`apps/web/src/modules/automations/AutomationsPage.tsx:45`）。
- **D89**：图视图里隐藏最后一种可见的边，会让全部边重新出现（`apps/web/src/components/graph/GraphView.tsx:464`）。选项：改为 hiddenEdgeKinds 语义；不允许关掉最后一种；加一个显式的"无"值。
- **D91**：Run 设置里给新对话选的各 Agent 后端从不发送，实际由 Preflight 决定（`apps/web/src/modules/agent_groups/AgentGroupsPage.tsx:410`）。选项：去掉选择框；把选择作为 Preflight 的初始值传入；加提示说明。
- **D92**：记忆页只显示前 50 行，没有分页（`apps/web/src/modules/memory/MemoriesPage.tsx:96`）。
- **D93**：来源频道详情页首次加载失败时，会显示"Source not found"（`apps/web/src/modules/sources/SourceChannelDetailPage.tsx:107`）。

## 3. i18n：是否补齐（待决定）

已经核对过，中英文词典的 key 一一对应。问题在于下面这些地方绕过了词典，或者日期不跟随应用语言。修复需要编写界面文案，所以没有做。

| 严重度 | 位置 | 问题 |
|---|---|---|
| medium | `apps/web/src/modules/conversation/ConversationExecutionPreflight.tsx` | 几乎所有文案都是硬编码英文 |
| medium | `apps/web/src/modules/conversation/ConversationInputComposer.tsx` | 标签、aria-label、占位符、错误提示 |
| medium | `apps/web/src/modules/evolution/AssetLifecyclePanel.tsx`、`EvolutionInboxPage.tsx` | 没有使用 evolution 字典 |
| medium | `apps/web/src/modules/sessions/SessionsPage.tsx`、`PublicationsPage` | 全部硬编码，复数靠拼接，日期没有 locale |
| medium | `apps/web/src/modules/plugins/PluginsPage.tsx`、`useEffectivePlugins` | 全部硬编码，日期不随语言 |
| low | `apps/web/src/modules/conversation/` 下的 ConversationSurface、DiscussionGroup、ConversationTurn、ConversationRunControls、OpenDiscussionDialog、ConversationSessionConfig | 文案、复数、时间格式 |
| low | `apps/web/src/modules/agents/ChatPanel.tsx` | 提示、错误、占位符、确认框 |
| low | `apps/web/src/modules/project_files/ProjectFileEditor.tsx`、`ProjectFolderSettingsPage.tsx` | 按钮、状态、字节单位、日期 |
| low | `apps/web/src/modules/prompts/PromptLibraryPage.tsx`、`capabilities/CapabilitiesPage.tsx` | 整页硬编码 |
| low | `apps/web/src/modules/activity/`（Queue、Detail、Inbox） | 硬编码，复数靠拼接 |
| low | `apps/web/src/modules/knowledge/`（notes-tree、KnowledgeOverviewPage、utils.ts 中的 5 处 `toLocaleString`） | 菜单、概览、日期 |
| low | `apps/web/src/modules/network_profiles/`、`job_queue/JobQueuePage.tsx` | 全部硬编码 |
| low | `apps/web/src/core/ErrorBoundary.tsx`、`RequireRole.tsx`、`FocusAreasPage.tsx` | 文案 |
| low | `apps/web/src/components/ui/`（dialog、date-picker）、`components/graph/`、`components/editor/` | 默认文案、状态标签、日期 |
| low | `plugins/official/diary/web/src/DiaryPage.tsx` | 文案，日期没有 locale |

## 4. 已知未完成（不需要产品决定，可以直接安排）

**技术遗留**
- 发生 overflow 轮换后，对旧 binding 调用 `rotateMissingVendorState` 会返回 409；守护进程续接时仍然使用旧会话（`server/src/modules/runtimeContext/continuity/`）。
- 已有的多通道 Workflow 需要做一次数据修复，才能补全复数的 `workflowBindingIds/workflowRuleIds`（相关代码在 `server/src/modules/sources/monitoringCoordinator.ts`）。
- `GitStatus` 协议没有 `truncated` 字段，所以被截断的 `git status` 无法告知调用方。diff 的截断已经修好。
- Capabilities 导入时，服务端会重新抓取 URL；预览和导入之间上游包发生变化，目前检测不到，需要加 `package_hash` 校验。
- Usage 的单会话平均值：token 总量来自 summary 接口，它也计入了 summary 级访问，而会话数只计完整访问，所以平均值略有偏差。summary 接口没有 `total` 字段，Group 行也因此会被截断。
- `createTask` 没有检查归档状态。
- `069#2` 的取舍：`probe_domain_budget` 上限定为 3，与数据库约束一致；已存的 4–10 读出时按 3 处理。如果要用 10，需要做一次迁移。
- POLICY_ENFORCEMENT_INVENTORY.md 里的 `memory.cross_space_read` 在代码中找不到同名的东西，还没核实。
- `retrievalEvalGroup.test.ts` 的偶发失败没能复现。推测原因已经随 `dbGroup` 的修复一并消除，但没有直接证据。
- 列表顺序的拖拽回滚（`104#7`）已经修复，但没有自动化测试，因为 jsdom 无法模拟 dnd-kit 的手势。

**判定为不值得修的**（修复的复杂度或风险大于问题本身）
- 用预设创建 Provider 中途失败时，对已写入的三处设置做补偿（`012#3` 的 B 部分）。
- blob 复用和清理之间的竞态（`024#4`）：没有任何产品路径会硬删除消息，所以触发不了。
- 来源扫描 sweep 的饥饿问题（`074#6`）：要一个实例里有 25 个以上永久阻塞的 Space 才会发生。

**清理时留在原处的**
- 各模块 `index.ts` 里约 508 个没人通过 index 引用的再导出。收缩模块对外暴露的内容是设计决定。
- 约 250 个无法证明已经无用的导出候选：名字在 `vi.mock`、文档、插件或路径字符串里出现过。
- vendored 的 AI Elements（59 个导出，以及未使用的 `reasoning.tsx`、`task.tsx`）和 `components/ui` 里的 9 个导出。
- 两个没有使用的测试钩子：`capture/routes.ts` 的 `__setRelocationServiceFactoryForTests` 和 `captureFiling/routes.ts` 的 `__setCaptureFilingServiceFactoryForTests`。
- `registerProjectSourceRoutingHook` 从未被调用，所以内置默认实现始终生效。
- 仓库没有配置 ESLint，现有的 22 处 `eslint-disable` 都不起作用。

**仓库操作**
- 从 `6e542b31` 起，`dev` 上有 416 个提交，都没有推送；是否推送、何时合并到 `master`，由你决定。
- 署名问题：low 修复第 1–5 批的 46 个提交（`83942d94` 到 `5a06e266`）实际由 Fable 5.1 完成，但署名是 Opus 5.5。之后各批已按实际模型署名。要更正这 46 个提交的署名，需要重写这段还没推送的历史。
