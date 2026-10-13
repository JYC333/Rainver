# 无人值守审计遗留：已确认决策与实施计划

- 整理日期：2026-10-14。
- 来源：原 `2026-10-03-unattended-sweep-open-items.md`，以及 engineering-grill 逐项讨论。
- 状态：产品取舍已确认；尚未实施。原 D 编号和 R10 保留用于追踪。
- 文档性质：位于 `.agent/reports/` 的临时执行计划，不是当前实现或长期架构的权威说明。实施完成后，将实际行为落实到 owning guides/API 文档，再按仓库规则归档或移除本文件；不要将本文件加入 context bundle。
- 授权范围：本次授权是整理、保存计划，不包含实施、提交、推送、部署、发布或数据库重置。后续获得实施授权后，依本计划推进；不为已确认取舍重新发起逐项确认。

## 1. 目标、边界与完成标准

将原报告中的安全、权限、运行、内容生命周期和界面问题转化为可验证的实现，不引入另一套权限、提案、认证、队列或运行引擎。

### 1.1 必须保留的最终决定

1. **没有旧业务数据。** 不安排旧数据清洗、重复行修复、历史 Workflow 补写、旧 binding 修复脚本或仅为旧实例提供的兼容层。新增字段、约束、索引仍需结构迁移与验证；这不授权删除现有数据库或重置迁移链。
2. **Space 与 Project 不同。** 每人有个人 Space 和个人助手；共享 Space 及 Project 各自可有共享助手。共享 Space 助手只由 Space 创建者调整，Project 助手只由 Project owner 调整。
3. **退订不等于撤销来源授权。** 退订停止新内容及自动画像信号，历史原文保留且可阅读；撤销来源访问授权后，历史原文也不可访问。
4. **个人与团队信息同时保留。** Today 的个人待阅读按本人计算，团队概览展示有权限的共享工作，阅读统计遵守匿名门槛。
5. **知识库检索由显式开关控制。** 新对话默认关闭，按用户和对话保持选择，控制真实检索行为；明确附加的材料仍可使用。
6. **Memory 内部版本不等于人工确认任务。** 无实际修改不产生新版本；正常受控写入保留 review-after，维护只把真实问题或需要编辑的修改交给用户。
7. **历史报告允许手动补生成。** 查询只读，补生成由明确操作触发，不占用当天意外发现池，不覆盖已有快照。
8. **标注失败需要提醒和有限恢复。** 提醒包括原因和下次自动重试时间；缺少授权等阻塞条件显示等待条件，不显示虚假倒计时。
9. **记账导入逐条成功、逐条纠错。** 一条失败不阻塞其他正确交易；交易及 postings 原子处理；防止重复。
10. **导入不开户、不关户、不直接过账。** 缺账户时映射到已有可用账户；账户管理是独立操作。移除前后端 `post_directly`。
11. **Project 笔记在所属 Project 始终有入口。** 跨 Project 共享是同一笔记的入口，撤销共享只移除目标入口和访问权；删除本体是独立操作。
12. **完整补齐报告列出的 i18n。** 包括官方日记插件、日期、复数、错误、无障碍标签；用户原文不翻译，UI 语言不改变报告时区。

### 1.2 通用实施约束

- 开始每组代码修改前，按 [INDEX](../INDEX.md) 和 [context-bundles](../context-bundles.yaml) 选最小相关路由，阅读 owning guide、相关边界及 ADR；不把整个报告当产品运行时上下文。
- 遵守 [BOUNDARIES](../BOUNDARIES.md)、[复用政策](../architecture/REUSE_AND_DEPENDENCY_POLICY.md)、[事务规则](../architecture/DATABASE_AND_TRANSACTIONS.md)、[测试策略](../architecture/TESTING_STRATEGY.md) 和 [COMMANDS](../COMMANDS.md)。
- Memory active state 只经 canonical applier；不得添加直接表写入或绕过 provenance/review。凭证遵守 ADR 0008，不经 ambient/CLI 环境传递 Provider key。
- 权限必须在服务端执行。列表、详情、统计、错误建议、通知、Artifact/原文及导出使用一致的受众判定；前端隐藏不构成权限保护。
- 结构以 `server/src/db/schema/` 为 authoring source，生成追加 migration；插件 schema 按插件现有迁移机制处理。禁止直接修改旧 SQL 来伪装已经升级。
- 下文提及的新增字段是需要表达的语义，不是已经存在的字段或最终命名。优先复用现有字段、版本、队列状态和 facade；必要新增同步 Drizzle、SQL、repository、协议和消费者。
- 路径约定：后端模块内的短路径（如 `auth/reauth.ts`）相对于 `server/src/modules/`；前端模块内的短路径相对于 `apps/web/src/modules/`。明确列出的完整路径优先；函数名用于定位，不把原报告的旧行号当稳定实现入口。
- 不承诺统一提交策略、每组提交或新增人工批准门。实际实现任务另行授权；计划的阶段划分表达依赖和验证范围。

## 2. 工作包与依赖顺序

| 工作包 | 问题范围 | 上游依赖 |
|---|---|---|
| P01 文件、Git 网络、主机输出、Provider 外发 | D6、D45、D52、D58 | 无，优先 |
| P02 认证、错误输出、运维 | D35、D48、D61、D62、D73、D88 | 无，优先 |
| P03 身份、助手与审批/覆盖层权限 | D1、D4、D8、D10、D46、D47/D57、D50、D74、D85 | P02 的身份/session 边界 |
| P04 Memory 生命周期与维护 | D13、D21、D43、D72 | P03 |
| P05 续接、任务门与结算 | D3、D11、D12、D49、D79 | P03；与 P04 联调写入门 |
| P06 资产、策略和导入快照 | D2、D18、D19、D28/D36、D54、D84、D94、package_hash | P03 |
| P07 Library、来源历史、兴趣与 Today | D5、D7、D22、D53、D59 | P03；外发消费者依 P01 |
| P08 每日报告、补生成与标注恢复 | D9、D20、D82 | P07；重试外发依 P01 |
| P09 检索、预算、并发、续接 | D14–D17、D60、D70、D75、D76、D78、D81、D87、技术遗留 | P01、P03、P05；来源资格依 P07 |
| P10 笔记 placement 与公开摘要 | D71、D77 | P03 |
| P11 记账导入与 reflection 幂等 | D26、D90、R10 | P03 的 scope/读写边界 |
| P12 协议、交互和完整 i18n | 其余 D 项、技术遗留、i18n | 对应后端工作包；可独立项先做 |

先打通 P01–P03 的安全与权限基础。之后按依赖推进各域；每个包的协议、界面、文案和文档随功能同步交付，P12 最后只做剩余修复和整体检查。无需等待其他无关工作包结束才做聚焦验证。

## 3. P01：文件、Git 网络、主机输出与 Provider 外发

**上下文：** `security-access`、`project-folder-artifact`；主机侧增加 `host-daemon` 的相关文档。参考 [project-files](../modules/project-files.md)、[hosts](../modules/hosts.md)、[SOURCE_CONNECTOR_CONSENT](../architecture/SOURCE_CONNECTOR_CONSENT.md)、ADR 0016。

### 3.1 D52：Folder 读取消除路径竞态

**事实与入口：** `packages/folder-read/src/read.ts::readFolderFile` 当前先 `assertContainedPath`，再按路径 `stat/readFile`；`server/src/modules/projectFolders/codePatchTarget.ts::withCodePatchTarget` 已有 Linux 目录句柄逐级打开机制，但它不是 Folder 读取的通用跨平台实现。

**实现步骤：**

1. 在 `packages/folder-read` 提取或扩展目的明确的 Node-only 安全打开机制。共享包不得反向导入 server，也不得复制两套安全算法。
2. 根目录及每个不可信路径组件使用目录句柄约束；最终文件安全打开后，类型检查、大小检查和内容读取都使用同一个句柄。Linux 可复用已有 `/proc/self/fd`、`O_NOFOLLOW` 机制。
3. 保留 `PathPolicy` 的 traversal、secret-like、protected-folder 规则。处理根目录信任及路径组件变化，不能只保护最后一级 symlink。
4. 读取最多 `MAX_FILE_BYTES + 1`，检测读取期间增长的文件；拒绝目录、FIFO、设备及其他非普通文件，支持取消并在所有分支关闭句柄。
5. server 与 host daemon 的 Folder 读取均接入该机制。保持现有编码识别、哈希及错误契约；新错误同步协议和可读文案。
6. **实施前置技术验证：** 为每个实际支持平台验证祖先目录和最终文件替换时仍不能逃出根目录。Linux 方案不能宣称覆盖 Windows/macOS；无法证明安全时不得采用旧的不安全 fallback。外部方案选择见 §15，未支持的平台明确返回能力错误，平台缺口仍记录为未完成。

**验收：** 正常 UTF-8/UTF-16/二进制行为保持；确定性竞态用例覆盖最终文件与祖先目录替换；secret-like 路径、特殊文件、动态超限均拒绝；FD 无泄漏。不能仅靠一次普通 symlink 测试关闭 D52。

### 3.2 D6：Git clone 只连接公网服务

**入口：** `server/src/modules/projectFolders/repositoryUrl.ts`、Folder 创建/clone 调用链；复用 `packages/outbound-guard` 及 `packages/host-daemon/src/egressProxy.ts` 的校验/连接思路。

