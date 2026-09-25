# Backlog

Date: 2026-08-13
Status: real work with no trigger condition. Merged from the retired
`hardening-blind-spot-remediation-plan.md`, `product-capability-followups-plan.md`,
and `protocol-client-contract-drift-plan.md` after a full audit against the code
on 2026-08-13.

## How to use this file

Every item here is a genuine gap that someone will eventually close; none of
them is waiting on a trigger. Anything that *is* waiting on a trigger, and every
standing enablement gate, belongs in
[../tasks/deferred-register.md](../tasks/deferred-register.md) instead. Nothing
here is scheduled; items are pulled on demand.

Implementation truth remains the code. Current-state architecture belongs under
`.agent/architecture/`; this file is forward-looking only. Remove an item once
its behavior is implemented and recorded in a current-state architecture
document — do not leave a closed section behind as history. That belongs to git.

## 1. Verification Engine

### A2.1 — Manual and model-based verification

`evaluate()` returns `skipped` with `implementation_status: "deferred"` for both
declared types, so a Workflow can declare them and receive nothing.

- [ ] Implement the declared `manual_review` verifier lifecycle, including
  durable pending/approved/rejected state and its effect on completion.
- [ ] Implement `model_judge` with a separately selected verifier model, never
  silently reusing the generator model.
- [ ] Add policy, audit, retry, and API read-model coverage.

Constraint: deterministic Verification Engine results remain the completion
authority; model or human judgment must be an explicit verifier result.

Scheduling rule: must be completed before any Workflow declaring one of these
verifier types as required completion evidence is enabled.

## 2. Workflow / Automation Lifecycle

### B4.1 — Complete Save Run as Workflow lifecycle

Current code provides the Run-detail UI, sanitized preview/extraction, low-risk
draft creation, and a high-risk `workflow_save` Proposal whose acceptance creates
a draft `workflow_template` asset version. Real-PostgreSQL coverage
(`server/test/runWorkflowServiceDb.test.ts`) stops at that draft boundary.

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

The `artifacts` module records no revision or edit history at all. The
`edited_by_user` flags elsewhere (research evidence cards, note revisions) are
their own domains' state and do not cover generated artifacts.

- [ ] Record user edits to generated artifacts with actor, artifact version,
  source Run, and before/after provenance.
- [ ] Convert meaningful edit patterns into evolution evidence/signals without
  treating every edit as an automatic promotion or memory write.
- [ ] Add Project Folder, Artifact, privacy, and cross-space isolation tests.

Interim: Proposal reject/request-changes signals remain the user-correction
evidence — see
[../architecture/EVOLUTION_SIGNAL_SYSTEM.md](../architecture/EVOLUTION_SIGNAL_SYSTEM.md).

## 4. Project Surfaces

### G1.2 — Two loose ends left by the Inquiry Step model

Both are unreachable today and neither blocks anything; they are recorded so the
next person to touch these paths does not rediscover them the hard way.

- [ ] `updateWork` consumes `next_focus_note` only when the request also names a
  `next_focus_kind`, so a note-only request succeeds and changes nothing. No
  caller sends one, and the change panel has no note field. If a standalone note
  edit is ever added, make that path real first rather than letting a user's note
  vanish silently.
- [ ] Nothing prevents two open background Steps of the same kind on one Thread.
  `completeBackgroundStep` closes the oldest rather than all of them, which is
  correct while a Thread pins at most one research Workflow. A genuine
  multi-Workflow Thread would need the Step id carried through the completion
  path so each operation closes the Step it actually produced.

Constraint: do not add a note edit or a second concurrent Workflow per Thread
without closing the matching item.

## 5. Runtime Conformance

### C3.1 — Conformance second wave: dropped

The first wave is gone, so there is no second one. The C3 suite was retired on
2026-09-09: it certified a vendor CLI's behaviour once and cached the verdict
against a version key, blind to the model actually selected, and gated dispatch
on it. Its strongest question — will a runtime write outside what it was given
— is answered structurally by ADR 0016's namespace, and the rest were single
samples of a non-deterministic system, or duplicated what using the runtime
already proves.

