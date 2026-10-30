# 共用简报底座与项目闭环实施计划

日期：2026-10-30。
状态：
- 已提交：P1（c7db1db5）、P2（97e08875）、P3（379a98c1），各阶段均经独立双审及提交前完整套件；第一轮整体修复为 d3a308ca。
- 剩余验收代码已提交：1102eb0f（真实隔离 worker 恢复／停止 ACK、完整回复通道、持久 pending、预算展示、质量入口）；完整门槛发现的 Source 冷却时间漂移独立修复为 6ca515db。
- 本批代码复核通过：Codex 长回复／规模／临时失权恢复与时钟窄复核通过，Antigravity 预算 UI／质量入口复审通过。修后独占 Node 24 完整门槛：server 515 文件、5898 项通过，5 项条件跳过；Web 239 文件、2156 项通过；两套性能门槛均通过（§9.10）。
- 待授权与未验：真实模型综合质量／实际费用、真实 live Host 远端 smoke。worker 进程重启与停止 ACK 已由真实子进程、隔离 PG 和合成 Host 验证（§9.8）。
- 当前没有 token／金额硬上限；界面已显示实际次数、时长与输入限制，并明确费用未知。次数不等于金额。
- 本计划保留，尚未完成全部验收，不退役、不迁 backlog；§7 的综合、质量和完整执行验收未勾项继续保留。

## 1. 用户目标与交付顺序

收集材料后，系统应交付“发生了什么、相比之前变了什么、为何值得关注、
对我／项目有什么影响”的综合简报，而不是要求用户读完不断累积的文章。
共用底座在设计时覆盖个人与项目；当前实际测试以项目为主，因此先贯通
项目旅程。个人跨主题综合是明确的后续交付，不复制项目实现，也不先做
个人界面来阻塞项目测试。

复杂度为中等偏上：采集、运行、调度、阅读和逐条分析已有；新增难点集中在
跨材料综合、跨期判断、可撤销的派生内容和异步版本归属。不是一次 UI 改动，
也不需要重写 Agent 执行系统。本文不承诺未经试验的工期或模型质量。

## 2. 调查依据与仍未验证的部分

已完成 Claude（架构／权限／生命周期）、Antigravity（入口／产品旅程）独立调查，
并由主 Agent 核对代码；以下是代码现状，不是提议能力：

| 能力 | 已实现事实 | 改造边界 |
| --- | --- | --- |
| Following | [逐篇判断](../../server/src/modules/sources/goals/topicJudgment.ts)、材料成员和有据变化记录 | 不是跨材料综合；标题命中只可作为相关线索 |
| 每日 Digest | [个人／项目选稿](../../server/src/modules/informationDigest/service.ts)、时区、完整日、历史、写一次 | 不在现有事务里加入模型调用，不覆盖已封存日报 |
| Sources 后处理 | [单频道批次总结](../../server/src/modules/sources/postProcessing/service.ts)、结构化校验、Run／Artifact 引用 | monitored channel 限制 batch_digest；不能直接扩大该入口绕过确认合同 |
| Reading | [统一材料投影](../../server/src/modules/informationDigest/readingRepository.ts)、Following 成员、材料去重 | 输入复用可读性谓词；文章家族去重不等于事件聚合 |
| 项目选入个人阅读 | [本人偏好](../../server/src/modules/informationDigest/readingPreferences.ts) | 不能因有读取权限就静默纳入所有项目 |
| 运行基础设施 | Job、Run、Automation、预算与权限门禁 | 不新增独立调度器、凭证通道或恢复循环 |

个人当前每日候选取自订阅频道和成功 annotation，并非 Following／项目材料
的总集合。不能仅换页面标题就声称已有个人整体简报。

未验证：真实模型的事件归并准确率、影响分析价值、输入规模与成本、真实用户
阅读负担改善。代码调查和合成测试不能代替这几项。实现期用合成固定语料
完成自动验收；真实模型／实例操作按其单独授权和预算执行。

## 3. 共用底座：职责和输入边界

在 InformationDigest 领域内增加专用综合分析能力，不做通用 Agent 框架或新应用。
模块拆分围绕输入授权、分析编排、结果校验、结果读取，具体文件名随实现收敛。

```text
Sources / Following / Corpus / 已有分析
                   ↓
scope adapter：范围、受众、目标上下文
                   ↓
冻结输入清单 → 事件归并 → 跨期比较 → 重要性与影响 → 引用校验
                   ↓
             有版本的简报结果
                   ↓
       Project / Reading / Following 的同一展示组件
```

| 维度 | Project adapter：首批 | Personal adapter：随后 |
| --- | --- | --- |
| 范围 | 此项目的 Following、可交付监控结果、Corpus | 当前 Space 本人关注，以及明确选入个人阅读的可读项目 |
| 上下文 | 已授权项目目标、阶段、约束及有界相关任务 | 明确个人关注与可用的本人偏好；冷启动无画像也可用 |
| 受众 | 当前全部项目读者可共享的内容，不能仅凭发起人权限 | 本人私有；当前 Space 内，不自动跨 Space |
| 私人状态 | 不输入成员个人阅读记录（B56） | 仅本人状态；不借简报写回兴趣画像或 Memory |
| 分析 | 本项目内跨主题综合、机会、风险、待决问题 | 跨 Following／已选项目综合；同一事件合并不同关注视角 |