- 保留公网 Git 服务的私有仓库认证能力，拒绝 loopback、link-local、私网及其他禁止目的地。
- 校验实际 DNS 结果和实际连接；重定向每次重新校验，不能只在接受 `repo_url` 时检查一次 hostname。
- 原生 Git 经受保护的传输连接执行。HTTP(S) 可以采用受控代理/CONNECT；SSH、git、scp-style 等只有能提供同等连接保护时才允许，否则拒绝并提示预先 clone 路径。禁止协议或代理配置绕过守卫。
- 复用连接校验时核实 upstream proxy 是否实际连接经校验 IP，不能认为转发原 hostname 自动完成 DNS pinning。
- 私网 Git 的正常方式是可信机器 clone 后，使用现有目录/配对主机注册，不新增私网仓库 allowlist 管理系统。

**验收：** 公网仓库成功；私网 IP、混合 DNS、DNS 重绑定、公网到私网 redirect、协议变体绕过失败；拒绝原因可读且无凭证输出。

### 3.3 D45：主机上传绑定当前执行尝试

**入口：** `server/src/modules/hosts/routes.ts` 的 diff/output 上传及相关 materialization。

- 验证 Host、Run、当前 `launch_id`/attempt 的关系；在持久写入前再次原子检查终止状态及当前尝试。
- Run 终止后拒绝新增输出副作用。终止前已接受的合法输出按结算流程处理，避免因异步尾部上传丢失结果。
- 同一 delivery 已持久化后的重复确认可返回幂等成功，但不得产生新对象、事件或覆盖新 attempt。

**验收：** 旧 launch、其他主机、终止与上传竞态均受控；重复传输只产生一次物化结果。

### 3.4 D58：本地推理按实际部署判定

**入口：** `server/src/modules/retrieval/egress/egressPolicy.ts`，以及 Provider/runtime profile 解析。

- 移除 `provider_type === ollama` 即本地的判定。记录部署类型、可信本地服务声明及必要模型属性；具体存储复用现有 Provider 配置。
- 同机服务及 Space 管理者明确登记的可信 Docker/LAN 服务，在确认本地推理时可作为 local。云端模型、公共远端、无法确认的部署按 external。
- 不能仅凭 localhost URL 证明实际推理本地；检查已知云模型元数据，并要求可信部署的 local-only 配置。未知默认收紧，运行配置覆盖不能改变分类而绕过 consent。
- 调用仍检查来源 consent、目的地、credentials 和预算。URL/部署归类不授予 Source 访问权。

**验收：** 本地、可信 LAN、公网 Ollama、localhost 云模型、未知部署、runtime override 分别覆盖；禁止外发的 Source 在任何路径上均不能发往云端。

## 4. P02：认证、错误输出与生产运维

**入口文档：** [auth](../modules/auth.md)、[deployment](../modules/deployment.md)、[OPERATIONS_AND_SAFETY](../architecture/OPERATIONS_AND_SAFETY.md)，ADR 0008、0020、0023。

### 4.1 D48：一次性、会话绑定的重新认证授权

**入口：** `server/src/modules/auth/reauth.ts`、认证/敏感操作 facade；可复用现有 Google reauth 的服务端 nonce 与会话绑定模式。

- grant 使用不可预测 token，服务端保存摘要、用户、会话、允许操作、过期时间、消费状态；沿用现有 10 分钟有效窗口，不另建认证协议。
- `status` 只读，不消费；敏感 mutation 原子校验并消费，重复、过期、另一 session/用户/操作均拒绝。消费与本地 mutation 的事务边界明确，不能允许并发使用两次。
- 登出清 Cookie 并撤销 grant；session revoke、用户禁用同样失效。重新认证造成 session 轮换时绑定成功返回的新 session。
- 调整安全设置页状态、失效/重认证提示及文档，使“mutation 消费授权”真实成立。

### 4.2 D73：正确传递 Better Auth 滑动续期

**入口：** `server/src/modules/auth/identity.ts` 的 `auth.api.getSession` 调用、`betterAuth.ts`，复用 `auth/routes.ts::authSetCookies/sendAuthResult` 的多 Cookie 转发语义。

- 由 Better Auth 决定 session refresh，取得并转发其全部 `Set-Cookie`；核对锁定版本支持的返回 headers API，不自行生成或写第二套 session。
- 认证中间层向实际响应传递续期 headers；正确处理多个 Cookie，保留 Secure/HttpOnly/SameSite/path。
- 尊重 rememberMe=false 的非持久 Cookie；登出不被续期响应重新建立有效状态。

**认证验收：** grant 消费/撤销、并发消费、session 轮换、滑动窗口、非持久 Cookie、多 Set-Cookie；`authFoundationDb`、auth routes/cookie 相关测试覆盖实际 facade。

### 4.3 D61/D62：安全错误契约

**入口：** `server/src/modules/scheduler/registry.ts`、status/告警消费者、`server/src/modules/routeUtils/common.ts::sendRouteError`。

- 面向 Space owner 的 scheduler 状态返回稳定错误码、安全说明和 request/correlation id；原始异常只进入实例管理员可访问的运维渠道，不能塞回普通状态字段。
- 5xx 固定安全 detail。Provider 502 等仅返回 allowlist 中的结构化错误类别、可重试性等，不返回原始 body、堆栈、URL 中凭证或 arbitrary error.message。
- 前端用稳定 code 映射本地化说明；日志关联保留诊断价值。

**验收：** 用包含 token、私有路径及跨 Space 内容的异常确认响应和普通告警不泄露；日志仍能定位。

### 4.4 D35/D88：服务状态与生产更新路径

- 无 worker 保留 degraded 及可执行的原因说明，不能误报 healthy；不为此扩展新的状态模型。
- `deployer/scripts/rebuild.sh` 在 prod 入口先拒绝，再引导实例更新/已有 `update.sh`，确保未开始换镜像；不新增逃生口。
- 更新继续复用维护、排空、备份和迁移边界。本计划不执行实际 rebuild/update/deploy。
- 验收使用脚本参数/模式测试及无真实部署副作用的测试；文档指向正确命令。

## 5. P03：助手、Automation、覆盖层与审批权限

**上下文：** access、agents、automations、capability、proposals owning guides，以及 ADR 0002/0003/0009/0017/0018。核心复用 `server/src/modules/access/`、`proposalReadSql` 和既有角色/对象权限 helper。

### 5.1 D46：助手目标与配置所有权

**入口：** `server/src/modules/agents/routes.ts` 的 default-assistant/settings，以及 provisioning、runtime profile、绑定/Skill overlay 调用链。

| 目标 | 配置权限 | 校验方式 |
|---|---|---|
| 个人 Space 个人助手 | 本人 | personal Space 实际用户身份 |
| 共享 Space 助手 | Space 创建者 | `spaces.created_by_user_id`，不能仅检查 owner/admin role |
| Project 助手 | Project owner | Project 实际 owner，且目标 Project 有效 |
| 普通个人 Agent | Agent owner | 真实 Agent owner |
| 其他 ownerless system Agent | 既有管理权限 | 不因助手规则放开所有 system Agent |

- 在配置入口显式表达目标作用域，复用 scoped settings/runtime profile；读回、修改、运行解析对准同一目标。
- 校验 `default_project_id` 同 Space、可读、有效；越权目标使用现有不可探测的错误约定。
- shared assistant 的所有设置/覆盖层使用专门规则，不让 Space admin 的通用覆盖层权限绕过创建者限制。
- 不引入所有权转移或管理员接管；不为 ownerless `system_assistant` 自动添加 ADR 0003 禁止的 persona。

### 5.2 D1/D8/D10：Automation 配置、阅读与执行责任

**入口：** `server/src/modules/automations/{service,routes,workflowExecutionService}.ts`。

- 仅 Automation owner 修改 prompt、目标、执行配置、授权相关状态；管理员只能暂停/归档止损，不能替所有者重新启用。
- 个人非 Project Automation 内容仅本人可见；Project Automation 按 Project reader。列表、详情、历史、Run 输出一致过滤。
- 管理员运维控制单独返回无内容的必要状态，不含 prompt、私人配置/结果或可反查的私有摘要。
- Workflow checkpoint approver 只作为 approval audit；后续节点沿用创建/启动 execution 时确定的负责主体及 credential principal，不借审批切换成审批人。
- 不新增自动转移责任或凭证授权功能。

### 5.3 D4/D47/D57：按实际对象和变更范围授权

**入口：** `capabilities/proposalApplier.ts`、`capabilities/repository.ts`、`proposals/applyService.ts`。

- Space 安装、共享版本及共享绑定由 Space owner 批准；Project 范围启停/配置由 Project owner 批准。实际 effect scope 来自目标记录及变更内容，不由 incidental `project_id` 决定。
- 保持 Run 不产出 `capability_*` 的既有边界，不恢复已经移除的生成路径。
- persona/agent Memory 审批人从实际 Agent/Memory 推导。省略或伪造 `required_owner_user_id` 不能放宽权限。
- 普通 Space Skill overlay：owner/admin；Project/Folder：read+write；个人：本人；普通 Agent：实际管理者；shared assistant：§5.1。
- overlay 不授予 capability trust、外发许可或 credential 使用权。先查读权再进行对象相关响应，不能仅检测 ID 存在。

### 5.4 D50/D74/D85：堵住其他越权入口

