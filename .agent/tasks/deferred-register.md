# Deferred Register

Date: 2026-08-17
Status: every item here waits on a recorded trigger.

Merged on 2026-08-13 from three scattered registers — the Project / Inquiry defer
table, the hardening plan's watch table and trigger-gated sections, and the
capability plan's parked ideas. They were three lists of the same kind of thing
in three files, which is why nobody read any of them.

**Rule:** do not pull an item into active work without its recorded trigger, or a
newly observed correctness or security requirement that supersedes it. Real work
with no trigger belongs in [../plans/backlog.md](../plans/backlog.md).

## Project and Inquiry — usage-triggered

Audited 2026-08-08 and re-checked against the code on 2026-08-13; none is
implemented, as expected for trigger-gated items.

| Item | Trigger | Owner |
|---|---|---|
| A creation-time setup preset distinct from Mode and Sources | Two or more real Projects repeat the same setup, and the repeated state cannot be owned by Primary Mode, Project Sources/extraction profiles, a saved Workflow, or an owning Area | Projects + owning domains |
| Revisit the four-Mode taxonomy | A real Project cannot be classified by how its work advances as research, delivery, operations, or learning | Projects |
| Review cursor/chunking | Measured pending volume makes bounded complete-pool selection too slow/noisy | Inquiry / Knowledge Promotion |
| Thread labels/tags | Navigation or search use demonstrates the need | Inquiry |
| Adaptive Learning scheduling | Real review behavior supplies scheduling requirements | Learning |
| Retrieval Project scope in every recall arm | Large multi-Project results make endpoint post-filtering lossy | Retrieval |
| Shared graph composer/tier tags | A second non-`space_objects` producer or a behavior consumer exists | Graph |
| Additional typed Thread links | A concrete named relationship requires its own lifecycle | Inquiry / Experiments |
| Incident/Runbook aggregates | Demonstrated lifecycle is not owned by Tasks, Runs, Automations, or Activity | Operations |
| Generic conditional branching + Checkpoint migration | A second domain needs runtime-conditional checkpoints | Workflow engine |
| Move question refinement into a Model node | Pre-start refinement must become governed execution provenance | Project Research |

## Rooms — continuation infrastructure

| Item | Trigger | Owner |
|---|---|---|
| Promote domain-carried Room linkage to a rooms-owned event-expectation table (`(event_kind, event_key)` → room/session; domains emit completions without storing Room identifiers) | A third domain needs domain-completion → Room continuation (today: delegation carries its own linkage; research carries `origin_room_id`/`origin_session_id` in `project_operations.progress_json`) | Rooms / Proposals |

## Personal / team content boundary leftovers

[ADR 0013](../decisions/0013-personal-team-content-boundary.md) is implemented;
current-state behavior lives in the ADR and in
[Security and Access Boundaries](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md).
These three were left open deliberately: none blocks single- or two-person use,
and each needs a real second member before its shape is knowable.

| Item | Trigger |
|---|---|
| **Orphaned `private` rows after a member leaves a Space.** Their owner can no longer read them and no one else ever could, so they are unreachable but still counted, indexed, and backed up. Deleting them destroys content the person may return for; reassigning them hands their private material to someone else. | A member actually leaves a real shared Space |
| **Explicit consent to `oversight_mode` when joining an existing Space.** The mode is immutable and visible to members, but nothing makes a joiner acknowledge it before their content lands under it. | Someone joins a Space they did not create |
| **Detail-read auditing beyond the four wired types.** `recordDetailRead` covers Task, Activity, Artifact, and note/`space_object`; Run, Proposal, Agent, Reader annotation, and the Source types record nothing on a detail read, so a demotion disclosure for those reports no readers even when there were some. Mechanical to extend, but each addition is a write on a read path — extend on evidence. | A demotion disclosure for one of those types is actually consulted |

## Runtime and operations