相同的是流程、结构化协议和执行机制，不要求硬编码相同模型。模型、Agent、
预算沿现有受控路由配置。实际 payload 必须包含 scope、space、授权主体和
受众，不接受只有 projectId 或只有提示词的“范围隔离”。

## 4. 首批必须确定的业务不变量

### 4.1 输入、证据和权限

- 生成请求固定截止时间、来源范围、上下文版本和输入清单 hash。
  清单保存材料／内容 revision、已有分析版本、goal／监控决定等引用，不另建正文库。
- 将获取与外发权限分开：可读不等于可发给任意模型。复用现有运行合同、
  Source consent、模型 egress 和凭证门禁；材料中的指令视为不可信内容。
- Project 使用完整当前受众的共享门禁；受控上下文检索也按该受众筛选，
  不能由任务执行者私有上下文污染项目影响分析。
- 输入冻结后、模型派发前、发布时和读取时均检查相应权限／版本。
  后台重试不能在来源变更或撤权后继续复用更强权限。
- 结果按可追溯洞察组织，每项声明引用其材料和上下文依赖；总览也必须有依赖。
  依赖撤销时隐藏整个受影响单元，而不是只隐藏链接；无法可靠拆分则隐藏整份结果。
  新增项目成员时同样重新检查。下载后的副本不承诺远程撤回。
- 个人结果不能直接复制到共享项目；跨范围追问或采纳时重新准备目标范围
  可见的内容，失败则不给动作，不以“清洗提示词”代替服务端授权。

### 4.2 综合结果与新变化

- 输出包括总览、有限条重点、事实／推断／待确认问题、影响理由、引用和覆盖情况。
  重要性必须结合目标、变化及证据；不能等同热度或标题命中。
- 同事件不同报道归为一项，保留矛盾；转载不是多份独立佐证。
  归并不确定时宁可分开并说明，禁止强行凑跨主题关联。
- 首次生成标为基线概览；后续与同范围上一份有效简报比较。
  新发现的旧材料、已有条目的新 revision、新的有据变化分别标记，不冒充新发布。
- 单纯“新增引用”不能证明新事件：事件内容没有实质增量时不重复提醒。
  上期失败／部分覆盖时，待处理项不得因截止时间推进而丢失。
- 重点条数限制的是首屏呈现，不是偷偷只分析三篇。记录候选、纳入、重复、
  未就绪、预算截断和失败范围；这些状态可能重叠，不能机械相加假称完整覆盖。
- 所谓“未发现重要变化”仅描述本次已覆盖范围，不声称全网或所有关注均无变化。
  分析失败、无可读材料、未生成、部分覆盖须分别说明。

### 4.3 运行、版本与恢复

- 使用现有 Job／Run／Automation。业务唯一约束与请求幂等键建立生成记录；
  handler 用状态／attempt CAS 认领。同请求双击、并发调度及重启不能重复生成或投递。
- 短事务准备清单和入队；事务外运行模型；短事务验证归属和提交。
  GET 不生成，不持有数据库锁等待模型。旧 attempt 晚回不得覆盖新结果。
- 生成记录需包含 scope、类型、截止时间、输入／上下文 hash、协议版本、Run 引用、
  生成状态和失败原因。输入引用和结果记录放在现有领域的专用表／关联中；
  不直接把可变简报塞进每日固定快照。最终约束和 migration 在实现时按 Drizzle 生成。
- 引用完整性、输出结构可自动验证；“引用存在”并不证明语义被来源支持。
  真实质量需要固定语料人工评价，不把 schema 校验写成事实核实。
- 启动前声明有界输入、token／成本、运行时间与重试次数；沿用实际执行预算归属，
  不把 Automation 次数当作 token 限额。配额和权限等待不无限自动重试。
- 复用现有停止／ACK、终态与恢复机制，不以超时伪称远程进程结束，
  不额外建立会重叠执行的后台循环。

## 5. 项目闭环：首个可用交付

用户旅程：项目关注 → 检查／收集 → 生成简报 → 阅读影响与证据 → 可继续调查。

1. 保留已有 Following“立即检查”，它只表示采集。项目简报增加明确的
   “生成简报”请求和独立进度；二者不共用一个模糊的刷新按钮。
2. 项目 Sources 中现有 Digest 位置呈现简报正文、覆盖和历史；阅读入口先露出
   最新简报预览，再进入证据列表，不新增顶层导航，不给每张文章卡叠长字段。
3. 每条重点回答：变化是什么、影响项目哪个目标／约束、为何重要、建议观察还是处理。
   上下文不足则写“尚不能判断”，不臆造项目进度或因果关系。
4. 点击证据进入现有 Reader；返回仍保留本期与位置。scope 切换／logout／晚回包
   不串入其他项目。项目读者可读；生成共享版本须项目写权限。
