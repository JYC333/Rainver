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
| A creation-time setup preset distinct from Sources | Two or more real Projects repeat the same setup, and the repeated state cannot be owned by Project Sources/extraction profiles, a saved Workflow, or an owning Area | Projects + owning domains |
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
| **`install` egress has no authorized way to be granted through the product.** A dispatch can set `model_override_json.egress_profile`, which the server composes and no request body reaches — but nothing in the product writes it, so package installs are unreachable outside a code change. The obvious home, a standing flag on the Agent runtime profile, is deliberately not read: `runtime_config_json` is free-form and `canWriteRuntimeProfiles` is a *read* predicate for an ordinary Agent (`agents/repository.ts`), so any member who could see the Agent could widen what its Runs reach. The two runtime-profile routes refuse the key; the guarantee is that nothing reads it, not that no route accepts it. Granting it needs a surface with its own authority check, and ADR 0017 §1 puts egress in the Exposure row — a person's approval per instance, not a checkbox. | Someone needs a Run that installs packages |
| **A Run on the built-in host can bypass the egress proxy.** `HTTP_PROXY` points a Run at the host's proxy and every vendor CLI, git and package manager follows it, but the namespace keeps the container's network (no `--unshare-net` outside the `none` profile), so a process that opens its own socket reaches the Internet directly. The registry refusal is therefore policy, not containment; the proxy's private-range refusal still holds, because the proxy declines rather than the client. Making the whole thing a boundary needs `--unshare-net` plus a userspace network helper (pasta or slirp4netns in the image) and a forwarder inside each namespace, or `CAP_NET_ADMIN` for nftables — the second is a capability this container must not have. | A Run's network reach has to be a guarantee rather than a policy |
| **The built-in execution host's login state is outside every backup.** Managed copies, their vendor logins, Agent runtime profiles and managed workspaces live under `cache/host-daemon/`, which backups exclude by rule and the credential archive does not cover — CLI login state used to live in `secrets/`. A restored instance comes back with no logins on its own execution host. | The daemon's config root moves out of `cache/`, or the credential archive covers it |

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
| **An unrecognised request from a runtime ends its turn as a question.** During a prompt the ACP controller treats any server request other than `fs/*` and `terminal/*` as the runtime asking the person something (`runs/cliConversationProtocol.ts`, `runs/vendorQuestion.ts`): the prompt is cancelled and the turn ends "waiting for an answer". A vendor extension request (`_`-prefixed) the runtime expects to be answered would end a turn the same way. No shipped runtime is known to send one. | A turn is seen ending as a question it never asked, or a runtime adds an extension request |
| **The remote-execution trust narrative lost the surface that carried it.** ADR 0016's consequence — *"execution is isolated on the server host; on a host you own and have paired, it runs with the trust you already extend to that machine … must be visible in the product (pairing flow, dispatch composer)"* — named two surfaces. The conversation-UI plan's P3 deleted the dispatch composer, and the Task page that replaced it as the only way to dispatch to a paired host says nothing about where a Run will execute or under what trust (checked 2026-09-03: no such text in `TaskDetailPage.tsx`). The pairing flow still carries its half. Not a regression introduced knowingly — the ADR consequence was not re-read when the surface was deleted, which is exactly the class of miss the P3 integration review was opened for. Needs a product decision, not a rename: where a person choosing a remote Location should be told what that means. | Next work on the Task dispatch surface, or the first real-usage report of a remote Task run |
| **Codex cancellation is unverified.** Codex internal delegation is accepted rather than disabled (decision below), and `cancellation_reliability` is `best_effort` — whether internal agents stop when the main process is terminated is unknown, so a cancelled Run may still be writing. The probe that would have answered it went with the C3 suite on 2026-09-09; answering it now means observing a real cancelled Run rather than a synthetic one, which is the better evidence anyway. | A cancelled CLI Run is seen to keep writing, or cancellation behaviour is examined deliberately |
| **Funding-aware routing.** The router cannot see cost or funding, so it cannot see that some capacity is already paid for. Design below. The trigger is a configuration state, not a purchase: the candidate query returns one row per runtime profile with at most one credential attached, so a connected subscription alone produces no second candidate. | Two enabled runtime profiles on one agent, same adapter and model, differing in funding channel |
| **Let Project Research stage runs route.** Today they cannot: they pin, so their `route_decisions` rows record a foregone conclusion — no candidate comparison, no usable score trace, and **no fallback chain, so a failed stage cannot retry onto another profile**. Unpinning requires [backlog C3.2](../plans/backlog.md) first, because the pin is currently the only way a caller can insist on the user's chosen provider. Three pins must then go, not one: the `RESEARCH_ADAPTER` constant, the per-run explicit pin, and — decisively — Work Context binding, which derives `explicit` for any run whose Setup carries a runtime profile (`bindRunToWorkContext`, `applyEffectiveWorkContextBindings`). The third is correct for a conversation, where it keeps a run on its owner's credential, and wrong for a system-managed stage. Two constraints found during a reverted attempt: the research profile lookup cannot simply drop its adapter filter, because nothing guards the `system_research` agent against a user-added CLI profile that cannot serve its structured-output contract; and there are six stage run-creation sites, the sixth being the screen/extract stage in `sources/postProcessing`. | Routing can express a provider/model requirement |
| **Internal-delegation routing requirement.** A task that must not be decomposed by the runtime cannot say so: `subagent_disable_mechanism` exists on the candidate but there is no matching request dimension, and adding one needs a producer as well. Only local CLIs have runtime-internal subagents, so nothing it could reject exists yet. Dropped on 2026-08-15 from the routing admission work that shipped in `47efdf59`, for that reason. | A CLI runtime is installed on the built-in execution host |
| **Risk level no longer contains a Run on the built-in host.** `read_only` was the only sandbox level that narrowed what a daemon Run could touch, and a Folder-bound run's floor moved off it on 2026-09-08 — it had left the levels inverted, with a low-risk run unable to write its own workspace while a high-risk one could. Every level now reaches the daemon as `read_write`, so `worktree` and `one_shot_docker` are recorded and honoured by nothing, and risk decides nothing about containment there. What contains a Run is the namespace and its egress profile, which do not vary by risk. Closing this means deciding what a high- or critical-risk CLI Run should actually get that a low-risk one does not — a narrower bind set, no egress, a disposable copy of the Location — or retiring the levels for daemon runs and saying so. | Critical-risk CLI Runs are dispatched in earnest, or the sandbox levels are revisited |
| **The server-side CLI execution subsystem is unreachable but not deleted.** Every vendor CLI adapter is `executor_family: "local_cli"`, which is exactly the predicate (`dispatchesToHostDaemon`) that routes a Run to the daemon port, so `ServerHostExecutionAdapter` now only ever serves managed-API runs. Everything it exists to provide is therefore dead for CLI work: worktree provisioning (`runs/ephemeralSandbox.ts`, `projectFolders/sandbox.ts`), Run Exchange, the code-patch collector, and the `worktree` / `one_shot_docker` sandbox levels, which `resolveSandboxLevelForRuntime` still produces for vendor CLI adapters and nothing then honours. Left in place because the unified-host plan did not authorize the deletion and managed-API runs still construct the same port; it is dead weight rather than a risk. Deleting it means deciding first whether critical-risk CLI Runs get a real containment story or the level is retired. | Critical-risk CLI Runs need containment beyond the strict namespace, or the next cleanup pass through `runs/` |
| **A managed workspace is invisible in the product.** It is the default place an Agent works when a Conversation names no Folder, and nothing can look at it: `folder_read` addresses a directory only by `workspace_location_id`, and a managed workspace has no Location row and no id by design (ADR 0016 section 1, B64). The daemon's heartbeat reports only `{container_kind, container_id, archived_available}` — existence, not contents. Observed 2026-09-08 on the built-in host: a Run reported creating `hello.txt`, the file really was at `<host config>/conversations/<conversation id>/hello.txt`, and there was no way to confirm that from the product. That makes every file an Agent touches in a Conversation unverifiable, which is a gap in what the product promises rather than a missing convenience. Not a boundary relaxation to close: ownership is already settled (one per Conversation), the daemon already runs the same `@rainver/folder-read` PathPolicy and byte/file-count limits it uses for remote Folder browsing, and Conversation visibility is the right gate. What is missing is addressing — `folder_read` needs to accept `{container_kind, container_id}` alongside a Location id, which is an addition to the frame rather than a change. | The first time someone needs to check what an Agent actually wrote in a Conversation — which is now, in practice |
| **The composer offers runtime options the chosen model does not have.** `session_config_options` comes from the host capability snapshot, which the daemon takes at `session/new` with no model selected, so it is the union across models. Measured 2026-09-08 against Codex 0.153.4: `gpt-5.6-luna` supports `low|medium|high|xhigh|max` and `gpt-5.3-codex-spark` only `low|medium|high|xhigh`, while the composer offers `ultra` for both; `fast-mode` exists for luna and not for spark. Picking one the model lacks fails the turn with an accurate but late message. The client cannot narrow it on its own — a model choice carries only `value`/`name`/`description`, no per-model option metadata — so the only generic source is setting the model in a session and reading the options back. The fix is for the capability probe to enumerate the model dimension (it already holds an ACP session; roughly one round trip per model, seconds in total) and store per-model option sets, which also settles `fast-mode`. Enumerating one dimension is a deliberate simplification: option sets could in principle depend on combinations. | Someone picks an effort or toggle their model does not support, or the next work on the composer |
| **Risk level has no effect on CLI dispatch.** Two things independently emptied it. The sandbox level stopped narrowing anything on the built-in host when a Folder-bound Run's floor moved off `read_only` (2026-09-08), and the conformance gate — the router's refusal of non-low-risk or file-shaped CLI work without a passed suite — went with the C3 suite itself (2026-09-09). What contains a CLI Run now is the host namespace, its egress profile and ADR 0008's credential channel, none of which vary by risk, so a `critical` Run and a `low` one are treated identically. That is stated rather than implied, because the levels are still resolved, recorded and shown. Closing this means deciding what a higher-risk CLI Run should actually get that a lower-risk one does not — a narrower bind set, no egress, a disposable copy of the Location — or retiring the levels for CLI runs and saying so. Asset-centric protection is the likelier answer than run grading: today's forbidden-path rules (`.ssh`, `.env`, `credentials`, `*.pem`) apply to Files & Code browsing and not to what a Run reads inside its own workspace. | Critical-risk CLI Runs are dispatched in earnest, or the first time something inside a Folder needed protecting from its own Run |
| **Neither daemon hot-reloads from the server's source mount.** The built-in Host's daemon ships inside the `sandbox-runner` image and changes only when that image is rebuilt; a paired Host uses an installed release. Local development can now build and install a paired Host from the checkout with `ops/scripts/host/build-local-release.sh --install`. The built-in runner still has a `read_only` rootfs and image-bundled `dist`, with no dev source mount/watch. On 2026-09-09 both were stale during acceptance, making version skew look like a product bug. The remaining dev improvement is a source mount plus watch for the built-in runner, which would trade away `read_only` in dev. | The next time local work touches daemon code, or a verification result cannot be explained |
| **Retention and pruning design.** Append-only Run/Event/Evolution/usage data and Artifact storage need explicit retention semantics that preserve audit obligations, Proposal/Artifact provenance, and per-type policy. It cannot be a generic age-based delete job. | The database reaches a few GB, backups exceed 15 minutes, or real Run logs make growth materially visible |
| **Operations runbook consolidation.** One operator page covering service placement and health, backup/restore and host-loss recovery, runtime-tool and credential recovery, retry/alert/scheduler diagnosis, and safe stop and escalation boundaries. | Unattended hardening completes |
| **`executeRun`'s outer catch has no thread-event awareness.** Found 2026-08-22 during the control-center phase-2 P3 closure review (retired plan, git history), sweeping for siblings of a just-fixed gap (four early returns in `remoteHostCliAdapter.ts` that produced a terminal Run with zero `host_thread_events` rows — fixed via `remoteFailureWithEvent`). `orchestrationService.ts`'s `executeRun` generic `catch` (~line 1490) finalizes a Run as failed with no knowledge of `thread_event_sink` at all — it's constructed only locally inside `invokeAdapterUnbounded`'s remote-CLI branch, never threaded up. If `executor.runCommand` in `remoteHostCliAdapter.ts` ever throws instead of resolving (traced one plausible path: a synchronous `ws.send()` throw from `dispatchLaunch` if the registered connection were ever not truly `OPEN`, an anomalous state this registry's own invariants should prevent — not a routine failure like the four just-fixed branches), the Conversation UI's poll-based completion detection (P3, `ThreadConversation.tsx`) has nothing to observe and reproduces the original "stuck Cancel / no diagnostics / no diff" symptom. Broader than P3's scope — this catch has never had thread-event awareness for *any* exception type, predating P1 through P3; not fixed here (review budget exhausted at 3/3 reviewers for this phase, and the fix requires restructuring how far up the call stack `thread_event_sink` is threaded, materially larger than a P3-scoped repair). | A real remote-host Run reaches `executeRun`'s outer catch by a path other than `remoteHostCliAdapter.ts`'s own now-complete status-event coverage |

**Codex internal delegation is not required to be disabled** (decided
2026-08-13). Runtime-internal delegation does not create a separate Rainver
grant. The C3 conformance suite and its route gate were retired on 2026-09-09:
Codex's `subagent_disable_mechanism: unknown` remains a truthful capability
declaration, but it does not pin a route to `low` trust. Effective trust now
derives from the execution Host and responsible owner, as recorded in
[ROUTING.md](../architecture/ROUTING.md). The built-in Host wraps a Run in its
Bubblewrap namespace; a paired trusted Host runs natively. Attribution and
cancellation quality still need real-Run evidence, so the cancellation row
above retains its trigger.

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
| Enabling `autonomous_tick` (Always-on) | Provider-fallback and tool-degradation evidence must exist, because an autonomously launched Run has nobody reading its result. Tool degradation is covered: the `degraded` terminal status and the `managed_tool_degraded` warning event serve it, and no change may remove them while Always-on is enabled. Provider fallback is **not** covered — the `model_provider_mismatch` event this row used to name exists nowhere in the code, so a Run silently served by a fallback Provider's own default model leaves no evidence. Emitting it is an open gap Always-on must close before it is enabled, not a condition that already holds. |
| Any CLI runtime use | Install the runtime on the built-in execution host from the host card and log it in. There is no conformance gate any more: the C3 suite was retired on 2026-09-09 because a one-shot behavioural verdict, cached against a version key and blind to the model actually selected, was not evidence to gate dispatch on. What contains a CLI Run is the host namespace, its egress profile and ADR 0008's credential channel. This covers spawning a vendor CLI and nothing else: it does not gate subscription capacity, which reaches runs through the isolated in-process OAuth channel described by [ADR 0008](../decisions/0008-credential-channel-isolation.md). |
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

Re-derive all eight terms together, including the two name-based ones
(`preference` at 20, and `profile_preference` at 25). `request.runtime_keys` and `request.runtime_profile_is_explicit` are
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
average is grouped by `runtime_key`, so it mixes every funding mode and every
model on that runtime into one number. Either the history CTE gains a finer
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

### The quota cache is joinable now, but the candidate has no host

The obstacle this recorded is gone: subscription quota lives in
`host_runtime_usage`, a table keyed by `(host, adapter, installation)`, so one
SQL query can join it. What remains is that a routing candidate is scored
before its host is settled for a profile that names none — decide whether the
term applies only to host-bound candidates, and record the choice here and in
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
  the `(r.instruction || r.prompt) && <p>...</p>` display line present in
  `RunsPage.tsx` and `RunDetailPage.tsx` can never actually render for a real
  Run. Not a regression — found during P4's discovery review, deferred as
  pre-existing and out of that phase's scope. (A third copy lived in
  `command_center/ThreadDetailPage.tsx`; that page was deleted by the
  conversation-UI plan's P3, which removes the Command Center's thread
  surface entirely.) Revisit only as a fix across both remaining call sites
  together, tied to whatever the intended non-redacted read path for a Run's
  task description turns out to be.

