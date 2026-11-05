# 通用解题引擎领域契约与迁移规格

状态：**P1 设计档案，已停止作为并行运行规格**。原设计与源码盘点保留供历史核查，不代表当前 API/迁移待实现；其中阶段任务、旧 HEAD/hunk 和未来式叙述都是当时的设计记录。

现行不变量由 [ADR 0027](../decisions/0027-problem-engine-research-separation.md) 约束；当前领域/API/工具分别以 [Inquiry 引擎](INQUIRY_PROBLEM_ENGINE.md)、[Research 调用](PROJECT_RESEARCH_CALLS.md)、[Project Work](PROJECT_WORK.md)、[Task/Board](TASK_BOARD_MODEL.md)、[单 Task Plan](PLAN_GRAPH_EXECUTION.md)、[升级与恢复](PROBLEM_ENGINE_UPGRADE.md) 为拥有者指南。源码仍是实现事实依据。本轮跨域验收、证据边界和遗留事项见 [验收清单](PROBLEM_ENGINE_ACCEPTANCE.md)。下文仅保留 P1 归档内容，不建立第二生命周期或另一份当前态权威。


## 1. 领域与写入权威

| 事实 | 唯一所有者及规范写路径 | 不产生的联动 |
| --- | --- | --- |
| Task 进度 | `tasks.status`，Task repository；完成/审核仍委托既有动作 | 不推进问题阶段或结束问题 |
| 问题、判断、工作及轮次 | 原地演进 Inquiry Thread/Step/Iteration；Inquiry 领域命令 | 不改关联 Task 状态 |
| Research 执行 | 现有 Workflow/Operation/Run、材料/报告链 | 不确认问题立场、方案或下一步 |
| 单 Task 执行图 | Plan/PlanVersion/Node 及既有结算 | Node 不是产品 Task，Plan 不是问题容器 |
| Source/监测/日常阅读 | 各自既有入口、权限与调度 | 不强制创建 Thread、FINER 或五阶段 |

保留 Thread 的 `question` / `hypothesis`，不添加 objective 或平行 Problem 根对象。Thread 仍遵守 ontology 根、Project 和内容权限；Step、轮次收尾、Iteration 是 Inquiry 内部结构。Project 无类型，直接 Task 可独立完成全部流程。

Reuse / Dependency Check：复用 Inquiry 命令/事务、`task_entity_links`、Step 目标引用、现有 Research orchestrator 与规范事件 writer。已检查协议、Drizzle schema、领域 facade 与共享 PG 夹具；现有 Zod/Drizzle 足够。外部通用工作流/状态机不适合接管产品判断与治理（领域语义，非商品化能力）；不引入依赖、调度器或另一执行容器。

## 2. 方法版本与 Step 分类

目标方法标识固定为 `problem_solving.v1`。历史方法标识为 `inquiry_research.v1`；旧行缺少标识时只在历史解码边界补此含义，不能把旧 kind 改写成新方法。协议、schema 和服务端投影在 P2 同步落地；P1 不向现有 `InquiryStageId` 枚举塞入未被消费者支持的值。

| stage（稳定机器值） | 中文 | 允许记录的工作/产物 |
| --- | --- | --- |
| `frame` | 明确问题 | 表述、范围、成功判据、已知信息/缺口 |
| `plan` | 制定方案 | 候选方法、取舍、顺序、预算/授权需求 |
| `act` | 采取行动 | Task 引用、Research 调用、实验及执行记录 |
| `verify` | 检验判断 | 结果引用、适用性、反证、可信度、未决缺口 |
| `conclude` | 总结本轮 | 保留/改变判断理由、收尾总结、下一焦点/结束决定 |

新 Step 将三个正交维度分开：`method_version` / `stage`（方法分类）、`work_kind`（做什么）、`slot` / `status`（注意力与执行事实）。`work_kind` 第一版为 `select_method`、`record_work`、`invoke_research`、`link_task`、`reference_result`、`assess_result`、`close_round`；研究内部搜索/阅读/综合仍用原 pipeline 类型，不混入此枚举。工作类型不是权限授权。

