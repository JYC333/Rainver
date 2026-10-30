# Reading 阅读方法改进 MVP

日期：2026-10-30。
状态：A+B 代码实施、Claude 技术与 Antigravity 产品独立复审及 primary 修后完整套件均通过；开发基线 52f0a456；用户现已授权本批本地提交，未部署。真实模型质量、实际费用及真实运行验收仍未完成；本文保留未验项，尚未退役。

## 1. 目标与首版范围

从 Reading 中一条过浅结果出发，完成「指出问题 → 修改阅读方法 → 有界试跑 → 新旧对比 → 人确认启用 → 新运行实际生效 → 可回滚」。

首个场景是项目相关功能调查：围绕项目目标，从产品／仓库主页找到具体功能线索，阅读对应文档和示例，解释机制、适配价值、代价与未知。主页介绍不能冒充完成调查。

只做一条可用的阅读方法链，复用现有提示词板块；不新增顶级导航、不重写通用演进系统、不做自动无限优化、不把所有提示词一次迁移。原演进／提示词高级能力仍可访问。

Reading 的入口是上下文入口；完整编辑、试跑、对比、申请启用及历史在现有 `/prompts` 内完成。新入口的可见性遵从真实维护权限，普通反馈不授予修改／启用权。

## 2. 已核实现状与缺口

- `prompts` 已有版本、渲染、作用域解析、手动评估记录、启用提案和回滚；生产解析只接受批准版本。
- `evolution` 已有资产版本、评估样例和提案应用。现有评估入口不是一次点击即可对任意提示词执行新旧试跑，不能只登记 passed 当作实际评估。
- 提示词页目前以资产列表、多个详情标签、原始标识及手工指标 JSON 为主；演进页还呈现目标／信号／策略等结构，缺少简单的下一步引导。
- `sources/goals/nativeSearch.ts` 和 `sources/materialProcessing/items.ts` 在代码中拼接用途／能力／相关性说明；未接入可演进的阅读方法。单篇重读只要求主资源及最多两页相关文档。
- 中立注解只做有限摘要／分类；它是多读者共享数据，不应承载某个项目的私人目标。
- `informationDigest/briefing` 仅综合冻结输入，摘要和片段有严格长度限制；禁止浏览与隐式检索。该闭包与权限合同不能因为本计划而取消。
- 既有日期切换修复为独立已验证变更，先提交；其任务已完成。旧共用简报计划的真实模型与 live Host 验收仍待授权，不因本计划启动而完成。

## 3. 页面与用户路径

页眉示意（文案按实际产品语言收敛）：

```text
← 阅读方法
项目相关功能调查                           [修改方法]
用于：当前项目 · 当前生效 v3
上次试跑：待人工确认

当前方法       试跑对比       历史
```

- 只有一个当前主动作：无草稿时「修改方法」，有草稿时「试跑对比」，有结果时「申请启用」。运行中可取消并查看进度；必要重试和回滚为明确次级操作。
- 生效范围与实际生效版本由服务端解析，不用“最新版本”代替。未接入／未启用／未知旧版本须如实标记。
- Reading／Reader 结果旁的「改进此结果」带入可核验的材料、所属项目和产生它的运行／版本；旧结果无归属时说明未知，不按标题或时间猜测。链接本身不是读权或写权。
- 修改从生效版本复制草稿，填写本次问题／改进说明，直接编辑可读方法；原始模板／变量／解析轨迹等折叠在高级信息。首版不强制额外模型生成草稿。
- 试跑前明确样例、执行 Agent／运行时、输入范围与已有运行限制，用户点击才启动。配置缺失、拒绝外发、无权限、无样例有可操作反馈；打开页面／渲染预览不调用模型。
- 对比展示同样例下旧版和候选输出、实际证据与未读内容、耗时和已知费用；未知费用显示未知。桌面双列、手机上下排列，保留旧结果不整页闪黑。
- 人评以「更好／差不多／更差／无法判断」及说明为主，查看相关性、证据支持、机制解释、适配代价；结构校验与人评分开展示。无需用户填写 JSON 或内部版本标识。
- 「申请启用」复用现有提案。批准前不改变正式运行；界面能打开待决定项并在决定后读回实际生效版本，不能将创建提案提示为已启用。
- 历史展示改动原因、试跑、批准与实际范围；回滚走现有受控机制和并发保护，读回确认后才提示成功。

