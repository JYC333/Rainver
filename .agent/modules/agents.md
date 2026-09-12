# Module: Agents

## Purpose

Define AI agents and wire them to execution. An agent is a configured product-level actor — separate from the human user who owns it and separate from the runtime adapter that executes it.

## Three-Way Separation

```
Agent            — product-level actor (owned by user/space/Project Folder, has policy)
    ↓ dispatches via
Runtime Adapter  — technical execution backend (capability, model_api, claude_code, codex_cli, …)
    ↓ calls
Model Provider   — underlying LLM (Anthropic, OpenAI, Ollama, …)
```

See `runtime-adapters.md` for the full adapter registry and license notes.

User-created Agents and template instances use the access-owned creation
resolver. A Project entry point writes `agents.project_id` and
`visibility=space_shared` in that Project's Space; an unbound creation lands
private in Personal Space. Direct Run and chat creation applies the same rule,
including the Session and Run rows. System-managed Agents are derived system
resources and keep their explicitly declared scope.

## Owns

- `Agent` ORM model and CRUD
- `AgentVersion` model (immutable execution config snapshot per `Run`)
- `AgentRuntimeProfile` model (named runtime/model/credential binding options under an Agent)
- `AgentTemplate` / `AgentTemplateVersion` — reusable factories (NOT runtime objects)
- `AgentTemplateService` — author templates + copy-on-create `create_agent_from_template`
- `Run` rows created through `RunService` (queued work, lifecycle, delegation links)
- Runtime adapter selection fields on `AgentVersion`
- System AgentTemplate seeding (factories; concrete system agents are provisioned on demand)
- Agent seeding and product-level agent configuration

### Project Research execution defaults

Project Research uses the normal Agent/AgentVersion/AgentRuntimeProfile path,
but users do not need to create those objects before starting Auto Research.
`ProjectResearchExecutionProfileService` provisions or reuses a space-scoped
`agent_kind="system_research"` Agent and a `model_api` runtime profile from
the selected ModelProvider/model. Research persists the resolved Agent/profile
IDs on the workflow and operation, so incremental runs keep the same managed
execution selection. Research setup does not expose runtime adapter or CLI
credential configuration.

OpenCode supports both the login its copy holds on its host and a direct
ModelProvider path. Provider
mode materializes a sandbox-local `opencode.json` using
`@ai-sdk/openai-compatible` and an expiring provider-proxy lease. Raw provider
API keys are never passed through subprocess environment variables.

## Agent Template Model (factory → instance)

```
AgentTemplate            — reusable factory; scope=system|space|user; NOT a runtime object
    → AgentTemplateVersion   — immutable config snapshot (published versions are immutable)
        ⇒ (copy-on-create)
Agent                    — the runtime instance
    → AgentVersion           — immutable prompt/policy/base config snapshot
    → AgentRuntimeProfile    — mutable named runtime binding; snapshotted onto each Run
```

Rules (clean model — no old paths):
- A **template is a factory**, never executed. No `Run` / model-call path reads an
  `AgentTemplate` or `AgentTemplateVersion`.
- **Agent always runs from** `Agent.current_version_id` → `AgentVersion`.
- Creating an Agent from a template **copies** the selected `AgentTemplateVersion` into a
  new `AgentVersion` (copy-on-create). `Agent.source_template_id` /
  `source_template_version_id` are **provenance only** — never used to assemble runtime config.
- **Template updates never mutate existing Agents.** Publishing a new template version has no
  effect on already-created agents.
- **Version objects are immutable runtime snapshots.**
- No template inheritance, no runtime merging, no dynamic parent-template lookup.
- Allowed create-from-template overrides apply to the copied `AgentVersion` only:
  `name`, `description`, `model_config_json` (merge), `schedule_config_json` (merge),
  `system_prompt`. Hard policy snapshots (tool/memory/context/runtime/output policy,
  output schema) are copied verbatim and are **not** overridable.
- Allowed create-from-template overrides apply to the copied `AgentVersion` only and are
  **safety-clamped** server-side in the agents module: a memory override can never grant
  `writable_scopes` or drop `requires_proposal`; an output override can never expand
  `allowed_output_types` beyond the template ceiling, drop `proposal_only`, or drop a
  `required_run_outputs` entry; a context override can never expand `allowed_input_contexts`
  (and `default_input_contexts` is clamped to that ceiling). The same clamps apply to the owner
  config edit path.