- `select_method`：选择阶段、跳过或回退，必带 actor、原因与上下文引用；不产生完成产物。跳过记录明确的目标和被跳过阶段，不伪造成功。
- `record_work`：记录该阶段的实际工作及引用；Frame/Plan 的正文不通过普通 PATCH 修改认知字段。
- `invoke_research`：可在任一阶段发起，必须带该阶段的具体缺口。操作运行时可占 background；开始调用不代表阶段完成。
- `link_task`：任一阶段引用 Task，通常为 Act；关联与执行分离，不从 Task status 推导阶段完成。
- `reference_result` / `assess_result`：前者收集结果，后者记录适用性判断（通常 Verify）；只有专门 Iteration 命令能改受保护认知字段。
- `close_round`：Conclude 的收尾工作，由收尾命令原子记录；不要求前四阶段齐全。

保留至多一个开放 primary Step 与多个 background Step 的约束；同一阶段可有多个 Steps，多个阶段可同时有工作。`next_focus_kind` / note 在迁移中保持开放 primary Step 的派生投影，不能成为第二份手填下一步。新协议显式区分新分类与旧 kind，不能用相同字段悄悄更换枚举含义。

旧 kind 只提供历史来源及保守工作分类：clarify/decompose→Frame；search/experiment→Act；read_evidence→Verify 的候选输入；synthesize→Verify/Conclude 的候选工作；promote Knowledge/decision/delivery Task→结果落地引用。后两类依原 Step 上下文而定；不足以判定就返回未分类历史，不能硬映射。旧 Acquire 不等于 Plan，旧 Land 不等于 Conclude；历史阅读、开始综合均不证明判断完成。

## 3. 阶段投影与命令边界

服务端 Inquiry 提供可重建的 `problem_solving.v1` 投影：Thread/version、当前轮引用、事实修订号、可空 `current_focus`、各阶段 `worked`/`has_outputs`、开放执行引用、跳过/回退记录及历史方法来源。阶段没有另一套可编辑 status；有产物不等于检验通过。客户端只展示投影，页签选择纯本地状态；Agent 使用同一读结果。

当前下一步唯一权威为开放 primary Step；显式选择必须经领域命令写成该 Step 后才改变焦点，不用“最早未完成阶段”强迫线性推进；只有 background 工作时焦点可以为空，仍显示其阶段与执行状态。阶段产物只计入本轮明确归属的事实。时间相同用持久有序键，不用 UUID 字典序或客户端时间推断归属；旧历史不足以确定顺序时保留歧义标记，不捏造顺序。

| 目标领域命令（非已注册 API 名） | 原子效果 | 校验与禁止项 |
| --- | --- | --- |
| 记录工作选择/工作 | Step + 原因/来源 + Thread 工作投影/版本 + 审计 | Project writer、完整内容权限、active、预期版本；不得改认知 |
| 收尾本轮 | 收尾事实 + 已结束 Step 归属 + 可选 Iteration + 工作投影/版本 + 审计 | 幂等键、预期 Thread/轮次修订；不能伪造认知变化 |
| 修改判断 | 既有受保护认知路径，Iteration + 输入/前后判断 + 审计 | 必须实质变化；单独修改不自动双计轮次 |
| 结束/归档问题 | 既有 lifecycle 命令及开放工作处理 | 不完成/取消关联 Task，不把收尾等同 archive |
| 关联/创建并关联 Task | Task 规范创建 + 关系及来源（创建并关联同事务） | 两端权限、同 Space/Project、幂等；失败不留下孤立伪成功 |
| 采纳 Research 结果 | Verify Step/适用性判断 + 可选显式 Iteration | 重新验证快照/引用权限；不凭执行成功推断采纳 |

并发写在锁定 active Project 与 Thread/轮次后比较预期版本，不匹配返回冲突及重新读取提示；幂等相同请求返回原结果，不同载荷重用键拒绝。外部执行在事务提交后发起，使用现有可靠重试/执行机制，不在事务中调用模型。领域事件走现有规范 writer，携带 actor、Run、关联/因果与幂等信息；不可通过新增写表旁路权限或审计。

### 3.1 下一步单一权威与写端迁移（目标合同）

`closeout.next_focus` 和 Iteration 的 `confirmed_next_focus` 只保存当时意图，不能被读模型用作当前下一步回退值。Advice 保存 `(method_version, work_kind, stage)` 及 Thread revision 的建议，不是当前工作；旧 Advice 保持旧方法词汇，不把旧 kind 当新方法动作。只有显式采纳/工作命令可以开 primary Step；无开放 primary 时，当前下一步为空，即使历史意图或 Advice 非空。