## 4. 实际运行与数据合同

### 4.1 一份可演进方法，代码持有执行边界

- 注册一个有明确版本的阅读调查方法，先贯通项目材料准备及其实际取材入口。实现者先锁定命名和共同调用点，避免只接手动重读而 Following 继续完全绕过它。
- 把可变的调查策略与不可变的提交、权限、工具／运行界限分开。方法正文不得覆盖 Source consent、完整受众、存储、版本、输出 schema 和网络／执行权限；变量中的外部内容为不可信资料。
- 调查步骤：确认已授权项目问题 → 选择少量具体功能线索 → 在已有访问范围／时间／工具限制内读相关主文档和示例 → 输出功能、机制、证据、与项目的关系、借鉴代价和未知。
- 区分原文、转述和推断；保留实际支持 URL。没有读到文档时说明初步发现／证据不足，不编造“深入分析完成”。不硬编码扣子功能，也不以页数或字数作为质量通过。
- 项目上下文必须来自规范读取，并在内容外发和写入前按实际受众／Source 目标重验。个人材料不因打开改进页而变成共享项目材料。
- 正式 Run 在准入／准备时解析并冻结具体方法版本及内容 hash，记录既有 provenance；排队期间启用／回滚不能使同一 Run 漂移。旧运行继续按原版本恢复；新运行才选择新生效版。
- 系统基线沿既有 catalog／显式同步合同注册，启动 GET 不写库。不新增代码和数据库各自独立选择方法的双权威。无资产／未部署有明确初始化或失败行为。

### 4.2 试跑与新旧可比

- 复用 canonical Run／Job／既有资产评估记录与受控产物，不新建模型循环／队列／通用评测平台。候选试跑有专用且受限的授权解析，不放宽生产 resolver 的 approved-only。
- 一次试跑固定基线、候选、样例材料版本／证据包、项目上下文和执行配置；对同一资料和模型配置比较。若实时取材不同，标明不可直接等同，不伪称严格对照。
- 控制样例包含主页及相关文档／示例链接；不能只喂主页再声称验证了追查能力。离线 fixture 验证调度与记录；真实模型语义评分仍需独立执行授权。
- 试跑输出保存在受控试跑结果中，不覆盖已保存 Reader 正文、原简报、阅读状态或现有批注，不推进 Following 采集水位、不自动创建任务／Memory／Knowledge／通知。
- 重复点击幂等、有限并发／次数／时长、取消与旧回包收敛；失败保留可诊断记录，不自动无限补试。费用沿真实账本，未知不写零，不承诺当前 adapter 不具备的金额硬上限。
- 样例、比较结果、人评、申请启用之间绑定确切内容和版本。候选改变后旧比较只能作历史，不可拿来批准新内容；上下文／材料撤权后隐藏相应派生内容，不仅移除证据链接。

### 4.3 深分析如何到达 Reading

首版的可读调查正文沿现有 Source material writer／Reader 交付，保留证据和项目范围，不仅写到一个无消费方的资产里。当前短注解与简报压缩保持诚实：若未将完整调查证据安全接入综合，明确首版是改善材料阅读方法，不宣称所有 Daily Briefing 已完成深度升级。不得放开简报自由浏览以绕过冻结依赖。

## 5. Reuse / Dependency Check

- Reuse：`prompts/{repository,resolver,renderer,provenance}`、`evolution` 版本／评估样例／promotion applier、现有 proposals、Run/job admission／settlement／usage、Source material submit／document writer／Reader、前端 Space／session／scope 守护。
- 内部现有能力已经覆盖版本管理、调度和受控写入，不引入第三方提示词平台、额外模型 SDK、爬虫或新依赖。新增只限阅读方法的领域接线、必要试跑适配与简单界面。
- 复用现有 real PG、运行时边界 fake、组件及 Chromium 合成 fixtures。实现者开工补充精确调用点／字段和是否确需 schema 变更，不为方便新建重复存储。