5. 首批保留建议文本，不自动建 Task、Memory 或 Knowledge。正式通知、带证据追问
   和明确采纳动作作为后续增强，不成为首批简报可用性的前置条件。

时间语义：
- 已完成日仍使用既有每日 Digest 日期／时区／写一次规则；简报独立关联该版本。
- 人工当期简报记录“截至几点”及输入集合，不能伪装为已完成日报。
  同一输入／上下文的重复请求返回已有工作；输入变化产生新版本，历史不覆盖。
- backfill 仅分析当前保留的材料，并保留已有监控历史顺序限制。
  定时运行复用既有 scope 调度，不额外每个关注新建一份同义定时器。
- 采集、逐条分析、综合、投递分别记录状态；不等待所有来源无限完成，允许有界部分交付。

## 6. 分阶段任务与退出条件

| 阶段 | 工作范围 | 完成条件 |
| --- | --- | --- |
| P0：本文 | 共用协议、职责、权限、版本、复用与验收计划 | 文档检查通过；未实现项保持未勾选 |
| P1a：底座 | 领域结果／输入引用、协议、scope adapter 接口、现有运行链集成 | 真实 PG 幂等／并发／恢复／权限用例；个人 scope 合成合同验证，绝非声称个人产品上线 |
| P1b：项目闭环 | 项目真实取材、目标上下文、综合、读取／手动生成／历史和 Web | 从合成收集结果到正文简报、引用 Reader、再生成变化版完整贯通；用户能开始项目测试 |
| P2：个人整体 | 个人选材与项目 opt-in、跨主题去重综合、Reading 默认消费入口 | 复用同一内核；多个 Following 同事件只出现一次；私人状态不进入共享输出 |
| P3：主动闭环 | 有意义变化提醒、同范围追问、明确采纳任务 | 去重通知、当前授权、明确用户动作及失败反馈；无自动批量任务 |

P1a 与 P1b 作为同一首批实施任务推进：不交付一个只有表和接口、用户仍看不到
简报的“已完成底座”。P2 不重写主流程；若必须复制流程，说明 P1 的抽象边界需要修正。

## 7. 验收与进度

- [x] 共用：同一固定材料经过两个 scope adapter，主流程相同、权限与影响不同。（P1 证据：`informationBriefingDb` 同一 manifest 内核、两种 audience/lens/context；个人真实选材仍属 P2）
- [ ] 综合：多篇同事件、矛盾来源、无关文章形成有据重点，而不是逐篇摘要拼接。
- [x] 变化：基线不冒充新闻；重复／无增量不再推；新 revision 有变化；迟到分析不丢。（结构层已测：基线；无变化复用同一检查、不建 Run；正文／分析原地改写→`revised`；new_publication/newly_found；迟到分析与不可共享项跨多次检查顺延；上期重点＋材料作对照背景，背景只能 `ongoing`。真实模型是否正确判同事件未测，见“质量”）
- [x] 项目：影响引用真实合成项目目标／约束；上下文缺失时明确不足。（合成项目目标 C1 进入 prompt 与投影；`affects` 无上下文被拒；UI 明示上下文不足；真实模型质量未验）
- [x] 授权：来源撤权、成员新增、上下文变私有后，相关总览／重点均不可泄露。（已测：家族每个成员／注解／信号各自出网门禁与依赖；次要来源撤权或归档→dispatch 拒绝、读时 withheld；Task 移出项目并私有→dispatch 拒绝、发布拒绝、读时隐藏；无权新成员 withheld；简报 Run 关闭自动检索与 pin，合成私有 Memory 不进入真实规划上下文）
- [ ] 执行：双击、并发生成、worker 重启、取消及旧 attempt 晚回各自收敛；有限预算可见。
  - 已测：重复／串行／并发复用；双向锁交错只认当前 attempt；生产 `executeRun` 守卫拒绝→Run failed（非 waiting_for_review）→简报 failed→释放名额；整请求 48k 字符硬上限。
  - 真实 worker 进程（`informationBriefingWorkerProcessDb`）：服务器自身的 `startJobsWorker` 跑在独立子进程中，连接隔离 PG 与合成 Host（daemon 线协议＋最小 ACP 代理，不调用模型），已验证：
    - 端到端发布；
    - 运行中 SIGKILL 后重启：回收任务、强制停止旧 launch、经 Host 确认后 orphaned→版本 failed、重试发布，旧 attempt 晚到的 complete 不改变结果；
    - 领取后崩溃：job 耗尽→Run `run_abandoned`→恢复流程最终化→版本 failed、可重试；
    - 停止 ACK 丢失：保持 cancelling，重启后重发并确认→cancelled；
    - 停止 ACK 迟到→cancelled，之后的输出不发布；
    - Host 断线后在宽限期内重连：一次发布。
  - 修复两处真实缺陷：CLI 完整回复经合同声明的结构化通道保留，summary 只作回退；job 结束的 Run 由恢复流程最终化。
  - 未测：真实 live Host／远端 daemon smoke。
  - 有限预算可见：已实现。生成前在共享面板显示服务器实际执行的限制（overview DTO `limits`，取自 `BRIEFING_LIMITS` 与本 scope 近 24 小时实际 Run 数），并明确运行中没有 token／金额上限、费用取决于运行时。token／金额上限本身仍不存在，见 §9.8。