- `proposals/proposalDecisionExecutor.ts` 的 `list_pending` 和 decide 404 建议统一 `proposalReadSql`，过滤真实指示人可见的提案。
- `access/creationContext.ts` 的 Project 内容创建要求 read+write。仅改变内容创建路径，不给所有管理性 canWrite API 全局加读门，也不赋予管理员隐含阅读权。
- `activity/repository.ts` 单条/批量 consolidation 要求 `owner_user_id === actor`；不新增“复制为我的记忆”功能。Project Activity 的落地规则见 P04。

**验收：** 两个人、Space 创建者、另一 owner/admin、Project owner/reader 的权限矩阵；读/改/批量/错误提示/间接 overlay 均验证。审批人、所有者、执行责任人各自独立记录且不混用。

## 6. P04：Memory 共享、维护和扫描完整性

**入口文档：** [MEMORY_MODEL](../architecture/MEMORY_MODEL.md)、[MEMORY_ACTIVITY_PROVENANCE](../architecture/MEMORY_ACTIVITY_PROVENANCE.md)、[MEMORY_MAINTENANCE](../architecture/MEMORY_MAINTENANCE.md)、[ADR 0003](../decisions/0003-memory-proposal-flow.md)。

### 6.1 D43/D21：canonical 写入及受众覆盖

- `contentAccess/service.ts` 不再直接更新 active Memory 的 visibility/access；生成正确目标的提案，经 canonical applier 创建版本、provenance 和原子 grants 变更。
- 应用时再检查 owner-sharing 权限、目标 placement、scope、受众及 source audience，不能只在提案创建时检查。
- Space admin 不能放宽他人 Memory。个人 Memory 不能仅切一个 visibility 就成为合法的 Space 共享 Memory；跨作用域按既有受治理转换语义处理。
- `activity/repository.ts` 的 Project Activity consolidation 目标是 Project 共享 Memory，仅在来源可见受众包含全部目标读者时允许；否则提示先明确共享。不要新增 Project 下 user-private Memory 类型。

### 6.2 D13：低噪声、可编辑的维护

**入口：** `memory/maintenanceArtifacts.ts`、维护 proposal 创建/accept、existing Memory revision editor。

- 维护默认检查/报告真实问题。年龄、薄内容等提示仅作为可见元数据，不能批量创建用户确认任务。
- 对实际需改内容生成具体 diff/提案，`requires_operator_edit` 进入现有 revision editor，编辑后才能接受；未编辑不能沿用旧内容伪装修复。
- 无实际变化直接返回 no-op，不调用 applier 创建新版本。每种 repair action 都实现自己的实际变更，不能统一忽略 action 后写回旧内容。
- 结构/placement 修复保留原文和 trust，追加维护 provenance。注册可验证的维护 artifact/proposal 引用，不凭空采用未注册的 `memory_maintenance_packet` 来源。
- 只有用户明确确认内容真实性时追加 `user_confirmation`；点击结构修复不自动把机器提取内容升级为人类确认。
- maintenance packet 不引入批量直写 active Memory。正常 bounded manual-origin Agent 写入保持 canonical applier 与 review-after，版本记录不形成逐条审批队列。

### 6.3 D72：扫描游标不跳过发现

- `memory/maintenance.ts` 记录 truncation、首个未处理位置及可恢复状态；游标只能越过已处理内容。
- 下页恢复首个未处理 finding，避免把其来源 entry 提前跳过。若需 entry 内 cursor，记录可重放的定位信息。
- interrupted/truncated 不标 complete；重启续扫幂等，避免重复提案。

**验收：** visibility 变化有版本/provenance；admin 越权失败；私有 Project Activity 不能扩散；no-op 无新版本；编辑入口能完成修复；超过 `max_findings` 的结果最终全部可处理。

## 7. P05：续接来源、任务门与运行结算

**上下文：** runtime-agent、Project Work、system actions、Plan graph；ADR 0017/0018。入口 `runs/repository.ts`、Room/研究/委派续接、`runs/finalizationService.ts`、`projectWork/projectWorkSystemActionExecutors.ts`、`plans/repository.ts`。

### 7.1 D3：统一真实根来源与责任人

1. 服务端保存/解析可信的 root Run/执行链关系、root trigger origin 和 responsible user；客户端字符串或子 Run 的 `manual` 不足以授权。
2. 研究完成、delegation、discussion wave 等沿同一解析路径。仅原始用户指令范围、预算范围内的有界自动续接继承 manual。
3. scheduled/unattended 根运行继续 unattended；缺失/无法验证 lineage 按 unattended，不能 fallback manual。
4. Memory、persona、credential 和 system action policy 使用同一有效 origin/主体，保留子回合类型作审计，但不改变根授权。
5. 新用户明确发起的指令可以建立新的 manual root；不得把系统事件伪造成用户新指令。

**验收：** 人工根有界续接、定时根续接、混合委派、缺失/伪造 lineage、预算耗尽均覆盖。尤其证明 Room 后续回合不再绕过 unattended 写入门。

### 7.2 D11/D49/D79：使用现有动作执行语义

- `followUpTaskReconciler` 和其他 fan-out 共用每回合最多 5 个的 canonical 计数；并发调用也不超额。超过上限的输出留在待处理卡片，不丢失、不自行排入下一轮无限执行。
- `packages/protocol/src/systemActions.ts` 显式表达 `task.plan.propose` 的条件性提案/方向门，服务端 gate 及 registry 文档一致。不要把它标 durable 来省掉审批。
- Plan `kind='action'` 调度到 `actionNodeHandlerRegistry`，沿用 Workflow 的 deterministic handler、授权、幂等、结果/失败契约；不是再建立一个 action dispatcher。

### 7.3 D12：失败结算可恢复，不重跑 Agent

**事实：** `runs/finalizationService.ts` 当前对执行图 reconcile best-effort 捕获后仍提交完成门，可能留下未结算 Task。

- 把必要的 registry reconciler 纳入完成门成功条件，区分非关键的 best-effort 附属处理。
- 保存结算未完成/可重试状态，复用现有 jobs/scheduler 定期重拾；按 Run 和结算版本幂等。
- 不重跑已完成的 Agent、不重复模型调用或业务 output materialization。崩溃后从未完成结算继续；已完成的 reconciler 无重复 durable 副作用。
- 状态读模型区分 Agent 执行结束与结算未完成，呈现安全可诊断原因。

**验收：** 注入 reconcile 失败、进程中断和重复恢复，Task 最终结算、完成门不提前提交、模型只执行一次。

## 8. P06：系统资产、版本与能力导入

**上下文：** prompts、evolution、capability、policy owning guides，ADR 0009/0017。[POLICY_ENFORCEMENT_INVENTORY](../architecture/POLICY_ENFORCEMENT_INVENTORY.md) 中目标契约只能在实现完成后改为已生效。

### 8.1 D2：全局内置与 scoped 定制分离

**入口：** `evolution/assetPromotionProposalApplier.ts`、`prompts/repository.ts`、builtin 启动同步和 ref 解析。

- system baseline 属于发布/catalog；Space owner/admin 无权修改实例全局 ref，也不能把带 `space_id` 的 scoped 版本部署成全局 system ref。
- 用户、Space、Project、Agent 定制按各自 scope 解析；保留来源、版本与覆盖关系，启动仅同步 builtin baseline，不覆盖 scoped 定制。
- 拒绝跨 Space/跨 scope 的部署、晋升和回滚；不新增全局运行时管理员覆盖系统。

### 8.2 D28/D36：关闭不生效的 generic policy_change

**入口：** `proposals/applierRegistry.ts` 中 generic policy applier、生产入口/协议/界面和 policy 文档。

- 查清所有生产创建和接受入口，移除或显式拒绝 generic `policy_change`；不能继续把任意 domain 写入 `policies` 后显示“生效”。
- 保留真正被使用的 Runtime Context Policy 版本与解析能力，按实际机制区分命名和界面。
- 不构建 `PolicyEffectCatalog` 或另一套持久化通用策略引擎。无消费的表/类型按真实调用链做最小收敛，不能删除仍被其他有效功能使用的结构。
- 更新 policy inventory、相关 API/隐私说明及 dogfooding 停止条件，使其反映关闭后的实际能力，而非宣称无消费者的策略已受执行。

### 8.3 D18/D19：晋升保护引用，评估绑定不可变内容

**入口：** `evolution/assetPromotionProposalApplier.ts`、`evolution/assetRepository.ts` 及 prompt/workflow pin/部署/执行引用解析。

- 晋升新版本时检查仍被有效 pin、部署或执行引用的旧版本，`deprecate_previous` 跳过它们；不要强制重写他人的 pin。各引用所有者明确切换后，再处理无引用旧版本。
- candidate/testing 内容不可原地修改或退回 draft 后复用旧评估。创建 child version 承载修改，draft 正常编辑仍可用。
- evaluation、promotion payload 绑定 version 与 content hash；应用时重检 hash、状态、评估目标及批准对象，使用乐观条件更新防并发改变。
- 检查 active execution 引用的存活条件，不把已记录的历史执行一概当永久阻止回收的活跃引用。

### 8.4 D54/D84/D94/package_hash：快照与重复操作

- `capabilities/proposalApplier.ts` 拒绝 imported Skill 对 `normalized_skill`、`capability_definition` 及对应保留快照字段的覆盖。内容 hash 与包快照保持一致。
- Capabilities 预览返回 `package_hash`，commit 携带并核对实际获取字节的 hash；不一致返回需重新预览，不接受另一份内容套用旧批准。
- `prompts/repository.ts` 当前 ref 已是 rollback target 时，再次无版本回滚要求明确 `version_id`；保存/复用足以识别该状态的已有审计信息。避免两个版本来回摆动，不引入未使用的复杂回滚链系统。
- Review/Convert 的 canonical 幂等键至少包含 Space、actor、source/version、operation；已有待处理提案返回该提案。DB 唯一性/锁保护并发；已结案后合法新操作不被永久阻止。前端显示 pending 并禁用重复按钮。