## 6. 实施顺序与退出条件

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| A：方法与运行接线 | 注册方法、正式解析／冻结／归属，受控候选试跑与样例比较／人评，真实取材路径使用方法 | real PG 正反与 canonical Run 合成路径证明实际使用版本；候选不影响正式运行；试跑无正式内容副作用 |
| B：端到端工作台 | Reading 上下文入口、简单页眉、编辑／试跑／对比／提案启用／历史回滚 | 项目冷启动至申请启用、决定后读回、新 Run 使用及回滚完整可达；中英 390／1280，权限与状态正确 |
| C：整体复核 | Codex 实施，Claude 技术与 Antigravity 产品独立审查，按具体反例窄修 | 所有阻塞闭环；稳定后 primary 独占 server full maxWorkers=4 与 Web full，协议／types／build／Chromium 按改动完成 |

阶段是交付检查点，不要求用户重复批准已授权的可逆 IDE 实施。用户已在代码与 UI 验证完成后明确授权本批本地提交；不擅 push／deploy。

## 7. 验收清单

- [x] Reading 的入口只携带已授权上下文，未知历史归属不假报版本。
- [x] 页眉显示实际范围、生效版和单个下一步，普通路径无需内部 ID／JSON。
- [x] 保存草稿不改正式行为；候选修改令旧比较失效；生产不使用未批准版本。
- [x] 同样例新旧试跑确有两个被记录的 Run／版本，不能手填 passed 假冒执行。
- [x] 未读资料、反例、失败和未知费用准确展示；结构合格与质量更好分别判断。
- [x] 当前范围的提案决定／实际生效／新 Run／回滚真实接通，重复或并发安全。
- [x] Source／项目／材料失权在读取、试跑外发、结果保存及结果读取重验；个人私文不扩大受众。
- [x] 取消、排队、重启／迟到回包按既有生命周期收敛；无额外背景循环。
- [x] 原日期切换修复、Reader／注解／既有 prompt consumers 不回退。
- [x] 独立双审、适当完整套件、类型／构建、390／1280 Chromium 与 owning guides 收口。（本地合成验证范围，最终证据见 §11）
- [ ] 真实模型质量／真实运行验收另记授权、配置、成本和结论；合成测试不能冒充。

## 8. 验证、安全与计划收尾

按 [TESTING_STRATEGY](../architecture/TESTING_STRATEGY.md) 与 [COMMANDS](../COMMANDS.md) 使用 Node 24、真实隔离 PG、受控 runtime/provider／Host fixtures。affected tests 先行；完整 server 与 Web 不并发，长进程 poll 到 exit 后才 Room wait。

不读取生产私文／凭证，不操作实例 DB、真实权限／Run／消息，不 push／deploy。开发 Codex 委派不等于许可产品真实模型验收；先前模型配置／费用及 live Host 目标授权尚未给出，本轮不重复询问或自行推断。

迁移使用 Drizzle canonical generation，已发布前缀 0000–0007 不改。保护工作区原先九项日期切换变更；提交后以干净基线实施。

更新实际 owning guides 与 INDEX，状态按证据勾选。计划仅在承诺范围及验收完成，或用户明确调整验收范围后退役，不将未验项搬 backlog 假完成。

相关现有设计：[Library](../modules/library.md)、[Information Digest](../modules/information-digest.md)、[Source material processing](../architecture/SOURCE_MATERIAL_PROCESSING.md)、[Source goals](../architecture/SOURCE_GOALS.md)、[Evolution signals](../architecture/EVOLUTION_SIGNAL_SYSTEM.md)、[BOUNDARIES](../BOUNDARIES.md)。

## 9. MVP 实施锁定设计（工作区；Codex）