| Item | Trigger |
|---|---|
| **Codex cancellation evidence.** Codex internal delegation is accepted rather than disabled (decision below), and `cancellation_reliability` is `best_effort` — whether internal agents stop when the main process is terminated is unverified, so a cancelled Run may still be writing. The `cancel_reliability` C3 probe already exists; it just cannot run without the binary. | A CLI runtime is installed into the sandbox image |
| **Funding-aware routing.** The router cannot see cost or funding, so it cannot see that some capacity is already paid for. Design below. The trigger is a configuration state, not a purchase: the candidate query returns one row per runtime profile with at most one credential attached, so a connected subscription alone produces no second candidate. | Two enabled runtime profiles on one agent, same adapter and model, differing in funding channel |
| **Let Project Research stage runs route.** Today they cannot: they pin, so their `route_decisions` rows record a foregone conclusion — no candidate comparison, no usable score trace, and **no fallback chain, so a failed stage cannot retry onto another profile**. Unpinning requires [backlog C3.2](../plans/backlog.md) first, because the pin is currently the only way a caller can insist on the user's chosen provider. Three pins must then go, not one: the `RESEARCH_ADAPTER` constant, the per-run explicit pin, and — decisively — Work Context binding, which derives `explicit` for any run whose Setup carries a runtime profile (`bindRunToWorkContext`, `applyEffectiveWorkContextBindings`). The third is correct for a conversation, where it keeps a run on its owner's credential, and wrong for a system-managed stage. Two constraints found during a reverted attempt: the research profile lookup cannot simply drop its adapter filter, because nothing guards the `system_research` agent against a user-added CLI profile that cannot serve its structured-output contract; and there are six stage run-creation sites, the sixth being the screen/extract stage in `sources/postProcessing`. | Routing can express a provider/model requirement |
| **Internal-delegation routing requirement.** A task that must not be decomposed by the runtime cannot say so: `subagent_disable_mechanism` exists on the candidate but there is no matching request dimension, and adding one needs a producer as well. Only local CLIs have runtime-internal subagents, so nothing it could reject exists yet. Dropped on 2026-08-15 from the routing admission work that shipped in `47efdf59`, for that reason. | A CLI runtime is installed into the sandbox image |
| **Retention and pruning design.** Append-only Run/Event/Evolution/usage data and Artifact storage need explicit retention semantics that preserve audit obligations, Proposal/Artifact provenance, and per-type policy. It cannot be a generic age-based delete job. | The database reaches a few GB, backups exceed 15 minutes, or real Run logs make growth materially visible |
| **Operations runbook consolidation.** One operator page covering service placement and health, backup/restore and host-loss recovery, runtime-tool and credential recovery, retry/alert/scheduler diagnosis, and safe stop and escalation boundaries. | Unattended hardening completes |
| **`executeRun`'s outer catch has no thread-event awareness.** Found 2026-08-22 during the control-center phase-2 P3 closure review (retired plan, git history), sweeping for siblings of a just-fixed gap (four early returns in `remoteHostCliAdapter.ts` that produced a terminal Run with zero `host_thread_events` rows — fixed via `remoteFailureWithEvent`). `orchestrationService.ts`'s `executeRun` generic `catch` (~line 1490) finalizes a Run as failed with no knowledge of `thread_event_sink` at all — it's constructed only locally inside `invokeAdapterUnbounded`'s remote-CLI branch, never threaded up. If `executor.runCommand` in `remoteHostCliAdapter.ts` ever throws instead of resolving (traced one plausible path: a synchronous `ws.send()` throw from `dispatchLaunch` if the registered connection were ever not truly `OPEN`, an anomalous state this registry's own invariants should prevent — not a routine failure like the four just-fixed branches), the Conversation UI's poll-based completion detection (P3, `ThreadConversation.tsx`) has nothing to observe and reproduces the original "stuck Cancel / no diagnostics / no diff" symptom. Broader than P3's scope — this catch has never had thread-event awareness for *any* exception type, predating P1 through P3; not fixed here (review budget exhausted at 3/3 reviewers for this phase, and the fix requires restructuring how far up the call stack `thread_event_sink` is threaded, materially larger than a P3-scoped repair). | A real remote-host Run reaches `executeRun`'s outer catch by a path other than `remoteHostCliAdapter.ts`'s own now-complete status-event coverage |

**Codex internal delegation is not required to be disabled** (decided
2026-08-13). Runtime-internal subagents do not widen the permission surface:
they run in the same worktree sandbox, the same freshly cleared `HOME`, behind
the same provider proxy, and under the same Run cost cap, and
file-scope conformance judges the resulting worktree diff regardless of which
internal agent wrote it. What remains is attribution and cancellation quality,
and Codex is already priced for that — its `unknown` declaration makes the
subagent conformance check fail by construction, which pins every Codex route at
`low` trust. The spec keeps `unknown` because that is the truth; inventing a
verified value would be worse. This replaced a former acceptance blocker
requiring a disable mechanism or opt-in Codex; only the cancellation evidence
above remains gated.

## Runtime composition and generated code

Two architectural boundaries were recorded during the 2026-08-14 runtime
boundary audit. The non-trigger-gated registry work is complete; these remain
triggered boundaries, not backlog items. Nothing about them is "not yet built",
and pulling either in early costs an architecture, not a week. Current runtime
composition is recorded in
[runtime-adapters.md](../modules/runtime-adapters.md).

### Cordis / live runtime composition

**Trigger.** At least two real stateful runtime components need in-process
replacement, **and** switching only on the next Attempt or on process restart
causes a demonstrated product limitation. Or: generated runtime extensions
become a real, evaluated product capability.

Neither half is close. The registry inventory in the plan above found seventeen
contribution registries, all populated at boot from a static composition, none
registering in response to a user action, and nothing anywhere unregistering.
The one lifecycle that exists — `scheduler/registry.ts` — belongs to the task
loop, not to the registration.

Until the trigger fires: no Cordis dependency, no `RuntimeCompositionEngine`, no
Everything-is-a-Plugin migration, no live generated code in the main server
process, and no `Registration`/`dispose()` primitive added for architectural
symmetry.

**Record explicitly, because this is the expensive mistake:** a Cordis runtime
scope is not a Space, Project, or Domain scope. Runtime composition answers
"which code is loaded"; Space answers "who may read this". If the trigger ever
fires, the two must not be allowed to become one enum, one id, or one predicate.

**Amended 2026-08-22 — re-evaluated in light of DeepSeek Harness; verdict
unchanged.** Cordis turns out to be DeepSeek-published (its docs live under
the deepseek-harness repo), and DSH — "everything is a plugin", agent loop
included — is its flagship reference implementation. Re-verified the
empirical basis against today's code before re-affirming: `PluginHost`
(`server/src/modules/plugins/host/index.ts`) is still boot-time-only,
synchronous, activate-once, with no deactivate/dispose anywhere; plugin
enablement is request-time DB-flag gating over always-loaded code; the
register/unregister lifecycles the hosts work added since the original audit
(`HostConnectionRegistry`, `CliProcessRegistry`) are data-plane state (live
connections, live processes), not code composition — the exact class the
original entry already excluded via its `scheduler/registry.ts` example.
Neither trigger half has moved. Three context updates, none changing the
verdict:

1. If the trigger ever fires, Cordis is now a *stronger candidate* than at
   the original evaluation (major-vendor maintenance, a serious reference
   implementation, real docs) — this changes post-trigger selection weight,
   not whether the trigger has fired. Counterweight: it currently moves at
   DSH's developer-preview breaking-change pace.
2. DSH-as-runtime-endpoint (see the multi-host section's endpoint row)
   provides an **out-of-process path to consume the Cordis plugin/skill
   ecosystem**: ecosystem plugins run inside a DSH endpoint, and the control
   plane speaks only the SDK protocol. This removes the strongest
   previously-conceivable future reason to adopt Cordis in-process — wanting
   the ecosystem no longer implies importing the programming model.
3. "External plugin-ecosystem compatibility" (third parties writing Agent
   Space extensions against Cordis instead of `PluginHost`) is explicitly
   **not** an additional trigger: it presupposes real third-party developers
   (far off for a personal/family product — other entries in this register
   still wait on a *second user*), and even if it arrived, item 2's endpoint
   path absorbs most of it. Named here so a future discussion cannot route
   around this entry by claiming the trigger list never considered the
   ecosystem argument.

The scope warning above stands unchanged and is *reinforced* by DSH's
existence: in a Cordis world everything becomes a `ctx.*` service, and the
most natural migration mistake would be hanging authorization predicates off
runtime scope.

### Generated executable lifecycle

**Trigger.** A real Automation or Workflow requires generated deterministic code
that cannot be expressed through the existing ActionNode, SystemAction, or
Workflow mechanisms, **and** there is observed reuse value — the same generated
thing wanted a second time.

The future lifecycle is conceptual only: Ephemeral → Candidate → Promoted
Executable Asset. Do not implement schema or runtime for it now, and do not
create the states in anticipation.

Until the trigger fires: generated one-off code stays Run/Attempt-scoped,
execution stays sandbox or subprocess based, promotion is never automatic, there
is no in-process `eval`, and none of it requires Cordis. The parked
**native capability executor** item below is the adjacent decision and stays
disabled on its own terms.

## Enablement gates

These are not deferred work. Each states what must be true before a capability
may be turned on, so they are stated as standing conditions rather than as the
state of any one instance — check the running instance for whether a condition
currently holds.

| Gate | Requirement |
|---|---|
| Enabling `autonomous_tick` (Always-on) | Provider-fallback and tool-degradation evidence must exist, because an autonomously launched Run has nobody reading its result. The `model_provider_mismatch` and `managed_tool_degraded` events serve this; no change may remove them while Always-on is enabled. |
| Any CLI runtime use | Install the runtime into the sandbox image, then run the C3 conformance suite for that runtime×version. Codex additionally carries the cancellation-evidence item above. This gate covers spawning a vendor CLI and nothing else: it does not gate subscription capacity, which reaches runs through the isolated in-process OAuth channel described by [ADR 0008](../decisions/0008-credential-channel-isolation.md). |
| Enabling retry or Always-on once cost is non-null | The Run retry cost cap (`runs/supervisor.ts`) and the autonomy daily cost limit were calibrated before catalog cost reached `estimated_cost_usd`. Re-check both against observed spend before enabling either feature, rather than discovering the thresholds by a run being refused. |
| Controlled product acceptance | Follow [../architecture/PRODUCT_ACCEPTANCE.md](../architecture/PRODUCT_ACCEPTANCE.md). Its OpenCode smoke section depends on the CLI gate above; the managed-API and Source sections do not. |
| Unattended dogfooding | [../plans/unattended-execution-hardening-plan.md](../plans/unattended-execution-hardening-plan.md) must pass its completion gate first. |

## Funding-aware routing — design

Carried over when `runtime-routing-plan.md` was retired on 2026-08-15. Nothing
here is scheduled; it is the design the trigger above unlocks. Current-state
routing facts live in [../architecture/ROUTING.md](../architecture/ROUTING.md).

### Rebalance the scoring terms

With one candidate the scoring function is inert, so re-deriving weights today
would be calibration against no observation. Two candidates that differ is the
first moment any weight is falsifiable.

Re-derive all nine terms together, including the two name-based ones
(`preference` at 20, and `profile_preference` at 25, which is *lower* than the
+30 shape bonus it can lose to). Deleting `executionShapeScore()` may be done
earlier as cleanup, but it is not a behaviour change and must not be recorded
as one. `request.adapter_types` and `request.runtime_profile_is_explicit` are
hard constraints and stay exactly as strict as they are.

### Add the funding dimension to the candidate model

```
funding_mode:        subscription_included | prepaid_token_plan | payg_api | local
quota_utilization:   0..1 | null      # from the broker; null when unknown
quota_resets_at:     timestamp | null
marginal_cash_cost:  number | null    # what this run costs beyond what is paid
```

`funding_mode` is a property of the access path, not of the runtime and not of
the provider. The same runtime reached through a subscription and through an
API key are different funding modes. It belongs on the candidate and must not
be folded into `RuntimeAdapterSpec` or the provider record.

`marginal_cash_cost` cannot simply be derived from `estimated_cost_usd`: that
average is grouped by `adapter_type`, so it mixes every funding mode and every
model on that adapter into one number. Either the history CTE gains a finer
grouping key or marginal cost comes from somewhere else. Decide this explicitly.

### Score quota pressure, not just cost

Subscription capacity is finite, so treating it as free spends it on whatever
runs first. A subscription at 95% utilization with a reset three days out should
be reserved for work that needs it while cheaper channels absorb low-value
tasks.

Derive pressure from `max(session_pct, week_pct)` — the same reduction
`autonomy/automationTarget.ts` already performs. Reuse it rather than inventing
a second definition; if the shared derivation deserves a home, extract it to
one. A stale reading is not a zero reading: `checked_at` and the existing age
check must gate whether the term participates at all.

### The quota cache is not joinable

`credentialBroker.writeQuotaCache()` writes a JSON file, not a table, and the
candidate list is one SQL query that cannot join a file cache. Either the
snapshot gains a table the query joins, or the router enriches candidates
through the broker after the query returns. The second keeps the broker as the
single quota authority and is probably right, but it makes scoring inputs
arrive from two sources — record whichever is chosen, here and in
[../architecture/ROUTING.md](../architecture/ROUTING.md).

### Definition of done

Carried from the retired routing plan. Each needs two candidates that
differ, which is what the trigger provides.

1. Two candidates differing only in funding mode score differently, and the
   difference is attributable in the recorded score components.
2. A subscription above the utilization threshold demonstrably yields to a
   cheaper channel for a low-value task.
3. A stale quota snapshot abstains rather than scoring as unused capacity —
   asserted by a test, not merely intended.
4. The `estimated_cost_usd` grouping question above is resolved and recorded,
   including how `cost_accuracy` (see
   [TOKEN_USAGE_METERING.md](../../docs/TOKEN_USAGE_METERING.md)) separates a
   genuine zero from an unpriced null, so uncosted runs are not treated as free.

### Out of scope when this is picked up

- Not giving the managed path file access. It has no working directory by
  design, a provider API has no file primitive, and a server-side `file.write`
  tool would be a worse version of what a CLI runtime does natively while
  turning an ungated mutation surface loose in the one path that currently has
  none. The related gap — a managed run cannot produce an artifact — is
  [backlog G1.4](../plans/backlog.md).
- Not building a quota subsystem. It exists; this connects a second consumer.
- Not changing the CLI credential channel.
  [ADR 0008](../decisions/0008-credential-channel-isolation.md) records the
  separate managed subscription channel.
- Not adding a user-facing routing configuration surface.
- Not introducing `execution_class` / `transport` on the adapter spec.

## Watch items

- **Run `prompt`/`instruction` are always redacted to `null` on every read** —
  `runToOut()` (`server/src/modules/runs/runReadModel.ts`) unconditionally
  nulls both fields by design ("canonical input remains in its owning
  Message/Run records... never the raw task or rendered context body"), so
  the `(r.instruction || r.prompt) && <p>...</p>` display line already
  present in `RunsPage.tsx`, `RunDetailPage.tsx`, and (as of P4)
  `command_center/ThreadDetailPage.tsx` can never actually render for a real
  Run. Not a regression — found during P4's discovery review, deferred as
  pre-existing and out of that phase's scope (fixing only the newest copy
  would leave the other two inconsistent). Revisit only as a fix across all
  three call sites together, tied to whatever the intended non-redacted
  read path for a Run's task description turns out to be.

## Rooms — product follow-ups

These items are deliberately outside the first Room release. They are
documented here so they cannot be mistaken for missing enforcement:

| Item | Trigger | Owner |
|---|---|---|
| Managed Assistant identity, system prompt, and profile customization | Room usage demonstrates a concrete need for per-Room persona or prompt variation, with an explicit audit/ownership model for who may change it | Rooms + Agents |
| Semantic search over the Room archive | A real Room transcript is large enough that bounded rolling summaries and cursor-based paging no longer answer member questions, and a Room-scoped retrieval contract can preserve the same Project/member boundary | Rooms + Retrieval |

Until those triggers occur, the Manager remains system-controlled and Room
archive access remains the bounded canonical transcript plus rolling summary;
neither item is a hidden extension point in the current API.

| Item | Trigger |
|---|---|
| Browser E2E coverage — note there is currently **none at all**: no Playwright config exists anywhere in the repo, so this is establishing a suite, not broadening one | Second real user, or a frontend regression that loses/corrupts data |
| TLS/rate limiting/CSRF hardening | Any move toward public internet exposure, currently forbidden |
| Multi-user sharing regression expansion | Second member joins a real shared Space |
| Private content carried into shared digests. Only `highly_restricted` is excluded from digests and maintenance outputs; ordinary `private` source content can reach a digest that its owner later shares by hand. Owned by the digest/context mechanism, not by any single digest producer (see [autonomy.md](../modules/autonomy.md)) | Second member joins a real shared Space |
| Offline queue — until then docs must not claim unsupported behavior | Real mobile/offline usage |
| Large-file/module splits | Next substantive edit to the affected oversized file |
| Master-key rotation | Suspected exposure or a future multi-instance requirement |
| Commercialization posture | A real external-user/product decision |

## Parked ideas

Not part of any implementation sequence. Do not pull one in without a separately
observed trigger.

- **OMO / oh-my-openagent integration** — benchmark/reference track only.
- **ML-based routing** — the deterministic Router remains authoritative.
- **Native capability executor** — keep disabled until separately designed and
  policy-gated.
- **Workflow canvas UI** — structured Plan/Workflow views remain sufficient.
- **AgentRunGroup extensions into a task graph** — keep AgentRunGroup as a
  collaboration surface. The delivered Room layer ([rooms.md](../modules/rooms.md))
  does not violate this: AgentRunGroup keeps its "one collaboration task"
  semantics and becomes a task opened inside a Room. Room is a persistent
  conversation container, not a DAG.

## Multi-host control center — deferred by decision

Phases 1 and 2 (both retired, plans deleted, ledgers in git history) and
[ADR 0016](../decisions/0016-control-plane-execution-hosts.md) built a
working dispatch/monitor/review loop across a handful of personally owned
hosts plus the conversational thread surface on top of it; the ACP runtime
replatform plan (retired 2026-08-23, complete) replaced the self-maintained
vendor protocol layer with ACP. These are explicit non-decisions recorded
during those plans' approvals, not oversights.

| Item | Trigger |
|---|---|
| **Remote in-place execution's propose→apply governance ("pit 3")** — changes land on disk before review on a trusted host, inverting this system's usual propose-then-apply order; no design chosen yet. | A dedicated design discussion, per the user's explicit request to revisit this separately |
| **Execution-location axis in `DeterministicRouteSelector`** | Phase-1 explicit (project, workspace, runtime) dispatch stops being sufficient — e.g. a project needs "run wherever is free" rather than a user-picked host |
| **Server-host daemon unification** (wrapping the server's own execution in the same daemon protocol as remote hosts, retiring `ServerHostExecutionAdapter` as a special case) | The two execution paths (server-local + daemon) have both been in daily use long enough to know the daemon protocol is stable |
| **Cross-host task-thread migration** (resuming a vendor CLI session on a different host than it started on) | A real workflow needs to move a task between machines mid-thread |
| **Remote quota probing** | A remote host's provider/subscription usage needs visibility from the control plane |
| **Capability-based host routing / distributed scheduling / host leasing** | More than a small fixed set of hosts, or concurrent dispatch contention, makes manual host selection impractical |
| **Multi-user host sharing** (a host accepting Runs from someone other than its registered owner) | A real multi-person household/team wants to share execution hardware — needs its own security design, not an extension of B62/B63 |
| **Host-level isolation for remote (trusted) hosts** (containerizing the daemon's execution, sandboxing per-run) | The trust model needs raising — e.g. a host is shared, or runs untrusted task input |
| **Cross-host workspace sync / divergence detection** | The same project's workspaces on different hosts diverge often enough that silence is costly |
| **Distinct `interrupted` run status + full daemon-reconciliation-on-reconnect** — P3 shipped a narrower version: `HostConnectionRegistry` gives a dropped WS connection `RECONNECT_GRACE_MS` (60s) to resume the same in-flight run before failing it as an ordinary `host_disconnected` failure. A disconnect that outlasts the grace window, or a daemon that reconnects after its process already finished while disconnected, does not get reconciled — the run is already terminal. | A real host with an unreliable network makes 60s too short in practice, or a run's process regularly outlives a disconnect long enough that losing its outcome is costly |
| **Binary-safe remote output-artifact transport** — `AGENT_SPACE_OUTPUT_DIR` contents are read back as UTF-8 and uploaded as JSON strings (`packages/host-daemon/src/outputFiles.ts`); a binary deliverable comes back corrupted. | A remote workflow needs to produce a binary output file, not just text |
| **Structured agent-space-information channel, distinct from workspace file changes** — real-usage finding, 2026-08-22: the user correctly separated two things this repo currently conflates under one mechanism. (1) Workspace-scope file changes (code, docs — anything meant to become part of the target repo) are fully handled by the daemon's git-diff capture (`gitDiff.ts`, intent-to-add covers new files too) — no upload channel needed. (2) Information meant for agent-space *itself* — something that should get recorded, indexed, or made visible across Projects (a cross-project note, a finding Knowledge/Memory should ingest) — has **no real channel today**. `AGENT_SPACE_OUTPUT_DIR`/`remote_output` artifacts were the closest thing, but they're just raw uploaded files with no schema and no consumer (unlike server-host's Run Exchange, which at least validates declared outputs against a `run_output.v1` manifest) — nothing reads them, nothing offers them to Knowledge/Memory, and (found the same day) the P3 Thread conversation UI doesn't even surface them, so anything landing there today is orphaned twice over. The prompt-level nudge that misdirected ordinary workspace writes into this channel was removed as an immediate fix (`remoteHostCliAdapter.ts`); this row is the real channel that removal leaves undesigned. Needs: what shape structured information takes (free text vs. a schema akin to `run_output.v1`), who consumes it (direct Knowledge item, a Memory proposal, a new reviewed-artifact subtype), and whether "cross-project exchange" should just be the existing Knowledge/Memory system rather than a new mechanism. | A real workflow needs a remote (or server-host) run to hand agent-space something other than a workspace file change — e.g. a cross-project finding, a note Memory should ingest |
| **Mid-turn steering** — tool-boundary queue injection and soft interrupt, so a message sent mid-turn reaches the agent before the turn ends (phase 2 shipped one-shot-per-turn with a turn-boundary queue). **The duplex transport this needs is being built by the ACP replatform** (its A2), and ACP's `session/prompt` + `session/cancel` are the protocol surface — so what remains deferred is the *product behavior*, not the plumbing. **Confirmed 2026-08-22 that the capability already exists at the protocol level**: `claude-agent-acp` 0.70.0 advertises `_meta.claudeCode.promptQueueing: true` at `initialize`. That removes the "is this even possible" unknown; it does not change the trigger, because the open questions were always product ones (what a queued mid-turn message should do to the visible conversation, and how it interacts with the per-thread FIFO queue). | The P1 execution-topology work's (Machine/ExecutionHost/WorkspaceLocation dispatch, shipped 2026-08-23) real-usage window closes; next-phase scoping |
| **DeepSeek Harness as a runtime candidate** — evaluated 2026-08-22 and **not adopted**. Its sibling entries here (codex, opencode) are gone: both moved into the (now retired, complete) ACP runtime replatform plan, and the `OpenCodeServerAdapter` HTTP/SSE-tunnel mechanism this row used to describe was superseded before anything was built — everything now speaks ACP over one stdio transport. DSH is the only part still deferred, and its disqualifier is a property of DSH rather than of the protocol choice: it is absent from the ACP registry, and **DeepSeek Harness added 2026-08-22 as a third endpoint candidate** (out-of-process JSON-RPC SDK, `session.event`/`session.status` push — same daemon-supervised/tunneled shape; its web server has no auth/TLS, loopback-only by default, so it is never dialed into directly, exactly like opencode serve). Current DSH limits, all verified against its own docs at evaluation time: Claude Code/Codex run only as one-shot subagent workers (fresh process per call, `inheritsParentContext: false`, no session resume, teardown after) — **cannot serve the conversational thread surface today**, which is built on vendor session resume + subscription quota; developer preview with no compatibility promise, and its SDK protocol has no version negotiation, no session-close, no prompt-cancel. Re-evaluation check item #1 at next-phase scoping: has DSH's Claude Code subagent gained context inheritance + session resume — that single change is what would qualify it for the conversational surface. **Absorb regardless of adoption** (reference, zero dependency): (a) when designing the next-phase adapter seam and tunnel protocol, lay DSH's SDK protocol, opencode's HTTP/SSE API, and claude's duplex frames side by side and shape our port from all three — and treat DSH's own admitted protocol gaps (version negotiation, session-close, cancel) as the checklist our tunnel protocol v1 must cover; (b) DSH's layered session-event vocabulary (`turn/start`, `step/start`, `tool/call`, `assistant/chunk`) is the reference point whenever `host_thread_events`' flat schema needs turn/step grouping (P3's conversation UI grouping model, future schema evolution); (c) DSH existing at all hardens the standing "never build our own agent loop / skill runtime / tool registry / subagent orchestration / trajectory engine" list — those all come free from the endpoint side. | The P1 execution-topology work's (Machine/ExecutionHost/WorkspaceLocation dispatch, shipped 2026-08-23) real-usage window closes; next-phase scoping |
| **Replace the remote-dispatch agent-FK shim** — implemented in the control-center phase-2 work (retired plan, git history; its C8 decision): `ensureRemoteDispatchAgent` (`server/src/modules/hosts/remoteDispatchAgent.ts`) lazily creates one space-shared, system-owned Agent per space (`agent_kind = 'system_remote_dispatch'`, a new value in `ck_agents_agent_kind`) purely to satisfy `runs.agent_id`/`agent_version_id`'s NOT NULL FKs — its own `adapter_type`/model config are never read by anything (a remote run's execution is driven by `runs.adapter_type`, not the Agent). Written directly (not via `PgAgentRepository.create()`) specifically to avoid that path's real requirements — a model provider for `model_api`-family types, a registered CLI runtime tool version for `local_cli`-family types — neither of which this placeholder needs or should depend on. This whole mechanism must be replaced by the real agent/Room-supervision model, not silently kept | Next-phase agent/Room-supervision model lands |
| **Global IA redesign** (projects listing, home, recents semantics — phase 2 deliberately touched only the Command Center) | Real conversational-surface usage (the P1 execution-topology work's real-usage window) supplies the evidence; then its own plan |
| Resuming [capability-shrink-plan.md](../plans/capability-shrink-plan.md) | The P1 execution-topology work's real-usage window closes (Room returns narrowed to dispatch/supervision — see the Project-kernel P2 row below) |
| **Remote subscription multi-account management** — daemon-side login-state inventory (which account each runtime on a host is logged in as; today's capability probe only checks binary presence), per-account config dirs (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), and web-driven remote login via device-flow URL passthrough over the host WS. Deferred out of [remote-host-provider-binding-plan.md](../plans/remote-host-provider-binding-plan.md) (2026-08-24): one ambient login per machine is sufficient today, and this half alone is as large as that whole plan. Coordinate with the platform-reuse P0 credential/multi-account item — the server-side `CredentialBackend` abstraction should land first. | A real remote machine needs more than one login account per runtime, or server-side selection among a host's accounts |
| **Provider-proxy WS tunnel** — carrying remote CLI model traffic back to the server's provider proxy through the existing host WS connection instead of a directly exposed port. Rejected in that plan's D2: streaming/backpressure over the WS frame protocol is real work with no benefit while a fixed port is exposable. | A deployment where the provider proxy's fixed port cannot be exposed to a host that needs API-provider-bound runs |
| **Prod ingress for remote hosts** — `apps/web/nginx.conf` forwards `/api/` only: there is no `/internal` WS-upgrade block, so a daemon cannot reach the prod compose stack at all (remote pairing has only ever worked through the dev Vite proxy's `/internal` forwarding). TLS is additionally required once a host connects from outside the LAN (see the standing TLS/rate-limiting/CSRF row), and the provider proxy's lease routes should join the same TLS entry then. | First remote host paired against the prod compose stack |

## Project kernel — P2 (deferred by decision)

Decided during the execution-topology and Project control-plane plan (P0/P1
shipped 2026-08-23; the plan is retired, git history holds its D8–D11
reasoning and Project-kernel keep/simplify/delete matrix in full). Execution
was deferred by that plan's own decision, not an oversight: "P1 acceptance
passes and a real-usage window has run" is the trigger for every row below,
and `ProjectProgressProjection`'s exact output fields are deliberately
undecided until real use supplies them, rather than fixed from the retired
plan's design-time guess.

| Item | Trigger |
|---|---|
| **Delete `projects.primary_mode`, `project_brief_versions.primary_mode`, `project_mode_transitions` + `listModeTransitions`/`transitionMode`** — `primary_mode` is read in exactly one place only to render "<mode> mode" text, and actively hides other modes' facts from view; nothing depends on it as real classification logic. | P1 real-usage window closes |
| **Collapse `projectEntitySummaryRegistry` + `projectAttentionRegistry` + `projectModeProjectionRegistry` into one `ProjectDomainContributionRegistry`**, one adapter per domain — `execution_readiness` becomes a contribution sourced from `workspace_locations` + `hosts`; only two new adapter methods (`listWorkItems()`, `listTimelineEvents()`). If a domain has a next action but no attention item, that domain's attention adapter is under-reporting — fix it, never open a second channel. | Same |
| **`ProjectProgressProjection`** — new, read-time-only derived view (progress/phase/blocked/momentum/recent changes/recommended next action/health/needs-attention). Never stored: a short-TTL in-memory cache is the only acceptable performance fix if one is ever needed, not a table — materializing derived state is how it silently becomes a canonical fact nobody re-derives again. | Same |
| **`ProjectOverviewService` simplifies** to a thin renderer over the projection above. | Same |
| **Project Steward** — not a new subsystem, three changes to what exists: `buildRoomProjectStateContext` reads `ProjectProgressProjection` instead of `ProjectOverviewService`; two more proposal-gated Room Manager Agent tools (`task.create`, `run.dispatch`); one model call producing a discardable, recomputable `ProjectAssessment` advisory record (`based_on_projection_at` + source refs) that is never canonical state. The Steward may not write Brief/Task/Decision/milestone/current-state directly — model output becomes a Proposal through the existing policy/approval/apply path, the same as every other domain. | Same |
| **Room stays unsplit as the Project conversation** — planning/advice and dispatch entry are the same surface, never two; a Project conversation is never coding-runtime session storage (that's HostTaskThread's job). Splitting them would force users to remember which sentence goes where. | Same |
| `diff2html` / `react-diff-view` for `apps/web`'s hand-rolled diff review (no diff library exists in the frontend today) | P2 frontend work starts |
| **No thread-level lock serializes a task thread's backend inheritance.** `prepareRemoteTaskRun` reads `currentBinding` and enqueues inside a transaction that takes no thread lock, unlike `advanceThreadQueue`'s advisory lock. Two overlapping API dispatches on one thread can have the inheriting one read before the override commits and then drain after it, flipping the thread's backend mid-conversation — the defect thread inheritance fixed, narrowed to a commit race. Not reachable from the composer, which awaits each send. | A second dispatch surface can send concurrently on one thread (an API client, an agent-driven sender), or the race is observed |
| **A bound Claude run on the *server-host* path still sends its provider's model name over ACP.** `vendorCliAdapter.ts` passes `runtimeBinding.model` into the conversation controller, which reconciles it against Claude's own alias space (`default`/`sonnet`/`opus`/…) where a third-party model name does not exist — so it falls through to the session's current value. On a resumed conversation whose model changed, that re-asserts the previous turn's model while `ANTHROPIC_MODEL` names the new one. The remote path was fixed by not using that channel for Claude at all (`boundAcpModelId`); the same treatment likely applies here. Whether real harm occurs depends on whether claude-code-acp ever reports a concrete third-party model name as `currentValue` rather than only its own aliases — if only aliases, the send is a harmless no-op, since all four `ANTHROPIC_*` variables name the same model. Not changed blind. | A bound server-host Claude conversation is observed running on a model other than the one selected, or a real host confirms the `currentValue` shape |

Kept deliberately, not part of this deferred set: Brief/versioning/`current_focus`/
`confirmed_decisions_json`/Project Instruction (already the right shape,
canonical A-class facts); Project Operations/Corpus/Areas (out of scope, no
evidence of a problem).

## Retirement

Remove an item when its trigger fires and the work moves to
[../plans/backlog.md](../plans/backlog.md) or lands, or when the item stops being
true. Retire this file when nothing remains.