Everything this wave proposed (validation compliance, artifact production,
timeout behaviour, cost/latency profiling, feeding trust decisions) shares that
premise. If the question comes back, the shape to reach for is observation of
real Runs rather than a synthetic probe taken once, and asset-centric
protection rather than run grading — see the risk-level item in
[../tasks/deferred-register.md](../tasks/deferred-register.md).

### C3.2 — Routing cannot express a provider or model requirement

Found 2026-08-15 while retiring the routing plan. The router never reads
`model_provider_id` or `model_name` — they are carried on `RouteCandidate` and
referenced nowhere in `router.ts`. A caller that needs a specific provider has
exactly one way to get it: pin the profile as `explicit`, which hard-filters
every other candidate and takes the run out of routing entirely. Project
Research does this, and it is why its stage runs record a foregone route
decision.

- [ ] Decide whether a run may declare a provider/model requirement, and
  whether it is a hard filter or a scoring term.
- [ ] Wire both sides. A requirement dimension needs a producer *and* a
  populated candidate side; `required_tools` has the first without the second
  and therefore rejects every candidate when used. See
  [../architecture/ROUTING.md](../architecture/ROUTING.md).
- [ ] Decide whether `required_tools` should be repaired or removed while here.
  It is reachable today from four carriers — Task `policy_json`, workflow node
  `contract_json`, plan node `policy_json`, and automation `config_json` — and
  any of them rejects every system-created candidate. Removal has to close all
  four; repair means populating the candidate side.

Constraint: this must land before "Let Project Research stage runs route" in
[deferred-register.md](../tasks/deferred-register.md), or unpinning Project
Research silently discards the user's provider choice rather than letting the
router honour it.

### G1.3 — Chat provider presets cover one vendor

Found 2026-08-14 during the runtime-boundary audit. `server/src/modules/providers/presets/`
holds five presets: four retrieval-side (OpenAI embeddings, Cohere, ZeroEntropy,
Ollama) and exactly one chat preset, MiniMax. Anthropic, OpenAI chat, OpenRouter
and DeepSeek have none, so adding one means typing a base URL and model names by
hand.

- [ ] Decide which chat vendors deserve a preset and add them, or state that
  presets are deliberately retrieval-only and stop implying otherwise in the
  add-provider form.

Constraint: a preset pre-fills configuration; it must not carry a credential,
and `api_key_required` stays a server-declared fact. The server-owned vendor
registry and its API are current-state authority; see
[provider-policy.md](../modules/provider-policy.md).

### G1.4 — A managed run cannot produce an artifact

Closed by the 2026-09 ACP Runtime Authority cutover (ADR 0022). The former
managed Agent loop no longer exists: autonomous Agent Runs use ACP and the
normal Run materialization path. Bounded `provider_task` Runs deliberately do
not gain a general Agent artifact surface; a future bounded operation that
needs durable output must use its owning domain service and provenance policy,
not revive a second Agent loop.

### R1.2 — Research start parameters should be auto-selected, not fixed defaults

`research.start_acquisition` (`.agent/architecture/SYSTEM_ACTIONS.md`,
`server/src/modules/projectResearch/pipeline/researchAcquisitionPipelineJob.ts`)
ships with server-derived fixed defaults for providers, candidate budget, and
execution model, mirroring the UI's preselection. Follow-up (user, 2026-08-20):
these should be evaluated and chosen per invocation by the Manager Agent or a
dedicated research agent — e.g. provider mix from the question's domain, budget
from project scale — instead of one static default set.

### R1.5 — A conversation-scoped Work Context Setup

**Import continuation no longer needs this.** Thread references (shipped
2026-08-29; [../modules/rooms.md](../modules/rooms.md) §Thread References)
settle the per-thread *reference* need as a one-shot message copied into the
target thread, which touches no scope. What remains here is the wider,
still-unexampled need for per-thread *configuration*; the five decisions
below stand, and the live `imported_session` explicit reference this entry
describes as "wired end to end" is removed by that plan's Phase 1.