- Seeded system templates (idempotent, global, no space/owner) —
  five **public** reusable specialized factories, plus the `personal_assistant` **internal** seed
  spec (`visibility=system_internal`, hidden from the library; see below). **There is no
  `general_chat` template** and no product-level DirectChat.
  - `personal_assistant` (category `assistant`, `visibility=system_internal`) — NOT a normal
    reusable template. It is the provenance seed spec for a space's `system_assistant`-kind
    Agent, the anchor for Assistant preferences settings (see below). It is excluded from the
    public Template Library and from user create-from-template; a space is not guaranteed to
    have an instance.
  - `activity_reflector` (category `reflection`) — processes captures/activity into typed
    proposals + a reflection summary; `classification_mode: model_selects`.
  - `memory_reflector` (category `memory`) — proposal-only memory update/merge/delete; can never
    write memory directly.
  - `knowledge_curator` (category `knowledge`) — proposes semantic KnowledgeItem types, relations,
    and source links (a source is not an item type; an answer is a relation).
  - `research_reader` (category `research`) — reads selected sources only; no web search/crawl.
  - `coding_reviewer` (category `workspace`) — read-only review/report outputs; no file write,
    no shell, no patch apply. (`coding_task_agent`, a code-writing agent, is future scope.)
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
  per-recipient typed work-scope CLI binding (`modules/rooms.md`), so which
  Agent and runtime a turn runs against remains a per-conversation, per-user
  choice without making the Room session a vendor-state authority.
  A `system_assistant`-kind Agent (system/space-owned, `owner_user_id` NULL,
  minted lazily from the internal `personal_assistant` seed on a Room's **first
  message**) is the immutable manager execution identity for Room turns. There
  is **one instance per Project**, plus one for the Space itself: two partial
  unique indexes, `uq_agents_system_assistant_per_space` (`project_id IS NULL`)
  and `uq_agents_system_assistant_per_project` — one composite index over
  `(space_id, project_id)` would not do, because a NULL `project_id` does not
  collide and the Space-level row would be unconstrained. A Project's instance
  is named `<Project name> Assistant`; the Space's keeps *Personal Assistant*
  in personal spaces and *Space Assistant* in shared ones, and is the one the
  `agent.default_assistant` settings pointer names — provisioning a Project's
  instance must never repoint it.

  Every instance is materialized from the same seed, so they start identical
  and diverge only as each Project is worked with: its own memory, its own
  token attribution, its own evolution target. `agent_versions.follows_seed_key`
  records which seed a version materializes. Reconciliation re-materializes a
  version carrying the current seed key, adopts an unmarked version whose
  content is already identical to what the seed produces (provably untouched),
  and leaves anything else alone rather than overwrite work it cannot account
  for. No path can author a version for a `system_assistant` today —
  `requireAgent` excludes the kind, and `publishSystemManagedPrompt` refuses it
  — so the day one lands it must clear the mark, which is what makes divergence
  real. The unmarked column *is* the record of divergence; nothing writes a
  second copy of that fact. A left-alone instance still has its runtime profiles
  reconciled, and routing builds its candidates from `agent_runtime_profiles`
  rather than from the version, so declining to republish an instance's prompt
  does not also stop it working.

  Two further decisions, recorded rather than left to be rediscovered:

  - **`agents.project_id` is `ON DELETE NO ACTION`, deliberately.** Projects are
    archived, never deleted, so there is no live failure mode. Should a deletion
    path land, it must **archive** the Project's Assistant — a non-`active`
    status frees the partial-unique slot — rather than delete a row that owns
    Run and token-usage history.
  - **An Assistant's name follows its Project's and is refreshed on the next
    reconcile**, so a Project renamed between Room creations carries the old
    name until then, and two Projects sharing a name give their Assistants the
    same name. Ambiguous, not an error.

  **Seed changes reach existing instances at boot.**
  `reconcileSeedFollowersForAllSpaces` runs once on start (and daily as a
  backstop) over every instance whose current version follows the seed,
  re-materializing it as the Project owner would by creating a Room — so a
  prompt shipped in a release lands on every Assistant that already exists,
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
  `agent.default_assistant.settings` space-scoped setting
  (`GET`/`PATCH /api/v1/agents/default-assistant/settings`) holds
  response style, verbosity, default context toggles, default project, proposal style, and soft
  model preferences. These shape default UI/context behavior only — they are never merged into the
  immutable `AgentVersion` and can never loosen the hard tool/runtime/output/memory/safety policy
  or edit the core system prompt. Per-invocation selection stays dynamic through
  Runtime Context typed acquisition, Delivery, and safe Invocation Snapshot and
  never mutates an `AgentVersion`.