| 当前写端 | P2/P3 目标约束 |
| --- | --- |
| `stepService.STEP_PROJECTION_SET_SQL` / note 投影 | 唯一从开放 primary 读取，方法版本与分类随 Step；与 Step 修改同事务更新，不从收尾/Iteration/Advice 复制字段 |
| `iterationService.recordIteration` 的 `confirmed_next_focus` / `applyNextFocus` | 移除隐式开启下一步；仅显式 `start_next_primary` 命令意图可在同事务创建 primary，保存历史意图本身不执行 |
| `iterationService.updateWork` / `stepService.applyNextFocus` | 作为规范工作写端校验版本、单 primary、阻塞和权限；不能按 kind 自动开没有 Operation 的 background Step |
| `adviceService.adoptAdvice` / `inquiry.adopt_next_step` | 重新校验建议版本/状态后显式采纳；手工作业创建 primary，研究/实验建议仅创建准备工作的 primary；实际调用成功绑定执行后才产生 background；建议标记与 Step/事件同事务 |
| Research orchestrator 工作回写 | 只登记已授权调用及其绑定 Step 的执行事实；不把建议或收尾意图自动变成新工作 |

`start_next_primary` 必须显式提供方法版本、工作类型、阶段及原因；它与收尾是否发生是独立意图。`invoke_research` 的 primary 可以表示准备/授权中的工作，但不能冒充执行中。创建 background 必须同时创建/绑定真实 Operation（实验沿其真实执行记录），提交后才调度；不以 `confirmed_next_focus=search_acquisition` 或 Advice 采纳代替启动。收尾本身默认不执行此命令，保持现有至多一个 primary 与阻塞一致性约束。

## 4. 轮次收尾与 Iteration

最小新增内部结构是**轮次收尾事实**，不是有状态 Round 执行容器。其合同包含 `thread_id`、稳定轮次边界引用、顺序/开始边界、`summary`、`input_refs`、`next_focus`（可空）、`iteration_id`（可空）、actor/Run、时间、幂等键和方法版本。唯一性分别约束每 Thread 的收尾序号、非空 iteration_id 的收尾关联，以及 Space 内收尾幂等键；同一 Thread 可有任意多次不同序号的收尾。下一步记录意图，不自动执行。首轮开始边界引用 Thread 创建事实；后续轮引用前一收尾事实，服务端分配稳定边界引用，不从标题或客户端时间拼接。收尾顺序按 Thread 内受锁保护的单调序号确定。

- 无变化收尾：记录原因、输入、未决缺口及下一步；不写 Iteration，不改 protected cognitive fields。
- 有变化收尾：同事务调用认知命令并链接一个 Iteration；收尾只计一次。既有独立认知修订不必结束轮次；必须由命令意图决定。
- 旧 Iteration：每条建立唯一兼容边界，保留 ID/前后判断/来源；不能再额外生成一轮。已有 Step.iteration_id 直接沿用归属；未赋值且已结束的旧 Step 按可验证历史顺序归属，歧义保留来源说明。空历史不伪造收尾。
- 开放 background Step 在收尾时不标成功、不取消、不换原始调用快照；保留发起边界引用。晚到结果只影响执行显示，显式采纳时才成为新轮输入；不能把旧轮报告永久计入以后每轮。
- 未结束 primary Step 在收尾中结束并归属该轮；放弃、失败和跳过保留各自事实，不用 `done` 冒充有产物。历史 abandoned Steps 也有轮次归属，避免 null 永久污染当前轮。
- 收尾后可以没有当前工作；打开下一轮或回退不抹历史，不创建执行、不复制关联 Task。问题结束与“本轮结束”是两条独立命令。

### 4.1 四个认知调用方及兼容写意图

当前 `recordIteration` 在每次实质变化后都会 `closeOpenSteps`、`assignSettledStepsToRound`，并按 `confirmed_next_focus` 调用 `applyNextFocus`；以下均为待实现的拆分，不是当前行为。