**验收：** scoped 操作不能写全局 ref；启动不覆盖定制；旧 pin 可运行；修改后旧评估无效；snapshot/hash 不能漂移；并发 Review 只有一个 pending proposal；重复 rollback 不振荡。

## 9. P07：独立 URL 保存、来源历史、画像与团队 Today

**上下文：** [library](../modules/library.md)、[sources](../modules/sources.md)、[information-digest](../modules/information-digest.md)、[SOURCE_CONNECTOR_CONSENT](../architecture/SOURCE_CONNECTOR_CONSENT.md)、B54/B56/B24A。

### 9.1 D22：所有者与目标范围内去重

**入口：** `server/src/db/schema/sources.ts` 的 URL unique、所有保存/导入/来源落库路径及 Library 读模型。

- 去重范围包含真实 owner 与合法目标 scope，区分个人和 Project 目标；同一 owner/scope 的重复返回已有合法记录。
- 另一用户私有 URL 不阻止本人创建自己的条目。不将他人 private body、annotation、source credentials 或访问权复制过来。
- 修改 schema unique 与全部 writer 的 conflict target 一致；处理 nullable scope 的 PostgreSQL unique 语义，不能留下实际重复漏洞。
- 返回冲突/已有对象只在 actor 有权读取时提供对象信息。

### 9.2 D5/D59：画像证据与历史阅读资格分离

**入口：** `interestProfile/repository.ts`、Library reading event、来源订阅/consent service、原文/Artifact/导出 resolver。

- 为阅读记录保留 origin/eligible evidence。serendipity 入口产生的阅读不更新兴趣权重、coverage、maturity 或候选；明确接受主题、以后独立阅读可成为正常证据。
- 退订停止新投递，排除相应来源的自动画像事实，重算受影响统计；明确确认的 topics 保留。不把“曾被意外发现推荐过”作为永久排除标签。
- 新增或扩展**历史阅读资格**与现有订阅资格的区分：记录在获得合法阅读授权期间接收的历史内容，退订不撤掉此资格。
- 实际授权撤销/用户失去来源权限时，历史资格不再允许访问；仍遵守 retention/deletion。重新订阅按真实授权恢复，不凭旧 grant 自动扩大权限。
- 当前 Source gate 依赖 active connection/subscription，需要同步更新调用者；不能只修改画像 SQL，就声称历史原文已经可读。
- 原文读取、Reader、Artifact 下载和 export 使用当前 Source 授权检查，避免 Artifact ACL 成为绕过撤权的入口。导出时检查资格；不承诺追回用户先前合法下载的离线副本。

**验收：** 从推荐入口阅读不影响画像；独立阅读可计入；退订后无新内容、历史可读、自动统计不计；撤销实际授权后所有服务端历史入口拒绝；已确认兴趣不被退订删除。

### 9.3 D53：个人待阅读与团队工作并列

**入口：** `frontendSupport/service.ts` 的 Today/report home 聚合、`apps/web` 对应入口。先确认 `/today` 与 `/home` 的实际 consumer，不机械修改同名页面。

- 我的 pending reading 来自本人有资格的 Library/read state；他人 read/ignore/archive 状态不改变本人数量。
- 团队 overview 来自有权限的共享 Tasks、blockers、Runs、Project 工作，不改成只剩个人信息。
- 阅读聚合遵守至少 3 名成员匿名门槛，不暴露个人忽略/归档状态；不足门槛时隐藏相应统计，不用另一种数值旁路反推。
- 团队完成状态以共享任务/工作结果定义，不以每个人读完全部内容定义。

### 9.4 D7：Briefing/Activity 通知遵守产出受众

**入口：** `sources/postProcessing/` 的 briefing 产出、Activity Inbox 写入及详情 resolver。

- personal digest 只通知 owner；Project shared digest 通知符合当前阅读资格的成员。
- mixed briefing 不在更宽受众的通知中带私有摘要、item_count、title、id。按受众拆分必要指针通知。
- Inbox 存指针及安全说明，不复制正文；点击访问 owning surface 时重新校验权限，撤权后不可读。

**验收：** 两个人的 Today 独立；团队共享工作仍可见；小团队统计不泄露个人状态；私有 digest 不出现在另一人的 Activity 预览、计数或通知。

## 10. P08：前一完整自然日、手动补生成与标注恢复

**入口：** `informationDigest/{automationTarget,service,repository,routes}.ts`、`dailyReports/{scheduler,service,repository}.ts`、`sourceAnnotation/{service,repository,scheduler,job}.ts`。

### 10.1 D9：报告日期来自调度槽位与配置时区

- digest 与 daily capture report 统一汇总配置时区前一个完整自然日，次日按计划生成。用调度 slot 转成本地日期后减一日，不从 worker 执行时的 now 推断。
- 复用 `dailyReports/repository.ts::localDateFromSlot/localDayUtcBounds`，有共享需要时按 owning boundary 提取，不复制日期算法或引入第二套 cron。
- 取半开区间 `[startUtc, endUtc)`，记录 `report_date`、timezone、interval、`generated_at`，报告标题指内容所属日。
- 自动日程 snapshot 固定本次时区/slot。时区更新影响未来日程，不重新解释已存报告；UI locale 不参与日期归属。
- 修改默认自动计划、trigger payload、查询边界和协议/标签一致；不写死 Asia/Shanghai，也不继续固定前一 UTC 日。

**验收：** UTC、Asia/Shanghai、DST 春秋转换、月/年边界、延迟到次日执行、重启同 slot 幂等；每个完整日条目归属唯一且无漏项。

### 10.2 D82：查询只读，补生成显式且幂等

- 历史 GET 仅查询已有 snapshot；不存在返回协议明确的 missing 状态/空结果。页面给“补生成”动作，不自动调用生成 service。
- 新增显式生成 command/POST，目标个人报告要求本人；Project 报告要求 read+write。校验所请求日期属于完整历史日，按配置时区而非浏览器/UTC-now 判断。
- 按 scope/owner/report_date 的既有身份建立并发幂等；已存在直接返回，不覆盖，也不重复模型付费。
- 补生成覆盖该完整日的当前留存合格数据，保存 `backfilled` 和实际生成时间。省略依赖当日 serendipity pool 的部分，不占用或挑选今天的池。
- 返回缺少历史材料的说明；不能宣称还原当时未保存的排序快照。失败保留可重试状态，不持久化伪成功 snapshot。

**验收：** 只打开历史页面不产生 DB 写入或池变化；双击/并发补生成只有一份 snapshot；无权限拒绝；重试不会覆盖已有报告。

### 10.3 D20：有限重试、条件恢复与明确提醒

**事实：** 现有 `ANNOTATION_MAX_ATTEMPTS = 3`，耗尽后 parked；`requeueParked` 已有定义和 DB 测试，但当前没有生产调用者。已有 helper 不能当作恢复流程已经完成。

- 扩展现有状态表示：临时失败待重试、等待 Provider/egress/consent 条件、自动预算耗尽暂停，分别有稳定 reason。存 `next_retry_at`、累计尝试/恢复预算及故障 episode identity 所需信息；能复用字段就不另建总状态表。
- 使用现有 jobs/scheduler 实现有限退避。初始实际失败上限沿用 3；条件恢复可开启受限的新恢复轮次，但必须有累计自动上限，不能每次批次成功就把全部失败无限重置。
- 建议实施初值：初始最多 3 次实际尝试，后两次分别在失败后 1 分钟、5 分钟；其后仅一个最多 3 次的自动恢复轮次，间隔为 30 分钟、2 小时、6 小时，同一故障 episode 累计最多 6 次。真实阻塞条件未恢复时不消费尝试，也不安排虚假的到期执行。这些是工程默认建议，不是用户逐项确认的数字；实现者可依据现有调度粒度调整并在常量、文档和测试中统一记录。
- `requeueParked` 增加 item/source/connection/reason、数量限制及 episode 约束。只重排受影响、仍可读且未成功的条目，避免无界重置整个 Space。
- Provider/egress/授权恢复事件和手动操作调用同一恢复机制；临时故障自动重试，缺配置/权限等待真实条件变化。每次执行重新检查 consent 和 egress。
- 给有权限的负责人一条可更新的故障通知：原因、受影响 eligible 数量、下次绝对时间/倒计时、手动重试。阻塞等待不显示倒计时；预算耗尽显示暂停和恢复入口。
- 同一故障 episode 合并通知，成功更新/清除；共享通知按 P07 规则，不泄露私人条目或数量。手动操作也受单次预算、并发认领和 rate/bounds 约束。

**验收：** 故障后能恢复，成功条目不重跑；倒计时与持久调度一致；无 Provider/禁止外发不循环付费；自动累计上限有限；并发手动/后台不重复执行；API、按钮、实际生产调用均接通。

## 11. P09：检索控制、并发预算、租约与尝试读模型

**上下文：** `runtime-context`，必要的 sources、research、sessions 文档；以 RuntimeContextGateway、WorkContextSetup、existing queue/lease 为入口，禁止增加另一套运行编排。

### 11.1 D60：对话知识库检索开关

**入口：** `runtimeContext/productionAcquisition.ts`、相关 retrieval tool adapter、Conversation composer controls 和 WorkContextSetup typed preference/versioned snapshot。

