# Backlog

Date: 2026-10-29
Status: remaining work with no trigger condition, rechecked against the current
working tree (including uncommitted changes). Implementation status here is not
a claim of release, deployment, or real-instance acceptance.

## How to use this file

Every item here is a genuine gap that someone will eventually close; none of
them is waiting on a trigger. Anything that *is* waiting on a trigger, and every
standing enablement gate, belongs in
[../tasks/deferred-register.md](../tasks/deferred-register.md) instead. Nothing
here is scheduled; items are pulled on demand. Reuse-engine replacements are
maintained in [platform-reuse-cleanup.md](platform-reuse-cleanup.md), not duplicated
here. Existing usage and deployment gates remain in force after this review.

Implementation truth remains the code. Current-state architecture belongs under
`.agent/architecture/`; this file is forward-looking only. Remove an item once
its behavior is implemented and recorded in a current-state architecture
document — do not leave a closed section behind as history. That belongs to git.

## 1. Verification Engine

### A2.1 — Manual and model-based verification

`evaluateByType()` still returns `skipped` with
`implementation_status: "deferred"` for both declared types. Finalization treats
skipped required evidence as `verification_incomplete`, not as a pass.

- [ ] Implement the declared `manual_review` verifier lifecycle, including
  durable pending/approved/rejected state and its effect on completion.
- [ ] Implement `model_judge` with a separately selected verifier model, never
  silently reusing the generator model.
- [ ] Add policy, audit, retry, and API read-model coverage.

Constraint: deterministic Verification Engine results remain the completion
authority; model or human judgment must be an explicit verifier result.