| 已核对调用方 | 目标是否收尾、Step 归属、下一步 |
| --- | --- |
| `inquiry/routes.ts:89` HTTP Iteration | 新合同必须给 `round_intent=position_only|close_round`；position_only 仅记当前轮认知输入，不结束/搬移任何 Step；close_round 才原子收尾并归属本轮已结束 Steps/当前 primary。下一步默认不开，仅显式 start_next_primary 可开 |
| `inquiry/inquirySystemActionExecutors.ts:119` Agent `inquiry.record_conclusion` | 同样必须显式 round_intent；结论文本不代表收尾意图，规则与 HTTP 相同，保留 Run/actor 来源 |
| `inquiry/signalService.ts:504` Candidate accept | 固定 position_only；服务端不能让 proposed/edits/body 注入收尾或下一步副作用。Candidate 与 Iteration 同事务，Iteration 属采纳时当前轮；原证据保留来源轮/快照，现有 Steps 不结束、不重归属、不开下一步 |
| `projectWork/updateUndo.ts:153` revert_iteration | 固定 position_only；补偿认知 Iteration 记入当前轮并引用原事件/Iteration，原历史与 Step 归属不动，不收尾、不开下一步。当前立场已被后续修改时拒绝盲目恢复，要求显式重新判断 |

旧 HTTP/Agent 无 round_intent 的请求仅由显式旧版本适配边界按旧“结论并收尾”合同处理，一次结论产生一次边界；适配响应标明旧语义。若旧请求携带 confirmed_next_focus，只记录意图，不自动启动执行；需显式工作/调用命令。新版缺意图拒绝，不能从字段有无猜测。无变化收尾使用专用收尾命令，不放宽 Iteration 实质变化 guard。该适配不适用于 Candidate 或 undo 内部调用。

### 4.2 规范事件、Updates 与补偿撤销

收尾是 ADR 0017 §2/§4 下直接、origin-gated 的领域写入；不新增统一人工批准。P2 在 Inquiry 注册 `thread.round_closed` 与 `thread.round_closeout_reverted`（目标事件名，当前尚未注册），subject 为 inquiry_thread，经 `recordThreadWorkEvent` → `recordDomainWorkEvent` → 规范 writer 写入，与领域事实同事务。事件包含边界/收尾/可选 Iteration 引用、summary、输入引用、方法版本、actor/Run、幂等与因果信息。认知变化仍保留既有 `thread.concluded` 事实；组合收尾两事件互相引用，Updates 展示一次可读组合而非误报两轮。

Updates 沿 Thread/来源 Run/输入内容的既有读门禁展示总结和撤销入口，摘要权限不泄露正文/引用；未实现可见性和撤销前不能开放该直接动作。批次折叠须保留每个收尾事件及其独立撤销目标。撤销由服务端设置可信 `undo_of_event_id`，不能接受请求载荷伪造。

撤销只追加 `thread.round_closeout_reverted` 补偿，不删除/修改原收尾、Iteration、Step 或后续边界；原审计与顺序永久保留，投影展示“已补偿”，不能把原 Step 重分到另一轮或减少序号吞掉后续轮次。收尾撤销不自动撤销其认知变更，需独立 revert_iteration；两者在 Updates 明确区分。即使无变化收尾也可按此规则撤销。

同事务锁 active Project/Thread/原事件并检查预期版本、未撤销及依赖：仅最新收尾且其后无新 Step、Iteration、收尾、已开始执行或结果采纳时，允许一次补偿并恢复收尾前的工作选择为**新 primary Step**（引用原 Step，原 Step 保持历史结束事实）；不恢复 background、不重发调用。若收尾前无 primary，则保持空。存在后续依赖、关联执行仍可能晚到、立场已改变或权限不满足时返回冲突/规范拒绝，保留后续轮次，用户可在当前轮显式补充判断；不级联撤销、不自动重开旧轮。重复撤销按事件唯一性拒绝或幂等返回原补偿。

schema 作者是 `server/src/db/schema/inquiry.ts`，P2 再选具体列/索引与生成 Drizzle 迁移；本合同不授权手写替代 schema 或部署。回填须可重入，以旧 Iteration 唯一关联去重；对账 Thread/Iteration/Step 数量、边界计数、孤立引用、开放执行与跨轮产物。Task Loop 不生成 Thread 或轮次。

## 5. Research 调用/返回与权限

以既有 Workflow/Operation 为执行引用；逻辑包版本分别为 `research_call.v1` / `research_result.v1`，P3 在现有边界实现，不新建平行 Call 生命周期表。调用类型分为问题证据调用与既有直接阅读/监测调用；后者不强制套用 Thread 合同。

| 输入字段组 | 要求 |
| --- | --- |
| 归属 | Project、Thread ID/不可变 revision、轮次边界/Step 引用；属于问题调用时必填，引用须同属该 Thread |
| 研究目标 | 明确待查缺口、已有材料引用、输出期待；不复制可编辑问题定义/下一步 |
| 范围 | 检索源、`since`/时间窗、`max_items` 依用户指令；未给则沿现有有界默认，不自行扩大 |
| 执行上下文 | 可信调用者/Run、预算及审批引用、取消与幂等关联；调用者不能通过载荷自授权限 |

