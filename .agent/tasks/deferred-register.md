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
| **The remote-execution trust narrative lost the surface that carried it.** ADR 0016's consequence — *"execution is isolated on the server host; on a host you own and have paired, it runs with the trust you already extend to that machine … must be visible in the product (pairing flow, dispatch composer)"* — named two surfaces. The conversation-UI plan's P3 deleted the dispatch composer, and the Task page that replaced it as the only way to dispatch to a paired host says nothing about where a Run will execute or under what trust (checked 2026-09-03: no such text in `TaskDetailPage.tsx`). The pairing flow still carries its half. Not a regression introduced knowingly — the ADR consequence was not re-read when the surface was deleted, which is exactly the class of miss the P3 integration review was opened for. Needs a product decision, not a rename: where a person choosing a remote Location should be told what that means. | Next work on the Task dispatch surface, or the first real-usage report of a remote Task run |
| **Codex cancellation is unverified.** Codex internal delegation is accepted rather than disabled (decision below), and `cancellation_reliability` is `best_effort` — whether internal agents stop when the main process is terminated is unknown, so a cancelled Run may still be writing. The probe that would have answered it went with the C3 suite on 2026-09-09; answering it now means observing a real cancelled Run rather than a synthetic one, which is the better evidence anyway. | A cancelled CLI Run is seen to keep writing, or cancellation behaviour is examined deliberately |
| **Funding-aware routing.** The router cannot see cost or funding, so it cannot see that some capacity is already paid for. Design below. The trigger is a configuration state, not a purchase: the candidate query returns one row per runtime profile with at most one credential attached, so a connected subscription alone produces no second candidate. | Two enabled runtime profiles on one agent, same adapter and model, differing in funding channel |
| **Let Project Research stage runs route.** Today they cannot: they pin, so their `route_decisions` rows record a foregone conclusion — no candidate comparison, no usable score trace, and **no fallback chain, so a failed stage cannot retry onto another profile**. Unpinning requires [backlog C3.2](../plans/backlog.md) first, because the pin is currently the only way a caller can insist on the user's chosen provider. Three pins must then go, not one: the `RESEARCH_ADAPTER` constant, the per-run explicit pin, and — decisively — Work Context binding, which derives `explicit` for any run whose Setup carries a runtime profile (`bindRunToWorkContext`, `applyEffectiveWorkContextBindings`). The third is correct for a conversation, where it keeps a run on its owner's credential, and wrong for a system-managed stage. Two constraints found during a reverted attempt: the research profile lookup cannot simply drop its adapter filter, because nothing guards the `system_research` agent against a user-added CLI profile that cannot serve its structured-output contract; and there are six stage run-creation sites, the sixth being the screen/extract stage in `sources/postProcessing`. | Routing can express a provider/model requirement |
| **Internal-delegation routing requirement.** A task that must not be decomposed by the runtime cannot say so: `subagent_disable_mechanism` exists on the candidate but there is no matching request dimension, and adding one needs a producer as well. Only local CLIs have runtime-internal subagents, so nothing it could reject exists yet. Dropped on 2026-08-15 from the routing admission work that shipped in `47efdf59`, for that reason. | A CLI runtime is installed on the built-in execution host |
| **Codex's own sandbox is never relaxed in strict mode, and turns the Run's workspace read-only.** ADR 0016 §2 wants exactly one boundary inside the built-in host's bubblewrap namespace. Only the daemon half exists: `strictNamespace.ts` exports `RAINVER_STRICT_SANDBOX=1` and **no code reads it**. The runtime-specific half was deferred by phase 1 of the unified-host plan to phase 2, and phase 2 did not write it. **Measured 2026-09-08** in the real `sandbox-runner` container with a real `codex` 0.147.0 binary under the daemon's own argv, correcting the reason this entry first gave: the nested vendor sandbox does *not* fail — user namespaces nest fine and it exits 0 — it stacks a `read-only` default over the Run's own working directory and HOME, so a Run runs and silently cannot write, with nothing in its output naming the second sandbox. The fix is known and was verified in the same place: `sandbox_mode = "workspace-write"` in the copy's `config.toml`, a file the daemon already materializes for a bound Run. Claude Code 2.1.263 has no vendor sandbox at all, so this is Codex-shaped. What remains is confirming how our pinned `codex-acp` adapter applies or forwards the setting, which needs the package on a host. Still the one acceptance blocker carried out of that plan. | A CLI runtime is installed on the built-in execution host — the same trigger as the two entries above, and they should be closed together |
| **Risk level no longer contains a Run on the built-in host.** `read_only` was the only sandbox level that narrowed what a daemon Run could touch, and a Folder-bound run's floor moved off it on 2026-09-08 — it had left the levels inverted, with a low-risk run unable to write its own workspace while a high-risk one could. Every level now reaches the daemon as `read_write`, so `worktree` and `one_shot_docker` are recorded and honoured by nothing, and risk decides nothing about containment there. What contains a Run is the namespace and its egress profile, which do not vary by risk. Closing this means deciding what a high- or critical-risk CLI Run should actually get that a low-risk one does not — a narrower bind set, no egress, a disposable copy of the Location — or retiring the levels for daemon runs and saying so. | Critical-risk CLI Runs are dispatched in earnest, or the sandbox levels are revisited |
| **The server-side CLI execution subsystem is unreachable but not deleted.** Every vendor CLI adapter is `executor_family: "local_cli"`, which is exactly the predicate (`dispatchesToHostDaemon`) that routes a Run to the daemon port, so `ServerHostExecutionAdapter` now only ever serves managed-API runs. Everything it exists to provide is therefore dead for CLI work: worktree provisioning (`runs/ephemeralSandbox.ts`, `projectFolders/sandbox.ts`), Run Exchange, the code-patch collector, and the `worktree` / `one_shot_docker` sandbox levels, which `resolveSandboxLevelForRuntime` still produces for vendor CLI adapters and nothing then honours. Left in place because the unified-host plan did not authorize the deletion and managed-API runs still construct the same port; it is dead weight rather than a risk. Deleting it means deciding first whether critical-risk CLI Runs get a real containment story or the level is retired. | Critical-risk CLI Runs need containment beyond the strict namespace, or the next cleanup pass through `runs/` |
| **A managed workspace is invisible in the product.** It is the default place an Agent works when a Conversation names no Folder, and nothing can look at it: `folder_read` addresses a directory only by `workspace_location_id`, and a managed workspace has no Location row and no id by design (ADR 0016 section 1, B64). The daemon's heartbeat reports only `{container_kind, container_id, archived_available}` — existence, not contents. Observed 2026-09-08 on the built-in host: a Run reported creating `hello.txt`, the file really was at `<host config>/conversations/<conversation id>/hello.txt`, and there was no way to confirm that from the product. That makes every file an Agent touches in a Conversation unverifiable, which is a gap in what the product promises rather than a missing convenience. Not a boundary relaxation to close: ownership is already settled (one per Conversation), the daemon already runs the same `@rainver/folder-read` PathPolicy and byte/file-count limits it uses for remote Folder browsing, and Conversation visibility is the right gate. What is missing is addressing — `folder_read` needs to accept `{container_kind, container_id}` alongside a Location id, which is an addition to the frame rather than a change. | The first time someone needs to check what an Agent actually wrote in a Conversation — which is now, in practice |
| **The composer offers runtime options the chosen model does not have.** `session_config_options` comes from the host capability snapshot, which the daemon takes at `session/new` with no model selected, so it is the union across models. Measured 2026-09-08 against Codex 0.153.4: `gpt-5.6-luna` supports `low|medium|high|xhigh|max` and `gpt-5.3-codex-spark` only `low|medium|high|xhigh`, while the composer offers `ultra` for both; `fast-mode` exists for luna and not for spark. Picking one the model lacks fails the turn with an accurate but late message. The client cannot narrow it on its own — a model choice carries only `value`/`name`/`description`, no per-model option metadata — so the only generic source is setting the model in a session and reading the options back. The fix is for the capability probe to enumerate the model dimension (it already holds an ACP session; roughly one round trip per model, seconds in total) and store per-model option sets, which also settles `fast-mode`. Enumerating one dimension is a deliberate simplification: option sets could in principle depend on combinations. | Someone picks an effort or toggle their model does not support, or the next work on the composer |
| **Risk level has no effect on CLI dispatch.** Two things independently emptied it. The sandbox level stopped narrowing anything on the built-in host when a Folder-bound Run's floor moved off `read_only` (2026-09-08), and the conformance gate — the router's refusal of non-low-risk or file-shaped CLI work without a passed suite — went with the C3 suite itself (2026-09-09). What contains a CLI Run now is the host namespace, its egress profile and ADR 0008's credential channel, none of which vary by risk, so a `critical` Run and a `low` one are treated identically. That is stated rather than implied, because the levels are still resolved, recorded and shown. Closing this means deciding what a higher-risk CLI Run should actually get that a lower-risk one does not — a narrower bind set, no egress, a disposable copy of the Location — or retiring the levels for CLI runs and saying so. Asset-centric protection is the likelier answer than run grading: today's forbidden-path rules (`.ssh`, `.env`, `credentials`, `*.pem`) apply to Files & Code browsing and not to what a Run reads inside its own workspace. | Critical-risk CLI Runs are dispatched in earnest, or the first time something inside a Folder needed protecting from its own Run |
| **Neither daemon updates itself, and a stale one silently verifies nothing.** The built-in host's daemon ships inside the `sandbox-runner` image and only changes when that image is rebuilt; a paired host's is installed from a published release under `~/.local/share/rainver-host/releases/<commit>` with a `current` symlink, and only changes when the installer runs. Local development has no path to either: the server service mounts its source and runs a TypeScript watch, and neither daemon does — `sandbox-runner` cannot, since its rootfs is `read_only` and its `dist` lives in the image. On 2026-09-09 both were stale during acceptance (the paired host 20 commits behind, from before the work began and without `command_run` at all; the runner a day behind, still sending a field the server had stopped accepting), and each cost a round of testing code that was not running — the failure looks like a product bug, not a version skew. Closing this means a dev-mode source mount plus watch for the runner (which trades away its `read_only` in dev) and an installer flag that builds a paired host's daemon from a local checkout. | The next time local work touches daemon code, or a verification result cannot be explained |
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
| **Binary-safe remote output-artifact transport** — `RAINVER_OUTPUT_DIR` contents are read back as UTF-8 and uploaded as JSON strings (`packages/host-daemon/src/outputFiles.ts`); a binary deliverable comes back corrupted. | A remote workflow needs to produce a binary output file, not just text |
| **Structured rainver-information channel, distinct from workspace file changes** — real-usage finding, 2026-08-22: the user correctly separated two things this repo currently conflates under one mechanism. (1) Workspace-scope file changes (code, docs — anything meant to become part of the target repo) are fully handled by the daemon's git-diff capture (`gitDiff.ts`, intent-to-add covers new files too) — no upload channel needed. (2) Information meant for Rainver *itself* — something that should get recorded, indexed, or made visible across Projects (a cross-project note, a finding Knowledge/Memory should ingest) — has **no real channel today**. `RAINVER_OUTPUT_DIR`/`remote_output` artifacts were the closest thing, but they're just raw uploaded files with no schema and no consumer (unlike server-host's Run Exchange, which at least validates declared outputs against a `run_output.v1` manifest) — nothing reads them, nothing offers them to Knowledge/Memory, and (found the same day) the P3 Thread conversation UI doesn't even surface them, so anything landing there today is orphaned twice over. The prompt-level nudge that misdirected ordinary workspace writes into this channel was removed as an immediate fix (`remoteHostCliAdapter.ts`); this row is the real channel that removal leaves undesigned. Needs: what shape structured information takes (free text vs. a schema akin to `run_output.v1`), who consumes it (direct Knowledge item, a Memory proposal, a new reviewed-artifact subtype), and whether "cross-project exchange" should just be the existing Knowledge/Memory system rather than a new mechanism. | A real workflow needs a remote (or server-host) run to hand Rainver something other than a workspace file change — e.g. a cross-project finding, a note Memory should ingest |
| **Mid-turn steering** — tool-boundary queue injection and soft interrupt, so a message sent mid-turn reaches the agent before the turn ends (phase 2 shipped one-shot-per-turn with a turn-boundary queue). **The duplex transport this needs is being built by the ACP replatform** (its A2), and ACP's `session/prompt` + `session/cancel` are the protocol surface — so what remains deferred is the *product behavior*, not the plumbing. **Confirmed 2026-08-22 that the capability already exists at the protocol level**: `claude-agent-acp` 0.70.0 advertises `_meta.claudeCode.promptQueueing: true` at `initialize`. That removes the "is this even possible" unknown; it does not change the trigger, because the open questions were always product ones (what a queued mid-turn message should do to the visible conversation, and how it interacts with the per-thread FIFO queue). | The P1 execution-topology work's (Machine/ExecutionHost/WorkspaceLocation dispatch, shipped 2026-08-23) real-usage window closes; next-phase scoping |
| **DeepSeek Harness as a runtime candidate** — evaluated 2026-08-22 and **not adopted**. Its sibling entries here (codex, opencode) are gone: both moved into the (now retired, complete) ACP runtime replatform plan, and the `OpenCodeServerAdapter` HTTP/SSE-tunnel mechanism this row used to describe was superseded before anything was built — everything now speaks ACP over one stdio transport. DSH is the only part still deferred, and its disqualifier is a property of DSH rather than of the protocol choice: it is absent from the ACP registry, and **DeepSeek Harness added 2026-08-22 as a third endpoint candidate** (out-of-process JSON-RPC SDK, `session.event`/`session.status` push — same daemon-supervised/tunneled shape; its web server has no auth/TLS, loopback-only by default, so it is never dialed into directly, exactly like opencode serve). Current DSH limits, all verified against its own docs at evaluation time: Claude Code/Codex run only as one-shot subagent workers (fresh process per call, `inheritsParentContext: false`, no session resume, teardown after) — **cannot serve the conversational thread surface today**, which is built on vendor session resume + subscription quota; developer preview with no compatibility promise, and its SDK protocol has no version negotiation, no session-close, no prompt-cancel. Re-evaluation check item #1 at next-phase scoping: has DSH's Claude Code subagent gained context inheritance + session resume — that single change is what would qualify it for the conversational surface. **Absorb regardless of adoption** (reference, zero dependency): (a) when designing the next-phase adapter seam and tunnel protocol, lay DSH's SDK protocol, opencode's HTTP/SSE API, and claude's duplex frames side by side and shape our port from all three — and treat DSH's own admitted protocol gaps (version negotiation, session-close, cancel) as the checklist our tunnel protocol v1 must cover; (b) DSH's layered session-event vocabulary (`turn/start`, `step/start`, `tool/call`, `assistant/chunk`) is the reference point whenever `host_thread_events`' flat schema needs turn/step grouping (P3's conversation UI grouping model, future schema evolution); (c) DSH existing at all hardens the standing "never build our own agent loop / skill runtime / tool registry / subagent orchestration / trajectory engine" list — those all come free from the endpoint side. | The P1 execution-topology work's (Machine/ExecutionHost/WorkspaceLocation dispatch, shipped 2026-08-23) real-usage window closes; next-phase scoping |
| ~~**Replace the Task-path `system_remote_dispatch` placeholder Agent**~~ — **done 2026-09-03** by the conversation-UI plan's P3. Rewriting remote Task dispatch to create its Run synchronously removed the queue that created the placeholder, so the Run now takes a real Agent: `body.agent_id`, else the Task's `assigned_agent_id`. `ensureRemoteDispatchAgent`, the `system_remote_dispatch` agent kind and its per-space unique index are deleted. **This narrows the API**: a remote dispatch on a Task with no assigned Agent and no `agent_id` in the body used to succeed against the placeholder and now returns 422, which is the same bar the server-host branch has always applied. | — |
| **Global IA redesign** (projects listing, home, recents semantics — phase 2 deliberately touched only the Command Center) | Real conversational-surface usage (the P1 execution-topology work's real-usage window) supplies the evidence; then its own plan |
| Resuming [capability-shrink-plan.md](../plans/capability-shrink-plan.md) | The P1 execution-topology work's real-usage window closes (Room returns narrowed to dispatch/supervision — see the Project-kernel P2 row below) |
| **Remote subscription multi-account management** — daemon-side login-state inventory (which account each runtime on a host is logged in as; today's capability probe only checks binary presence), per-account config dirs (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), and web-driven remote login via device-flow URL passthrough over the host WS. Deferred out of the remote-host provider-binding plan (2026-08-24; that plan shipped and was retired 2026-08-28, ledger in git history): one ambient login per machine is sufficient today, and this half alone is as large as that whole plan. Coordinate with the platform-reuse P0 credential/multi-account item — the server-side `CredentialBackend` abstraction should land first. | A real remote machine needs more than one login account per runtime, or server-side selection among a host's accounts |
| **Agent work surface — paired-host acceptance.** The plan (`agent-work-surface-plan.md`, retired 2026-08-28) made this a gate on its own P2 and P3: a Task with one `required_outputs_json` entry dispatched to a paired host; the agent lists its tools, reports progress, submits the output with the declared type, exits; the Task goes `done` with `task.accepted`, the artifact is linked `role = 'output'`, the Run shows the tool calls and the Skill hash, and the run directory is gone. A binding-less and a bound dispatch both work, and a Task with no declared outputs behaves as before. **It was not run** — every phase shipped on real-Postgres and unit coverage instead, and the gate was carried here rather than waived silently. The same dispatch is what would confirm the two conditions that produce a silently tool-less Run: a Host whose `daemon_server_url` is empty (the adapter now says so as a thread diagnostic rather than failing), and a paired daemon predating the `work_surface` launch-frame field, which ignores it while the server has already issued the identity and told the agent to use it. | The next dispatch to a paired host |
| **Instance update — real-machine acceptance.** Carried out of the retired instance-update plan (2026-09-07; current state in [modules/deployment.md](../modules/deployment.md) and [ADR 0020](../decisions/0020-instance-update-through-deployer-pull.md)). Every mechanism is covered by real-Postgres, unittest and DOM tests with docker.sock stubbed; what no test can reach is a real daemon and a real registry. (1) The end to end run: push a trivial change to `master`, wait for `publish-images`, press "Check for updates" and see the new digest, press "Update" with one automation scheduled to fire during the drain — it defers and runs afterwards — watch the stages complete, and confirm the running sha changes while the deployer container's image does not. (2) Break health on purpose once (an env that makes the server fail startup) and confirm the job fails at `health` with the dump path shown. (3) The digest coupling, half settled on 2026-09-07 against a real daemon and the real registry: `docker buildx imagetools inspect --raw` (v0.29.1, the version the deployer image pins) emits the served bytes with no trailing newline, and their sha256 equals the index digest the registry reports for `ghcr.io/jyc333/rainver-server:edge`; a live dev container confirmed the `com.docker.compose.oneoff=False` filter selects it. What remains is the other side of the comparison: that `RepoDigests` on a *pulled* production image names that same index digest, so `update_available` is not stuck true forever. (4) That `migrate.sh --mode prod` run from inside the sidecar resolves host and container paths to the same directories, which is the P0 check no CI can fake. (5) One decision to confirm rather than test: the deployer authenticates with the same `SERVER_INTERNAL_TOKEN` the sandbox runner holds, so a compromised runner could claim a queued job or post a forged `succeeded` — it still cannot create one. ADR 0020 §1 chose that reuse deliberately; confirm it is an acceptable trust boundary for a production instance, or split the credential before relying on the stage events as an audit. | The next update of the production instance |
| **Ambient CLI session import — real-host acceptance.** Carried out of the retired ambient-session-import plan (2026-08-28; current state in [modules/imported-sessions.md](../modules/imported-sessions.md)). Every mechanism below is covered by tests with the daemon round trip stubbed at the connection registry; what no test can reach is the daemon actually driving a runtime on a machine someone uses. (1) The end-to-end run: pair a host, bind a folder, see per-runtime counts arrive on a heartbeat, import, and read the records back. (2) The incremental claims, each of which is a decision the design rests on — a second sync inserts nothing; continuing a session in the terminal and syncing again brings only the new records; deleting a session on the host and syncing marks it `gone` while keeping what it contributed; a session outside the 30-day window stays `present` rather than being swept into `gone` by the enumeration. (3) Visibility with a second Space member present, and ledger totals attributed to the host owner without double-counting on re-sync. (4) Two cost questions a laptop answers and a test cannot: whether the 30-second replay drain ceiling is generous enough for a long OpenCode session on a loaded machine — a replay still streaming when it expires is recorded `partial` and retried, so the failure is visible but wasteful — and whether the ten-minute count refresh, which starts one agent process per runtime, is unobtrusive enough in practice. | A paired real host with its own CLI history in a bound folder |
| **Remote provider binding — real-host acceptance.** Carried out of the retired remote-host provider-binding plan (P2, 2026-08-28); each needs a paired machine and a real provider account, so none could be run on the server alone. (1) Whether Claude Code starts from an empty config directory given only `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — the daemon materializes exactly that shape, so if Claude Code needs login state present, D4's claude_code branch needs redesign, not adjustment. (2) The end-to-end run: claude_code and one config-file runtime each completing a dispatched run against a bound provider with no machine-local login involved, a binding-less dispatch on the same host still using ambient login, and usage attribution rows appearing for the bound runs. (3) Whether OpenCode's `OPENCODE_CONFIG` wins over a project-level `opencode.json` in the working directory — the remote path points `OPENCODE_CONFIG` at the profile because the daemon never writes to the user's checkout; if a workspace's own config layers over it, a bound OpenCode run falls back to ambient credentials, a B67 hole only a real host reveals. (4) Whether the remote ACP controller should carry the binding's model: `createCliConversationController` receives `RunExecutionInput.model`, not the binding's resolved model, which reaches the runtime by its own channel (`ANTHROPIC_MODEL` or the config file); nothing threads a model into a remote run today, so the two cannot diverge yet, but a caller that did would name via `session/set_config_option` a model the bound provider may not serve. | A paired real host with a provider account; the first bound remote run |
| **Managed workspaces & direct chat — real-host acceptance.** Carried out of the retired managed-workspace plan (`host-agent-managed-workspace-plan.md`, retired 2026-08-30; current state in ADR 0016 and modules/hosts.md/rooms.md/agents.md), then updated by the Conversation execution-context work. Every mechanism is covered by real-Postgres and daemon unit tests with the connection registry stubbed; what no test reaches is the daemon on a machine someone uses. The walk: from `/agents` (no Project) create a managed-workspace Agent on a paired host; chat directly and have it write a file; verify `~/.rainver-host/agents/<id>/direct/<user>/` holds it; add the same Agent to a Room, explicitly create and initialize two Conversations, and verify separate `conversations/<conversationId>/` directories that cannot see the direct-chat file or each other's files; remove the Agent and verify its Conversation × Agent threads close while a shared Conversation directory is archived only after its last live Agent thread closes; stop the daemon and verify preflight blocks send without changing the pinned context; confirm `claude --resume` lists the Agent sessions and ambient import does not import them. | The next session on a paired real host with the rebuilt daemon |
| **Agent identity — paired-host acceptance.** Carried out of the agent-identity-and-memory-boundary plan (retired 2026-09-06; current state in [ADR 0003](../decisions/0003-memory-proposal-flow.md) §4, [modules/hosts.md](../modules/hosts.md) and [modules/rooms.md](../modules/rooms.md)). On a paired host: two Agents on the same CLI and provider in the same Location; one Agent in two Conversations. Verify four distinct profile directories under `agents/<agent_id>/profiles/`, two vendor sessions for the one Agent, zero overlap of CLI memory subdirectories, that an unbound run's state root is its profile (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` pointing inside it) while `HOME` stays the machine's, so `git commit` and `git push` still work from a Task run, and that `POST /agents/:id/host-state/reset` archives that Agent's profiles and nothing else. Two questions to answer in the same session, because only a real runtime can: whether Claude Code starts from a fresh `CLAUDE_CONFIG_DIR` whose only pre-existing content is the linked credential file — the daemon links exactly that one file, so if it also needs a settings or onboarding marker, every subscription-login profile fails to authenticate on its first dispatch and that file joins the link set for the adapter (this is the `host_login` shape; the provider-bound `ANTHROPIC_BASE_URL` shape is the remote provider-binding row's first clause, a different question) — and whether Codex partitions `memories/` under `CODEX_HOME` by working directory, which changes how much CLI scratch a container profile accumulates but not the design. | The next session on a paired real host with the rebuilt daemon |
| **Credential refresh semantics per runtime.** The one thing the agent-identity plan's P1 login-link design rests on (that plan is retired; current state in [modules/hosts.md](../modules/hosts.md)) and no test on the server can reach: for Claude Code, Codex and OpenCode, whether an expired token is rewritten **in place** or via temp-file **rename**. In place → every Agent profile on the host sees the refresh through its link. Rename → the login home gets a new inode; a symlinked profile follows it by path, and a hard-linked one (the Windows fallback) is relinked on its next run because the source is newer, so neither is left pinned to an orphaned credential. What remains unknown is whether a **rotating** refresh token invalidates the siblings between those two moments. Check by linking the file into a scratch directory, forcing a refresh, and comparing inodes; record the answer per adapter next to `credential_file` in `runtimeAdapters/specs.ts`. | A paired real host with a logged-in CLI whose token is near expiry |
| **OpenCode's state root under an unbound run is unverified.** The agent-identity plan's P1 (retired; current state in [modules/hosts.md](../modules/hosts.md)) moves each runtime's state into the Agent's profile through that runtime's own variable rather than by moving `HOME`, so a Task run on a paired machine keeps `~/.gitconfig` and `~/.ssh`. Claude Code (`CLAUDE_CONFIG_DIR`) and Codex (`CODEX_HOME`) are certain — those are the variables their bound bindings already use. OpenCode is pointed at `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` inside the profile, on the documented behavior that its data directory is `$XDG_DATA_HOME/opencode` before falling back to `HOME/.local/share/opencode`. If it ignores XDG, its sessions and auth stay in the machine's own directory — no worse than before this phase, but not the isolation B68 claims. Check by dispatching an unbound OpenCode turn on a paired host and looking for `auth.json` and a session file under the profile. | The first unbound OpenCode dispatch on a paired host |
| **`roomsDb.test.ts` seeds four conversations into one Room concurrently and races its manager constraint.** Observed twice during the agent-identity P1 full-suite runs (2026-09-06), passing on re-run and passing when the file runs alone. `seedConversation` calls `seedRoomManager`, whose `ON CONFLICT (room_id, agent_id)` does not cover `uq_room_agent_members_manager` (one manager per Room), so a `Promise.all` of four seeds can insert two managers at once and one loses. Unrelated to that phase's change — a test-support race that will keep failing CI intermittently. The fix is to seed the manager once before the `Promise.all`, or to make the seed conflict-tolerant on the manager constraint too. | The next intermittent CI failure in that file, or the next change to Room seeding |
| **`host-state/reset` has no web surface.** The endpoint shipped with the agent-identity plan's P1 (retired; current state in [modules/hosts.md](../modules/hosts.md)) and is reachable only by API. Whether "clear this Agent's CLI memory on this host" belongs on the Agent page, the Room roster, or the Command Center is a product placement question that phase did not decide. | The first time clearing an Agent's CLI state is wanted from the product rather than by curl |
| **Bound remote runs cannot see `~/.gitconfig` / `~/.ssh`.** A stated limitation of the retired provider-binding plan, not a defect: a bound run's environment is an allowlist and its `HOME` is a control-plane profile. `SSH_AUTH_SOCK` is admitted because it selects no backend, but an agent that commits or pushes inside the workspace can succeed unbound and fail bound. Widening this means naming exactly which machine state a bound run may see — a B67 decision rather than a convenience. | A bound remote run needs to commit or push |
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
| **Delete `projects.primary_mode`** — done 2026-09-03 by [ADR 0019](../decisions/0019-project-has-no-type-field.md): the field, `project_brief_versions.primary_mode`, `project_mode_transitions` and the transition API are gone; a Project has no type field. | Closed |
| **Collapse `projectEntitySummaryRegistry` + `projectAttentionRegistry` + `projectModeProjectionRegistry` into one `ProjectDomainContributionRegistry`**, one adapter per domain — `execution_readiness` becomes a contribution sourced from `workspace_locations` + `hosts`; only two new adapter methods (`listWorkItems()`, `listTimelineEvents()`). If a domain has a next action but no attention item, that domain's attention adapter is under-reporting — fix it, never open a second channel. | Same |
| **`ProjectProgressProjection`** — new, read-time-only derived view (progress/phase/blocked/momentum/recent changes/recommended next action/health/needs-attention). Never stored: a short-TTL in-memory cache is the only acceptable performance fix if one is ever needed, not a table — materializing derived state is how it silently becomes a canonical fact nobody re-derives again. | Same |
| **`ProjectOverviewService` simplifies** to a thin renderer over the projection above. | Same |
| **Project Steward** — not a new subsystem, three changes to what exists: `buildRoomProjectStateContext` reads `ProjectProgressProjection` instead of `ProjectOverviewService`; two more proposal-gated Room Manager Agent tools (`task.create`, `run.dispatch`); one model call producing a discardable, recomputable `ProjectAssessment` advisory record (`based_on_projection_at` + source refs) that is never canonical state. The Steward may not write Brief/Task/Decision/milestone/current-state directly — model output becomes a Proposal through the existing policy/approval/apply path, the same as every other domain. | Same |
| **Room stays unsplit as the Project conversation** — planning/advice and dispatch entry are the same surface, never two; a Project conversation is never coding-runtime session storage (that's HostTaskThread's job). Splitting them would force users to remember which sentence goes where. | Same |
| `diff2html` / `react-diff-view` for `apps/web`'s hand-rolled diff review (no diff library exists in the frontend today) | P2 frontend work starts |
| ~~**No thread-level lock serializes a task thread's backend inheritance.**~~ — **closed 2026-09-03** by the conversation-UI plan's P3 and its integration gate. The race was: two overlapping dispatches on one thread, the inheriting one reading the backend before the override commits. Two things now prevent it. The admission takes `lockActiveProjectForMutation` (`SELECT … FOR UPDATE` on the Project row) before either branch, and a thread belongs to exactly one Project through its Location, so two dispatches to one thread serialize. And the admission refuses outright while the thread's latest Run is non-terminal (integration finding IG-M3), so the second dispatch does not merely queue behind the first — it is rejected with 409. Inheritance itself now reads the thread's newest Run (`threadRunBinding`) rather than a message ledger. **Residual, recorded rather than closed**: the revival paths (`resumeRunAfterSupervisorReview`, `requeueRunForRetry`) restart a Run without going through the admission and take no Project lock, so they are not covered by either guard. | A revival path is observed restarting a thread-bound Run alongside a fresh dispatch |

Kept deliberately, not part of this deferred set: Brief/versioning/`current_focus`/
`confirmed_decisions_json`/Project Instruction (already the right shape,
canonical A-class facts); Project Operations/Corpus/Areas (out of scope, no
evidence of a problem).

## Retirement

Remove an item when its trigger fires and the work moves to
[../plans/backlog.md](../plans/backlog.md) or lands, or when the item stops being
true. Retire this file when nothing remains.