Today a Room run's `work_context_scope_id` is `room_agent_members.id` — the
`(Room, agent)` pair — and `work_context_setups` is unique on
`(space_id, work_context_scope_id, user_id, version)`. So a Room conversation
has **no per-conversation setup**: two threads with the same agent in one Room
share one, and nothing that belongs to a single thread can be configured.

This surfaced when import continuation wanted to pin the imported session as
an explicit reference on the new conversation. Pinning at the only scope that
exists would attach it to every conversation that person has with that agent
in that Room — bounded and arguably right for a personal Room, wrong for the
mainline, where a shared continuation lands.

Nothing is pinned as a result. The `imported_session` explicit reference that
was briefly wired end to end has since been removed by the thread-references
work, which settles the per-thread *reference* need as a one-shot copy and
leaves this entry to the per-thread *configuration* need.

Two alternatives were weighed and rejected, 2026-08-29:

- **Give every continuation its own Room.** Makes the pin boundary exact, but a
  shared continuation excludes nobody, so that Room carries no visibility
  meaning — it is Room-as-topic, which ADR 0018 decision 1 rejects by name, and
  the roster-titled sections would render it as a split with the same audience
  as the Project's own conversations.
- **A tool that reads a named imported session**, with the id carried in the
  seed. Literally "on demand", no scope change, and the content gate already
  exists. Cheaper, and it answers the narrow need — weigh it first if the only
  driver is import continuation.

The scope change is the right long-term shape because it closes the wider gap,
not because of imports. What it needs, and what no plan currently contains:

1. **Addressing.** `(conversation, agent)` has no row today. Either a new table
   or `session_id` in the setup key — and `work_context_scope_id` is passed
   around as a single varchar token, including in a JSON expression index on
   `jobs` (`db/schema/jobs.ts`).
2. **Inheritance.** Does a conversation-scoped setup replace or layer over the
   Room-scoped one, and if layered, which field wins?
3. **Snapshot reproducibility.** Setups are versioned and fingerprinted, and
   invocation snapshots record which version ran. A second scope level changes
   what a snapshot must record — ADR 0014 audit territory.
4. **Lifecycle.** Conversation archived, membership revoked: what happens to
   the setup, and do old snapshots still resolve?
5. **Who edits it.** The Work Context surface is organised per Room recipient.

Blast radius includes `scope_kind = 'room_recipient'` branches hardcoded in the
agent re-authorization SQL (`runtimeContext/gateway.ts`, twice) and
`productionAcquisition.ts`, plus the invocation-snapshot and continuity chain.

## 7. Harness And Scope Convergence

Two remaining specifications cover capability shrink and the two-Scope user
model, and one audit (H2) covers the two paths a prompt is assembled by. Each
is a separate convergence with its own prerequisites; pointers only here,
detail there. Runtime-boundary and registry-lifecycle work completed on
2026-08-14, and the routing specification was retired on 2026-08-15 — its
shipped behaviour is in
[../architecture/ROUTING.md](../architecture/ROUTING.md) and its untriggered
remainder in [../tasks/deferred-register.md](../tasks/deferred-register.md).

None is currently active. The completed managed execution replatform is
current-state architecture, not backlog work.

### H1 — Managed tool families cannot contribute to the system prompt

Closed by the ACP cutover. Room delegation and wait behavior are exposed as
canonical ACP tool definitions; their descriptions carry usage guidance,
target schemas constrain delegation to active Room members, and the Runtime
Context Delivery remains the authoritative instruction source. The former
managed-loop prompt override is not retained. `managedAgentDelegationTools`
tests assert both tool behavior and the guidance delivered with those tools.
- [ ] Focus areas: classify from where content lives. The first slice shipped
  ([ADR 0015](../decisions/0015-focus-area-classification.md)) with
  classification available only from a focus area's own page, through pickers
  that list the first 100 notes and knowledge items. That does not scale and it
  is the wrong direction of travel: filing something should be possible from the
  note, the knowledge item or the Project itself. `focusAreasApi.setForObject`
  and `setForProject` already exist, so this is a front-end affordance rather
  than new API. The aggregation page also caps objects at 200 with no paging.