| 返回字段组 | 要求 |
| --- | --- |
| 身份/快照 | Workflow/Operation/Run、原 Thread revision/Step/边界、结果版本 |
| 发现 | 研究发现、支持/反对证据及来源引用、局限、未解缺口 |
| 产物/运行 | 报告/材料引用、真实执行状态、实际用量、失败/取消原因、可用的部分结果 |
| 适用性 | 标出快照过时；执行包本身不含已接受问题立场或已决定下一步 |

### 5.1 启动绑定、取消、重试与对账

当前 `stepService.startStep` 以 thread+kind 复用开放 Step（不含轮次/调用身份），`completeBackgroundStep` 以同 kind 最早 Step 结算，`adviceJob.tryCompleteSearchStepForWorkflow` 吞掉异常。P3 必须同时更改启动与结算侧，不能只修完成回调。

每次问题研究的**逻辑调用**在启动事务内一一绑定一个 Step 与一个初始 Operation，保留 Workflow、Thread 不可变 revision、发起轮边界及方法分类。逻辑调用身份复用既有 Operation 身份，不新建调用生命周期表；幂等作用域为 Project/Thread 下的调用请求键并校验载荷，不能用 thread+kind 去重。重复同一调用返回同一绑定；同类新调用/新轮必须生成独立 Step/Operation；同一 Workflow 不代表同一调用。绑定成立且提交后才允许调度，失败须整体回滚，不留下无 Operation 的执行 Step。

完成、失败、取消和对账都按原绑定及当前尝试/修订 CAS，校验所属 Project/Thread/快照，不能按 kind、最早创建时间或当前轮猜 Step。取消只取消该调用，不波及同类其他调用；请求取消与确认终态分别记录，晚到成功不得覆盖已确认取消或更新后的尝试。重试沿原逻辑调用/Step 关联新尝试；如现有机制需产生新 Operation，记录显式 predecessor/逻辑调用身份并限制一个当前尝试，保留初始绑定，不把新 Operation 冒充另一个无关调用。用户另发新调用与重试严格区分。

幂等终态对账保证 Operation 与 Step 最终一致；回调失败保留可重试诊断/待对账状态，使用既有恢复入口再次核验绑定。吞错、找不到绑定、更新零行均不能作为对账成功。历史无法唯一绑定时保留未解析历史并显式诊断，不猜测补绑；P6 对账覆盖启动、跨轮晚到、取消竞态、重复通知与重试。发起轮/快照不随收尾迁移，结果采纳才在当前轮增加输入引用。

Project writer 不替代 Thread/Source/报告自身内容权限。开始前与读取/采纳时重验两端权限；不可访问引用用既有拒绝语义，不泄露标题、计数或错误细节。Source owner、预算、凭据、Knowledge/Memory 发布与外发审批继续走各自规范路径。FINER 为 Frame 可调用方法，旧评估和 Research Context 版本保留，不成通用硬门槛。

成功只完成调用相关 Step；失败/取消保留已合法产物与审计，不能认定检验通过。重试复用现有 Operation 的幂等/取消机制，明确关联新尝试，不重复建 Task、不越预算。过时结果继续属于原快照；采纳必须显式记录它对当前版本是否适用，不能静默覆盖新表述/判断。现有 `adviceJob.tryCompleteSearchStepForWorkflow` 按 Thread/kind 完成后台 Step，P3 必须改为按原调用/Step 精确结算并可重试对账；不能让旧 Workflow 的晚到回调关闭另一轮的新搜索，也不能依赖吞错的 best-effort 回调作为唯一结算。Research 可给证据质量和局部结论，最终问题立场、取舍和下一步仍由 Inquiry 命令决定。

## 6. Task 关联

复用 `task_entity_links`：`entity_type = inquiry_thread`，`entity_id` 为原 Thread ID，角色沿 schema 的 `investigates` / `prepares` / `executes` / `references`。唯一键沿 `(space_id, task_id, entity_type, entity_id, role)`；一个关系可被不同轮次/阶段 Step 引用，多对多不复制 Task。Step 的目标引用追溯当次用途；长期关联不充当轮次进度。