- 新对话默认 OFF；按 user+conversation 保存选择，其他成员的选择不改本人设置。提供小按钮和检索域选择，不另增跨对话全局保持选项。
- 检索域 registry 覆盖真实知识域，如 knowledge_item、note、source、claim；使用现有 typed registry，不用任意 metadata string 作为权限。
- Runtime acquisition 和本次 Run 可用检索工具都遵守冻结的选择；UI OFF 时不能因模型调用另一个工具而自动查询同一知识域。
- 用户明确 attached 的材料不受自动检索开关排除；其他检索域不被连带关闭。每次访问仍执行 ACL、Source consent、egress 和预算门。
- 实施时核对并更新 B24/相关 Runtime Context 文档，表达受显式控制的检索与 ingestion 的区别：读取不自动生成 Memory，也不把知识条目自动变成 accepted delivery。

**验收：** OFF/ON、刷新恢复、同一会话不同用户、工具调用、显式附件、多检索域、已启动 Run 的冻结设置均覆盖；不能只测按钮外观。

### 11.2 D14/D15/D75/D76：队列、预算与后处理

- **D14** `retrieval/embedding/service.ts`：策略阻止的 chunk 标记 blocked/skipped-policy，并绑定有效政策/目的地代次。claim 不再被这些队头条目占满；consent、Provider 或目标变化时有界重排相应条目。成功/无关失败不被全部重置，不靠无限扫批解决饥饿。
- **D15** `sources/sourceBackfillExecutionService.ts`：同一 plan 的 segment 每页原子预留额度、核对总已用+reserved；按实际新增唯一 items 消费，失败释放未消费 reservation。页返回超额时只落可用部分并保存可恢复 cursor；并发永不超 `max_items`。使用现有事务/锁，不依赖单 worker。
- **D75** `sources/postProcessing/service.ts`：手动 run/drain 与后台 job 使用同一按 rule/cursor 的原子认领或 PostgreSQL advisory lock，重复请求返回既有运行/明确冲突。锁保护跨 worker，崩溃可恢复；不新接前端手动功能作为顺带扩展。
- **D76** `retrieval/searchService.ts`：原生 rerank 与 LLM fallback 使用其实际发送 excerpt 长度分别计算预算，candidate 数、字符串截断和计费估算使用同一最终 payload。不能因为错误的 2000 字符假设让后半候选只剩标题；不直接把所有 fallback 内容扩大到 2000。

**验收：** blocked 队头不饿死可用任务；政策更新只恢复匹配项；多 segment 同时落库不超额度；手动/后台只执行一次 LLM；24+ 候选的预算和实际片段匹配。

### 11.3 D16：长行有界续读

**入口：** `sessions/conversationInputResourceService.ts`、`input_resource.read` 协议和 tool。

- 在现有行定位基础上支持 byte offset/next cursor，返回 bounded data、next offset、EOF/截断信息；资源保持已冻结版本，不能续读另一份文件。
- 单行超过 64KB 可以分块继续，处理 UTF-8 多字节边界；明确 byte offset 与字符列不是同一单位。
- 不创建虚拟行号，不因超长行拒绝整个附件，不返回无界内容。检查 offset 范围和运行访问资格。

**验收：** >64KB 单行、多字节边界、EOF、非法 cursor、重复续读及资源身份保持；顺序拼接恢复原文，引用行号稳定。

### 11.4 D17 与 continuity overflow 遗留

**入口：** `runtimeContext/continuity/cliContinuity.ts`、`rotateMissingVendorState`、host daemon 续接/绑定响应。

- lease 记录 holder Run、唯一持有 token/代次，缩短 TTL 并心跳。接管后旧 holder 的迟到续期、写回或释放不能影响新租约。
- terminal/dead holder 可依法接管；等待有上限、支持取消，超时返回可重试错误，不能再卡两小时。
- overflow/vendor state 轮换后以服务器返回的最新 binding/generation 为权威，daemon 更新缓存并续接新 session；旧 binding 的幂等重试解析到当前结果，不盲目重复轮换。
- 不做旧数据库 binding 修复脚本；新运行、轮换、崩溃重启流程全部正确。

**验收：** 崩溃接管、旧 holder 迟到请求、长 Run 正常心跳、等待取消、连续 overflow 及重启后 session 一致。

### 11.5 D70/D78/D81/D87 与 GitStatus 遗留

- **D70** `runs/turnReadModel.ts`：事件可归属实际 attempt/launch；默认投影最新尝试，旧错误/工具状态归入折叠历史。不能只过滤 run_events 而留下 host_thread_events 污染，确需字段时同步 schema/wire。
- **D78** `agents/routes.ts` 的 restore_workspace：提交前只记录 intent，外部恢复在事务成功后、Run 派发前经现有 dispatch boundary 执行；失败可恢复且不会先运行 Agent。`changed:false` 是幂等成功，不返回假冲突。
- **D81** `research/queryPlanning/adaptiveQueryOrchestrator.ts`：persist 原始 semantic intent，broaden/narrow/retry 都从该原意图及当前约束派生，禁止用已经放宽的查询替换原始意图；不多加一次 LLM planner。
- **D87** `packages/protocol/src/researchDiscovery.ts`：摘要响应使用 bounded recent attempts，完整历史提供既有分页模式；同步 total/has_more/cursor 及消费者。超过 200 的历史仍合法可读，不以无关协议数组限制拒绝新重试。
- **GitStatus**：`packages/folder-read` → host wire → server → web 传递 `truncated`，显示结果不完整。不得把截断结果当全量结果作破坏性判断。

**验收：** 前次失败不再显示为当前 running；恢复失败可重试且无事务外失控副作用；narrow 恢复原限制；>200 attempts 可验证、可分页；truncated 信号端到端可见。

## 12. P10：笔记 placement 与公开摘要

**上下文：** knowledge、Project、content access/ontology；阅读 [PROJECTS](../architecture/PROJECTS.md)。

### 12.1 D71：所属 Project 至少保留一个入口

**入口：** `knowledge/noteWriter.ts::removeNotePlacement`、`knowledge/spaceObjectProjectShares.ts::revokeSpaceObjectProjectShare`、`noteProjectFolders.ts::projectOwningCollection/ensureProjectNotesFolder`、folder move/delete/batch/reorder/capture 路径。

**当前缺口：** `removeNotePlacement` 只检查全局至少一个 placement，允许 A 的笔记只剩 B 的共享位置。仅在撤销 B 时恢复 A 入口不能修复这个根因。

- 定义不变量：`note.project_id = A` 的活跃笔记，至少一个有效 placement 的 collection 位于 A 的所属目录子树。B 的共享位置不满足它。
- 从实际 collection ancestry 判断 owning Project，复用 `projectOwningCollection`；不根据目录名推断。必要时用 `ensureProjectNotesFolder` 建立新笔记初始入口。
- 删除 A 最后入口要求显式移入 A 的其他目录或独立删除本体；显示这两个实际可执行动作，不默默移动到 B 或改变 owner。
- A/B 是同一笔记本体，B 在有效共享权限下可见最新正文。整理 A 的目录不撤掉 B；撤销 B grant 只删 B 的共享入口与授权。
- 所有 placement 删除/移动、文件夹子树移动/删除、批量整理及共享撤销，在事务中按笔记锁定后验证最终状态；统一锁顺序避免并发各自看到“还有一个”却共同删光。
- 主体 deletion 是独立明确操作，按 canonical owning service 清理全部引用；不把撤销共享变成删除笔记。

**验收：** A 最后入口+B 剩余时移除被拦；A 内移动成功且 B 保留；撤 B 后 A 可找到、B 不可读；并发移除、删除 folder、批量操作均保持不变量；正文授权同步正确。

### 12.2 D77：草稿与已发布快照分离

**入口：** `projects/repository.ts` public summary、协议、编辑/发布界面与索引 writer。

- draft 与 published snapshot 分开保存，published 带批准人/时间/来源版本。普通 writer 只修改 draft。
- owner 级权限执行 publish/revoke；publish 在事务中核对草稿版本，不能批准后被并发草稿替换。
- 修改 draft 不影响旧 published；revoke 才下线。公开读取/检索只读取已批准版本，不将新草稿偷偷加入公开索引。
- 使用现有 reindex 机制更新批准版本，撤销时清理公开 projection；不添加另一份内容 authority。

**验收：** writer 保存草稿后旧发布内容仍可读；越权 publish/revoke 拒绝；并发编辑不发布未批准内容；索引和公开 API 一致。

## 13. P11：记账导入、账户映射与 reflection 幂等

**入口：** `plugins/official/finance_ledger/server/src/domain/importExportService.ts`（含 `ImportPersister`）、`domain/transaction.ts::withLockedBook/attempt`、插件 routes/types、`FinancePage`；日记插件 reflection writer。

### 13.1 D26：逐条状态与稳定身份