- [ ] [capability-shrink-plan.md](capability-shrink-plan.md) — the authority
  documents and the workflow template layer landed on 2026-08-14. The remaining
  items collapse the implementation to
  `SkillPackage + SkillBinding + SkillPolicy`.

### H2 — Prompt provenance across ACP and conversation inputs

From the agent-identity-and-memory-boundary plan's decision 8, recorded in its
P5 (2026-09-06); that plan is retired and the surviving statement of the split
is [modules/rooms.md](../modules/rooms.md)'s host-bound section.

The 2026-09 cutover now routes every Agent Host dispatch through
`RuntimeContextInvocationGateway`; `remoteHostCliAdapter` projects that
Delivery into the ACP prompt. Structured conversation input is still hydrated
by `ConversationInputService` and supplied as a separate content source to the
same projection. Keep this distinction explicit: it is not a second runtime
authority, but omission or duplicate delivery at the join would affect the
user's actual turn.

This remains a final-integration review item, not a deferred implementation
project. Verify the current-user message is neither lost nor duplicated across
Delivery projection and conversation-input hydration; compare Room/direct-chat
transcript continuity with the immutable Runtime Context snapshot.

## 8. Execution Runtime

### One Host daemon cannot connect to multiple Rainver servers

Recorded 2026-09-04. The installed daemon currently owns one
`~/.rainver-host/config.json` containing a single `server_url`, `host_id`,
token, and workspace map, and the CLI refuses a second registration. Supporting
multiple servers is intentionally deferred; it should be a real multi-instance
model rather than an array added to the existing singleton config.

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

### A bound remote run's egress snapshot records `local_cli`

Carried out of the retired remote-host provider-binding plan (P2,
2026-08-28). A bound remote run's model traffic is governed by the Space's
`externalEgressEnabled` switch (the `local_cli` egress branch) but **not** by
per-provider egress policy: `runtimeProviderEgressDestination` never runs for
it, because the provider is resolved after the execution-control snapshot is
written. The snapshot therefore records `destination_type: "local_cli"` for a
run whose traffic went to a named ModelProvider through the server proxy. The
alternative at the time — recording the router's *prediction* — was wrong in
a worse way. Closing it means either writing the snapshot after binding
resolution or amending it afterwards; neither was P2-sized.

### Per-dispatch backend override in the Command Center

Carried out of the same plan. The API accepts `model_provider_id` / `model`
on both dispatch routes and the resolution honors all three request shapes
(dispatch override > host×adapter default > ambient), but the Command Center
only sets the Host × adapter default. "Pick a provider on a single dispatch"
— the second half of that plan's DoD 1 — is reachable by API only.

### pg-boss for the `jobs` module

Recorded during the execution-topology and Project control-plane plan's P0
reuse evaluation (2026-08-23; that plan is now retired, git history holds it): `PgJobQueueRepository` + the job worker
(~800 lines, `server/src/modules/jobs/`) is a real candidate for replacement
by `pg-boss`, a mature Postgres-backed job queue. Not pulled into that plan
because it replaces an already-working internal canonical mechanism the
execution-topology work doesn't touch, not a broken or duplicated one — no
urgency, real payoff. `queueAdvance.ts`'s own pg-advisory-lock serialization
(the "one active Run per thread" invariant) is a separate concern this
migration would not remove.

### `server` and `sandbox-runner` must now be deployed together

Recorded 2026-08-28. `SANDBOX_RUNNER_PROTOCOL_VERSION` went to 2 when the
runner's `tool_channel` stopped naming an MCP endpoint and became the work
surface, and `validateRequest` accepts only its own version. That is deliberate
— a stale runner would otherwise hand a Run a live token with no command — but
it breaks in both directions: a version-1 runner refuses every request from a
current server, and a version-2 runner refuses every request from a rolled-back
one, including `verification` runs that have nothing to do with tools. Nothing
in `ops/compose/*.yml` or `ops/scripts/` records that the two images are now a
unit. Either write that down where a deploy reads it, or make the runner accept
a request whose `tool_channel` it fully understands regardless of version.