Task 页与问题页分别通过所属读边界读取另一端可见摘要和回链；问题页状态直接取 `tasks.status`。创建并关联须同事务，关联已有 Task 验证两端与 Project 一致。链接不改变 owner/visibility，也不扩展 Task 完成条件；Task/Plan 结果被引用后仍遵循产物权限。Task 可无 Thread，Thread 可无 Task，无研究需求就不创建 Research。

## 7. 旧客户端、历史与链接兼容矩阵

兼容仅限历史读取、旧链接解析和明确的退役错误，不是双写或两套活动模型。P2 定义协议版本，P4 切断旧 Task writer，P5 迁移入口，P6 验证升级窗口。旧字段待前端/Agent/外部消费者审计与升级证据齐全后单独移除，不在 P1 删除。

| 旧入口/数据 | 目标行为及责任阶段 | 不能做的转换 |
| --- | --- | --- |
| `task.advance_stage` / Task stage HTTP 写入 | P4：有权调用者收到明确退役错误（HTTP 410；工具结构化退役原因），指向 `task.set_status` 或问题工作命令；未授权仍先遵守拒绝语义 | 不静默改看板、不自动建 Thread |
| Board/Work/Attention 的 loop/stages/visited/loop_stage | P4：活动 DTO 保持 null/空，字段标 historical/deprecated；事件历史按原值及内容权限可读 | null 不证明历史不存在；不能只留表却无访问路径 |
| Task Loop 表/`task.stage_changed` 事件 | 只读历史；原 ID/actor/顺序不变；P4 明确历史读入口，P6 对账 | 不依据阶段推导 status/问题 |
| Inquiry 旧 stage/kind | 历史解码及旧客户端读协议保留旧语义，目标新投影显式版本；未知新版本旧客户端应提示升级 | 不重用旧枚举承载新语义，不反向编造旧阶段完成 |
| 旧 Iteration/conclusion 写入 | P2：原有实质变化约束保留，HTTP/Agent 旧版本适配按 §4.1 将一次旧结论原子关联一次收尾；Candidate/undo 固定不收尾；新无变化收尾用新合同 | 不放宽认知 guard，不双计轮次 |
| 旧 Research 调用/记录 | P3：保留 Workflow/Operation/报告身份与 snapshot；由适配边界接入能力合同 | 不新造问题、不重写旧评估或下一步历史 |
| `/research?research=new&thread=…`、`?tab=focus` | P5：选定问题工作区的研究调用区；缺 Thread 时选择问题，保留设置；无权/不存在按规范提示 | 不仅打开页面就创建问题/调用 |
| `?tab=reports|runs|reading|checklist` | P5：保留目标 ID、筛选、Thread/Workflow 参数到问题内记录；跨问题走项目级记录 | 不丢查询条件，不猜 Thread |
| `/research/reports/:reportId` | 保留可直达报告与返回上下文；报告无 Thread 仍项目级可读 | 不强行重定向到任意问题 |
| `?tab=standing`、`/operations` | standing→问题列表汇总；operations→项目研究运行记录，保留过滤条件 | 不维持第二份问题下一步控制 |
| 无关联历史记录/无法解析链接 | 项目级只读入口或恰当不可访问提示，保留原 ID；浏览器后退可用 | 不删数据、不以默认问题掩盖错误 |
| Sources/监测/日常阅读及原 Library 链接 | 保持直达，读取权限不变 | 不经过问题选择器或 FINER |

切换以新写入端、读端和旧 URL 解析同时就绪为条件。应用中无新旧双权威；兼容解码不写旧阶段。迁移扩展先于应用切换，遵守 B59 的旧构建可读约束；尚未支持新数据的旧应用不能盲目回滚。无生产数据删除授权，升级/备份恢复演练归 P6，部署需另行授权。

## 8. 源码盘点与迁移落点

本节为 P1 工作树核查，包含尚未提交的 Task Loop 退役，不代表已发布。检索范围为 `server/src`、`packages/protocol/src`、`apps/web/src`；通过 `INQUIRY_STAGE|deriveStages|next_focus|iteration_id`、`task_loop_states|task.stage_changed|loop_stage|advance_stage` 和 Research 路由/查询构造追踪读写。实现阶段须重跑检索，不能只改以下入口后宣称完成。