## Rooms — product follow-ups

These items are deliberately outside the first Room release. They are
documented here so they cannot be mistaken for missing enforcement:

| Item | Trigger | Owner |
|---|---|---|
| **Room conversation — live product acceptance.** The deterministic acceptance gate passed on 2026-09-03, and a temporary test identity reached a real Project Room in the browser: the empty Room, roster disclosure, conversation setup, and send preflight rendered correctly. The final managed/host-bound walk was not claimed: it needs a second human, a paired host, and a real provider, while the available test stack has Google OAuth disabled and no paired host/provider configured. | An OAuth-enabled test instance has a second human, a paired host, and a provider account available; then run the Room script in [PRODUCT_ACCEPTANCE.md](../architecture/PRODUCT_ACCEPTANCE.md) through managed and host-bound conversation execution | Rooms + Runtime |
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

## Rooms — discussions

Deferred when bounded Agent-to-Agent discussion shipped (2026-09-24; current
state in [modules/rooms.md](../modules/rooms.md), "Discussions among a
conversation's Agents", and [architecture/EXECUTION_MODEL.md](../architecture/EXECUTION_MODEL.md),
"Containers and Agent-triggered budgets").

| Item | Trigger | Owner |
|---|---|---|
| A second thread level inside a conversation — a discussion with its own view and reading scope instead of a folded group in the one timeline (*Room = channel, Conversation = thread, discussion = a grouped run inside a thread*) | Conversations are observed being used as long-lived channels: several discussions interleaving in one conversation | Rooms |
| Per-directory parallelism for discussion participants — a worktree per participant and a merge, instead of waves that run one Agent at a time in the Conversation's shared directory | Wall-clock complaints about serial waves | Rooms + Hosts |
| An earlier "not converging" detector than the round cap — today two Agents that keep politely `@`-ing each other stop only at the cap | Evidence of polite mutual `@` loops reaching the cap in practice | Rooms |
| A per-discussion subscription allocation below the account reserve line — today the quota gate holds every Agent-triggered turn at one account-level `reserve_pct` | Real usage shows the account-level reserve is too coarse | Rooms + Providers |
| A Space policy for the session rotation share — the design allowed a Space to override the 60 % default (`ROOM_SESSION_ROTATE_SHARE`); it shipped as a constant | A Space needs a different rotation point (a model or vendor that compacts earlier, or cost tuning) | Rooms + Hosts |
| A Space setting for an explicit discussion's default spend cap — the design defaulted it to the Space's pipeline default (ADR 0017), which does not exist as a setting; it shipped as USD 2 (`ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD`) | ADR 0017's bounded pipeline spend gets a Space setting, or USD 2 proves wrong in use | Rooms + Providers |
| An emergent discussion started by a delegation or research result is anchored on that continuation's hidden instruction, not the person's message — kept because folding the timeline from the person's message would split the block around the Manager's reply | The discussion block is seen starting at the wrong place, or the timeline folding changes | Rooms + Web |

