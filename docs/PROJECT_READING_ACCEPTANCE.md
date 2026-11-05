# 项目 Reading 验收：自动证据与真实质量分开

适用源码：Project Reading R1–R6；本文件不是运行时prompt、另一份计划或部署声明。
R1–R6已逐阶段双审、验证并分别提交，最终Claude技术与Antigravity流程整体审查均PASS。真实模型质量Q1、
真实远端Host、账号/实际费用为 **NOT EVALUATED（未授权）**。不能以结构合格、
固定输出或以下测试绿灯代替人工语义判断。Source实现及追加迁移均未在实例部署/应用。

## 计划退役记录（2026-11-02）

用户实际试用后反馈“基本上差不多”，明确同意退役本轮实施计划。
因此删除 `.agent/plans/project-reading-information-flow.md` 及其活动计划入口；
用户的基本试用反馈不代替下述Q1量表、目标远端Host或实际费用的正式验收。
这些项目继续在本文保留为未评估，不再阻塞本轮实施计划退役，也不自动安排后续调用。

R1–R6提交依次为 `62f5e964`、`faff6beb`、`3280b213`、`e582dd05`、
`1dadd41c`、`9968bcb6`；最终整体双审与验收边界记录在 `f5510200`。
旧计划全文及变更记录可从Git历史追溯，当前实现合同由
[Library](../.agent/modules/library.md)、
[Material processing](../.agent/architecture/SOURCE_MATERIAL_PROCESSING.md)、
[Source Goals](../.agent/architecture/SOURCE_GOALS.md)、
[Information Digest](../.agent/modules/information-digest.md) 和
[Reader](../.agent/architecture/READER.md) 维护。

## 可复用入口与证据分层

- 下文A1–A12保留已完成自动/合成验收的编号与断言入口；Q1量表和受权步骤单独保留。
- [方法与评价原则](READING_METHOD_V1.md)已定义证据/反例/未知/阅读负担的人工评价。
- 固定语料唯一机器来源：[projectReadingQuality.v1.json](../server/test/fixtures/projectReadingQuality.v1.json)。
  九例全为synthetic，本地`.example`身份不联网；original/analysis、日期、同源起点、
  Project事实、目的、引用段落和不能支持的结论均显式。没有模型输出、人工分数或passed记录。
- `projectReadingQualityFixture.test.ts`只验版本、身份/引用闭包和保留的反例条件。
  不注册产品evaluation case，不造新评测store，不绕现有Sample/Source读取与存储许可。
- 真实持久行为使用`useTestDatabase(import.meta.filename)`：shared Testcontainers中
  每文件独立`rainver_test*`数据库，不连接实例。
- 模型边界使用synthetic ACP Host，真实canonical Run/Job/Delivery/settlement；
  browser的主题完成使用受控terminal fixture，不能冒称该浏览器自己跑过真实模型/worker。
  worker完整链由独立PG测试证明。
- 开发期间的日志、截图、临时审查报告和Host构建副本原存于Git忽略的
  `.tmp/project-reading/`，未纳入版本控制；2026-11-02按用户要求清理。
  本文保留验收结论和可重跑测试入口，不再依赖这些临时文件。不把重叠测试组相加当独立总数。

## A1–A12 test → assertion 映射

下表是可重跑的断言位置，不表示所有外部平台/模型都经过实际验证。
本表的测试入口仍在源码中；清理临时报告后，可按这些入口重新验证。