- [x] 状态：采集完成但综合失败、部分覆盖、无材料与无重要变化有不同反馈。（服务端状态/outcome/coverage + Web 单测）
- [x] 页面：390／1280px 可读，引用可回看；无额外材料卡字段；切篇／切 scope 不串回包。（`project-briefing.browser.mjs` 真 Chromium，路由 mock 合成数据；`ProjectBriefingPanel.test.tsx` scope/卸载/登出守卫）
- [x] 历史：原 Digest 快照不改；人工当前版本与封存日、backfill 区分。（每日经现有 Automation、重放复用、blocked 日、日期顺序 422）
- [x] 个人：P2 检验真实选材而非仅通过 schema；多个来源／项目视角可整体归纳。（P2 已提交并通过阶段双审（97e08875），已测：真实 PG 正反选材——本人 Following、订阅已有分析、opt-in 可读项目，排除他人话题、未选项目、他 Space；同一 capture 多视角合并，不同 URL 同事件可由单个重点归并（结构可表达，非真实模型判对）；opt-out／撤权／删项目后在派发、发布、读取及跨代对照中撤回；delta／no-new／迟到分析；与项目隔离；个人每日 Automation 碰撞保留与恢复；Chromium 390／1280。模型能否正确归纳多视角属“质量”项，仍未勾）
- [ ] 质量：受控真实模型运行另记授权、成本、引用支持情况和误归并，不用 mock 通过冒充。

实现时按 [TESTING_STRATEGY](../architecture/TESTING_STRATEGY.md) 使用 familygroup、
真实隔离 PostgreSQL 和 Chromium；遵循 [COMMANDS](../COMMANDS.md)。文档阶段仅跑
guide／链接检查。每批提交前运行必要的完整套件；不反复执行无关全量。
实现与权限／并发审查、产品验收分开记录。未经实际完成不勾选，不迁 backlog 代替交付。
计划退役须完成已承诺范围，或用户明确调整范围，并将已实现合同归入 owning guides。

## 8. Reuse / Dependency Check

- Existing repository capability found? Sources 可读性、材料家族、逐条分析／后处理执行与校验；
  InformationDigest 历史／scope；Reading 项目偏好；Run／Job／Automation／受控 retrieval。
- Existing installed dependency found? Drizzle、Zod、pg、既有模型／CLI adapter；不需新增依赖。
- Mature external option evaluated? Feedly／Inoreader 的跨篇报告、Omi 日总结和 RSSBrew 分层流水线
  作为已完成产品调研；它们不接管 Rainver 权限和运行合同。初版事件归并沿已有模型，
  不引入向量数据库／新闻引擎；若质量试验要求专用聚类，另作实际库评估。
- Chosen approach: extend existing domain and reuse execution infrastructure。
- Why: 核心新增是 scope、派生内容授权、版本和产品交付语义；复制外部应用或新调度器
  会绕过现有治理。不是把单频道 batch_digest 改名后扩权。

## 9. P1 实施设计（锁定于 2026-10-30，以代码为准）

- 领域：`server/src/modules/informationDigest/briefing/`。内核（清单、跨期分类、
  提示、结果校验、读取重授权）与 scope adapter 分开；adapter 只声明主体、受众、
  取材与上下文。Project adapter 首批上线；Personal adapter 只做本人 Following 取材
  与合同测试，P2 再接真实个人选材与界面。
- 存储：`information_briefings`（一份生成记录 = 一个版本）与
  `information_briefing_inputs`（冻结的材料／上下文引用，不存正文）。迁移 0007。
- 唯一性：同 scope 同时最多一份进行中；`request_key` = scope + 类型 + 输入 hash +
  上下文 hash + 协议版本 + 执行选择，相同即复用；`daily` 以 scope + 日期唯一。
- 运行：短事务冻结清单 + `createQueuedRunWithBudgetAdmission` + `agent_run` 入队；
  派发前守卫重验权限／egress／归属；终态由 settlement reconciler
  `information_briefing` 投影，按 `run_id` + attempt 判定归属，旧 attempt 晚回忽略。
  不新建后台循环。
- 输出：Run 最终文本中的 `information_briefing.v1` JSON，服务端校验引用、
  事实需材料引用、影响需上下文引用、新颖性需对应跨期类别；不合格即失败，不冒称核实。
- 读取：每次按当前完整项目受众重验每个引用；依赖撤销的单元整项隐藏，
  总览依赖撤销则整份隐藏。
- 预算：输入条数／摘录长度上限、`max_duration_seconds`、`max_attempts=1`、
  每记录重试上限、每 scope 每日生成上限；定时运行另受 Automation 预算。
  无运行中 token 硬上限，如实记为限制。

### 9.1 首轮双审修复（R1–R10，2026-10-30，以代码为准）

