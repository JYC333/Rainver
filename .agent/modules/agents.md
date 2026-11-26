# Module: Agents

## Purpose

Define AI Agents as product-level actors, separate from their owner and from
the ACP runtime that executes them.

## Three-Way Separation

```
AgentVersion        — immutable behavior and constraint authority
AgentRuntimeProfile — mutable runtime/backend/Host deployment authority
ACP runtime         — external Agent loop launched by a Host daemon
ProviderTask        — separate bounded server-side model invocation authority
```

See [`runtime-adapters.md`](runtime-adapters.md) for the ACP registry and
execution boundary.

User-created Agents and role instances use the access-owned creation
resolver. A Project entry point writes `agents.project_id` and
`visibility=space_shared` in that Project's Space; an unbound creation lands
private in Personal Space. Direct Run and chat creation applies the same rule,
including the Session and Run rows. System-managed Agents are derived system
resources and keep their explicitly declared scope.

## Owns

- `Agent` ORM model and CRUD
- `AgentVersion` model (immutable Agent behavior/constraint snapshot per Run)
- `AgentRuntimeProfile` model (Agent-scoped runtime/backend/Host deployment)
- Agent roles — read-only file specs in `catalog/agent_roles/<key>/role.yaml`
  (NOT runtime objects), served by `server/src/modules/agentRoles/routes.ts` with
  copy-on-create `POST /api/v1/agent-roles/{id}/agents`
- `Run` rows persisted through `PgRunRepository` (`server/src/modules/runs/repository.ts`: queued work, lifecycle, delegation links)
- Built-in role catalog (factories; concrete system agents are provisioned on demand)
- Agent seeding and product-level agent configuration

### Project Research execution defaults

Project Research provisions or reuses a space-scoped
`agent_kind="system_research"` Agent and its selected AgentRuntimeProfile.
The Profile is pinned by the screening rules' Source post-processing Runs and
names the provider/model the queued stages run on; the Agent backs every
research pass's WorkflowExecution coordinator Run and the synthesis-only
snapshot's Agent node. Those are ordinary ACP Agent Runs. Monitoring
comparison, synthesis and critique are bounded `provider_task` Runs that select
no Agent or Profile, and question refinement remains incidental ProviderTask
work. Research does not introduce a server-managed Agent loop.

OpenCode supports either the login held on its execution Host or a
ModelProvider-backed Profile. Provider mode materializes a Run-scoped
`opencode.json` pointing at the expiring provider-proxy lease. Raw provider API
keys never enter the runtime process.

## Agent Role Model (factory → instance)

```
Agent role           — reusable factory; a catalog file spec; NOT a runtime object
    → role version       — the spec's config, exposed read-only as its single version
        ⇒ (copy-on-create)
Agent                    — the runtime instance
    → AgentVersion           — immutable prompt/policy/base config snapshot
    → AgentRuntimeProfile    — mutable named runtime binding; snapshotted onto each Run
```

Rules:
- A **role is a factory**, never executed. No `Run` / model-call path reads a
  role spec.
- **Agent behavior always comes from** `Agent.current_version_id` →
  `AgentVersion`; runtime deployment is independently selected from the Agent's
  `AgentRuntimeProfile` rows.
- Creating an Agent from a role **copies** the role's config into a
  new `AgentVersion` (copy-on-create). The `agents` table records role
  provenance columns; the role is never used to assemble runtime config.
- **Role updates never mutate existing Agents.** Changing a catalog spec has no
  effect on already-created agents.
- **Version objects are immutable runtime snapshots.**
- No role inheritance, no runtime merging, no dynamic parent-role lookup.
- Allowed create-from-role overrides apply to the copied `AgentVersion` only:
  `name`, `description`, `schedule_config_json` (merge), and `system_prompt`.
  Runtime/backend selection is provisioned independently as a default Runtime
  Profile; it is not copied from AgentVersion.
- Allowed create-from-role overrides apply to the copied `AgentVersion` only and are
  **safety-clamped** server-side in the agents module: a memory override can never grant
  `writable_scopes` or drop `requires_proposal`; an output override can never expand
  `allowed_output_types` beyond the role ceiling, drop `proposal_only`, or drop a
  `required_run_outputs` entry; a context override can never expand `allowed_input_contexts`
  (and `default_input_contexts` is clamped to that ceiling). The same clamps apply to the owner
  config edit path.
- Seeded system roles (idempotent, global, no space/owner) —
  five **public** reusable specialized factories, plus the `personal_assistant` **internal** seed
  spec (`visibility=system_internal`, hidden from the library; see below). **There is no
  `general_chat` role** and no product-level DirectChat.
  - `personal_assistant` (category `assistant`, `visibility=system_internal`) — NOT a normal
    reusable role. It is the provenance seed spec for a space's `system_assistant`-kind
    Agent, the anchor for Assistant preferences settings (see below). It is excluded from the
    public Role Library and from user create-from-role; a space is not guaranteed to
    have an instance.
  - `activity_reflector` (category `reflection`) — processes captures/activity into typed
    proposals + a reflection summary; `classification_mode: model_selects`.
  - `memory_reflector` (category `memory`) — proposal-only memory update/merge/delete; can never
    write memory directly.
  - `knowledge_curator` (category `knowledge`) — proposes semantic KnowledgeItem types, relations,
    and source links (a source is not an item type; an answer is a relation).
  - `research_reader` (category `research`) — reads selected sources only; no web search/crawl.
  - `coding_reviewer` (category `workspace`) — read-only review/report outputs; no file write,
    no shell, no patch apply. There is no code-writing `coding_task_agent`.
- **Output policy uses `allowed_output_types`** (never a misleading `default_outputs`/`allowed_outputs`).
  The set is a ceiling; the model selects which output(s) to emit per run
  (`classification_mode: model_selects`), bounded by `allow_multiple_outputs_per_run` /
  `allow_multiple_outputs_per_activity`, with `required_run_outputs` and per-type
  `default_review_mode`. Durable changes are proposal-only (`proposal_only: true`).
- **Context policy uses product-level `allowed_input_contexts` (ceiling) + `default_input_contexts`**
  (enabled start set); the assistant narrows/selects within the ceiling at run time.