1. 复用现有 Beancount parser/engine validation，解析阶段不修改真实账户或 ledger。账户验证的模拟状态不能导致 persistence 自动创建账户。
2. 新增/扩展导入 batch 与 entry 状态：稳定来源记录身份、原始位置/内容摘要、pending mapping/validation error/imported 状态、生成的 draft 引用及错误。具体表名沿插件 schema 约定。
3. 身份优先用可信外部 entry ID；否则使用原始 import identity+occurrence 信息。同一文件重传可识别，原记录的 mapping 修正不会变成新记录。
4. 文件 hash 可快速匹配原 batch，但不能因为 batch 已存在而阻断其中失败条目的重试。也不能仅按交易内容 hash 去重，从而合并两笔实际相同的交易。
5. 失败子集/修改后的重新上传，要求保留 entry identity 或明确选择原 import 中未完成条目。身份不确定时先让用户关联/选择，不猜测去重或静默复制；保留完整原始记录身份供预览。
6. 每笔交易连同所有 postings 用 savepoint 原子持久化为待确认记录；失败回滚该笔，继续其他正确 entry。DB 唯一键配合 book lock 防并发重复。
7. preview/结果分别列成功、等待映射、错误、重复已导入条目；重试只处理未导入条目，已成功的 draft ID 不变化。

### 13.2 D90：导入只生成待确认记录

- 前端删除“直接过账” checkbox；协议/types 不接受 `post_directly`；服务端不再据该参数选择 `posted`。旧客户端传入该参数按严格请求校验拒绝，不能隐藏按钮后仍保留后门。
- import options、service 和 persister 固定待确认状态；所有真实过账经既有独立确认/过账 service，并保持 money gate。
- 不导入执行 `open/close`，不把它们变成日后可自动执行的账户生命周期提案。parser 可保留内部分诊信息，但不调用账户 create/close writer，也不将模拟账户落库。
- 正常导入 UI 只表达交易、账户映射和错误，不提供“导入开户/关户”选项。文件中的生命周期指令不是授权；必要诊断可计入未导入指令，不作为普通设置项。
- `commodity`、隐含 `ensureCommodity` 及其他结构性指令也不能绕过 proposed 状态立即改变 canonical 结构。采用现有待确认引用/验证机制，确需配置时走独立设置或受治理确认；不顺带承诺新 commodity 管理功能。

### 13.3 缺少账户的显式映射

- preview 返回原账户名、受影响 entry 和“缺少对应账户”；映射输入指向当前 book 中已有且 actor 有权限使用的账户 ID。
- 复用现有账户列表/`findAccountForViewer`/创建关闭 API，不在 import service 内隐式创建。账户不存在时用户去账户管理，创建后返回刷新映射。
- 服务端重检同 Space、同 book、可见/可用及交易日期上的有效性。记录 mapping version 和原始 entry identity，映射修改不改变原记录。
- 有完整有效映射的 entry 可先成功；未映射 entry 等待，不丢弃、不标为成功。

**验收：** 正确交易+坏交易部分成功；交易不半写；缺账户映射后补入；重新上传/修改映射/并发导入无重复；内容相同的独立两笔保留；导入前后账户 opening/closing 及 canonical 结构不发生未经确认的变化；不存在任何直接过账入口。

### 13.4 R10：日记 reflection 多 worker 幂等

- 在插件 owning schema 添加 `(entry_id, reflection_date)` 唯一约束，writer 以明确 `ON CONFLICT` 幂等落库。
- 并发生成同 entry/date 只产生一个 durable reflection，重复 job 不覆盖用户后续编辑；如生成涉及模型调用，优先在调用前复用现有认领机制避免重复费用。
- 无旧数据，不加历史重复扫描或删除脚本。验证插件 migration 与多 worker 插入竞争。

## 14. P12：协议、界面、已知技术遗留和完整 i18n

**上下文：** frontend-product 的相关 owning guides、protocol foundation；涉及字段按真实 authority 核对，不为死字段增加无用子系统。

### 14.1 协议与真实数据对齐

| 问题 | 入口和实施要求 | 验收 |
|---|---|---|
| D64 Inquiry subtype | `packages/protocol/src/objectSchema.ts` 已有 `question/hypothesis`；补 `ontology/objectProfileSubtypeKeys.ts` 和 `server/src/db/schema/knowledge.ts` 对应 CHECK。遵守 ADR 0011 的 existing domain，不删除 Inquiry，也不扩展其他对象类型。 | 两种 subtype 创建/读回成功，非法值失败，schema/协议一致。 |
| D65 无生产来源错误 | 清理 `conversation_backend_required` 的死恢复契约、rooms catch 和 UI 分支，沿现有 Preflight 错误处理；不人为新增异常来源保留死代码。 | 当前后端错误均有实际可达处理，未准备执行配置通过真实 Preflight 阻止。 |
| D66 Run 关联 | 核对 canonical task/prompt/version 引用，序列化真实且有权读取的关联；没有真实来源的保留字段/分支删除，不制造 task 关系。 | 有关联可打开，无关联/不可见不泄露，prompt 信息来自实际执行版本。 |
| D67 Agent 模板来源 | 模板创建时存合法 `source_template_id` 和来源元信息，经协议返回；直接创建继续无模板来源。 | 模板创建显示真实来源，失效模板不伪装直接创建。 |
| D68 Memory 元数据 | `db/schema/memory.ts` 已有 `approvedBy/lastAccessedAt`，补 `memory/repository.ts::MEMORY_COLUMNS` 与 DTO。访问统计只写既有 read metric，不改 Memory 内容；不为自动写入伪造审批人。 | 真值正确返回，未审批合理为空；内容版本不因阅读改变。 |
| D69 默认 Space | 服务端按当前身份优先选个人 Space，复用现有 membership/bootstrap 数据；清理前端无效 `default_space_id` 分支，不建新偏好系统。 | 多 Space/退出共享 Space/刷新选择合法，不能选另一人的个人 Space。 |
| D80 Evolution 列表 | list/count 都筛 Evolution 类提案并应用相同 ACL。 | pending 数量与分页列表总量一致。 |
| D83 插件结果类型 | `server/src/modules/plugins/host/context.ts` 的记账 proposal result 不标为 knowledge_item；沿真实插件 result contract 返回明确类型或无对象结果，清理无生产消费的分支。 | 不产生虚假 Knowledge 链接/索引，真实提案结果可解析。 |

### 14.2 交互修复

| 问题 | 实施要求 | 验收 |
|---|---|---|
| D23 Provider 停用 | owner 的列表包含 disabled Provider，支持 re-enable；选择器仍过滤不可用项。 | 停用后可找回、启用，别人不能管理。 |
| D24 一次性链接 | clipboard 写入失败保留并显示已生成链接，提供手动复制；只有成功写入才显示“已复制”。reset link 只在授权页面短暂显示，不发日志/共享通知。 | 无 clipboard、权限拒绝、成功复制均正确，一次性链接不丢失。 |
| D25 registry Login | `HostExecutionTargetPicker` 跳转已有 Command Center 的主机安装/login 流程。 | 不再请求必然 422 的 Agent Login；登录目标与实际 host/installation 一致。 |
| D51 Time 占位 | 标明“计划中”，在 owning module 文档说明现状；不实现新 Time 子系统。 | 用户可识别未完成状态，文档引用有效。 |
| D63 Automation 标签 | 展示 information_digest、autonomous_tick 等真实 target 名称；移除/禁用不支持的 Project binding 编辑器。 | 不误标 agent run，不提交必然失败修改。 |
| D89 图边过滤 | 空集合表达无可见边，不 fallback 全部；沿现有状态模型修复。 | 隐藏最后一类边后图中零边，重新开启恢复对应边。 |
| D91 后端设置 | 移除 AgentGroups Run settings 的无效 per-Agent backend picker；保留 `ConversationExecutionPreflight` 真正生效的每参与者选择、现有 session controls。 | 选项只出现在真实生效处，不改 reusable Agent 默认配置或已有 pins。 |
| D92 Memory 分页 | 接入现有 pagination 模式和总量/游标，搜索/过滤变化重置分页。 | >50 行可浏览、无重复漏页、状态正确。 |
| D93 Source 加载错误 | 区分 loading、request failure、确认 404；失败给 retry，不显示假 not found。 | 首次网络失败可重试，真实 404 仍正确。 |

### 14.3 原报告无 D 编号的技术遗留

- **Workflow 多通道字段：** `sources/monitoringCoordinator.ts` 新建/更新记录完整 `workflowBindingIds/workflowRuleIds`，同步消费者。没有旧数据，不跑旧记录补写任务。
- **Usage 平均值与分页：** summary token 分子和 session 分母采用相同可见级别；summary API 补 `total`/分页语义，Group 行不截断。不得以较宽 summary access 泄露不可读 session 内容。
- **createTask 归档门：** 复用 Project/archive lifecycle 判定，在 canonical create path 阻止归档目标创建；直接 API、工具和批量入口一致。
- **probe_domain_budget：** 保持上限 3 与数据库约束一致，配置/协议/界面都不能写入 4–10。不要新增支持 10 的 migration 或旧数据修复。
- **retrievalEvalGroup 偶发失败：** 在现有测试支持下针对性复现、检查隔离与 dbGroup 相关证据；仅修可证实原因。没有复现和证据时记录未解决，不因推测声称已修复，也不无限重复全套测试。
- **continuity overflow、GitStatus、package_hash：** 分别在 P09、P09、P06 实施，不重复建立第二份任务或实现。

### 14.4 完整 i18n 范围

沿 `useAppTranslation`、现有 i18next/react-i18next 及 `Intl` 实现；优先复用已有 namespace/key，维护中英文 key、插值和复数一致。下列范围全部纳入，不只修改 medium 项。