| 读/写/链接 | 当前落点（相对仓库根） | 后续处理 |
| --- | --- | --- |
| 旧阶段词汇/帮助/分类 | `packages/protocol/src/inquiry.ts` | P2 版本化合同，不机械改字符串 |
| 前端阶段/轮次/推荐计算 | `apps/web/src/modules/projects/problemWorkspace/`（`ProblemAreaPage.tsx`、`ProblemWork.tsx`、`useProblem.ts`）；`InquiryAreaPage.tsx`、`inquiryArea/roundFacts.ts` 消费或构造入口 | P2 服务端投影；P5 UI/推荐使用统一读结果 |
| Step 写入/轮次赋值/焦点投影 | `server/src/modules/inquiry/stepService.ts` | P2 分离方法、工作类型与执行/注意力，保留单 primary 约束 |
| 认知、工作、定义、生命周期 | `inquiry/iterationService.ts`、`threadService.ts`、`threadRevisionService.ts`、`routes.ts` | P2 收尾和认知路径分离；保留受保护字段与完整内容权限 |
| 认知撤销 | `server/src/modules/projectWork/updateUndo.ts`、`updatesReadModel.ts`、`domainWorkEvents.ts`；`inquiry/threadWorkEvents.ts` | P2 认知撤销不收尾，新增收尾事件/Updates/补偿按 §4.2 同步落地 |
| Candidate 推进 | `inquiry/signalService.ts` | P2/P3 核对建议采纳、完成搜索及 Candidate→Iteration，不旁路新收尾 |
| Research 开始/结束回写工作 | `projectResearch/researchProblemCalls.ts`、`projectResearch/pipeline/researchAcquisitionService.ts` | P3 保留调用事实，去掉执行层替问题选择下一步的权力 |
| Research 内阶段/重试/进度 | `projectResearch/orchestrator.ts`、`operationProjection.ts`、`researchStages.ts`、`routes.ts`、`repository.ts`、`pipeline/` | P3 保留 pipeline 与取消/重试治理；不把内部阶段当问题阶段 |
| Task 阶段历史 writer/模型 | `projectWork/eventWriter.ts`、`eventKinds.ts`；`server/src/db/schema/projectWork.ts` | P4 停用活动 writer，但保留历史读取与事件约束 |
| Task 活动入口/结算 | `projectWork/routes.ts`、`taskActions.ts`、`projectWorkSystemActionExecutors.ts`、`settlement.ts`；`tasks/projectIntegration.ts` | 基线已停用部分入口；P4 核验全部消费者/权限及兼容错误 |
| Task 读投影/展示 | `projectWork/boardReadModel.ts`、`agentAttention/repository.ts`、`readModel.ts`；协议 `projectWork.ts`/`agentAttention.ts`；`BoardCard.tsx`、`ProjectPulse.tsx`、`TaskWorkTab.tsx`、`TaskDetailPage.tsx`、`apps/web/src/api/client.ts` | P4 迁移读合同/历史；P5 回链；不恢复活动 Loop |
| Agent 工具及策略 | `packages/protocol/src/systemActions.ts`、`policy.ts`；服务端 `systemActions/`、`projectWork/index.ts`、`skills/workSkill.ts`、`agents/spaceAssistantService.ts`、`policy/decisionCore.ts` | P4 注册/提示/许可同步退役，不只藏 UI |
| 旧路由注册与重定向 | `apps/web/src/modules/projects/ProjectsModule.tsx` | P5 先解析目标再收导航，保留 report ID 与 operations 兼容 |
| Research tab 分流/编辑入口 | `ResearchAreaPage.tsx`、`DeepResearchAreaPage.tsx`、`FocusResearchWorkbench.tsx`、`ResearchSetupDialog.tsx`、`QuestionRefinementPanel.tsx` | P5 移除重复焦点编辑，保留记录入口 |
| 链接生产与返回 | `problemWorkspace/researchLinks.ts`、`ProjectPulse.tsx`、`ResearchReportPage.tsx`、`ResearchResultCard.tsx`、`ResearchOperationRow.tsx`、`ProjectResearchStandingPanel.tsx`、`researchArea/ResearchRunsTab.tsx` | P5 保留上下文与筛选；覆盖母导航、目的页和后退 |
| schema/关系 | `server/src/db/schema/inquiry.ts`、`projectResearch.ts`、`tasks.ts`；`packages/protocol/src/projectResearch.ts` | P2/P3/P4 分属作者，不在 P1 预做迁移 |