- 方法资产：`reading.project_investigation`（catalog/prompts/reading_project_investigation.yaml），`prompt_type: text`。正式入口 `sources/goals/nativeSearch.queueNativeSearch` 与 `sources/materialProcessing/items.start` 均在同一准入事务调用 prompts 的阅读方法适配，production resolver 保持 approved-only。Run contract 的 `workflow_input_json.reading_method` 保存真实 provenance、模板 hash、渲染 hash、项目上下文 hash；正文直接进入冻结 Run 请求，恢复不重新选择版本。不存在代码正文 fallback；未显式 sync/deploy 时报可操作初始化错误。
- 不新建表：草稿/候选仍在 evolvable_asset_versions；样例仍为 evaluation_cases；一对试跑仍为 evolvable_asset_evaluation_runs（evaluator `reading_method_pair.v1`），suite ref 固定 case/材料/上下文/执行配置及两个 Run id，metrics 只存人工结论，不手填结构 passed。结果从其真实 Run canonical output 读取。采用受控离线证据样例（主页+主文档/示例），无隐式实时 fetch，严格同输入；页内明确离线比较与真实取材的区别。
- 试跑是 canonical Run+agent_run Job、closed WorkContext、无 Source 写入 action。既有 Run finalization reconciler 投影评估终态（CAS）；同版本/样例/输入/执行 hash 的重复启动幂等。取消走 canonical cancel。候选试跑的维护/Source/材料/项目完整受众与实际目的地 egress 在准备、派发/Delivery、保存和读取重验；正式采集沿原requester及canonical产物作用域门禁；失权隐藏整份对比。只准既有 asset 维护者使用候选，不开放普通用户生产解析。
- 前端 `/prompts?reading_method=1&item_id=…&project_id=…` 为简单工作台；旧高级 PromptLibraryPage 保留 `/prompts?advanced=1`。Reader/Reading 入口仅在服务器返回 can_manage 后提供。版本修改创建新 immutable child 草稿，旧比较绑定旧hash；启用仍创建既有 promotion proposal，由人决定，刷新读回 production resolution；回滚走既有 prompt repository。
- Reuse Check：现有 prompts/evolution/Run/Job/Source writer/usage/WorkContext 已覆盖机制；无新增依赖、模型SDK、调度/评测平台或 schema。外部 commodity 框架不接管领域权限和提案；采用现有能力的窄适配。当前完整调查正文沿 Source material writer 进入Reader，中立annotation/closedbriefing不改，DailyBriefing短片段限制继续明示。


## 10. A+B 实施与交审状态（2026-10-30）

上述已勾选项限本地真实 PG、合成 worker/ACP Host、组件及 Chromium 的实际验证范围；不表示真实模型的调查质量已经合格，也不是独立审查或全量套件的替代。

- A 已实施：两条正式 Source 调查入口消费同一批准方法；准入冻结方法、hash、provenance 与授权项目上下文。Source material writer 与 native goal 手动恢复／物化均重验，最终 Reader artifact 保留实际 Run 的方法归属；无归属旧结果继续未知。中立 annotation、closed briefing 及其片段限制未扩大。
- B 已实施：现有 `/prompts` 的上下文工作台提供可读编辑、显式样例／Agent 配置、两个 canonical Runs 的对比、人评、申请启用、决定后 resolver 读回与回滚。原高级界面、asset/tab 深链可达。Reader 返回保留原日期／来源／列表上下文，避免改变 Serendipity 的兴趣语义。
- 试跑沿现有表，不加 schema／迁移／依赖。每人每 Space 一组进行中、滚动一日三组、每 Run 一 attempt／180 秒、最终请求 48k 字符；既有更紧预算仍有效，无 token／金额硬 cap。配置在准入冻结，改变配置后派发拒绝；基线部署变化使旧比较仅作历史，不能据此批准新内容。
- 样例只接受 server-owned 虚构主页＋文档 fixture，或当前真实保留 Reader 正文的精确片段／支持 URL；须有完整 Source 存储同意和完整受众读权。规范样例 proof 不能由旧通用评估 API 伪造。试跑的 case／artifact／Project audience／Source 规范锁贯穿 Delivery commit；派发、结果读取、人评与提案应用均重验，不另开复制私文或自动检索通道。
- 配对 Run 仍私有，WorkContext 绑定项目策略／指令版本、关闭自动检索与 pins，无 Source 写工具；这不是 paired-native OS 隔离承诺。退出维护／Source 权限后仍可停止自己准确归属的试跑，不返回被撤销文本。并发试跑／启用复用 canonical asset lock；Run finalization reconciler 投影 pair，旧回包不覆盖新状态。
- 已通过合成 worker 两 Run 的实际 Delivery/settlement、隔离库提案应用／生效读回／新 Run／回滚、Source 双向并发锁、撤权零 Delivery、worker SIGKILL／租约回收／迟到完成／显式重试，以及中英 390／1280 完整页面旅程。详细命令、退出状态、日志和截图写在 `/tmp/reading-method-mvp-Codex-implementation.md`。
- C 已完成：Claude 技术与 Antigravity 产品独立复审、具体反例窄修及 primary 独占 server full maxWorkers=4 → Web full（含性能），最终证据见 §11。用户已授权本地提交，未 push／deploy。
- 真实产品模型／远程 Host／真实费用／语义质量验收未执行，原 Task8325 的真实模型/live Host 验收也未完成；需原有独立授权配置，不移至 backlog 假作退役。