- 依赖（R1/R2）：冻结每个贡献项的依赖（家族成员条目、注解、范围信号各带 revision 与
  Source 连接）；被拒出网的成员／注解／信号整体不贡献文本。`authorization.ts`
  是 dispatch、发布与读取共用的唯一授权规则；冻结上下文（简报版本、Task）在三处同样重验。
- 失败归属（R3）：`information_briefing` 托管策略对 manual 与 job 均 fail-fast，
  仅 job 带凭证预授权；守卫拒绝以 `RunPreparationError` 携带简报错误码，终态经
  Supervisor→settlement 落为 failed 并释放进行中名额。
- 环境上下文（R4）：每个简报 Run 自带 Work Context（scope = Run），关闭自动检索、无 pin；
  被改开即 `briefing_context_widened` 拒绝派发。不改全站默认。
- 版本（R5/R6）：比较链只经过已发布版本；`request_key` 取实质状态，无变化的检查复用
  （仅更新 `checked_at`）；`request_hash` 固定确切请求，重试只重发经 hash 校验的原请求；
  内容／分析变化即新版本，封存日失败版本保留为历史，日唯一只约束 live 版本。
- 发现与背景（R7/R8/R9）：窗口包含正文／分析变化；不可共享项记录并顺延；上期仍可读的
  重点及其材料作为 `background`（重新门禁）参与对照或在上下文变化时重估影响；不重放总览散文。
- 预算（R10）：在清单阶段对 prompt+instruction 整体渲染、三级降级、截断并顺延，
  创建 Run 前断言 ≤ 48,000 字符。
- 迁移：仅重新生成未发布的 0007（新增 `request_hash`、`checked_at`，
  输入状态 `not_shared`、delta `background`，日唯一索引限 live 状态）。

### 9.2 增量复审修复（F1–F3，2026-10-30，以代码为准）

- F1 跨期依赖闭包：对照文本冻结到 `comparison_json`，并带完整闭包（引用 S 的全部依赖、引用 C 的
  上下文来源、上一版继承的闭包，跨代传递）。闭包中任一项失效，整个版本即不成立：派发拒绝、
  发布失败、读取隐藏。仍共享的已完成 Task 可以正常作为对照。
- F2 采集来源读门禁：注解及各类范围信号（Following／监测 decision／Corpus）的采集 Source，
  在准备阶段和统一授权中，均按全体当前受众走规范读门禁（不走 oversight，不以外发许可替代）。
  另修复 `everyReader` 的 NULL 语义漏洞：成员条件为 NULL 时按不可读处理。
- F3 封存日保留：与进行中版本或更早保留日冲突时，记录 blocked 保留日，附原因、日期、截止时间
  与延迟请求，不把手动版本当作当日结果。之后按日期顺序启动：本 scope 版本结算后
  （`resumeHeldDays`）、下一次每日触发、或显式按日期重试。保留日只与更晚的封存日比较顺序；
  未保留的回补仍受完整顺序限制。仍保持每个 scope 只有一个 Run。
- 迁移：重新生成未发布的 0007，新增 `comparison_json`、`request_json`。

### 9.5 P3 通知、追问、采纳（2026-10-30，以代码为准）

- 通知：在发布当前 attempt 的结算事务内判断。仅当 delta 中有受众当前可读、经校验为 new／update 的重点时，
  才对每位当前受众写入一条私有 Inbox 指针（`OperationalAlertService`，kind `briefing_changes`）。
  每个 scope 每人最多一条，后续变化更新同一条。标题为通用文字，行上不带 Project，
  内容不写正文、标签或项目名，打开时由简报页重新授权。baseline、no-new、仅 ongoing、失败、
  迟到 attempt 与重放都不通知。
- 追问：先只读准备预览，再沿现有 Thread Reference 的 hold → 草稿 → 显式发送 → attach 路径，
  新增 `briefing_highlight` grain。attach 时重新授权：整版闭包与重点依赖、房间 Agent 各运行时的出网许可；
  项目重点只进同项目 Room，个人重点只进仅本人可读的 Room；不可披露，确认也不能扩大受众。
- 采纳：先预览，再确认；经规范 `createTask` 写入并产生 `task.created` 事件，校验写权限并锁定项目。
  确认绑定预览 hash，期间变化返回 409，撤权返回 403。按（简报, 重点）幂等。项目重点生成共享任务，
  个人重点只生成本人私有任务。不写 Memory／Knowledge。
- Reuse Check：复用 Activity Inbox 指针（B24A）、Thread References 及其 composer hold／draft、
  规范 Task writer 与 ProjectWork 事件、内核 `authorizeVersion`。未新建通知系统、调度或依赖，没有迁移。