## Thread references — deferred at close

Shipped 2026-08-29 (`10a02a31`, `60b86670`, `92375c49`, `27f12464`); these
were deliberately left, each with the reason it is safe to leave.

| Item | Trigger | Why it is safe today |
|---|---|---|
| Agent members are not counted in the disclosure calculus — `disclosureGainedBy` measures human audiences only | A Room's Agents can read a thread's history on behalf of somebody outside the Room's human audience | An Agent's reach is already bounded by its Room grants, which require an active membership in the same Room |
| No `claimTurn` and no cost bound on the attach endpoint; the schema permits 20 picks in one call | A product path emits more than one pick at a time — the picker attaches one | Record and message picks fetch only the ids they name. A whole-session pick's model call runs *before* the transaction opens, so it is never under the Room row lock. What is under the lock is one lookup per conversation pick against a partial index (`ix_messages_external_reference`), which a thread that never held external content has no entry in |
| Two people referencing the same unsummarized session at once both pay for it | Observed duplicate spend, or a second worker process | The outcome is correct — the monotonic upsert settles the write — and the obvious fix, an advisory lock held across the model call, would violate the rule against holding a transaction across a provider call |
| A provider outage during a continuation leaves the first message unsendable; the "attach records instead" fallback was not built | A Space runs without an eligible provider, or an outage is observed during real use | The pick can now be dropped from the composer by hand, so the thread is no longer wedged — only the reference is lost |
| `item_ids` is capped at 200 by the schema with no client-side cap or warning | Somebody hits the raw 422, or a picker gains select-all | Nothing is lost when it happens: the send is refused before anything is written, and the pick survives for the person to narrow. Reachable today — the imported-session page lists up to 2,000 records, each with a checkbox — so this is a rough edge, not an unreachable one |
| `picked` and `disclosure` are not reset by `RoomConversation` itself | A consumer keeps the component mounted across a conversation switch | Both current consumers remount via `key`, so the state cannot outlive its conversation |
| A whole-thread pick of a thread holding external content is labelled `external_untrusted`, but the *summarizer* is not told its input is untrusted | Prompt injection is observed surviving summarization | The label and fence are applied to the carried copy; this is about the summary's own production, which is the Room summary service's contract, not a reference's |

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
| **The Location lease is keyed by Location id, not by directory.** Two Locations registered at the same path, or one nested inside another, are separate leases, so writers in them are not serialized against each other (`packages/host-daemon/src/locationLease.ts`). Keying by the canonical real path would close it, at the cost of resolving paths before the lease. | A host is seen with overlapping Location registrations |
| **An in-place Run's diff capture follows a `.git` file.** A Location whose `.git` is a file (a linked worktree or submodule checkout, or one a Run planted) points the daemon's private-index `git add` at that git directory, so the capture writes loose objects into another repository's object store — never its index, refs or working tree, and nothing it contains is executed (`runLocationGit`, which also keeps git out of nested repositories). Task worktrees refuse such a Location outright. Closing it means capturing only when `<location>/.git` is a real directory, or with `GIT_DIR` pinned, and deciding what a legitimately linked checkout gets instead. | A Location on a linked worktree or submodule is seen in use |
| **A Task worktree's fallback removal checks its path, then deletes by path.** When `git worktree remove` refuses, the daemon deletes the worktree directory and its own entry under `<common>/worktrees` after a final realpath check (`host-daemon/src/taskWorktree.ts`); Node has no `openat`, so another strict Run on the same Location — which has `.git` bound read-write — could swap `<common>/worktrees` for a symlink between that check and `fs.rm`. Only reached when git itself refused the removal. Closing it means deleting by descriptor or inside a namespace. | A Location whose `.git/worktrees` an Agent is seen replacing |
| **Any capture failure quarantines a Task worktree.** `captureWorkspaceTree` returning nothing — git unable to represent the tree, but also a timeout, a refused configuration probe or a full disk — moves the worktree to quarantine and answers the settle `ok: false` (hosts.md, "Location lease, Task worktrees and `git_after`"), so a transient failure costs the Run's uncommitted work its place on the branch (it stays on disk). Telling git's "cannot represent this" from transient failures, and retrying the latter in place, is the refinement. | A quarantine caused by a transient failure is observed |
| **A cancelled Task's parked Run holds its branch delete.** Cancelling a Task does not cancel a Run of it parked on a review request or a delegated Agent, and the `task_branch_delete` job defers while such a Run has not ended, so the branch stays until the Run is resolved. | A cancelled Task's branch is seen surviving a parked Run |
| **A merge's resolution Run is not stopped when its Task leaves `done`.** Reopening or cancelling a Task withdraws its merges (`withdrawTaskMerges`), but a conflict-resolution Run already dispatched runs to its end and spends its quota first; the merge's abort waits for it (`task_busy`). | A reopened Task is seen waiting on a resolution Run |
| **A merge's resolution Run held at the quota gate is invisible.** It is not a Conversation Run, so the gate posts no notice and offers no "continue anyway"; the merge stays `resolving`, which is not an attention status, until the window resets and the minute scheduler admits it. | A merge is seen stuck in `resolving` behind the quota line |
| **Two jobs of one merge are kept apart only by the wake's pre-check, not by a lock.** `wakeTaskMergesForLocations` and `withdrawTaskMerges` enqueue a job only when none is pending or running for the merge, but nothing serialises two that slip through, so an overlap duplicates a step (the host lease and the row's status guards keep it harmless). | A duplicated merge step is observed |
| **No person-facing retry for a blocked merge.** A merge stopped on a conflict, failed checks or a failure is tried again only when the checkout reports its main branch at a commit other than the one the merge was blocked against, or the Task is closed again; a flaky check with no change to the main branch, and a stop the checkout does not show being fixed (the main branch checked out in another worktree, or moved while the checkout is on another branch), have no retry control. Deleting the Task branch after `no_changes` is also best effort, not a durable job, so a host offline at that moment keeps an empty branch. | A person is seen reopening Tasks just to retry a merge |
| **Merge on a real host — acceptance.** The Task branch merge (ADR 0016 §11; `modules/hosts.md`, "Merging a done Task") is covered by fake-host server tests and real-git daemon tests, not end to end: (1) checkout on main — fast-forward alongside non-overlapping edits; overlapping edits wait, then a commit wakes the merge through the heartbeat (paired) or the two-minute refresh (built-in); (2) checkout off main — compare-and-swap; (3) a paired host with git older than 2.38 answers `git_too_old`; (4) a real runtime resolving a conflict in the worktree on its resumed host thread without committing, then continue, verification and finish; (5) the Room notice and the attention item; (6) a paired host forced to update to daemon 0.4.0. | A paired real host and the built-in host with at least one logged-in runtime |
| **Task worktrees quarantined whole are never cleaned up.** A Task worktree the daemon cannot recognise as git's, could not capture, or could not remove (hosts.md, "Location lease, Task worktrees and `git_after`") is moved whole to `<config>/task-worktrees-quarantine/` so nothing an Agent left is deleted uncaptured; nothing removes those directories or tells the person they exist. (The nested repositories and submodule histories kept from a worktree whose work is on the branch are `-retired` and swept after 30 days.) | Quarantined worktrees are observed, or a host disk-usage surface is built |
| **Location git configuration is probed, then used, by two processes.** `runLocationGit` reads the checkout's filter drivers and `core.worktree` with one `git config` and runs the real command in another, so a writer in the Location that swaps `.git/config` between the two can have a driver the probe never saw run as the daemon or the server. Closing it means running Location git inside a namespace, or against a snapshot of the configuration. | Strict Runs share a Location with a daemon-run git call in practice, or any sign of the race being used |
| **Execution-location axis in `DeterministicRouteSelector`** | Phase-1 explicit (project, workspace, runtime) dispatch stops being sufficient — e.g. a project needs "run wherever is free" rather than a user-picked host |
| **Server-host daemon unification** (wrapping the server's own execution in the same daemon protocol as remote hosts, retiring `ServerHostExecutionAdapter` as a special case) | The two execution paths (server-local + daemon) have both been in daily use long enough to know the daemon protocol is stable |
| **Cross-host task-thread migration** (resuming a vendor CLI session on a different host than it started on) | A real workflow needs to move a task between machines mid-thread |
| **Remote quota probing** | A remote host's provider/subscription usage needs visibility from the control plane |
| **Capability-based host routing / distributed scheduling / host leasing** | More than a small fixed set of hosts, or concurrent dispatch contention, makes manual host selection impractical |
| **Multi-user host sharing** (a host accepting Runs from someone other than its registered owner) | A real multi-person household/team wants to share execution hardware — needs its own security design, not an extension of B62/B63 |
| **Host-level isolation for remote (trusted) hosts** (containerizing the daemon's execution, sandboxing per-run) | The trust model needs raising — e.g. a host is shared, or runs untrusted task input |
| **Cross-host workspace sync / divergence detection** | The same project's workspaces on different hosts diverge often enough that silence is costly |
| **Distinct `interrupted` run status + full daemon-reconciliation-on-reconnect** — P3 shipped a narrower version: `HostConnectionRegistry` gives a dropped WS connection `RECONNECT_GRACE_MS` (60s) to resume the same in-flight run before failing it as an ordinary `host_disconnected` failure. A disconnect that outlasts the grace window, or a daemon that reconnects after its process already finished while disconnected, does not get reconciled — the run is already terminal. | A real host with an unreliable network makes 60s too short in practice, or a run's process regularly outlives a disconnect long enough that losing its outcome is costly |
| **Binary-safe remote output-artifact transport** — `RAINVER_OUTPUT_DIR` contents are read back as UTF-8 and uploaded as JSON strings (`packages/host-daemon/src/outputFiles.ts`); a binary deliverable comes back corrupted. | A remote workflow needs to produce a binary output file, not just text |
| **Structured rainver-information channel, distinct from workspace file changes** — real-usage finding, 2026-08-22: the user correctly separated two things this repo currently conflates under one mechanism. (1) Workspace-scope file changes (code, docs — anything meant to become part of the target repo) are fully handled by the daemon's git-diff capture (`gitDiff.ts`, intent-to-add covers new files too) — no upload channel needed. (2) Information meant for Rainver *itself* — something that should get recorded, indexed, or made visible across Projects (a cross-project note, a finding Knowledge/Memory should ingest) — has **no real channel today**. `RAINVER_OUTPUT_DIR`/`remote_output` artifacts were the closest thing, but they're just raw uploaded files with no schema and no consumer (unlike server-host's Run Exchange, which at least validates declared outputs against a `run_output.v1` manifest) — nothing reads them, nothing offers them to Knowledge/Memory, and (found the same day) the P3 Thread conversation UI doesn't even surface them, so anything landing there today is orphaned twice over. The prompt-level nudge that misdirected ordinary workspace writes into this channel was removed as an immediate fix (`remoteHostCliAdapter.ts`); this row is the real channel that removal leaves undesigned. Needs: what shape structured information takes (free text vs. a schema akin to `run_output.v1`), who consumes it (direct Knowledge item, a Memory proposal, a new reviewed-artifact subtype), and whether "cross-project exchange" should just be the existing Knowledge/Memory system rather than a new mechanism. | A real workflow needs a remote (or server-host) run to hand Rainver something other than a workspace file change — e.g. a cross-project finding, a note Memory should ingest |
| **Mid-turn steering** — tool-boundary queue injection and soft interrupt, so a message sent mid-turn reaches the agent before the turn ends (phase 2 shipped one-shot-per-turn with a turn-boundary queue). **The duplex transport this needs is being built by the ACP replatform** (its A2), and ACP's `session/prompt` + `session/cancel` are the protocol surface — so what remains deferred is the *product behavior*, not the plumbing. **Confirmed 2026-08-22 that the capability already exists at the protocol level**: `claude-agent-acp` 0.70.0 advertises `_meta.claudeCode.promptQueueing: true` at `initialize`. That removes the "is this even possible" unknown; it does not change the trigger, because the open questions were always product ones (what a queued mid-turn message should do to the visible conversation, and how it interacts with the per-thread FIFO queue). Room conversations now queue a person's message at the turn boundary (`room_queued_messages`, [modules/rooms.md](../modules/rooms.md)), which is what a person steering a discussion gets today. | The P1 execution-topology work's (Machine/ExecutionHost/WorkspaceLocation dispatch, shipped 2026-08-23) real-usage window closes; next-phase scoping; or turn-boundary queueing proves too slow for people steering a Room discussion |
| **DeepSeek Harness as a runtime candidate** — evaluated 2026-08-22 and **not adopted**. Its sibling entries here (codex, opencode) are gone: both moved into the (now retired, complete) ACP runtime replatform plan, and the `OpenCodeServerAdapter` HTTP/SSE-tunnel mechanism this row used to describe was superseded before anything was built — everything now speaks ACP over one stdio transport. DSH is the only part still deferred, and its disqualifier is a property of DSH rather than of the protocol choice: it is absent from the ACP registry, and **DeepSeek Harness added 2026-08-22 as a third endpoint candidate** (out-of-process JSON-RPC SDK, `session.event`/`session.status` push — same daemon-supervised/tunneled shape; its web server has no auth/TLS, loopback-only by default, so it is never dialed into directly, exactly like opencode serve). Current DSH limits, all verified against its own docs at evaluation time: Claude Code/Codex run only as one-shot subagent workers (fresh process per call, `inheritsParentContext: false`, no session resume, teardown after) — **cannot serve the conversational thread surface today**, which is built on vendor session resume + subscription quota; developer preview with no compatibility promise, and its SDK protocol has no version negotiation, no session-close, no prompt-cancel. Re-evaluation check item #1 at next-phase scoping: has DSH's Claude Code subagent gained context inheritance + session resume — that single change is what would qualify it for the conversational surface. **Absorb regardless of adoption** (reference, zero dependency): (a) when designing the next-phase adapter seam and tunnel protocol, lay DSH's SDK protocol, opencode's HTTP/SSE API, and claude's duplex frames side by side and shape our port from all three — and treat DSH's own admitted protocol gaps (version negotiation, session-close, cancel) as the checklist our tunnel protocol v1 must cover; (b) DSH's layered session-event vocabulary (`turn/start`, `step/start`, `tool/call`, `assistant/chunk`) is the reference point whenever `host_thread_events`' flat schema needs turn/step grouping (P3's conversation UI grouping model, future schema evolution); (c) DSH existing at all hardens the standing "never build our own agent loop / skill runtime / tool registry / subagent orchestration / trajectory engine" list — those all come free from the endpoint side. | The P1 execution-topology work's (Machine/ExecutionHost/WorkspaceLocation dispatch, shipped 2026-08-23) real-usage window closes; next-phase scoping |
| ~~**Replace the Task-path `system_remote_dispatch` placeholder Agent**~~ — **done 2026-09-03** by the conversation-UI plan's P3. Rewriting remote Task dispatch to create its Run synchronously removed the queue that created the placeholder, so the Run now takes a real Agent: `body.agent_id`, else the Task's `assigned_agent_id`. `ensureRemoteDispatchAgent`, the `system_remote_dispatch` agent kind and its per-space unique index are deleted. **This narrows the API**: a remote dispatch on a Task with no assigned Agent and no `agent_id` in the body used to succeed against the placeholder and now returns 422, which is the same bar the server-host branch has always applied. | — |
| **Global IA redesign** (projects listing, home, recents semantics — phase 2 deliberately touched only the Command Center) | Real conversational-surface usage (the P1 execution-topology work's real-usage window) supplies the evidence; then its own plan |
| Resuming [capability-shrink-plan.md](../plans/capability-shrink-plan.md) | The P1 execution-topology work's real-usage window closes (Room returns narrowed to dispatch/supervision — see the Project-kernel P2 row below) |
| **Remote subscription multi-account management** — daemon-side login-state inventory (which account each runtime on a host is logged in as; today's capability probe only checks binary presence), per-account config dirs (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), and web-driven remote login via device-flow URL passthrough over the host WS. Deferred out of the remote-host provider-binding plan (2026-08-24; that plan shipped and was retired 2026-08-28, ledger in git history): one ambient login per machine is sufficient today, and this half alone is as large as that whole plan. Coordinate with the platform-reuse P0 credential/multi-account item — the server-side `CredentialBackend` abstraction should land first. | A real remote machine needs more than one login account per runtime, or server-side selection among a host's accounts |
| **Agent work surface — paired-host acceptance.** The plan (`agent-work-surface-plan.md`, retired 2026-08-28) made this a gate on its own P2 and P3: a Task with one `required_outputs_json` entry dispatched to a paired host; the agent lists its tools, reports progress, submits the output with the declared type, exits; the Task goes `done` with `task.accepted`, the artifact is linked `role = 'output'`, the Run shows the tool calls and the Skill hash, and the run directory is gone. A binding-less and a bound dispatch both work, and a Task with no declared outputs behaves as before. **It was not run** — every phase shipped on real-Postgres and unit coverage instead, and the gate was carried here rather than waived silently. The same dispatch is what would confirm the two conditions that produce a silently tool-less Run: a Host that cannot be resolved to a control-plane address (the adapter says so as a thread diagnostic rather than failing), and a paired daemon predating the `work_surface` launch-frame field, which ignores it while the server has already issued the identity and told the agent to use it. | The next dispatch to a paired host |
| **Instance update — real-machine acceptance.** Carried out of the retired instance-update plan (2026-09-07; current state in [modules/deployment.md](../modules/deployment.md) and [ADR 0020](../decisions/0020-instance-update-through-deployer-pull.md)). Every mechanism is covered by real-Postgres, unittest and DOM tests with docker.sock stubbed; what no test can reach is a real daemon and a real registry. (1) The end to end run: push a trivial change to `master`, wait for `publish-images`, press "Check for updates" and see the new digest, press "Update" with one automation scheduled to fire during the drain — it defers and runs afterwards — watch the stages complete, and confirm the running sha changes while the deployer container's image does not. (2) Break health on purpose once (an env that makes the server fail startup) and confirm the job fails at `health` with the dump path shown. (3) The digest coupling, half settled on 2026-09-07 against a real daemon and the real registry: `docker buildx imagetools inspect --raw` (v0.29.1, the version the deployer image pins) emits the served bytes with no trailing newline, and their sha256 equals the index digest the registry reports for `ghcr.io/jyc333/rainver-server:edge`; a live dev container confirmed the `com.docker.compose.oneoff=False` filter selects it. What remains is the other side of the comparison: that `RepoDigests` on a *pulled* production image names that same index digest, so `update_available` is not stuck true forever. (4) That `migrate.sh --mode prod` run from inside the sidecar resolves host and container paths to the same directories, which is the P0 check no CI can fake. (5) One decision to confirm rather than test: the deployer authenticates with the same `SERVER_INTERNAL_TOKEN` the sandbox runner holds, so a compromised runner could claim a queued job or post a forged `succeeded` — it still cannot create one. ADR 0020 §1 chose that reuse deliberately; confirm it is an acceptable trust boundary for a production instance, or split the credential before relying on the stage events as an audit. | The next update of the production instance |
| **Ambient CLI session import — real-host acceptance.** Carried out of the retired ambient-session-import plan (2026-08-28; current state in [modules/imported-sessions.md](../modules/imported-sessions.md)). Every mechanism below is covered by tests with the daemon round trip stubbed at the connection registry; what no test can reach is the daemon actually driving a runtime on a machine someone uses. (1) The end-to-end run: pair a host, bind a folder, see per-runtime counts arrive on a heartbeat, import, and read the records back. (2) The incremental claims, each of which is a decision the design rests on — a second sync inserts nothing; continuing a session in the terminal and syncing again brings only the new records; deleting a session on the host and syncing marks it `gone` while keeping what it contributed; a session outside the 30-day window stays `present` rather than being swept into `gone` by the enumeration. (3) Visibility with a second Space member present, and ledger totals attributed to the host owner without double-counting on re-sync. (4) Two cost questions a laptop answers and a test cannot: whether the 30-second replay drain ceiling is generous enough for a long OpenCode session on a loaded machine — a replay still streaming when it expires is recorded `partial` and retried, so the failure is visible but wasteful — and whether the ten-minute count refresh, which starts one agent process per runtime, is unobtrusive enough in practice. | A paired real host with its own CLI history in a bound folder |
| **Remote provider binding — real-host acceptance.** Carried out of the retired remote-host provider-binding plan (P2, 2026-08-28); each needs a paired machine and a real provider account, so none could be run on the server alone. (1) Whether Claude Code starts from an empty config directory given only `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — the daemon materializes exactly that shape, so if Claude Code needs login state present, D4's claude_code branch needs redesign, not adjustment. (2) The end-to-end run: claude_code and one config-file runtime each completing a dispatched run against a bound provider with no machine-local login involved, a binding-less dispatch on the same host still using ambient login, and usage attribution rows appearing for the bound runs. (3) Whether OpenCode's `OPENCODE_CONFIG` wins over a project-level `opencode.json` in the working directory — the remote path points `OPENCODE_CONFIG` at the profile because the daemon never writes to the user's checkout; if a workspace's own config layers over it, a bound OpenCode run falls back to ambient credentials, a B67 hole only a real host reveals. (4) Whether the remote ACP controller should carry the binding's model: `createCliConversationController` receives `RunExecutionInput.model`, not the binding's resolved model, which reaches the runtime by its own channel (`ANTHROPIC_MODEL` or the config file); nothing threads a model into a remote run today, so the two cannot diverge yet, but a caller that did would name via `session/set_config_option` a model the bound provider may not serve. (5) OpenCode on an Anthropic-protocol vendor (added 2026-09-24; current state in [modules/runtime-adapters.md](../modules/runtime-adapters.md)): the binding now registers `@ai-sdk/anthropic` on an `anthropic`-route lease (`<lease>/v1` as `baseURL`). Acceptance is a bound OpenCode Conversation whose second turn records `cache_read_input_tokens > 0` in `token_usage_events`; if it does not, the planned fallback is the proxy adding `cache_control: {type:"ephemeral"}` to the last `system` block and last message block on the `anthropic` route only, then re-running. The same run confirms the `/v1/messages` path reaches the Claude-compatible upstream, and that OpenCode's own model-family detection treats the `rainver_provider` model (a `claude-*` id) as Anthropic — the caching depends on it, and it is measured, not assumed. | A paired real host with a provider account; the first bound remote run |
| **Managed workspaces & direct chat — real-host acceptance.** Carried out of the retired managed-workspace plan (`host-agent-managed-workspace-plan.md`, retired 2026-08-30; current state in ADR 0016 and modules/hosts.md/rooms.md/agents.md), then updated by the Conversation execution-context work. Every mechanism is covered by real-Postgres and daemon unit tests with the connection registry stubbed; what no test reaches is the daemon on a machine someone uses. The walk: from `/agents` (no Project) create a managed-workspace Agent on a paired host; chat directly and have it write a file; verify `~/.rainver-host/agents/<id>/direct/<user>/` holds it; add the same Agent to a Room, explicitly create and initialize two Conversations, and verify separate `conversations/<conversationId>/` directories that cannot see the direct-chat file or each other's files; remove the Agent and verify its Conversation × Agent threads close while a shared Conversation directory is archived only after its last live Agent thread closes; stop the daemon and verify preflight blocks send without changing the pinned context; confirm `claude --resume` lists the Agent sessions and ambient import does not import them. | The next session on a paired real host with the rebuilt daemon |
| **Conversation substrate — paired-host acceptance.** Carried from the conversation-substrate work of 2026-09-24 (current state in [modules/hosts.md](../modules/hosts.md) and [modules/rooms.md](../modules/rooms.md)), which the server suite cannot exercise: (1) ACP `usage_update` occupancy — whether Claude Code, Codex and OpenCode each report `used`/`size`, since a runtime that does not never rotates (`host_threads.context_tokens` stays null); (2) handoff rotation on a real session — a Conversation driven past 60 % of its window dispatches the handoff turn, the Agent calls `handoff.write` through `rainver call`, and the person's turn opens a fresh vendor session whose first reply shows it read the handoff; (3) the standing-context digest on a real resume — the second turn's prompt omits the identity block and the Agent still acts in role; (4) the Location lease and Task worktree on a real checkout — two writers on one Location serialize, a Task Run works on `rainver/task-<task_id>` in the daemon's own directory and leaves the person's `git status` clean, its settle leaves one unsigned commit authored by the Agent with no signing prompt, and a runtime that files sessions by cwd (Claude Code) resuming across a Task's Runs; (5) vendor question translation ([modules/runtime-adapters.md](../modules/runtime-adapters.md)) — per runtime, prompt the Agent into its own question tool (Claude Code AskUserQuestion, Codex `request_user_input` in plan mode) and confirm the frame matches `server/test/acpVendorQuestion.test.ts` (modelled from claude-agent-acp 0.70 / codex-acp 1.12 source, not captured), the runtime ends the prompt after `session/cancel` (stop reason `cancelled` or an error, not a hang), the reply lands with "waiting for an answer", and the next message resumes the same vendor session with the answer. | A paired real host with at least one logged-in runtime |
| **Agent identity — paired-host acceptance.** Carried out of the agent-identity-and-memory-boundary plan (retired 2026-09-06; current state in [ADR 0003](../decisions/0003-memory-proposal-flow.md) §4, [modules/hosts.md](../modules/hosts.md) and [modules/rooms.md](../modules/rooms.md)). On a paired host: two Agents on the same CLI and provider in the same Location; one Agent in two Conversations. Verify four distinct profile directories under `agents/<agent_id>/profiles/`, two vendor sessions for the one Agent, zero overlap of CLI memory subdirectories, that an unbound run's state root is its profile (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` pointing inside it) while `HOME` stays the machine's, so `git commit` and `git push` still work from a Task run, and that `POST /agents/:id/host-state/reset` archives that Agent's profiles and nothing else. Two questions to answer in the same session, because only a real runtime can: whether Claude Code starts from a fresh `CLAUDE_CONFIG_DIR` whose only pre-existing content is the linked credential file — the daemon links exactly that one file, so if it also needs a settings or onboarding marker, every subscription-login profile fails to authenticate on its first dispatch and that file joins the link set for the adapter (this is the `host_login` shape; the provider-bound `ANTHROPIC_BASE_URL` shape is the remote provider-binding row's first clause, a different question) — and whether Codex partitions `memories/` under `CODEX_HOME` by working directory, which changes how much CLI scratch a container profile accumulates but not the design. | The next session on a paired real host with the rebuilt daemon |
| **Credential refresh semantics per runtime.** The one thing the agent-identity plan's P1 login-link design rests on (that plan is retired; current state in [modules/hosts.md](../modules/hosts.md)) and no test on the server can reach: for Claude Code, Codex and OpenCode, whether an expired token is rewritten **in place** or via temp-file **rename**. In place → every Agent profile on the host sees the refresh through its link. Rename → the login home gets a new inode; a symlinked profile follows it by path, and a hard-linked one (the Windows fallback) is relinked on its next run because the source is newer, so neither is left pinned to an orphaned credential. What remains unknown is whether a **rotating** refresh token invalidates the siblings between those two moments. Check by linking the file into a scratch directory, forcing a refresh, and comparing inodes; record the answer per adapter next to `credential_file` in `runtimeAdapters/specs.ts`. | A paired real host with a logged-in CLI whose token is near expiry |
| **OpenCode's state root under an unbound run is unverified.** The agent-identity plan's P1 (retired; current state in [modules/hosts.md](../modules/hosts.md)) moves each runtime's state into the Agent's profile through that runtime's own variable rather than by moving `HOME`, so a Task run on a paired machine keeps `~/.gitconfig` and `~/.ssh`. Claude Code (`CLAUDE_CONFIG_DIR`) and Codex (`CODEX_HOME`) are certain — those are the variables their bound bindings already use. OpenCode is pointed at `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` inside the profile, on the documented behavior that its data directory is `$XDG_DATA_HOME/opencode` before falling back to `HOME/.local/share/opencode`. If it ignores XDG, its sessions and auth stay in the machine's own directory — no worse than before this phase, but not the isolation B68 claims. Check by dispatching an unbound OpenCode turn on a paired host and looking for `auth.json` and a session file under the profile. | The first unbound OpenCode dispatch on a paired host |
| **`roomsDb.test.ts` seeds four conversations into one Room concurrently and races its manager constraint.** Observed twice during the agent-identity P1 full-suite runs (2026-09-06), passing on re-run and passing when the file runs alone. `seedConversation` calls `seedRoomManager`, whose `ON CONFLICT (room_id, agent_id)` does not cover `uq_room_agent_members_manager` (one manager per Room), so a `Promise.all` of four seeds can insert two managers at once and one loses. Unrelated to that phase's change — a test-support race that will keep failing CI intermittently. The fix is to seed the manager once before the `Promise.all`, or to make the seed conflict-tolerant on the manager constraint too. | The next intermittent CI failure in that file, or the next change to Room seeding |
| **`host-state/reset` has no web surface.** The endpoint shipped with the agent-identity plan's P1 (retired; current state in [modules/hosts.md](../modules/hosts.md)) and is reachable only by API. Whether "clear this Agent's CLI memory on this host" belongs on the Agent page, the Room roster, or the Command Center is a product placement question that phase did not decide. | The first time clearing an Agent's CLI state is wanted from the product rather than by curl |
| **Bound remote runs cannot see `~/.gitconfig` / `~/.ssh`.** A stated limitation of the retired provider-binding plan, not a defect: a bound run's environment is an allowlist and its `HOME` is a control-plane profile. `SSH_AUTH_SOCK` is admitted because it selects no backend, but an agent that commits or pushes inside the workspace can succeed unbound and fail bound. Widening this means naming exactly which machine state a bound run may see — a B67 decision rather than a convenience. | A bound remote run needs to commit or push |
| **Provider-proxy WS tunnel** — carrying remote CLI model traffic back to the server's provider proxy through the existing host WS connection instead of a directly exposed port. Rejected in that plan's D2: streaming/backpressure over the WS frame protocol is real work with no benefit while a fixed port is exposable. | A deployment where the provider proxy's fixed port cannot be exposed to a host that needs API-provider-bound runs |
| **Prod ingress for remote hosts** — `apps/web/nginx.conf` forwards `/api/` and an exact-match `/internal/hosts/ws` WS-upgrade block for the paired-host daemon; every other `/internal/*` route stays unreachable through it. TLS is still required once a host connects from outside the LAN (see the standing TLS/rate-limiting/CSRF row), and the provider proxy's lease routes should join the same TLS entry then. | First remote host connecting to the prod compose stack from outside the LAN |

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
| **Delete `projects.primary_mode`** — done 2026-09-03 by [ADR 0019](../decisions/0019-project-has-no-type-field.md): the field, `project_brief_versions.primary_mode`, `project_mode_transitions` and the transition API are gone; a Project has no type field. | Closed |
| **Collapse `projectEntitySummaryRegistry` + `projectAttentionRegistry` + `projectModeProjectionRegistry` into one `ProjectDomainContributionRegistry`**, one adapter per domain — `execution_readiness` becomes a contribution sourced from `workspace_locations` + `hosts`; only two new adapter methods (`listWorkItems()`, `listTimelineEvents()`). If a domain has a next action but no attention item, that domain's attention adapter is under-reporting — fix it, never open a second channel. | Same |
| **`ProjectProgressProjection`** — new, read-time-only derived view (progress/phase/blocked/momentum/recent changes/recommended next action/health/needs-attention). Never stored: a short-TTL in-memory cache is the only acceptable performance fix if one is ever needed, not a table — materializing derived state is how it silently becomes a canonical fact nobody re-derives again. | Same |
| **`ProjectOverviewService` simplifies** to a thin renderer over the projection above. | Same |
| **Project Steward** — not a new subsystem, three changes to what exists: `buildRoomProjectStateContext` reads `ProjectProgressProjection` instead of `ProjectOverviewService`; two more proposal-gated Room Manager Agent tools (`task.create`, `run.dispatch`); one model call producing a discardable, recomputable `ProjectAssessment` advisory record (`based_on_projection_at` + source refs) that is never canonical state. The Steward may not write Brief/Task/Decision/milestone/current-state directly — model output becomes a Proposal through the existing policy/approval/apply path, the same as every other domain. | Same |
| **Room stays unsplit as the Project conversation** — planning/advice and dispatch entry are the same surface, never two; a Project conversation is never coding-runtime session storage (that's HostTaskThread's job). Splitting them would force users to remember which sentence goes where. | Same |
| `diff2html` / `react-diff-view` for `apps/web`'s hand-rolled diff review (no diff library exists in the frontend today) | P2 frontend work starts |
| ~~**No thread-level lock serializes a task thread's backend inheritance.**~~ — **closed 2026-09-03** by the conversation-UI plan's P3 and its integration gate. The race was: two overlapping dispatches on one thread, the inheriting one reading the backend before the override commits. Two things now prevent it. The admission takes `lockActiveProjectForMutation` (`SELECT … FOR UPDATE` on the Project row) before either branch, and a thread belongs to exactly one Project through its Location, so two dispatches to one thread serialize. And the admission refuses outright while the thread's latest Run is non-terminal (integration finding IG-M3), so the second dispatch does not merely queue behind the first — it is rejected with 409. Inheritance itself now reads the thread's newest Run (`threadRunBinding`) rather than a message ledger. **Residual, recorded rather than closed**: the revival paths (`resumeRunAfterSupervisorReview`, `requeueRunForRetry`) restart a Run without going through the admission and take no Project lock, so they are not covered by either guard. | A revival path is observed restarting a thread-bound Run alongside a fresh dispatch |

| **Knowledge body search has a hit/miss oracle through the retrieval index.** `bodyMatchSql` (`knowledge/knowledgeRepositoryRows.ts`) gates an `ILIKE` on `full` access, but the sibling arm in `retrieval/searchService.ts` matches `retrieval_chunks.tsv` / `plain_text` with no viewer term. Revalidation redacts the returned text, so no excerpt is disclosed — but the row still comes back as a hit, so a summary-level reader can POST candidate substrings to `/api/v1/knowledge/search` and reconstruct a withheld body a piece at a time. Found by the 2026-09-11 security remediation's integration gate; not fixed there because giving that search a viewer predicate is a design change to the retrieval module, and the same arms very likely carry it for `memory` and `source_item` too. | Someone works on retrieval scoping, or a report of a reconstructed body |
| **The Open Skill importer reads a response body with no ceiling.** `capabilities/skillImporter.ts` calls `await response.text()` before `assertByteLimit` runs, across up to `MAX_PACKAGE_FILES` (200) files, and three `api.github.com` calls read JSON under no limit at all. A member pointing the importer at large files in a repository they control can exhaust the single server process's memory. The host allowlist is why it sits outside `@rainver/outbound-guard`; the allowlist does not bound a body. Found by the same integration gate. | Any work on the skill importer, or an observed memory incident |

Kept deliberately, not part of this deferred set: Brief/versioning/`current_focus`/
`confirmed_decisions_json`/Project Instruction (already the right shape,
canonical A-class facts); Project Operations/Corpus/Areas (out of scope, no
evidence of a problem).

## Schema follow-ups

| Item | Trigger | Owner |
|---|---|---|
| Drop `hosts.daemon_server_url`. Nothing has read or written it since the security remediation's item 1.1 (2026-09-11). Dropping it in the same release would break the release still running while the migration applies. | Every deployed release is one that no longer reads the column | Hosts |

## 2026-10-03 sweep — inherited decisions

从退役的无人值守审计清单迁入（2026-10-05）。以下 D 编号和候选描述保留
原审计的取舍信息，代码位置以 **2026-10-03** 为准，**不是当前实现事实**。
触发条件：对应模块进入产品／权限／生命周期设计决策，或观察到新的正确性、
安全性问题。触发后先对照当前代码和边界重新核实，再决定修实现还是修规范；
不得把迁移视为本轮已确认或已修复。D33、D41 原已解决，不迁入。
本轮修复的 R2 是 Briefing 的 run summary；D7 的 Activity 预览是另一条读取路径。
R8 修复重复整合的事务竞态，没有代替 D85 的记忆所有者／审批人决定。

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

### i18n：是否补齐（待决定）

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

### Other inherited watch and cleanup items

| Item | Trigger |
|---|---|
| R10：同一日记的 reflection 缺少 `(entry_id, reflection_date)` 唯一约束；默认单 worker 顺序执行不触发并发插入。 | 启用多个 server／worker 共用同一数据库前，核查历史重复并增加唯一约束与 `ON CONFLICT` |
| `069#2`：`probe_domain_budget` 按数据库上限 3 处理，旧值 4–10 读出也按 3。 | 决定支持预算 10 时，先迁移约束 |
| `retrievalEvalGroup.test.ts` 历史偶发失败未复现，不能断言由 `dbGroup` 修复消除。 | 再出现同类失败时保留复现证据 |
| 列表拖拽回滚 `104#7` 已修复但未用 jsdom 自动化覆盖，jsdom 无法模拟 dnd-kit 手势。 | 下次改变列表拖拽路径时补适合的浏览器验证 |
| Provider 预设创建失败后的三处设置补偿（`012#3` B 部分）。 | 观察到半完成设置影响正常使用 |
| blob 复用／硬删除清理竞态（`024#4`）；原审计未发现产品硬删除消息路径。 | 引入消息硬删除或发现真实并发清理路径 |
| Sources sweep 饥饿（`074#6`）；原审计触发需要超过 25 个永久阻塞的 Space。 | 观察到这一规模或真实扫描饥饿 |
| 原审计约 508 个未被 index 消费的再导出、约 250 个无法证明无用的导出候选，以及 vendored AI Elements 的 59 个导出／`reasoning.tsx`／`task.tsx` 和 UI 的 9 个导出。数量是历史快照。 | 明确收缩模块公共 API 或更新 vendored 组件时，重新查找真实消费者 |
| capture／captureFiling 两个测试 factory 钩子，`registerProjectSourceRoutingHook` 的默认实现，以及没有 ESLint 配置时的 22 处历史 eslint-disable。 | 对应模块或 lint 配置进入清理范围，先重新核实引用 |
| 原 low 修复第 1–5 批 46 个提交（`83942d94` 到 `5a06e266`）模型署名据原报告与实际执行模型不一致。 | 用户明确要求更正署名；先核实远端状态并单独授权历史改写 |

## Retirement

Remove an item when its trigger fires and the work moves to
[../plans/backlog.md](../plans/backlog.md) or lands, or when the item stops being
true. Retire this file when nothing remains.