- **Templates carry no hardcoded model** — `model_config_json` has no `model` key, meaning
  "use the system default model". On create-from-template, `_resolve_default_model` resolves the
  space's default `ModelProvider` (the enabled one with `is_default`) and stamps the concrete
  `model_provider_id` + `model_name` (and `model_config_json.model`) onto the new `AgentVersion`;
  an explicit override model wins. When no default provider is configured the binding is left
  empty and the create-from-template UI blocks creation, prompting the user to set a default
  model provider first. Template detail shows the model as "System default model"; the created
  agent shows the concrete resolved model.

## Agent Runtime Profiles

`AgentRuntimeProfile` is the mutable runtime binding layer under an Agent. It
lets one Agent keep the same identity, prompt, capability policy, and safety
ceiling while offering named runtime choices such as "Model API default",
"Codex CLI", or "Claude Code".

A profile may also be host-bound with `execution_host_id`, a `workspace_mode`,
and a pinned `runtime_installation`. `location` mode additionally pins
`workspace_location_id` and requires the Agent's Project context; `managed`
mode has no Location and lets the daemon derive a private workspace per Agent
× Room or direct owner. The selected remote host and installation are
validated against the caller's ownership and the daemon's reported
capabilities. Host-bound profiles do not require a server ModelProvider or
server runtime-tool installation: the paired host owns the CLI login and
runtime process. Room and direct chat dispatch apply the profile's owner-only
trigger and record the real Agent id on the remote Run.

A profile is the runtime an Agent runs on, not the Agent. What the CLI
remembers on that machine belongs to the Agent and the container it ran in —
one runtime profile directory per Agent × Conversation, or Agent × owner for
direct chat ([`hosts.md`](hosts.md)) — so changing the profile does not carry
one Room's CLI memory into another, and two Agents on one machine share none
of it.

Rules:

- Creating an Agent also creates one default runtime profile from the initial
  `AgentVersion` runtime/model values.
- Runtime profiles store adapter type, optional ModelProvider/model, the
  execution host and installation for a CLI runtime, runtime config, runtime
  policy, enabled state, and default state.
- Run creation accepts `runtime_profile_id`; when omitted it selects the first
  enabled profile with `is_default=true`, falling back to the oldest enabled
  profile. If no enabled profile exists, legacy `AgentVersion` runtime/model
  resolution is used.
- A disabled selected profile fails run creation. Editing a profile affects
  future runs only.
- Each new Run stores `runs.runtime_profile_id` and
  `runs.runtime_profile_snapshot_json`. Execution reads runtime config from
  that snapshot before falling back to the `AgentVersion`, so historical runs
  remain auditable after profile edits.
- Product workflow UIs should select `agent_id + runtime_profile_id`. Naked
  per-run `adapter_type` / `model_provider_id` / `model` fields are kept only
  as compatibility inputs for older callers and should not be the primary
  frontend model.

## Identity and memory

An Agent is the memory boundary; a Conversation is the context boundary; host ×
CLI is only the substrate
([ADR 0003](../decisions/0003-memory-proposal-flow.md) §4–§6). Three things are
kept apart deliberately, and they have three different authors:

| | Author | Where it lives | Reach |
|---|---|---|---|
| **Role** (`agents.role_instruction`) | the owner, as a setting | `agents` | wherever the Agent runs |
| **Persona** (`memory_type = 'persona'`) | the Agent, about itself | `memory_entries`, `scope_type = 'agent'` | every Room and direct chat; one active entry per Agent |
| **Note** (`note` / `decision` / `lesson`) | the Agent, about a Room | the same scope, carrying `origin_room_id` | only where that Room's audience already reached |