| 编号 | 真实断言入口（server/test，除标web） | 能证明什么；剩余边界 |
|---|---|---|
| A1 | `projectReadingRecordsDb` “A -> independent D/D2”；`projectDeepReadingDb` “D and explicit D2 preserve…” | 独立snapshot/Artifact，Ahash/批注/进度不变；不是模型内容质量 |
| A2 | `projectReadingRecordsDb` “deterministic fetch failures…”；`projectDeepReadingDb` “missing deterministic original…” | fake fetch 403/不可用/PDF/Markdown/主页、B独立URL、Agent不能冒原文；不突破登录/付费墙，不声称已下载真实站点 |
| A3 | `projectReadingThemesDb` “manual durable collection…”、“scheduler freezes…”、“real worker/orchestrator…”、“scheduled cohort waits…” | 持久来源/抽取终态后各主题，再组合；模型边界合成 |
| A4 | 同文件 “pending audit…”、“empty first…”、“late original…”、“failed collection…”、“F2 only collection coverage…” | 首空/partial/失败/无新增/迟到pending区别；输入方法/目的变化不误复用 |
| A5 | 同文件 “composition keeps independent immutable versions…” | 单B只改B，A/C引用/顺序/时间等值，历史不变；无跨主题模型结论 |
| A6 | 同文件 “worker SIGKILL…”、“scheduled cohort waits…”；`projectDeepReadingDb` “private deep reading survives a killed worker…” | 真实测试子进程SIGKILL/restart，旧launch停止ACK、显式新boundedRun、晚回拒绝、唯一报告；只加速DB租约11分钟，不改生产阈值/预算 |
| A7 | `projectDeepReadingDb` “favorite and private deep reading…”、“favorite does not require…”、HTTP/favorites分页；R5 web/browser | 三组合、私隔离、取消收藏保报告，GET/页面不生成；离页不等取消 |
| A8 | `projectReadingThemesDb` “freezes purpose/method/context…”、“an activated new purpose…”；deep “global material…” | 精确目的/方法/原文，旧报告不重标新目的；不混两个目的 |
| A9 | 同文件 publication canonical fence、history/export、restore authority；deep physical Delivery/source withdrawal/private Source jobs/postprocessing | 实际目的地/受众/Source闭包与双向锁、export/generic入口、私作业投影；不是已送vendor context可撤回承诺 |
| A10 | deep “private investigation preserves explicit opencode…”、“API-bound OpenCode…”、“HTTP favorites/list…”；themes advertised mode | 合成Profile/API-bound/CLI同规范选择、禁用不fallback；不冒实际厂商账号或真实CLI质量 |
| A11 | `projectReading.browser.ts`原八矩阵及`READING_LONG_REVIEW=1`；web `ProjectReadingPage`/`LibraryItemReaderPage` | 四视图、多主题分节摘要/完整分析阅读/定位/时间/历史/exact原文/无收藏解读入口；Sidecar关闭，未验开启后的任意布局或全a11y |
| A12 | `baselineSchema`空库完整迁移链；`readerSourceVersionsDb`；`informationBriefingPersonalDb`；`researchAreaDb` | 正式迁移链在空库上可重复应用、旧正文/状态/身份、个人与Research受影响consumer；所有实例已在当前链上，不再保留旧链升级演练 |

## 每日版与历史链路（2026-11-02重构）

Overview按Project时区展示每日进度，但只有新的分析正文发布后才形成内容版本。
同一轮采集、等待分析、生成正文共用现有round身份，不生成中间内容版本；
无新增、失败及跨日只有检查的情况保留进度，不复制昨天正文、不增加版本。
历史入口分页覆盖按日版本及未挂入每日版的主题分析；日期链接进入同一入口。
删除重复Project日报/分析面板及无人使用的monitoring结果分支，Project独立AI日报入口退役；
个人日报、历史Run结算、原文及私人深读保留现有边界。

专项断言入口：`projectReadingThemesDb` 的单轮发布/no-new/idempotence、delayed scheduler
slot/DST、collection-only progress、paged archive/current Source authority；
`informationBriefingDb` 的retired Project generation/preserved old Run，
`TopicAnalysisArchive`/`ReadingHistory`/`SourcesAreaPage` 的日期、分页、入口和拒绝读取；
`reader-journeys` 的Overview八矩阵增加当日修订和前一天历史。
迁移由Drizzle生成；本轮未连接运行实例或应用迁移，模型质量仍未评估。

2026-11-03按用户要求移除本轮新增的旧格式适配器、未按日版本分支及日期推断。
测试实例既有记录以一次性手动SQL规范化，仓库不包含回填脚本或自动回填逻辑。
正常每日版历史、独立主题分析、原文与私人解读的读取和权限检查继续保留。

## 长文阅读人工检查

复用现built Chromium fixture；`READING_LONG_REVIEW=1`仅为测试选择，不是产品开关。
三个主题由真实collector入口、canonical theme terminal projection、composition writer入库，
引用同一个实际保留原文snapshot（不伪造三份独立证据）。主题输出标明synthetic。
检查父Project导航→默认总版，三个主题各显示一次摘要和引用重点，键盘进入B的完整分析并返回，
真实主题时间、返回后分节、历史只一主题、返回当前三主题、C引用进入精确原文和返回。
原R5八矩阵覆盖dark/light×en/zh-CN×390/1280；R6新增en/dark桌面和zh-CN/light手机，
当时人工抽样检查了入口与目标页截图；临时截图现已清理，浏览器fixture仍可重跑。
不能只凭no-overflow/截图存在/DOM类名宣称视觉通过。
未收藏结果永久入口由R5真实私报告旅程及R4/R6PG断言共同提供，长文浏览器不伪造私报告。