- 复审修复 1（F1–F5）：
  - 采纳先校验 scope 与写权，再按 key 查已有 Task；只经规范 Task 读门禁（`findReadableTask`）返回或预告。
    读不到的已有 Task 返回 409，不重复创建。
  - 出网分两道：attach 时，Agent 有效但没有启用 Profile 即拒绝；每次 Delivery 时，planner 与 gateway
    再按 Run 实际执行的 Agent／Profile，走唯一 Source 出网门禁复验（`referenceDelivery.ts`）。
  - 新 vendor 会话的首轮把附加的重点作为独立的不可信 reference 项送达；续聊仍在 Room 增量中送达。
  - Web 动作按（scope, briefing, 稳定 index）归属，忙碌状态归属于发起它的请求。
  - copy-once 合同来自 protocol `threadReferences` 与 rooms 指南，不是 ADR 0018。
  - P3 此后通过阶段双审，已提交（379a98c1）。
- 复审修复 2（R1、R2 与类型）：
  - 引用的出网判定改用 Delivery 自己授权的目标：由 Run 持久化的 adapter／ModelProvider 推出，
    经 `runDestination.ts` 与 gateway `authorizeEgress` 共用同一分类。
    不再按可编辑的 live Profile 判定；Source 同意仍走唯一门禁。
  - Delivery 事务先以 `FOR SHARE` 依序锁定：引用消息 → 简报行 → 闭包内的 Source item
    （含其连接与附加者订阅）→ 其余连接；锁后重验，持有到提交。撤权要么先提交、交付被拒，
    要么等待交付提交。
- 复审修复 3（R2 完整闭包）：
  - Delivery 锁住完整授权闭包，依序为：简报行 → 受众 → 上下文根 → 范围信号 → 授权与订阅 → Source。
    - 受众：项目简报锁项目行、成员、用户与 Space 成员；个人简报锁本人 Reading opt-in 的共享 advisory 锁，以及所选项目的受众。
    - 上下文根：Task 与个人 Goal。
  - 项目成员写者 `addMember`／`removeMember` 在同一事务内先取 `lockProjectAudienceForChange`，
    与 Delivery 的项目共享锁互斥，新成员不能绕过。
  - 个人 Goal 删除与 `addMember` 两类写者均已有真实 PG 双向测试。
  - 修正已提交 P1/P2 测试的 4 处类型错误，不改产品行为。
- 未验：真实模型质量、真实 Room 中 Agent 对 reference 的回答、worker 重启。

### 9.4 P2 个人整体（2026-10-30，以代码为准）

- 个人 adapter 真实取材：本人 Following；订阅频道送达的条目（`subscription` lens，有已有分析才算 ready）；
  明确 opt-in 个人阅读（`ReadingPreferences`）且当前可读的项目的 Following、可交付监测、Corpus，
  lens 标注项目名。仅本人受众、当前 Space；不读其他成员状态；上下文只用本人 Following 主题
  （`personal_focus`），冷启动可用，不读写 Memory／兴趣画像。
- 撤回：`signalState` 只在项目仍 opt-in 且可读时承认项目来源信号。opt-out、撤权、删除后，
  经内核唯一授权规则在派发、发布、读取及跨代对照中撤回。
- 复用：manifest／request／Run／settlement／历史／每日／预算／授权／结果校验／BriefingView 不复制。
  routes、每日设置与 Automation 钩子按 scope 泛化；面板按用途抽出 `BriefingPanel`，
  项目与个人各自只绑定 API 与 Reader 返回路径。
- Reuse Check：沿用 Reading 偏好、订阅、Following 与项目可读性的现有谓词，以及个人每日 Digest Automation；
  不新建订阅开关、调度器或依赖；没有新增迁移。
- 当轮未做（P3 后续见 §9.5）：真实模型质量与真实实例仍未验证。

### 9.3 最终窄修（2026-10-30，以代码为准）

- 历史顺序先于保留：新建保留日（包括繁忙冲突与阻断拒绝两条路径）前，先做与空闲时相同的历史检查，
  只排除当前进行中的版本（它只是临时等待）。过期 backfill 无论空闲还是繁忙都返回 422，
  不留下可恢复的旧日。只有记录时合法的保留日，才享有此后不被手动发布阻断的豁免。
- 面板：对 queued 及可恢复保留状态（scope_busy、earlier_day_pending）做有界只读轮询，
  覆盖最新、已选和历史中的版本；每 4 秒一次，不重入，每次挂载最多 30 分钟。需人处理的拒绝不轮询。
  所有人可见只读刷新；有版本进行中时 Generate 不可用。

### 9.6 整体审修复（O1、O2；d3a308ca，复核通过）

- **O1 生成链路的出网目标。**
  - 简报生成 Run 一旦绑定 adapter（`runtime_key`，调用 ModelProvider 时含 provider），dispatch guard
    （`assertBriefingDispatch`）就按该固定绑定判定 Source 出网，经 `runtimeContext/runDestination.ts`
    使用与 Delivery egress authority 相同的分类，不再采用可编辑的 live Profile。
    仅在尚未绑定时，校验候选 Profile。
  - 该 Run 请求的 Delivery 也重验：gateway 先锁住版本完整闭包，再以自身授权的
    `egress.destination` 走同一规则（`assertBriefingVersionDispatchable`）。
  - 请求 hash、attempt、scope、closed Work Context、revision 等守卫不变。