The prompt renders role first and persona second. This is delivered on the
**host-bound** path — `agentGroups/agentIdentityPrompt.ts`, on a Room turn, a
Room delegation and a direct chat. A managed (server-side) Agent does not
receive the block yet: it would acquire the same entries through the Runtime
Context Memory candidate authority, which is a different change, deferred in
[plans/backlog.md](../plans/backlog.md) §10. Neither role nor persona is written
to a vendor context file, and the CLI's own auto-memory is scratch Rainver never
reads, imports or promotes.

**Who may change a persona is decided by who is responsible for the Run**,
read from the **root** Run's `trigger_origin` and `instructed_by_user_id`
together (`systemActions/effectiveRunTrigger.ts`,
one row, so a delegated child is judged by what started the chain), and never
from the prompt. Person-facing run create always stamps `manual`; a client
cannot send `automation` to skip the in-turn proposal. The owner's own turn
produces a proposal decided in that turn; any other member's turn produces a
proposal only the owner can accept (`required_owner_user_id`, by identity and
not by role). Owner-only proposal text is never stored in the shared Room
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
  status (active|inactive|archived)

AgentVersion:
  id, agent_id, space_id
  version                   — immutable label, e.g. "v1", "v2"
  system_prompt             — immutable execution prompt text
  model_provider_id           — FK to ModelProvider (LLM backend for this version)
  model_name                  — model id string for the selected provider
  model_config_json         — {model, temperature, max_tokens, ...}
  runtime_config_json       — {risk_level, max_run_time_seconds}
  context_policy_json       — {readable_scopes, writable_scopes}
  memory_policy_json        — {readable_scopes, writable_scopes, requires_proposal}
  capabilities_json         — list of capability IDs
  tool_permissions_json     — {allowed_tools, allowed_adapter_types}
  runtime_policy_json       — {sandbox_required, allowed_adapter_types}
  source_proposal_id        — proposal that approved this version, when post-create
  source_activity_id        — activity record for the config change, when post-create
  created_at
  Note: AgentVersion is append-only. Agent.current_version_id is updated on save.
        Existing runs keep their agent_version_id and remain reproducible.

AgentRuntimeProfile:
  id, agent_id, space_id
  name
  adapter_type                 — model_api, claude_code, codex_cli, ... (`capability` is declared and disabled)
  model_provider_id            — optional ModelProvider binding
  model_name                   — optional model id for the selected provider
  runtime_config_json          — resolved runtime config, including CLI tool version and an
                                  optional credential_profile_id default hint, when relevant
  runtime_policy_json          — runtime policy/default adapter metadata
  enabled, is_default
  Note: mutable product configuration. Runs snapshot the profile at creation.
  Note: the profile has no credential column, and neither does anything else.
        A CLI runs on the execution host this profile names and uses the login
        held by the copy there (ADR 0016 §7).

Run:
  id, space_id, agent_id, agent_version_id, runtime_profile_id
  runtime_profile_snapshot_json — immutable selected runtime profile snapshot for this run
  status (queued|running|succeeded|failed|cancelled|degraded|waiting_for_review)
  mode (live|dry_run)
  parent_run_id               — lineage link (follow-up/retry/manual continuation or delegated child run)
  root_run_id                 — root of an AgentRunGroup run tree when grouped
  run_group_id                — owning AgentRunGroup when grouped
  delegation_id               — RunDelegation that created a delegated child run
  instructed_by_agent_id      — internal-only ORM field for actor resolution; not settable via public API
  prompt, instruction, output_json, error_json, sandbox metadata fields