### A sandboxed Run cannot declare a Task's output

Carried out of the agent work surface plan's P2 (retired 2026-08-28; ledger
in git history)
(2026-08-28). `artifact.submit` is granted only on the remote-host path,
because only that path applies a declaration: the executing host uploads its
output directory and `hosts/repository.ts` gives those files the declared type
and Task link. A server-host Run's artifacts come through
`materializationService` (`produced_artifact_paths`), which does not consume
declarations, so the action is withheld rather than accepted and ignored —
telling an agent its deliverable was recorded when nothing would act on it is
worse than not offering it. Closing this means teaching materialization to
join declarations to collected paths, with `path` relative to the Run's
exchange output directory rather than `$RAINVER_OUTPUT_DIR`. Until then a
sandboxed Run's Task with declared required outputs still parks for review.

### Loose ends from the agent work surface

Recorded 2026-08-28 when `agent-work-surface-plan.md` retired; found by its
integration gate.

- [ ] Nothing reads `run_tool_identities.skill_content_hash`. Both delivery
  paths write it, and the remote one also mirrors it into the Run's
  `metadata_json`, but a sandboxed Run's Skill is only recoverable by direct
  SQL — which is the use the column was added for.
- [ ] A paired daemon predating the `work_surface` launch-frame field ignores
  it silently while the server has already issued the identity and told the
  agent to use `$RAINVER_CLI`. `hosts.daemon_version` is recorded and never
  read; either read it, or have the daemon declare the capability in its
  `hello`.
- [x] The work-surface wire shape is declared twice —
  `runs/runWorkSurface.ts`'s `RunWorkSurfaceFrame` and the daemon's
  `WorkSurfaceFrame` — with nothing pinning them together. **Resolved
  2026-09-02:** the whole host WebSocket wire, both directions, is one
  contract (`packages/protocol/src/hostWire.ts`); the daemon depends on
  `@rainver/protocol` at runtime and parses every frame with it, the server
  parses daemon frames with it, and both type their sends against it. The
  daemon's `WorkSurfaceFrame` is now an alias of the contract's type. Found
  because `work_surface` was in fact dropped at that boundary.

### Interactive permission gate for headless dispatch

`RunPermissionPolicy` (`server/src/modules/runs/runPermissionPolicy.ts`,
landed in the same P0) always pre-authorizes, because every current dispatch
path is headless — no human is present mid-run to answer a prompt. A gate
that can actually suspend a Run for a human decision needs suspend/notify/
resume machinery this policy does not have, and would change the product
surface (a Run can sit "waiting for permission" instead of running to
completion or failing). Not scoped into any current plan. Until it exists,
the Rainver Work Skill teaches `task.request_review` as the way an agent hands
a decision back: it stops the work and asks, which is the whole of what a
dispatched Run can do about a question only a person can answer.

### Custom Source handler isolation is application-level, and ESM would not change that

The Custom Source runner spawns each handler as a plain `node` child process
and relies on a generated CommonJS bootstrap that monkey-patches `net`, `tls`,
`http(s)`, `dgram`, `fetch`, `child_process`, `worker_threads`, and the common
`fs` entrypoints before `require`-ing the handler. The runner's own header says
what that is: defense in depth, not container, network-namespace, or OS-level
isolation — a native addon, `process.binding`, or any unpatched API reaches
outside it.

Decided 2026-08-26, when the server moved to ESM: the bootstrap and the
`handler.cjs` artifact contract stay CommonJS on purpose. Porting them to ESM
would cost a sandbox rewrite (`module.register()` loader hooks,
`syncBuiltinESMExports()`, a handler version migration) and leave the
protection surface exactly where it is, because live bindings and async
`import()` make the patching approach harder, not stronger.

What would actually raise the bar, in order of cost:

- [ ] Spawn handlers under Node's permission model:
  `--permission --allow-fs-read=<sandbox> --allow-fs-write=<sandbox>` with no
  `--allow-child-process`, `--allow-worker`, or `--allow-addons`. Enforced at
  the runtime API boundary rather than by patching; a few lines in `spawn`,
  no change to stored handlers. Does not cover the network.
- [ ] For the network, run handler processes inside the existing Docker sandbox
  image with networking disabled, at the price of a container start per run.

Constraint: keep the honesty boundary — do not describe the runner as
OS-sandboxed until one of the above is in place. Do the ESM port, if ever,
only as part of such a rewrite, never on its own.

### Queued research stages still run as Agent Runs

Recorded 2026-09-21 by the ACP runtime-authority review. Monitoring
comparison (`research.monitor_compare`), brief synthesis and its critique
(`research.brief_synthesize`) are single-shot structured generation with no
tools and no turns, so ADR 0022 classifies them as `provider_task` Runs. They
still create `agent` Runs through `ProjectResearchExecutionProfileService`,
which manufactures a `system_research` Agent and a `Research · OpenCode`
`model_provider` Profile, and dispatch an ACP session to produce JSON. Ad-hoc
analysis and notebook chat already moved to `runs/boundedProviderTaskRun.ts`.

Why they did not move with them: the three stages consume
`output_json.result.materialization` (the `research_report.archive.v1`
artifact written by `RunMaterializationService` during agent-run
orchestration) and the declared-output verification / Supervisor retry path.

- [ ] Give `runBoundedProviderTask` a materialization step that writes the
  same declared artifacts and evidence a bounded contract names, reusing
  `RunMaterializationService` rather than a second writer.
- [ ] Move all three writers (`monitorComparisonService`,
  `pipeline/synthesisCoordinator` both sites, `orchestrator.startInitialIntake`
  and `standingComparisonService`) to `createQueuedProviderTaskRun` +
  `provider_task_run` in one change; register their preparers by
  `capability_id`.
- [ ] Delete the Agent/Profile manufacturing in `executionProfileService.ts`
  and shrink `RESEARCH_AGENT_CAPABILITY_IDS` to nothing, then remove the
  `system_research` Agent kind if no consumer remains.

Constraint: no half-migrated writer; every research Run must satisfy
`ck_runs_execution_shape` at every step.

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

## 9. Imported CLI History

From the ambient-session-import integration gate (2026-08-28); the feature
shipped in `293023c3` / `d162aabf` and neither item blocks it.

- [ ] Render an extracted statement's citations as links back to the imported
  record they came from. The refs are stored — on the Brief version's
  `source_refs` and inside the memory packet's candidates — but nothing opens
  them, which is the one part of the plan's Phase 2 acceptance condition 2 that
  is not built.
- [ ] Make the four read-side wire shapes (`ImportedSession`,
  `ImportedSessionRecord`, `AmbientSyncReport`, `ExtractionOutcome`) actually
  enforced rather than merely declared. They now live in
  `packages/protocol/src/ambientSessions.ts` and the web forwards them, but the
  server still declares its own row and report types independently and the web
  client's `get<T>` is an assertion, so a future server change would not be
  caught by typecheck. The declaration that had already drifted is gone; the
  mechanism that let it drift is not.

## 10. Agent Identity

From the agent-identity-and-memory-boundary plan's P4 review (2026-09-06);
that plan is retired, and the current state is
[ADR 0003](../decisions/0003-memory-proposal-flow.md) §4 with
[modules/rooms.md](../modules/rooms.md) and
[modules/agents.md](../modules/agents.md). The phase shipped and the item
does not block it. (Sending the block on change is implemented; see
`modules/rooms.md`.)

- [ ] Deliver the same block to **managed** (server-side) Agents. P4 scoped
  itself to the host-bound path on purpose: the managed path would acquire
  these entries through its Runtime Context Memory candidate authority, which
  is a different and smaller change, and the plan deferred it behind the
  two-prompt-assembly-paths audit in section 7 (H2).

## Completion and retirement

Remove an item once it is implemented and recorded in current-state
architecture, or once it is re-scoped elsewhere. Retire this file when no item
remains.