The standing Workflow enablement condition is recorded in the
[enablement gates](../tasks/deferred-register.md#enablement-gates).
Evidence: `runs/verification/engine.ts`, `runs/finalizationService.ts`, and
[Verification Engine](../architecture/VERIFICATION_ENGINE.md).

## 2. Workflow / Automation Lifecycle

### B4.1 — Complete Save Run as Workflow lifecycle

Current code provides the Run-detail UI, sanitized preview/extraction, low-risk
draft creation, and a high-risk `workflow_save` Proposal whose acceptance creates
a draft `workflow_template` asset version. Real-PostgreSQL coverage
(`server/test/runWorkflowServiceDb.test.ts`) stops at that draft boundary.
`RunDetailPage.saveWorkflow()` discards the returned proposal/asset/version IDs
after its toast, although the existing Evolution surfaces already own review
and promotion. Independent promotion tests do not close the full journey.

- [ ] Connect the created draft visibly into the existing proposal/promotion
  lifecycle so the user can review and promote it without reconstructing which
  asset came from the source Run.
- [ ] Add end-to-end coverage from source Run through save Proposal (when
  required), draft, promotion/approval, approved version, and subsequent
  Workflow launch.

Constraints: extraction stays sanitized; credentials, host paths, transient Run
IDs, and unreviewed mutable runtime state must not become Workflow definition
content. Always-draft behavior and standard proposal/promotion gates remain in
force.

## 3. Evolution and Artifact Provenance

### D1.2 — Artifact user-edit tracking

The `artifacts` module exposes list/detail/export, with no user-edit endpoint
or revision model. Its current role is an audit/export boundary; domain reports
are read through their owning domain. This work therefore needs an explicit
edit/revision source and ownership contract, not just a missing event hook.
`edited_by_user` flags in research evidence cards and note revisions belong to
those domains and do not establish Artifact revisions.

- [ ] Define the supported edit/revision lifecycle, then record edits with actor, artifact version,
  source Run, and before/after provenance.
- [ ] Convert meaningful edit patterns into evolution evidence/signals without
  treating every edit as an automatic promotion or memory write.
- [ ] Add Project Folder, Artifact, privacy, and cross-space isolation tests.

Interim: Proposal rejection supplies correction evidence. There is no
`request_changes` Proposal lifecycle status or authoritative Artifact revision
event; an emitter branch is not an implemented user flow. See
[../architecture/EVOLUTION_SIGNAL_SYSTEM.md](../architecture/EVOLUTION_SIGNAL_SYSTEM.md).

## 4. Project Surfaces

### Domain contents and classification pagination

Domain contents stop at 200 objects; classification pickers load only 200
Projects and 100 Notes/Knowledge Items. Detail-page classification already
exists and is not remaining work.

- [ ] Add continuation to `focusAreas/service.ts:contents` and the Domain UI.
- [ ] Page the classification pickers in `FocusAreasPage.tsx` without changing
  visibility or classification authority (ADR 0015).

The note-only and concurrent same-kind Inquiry Step extensions have explicit
usage triggers and are tracked in the
[Project/Inquiry register](../tasks/deferred-register.md#project-and-inquiry--usage-triggered).

## 5. Runtime Routing and Provider Setup

### C3.2 — Routing cannot express a provider or model requirement

`routing/router.ts` still has no provider/model requirement independent of an
explicit Runtime Profile. Pinning a Profile preserves the user's backend choice
but does not allow fallback among Profiles satisfying a shared requirement.

- [ ] Define provider/model requirements as a hard filter or scoring term and
  wire both request producers and candidate data.
- [ ] Resolve the `required_tools` inventory contract or remove that channel
  from every producer. Candidate tools now come from
  `runtime_config_json.tools` / `tool_ids` (`routing/repository.ts`), rather
  than an unconditional empty array. Profiles without declarations still fail
  a nonempty requirement; the declarations are not Run tool grants.
- [ ] Cover Task policy, Workflow contract, Plan policy and Automation config
  carriers, including pinned Conversation behavior and retry/fallback.

Constraint: the provider/model requirement must exist before unpinning Research
stage Runs under the [routing trigger](../tasks/deferred-register.md).
Current authority: [Routing](../architecture/ROUTING.md).

### G1.3 — Chat provider presets cover one vendor

MiniMax remains the only chat preset in `providers/presets/`; the other presets
cover embeddings/reranking. The vendor registry already publishes endpoints,
and `AddProviderForm` pre-fills the selected vendor's base URL. The remaining
convenience gap is curated chat model/configuration defaults, not absent vendor
support or mandatory manual endpoint entry.

- [ ] Decide which chat vendors need curated presets and add them, or make the
  deliberate scope of the chat preset catalog explicit in the add-provider flow.

Constraint: presets carry no credentials; vendor identity, capabilities,
endpoint defaults and `api_key_required` remain server-owned. See
[provider-policy.md](../modules/provider-policy.md).

### R1.2 — Select Research acquisition defaults per invocation

Room-invoked `research.start_acquisition` still uses a fixed provider mix
(`arxiv`, `openalex`) and query candidate budget (1,000), while provider/model
selection comes from configured defaults. The Manager or a research Agent does
not choose those parameters for each invocation.

- [ ] Add governed per-invocation selection of provider mix, candidate budget
  and execution model, preserving the user's requested acquisition scope.

`max_items` and `since` are already caller-supplied. Query candidate budget and
acquisition item cap are different controls; do not replace one with the other.
Evidence: `projectResearch/pipeline/researchAcquisitionPipelineJob.ts`,
`projectResearch/executionProfileService.ts`, and
[System Actions](../architecture/SYSTEM_ACTIONS.md#researchstart_acquisition).

## 6. Context Delivery Acceptance

### H2 — Joined prompt-provenance acceptance

Agent Host dispatch now uses `RuntimeContextInvocationGateway`; the ACP adapter
projects its accepted Delivery and hydrates authorized image/resource blocks
without repeating descriptor text. Delegated children and session handoffs use
their own Run request rather than the parent's pending user message. The former
server-managed Agent loop is gone; this is not a two-runtime-authority migration.

Existing focused coverage includes `acpRuntimeContextPrompt.test.ts`,
`remoteHostCliAdapter.test.ts`, `conversationInputService.test.ts`,
`runtimeContextGroup.test.ts`, and `currentRuntimeContextInputRef` cases in
`runOrchestrationService.test.ts`. These establish component contracts; do not
re-list their implemented behavior as missing.

- [ ] Close the joined acceptance record for Room/direct chat, resumed turns,
  attachments, retry, handoff and delegation: match the canonical current input,
  immutable Invocation Snapshot and actual ACP prompt for the same invocation,
  showing no lost or duplicated message/descriptor and the correct continuity.

Current authority: [Runtime Context](../modules/runtime-context.md) and
[Rooms](../modules/rooms.md). Broader Research restructuring remains behind the
[usage and retirement gates](../tasks/deferred-register.md#information-monitoring--usage-and-retirement-gates).

## 7. Execution Runtime

### One Host daemon cannot connect to multiple Rainver servers

Recorded 2026-09-04. The installed daemon currently owns one
`~/.rainver-host/config.json` containing a single `server_url`, `host_id`,
token, and workspace map, and the CLI refuses a second registration in that
configuration root. `RAINVER_HOST_CONFIG_DIR` can select another root, but does
not provide a named-profile CLI or independent service lifecycle. Supporting
multiple servers needs a real multi-instance model rather than an array added
to the singleton config.

- [ ] Introduce named profiles with isolated server credentials and workspace
  mappings.
- [ ] Run profiles as independent systemd instances (for example,
  `rainver-host@work.service`) so connection, restart, logs, and failure state
  do not affect another server.
- [ ] Make `register`, `unregister`, `workspace`, `status`, and `update`
  explicitly profile-aware, including safe defaults and unambiguous output.
- [ ] Cover per-profile credential isolation, simultaneous connections,
  revocation, service lifecycle, and upgrades.

Constraint: one server's revoke, outage, or configuration cleanup must never
stop another profile or expose its token or workspace mappings.

### A provider-bound Host Run's egress snapshot records `local_cli`

`policy/executionControlSnapshots.ts:createForRun` can read the immutable
Runtime Profile's selected provider, but explicitly sets the snapshot's provider
to null for Host dispatch. It records `local_cli` even when
`remoteProviderBinding.resolveRemoteRunBinding` uses that Profile's named
ModelProvider. This is not merely late provider resolution, nor evidence that
dispatch/proxy credential and provider checks are absent.

- [ ] Align the snapshot with the selected backend and actual egress
  classification, preserving credential authorization, provider classification
  and the distinction between Host and server-side network activity.
- [ ] Update policy/read-model tests together; `runtimeContextPolicyDb.test.ts`
  currently asserts the `local_cli` snapshot for this path.

### A strict-Host Task Run cannot declare its output

All Agent CLI Runs now use the Host daemon; the old server-loop versus
remote-loop explanation no longer applies. The gap remains in
`systemActions/scenarioToolAllowance.ts:dispatchToolAllowance`: only
`trusted_host` receives `artifact.submit`; a built-in strict-Host Task Run does
not. `runWorkSurfaceDb.test.ts` asserts this restriction.

- [ ] Verify and complete declaration-to-collected-output materialization for
  strict-Host execution, including declared types, Task links, provenance and
  missing-output failures.
- [ ] Grant `artifact.submit` for that mode only when declarations are applied
  end to end. Reuse the current Host collection/materialization path rather
  than restoring a retired server execution path.

Current behavior: [Hosts](../modules/hosts.md).

### Work Skill provenance is not exposed through its identity read model

`runToolIdentityRepository.ts` stores `skill_content_hash`, and Host dispatch
also mirrors the hash into Run metadata. The identity-column value has no
product reader. The unified Host wire contract already exists in
`packages/protocol/src/hostWire.ts` and is not remaining work.

- [ ] Expose the dispatched Work Skill identity through a supported provenance
  read model, making the delivered version traceable without inventing a second
  identity source. Do not describe all strict-Host evidence as SQL-only: Host
  dispatch already carries the metadata copy.

### Interactive permission gate for headless dispatch

`runs/runPermissionPolicy.ts:decidePermission` selects `allow_once`, then
`allow_always`, or cancels if neither option exists. It records the headless
preauthorization decision; it has no durable wait for a person.

- [ ] Define and implement a suspend/notify/resume authorization lifecycle for
  workflows that require a person to decide an ACP permission request mid-run.
- [ ] Preserve authorization, cancellation, recovery and audit across the wait;
  ordinary runtime questions or `task.request_review` are not substitutes for
  a permission-decision state machine.

This does not authorize changing current headless policy or adding a per-Run
confirmation in place of the high-trust control below.

### Queued research stages still run as Agent Runs

Monitoring comparison, synthesis and critique still create Agent Runs through
`ProjectResearchExecutionProfileService`. Their consumers use declared output
materialization and the Run verification/reconcile/retry path. Ad-hoc analysis
and notebook chat already use bounded provider tasks; that partial migration
does not complete these stage callers.

- [ ] Reuse the existing `runBoundedProviderTask` finalizer and canonical Run
  materialization/verification mechanisms for declared artifacts and evidence.
- [ ] Migrate `monitorComparisonService`, both `pipeline/synthesisCoordinator`
  sites, and retained intake/standing callers together to queued provider-task
  execution; register preparers by stage/capability identifier.
- [ ] Preserve reconciliation and retry evidence. Remove Agent/Profile
  manufacturing in `executionProfileService.ts` only after its remaining
  consumers migrate; remove the `system_research` kind only if unused.

Constraint: each Run must satisfy `ck_runs_execution_shape`; do not leave a
half-migrated producer/consumer pair. Stage identifiers already live in
`projectResearch/researchStages.ts`; capability-layer removal is completed work.
Evidence: `projectResearchSynthesisReconcileDb.test.ts` and
[Execution Model](../architecture/EXECUTION_MODEL.md).

### `high`-trust execution needs an enforced control, not a run-time confirmation

Recorded 2026-09-21. No execution target reaches `high` effective trust
(`routing/repository.ts` `effectiveTrustLevel`), so an Agent whose risk is
`high` or `critical` has no candidate anywhere; the creation form disables
those levels. Owner-triggered Runs on a paired Host are `medium`
(ADR 0016 amendment of 2026-09-21).

Decision recorded with the product owner: do not gate `high` behind a
per-Run confirmation dialog. A confirmation nobody reads is not a control,
and ADR 0017 / B70 already prefer review-after with undo over pre-approval.

- [ ] Define `high` as an explicit, revocable, scoped grant the Host owner
  makes once in the Host settings (which Agents or Projects, for how long),
  visible in the Host status and audit, never a modal at dispatch time.
- [ ] Pair it with review-after: a `high`-risk Run's effects go through the
  existing proposal-gated writers and artifacts so they are visible and
  undoable; irreversible actions keep their existing policy gates.
- [ ] Only then enable `high` / `critical` in the Agent form and add
  `high` to the routing trust table with the grant as its evidence.

Constraint: routing must derive the trust from the stored grant, never from a
registry declaration or a UI label (plan decision recorded in ROUTING.md).

## 8. Imported CLI History

From the ambient-session-import integration gate (2026-08-28); the feature
shipped in `293023c3` / `d162aabf` and the remaining citation-link item does not block it.

- [ ] Make imported-history extraction citations navigable to their source
  records. The Brief stores goal and decision refs as one flat version-level
  `source_refs` array while `confirmed_decisions` remains strings, so the
  statement-to-record pairing no longer exists after extraction. Memory packet
  candidates retain record and session id arrays in the proposal payload, but
  the proposal read DTO does not expose them. The imported-session read route
  takes a session id and returns only the first 2,000 records; there is no
  record-id locator or direct record read route.

  Decide whether the Brief needs a version-level **source records** list or
  exact citations beside each extracted statement. A version-level list must
  not imply that every listed record supports every statement. Exact links
  require preserving statement-to-record refs in the reviewed Brief contract
  and a record-target deep link backed by a read-only locator under the
  imported session's existing `full` access gate. The memory packet surface
  likewise needs a gated candidate projection before its stored refs can be
  rendered. This is the remaining part of the retired plan's Phase 2
  acceptance condition 2.
## 9. Reader 剩余验收与增强

按用户2026-10-29最新决定，实施plan退役，未完成内容集中在此按需拉取。
迁移不代表能力已实现、验收通过或已部署。完整调研与历史证据保留在Git历史：
退役前版本 `8f8ec8b3` 的 `.agent/plans/reader-experience-implementation-plan.md`。
现行行为见 [Reader](../architecture/READER.md)、[Library](../modules/library.md)、
[Information Digest](../modules/information-digest.md)，不再维护第二份实施清单。

### 真实设备与体验验收（E03 / F06 / G03–G06 / H05–H06）

- [ ] 目标手机/PWA的系统软键盘、原生选区手柄、长按、自动高亮开关、范围精调、
  横滑翻篇与竖向滚动冲突；表格/代码横滚及选文不得翻篇。评论输入、工具条、
  保存/取消在键盘弹出后仍可达，旋转后同句和高亮保持。
- [ ] 真实屏幕阅读器与纯键盘走查：结构、动作名称、焦点顺序/返回、目录与批注
  抽屉、对话框、保存中/失败/重试和减少动态效果；撤权不得留旧正文与引文。
- [ ] 物理目标设备测短/长文、中英混排、0/20/200批注、图片晚加载的首屏、选择
  延迟、恢复和内存；先记录设备/系统/浏览器及预算，再报告p50/p95，连续阅读10篇
  检查回收。CPU节流与JS堆不等于真实手机性能或进程内存。
- [ ] 桌面/手机视觉走查：浅深色、hover/focus/选中/禁用/保存/失败，选中与持久
  高亮清晰但不抢正文。像素级Readwise比较需有权访问的登录界面或用户认可截图，
  不能用公开资料推断私有tokens或后端行为。

已有自动证据：实际200%浏览器tab zoom、旋转视口文字锚点恢复、18样本性能/批注
矩阵、10篇SPA JS堆回收、图片晚到恢复、14张浅深状态截图均已通过。
范围调整、私密独立文档笔记、改键、可选横滑、引用/标签JSON导出已实现；
导出不含评论线程。不要把这些重列为待实现，也不能把合成测试冒充上述真机验收。
证据入口：`reader-layout.browser.mjs`、`reader-journeys.browser.mjs`、
`ReaderWorkspace.test.tsx`、`readerPositionsDb.test.ts`、`readerDocumentFidelityDb.test.ts`。

### A08 — 公式、脚注与复杂媒体

- [ ] 专用数学/脚注表示与渲染；基础文章不吞字符，脚注可读且能往返定位。
- [ ] 不支持内容提供可解释退化/原文入口，不同媒体的标注不互套坐标。
  保真PDF/EPUB/视频依赖见H08，不以一般Markdown支持冒充已完成。

### G06 — 平板分页双栏

- [ ] 独立定义横向分页/双列模式、阅读位置和批注坐标，再实施控件；现有连续滚动
  容器适配已完成，侧栏加正文不等于双栏分页。
- [ ] 跨模式及竖屏→横屏→竖屏保持同句和高亮，不混用滚动像素与分页坐标；
  未实现不显示无效分页开关。

### G08 — 真离线阅读与同步

- [ ] 先接受独立架构决策，再定义授权正文缓存、撤权/过期、离线写入队列、冲突、
  回网重新授权及失败语义。现有服务端权威不变，不直接引入第二套同步权威。
- [ ] 断网不伪称已同步，回网复核授权，旧缓存不得成为撤权旁路；SW静态壳缓存
  不是离线阅读。遵守 [Local-first compatibility](../architecture/LOCAL_FIRST_COMPATIBILITY.md)。

### E08 / H08 — 完整导出与后续媒体

- [ ] 完整批注/评论线程归档与批量导出：复用Reader当前授权读取，分别定义引用、
  评论和证据范围；当前引用/标签JSON导出不等于评论归档或全库批量导出。
- [ ] PDF原版、EPUB分页、视频同步转录、TTS分别定义格式、播放/下载、位置与标注
  坐标、依赖及授权边界；按类型路由，不误用重排文本坐标，不放假播放/下载/分页按钮。
- [ ] 如增加全文库检索，复用搜索owner、分页与授权。当前列表只搜标题/摘要/来源，
  文内查找是另一个入口，不以前端过滤当前页冒充全文库检索。

后续复用canonical文档/Notes/批注/位置writer与服务端授权；阅读位置、浏览到底或翻篇
不自动改变已读/推荐画像，打开旧文不静默重解析。部署、读取真实私文或改变实例权限
仍需相应授权。
参考官方产品行为（非Rainver实现证据）：
[外观](https://docs.readwise.io/reader/docs/faqs/appearance)、
[批注](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes)、
[导出](https://docs.readwise.io/reader/docs/faqs/exporting)、
[PDF](https://docs.readwise.io/reader/docs/faqs/pdfs)、
[视频](https://docs.readwise.io/reader/docs/faqs/videos)。

## Completion and retirement

Remove an item once it is implemented and recorded in current-state
architecture, or once it is re-scoped elsewhere. Retire this file when no item
remains.