```

## Main Flows

**Queued run creation**

1. HTTP (`POST /agents/{id}/runs`, task board endpoints, or agent helpers) → `RunService.create_run`
2. Run creation resolves the selected/default runtime profile, validates it, and snapshots it on the Run
3. Worker picks up `agent_run` jobs → `RunOrchestrationService` selects adapters from policy and run snapshot
4. Adapters execute with sandbox routing managed outside the agents module

**Run lineage (parent_run_id)**

`parent_run_id` supports user-created lineage: follow-up runs, retries, manual continuations, and
external run imports. `trigger_origin="parent_run"` is not a valid trigger origin — parent lineage
is a structural link, not a trigger type. Valid trigger origins: `manual`, `automation`, `job`,
`system`, `delegation`.

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
dependency summaries once all declared dependency runs are terminal. Delegation
completion alone does not create an inferred follow-up run.

The web Agent Rooms surface is space-scoped at `/agent-groups` under the Agents
scene. It creates manager-led rooms, reads group timeline/trace, posts
natural-language room messages, and exposes room settings separately from the
chat surface. The default recipient is the manager. Structured Tiptap `@`
mentions route direct segments to selected room members, adjacent mentions fan
out one segment in parallel, and Agent coordination routes the whole message to
the manager for decomposition. Room members define the `agent.delegate` target
pool and `agent.wait_for_results` can wait on sibling or delegated runs.
Child artifacts and proposals link to the existing Artifacts and Review
surfaces instead of creating a separate approval path.

**Agent execution config changes**

There are two paths, by who is making the change:

1. **Owner direct edit (no proposal).** `PATCH /agents/{agent_id}` applies both
   identity fields (name/description/visibility/role_instruction/status, directly on
   the `Agent` row) and execution-config fields (system prompt, model/provider, runtime
   policy, capabilities, tool permissions, …). Execution-config changes **append a new
   immutable `AgentVersion`** (preserving history; existing runs keep their version
   pointer), advance `Agent.current_version_id`, and **record a lightweight
   `system_event` Activity** (`metadata_json.kind="agent_config_updated"`) instead of a
   proposal. The owner is the authority and there is no second party to review, so a
   proposal would be pure ceremony. Runtime policy gates still apply at execution.

2. **Proposed change (needs review) → proposal.**
   `POST /api/v1/agents/{agent_id}/config-proposals` creates an `agent_config_update`
   proposal for changes suggested by a non-owner actor (e.g. an agent learning loop or
   automation). Accepting it validates same-space agent/provider/adapter/base version,
   rejects a stale `base_version_id`, creates a new immutable `AgentVersion`, records
   proposal/activity provenance, and advances `Agent.current_version_id`.

3. **Owner config UI edit (no proposal) → `POST /api/v1/agents/{agent_id}/config`.**
   The Agent configuration frontend uses this focused endpoint (schema
   `AgentConfigUpdate`). It builds a **new immutable `AgentVersion`** copied from the
   current one, applies only the allowed editable areas, advances
   `Agent.current_version_id`, and records an `agent_config_updated` Activity. Editable:
   `name`/`description` (identity, on the Agent row), `system_prompt`, `model_provider_id`/
   `model_name`/`model_config_json`, `context_policy_json`, `memory_policy_json`,
   `output_policy_json`, `schedule_config_json`, `output_schema_json`.
   **Hard-safety snapshots are copied verbatim and cannot be loosened here:**
   `tool_policy_json`, `tool_permissions_json`, `capabilities_json`, `runtime_policy_json`,
   `runtime_config_json`. Within memory/output policy the
   `writable_scopes` and `requires_proposal` (memory) and `proposal_only` (output) guarantees
   are **re-stamped from the source version**, so a frontend override can never grant direct
   memory write, unlock tools, or turn off proposal-only outputs.

**Version restore — `POST /api/v1/agents/{agent_id}/versions/{version_id}/restore`.**
   Appends a brand-new `AgentVersion` whose config is copied from the selected prior version,
   then advances `current_version_id`. The selected version is never mutated or reactivated;
   history stays append-only. Restore, like every other Agent mutation (identity,
   config, runtime-profile writes), passes the one owner gate `assertAgentOwner`
   (`agents/agentAccess.ts`, 404 on refusal): the owner may; an unowned
   system-managed Agent (Project Research, source annotation, source
   post-processing) only the Space's owner or admin may; the Assistant is never
   changed through these paths — its runtime profiles follow its Project's
   write boundary.

**Read endpoints for the config UI:**
   `GET /agents/{id}/current-version` (current `AgentVersionOut` config snapshot),
   `GET /agents/{id}/versions` + `/versions/{version_id}` (history + detail).
   These use the same Agent content ACL as `GET /agents/{id}` (404 on deny).
   A `summary` viewer keeps version metadata and loses `system_prompt`.
   Also:
   `GET /agents/{id}/proposals?status=pending` (proposals linked to the agent — config updates
   plus run-emitted proposals), `GET /agents/{id}/runs` (run history),
   `GET /agent-templates/{id}/versions/{version_id}` (template version config for the library
   cards and the create-from-template summary).

All edit paths preserve the version-immutability invariant (append, never mutate). Direct
version creation via `POST /agents/{id}/versions` remains disabled.

## Frontend Agent Configuration Surfaces

The React `agents` module (`apps/web/src/modules/agents/`) renders the product-level UI over
the backend AgentTemplate → AgentVersion model. No mock/hardcoded template or agent data
remains; every card is backed by an API call.

- **Template Library** (`TemplateLibraryPage.tsx`, `/agents/templates`) — lists real
  system/user/space templates from `GET /agent-templates`. Each card shows name, description,
  category, scope, visibility, status, current version, and input/output/safety summaries
  (derived from the current template version config). Actions: **Use template**, **View details**.
  Templates are presented by their own identity (e.g. *Activity Reflector* = the reflection
  factory). "Daily Reflector" is not a template — it is simply a name a user might give an
  Agent created from *Activity Reflector* and scheduled daily; scheduling is an instance choice,
  not a template property, so the library does not conflate the two.
- **Template Detail** (`TemplateDetailPage.tsx`, `/agents/templates/:id`) — read-only Inputs/
  Outputs/Schedule/Model/Safety views of the current template version.
- **Create from Template** (`CreateFromTemplatePage.tsx`, `/agents/templates/:id/use`) — shows
  the selected template-version summary, lets the user set name/description and the allowed
  overrides (system prompt, model name, schedule enable), then calls
  `POST /agent-templates/{id}/agents` and navigates to the new Agent detail page.
- **Agent Detail** (`AgentDetailPage.tsx`, `/agents/:id`) — tabbed view: **Overview**
  (identity/role edit, provenance, current version, last run, pending proposals), **Inputs**,
  **Outputs**, **Schedule** (editable), **Runtime** (runtime profiles), **Review & Safety**, **Versions**
  (history + restore), **Runs** (real run history with useful empty state).
- **Policy → product mapping** (`policyMap.ts`, rendered by `ConfigCards.tsx`) is the single
  source of truth that translates `context_policy_json` → input cards (capture inbox / approved
  memory / previous reflection summaries / sessions / Project Folder), `output_policy_json` → output
  type cards (task/idea/memory proposals, reflection summary artifact, wiki/archive), with memory
  outputs always shown as review-required; `tool_policy_json` + `memory_policy_json` → the
  "this agent can / cannot" safety statements and a derived review posture (Strict/Balanced/
  Draft-friendly, read-only since the backend has no editable review_mode);
  `schedule_config_json` → manual/daily/interval/cron summary; runtime profiles → adapter/model/
  credential choices. Raw JSON appears only behind an explicit **Advanced** disclosure (Runtime
  tab, Versions view).

Not built on this surface: full scheduled reflection execution, marketplace /
sharing / import / export, template inheritance, runtime use of templates,
direct memory writes, or faked frontend data. Template create/publish
endpoints exist; the Agents UI does not author custom templates.

Unimplemented template authoring: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §24.

## Built-in Templates (no built-in concrete agents)

There are no eagerly seeded per-space concrete Agents. The old boot-time
concrete-agent seeder was removed. Built-in product behavior comes from system
templates (factories), while a Project's hidden managed Assistant is provisioned lazily
and only when someone first speaks in one of its Rooms. Keeping it off Room
creation is what lets a Project be created with its mainline Room without a
Space's backend configuration being able to fail the Project
([ADR 0018](../decisions/0018-room-as-visibility-boundary.md) decision 4).

Built-in **templates** (global factories, idempotent, seeded by the server agents module,
seeded once in `bootstrap`). Five are **public** reusable specialized factories; the sixth,
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
  template. A Project's concrete Assistant is created transactionally on the first
  message sent in one of that Project's Rooms; a boot-time reconcile brings every
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
  patch apply (a code-writing `coding_task_agent` is future scope)

Why no `general_chat` or generic DirectChat: a generic session-only chat object would be a naked
conversation with no Agent identity or space-aware policy. Every Room conversation, and every
host-bound direct chat, instead targets an explicit, space-scoped `Agent` — carrying that Agent's
context policy and proposal-only output policy — resolved through the conversation backend
binding (`modules/rooms.md`). Host-bound direct chat is owner-only, uses one direct container per
Agent × owner, and exposes reset/archive/opt-in restore semantics; it does not make arbitrary
Agents into a global default. Templates not seeded
initially (future scope): `coding_task_agent`, `research_scout`, `source_processor`,
`weekly_planner`, `finance_reviewer`, `health_reviewer`, `task_manager`.

There is **no** single global "default agent" that runs implicitly. Every `Run` targets an
explicit `Agent`, and execution config resolves from the Run's snapshotted runtime profile plus
`Agent.current_version_id` → `AgentVersion`.
A `system_assistant`-kind Agent is system-owned, hidden from ordinary Agent list/detail/create
surfaces, and limited to one active instance per Project (plus a Space-level slot the schema
allows and nothing fills). Room creation lazily provisions the Project's instance from the
internal `personal_assistant` prompt seed and uses it as the immutable Room manager. Its
runtime profiles remain shared definitions; the speaking user's API eligibility or CLI credential
is resolved per conversation binding. It also anchors soft Assistant **preferences**
(`agent.default_assistant.settings`) without allowing those preferences to change the core prompt
or hard policy.

Memory reflection (`POST /sessions/{id}/reflect`) is an explicit **internal service**
(the memory consolidation/reflection path via the `memory.reflect` capability) — it does not run
through a concrete built-in agent. The `memory_reflector` template is the factory for users who
want a standalone reflection Agent instance.

Runtime tests use explicit fake adapters or the `capability` adapter when they
need a native, no-credential execution path.

## Adapter Registry

| Adapter       | Required risk_level | Sandbox Level   | Notes                                                     |
|---------------|---------------------|-----------------|-----------------------------------------------------------|
| `capability`  | any                 | none            | Local enabled capability execution; no file access by default |
| `model_api`   | any                 | none            | Managed API runtime; credentials resolved through ModelProvider |
| `claude_code` | none (no Folder) / high (Folder) | `ephemeral` / `worktree` | No Folder → ephemeral run-scope dir; Folder bound → requires high → worktree. Never runs at none/dry_run |
| `codex_cli`   | none (no Folder) / high (Folder) | `ephemeral` / `worktree` | No Folder → ephemeral run-scope dir; Folder bound → requires high → worktree. Never runs at none/dry_run |

## Invariants

- `claude_code` and `codex_cli` stay in the sandboxed adapter set — cannot be downgraded to host execution
- Context snapshots captured at run creation stay immutable
- No vendor adapter is the source of truth for memory, policy, or audit
- `agent_version_id` on `Run` is immutable per row — historical runs stay reproducible after edits to `Agent`
- `runtime_profile_snapshot_json` on `Run` is immutable per row — historical runs keep the selected runtime binding after profile edits
- `AgentVersion` is append-only — prior rows are not rewritten in place
- Public post-create execution config mutation is proposal-only. Direct public
  AgentVersion creation must not advance `Agent.current_version_id`.
- Accepted config proposals leave provenance from the new AgentVersion to the
  accepted Proposal and ActivityRecord.
- Agent configuration is loaded from the immutable AgentVersion path; it is not
  represented by a Memory row or Runtime Context checkpoint.
- The owner config UI (`POST /agents/{id}/config`) and create-from-template overrides
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
- `server/src/modules/agents/` — system AgentTemplate/AgentVersion behavior
- `server/src/modules/agents/routes.ts` — agent HTTP API incl. `/config`, `/current-version`,
  `/versions/{id}/restore`, `/proposals`
- `server/src/modules/agents/` — template HTTP API when enabled
- `apps/web/src/modules/agents/policyMap.ts` + `ConfigCards.tsx` — policy/config JSON → product cards
- `apps/web/src/modules/agents/{TemplateLibraryPage,TemplateDetailPage,CreateFromTemplatePage,AgentDetailPage}.tsx`

## Related Decisions

- [0002-agent-model.md](../decisions/0002-agent-model.md)
- [0004-context-wrapper.md](../decisions/0004-context-wrapper.md)

## Related Docs

- [runtime-adapters.md](runtime-adapters.md) — adapter registry, three-way separation, license notes
- [hosts.md](hosts.md) — execution hosts, the strict-mode namespace, and what became of the sandbox line
- [provider-policy.md](provider-policy.md) — model provider configuration