补充跨入口链接清单：`server/src/modules/projects/attentionService.ts` 生成提醒链接；`apps/web/src/modules/library/readingLinks.ts`、`LibraryItemReaderPage.tsx` 生成阅读/返回链接；项目目录内 `ResearchScanTimeline.tsx`、`useProjectResearch.ts`、`ProjectSourcesPage.tsx` 也消费或产生研究路径。P5 必须逐项核对，Library/Sources 的直接阅读路径保持原意。`apps/web/src/api/client.ts` 的 `/research` 是 API 调用，不能当页面重定向处理。

表中未带目录的 Inquiry/Research 文件归前列最近的领域目录；前端组件归 `apps/web/src/modules/projects/`。以实际路径为准。

## 9. 设计验收样例与交接

| 案例 | 合同表达（非运行测试通过声明） |
| --- | --- |
| 直接小修复 | Task→执行/验收→done；无需 Thread/Research/五阶段 |
| 无变化收尾 | Verify 引用输入→Conclude 收尾，iteration_id=null；认知字段不动 |
| 跳阶段 | Frame 后显式选择 Act/跳过 Plan，保留原因；Plan 不显示已完成 |
| 返工 | Verify 反证→选择 Plan，同轮新增 Step；也可显式收尾后继续，无历史覆盖 |
| 多任务多轮 | 问题 A 引用三个 Task，B 引用其中同一个；每轮 Step 引用不同用途，状态仍从 Task 读取 |
| 全任务完成但问题未解 | Task 全 done，Thread 保留未决缺口，不自动结束 |
| Research 晚到 | 原快照调用跨收尾继续；结果只更新执行，当前轮显式评估后才纳入判断 |
| 无 Research 的问题 | 排错的日志/测试直接作为 Verify 输入，不创建空研究容器 |

P1 基线已有批量创建与退役实现，全部保留在工作区，不作为 P1 已实现成果。批量功能是既有独立改动；Task 状态/退役后端归 P4，UI 隐藏/回链归 P5，相关测试随所属实现提交。混合文件（协议 systemActions、workSkill、策略、P4/P5 文档）由父 Agent 逐 hunk 分组，不能整文件并入 P1。已提交 CLI 修复不动。

P1 精确提交范围建议：本文件、新 ADR、计划原文，以及 INDEX/BOUNDARIES/旧 ADR/当前态指南中**本次新增的规格路由、限定替代说明和现状纠错 hunk**。基线已有 INDEX 的计划路由可随计划纳入；基线 Task Loop/批量实现及其现状态文档不属于 P1。父 Agent 双审后再决定暂存；本轮不提交、不完成 Project Task。

## 10. P1 审查修正与独立提交边界

B1：以 HEAD 的 ADR0019 decision 4 “The Loop has one wording”为历史依据，ADR0027 取代 decision 1/4 的通用工作进程含义并确立 Task 单一看板状态；不依赖工作区尚未提交的 decision 4 替换。`PROJECT_WORK` 仅顶部 Planned domain change 横幅属于独立 P1 路由，其正文的 Task Loop 退役重写归 P4。未来暂存 ADR0019 时仅选择 Status 后的新增替代说明，保留 HEAD 的 decision 3/4 正文。

B2：§4.1 逐一约束全部四个 recordIteration 调用方；HTTP/Agent 显式意图，Candidate/undo 固定 position_only；§4.2 指定规范事件、Updates 门禁、补偿撤销和依赖冲突，不静默删除/重计后续轮次。

B3：§3.1 规定开放 primary Step 为当前下一步唯一权威，覆盖投影、认知/工作命令、Advice 采纳与 Research 回写；历史意图不驱动当前工作，无执行绑定不开 background。

B4：§5.1 从启动事务建立 Step/逻辑调用/初始 Operation 一一绑定，去重、完成、取消、重试及对账均沿身份与尝试，不能仅改完成侧；吞错不算对账成功。

独立候选检查采用 HEAD 完整文件树，仅叠加 P1 新文档、计划原文及明确的 P1 文档 hunk；验证 ADR0019 原 decision 4 保留、未混入批量 pacing 变更、PROJECT_WORK 正文逐字保持 HEAD、全部开发指南链接可解析。工作区仍保留 P4/P5 基线，不能用整文件暂存代替此选择。当前态指南中的未来横幅不证明引擎已实现；P2/P3 的事件/协议注册、真实 PG 幂等/并发/撤销和调用绑定测试仍是后续实施责任，本次无实现阻塞项需用户决策。