- **O2 无发布正文时的 pending 顺延。**
  - 比较只走已发布正文链。待处理材料另由 `pendingSince` 收集：取比较基准之后（无基准则全部）、
    当前截止时间之前同一 scope 的版本中最新状态仍为 pending 的条目，经 scope 自身门禁重新授权。
  - 上限 200；超出部分计入 coverage `truncated`，`complete=false`，并保持 pending。
  - 只按已结算（ready）版本中的最新状态判断。尝试收录（included）后失败、取消或仍在运行，
    均不算已处理：材料保持 pending，同一请求走该版本的冻结重试，最多 3 次，之后明确返回
    `briefing_attempts_exhausted`。只有发布正文后（该版本成为比较基准），材料才离开顺延。
  - 重复检查仍幂等；不改已封存日／backfill。
- 真实模型质量、worker 重启、远端 ACK 仍未验；当前没有 token／金额硬上限，不能以次数限制冒充金额限制。
  已进入 vendor 会话的上下文无法远程撤回。

### 9.7 第一轮整体修复验证记录（d3a308ca，历史证据）

- Claude 实施，Codex／Antigravity 各阶段独立审核后提交；整体审发现的问题继续由 Claude 修复，Codex 最终窄复核 19/19 通过。无 UI 增量，保留 Antigravity 整体 UX PASS。
- 修后主 Agent 独占运行 `REQUIRE_TEST_POSTGRES=true vitest run --maxWorkers=4`（server，Node 24），exit 0，76.63 秒；512 文件通过、1 文件条件跳过，5873 项通过、5 项条件跳过。日志 `/tmp/shared-briefing-overall-server-final.log`。
- Web 完整结果复用 `/tmp/shared-briefing-P3-web-full.log`，239 文件／2156 项通过；本次整体修复未改 Web 或 protocol。两套完整性能门槛均通过。
- 实际生产代码链验证止于合成材料的 accepted Delivery 准备，未实际发送供应商；没有操作运行实例、调用真实模型、push 或部署。真实模型综合／引用支持／价值、worker 重启、远端 ACK、200 条 carry 的真实规模均未验；已经进入 vendor 会话的内容不能远程撤回。

### 9.8 剩余验收推进（2026-10-30，1102eb0f）

- 进程级恢复与停止 ACK：见 §7「执行」。工作进程运行构建后的 `dist`（与 `node dist/index.js` 同一产物），
  `buildServer` 注册全部模块；未启动调度器的其他任务。租约过期以回拨持久化心跳表示（等价于 600 s 回收阈值）。
- 规模：205 条待处理项真实 PG：携带 200 条（上限），其余 5 条保持 pending，下次发布后继续携带；
  已退出 scope 的项不再携带；发送 40 条；prompt ≤ 48k；已简报材料只作为背景返回。
- 预算（审计结果，未新增上限）：
  - 已强制：每 scope 每日 6 个 Run（含重试）；每版本 3 次尝试；Run `max_attempts=1`、`max_duration_seconds=900`
    （服务端计时，超时即终止）；输入 40 条新闻＋12 个背景家族、携带 200 条、整请求 48k 字符；
    定时运行另受 Automation 预算来源的 `max_runs` 约束。
  - 不存在：运行中的 token／金额硬上限。规范 `max_cost` 仅由 Supervisor 在安排重试前按估算用量检查，
    而简报 Run 为 fail-fast、不重试，因此对简报不起作用。ACP 的 `session/prompt` 没有 token 上限参数，
    原生 CLI 的用量由其运行时自行控制；`effectiveMaxOutputTokens` 只作用于服务端直接调用 provider，
    不适用于简报的 Agent 运行时。
  - 最小可审方案（待用户确定金额，未实施）：准入时按规范用量账本，汇总该 scope 近 24 小时简报 Run 的
    `estimated_cost_usd`，超过用户设定的上限即拒绝新 Run。这是事后估算的准入门，不是运行中硬上限，
    也不能把次数当作金额。
- Reuse Check：
  - 复用服务器自身的 `buildServer`、`startJobsWorker`、`sharedHostConnectionRegistry`，以及既有的 daemon 线协议与 ACP 帧（同 `remoteHostCliAdapter` 测试）。
  - 复用规范的回收、恢复、最终化流程。
  - 未新增依赖（`tsx` 只是传递依赖，因此运行 `tsc` 构建后的 `dist`）、调度循环或计费框架。
- 质量：固定合成语料（`test/support/briefingQualityCorpus.ts`）与评估入口
  （`informationBriefingQualityHarnessDb`）。用例：同一事件不同 URL、矛盾报道、无关材料、项目目标影响、
  上期重复与真实增量、个人跨主题 lens。
  - 走真实 request／manifest／prompt；写出请求、引用对照、期望与人工量表。
  - 提供已授权的真实模型回复后，再走真实 parse／validate／settle 并记录合同结果。
  - 尚无真实模型运行（等待授权），质量项不勾选；结构占位回复不能作为质量证据。

### 9.9 剩余验收修复（R1、R2、F1、预算可见性、个人质量入口；1102eb0f，复核通过）