## Q1人工量表与未来受权步骤（当前不执行）

每例对七维分别记“达到/部分/未达到/不适用”，附输出原句和精确input-id/passage-anchor，
另记理由/缺口；不自动求总分：

1. **支持度**：重要判断实际由哪段支持？区分作者说法/推断/外部支持。
2. **差异与反例**：识别同源转载、矛盾的条件/版本，旧文新发现不冒新事件；AI摘要不计独立源。
3. **Project出处**：项目事实来自获权输入，目的不是已实现事实；缺事实必须明确。
4. **目的相关**：回答所选目的；同文两目的各自冻结与评价，不混结论。
5. **深度**：解释机制/论证/适用条件与代价；不能主页长篇改写、release/PR清单冒调查。
6. **未知**：未读/失败/无工具/无权限真实；不编API、实测或阅读过的文献。
7. **阅读负担**：速读→主题摘要→必要正文，长度与证据匹配、可核引用，无凑标题和重复。

任何伪引用/伪实测、原文被报告覆盖、私有文案泄漏或越权写不能用其它维度抵消。

以后只有取得明确真实调用授权，才在独立测试Space/Project按既有UI/服务执行：

1. 明确材料URL/实际可保留范围、Project事实来源、目的、目标Host与本人可用
   Agent/Profile/model/mode、次数/费用上限及失败停止条件。缺一项先补范围，不默认外发。
2. 先少量（如每目标一个样例、基线/候选各一次，共两Run）的明确有限试用；真实数量由用户批准，
   不自动安排其余九例/持续Following。无in-run token/金额硬cap，次数不能冒金额；
   准入/工具/时长有现有限额，usage/cost未报则记unknown，不能标0。
3. 通过现合法Source capture/retention和受控Sample入口提供精确版本材料；不可把本JSON
   任意粘贴为已保留私文或自动导入产品。live网络变动记录并承认不严格可比。
4. 记录目标方法/父版hash、Run/attempt/执行配置、原文snapshot/hash、冻结目的/Project上下文、
   输出/引用、实际时间与可用usage。基线/候选输入相同，人工量表独立评价，结构valid不是更好。
5. liveHost单独观察真正远端进程/ACK/恢复；本地synthetic wire不能取代。用户仍自己决定提案，
   不由IDE批准；无自动分享/Memory/Tasks/通知。撤权后已发vendor context/已下载副本不能保证撤回。

Q1结果保持NOT EVALUATED直到实际获权执行且有人记录评价。R6最终gate及整体双审已通过；
本次授权源码开发与自动/合成验收完成。用户在基本试用后明确决定退役实施计划，
未验真实质量、目标远端Host与实际费用继续在本文保留，不改标PASS。

## 最终工程验收与已知限制（2026-11-01）

最终受审源码为R6提交9968bcb6。完整server6086通过、5项既有OS选择性跳过，
523个文件通过、1文件跳过，exit0；未调整超时或性能预算。生产Web、protocol、schema
在R6没有变化，分别复用R5完整Web2231通过、protocol336通过、13迁移同步结果。
各阶段最后类型/build和指南检查通过。上述数字是各自完整门槛，不与重叠定向组累加。

整体审查没有阻塞P1/P2，仍记录以下非阻塞限制，不当作新增已实现功能：

- 旧普通Project material-processing兼容入口尚非新的deep合同：私分析不在新私解读列表中；
  通用jobs仍可对材料读者显示非正文状态元数据，且普通作业仍计入原文屏障。
- 报告引用精确原文时，即使它也是当前原文，仍显示历史只读版本；历史总版的选择器范围有限，
  主题标题沿当前名称，冻结目的正文另行展示。
- 已授权新链的sticky cutover不会因删除唯一Following自动恢复旧项目模型日程。
- 手机悬浮Chat会覆盖部分底部区域，需要滚动；Sidecar开启和arm等其他平台未验。

这些限制与Q1、真实远端Host及费用未验保持可见；没有push、应用部署或实例迁移。


## 分支迁移合并（2026-11-02）

按用户要求，当前dev相对master的六个迁移0007–0012已用ADR 0025工具合为
`0007_project_reading`，保留已发布0000–0006不变。旧各阶段编号是历史证据，
不是当前文件名；现有数据库转换要求和归档身份见
[迁移说明](../server/migrations/README.md#current-dev-branch-consolidation-2026-11-02)。
此前13项迁移同步为合并前结果；合并后的链共8项，须以本次检查为准。