| 范围 | 必须处理 |
|---|---|
| `conversation/ConversationExecutionPreflight.tsx` | 完整执行前配置文案、后端/主机选择、校验和错误。 |
| `conversation/ConversationInputComposer.tsx` | 标签、placeholder、aria-label、附件/输入错误及新增检索按钮。 |
| `evolution/AssetLifecyclePanel.tsx`、`EvolutionInboxPage.tsx` | 生命周期、评估、晋升、错误，接入 evolution 词典。 |
| `sessions/SessionsPage.tsx`、PublicationsPage | 页面文案、复数、日期。 |
| `apps/web/src/modules/plugins/PluginsPage.tsx`、`useEffectivePlugins` | 插件列表、启停/错误、日期。 |
| conversation 的 Surface、DiscussionGroup、Turn、RunControls、OpenDiscussionDialog、SessionConfig | 文案、复数、时间、配置状态与错误。 |
| `agents/ChatPanel.tsx` | 提示、错误、placeholder、确认框。 |
| project_files 的 ProjectFileEditor、ProjectFolderSettingsPage | 按钮、文件状态、单位、时间、能力错误。 |
| prompts/PromptLibraryPage、capabilities/CapabilitiesPage | 全页文案，含 duplicate proposal/hash mismatch 提示。 |
| activity 的 Queue、Detail、Inbox | 操作、状态、复数、指针通知和失败提醒。 |
| knowledge 的 notes-tree、KnowledgeOverviewPage、utils.ts | 菜单、概览、placement 约束提示、日期格式调用。 |
| network_profiles、job_queue/JobQueuePage | 全页文案、状态、错误和重试时间。 |
| core/ErrorBoundary、RequireRole、FocusAreasPage | 错误、权限和分类文案。 |
| components/ui 的 dialog/date-picker、graph、editor | 默认按钮/提示、状态、日期、无障碍标签；保留第三方 API/标识。 |
| `plugins/official/diary/web/src/DiaryPage.tsx` | 完整文案、日期，插件使用既有翻译接入机制。 |

额外要求：

- 日期/时间使用当前 UI locale 和明确业务时区；修改 locale 不改变 digest/capture 的所属日或存储数据。
- 不拼接英文复数；数量、单位、相对时间和绝对重试时间使用现有格式工具/Intl。
- React hook 只用于合法组件/hook 场景；公共 utils、异步 callback 通过现有 i18n 实例/传入 translator 访问，不新建第二个翻译状态。
- 用户文本、Source 原文、模型输出保持原文；安全错误 code 与协议 enum 不翻译，只翻译展示说明。
- 避免在共享基础组件硬塞业务内容；优先由调用者传入本地化 label，必要默认文案才由组件处理。

**验收：** 中英文关键页面、错误/空状态、按钮/aria-label、数量 0/1/多条、日期与时区、插件启用/关闭均检查。现有 key parity 检查通过不代表硬编码清理完成，需同时检查实际调用和界面。

## 15. Reuse / Dependency Check

本节记录本轮已核查的复用方向。项目的授权、受众、版本与记账语义仍由 Rainver owning modules 决定；外部依赖只承担通用机制。实现时按锁定版本验证 API，不因为链接指向最新版而直接升级。