- **Chat is a queued Run, not a naked DirectChat.** A chat turn persists a user
  message and a queued Run, returns `chat_turn_accepted.v1`, and is executed by the
  `agent_run` worker. Clients follow the canonical RunEvent SSE stream until the
  worker-published `chat_completed` event, then read the durable assistant message. The
  request route never invokes a runtime adapter directly. Chat is not backed by a single
  space-wide default Assistant identity: a Room resolves a per-speaker,
  per-recipient host thread and vendor session (`modules/rooms.md`), so which
  Agent and runtime a turn runs against remains a per-conversation, per-user
  choice without making the Room session a vendor-state authority.
  Stops share `runs/executionControl.ts`; terminal cleanup shares the durable
  `runs/runSettlement.ts` ledger. Recovery has one background owner outside
  the job lanes. Missing local process state never confirms a persisted Host
  launch's exit, and finalization contention defers completion without another
  model attempt. See [RUNS_AND_OUTPUTS](../architecture/RUNS_AND_OUTPUTS.md).
  A `system_assistant`-kind Agent (system/space-owned, `owner_user_id` NULL,
  minted lazily from the internal `personal_assistant` seed when someone first
  opens a Conversation draft in one of the Project's Rooms) is the immutable
  manager execution identity for Room turns. There
  is **one instance per Project**, plus a Space-level slot: two partial
  unique indexes, `uq_agents_system_assistant_per_space` (`project_id IS NULL`)
  and `uq_agents_system_assistant_per_project` — one composite index over
  `(space_id, project_id)` would not do, because a NULL `project_id` does not
  collide and the Space-level row would be unconstrained. A Project's instance
  is named `<Project name> Assistant`. Room provisioning always passes the
  Room's Project, so nothing creates a new Space-level instance; an existing
  one is still reconciled, keeps *Personal Assistant* in personal spaces and
  *Space Assistant* in shared ones, and is the one the
  `agent.default_assistant.settings` pointer names — provisioning a Project's
  instance must never repoint it.

  Every instance is materialized from the same seed, so they start identical
  and diverge only as each Project is worked with: its own memory, its own
  token attribution, its own evolution target. `agent_versions.follows_seed_key`
  records which seed a version materializes. Reconciliation re-materializes a
  version carrying the current seed key, adopts an unmarked version whose
  content is already identical to what the seed produces (provably untouched),
  and leaves anything else alone rather than overwrite work it cannot account
  for. No path authors a version for a `system_assistant`.
  `requireAgent` excludes the kind, and `publishSystemManagedPrompt` refuses it.
  Do not add a path that leaves the mark set. The unmarked column *is* the
  record of divergence; nothing writes a
  second copy of that fact. A left-alone instance still has its runtime profiles
  reconciled, and routing builds its candidates from `agent_runtime_profiles`
  rather than from the version, so declining to republish an instance's prompt
  does not also stop it working.

  - **`agents.project_id` is `ON DELETE NO ACTION`.** Projects are
    archived, never deleted. Do not delete the Project's Assistant. Archive
    it: a non-`active` status frees the partial-unique slot. The row owns
    Run and token-usage history.
  - **An Assistant's name follows its Project's and is refreshed on the next
    reconcile**, so a Project renamed between Room creations carries the old
    name until then, and two Projects sharing a name give their Assistants the
    same name. Ambiguous, not an error.

  **Seed changes reach existing instances at boot.**
  `reconcileSeedFollowersForAllSpaces` runs once on start (and daily as a
  backstop) over every instance whose current version follows the seed,
  re-materializing it as the Project owner would by creating a Room — so a
  changed seed prompt lands on every Assistant that already exists,
  not only on the next Project to start a conversation. It is idempotent, and
  an instance whose Project has no eligible backend for its owner is skipped
  and logged rather than failed on.

  An Assistant is hidden from ordinary
  Agent CRUD surfaces; `GET /api/v1/agents/default-assistant/settings` exposes only the
  soft preference layer, and its managed-identity pointer stays null while no
  Space-level instance exists. The shared
  Run admission boundary rejects this identity for every non-Room run producer; only the
  Room dispatch path supplies the internal Room authority marker for root, grouped, and
  delegated Runs.

Room-backed execution has one additional, deliberately narrow access path for
private or `selected_users` specialist Agents. `room_agent_access_grants` is
evaluated only when the Agent Group carries the matching `room_id`, the Agent
is an active Room roster member, and the requesting user is an active member of
that Room. It does not alter `contentReadSql`, ordinary Agent list/detail APIs,
Project visibility, or non-Room Run authorization. A grant is revocable and is
always rechecked at dispatch and Room runtime-context setup; Run snapshots
preserve history after a specialist or human member is removed.
- **Assistant preferences are a soft layer, never policy.** The
  `agent.default_assistant.settings` setting
  (`GET`/`PATCH /api/v1/agents/default-assistant/settings`, with
  `?project_id=` naming a Project's Assistant, otherwise the Space's own) holds
  response style, verbosity, default context toggles, default project, and
  proposal style, in one row per Assistant (`settings.scope_type` `space` or
  `project`). Reading needs Space membership, or reading the Project; the
  response carries `scope`, `project_id` and `can_configure`. Writing is
  `canConfigureAssistant` (`agents/agentAccess.ts`): the personal Space's
  Assistant is its person's, a shared Space's is its creator's by
  `spaces.created_by_user_id` (another owner/admin is refused), a Project's is
  its owner's by `projects.owner_user_id`. Nothing transfers this authority.
  `default_project_id` must name an active Project of the same Space the
  configurer can read, and for a Project's Assistant that Project itself. These shape default UI/context behavior only — they are never merged into the
  immutable `AgentVersion` and can never loosen the hard tool/runtime/output/memory/safety policy
  or edit the core system prompt. Per-invocation selection stays dynamic through
  Runtime Context typed acquisition, Delivery, and safe Invocation Snapshot and
  never mutates an `AgentVersion`.
- **Roles do not select a runtime or model.** New Agents receive a default
  Runtime Profile from the Space provisioning template when present, otherwise
  Server Runtime + OpenCode + `runtime_native`. A ModelProvider is used only
  when an explicit provisioning template selects `model_provider`.

## Agent Runtime Profiles

`AgentRuntimeProfile` is the mutable deployment binding under an Agent. It lets
an Agent keep its identity, prompt and constraints while selecting an ACP
runtime, backend mode, execution Host/installation and workspace.

A profile may also be host-bound with `execution_host_id`, a `workspace_mode`,
and a pinned `runtime_installation`. `location` mode provides a default
Folder through `workspace_location_id` and requires the Agent's Project context.
`managed` mode stores no default Folder and lets the daemon derive a private workspace per Agent
× Room or direct owner. An ordinary Server Agent Run may also have neither a
Conversation thread nor a Location: its CLI state uses a stable Agent scope,
while the daemon gives each Run a private temporary working directory. The
selected host and installation are
validated against the caller's ownership and the daemon's reported
capabilities. A Room conversation or Task with its own workspace uses that
workspace with an eligible Profile on the same Host. Host-bound profiles do not require a server ModelProvider or
server runtime-tool installation: the paired host owns the CLI login and
runtime process. For input admission, an unbound Host-owned ACP profile uses
the installation's initialize prompt capability as the image authority; a
Provider-bound profile requires the conservative runtime/Provider-model
intersection. Room and direct chat dispatch apply the profile's owner-only
trigger and record the real Agent id on the remote Run.

A profile is the runtime an Agent runs on, not the Agent. What the CLI
remembers on that machine belongs to the Agent and its stable execution
container — Agent × Conversation, Agent × owner for direct chat, Workspace
Location, or the Agent itself for a Server Run without either ([`hosts.md`](hosts.md)).
This keeps sessions resumable without sharing CLI state between Agents or
Rooms. A no-Location Server Run's working directory is separate and temporary;
it is removed with the Run rather than becoming an unowned persistent folder.

The Server provisions release-pinned OpenCode asynchronously through its
built-in Host daemon. New default Profiles remain unavailable while the
installation is pending; readiness follows installation and ACP health checks,
not whether a native account is logged in. Paired Hosts remain under explicit
owner-controlled installation and upgrade.

Rules:

- Agent creation provisions a default Profile independently from AgentVersion.
- Profiles own `runtime_key`, `backend_mode`, Provider/model when applicable,
  execution Host/installation, workspace selection, and runtime-specific
  options. Credentials themselves are never stored on a Profile.
- Each Agent Run records its execution kind and AgentVersion. Routing selects
  an eligible Profile; before dispatch it stamps the selected Profile id,
  runtime key, and immutable Profile snapshot. AgentVersion never supplies a
  runtime/model fallback. A disabled/unavailable Profile fails closed.
- Editing a Profile affects future route selection only. An initialized
  Conversation/Host thread retains its pinned execution snapshot.
- Disabled non-Assistant Agents retain Profile read access and allow edits to
  existing Profiles under the usual Agent permissions. Run admission still
  requires an active Agent.
- Public Run creation accepts explicit `runtime_profile_id` when the caller
  owns that choice; it does not accept per-run `adapter_type` or
  AgentVersion model fields as alternate authority.
- `model_provider` is available on a paired Host as well as the Server
  Runtime; the daemon receives a short-lived proxy lease URL, never a key. A
  provider-bound Profile must name an execution target
  (`execution_host_id` + `workspace_mode` + `runtime_installation`).
- Cross-Space Provider use is guaranteed only by an enabled
  `model_provider_space_grants` row joined to an enabled Provider — on a
  Profile and on the Space provisioning template alike.

### Profile admission ownership

`runtimeProfileAdmission.ts` owns the `agent_runtime_profiles` row: the
Host/workspace binding check, the backend-mode rules, Provider selectability,
the option-bag schemas, the Agent-row lock every default flip takes, and the
one `INSERT` and one `UPDATE` that write a Profile. `repository.ts` owns
Agents, AgentVersions and the Space provisioning template, and reaches Profile
writes only through that module. Do not add a second profile writer on the
repository. Request bodies
for both surfaces are validated by the `@rainver/protocol` schemas
(`AgentRuntimeProfile{Create,Update}BodySchema`,
`SpaceAgentRuntimeDefaultWriteSchema`), whose `.strict()` rejects
`adapter_type`, `credential_profile_id`, and the other deployment aliases.
Do not keep a second list of those names on a route.

`runtime_config_json` and `runtime_policy_json` have disjoint authored keys
(see [AGENT_RUNTIME_AUTHORITY](../architecture/AGENT_RUNTIME_AUTHORITY.md));
admission refuses a key written to the bag that does not author it.

An invalid Space provisioning template fails Agent creation — including the
managed Project Assistant a Room mints when its first Conversation draft is
opened — with
`space_runtime_default_needs_repair` (409) naming the selection and the repair.
`GET /api/v1/agents/runtime-default` reports `state` and `state_reason` for the
same condition; `PUT` with `backend_mode: "runtime_native"` is the repair and
the reset to the product default.

### Conversation development controls

Direct Agent chat and Room chat share the same development-facing controls.
The first Host-bound direct send creates and pins the Conversation execution
context; later direct sends resolve the existing Agent × owner Host thread and
use its pinned workspace when the Profile's default Folder changes on the
same Host. The backend catalog for the existing conversation shows that
workspace. A changed Host still needs a new Conversation. Git state is not a send gate: the
context's initialization-time `git_*` snapshot and the Run-start
`git_snapshot` are audit inputs, and the CLI reads the checkout itself.

`ConversationRunControls` reuses `PATCH /api/v1/runs/{runId}/stop` for active
turns and renders cancellation with retained partial output. Terminal
Host-backed turns look up the exact `remote_diff` Artifact for that Run,
including managed workspaces, and link back to Files & Code for the current
Project view. Failed direct or Room turns expose an idempotent manual retry;
the retry reuses the persisted user input and pinned execution context while
adding retry Run ids to the original message instead of inserting a duplicate
user message. Composer drafts are destination-scoped sessionStorage records
containing only text and server-issued logical input references, validated on
restore and discarded after seven days.

Member ACP options are saved explicitly through the shared composer controls.
The Conversation binding stores them independently of sending a message;
Room delegated Runs use the target member's saved options. The first direct
message can carry its initial choices while creating the Session. Run and Turn
views distinguish the requested picker value from the runtime-reported model;
unconfirmed reports and the runtime's `default` policy are never presented as
a verified model identity. See `modules/rooms.md`, "Saved member session options".

### Agent work projections

[Agent Attention](agent-attention.md) owns the user-level aggregation reader and
personal reading state, exposed through the `/api/v1/me/agent-attention` list,
`/item`, `/read-state`, `/views`, `/snapshot` and `/stream` endpoints.
Its `semantics.ts` pure functions and protocol DTOs preserve Task/Plan, Session,
non-Room group and explicit Run lineage identities. The repository supplies current
access decisions; Task responsibility, Session answering and Turn state stay in
their owning modules. Reading never writes their business lifecycle.
Queued members project as waiting; an executing member keeps the work working.
Explicit Room supersession and direct retry links remove old members' reasons and
results from current attention, preserving history. Result read revisions include the
physical Attempt identity, so a previous Attempt's read cannot consume a new result.

## Identity and memory

An Agent is the memory boundary; a Conversation is the context boundary; host ×
CLI is only the substrate
([ADR 0003](../decisions/0003-memory-proposal-flow.md) §4–§6). Three things are
kept apart deliberately, and they have three different authors:

| | Author | Where it lives | Reach |
|---|---|---|---|
| **Role** (`agents.role_instruction`) | the owner, as a setting | `agents` | wherever the Agent runs |
| **Persona** (`memory_type = 'persona'`) | the Agent, about itself | `memory_entries`, `scope_type = 'agent'` | every Room turn (not direct chat); one active entry per Agent |
| **Note** (`note` / `decision` / `lesson`) | the Agent, about a Room | the same scope, carrying `origin_room_id` | only where that Room's audience already reached |

The prompt renders role first and persona second. It is delivered through the
Host-bound ACP Run path — `agentGroups/agentIdentityPrompt.ts` on a Room turn
and Room delegation; a direct chat carries neither (`modules/rooms.md`,
"Host-bound specialists and direct chat"). There is no server-side Agent loop with a
separate memory-delivery path. Neither role nor persona is written to a vendor
context file, and the CLI's own auto-memory is scratch Rainver never reads,
imports or promotes.

**Who may change a persona is decided by who is responsible for the Run**,
read from the verified **root** Run's `trigger_origin` and
`instructed_by_user_id` together (`systemActions/effectiveRunTrigger.ts`,
through parent and continuation-cause hops, so a delegated child or a Room
continuation is judged by what started the chain, and an unverifiable chain by
nobody), and never
from the prompt. Person-facing run create always stamps `manual`; a client
cannot send `automation` to skip the in-turn proposal. The owner's own turn
produces a proposal decided in that turn; any other member's turn produces a
proposal only the owner can accept (`memoryProposalDecider`, by identity and
not by role, derived from the entry or the applier's own fields). Owner-only proposal text is never stored in the shared Room
message; the Room reader projects it from the proposal authority only for that
owner, so the member who asked gets nothing. An unattended Run applies it
directly — and records it where the write happened — **only when the person
responsible for that unattended work is the Agent's owner**; anyone else's
Automation, tick or job leaves the same proposal their turn would have
(ADR 0003 §5).
A **revision** is `agent.persona_revised`, carrying what it replaced as well as
what it now says, with a one-step `restore_memory` that retires the new version
and brings the previous one back. A **first** persona replaced nothing, so it
is an ordinary `memory.remembered` whose reversal is an archive. At most one
persona write per Run. An Agent with no owner — the
`space_shared` Space and Project Assistants — has no memory of its own at all.

A revision is a new version on the chain, so the Memory page's version chain
and restore are how a person reads and reverses what an Agent became. Widening
a note means promoting it to Project Memory as a proposal; the entry itself
never widens.

Outside a Project, an autonomous persona change creates a private, content-free
Activity Inbox pointer for the owner. It opens the Memory page, whose named
Agent filter identifies the relevant memory and where the same one-step
reversal is `POST /memory/:id/revert`; a Project-bound change appears in the
Project's updates. Both reversals are one action for the same reason: an Agent must
always have some persona, so archiving the head alone would leave it with
none.

## Does Not Own

- Memory content (memory module)
- Policy decisions (policy module)
- Project Folder/sandbox lifecycle (`server/src/modules/projectFolders/` and runtime adapter execution sandboxes)
- Capability definitions (capability module)
- Provider credentials (`ModelProvider` encrypted config + `server/src/modules/providers/`); a CLI runtime uses the login held by its copy on its execution host, which Rainver never sees
- Run execution orchestration (`server/src/modules/runs/` + job worker)

## Key Models

```
Agent:
  id, space_id, name, description, visibility
  role_instruction          — public identity/role description
  current_version_id        — convenience pointer to latest AgentVersion
  status (active|inactive|archived|disabled)

AgentVersion:
  id, agent_id, space_id
  version_label             — immutable version label
  system_prompt             — immutable execution prompt text
  risk_level                — Agent execution constraint
  max_run_time_seconds      — legacy metadata; no execution deadline
  context_policy_json       — {readable_scopes, writable_scopes}
  memory_policy_json        — {readable_scopes, writable_scopes, requires_proposal}
  capabilities_json         — list of capability IDs
  tool_permissions_json     — server-authorized tool allowlist
  tool_policy_json          — Agent tool-use constraints
  output_policy_json        — output and egress constraints
  schedule_config_json      — scheduling policy
  output_schema_json        — structured output contract
  source_proposal_id        — proposal that approved this version, when post-create
  source_activity_id        — activity record for the config change, when post-create
  created_at
  Note: AgentVersion is append-only. Agent.current_version_id is updated on save.
        It contains no runtime/model deployment fallback.

AgentRuntimeProfile:
  id, agent_id, space_id, name
  runtime_key                  — code-registered ACP runtime definition
  backend_mode                 — runtime_native | model_provider
  execution_host_id            — Server Runtime or paired Host
  runtime_installation         — concrete installed copy on that Host
  workspace_location_id/mode   — optional execution workspace binding
  model_provider_id/model_name — present for model_provider mode only
  runtime_config_json          — runtime-specific, secret-free options
  runtime_policy_json          — runtime-specific policy options
  enabled, is_default
  Note: mutable deployment configuration, independent of AgentVersion.
  Note: the profile has no credential column, and neither does anything else.
        Native login belongs to the execution Host; provider secrets stay in
        the server-side proxy boundary.

Run:
  id, space_id, execution_kind (agent | provider_task), run_role
  agent_id, agent_version_id     — required only for execution_kind=agent
  runtime_profile_id, runtime_key, runtime_profile_snapshot_json
                                  — Agent runtime selection and snapshot
  provider_task_control_id, provider_task_delivery_id, provider_task_snapshot_id
                                  — required for formal provider_task Runs
  status, mode, trigger_origin
  parent_run_id               — lineage link (follow-up/retry/manual continuation or delegated child run)
  cause_run_id                — only on a `continuation` Run: the Run its report is about, within budget
  root_run_id                 — root of an AgentRunGroup run tree when grouped
  run_group_id                — owning AgentRunGroup when grouped
  delegation_id               — RunDelegation that created a delegated child run
  instructed_by_agent_id      — internal-only ORM field for actor resolution; not settable via public API
  prompt, instruction, output_json, error_json, sandbox metadata fields
  Check constraints reject hybrid Agent/provider_task shapes.
```

## Tool failure recovery

All Agent calls use the current Run catalogue from the System Action dispatcher;
an absent operation is an explicit permission refusal, indistinguishable from an
unknown name. Domain-hidden objects remain 404. The Work Skill and shared Room
execution rules require checking only current tools and visible objects after
404, without alternate-name/id probing, automatic write replay or unverified
repair promises. Field errors point to `describe` and expose only safe field
names/codes. Workspace action hints use the owning module's live authorizer and
admission rules; they never confer write authority. See
[SYSTEM_ACTIONS](../architecture/SYSTEM_ACTIONS.md#agent-discovery-failures-and-recovery).

## Main Flows

**Queued run creation**

1. Agent Run producers create an explicit `execution_kind = agent` Run with its
   AgentVersion and optional requested Profile pin.
2. The router selects an eligible Profile (or honors an explicit pin), then
   stamps the selected Profile id, `runtime_key`, route decision and Profile
   snapshot before execution.
3. `RunOrchestrationService` dispatches through the execution Host daemon and
   shared ACP adapter/controller.
4. ProviderTask Runs are a separate bounded-call shape and are not dispatched
   as Agent Runs.

**Run lineage (parent_run_id)**

`parent_run_id` supports user-created lineage: follow-up runs, retries, manual continuations, and
external run imports. `trigger_origin="parent_run"` is not a valid trigger origin — parent lineage
is a structural link, not a trigger type. Valid trigger origins: `manual`, `automation`,
`autonomous`, `job`, `system`, `delegation`, `continuation`. `user`, `api`, and `workflow` are
accepted on read so existing rows parse. Do not write them as a new trigger origin.

Agent-to-agent child-run creation is represented by `run.spawn_child` inside
`AgentRunGroup`. The backend route surface lets a human manager create rooms,
post messages, and audit timeline/trace state. Direct public child-run spawning
is not exposed; child-run creation goes through `AgentGroupRunService`, active
same-space group membership checks, parent-run agent identity checks, and the
`run.spawn_child` policy gate. `runtime.execute` controls adapter execution
only; it is not a delegation replacement.

Agent Room budgets may shrink the default delegation depth, parent fanout, and
group concurrency ceilings; they cannot expand those server defaults. The
`run.spawn_child` policy request fails closed unless these budget/capacity
proofs are present.

Delegated child-run lifecycle is projected back into the group room after the
run state changes. Started child runs update `run_delegations.status` to
`running` and write `delegation_started` trace events. Terminal child runs write
the terminal delegation status, a bounded result summary, a
`delegation_result` group message, and `delegation_completed` trace events on
both the child run and root run. Child proposals stay proposals; the group flow
does not auto-apply them.

Room agents can explicitly wait for other room results through
`agent.wait_for_results`. A waiting run uses status `waiting_for_dependency`;
the worker is released, and the lifecycle projector requeues the same run with
dependency summaries once all declared dependency runs are terminal. Additional
input the person sent the parked run meanwhile is appended to that
continuation and settled with it ([Rooms](rooms.md#ordinary-send-into-an-active-turn)). Delegation
completion alone does not create an inferred follow-up run.

The CLI tool route flushes a successful `waiting` receipt before asking that
execution's live channel to yield through ACP `session/cancel`. Its cancelled
prompt completes as a dependency pause and preserves the vendor session. A
runtime still alive after five seconds is stopped through the Host's existing
nonce-scoped stop/force protocol. The worker still waits for runtime completion
and cleanup before admitting children; the request never releases execution
or directory ownership itself. Closed channels cannot target a resumed attempt.
Queued delegation turns expose `queue_wait_reason` from the same scheduling
reader used by `agent.list_runs`; the activity companion distinguishes waiting
for the parent to yield from waiting for delegation admission. State stream
frames update and clear this reason even when the turn state stays unchanged.

Each result in that continuation carries its `run_id`, the result summary
(2,000 characters at most) and the task the waiter assigned it, clipped to
2,000 characters by `runAssignedTaskExcerpt` (the delegating call keeps the
whole task). The same clip applies to the task in a `ready` tool result. A run
that waits again — `own_delegations` lists every delegation it ever made —
records the results it was handed in `waiting_for_results.delivered_run_ids`,
kept across later parks. Its next continuation names those by agent, `run_id`
and status only and says `agent.wait_for_results` with `scope: run_ids` reads
one again. Resending every earlier task and result on each resume once pushed
a long review loop's prompt past Codex's 1,048,576-character input limit.

**Hand-over of long material.** The `agent.delegate` instruction's own
description tells the delegating Agent to refer to what the target can
already read (workspace files, earlier results by run id) instead of copying
it, and not to write hand-over files into the workspace or `/tmp` (a
read-only target's namespace has a fresh `/tmp`; the workspace is the
person's). In a Room, a task longer than 16,000 characters
(`DELEGATION_INLINE_INSTRUCTION_CHARS`, `agentGroups/delegationBrief.ts`) is
never refused: `spawnChildRun` stores it whole as a `delegation_brief`
Artifact of the delegating Run (`surface_role: operational`, inheriting that
Run's grants, B8A), and the delegation row, the `delegation_request` message
and the child's prompt carry its first 4,000 characters and its
`rainver://artifacts/<id>` link. Every Room child already holds
`input_resource.read/search`, which resolve that link on any Host and under
any isolation (`architecture/SYSTEM_ACTIONS.md`). Outside a Room the task
stays inline and the runtime's input limit is the bound
(`modules/runtime-adapters.md`). The threshold was set from this
deployment's delegations to 2026-11-05: median 1,240 characters, the longest
written instruction about 10,400, everything over 16,000 pasted material.

Every new live or structured delegation must declare `workspace_access` as
`read` or `write`; omission/null fails validation instead of silently choosing
write access. Independent research/review without workspace edits uses `read`;
workspace changes use `write`. The service validates before policy preflight
and creation, enforces the parent's read ceiling, and snapshots the selected
value on the child. The parent delegates all independent readers then yields;
the existing FIFO admits compatible readers together and keeps writers
exclusive. Tool results expose the selected access/concurrency, and
`agent.list_runs` adds access and current scheduling waits without prompts or
results. See [execution contracts](../architecture/EXECUTION_MODEL.md#explicit-read-only-review-delegation).

In an isolated Location-backed Room, an explicit code review uses
`workspace_access: "read"` and `review: {}`.
The review prompt carries the usual identity, compact review rules, and the
tool and workspace guidance needed for the review. A follow-up can set
`review.previous_run_id` to the same reviewer's completed Run under the same
coordinator Run. Give the old/new commit, remaining findings, changed files
and relevant document sections in `instruction`. Inspect full sources when
they bear on the finding. Independently requested reviews start fresh.
The server checks the previous verified review, the audience, identity,
configuration, thread and workspace generation, and recorded occupancy before
requesting native resume. An ineligible source starts with a fresh session.
The new Run always receives its own Host-verified review basis. Audit
`model_override_json.delegated_review.session` records dispatch intent and the
runtime usage records whether it actually resumed.

For the same implementation under the same coordinator Run, use
`workspace_access: "write"` and `continuation.previous_run_id` to point to the
same writer's last completed Run. Include remaining changes and checks in the
instruction. The saved commit and bounded result accompany the follow-up when
the previous Run is fully readable and its checkpoint belongs to the same open
batch. A matching session can resume when its recorded context is at most a
quarter of its window. Other follow-ups start fresh. Independent writes omit
the continuation field. The ordinary write lease, checkpoint and publication
rules still apply. `model_override_json.delegated_write.session` records the
dispatch decision.

The web Agent Rooms surface is the Projects module's `rooms` route
(`/projects/:projectId/rooms`, `apps/web/src/modules/agent_groups/AgentGroupsPage.tsx`).
It creates manager-led rooms, reads group timeline/trace, posts
natural-language room messages, and exposes room settings separately from the
chat surface. The default recipient is the manager. A structured Tiptap `@`
mention that opens the message or a line addresses that member directly
(adjacent mentions fan out one segment); mentions inside a sentence hand the
whole message to the manager with those members as coordination targets. The
composer shows the route and lets the person switch it (`modules/rooms.md`,
"Addressing and routing a message"). Room members define the `agent.delegate` target
pool and `agent.wait_for_results` can wait on sibling or delegated runs.
Child artifacts and proposals link to the existing Artifacts and Review
surfaces instead of creating a separate approval path.

**Agent definition changes**

Both paths are owner direct edits, gated by `assertAgentOwner`; there is no
public config-proposal route:

1. **Owner direct edit (no proposal).** `PATCH /agents/{agent_id}` applies
   identity fields directly on the `Agent` row. Agent definition changes
   (system prompt, execution constraints, context/memory/tool/output policy,
   schedule and output schema) append a new immutable `AgentVersion` and advance
   `Agent.current_version_id`; no Activity row is written. The owner is the
   authority and there is no second party to review, so a
   proposal would be pure ceremony. Runtime policy gates still apply at execution.

2. **Owner config UI edit → `POST /api/v1/agents/{agent_id}/config`.** This
   focused endpoint appends an immutable `AgentVersion` and accepts the prompt,
   context/memory/tool/output policy, schedule/output schema, and typed
   `execution_constraints` (`risk_level`; legacy `max_run_time_seconds` is
   accepted for compatibility but is not enforced or offered in the UI). It does not
   accept runtime identity, Provider/model binding, backend mode, Host,
   installation, or Profile options; those are changed through the Runtime
   Profile API. Safety clamps preserve memory-proposal and output-policy
   requirements, so an Agent definition edit cannot directly grant tools or
   write authority.

Every Agent definition, Runtime Profile, role, Run-start and direct-chat
write URL is an operation-core command (`agents/operations.ts`,
`agents/chatOperations.ts`; SYSTEM_ACTIONS "Agent and Room commands"): a required
`Idempotency-Key`, identity receipts re-read through the Agent/Profile/Run GETs,
and the same owner/configurer/placement gates below rechecked in the transaction.
The UI's create body's tool/output/schedule policies are now kept on the initial
version (the old route silently dropped them).

**Version restore — `POST /api/v1/agents/{agent_id}/versions/{version_id}/restore`.**
   Appends a brand-new `AgentVersion` whose config is copied from the selected prior version,
   then advances `current_version_id`. The selected version is never mutated or reactivated;
   history stays append-only. Restore, like every other Agent mutation (identity,
   config, runtime-profile writes), passes the one owner gate `assertAgentOwner`
   (`agents/agentAccess.ts`, 404 on refusal): the owner may; an unowned
   system-managed Agent (Project Research, source annotation, source
   post-processing) only the Space's owner or admin may; the Assistant is never
   changed through these paths — its runtime profiles, like its settings and
   its agent-scope prompt and workflow versions, are changed only by the
   person who configures it (`canConfigureAssistant`: the Space creator for
   the Space Assistant, the Project owner for a Project Assistant). Agent-scope
   asset versions and pins of any other Agent follow `canChangeAgent`; Space
   role alone grants neither.

Project overview **Runtime settings** opens the Project Assistant's reusable
profiles. The Project owner can add a Host/workspace profile and set its
default there. Before a new Room conversation is confirmed, each participating
Agent with multiple eligible profiles can pick one for the selected Host and
workspace. This choice pins that conversation without changing the Agent default.

**Read endpoints for the config UI:**
   `GET /agents/{id}/current-version` (current `AgentVersionOut` config snapshot),
   `GET /agents/{id}/versions` + `/versions/{version_id}` (history + detail).
   These use the same Agent content ACL as `GET /agents/{id}` (404 on deny).
   A `summary` viewer keeps version metadata and loses `system_prompt`.
   Also:
   `GET /agents/{id}/proposals?status=pending` (proposals linked to the agent — config updates
   plus run-emitted proposals), `GET /agents/{id}/runs` (run history),
   `GET /agent-roles/{id}/versions/{version_id}` (role version config for the library
   cards and the create-from-role summary).

All edit paths preserve the version-immutability invariant (append, never mutate). Direct
version creation via `POST /agents/{id}/versions` remains disabled.

## Reusable Agent identity and Project boundaries

Standard Agents have no execution-owning `project_id`. `project_agent_links`
places the same identity in each Project; each Conversation chooses its own
Host, CLI installation and workspace. `access_project_id` independently retains
a Project content ACL and the management boundary of its Agent policy. Creating a standard
Agent with a Project sets that access scope and creates its Project link in
the same transaction. Linking elsewhere grants no content access.

Migration `0019_agent_workspace_and_conversation` performs the one-time cutover for
all old standard Agents, including archived identities. It copies their old
Project into `access_project_id`, adds missing original-Project links without
reactivating removed links (unattributable links are skipped), and clears only
their execution ownership. IDs,
versions, grants, policy versions, default Profiles, Sessions, Host threads and
Run snapshots stay unchanged. It requires stopped old writers; there is no
conversion button or runtime legacy adapter. Managed `system_assistant`
identities retain their Project ownership and provisioning rules.

An Agent policy keeps its original Project parent and management boundary and
contributes on every execution. With no explicit execution Project or Folder,
policy resolution falls back to the retained access Project, preserving legacy
direct-chat Project and Agent constraints. An explicit Project B resolves B's
Project policy plus the Agent policy, without loading A's Project policy.
Constraint intersection and preference clamping use the canonical resolver;
immutable AgentVersion constraints remain Agent behavior everywhere.

The retained access Project remains a mandatory dependency for Agent **content**
reads and ordinary direct use. It is not an execution grant. A Project-writer
Room member who owns the Agent may explicitly authorize its use in another
Project's Room. This reuses `room_agent_access_grants`, exact current-member
confirmation and the Room lock; it never clears `access_project_id` or changes
visibility. Even a `space_shared` Agent needs this owner confirmation when its
retained access Project differs. Non-owners cannot add such an Agent merely
because they can read both Projects.

`rooms/agentUsageSql.ts` is the execution-only predicate for roster dispatch,
Conversation preflight/init, queued binding/authorization and Work Context
Delivery. It checks active Space/Project/Room authority, active specialist
membership and a live grant from the Agent's current owner. For cross-Project
use, that owner must remain an active person, Space member, Project reader and
writer, and Room member. Room removal revokes both received and issued grants;
Project removal or loss of write authority revokes issued grants transactionally.
Restoring membership after Room/Project revocation needs fresh consent. Project audience and Room locks fence
Delivery against these changes; Agent locks protect owner changes. A B-only member can
execute in B without reading A, the Agent definition or its other work. A
Project link shown solely through this grant returns `room_only`, no description,
and only the viewer's Rooms; its UI opens the Room rather than direct chat,
configuration or global history. Generic Agent content gates do not accept it.

Cross-Project execution withholds the old role, AgentVersion system instruction,
capability descriptions, persona and Agent-bound Skill packages. Legacy free-text
fields cannot prove absence of Project-derived facts. Notes are delivered only
within the target Project (and in an isolated execution, only from this Room).
The reverse boundary is enforced too: an isolated Run cannot create or revise
global persona through direct writes, proposal creation, or owner acceptance.
The canonical applier rechecks canonical Run provenance and retention under
an Agent share lock; owner approval grants no cross-Project content transfer.
Delivery quarantines historical persona with foreign-Project Run provenance,
including provenance copied along revisions.
The target Project's published context and explicitly selected Project Skills
remain available. Runtime Context automatic retrieval filters to target-Project
objects before delivery; the final release closure rejects foreign Project
dependencies even for a viewer of both Projects. Interactive global search/brief
tools, whose LLM stages have no Project filter, are withheld for isolated use.
Typed Runtime Context constraints still intersect normally; arbitrary old Agent
policy bags are not a model-visible input.

Conversation × Agent Host threads, managed cwd and CLI profiles are separate
for A and B. There is no history/attachment replay from the original Project;
archive restoration is limited to this same Room. Removing a specialist or user
revokes future use, including queued Runs; invitation activation extends Room
use only after the current owner approves the exact roster snapshot. Delivery
holds Room/audience locks through commit, ordering release against revocation.

Location Profile admission requires the current actor's Host ownership,
Project writer access and an active Project Agent link (or that Project's
managed Assistant). Conversation setup passes its actual Project; an explicit
non-Project context cannot infer one from a Location. Candidate Profiles hide
Locations outside the Conversation's Project. For a draft direct chat,
`GET /agents/:id/conversation-backends?project_id=` carries a read-checked
Project until a Session exists; thereafter the Session is authoritative, and a
mismatched Project is refused. Dispatch and retry retain
the Run/Location Project check. Existing initialized Conversations keep their
pins after link removal; live Project and Agent content authority is rechecked
before queued execution. New direct Conversation setup resolves its explicitly
selected Agent before considering historical Host threads or an Assistant.

Reuse / Dependency Check: extend `project_agent_links`, canonical content ACL,
Profile admission, Conversation bindings and runtime-policy resolver. Drizzle
and the existing PostgreSQL migration runner own schema changes; shared real-PG
fixtures own verification. This is domain authorization, so no external engine
or additional dependency is needed.

## Project Agents and independent use

The Agent library (`/agents`) creates, configures and directly uses Agents
with no Project or Room. A Project's Agent list is a separate, Project-owned
reference (`project_agent_links`, [PROJECTS](../architecture/PROJECTS.md#project-agents)):
the same Agent can be on several Projects' lists and in several Rooms without
being copied, and each Room conversation keeps its own Conversation × Agent
host thread and CLI state (see [rooms](rooms.md)). Being on a Project's list
is what lets a person start a direct conversation with the Agent placed in
that Project (the Agent's first turn in a Project-placed direct session —
new, or created empty beforehand — returns 409 otherwise; the Project's
managed Assistant is exempt; a session where the Agent already ran keeps
going). That conversation is a direct session with Project context — it is in
no Room, carries no Room transcript, and its Run gets the same Project tool
allowance as other Project-placed direct turns. On a Host it is its own
Conversation container (thread, managed cwd, runtime profile and archive keyed
by the Session; see [PROJECTS](../architecture/PROJECTS.md#project-agents)),
never the Agent × person direct container that non-Project direct chats share.
Agent creation from a Project's Agents page or a Room's members carries a
validated `return_to` (`projects/agentCreationReturn.ts`) and comes back with
the new Agent named for one explicit add; `/agents/:id?tab=runs` opens the
Agent's Runs as its work history.

## My Agents (cross-Space list)

`GET /api/v1/me/agents` (`agents/myAgents.ts`, DTO `MyAgentsPageSchema` in
`packages/protocol/src/myAgents.ts`) is one person's Agents across every
Space they are an active member of; the web page is the user-scoped
`/my-agents` (`MyAgentsPage`), reached from the rail, and an in-Space
`/agents` index redirects there. It is person-scoped: the route ignores the
browsed Space (`X-Rainver-Space-Id` or `?space_id=`) and the web call sends
none, so a direct open, a refresh or a Space the person left never refuses it;
a signed-in person with no active Space gets an empty page (`resolvePerson`),
while a missing, invalid or expired session is still refused.
The page keeps the Agents scene navigation (desktop sidebar, mobile tabs); while
no Space is known its in-Space entries and the Roles/New agent buttons are
inert rather than links that land on Home. It refreshes quietly while visible:
the refresh re-reads the whole loaded range in server-sized pages (so more
than 200 loaded entries are never cut back). Each page carries the `revision`
of the whole filtered list, computed in the same statement as the page and
its total: the SHA-256 of one JSON array per entry, in list order, of exactly
the values the response shows (`agent_id`, Space id and name, name, status,
description, `access`, `management`, `plugin_id`, home Project id and name —
not its Rooms, read per page after it). `access`, `management` and `plugin_id`
are projected once in SQL and returned as they were digested, so a Room-only
entry's hidden role source, description, home Project or ownership never
reaches the revision, and a null, an empty string and a field boundary stay
distinct. The pages are stitched only when they all carry one revision, so
they were cut from one list and repeat or skip nothing, whatever moved, and an
access change between the reads also counts. Otherwise the refresh starts
over, at most three times, then keeps the current answer
(`myAgentsPaging.ts`). Every page still runs the live gates. Only the latest
refresh writes: one is dropped if a newer refresh, a reload or "Show more"
started or finished meanwhile for the current filters. Earlier filters’
pending requests do not block or invalidate a refresh. "Show more" (`readMore`) reads the page at the
server position after the last entry and appends it only when it carries the
shown list's revision; otherwise the list moved since it was shown (an entry
added, removed or moved across the pages), and the shown range together with
the new page is read again through the same bounded `readRange` and replaces
it, so it repeats and skips nothing. A list that never settles keeps what is
shown and offers Retry; a reload or filter change meanwhile drops the answer.
Rooms and plugin states are read live per page and change on the next
refresh. It adds no authority:

- An Agent is listed when the ordinary Agent content gate (`contentReadSql`)
  admits the person, or when `roomAgentUseSql` admits them in one of its
  Space's Rooms of an active Project (`access`: `owner`, `shared` or
  `room_only`); an archived Project's Room admits no entry. The listing
  form of that predicate (`anyAgentStatus`) ignores only the Agent's own
  status, so a stopped Agent stays listed for the people its Rooms admit; it
  never decides execution. Archived and managed Assistant Agents are not
  listed.
- A Room-only entry carries its name and the person's admitting Rooms only:
  no description, home Project, detail, direct chat or plugin source
  (`plugin_id`, `plugin_state` and the plugin page are omitted, only Rooms that
  work for the person now are named, and `source=plugin` never matches it). Every Project and Room
  named passes the person's own read/membership gates; a Room in a Project
  they do not read is never named.
- `management` is `canChangeAgent`'s rule (owner; Space owner/admin for an
  unowned Agent). `GET /agents/:id` returns the same answer as `can_manage`;
  the detail page disables every editing control otherwise and says who
  manages it.
- The Room summary counts Rooms where it works for the person now: the
  Agent is active, `roomAgentUseSql` admits them, the Project is active and,
  for a plugin's Agent, the companion admission's plugin conditions hold for
  that Project (`plugin_state`: `ready`, `unbound`, `disabled`). Zero shows
  "no Room available" and keeps the entry; one names its Room; several
  expand by Project. Each link opens the Room, detail, direct chat or the
  plugin's Project page in the Agent's own Space.
- Filters are server-side: `manage=all|manageable` and
  `source=all|mine|shared|room_only|plugin`.

### Stopping an Agent

A manager stops an Agent from its detail page (`agent.update` with
`status: "disabled"`, after a confirmation) and restores it the same way.
Only the status changes: configuration, versions, Runtime Profiles, Project
links, Room seats, grants and history stay. A stopped Agent accepts no new
request from any entry: direct chat (`getAgentForChat`), Room dispatch and
Run claim (`roomAgentUseSql`, `checkRunExecutionAuthorization`), Room
candidates, delegation, and every new Run (`createQueuedRun` refuses a
non-active Agent with 409). Stop shares one row-lock boundary with Run
admission: enqueue reads the Agent `FOR SHARE` in the Run's own transaction,
and every claim (direct, Room or plugin) re-reads its status `FOR SHARE` as its
own statement after the Room, conversation and plugin locks, refusing a stopped
Agent (`agent_not_active`) before the Run is `running`. A stop that commits
first is seen by both; one that does not waits until the Run is queued or
running. A Run already `running` is not interrupted. Restoring re-admits it wherever current access
holds at that time. Removing it from one Room only ends that Room seat; it
is not a stop. Archiving a Project takes the same kind of boundary for Room Runs: every Room claim (ordinary or plugin) share-locks the Room's own Project row (never the Project the Run names), re-reads it as its own statement, and refuses (`project_not_active`) when it is no longer active, so an archive that commits first starts nothing there and one that does not waits until the Run is `running`. A Room Run works in its Room's Project: enqueue refuses one naming another Project (409; a Run Group's scope key already ties it), and a stored Run that names another is refused at claim (`run_project_mismatch`). A Room Run naming no Project keeps the Room's Project as its authority; a plugin's companion Agent still requires its Run's Project and is refused without one. Reading an archived Project's history is unchanged. Tests: `server/test/myAgentsDb.test.ts`.

## Frontend Agent Configuration Surfaces

The React `agents` module (`apps/web/src/modules/agents/`) renders the product-level UI over
the backend role → AgentVersion model. No mock/hardcoded role or agent data
remains; every card is backed by an API call.

- **My Agents** (`MyAgentsPage.tsx`, `/my-agents`) — the cross-Space list
  described in "My Agents" above.
- **Role Library** (`RoleLibraryPage.tsx`, `/agents/roles`) — lists the
  system catalog roles from `GET /agent-roles` (no plugin Roles). Each card shows name, description,
  category, scope, visibility, status, current version, and input/output/safety summaries
  (derived from the current role version config). Actions: **Create agent**, **View details**.
  Roles are presented by their own identity (e.g. *Activity Reflector* = the reflection
  factory). "Daily Reflector" is not a role — it is simply a name a user might give an
  Agent created from *Activity Reflector* and scheduled daily; scheduling is an instance choice,
  not a role property, so the library does not conflate the two.
- **Role Detail** (`RoleDetailPage.tsx`, `/agents/roles/:id`) — read-only Inputs/
  Outputs/Schedule/Safety views of the current role version; deployment
  backend is provisioned separately from the role.
- **Create from Role** (`CreateFromRolePage.tsx`, `/agents/roles/:id/use`) — shows
  the selected role-version summary, lets the user set name/description and
  Agent-definition overrides (including prompt and schedule settings), then calls
  `POST /agent-roles/{id}/agents` and navigates to the new Agent detail page.
- **Agent Detail** (`AgentDetailPage.tsx`, `/agents/:id`) — Stop/Restore and every
  editing control only when `can_manage`, otherwise read-only with who manages it
  (view controls such as Profile switching, raw JSON, version configs and catalog
  retry stay usable; a Space owner/admin is told Access remains theirs);
  direct chat only for an active non-plugin Agent. Tabbed view: **Overview**
  (identity/role edit, provenance, current version, last run, pending proposals), **Preferences**
  (the managed Assistant only), **Inputs**, **Outputs**, **Schedule** (editable), **Runtime**
  (runtime profiles), **Tools**, **Review & Safety**, **Versions**
  (history + restore), **Runs** (real run history with useful empty state).
- **Policy → product mapping** (`policyMap.ts`, rendered by `ConfigCards.tsx`) is the single
  source of truth that translates `context_policy_json` → input cards (capture inbox / approved
  memory / previous reflection summaries / sessions / Project Folder), `output_policy_json` → output
  type cards (task/idea/memory proposals, reflection summary artifact, wiki/archive), with memory
  outputs always shown as review-required; `tool_policy_json` + `memory_policy_json` → the
  "this agent can / cannot" safety statements and a derived review posture (Strict/Balanced/
  Draft-friendly, read-only since the backend has no editable review_mode);
  `schedule_config_json` → manual/daily/interval/cron summary; runtime profiles → runtime/backend/
  Host/installation choices. Raw JSON appears only behind an explicit **Advanced** disclosure (Runtime
  tab, Versions view).

Not built on this surface: full scheduled reflection execution, marketplace /
sharing / import / export, role inheritance, runtime use of roles,
direct memory writes, or faked frontend data. There are no role
create/publish endpoints; roles are catalog files and the Agents UI does
not author custom roles.


## Creating an Agent (one flow)

Every user-initiated creation goes through `/agents/new` (`AgentFormPage`). It is reached from My Agents, a Project's Agents page and a Room's "Create a new Agent…" with `?project=&return_to=`. A **Start from** card offers **Blank** or an official catalog Role. A plugin's Role is a Project-specific assistant: it is offered and created only from that plugin's page in a Project where the plugin is bound and enabled, never from New Agent or the Role library, and the server refuses it without a Project, in an archived Project (which also lists no plugin Role), unbound, not enabled or without Project write. Creation takes bind's lock order (plugin scope shared, then the Project, then the binding row) and re-reads enablement and binding after those locks, so a concurrent disable or unbind either commits first and the Role is gone, or waits until the Agent exists ([OFFICIAL_OPTIONAL_MODULES](../architecture/OFFICIAL_OPTIONAL_MODULES.md), Agent Roles). Choosing a Role keeps the Project and the return path (`/agents/roles/:roleId/use`); Cancel, like Create, goes back to an accepted `return_to`. The Role form reads the Project list like the blank one (a Role page opened directly keeps its carried Project) and sends `project_id`; "start blank instead" returns to the same component with every Role-derived field and policy cleared. A Role that cannot be read here (removed, or a plugin's) shows that it is unavailable with a link to the blank form, never a form that would submit to it. An Agent created from a plugin's Role runs only where that plugin is set up ([OFFICIAL_OPTIONAL_MODULES](../architecture/OFFICIAL_OPTIONAL_MODULES.md), Companion Agent admission). A plugin's own setup (`PluginAgentSetup`) lists its Role with its Project (`?project_id=`) and uses the same `agent.role.instantiate` with that Project, reusing an authorized Agent and the ordinary Room add with its share confirmation; there is no separate form. There are no per-Project×Agent settings, sub-agents or custom Role publication. A Project preference an Agent learns is proposed as Project memory through the existing approval.

## Built-in Roles (no built-in concrete agents)

There are no eagerly seeded per-space concrete Agents. Built-in product behavior comes from system
roles (factories), while a Project's hidden managed Assistant is provisioned lazily
and only when someone first opens a Conversation draft in one of its Rooms. Keeping it off Room
creation is what lets a Project be created with its mainline Room without a
Space's backend configuration being able to fail the Project
([ADR 0018](../decisions/0018-room-as-visibility-boundary.md) decision 4).

Built-in **roles** (global factories read from
`catalog/agent_roles/<key>/role.yaml`; nothing is seeded into the database). Five are **public** reusable specialized factories; the sixth,
`personal_assistant`, is an **internal seed spec** (`visibility=system_internal`) for the
per-Project `system_assistant`-kind Agent — hidden from the public library and not
user-instantiable.
**`general_chat` is intentionally not seeded** and there is no generic product-level DirectChat.
The host-bound Agent chat surface is a constrained exception: it is still an
explicit Agent, owner-only, and uses the Agent's host profile/container rather
than a space-wide default:
- `personal_assistant` (`assistant`, `system_internal`) — provenance seed spec for the
  per-Project `system_assistant`-kind Agent; dynamic per-invocation selection via Runtime
  Context; `chat_message` + proposal-only task/idea/memory/knowledge. Not a reusable
  role. A Project's concrete Assistant is created transactionally when the first
  Conversation draft is opened in one of that Project's Rooms; a boot-time reconcile brings every
  seed-following instance up to a changed seed afterwards.
- `activity_reflector` (`reflection`) — model-only; processes captures/activity into typed
  proposals + reflection summary; `classification_mode: model_selects`; proposal-only durables
- `memory_reflector` (`memory`) — model-only; memory update/merge/delete proposals only (+ noop);
  never writes/merges/deletes memory directly
- `knowledge_curator` (`knowledge`) — proposes semantic KnowledgeItem types, relations, and source
  links; source is not an item type, an answer is a relation; proposal-only
- `research_reader` (`research`) — reads selected sources only; no web search / crawling; produces
  source summaries, questions, and knowledge proposals
- `coding_reviewer` (`workspace`) — read-only review/report outputs; no file write, no shell, no
  patch apply. There is no code-writing `coding_task_agent`.

Why no `general_chat` or generic DirectChat: a generic session-only chat object would be a naked
conversation with no Agent identity or space-aware policy. Every Room conversation, and every
host-bound direct chat, instead targets an explicit, space-scoped `Agent` — carrying that Agent's
context policy and proposal-only output policy — resolved through the conversation backend
binding (`modules/rooms.md`). Host-bound direct chat is owner-only, uses one direct container per
Agent × owner, and exposes reset/archive/opt-in restore semantics; it does not make arbitrary
Agents into a global default. These role ids are not seeded:
`coding_task_agent`, `research_scout`, `source_processor`,
`weekly_planner`, `finance_reviewer`, `health_reviewer`, `task_manager`.

There is **no** single global "default agent" that runs implicitly. Every `Run` targets an
explicit `Agent`, and execution config resolves from the Run's snapshotted runtime profile plus
`Agent.current_version_id` → `AgentVersion`.
A `system_assistant`-kind Agent is system-owned, hidden from ordinary Agent list/detail/create
surfaces, and limited to one active instance per Project (plus a Space-level slot the schema
allows and nothing newly fills). Opening a Room's first Conversation draft lazily provisions the Project's instance from the
internal `personal_assistant` prompt seed and uses it as the immutable Room manager. Its
runtime profiles remain shared definitions; the speaking user's API eligibility or CLI credential
is resolved per conversation binding. It also anchors soft Assistant **preferences**
(`agent.default_assistant.settings`) without allowing those preferences to change the core prompt
or hard policy.

Memory reflection (`POST /api/v1/sessions/:sessionId/reflect`) writes a
`memory_create` proposal from the recent transcript. It does not run a
capability or a built-in Agent. The `memory_reflector` role is the factory
for a standalone reflection Agent. Do not route that request through
`memory.reflect`.

Agent runtime tests exercise ACP or inject a narrow test execution port. The
planned `capability` entry is not an implemented no-credential Agent runtime.

## ACP Runtime Registry

The currently implemented Agent runtimes are `opencode`, `claude_code`, and
`codex_cli`; all use the shared ACP adapter/controller. OpenCode supports both
`runtime_native` and `model_provider`; Claude and Codex currently use their
Host-local native login. Planned `capability`, Gemini, and generic custom
entries are not selectable Agent execution paths. Runtime-specific Host,
workspace and isolation facts come from the runtime registry and are enforced
by routing and the Host daemon.

## Invariants

- Every Agent Run is dispatched to an execution Host and uses ACP; there is no
  Server-owned Agent loop or `model_api` Agent runtime
- Runtime identity and backend mode come from the selected AgentRuntimeProfile,
  never from AgentVersion or a Host-global provider default
- Provider secrets remain server-side; native logins remain on their execution
  Host
- Context snapshots captured at run creation stay immutable
- No vendor adapter is the source of truth for memory, policy, or audit
- `agent_version_id` on `Run` is immutable per row — historical runs stay reproducible after edits to `Agent`
- `runtime_profile_snapshot_json` on `Run` is immutable per row — historical runs keep the selected runtime binding after profile edits
- `AgentVersion` is append-only — prior rows are not rewritten in place
- Public post-create execution config mutation is owner-direct. `PATCH
  /agents/{agent_id}` and `POST /agents/{agent_id}/config` append an
  `AgentVersion` and may advance `Agent.current_version_id`. There is no
  config-proposal route, and these writes do not record proposal provenance.
- Agent configuration is loaded from the immutable AgentVersion path; it is not
  represented by a Memory row or Runtime Context checkpoint.
- The owner config UI (`POST /agents/{id}/config`) and create-from-role overrides
  cannot loosen hard-safety snapshots (tool/runtime policy copied verbatim) and cannot
  expand memory `writable_scopes`, disable memory `requires_proposal`, or turn off output
  `proposal_only` — those are re-stamped from the source version.

## Related Files

- `server/src/modules/agents/` — Agent CRUD and run creation helpers
- `server/src/modules/runs/` — Run creation, listing, and orchestration
- `server/src/modules/runs/orchestrationService.ts` — canonical orchestrator
- `server/src/modules/runs/` and `policy/` — risk/sandbox mapping and file-access adapter validation
- `server/src/modules/runtimeAdapters/specs.ts` — RuntimeAdapterSpec catalog
- `server/src/modules/runs/remoteHostCliAdapter.ts` — the host daemon CLI adapter local CLI execution
- `server/src/modules/agents/` — AgentVersion behavior
- `server/src/modules/agents/routes.ts` — agent HTTP API incl. `/config`, `/current-version`,
  `/versions/{id}/restore`, `/proposals`
- `server/src/modules/agentRoles/routes.ts` — role HTTP API over `catalog/agent_roles/`
- `apps/web/src/modules/agents/policyMap.ts` + `ConfigCards.tsx` — policy/config JSON → product cards
- `apps/web/src/modules/agents/{RoleLibraryPage,RoleDetailPage,CreateFromRolePage,AgentDetailPage}.tsx`

## Related Decisions

- [0002-agent-model.md](../decisions/0002-agent-model.md)
- [0004-context-wrapper.md](../decisions/0004-context-wrapper.md)

## Related Docs

- [runtime-adapters.md](runtime-adapters.md) — adapter registry, three-way separation, license notes
- [hosts.md](hosts.md) — execution hosts and the strict-mode namespace
- [provider-policy.md](provider-policy.md) — model provider configuration