## 10.1 双审 fixes1 首次交接记录（后续复审见 §11）

首轮双审指出 F1 历史新鲜度与权限混淆、F2 每卡重探测、F3 采集全受众门禁回退；首轮绿灯未覆盖这些反例，不作通过依据。现将历史读取与严格执行校验拆开，正常输入修订保留 stale 历史；scope-only 入口按挂载作用域共享；Source 采集恢复原分层读者语义，项目上下文只进入相同 canonical Project 的产物，否则 Run/WorkContext 不注入项目而进行普通阅读。该次交接时真实模型质量、完整门槛和独立复审尚未完成；后两项已在 §11 闭环。报告 `/tmp/reading-method-mvp-fixes1-Codex.md` 记录本次正确预期正反验证，不代表计划退役。

## 11. 最终代码复核与完整门槛（2026-10-30）

- Claude 技术增量复审与 Antigravity 产品复审均 PASS：`/tmp/reading-method-mvp-rereview-Claude.md`、`/tmp/reading-method-mvp-rereview-Antigravity.md`。首轮 F1–F3 失败证据及修复记录保留，不将首轮审查改写为通过。
- primary Node 24 独占 server 完整套件：`REQUIRE_TEST_POSTGRES=true vitest run --maxWorkers=4`，exit 0，105.62 秒；517 文件通过、1 文件条件跳过，5917 项通过、5 项条件跳过；性能门槛通过。日志 `/tmp/reading-method-mvp-server-full.log`。
- server 结束后独占 Web 完整套件：`vitest run`，exit 0，28.01 秒；242 文件、2176 项全部通过；性能门槛通过。日志 `/tmp/reading-method-mvp-web-full.log`。两套未并发。
- 协议 318 项、server 含 tests 类型检查、Web 类型检查／构建、中英 390／1280 Chromium 四条合成旅程及指南检查已通过，复用修后报告 `/tmp/reading-method-mvp-fixes1-Codex.md` 的实际命令／日志；没有将重叠验证累计成独立覆盖数。
- 全部验证使用隔离 PG／合成运行时与浏览器接口；IDE 没有调用真实产品模型、操作真实实例／用户提案或读取私文凭证。模型语义质量、真实费用与 live Host 未验，无 token／金额硬上限，不承诺已进入 vendor 会话的内容可撤回。
- 普通采集在 Source 与 Goal 不同 Project 时使用无 Project 注入的 Run／WorkContext，保留 Goal 访问依赖及原分层读者语义；此类 Run 不在按 Project 字段过滤的通用运行列表中，追溯仍由 Goal／材料归属提供。现有试跑工作台仍保留完整受众的样例门禁。
- 本批没有 schema、迁移、依赖或 lockfile 变化；既有 0000–0007 未改。用户已授权提交本次 MVP 与后续 UI／规范改动；不 push／deploy。计划不退役，未验项未迁 backlog。


## 12. UI 规范与提交前收口（2026-10-30）

- 补齐 UI_STYLE_GUIDE，接入 AGENTS／CLAUDE、INDEX 与相关前端 context bundles。入口使用共享小号次要按钮，阅读操作优先；工作台使用共享控件、主题边框与中英字典。摘要卡不显示不可用入口，可访问名称包含可见标签。
- Claude 技术与 Antigravity 视觉双审 PASS，真实父卡入口和目的地均经截图检查。明暗主题、中英、390／1280 共 16 条 Chromium 合成旅程通过；最后两项窄修后类型／构建及两条入口抽样通过。
- 最终 Web 完整套件 242 文件、2178 项通过，性能预算通过；指南 8 项通过，diff 检查通过。后端未因 UI 调整而改变，复用 §11 修后全量验证。
- 计划剩余项仍为 §7 最后一项：真实模型对实际资料的调查质量、实际运行环境及费用验收。当前合成试跑对照不能证明真实联网追查能力。完整调查证据接入 Daily Briefing 综合不在本首版承诺内，不能将材料阅读改进宣传为简报全面升级。