| 能力 | 内部机制及实际缺口 | 外部方案/取舍 | 实施结论 |
|---|---|---|---|
| 文件安全打开 | `PathPolicy` 已管路径规则；`withCodePatchTarget` 已有 Linux fd 相对打开。Folder 读取仍按路径执行，其他平台未证明安全。 | [Node 24 fs](https://nodejs.org/docs/latest-v24.x/api/fs.html) 提供句柄操作，但只用末级 O_NOFOLLOW 不足以保护祖先；[openat2](https://man7.org/linux/man-pages/man2/openat2.2.html) 是 Linux 路径约束候选；[cap-std](https://github.com/sunfishcode/cap-std)、[Dir API](https://docs.rs/cap-std/latest/cap_std/fs/struct.Dir.html) 是 capability filesystem 候选，需 Rust/helper 或 binding，增加多平台构建成本。 | 先复用 Linux 实现并验证目标平台；外部候选未安装、未完成依赖准入。若内部方案不能覆盖支持平台，比较 binding/helper 成本后记录选择；不能以不安全 fallback 结案。 |
| Git transport | `outbound-guard` 与 host egress proxy 已有目的地规则；Git clone 接入、实际连接 IP 与 redirect 守卫有缺口。 | [Git 配置文档](https://git-scm.com/docs/git-config) 提供 proxy/redirect 控制；使用原生 Git，不换一套 Git parser/client。 | 扩展既有受保护传输，不自行编写 Git 协议或独立 HTTP retry client。协议不满足守卫条件时拒绝。 |
| 本地推理 | 现有 egress policy 把 Ollama 类型等同 local，需要部署/模型属性。 | [Ollama FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features) 与 [cloud 文档](https://docs.ollama.com/cloud) 说明本地服务也可使用云模型。 | 使用可信部署的 local-only 声明和模型信息；URL 不作为唯一证明，不添加 Provider 类型例外。 |
| 认证/续期 | Better Auth 已是认证/session writer；Rainver facade 丢失 refresh Cookie，reauth grant 缺服务端消费。 | [Better Auth session management](https://better-auth.com/docs/concepts/session-management)；使用仓库锁定版本支持的 response header 接口。 | 修 facade、扩展 Rainver recent-auth 业务 grant，禁止第二套 session/OAuth issuer。 |
| 日程/重试 | SchedulerRegistry、PgSchedulerTaskStore、JobHandlerRegistry、cron-parser 已存在。 | 已安装依赖及现有 queue retry；新增通用 cron/backoff engine 不减少维护。 | 在现有状态/触发机制里表达有限恢复与语义；预算和故障 episode 属于本产品。 |
| scoped 配置/上下文 | ScopedSettingsStore、WorkContextSetup、RuntimeContextGateway 已存在。 | 无需新全局偏好或 context 引擎。 | typed descriptor 与版本快照，统一前后端消费。 |
| Memory/proposal | canonical applier、proposal registry、revision editor、proposalReadSql 已存在。 | 不引入外部审批系统或直接 Memory writer。 | 扩展现有机制，补 provenance、权限和幂等。 |
| 账本格式/事务 | Beancount parser/engine、withLockedBook、attempt/savepoint、账户 API 已存在。 | 不重写 parser/decimal engine，不以导入执行结构指令。 | 新增领域级 entry 状态及 mapping，保持 canonical posting service。 |
| i18n/日期 | i18next/react-i18next、useAppTranslation、Intl、现有 timezone helpers。 | 不新增翻译/日期状态库或自建复数算法。 | 扩展现有词典、格式工具，保持业务时区独立。 |

若确需新运行时依赖，完成复用政策要求的维护、兼容性、许可证、安全、传递依赖和构建成本检查，并更新 canonical index 及必要的 `server/test/boundaries.test.ts` file-scoped allowlist。候选存在不等于通过准入。

## 16. 数据结构、协议和文档交付清单

### 16.1 需要核对的结构变化

下表是语义清单，不要求每项新建一张表。

| 工作包 | 需要表达/约束的状态 |
|---|---|
| P02 | recent-auth grant 的摘要、session/operation 绑定、expiry/consumption。 |
| P03/P05 | assistant 目标 scope；可信 root lineage/responsible user；execution initiator 与 approver 分离。优先复用已有身份和引用。 |
| P04 | provenance 注册、Memory 版本/grants 原子性；维护扫描 continuation/truncation。 |
| P06 | evaluation/promotion 内容 hash、活跃引用保护、package_hash、pending proposal 唯一身份。 |
| P07 | owner+scope URL unique；订阅与历史阅读资格/当前授权区分；阅读 origin/画像证据资格。 |
| P08 | report date/timezone/bounds/generated_at/backfilled 与 snapshot 幂等；annotation retry time、等待原因及累计预算。 |
| P09 | policy-blocked embedding generation；backfill reservation；输入资源 continuation；lease holder/fencing；attempt event 归属；研究原意图。 |
| P10 | published summary snapshot 与 draft 分离；笔记所属 placement 的事务不变量。 |
| P11 | import entry 稳定身份/状态/mapping version、draft 引用与唯一约束；reflection 唯一键。 |
| P12 | Inquiry subtype CHECK、Agent template 来源；其余多数是序列化/读模型修复，不能无依据添列。 |

- 先改 schema authoring，再按 COMMANDS 生成 migration；审查约束、nullable unique、FK、索引及 plugin ownership，执行 schema consistency check。
- 无旧数据，不添加 business-data UPDATE/清洗任务。测试中构造的故障/并发状态仍需覆盖，不能以没有旧数据为由跳过运行正确性。
- server、protocol、host daemon、web、official plugins 的 DTO 修改成组交付；新字段拒绝含糊的 `Record<string, unknown>` 替代类型契约。
- 删除已确认的死契约时全链删除；不保留 UI 分支等待永远不存在的响应。

### 16.2 文档随实现更新

各包完成后，仅更新实际受影响的 owning guides、API/usage、当前架构和必要 ADR/BOUNDARIES 引用：

- P01/P02：security、Source consent、hosts、project-files、auth、deployment/operations。
- P03/P05：agents、automations、capability、proposals、execution、system actions、Plan/Project Work。
- P04：Memory model/provenance/maintenance、content access、Activity。
- P06：prompts/evolution/capability、policy enforcement inventory、对应隐私/API 说明。
- P07/P08：Library、Sources、interest/digest、Today/Inbox、daily reports/annotation。
- P09：Runtime Context、retrieval、continuity、research、input resources、host wire。
- P10/P11：Project/Notes、公有摘要、finance import/account mapping、diary reflection。
- P12：具体前端模块、协议与语言使用说明。

当前架构文档不提前改成“已实施”；不要重写无关文档，也不要通过删掉安全边界消除测试冲突。原 R1 code_patch 修复、R2 Run summary、R8 并发 consolidation 不等于本计划的 D52、D7、D85，不重复宣称它们解决了新问题。

## 17. 验证计划与交付标准

### 17.1 每包的聚焦验证入口

下列是仓库现有测试入口及应扩展的行为；是实施时要执行的检查，不代表本轮已执行。按包从自己的工作目录运行，新增小测试优先加入既有 family/group，复用共享 fixtures。

| 工作包 | 现有聚焦测试入口/验证范围 |
|---|---|
| P01 | folder-read `test/read.test.ts`；host-daemon `test/folderRead.test.ts`、`test/egressProxy.test.ts`；server `test/codePatch.test.ts`、`test/retrievalEgress.test.ts`、`test/retrievalEgressDb.test.ts`，补受保护 clone 与 upload 竞态。 |
| P02 | server `test/authFoundationDb.test.ts`、`test/authRoutes.test.ts`、`test/authCookie.test.ts`、`test/googleReauth.test.ts`，以及受影响 status/error/deployer 入口。 |
| P03 | server `test/agentsCrudRoutes.test.ts`、`test/automationsProjectDb.test.ts`、`test/capabilitiesSkillOverlay.test.ts`、`test/capabilityProposalApplier.test.ts`、`test/proposalsRoutes.test.ts` 和 Activity owner 场景。 |
| P04 | server `test/memoryProposalIntegration.test.ts`、`test/memoryReadAuthMatrix.test.ts`、`test/memoryMaintenanceDb.test.ts`、`test/memoryMaintenanceArtifacts.test.ts`、`test/memoryMaintenanceJobs.test.ts`。 |
| P05 | server `test/projectWorkActionsDb.test.ts`、`test/projectWorkSettlementDb.test.ts`、`test/runtimeAuthority.test.ts` 及现有 Room/delegation/Run finalization family。 |
| P06 | server `test/evolutionRepository.test.ts`、`test/evolutionRoutes.test.ts`、`test/capabilitiesFramework.test.ts`、`test/capabilitiesSkillApprovalDb.test.ts`，受影响 prompt/ref/import tests。 |
| P07 | server `test/sourceConsent.test.ts`、`test/sourceRetrievalAccess.test.ts`、`test/sourceReaderRoutes.test.ts`、`test/informationDigestDb.test.ts` 及 Library/interest/Today 聚合。 |
| P08 | server `test/informationDigestDate.test.ts`、`test/informationDigestDb.test.ts`、`test/dailyReportsDb.test.ts`、`test/sourceAnnotationDb.test.ts`；补生成/故障提醒 UI。 |
| P09 | server `test/conversationInputResourceService.test.ts`、`test/runtimeContextPolicyDb.test.ts`、`test/sourceBackfillExecutionDb.test.ts`、`test/sourcePostProcessingRepository.test.ts` 及 continuity/research/retrieval family。 |
| P10 | server `test/noteCrossProjectShareDb.test.ts`、`test/knowledgeNotePlacementDb.test.ts`、`test/knowledgeNoteProjectBindingDb.test.ts`、`test/projectPublicSummaries.test.ts`。 |
| P11 | server `test/financeLedgerImportExport.test.ts`、`test/financeLedgerRoutes.test.ts`、`test/financeLedgerPluginSchema.test.ts`、`test/financeLedgerService.test.ts` 及 diary reflection DB 场景。 |
| P12 | protocol 对应 DTO tests；web `src/modules/conversation/ConversationExecutionPreflight.test.tsx`、`src/i18n/i18n.test.ts` 和相关页面；server `test/agentGuides.test.ts`、对应序列化/API tests。 |

必要命令模式（示例只执行本次实际影响的文件，不把整张表一次全跑）：

```bash
# cwd: server
pnpm run schema:generate -- --name <meaningful-change-name>
pnpm run schema:check
pnpm run typecheck
pnpm exec vitest run test/<affected-file>.test.ts
pnpm run build

# cwd: packages/protocol（契约变化时）
pnpm run typecheck
pnpm exec vitest run test/<affected-file>.test.ts

# cwd: packages/folder-read 或 packages/host-daemon（实际影响时）
pnpm run typecheck
pnpm exec vitest run test/<affected-file>.test.ts

# cwd: apps/web
pnpm exec vitest run src/<affected-file>.test.tsx
pnpm run build
```

- schema generate 只在真实结构变化时执行；插件按现有 schema runner，不把插件表搬到 server domain。
- 所有 durable 行为使用 `useTestDatabase` 的共享真实 PostgreSQL，不新启第二套 DB fixture、不用 fake DB fallback。不可用时记录 skipped，继续独立类型/协议/文档检查；严格验收使用 `REQUIRE_TEST_POSTGRES=true`。
- UI 增加行为验证及中英文视觉检查，不为纯文案编写复制实现的测试。没有 ESLint，不添加并宣称 lint 已通过。
- server 构建会构建 workspace deps/官方插件所需产物；依 COMMANDS 避免重复手工前置构建。契约变化仍运行 protocol 自身检查。
- 全套测试在获授权提交前或 CI 执行，不在每个局部编辑后重复；有新失败或实际影响才扩大范围。

### 17.2 最终跨包场景

1. 两个人加入共享 Space：个人助手、Automation、digest、Memory 和阅读状态独立；团队工作可见；Space admin 不能改创建者的助手。
2. Project owner/reader/admin 不同：创建、覆盖层、审批按实际对象与效果范围授权；审批不改变 Workflow credential principal。
3. manual 根运行继续研究/委派，与 scheduled 根继续回合分别验证 Memory/persona/credential gate；缺 lineage 收紧。
4. 退订后历史原文/Reader/Artifact/export 保持可读，自动画像停止；撤销来源授权后这些服务端入口均拒绝。
5. 日报告按配置时区汇总昨日完整日；调度延迟不换日；历史查询无写入；并发补生成不重复且候补池不变。
6. Provider 故障→倒计时→有限重试→恢复；禁止外发→等待条件；成功条目不重做，通知不泄露另一人数据。
7. 混合正确/错误/缺账户的账本：部分成功、映射补入、重复重试无重复；独立相同交易保留；账户生命周期未变且无法直接过账。
8. A 笔记共享到 B：A 内整理不影响 B，A 最后入口受保护，撤销 B 后 A 可找、B 不可读；并发/批量也成立。
9. 晋升 prompt/workflow：旧 pin 继续可运行；改 child 后旧评估不能批准新内容；Capability 包变化需要重新预览。
10. 文件竞态和网络目的地变更不越界；Run 终止/重试后的主机输出不能覆盖当前 attempt。
11. 租约崩溃/overflow/Run 结算重试均可恢复，无重复模型调用或 durable 副作用；后处理和 backfill 跨 worker 正确。
12. 中英文、数量、错误/空状态、无障碍标签和日记插件完整；语言切换不改变报告日期归属或访问权。

### 17.3 完成的判定

每个工作包交付：实现与协议消费者、必要 schema artifact、聚焦行为测试结果、受影响当前文档、未验证的平台/环境限制。仅修 helper 而未接通生产调用、仅隐藏按钮、仅通过 key parity 均不算完成。

全部工作包满足各自验收并通过跨包验证后，才将本计划标为已完成。技术验证失败单独保留，不能用“产品决定已确认”替代实现证据。

## 18. 明确不进入本轮实现的事项

保留原报告的范围控制，以下不因计划整理而获得实施授权：

- Provider preset 中途失败时三处设置的补偿（原 `012#3` B 部分）。
- 没有产品硬删除消息路径可触发的 blob 复用/清理竞态（原 `024#4`）。
- 超过 25 个永久阻塞 Space 才触发的 Source sweep 饥饿（原 `074#6`）。
- 约 508 个无人通过 index 使用的 re-export、约 250 个无法证明无用的候选、vendored AI Elements 的 59 个导出及未用 reasoning/task、components/ui 的 9 个导出。不顺手删除或改变公共 API。
- capture/routes 与 captureFiling/routes 两个未使用测试钩子，22 个当前无 ESLint 支持的 eslint-disable。不引入 ESLint 清理项目。
- 未调用的 `registerProjectSourceRoutingHook`：保持实际默认实现，只有某项已授权行为依赖它才核查接线；不新增 routing 功能或宣称应该自动接通。
- 通用 policy 引擎、私网 Git allowlist、Project user-private Memory、新助手接管/转移、强制重写所有 pin、导入开户/关户、导入直接过账。
- 所有旧业务数据扫描、修复/回填和数据库重置。

未来有实际产品触发或新证据时再讨论，不在此计划里制造额外确认项。

## 19. 执行记录

| 项目 | 当前状态 |
|---|---|
| 产品取舍 | 已确认，剩余需用户判断的事项为 0。 |
| 实施入口调查 | 已核查原报告及关键调用链；后续每组修改前仍需读取其最小 owning context。 |
| 外部方案 | 官方参考与候选已列于 §15；没有安装新依赖，跨平台候选未完成准入。 |
| P01–P12 / R10 | 均待实施，本文件不声称任何代码问题已修复。 |
| 本轮交付 | 仅改写本计划文档，保留全部原 D 编号、R10、无编号遗留、i18n 范围及不处理事项。 |
| 实现测试/CI | 本轮未执行；§17 为后续实施的验证要求。 |
