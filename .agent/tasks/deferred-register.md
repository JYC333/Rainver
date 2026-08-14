# Deferred Register

Date: 2026-08-13
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
| **Codex cancellation evidence.** Codex internal delegation is accepted rather than disabled (see the 2026-08-13 decision in [current-focus.md](current-focus.md)), and `cancellation_reliability` is `best_effort` — whether internal agents stop when the main process is terminated is unverified, so a cancelled Run may still be writing. The `cancel_reliability` C3 probe already exists; it just cannot run without the binary. | A CLI runtime is installed into the sandbox image |
| **Retention and pruning design.** Append-only Run/Event/Evolution/usage data and Artifact storage need explicit retention semantics that preserve audit obligations, Proposal/Artifact provenance, and per-type policy. It cannot be a generic age-based delete job. | The database reaches a few GB, backups exceed 15 minutes, or real Run logs make growth materially visible |
| **Operations runbook consolidation.** One operator page covering service placement and health, backup/restore and host-loss recovery, runtime-tool and credential recovery, retry/alert/scheduler diagnosis, and safe stop and escalation boundaries. | Unattended hardening completes |

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

## Watch items

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

## Retirement

Remove an item when its trigger fires and the work moves to
[../plans/backlog.md](../plans/backlog.md) or lands, or when the item stops being
true. Retire this file when nothing remains.