- R1 长回复：`canonicalRunOutput` 按 Run 合同声明的 `structured_output_json.schema`，把回复中的
  `information_briefing.v1` 对象（整段 JSON 或最后一个 fenced 块，上限 262,144 字符）保存为
  `result.structured_output`。终态写入的 sanitize 只限制其中每个字符串，因此合法长回复完整保留。
  settlement 依次读取 `output_text` → `structured_output` → 结构化 `result` → summary；
  被截断的 summary 记为 `briefing_output_truncated`。evidence redaction 与 32k 上限不变。
  - 已测：真实 worker 进程 41k 合法回复发布；同样长但引用不存在的回复→`briefing_output_invalid`；
    长纯文本→`briefing_output_truncated`；prose summary 加结构化 result 的回复可以发布。
- R2 持久 pending：按 scope 内已结算版本中每项的最新状态判断，不再以发布截止时间抹除；
  按最旧优先每版顺延 200 条，未处理完的轮转到队尾。
  缺席不等于退出：候选已按完整受众读权过滤，因此未返回的顺延项由 `adapter.scopeMembers`
  （仅 id，同一信号查询关闭读门禁）判断。
  - 仍属 scope、当前不可共享（Source 或条目暂不可读、失去已 opt-in 项目的读权）→ `not_shared`，保持 pending，
    不读不发，`complete=false`，再次顺延时重新授权。
  - 能证实已退出（Goal 删除或不再选入、Corpus 归档或排除、opt-out、退订、条目或 Source 删除）→ 永久 withdrawn。
  移除 `maxCarryRecorded`。已测：1205 条经两次发布无一丢失；Source 临时私有→恢复后交付；
  暂拒项不占住顺延额度；真正退出不再携带；个人失去项目读权保持 pending、opt-out 才退出。
- 预算可见性：见 §7「执行」。
- 质量入口：personal 与 baseline／delta 共用 settle-and-record，写入真实 contract.json；
  每次重写请求时先删除本 case 旧的 contract.json；合成的合法／非法回复仅作接线验证，不能作为质量结论。

### 9.10 本批完整门槛与仍待验收项

- 复核：Codex F1 最终窄核 16/16、Source 时钟窄核 10/10；Antigravity 预算 UI／个人质量入口复审通过。前序长回复、1205 条跨发布及真实 worker 进程验证的证据范围保留。
- server：Node 24，`REQUIRE_TEST_POSTGRES=true vitest run --maxWorkers=4`，真实隔离 PG，exit 0，90.55 秒；515 文件通过、1 文件条件跳过，5898 项通过、5 项条件跳过。日志 `/tmp/shared-briefing-remaining-server-final.log`。
- Web：同一 Node 版本独占 `vitest run`，exit 0，30.03 秒；239 文件、2156 项通过。日志 `/tmp/shared-briefing-remaining-web-full.log`。两套完整性能门槛均通过，未并发运行。
- 首次 server full 的 HTTP-date 冷却时间提前 1 ms 失败保留在 `/tmp/shared-briefing-remaining-server-full.log`，没有改写为通过。6ca515db 改为取锁后单次物化 DB 时钟、按时间戳钳制；日期精度、各组共享基准、1s–24h／默认 60s 及不缩短由真实 PG 验证。原日期精确断言未放宽。
- protocol 315 项、含 tests 的 server 类型检查、Web 类型检查／构建及两条 Chromium 合成旅程均已通过，见本批实现／修复报告。schema 与迁移 0000–0007 未改动。
- 综合／质量入口已能导出固定合成语料请求、引用对照及人工量表，导入 baseline／delta／personal 回复后记录实际合同结算；未提供真实模型回复时仍为 NOT EVALUATED，placeholder 和合成接线验证不得评分为真实质量通过。
- 尚需明确授权的真实模型调用配置与费用上限、真实远端 Host 验收目标；此前禁止操作真实模型／运行实例的约束未因开发 Agent 重新登录而解除。没有操作实例 DB、读取私文或凭证、调用真实模型、push 或部署。任务及计划保留未完验收项。
- 真实 token／金额硬上限当前不存在；已进入 vendor 会话的内容不可远程撤回。

## 10. 实现前置约束与需试验参数

无需继续宽泛调研即可开始 P1；实现开工前锁定具体 schema／路由和运行合同：
业务唯一键、manifest 内容可复现方式、真实模型预算归属、输出依赖粒度及恢复接线。
这是实现设计检查，不要求用户逐项填写技术参数，也不自行修改运行实例配置。

候选上限、基线窗口、重点条数、成本上限和重试阈值是有界配置；先用固定语料
测覆盖与成本再定默认值，不把 Agent 建议的“7 天／3 次”等当既成规格。
跨 Space 个人总览、自动任务写入、独立事件知识图谱不在本计划首批。

相关约束：[BOUNDARIES](../BOUNDARIES.md)、
[Information Digest](../modules/information-digest.md)、[Library](../modules/library.md)、
[Source Goals](../architecture/SOURCE_GOALS.md)、
[DATABASE_AND_TRANSACTIONS](../architecture/DATABASE_AND_TRANSACTIONS.md)。
