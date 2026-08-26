# Module: Rooms

## Status
**IMPLEMENTED** — schema, service, and API routes live in `server/src/modules/rooms/`.

## Purpose
A Room is a persistent, project-bound, multi-party collaboration container: a
human and agent roster plus multiple durable conversations. It is the
frontend-facing surface for dispatching work to agents from inside a
conversation. `/projects/:projectId/rooms` is the primary in-Project workspace;
`/rooms` is the cross-Project index. Together they replace the old Project
Chat surface and the hardcoded default-Assistant chat entry — neither exists
anymore.

A Room does not create a new orchestration mechanism. Every message opens one
`agent_run_group` as one collaboration task (see `modules/agents.md` and
`architecture/EXECUTION_MODEL.md`); `agent_run_groups` keeps its "one
collaboration task" semantics unchanged. `/agent-groups` remains the backend
task/audit authority, not a second conversation UI.

## Owns
- `rooms`, `room_user_members`, `room_agent_members` schema (`server/src/db/schema/rooms.ts`)
- Room-only specialist grants, invitation/approval snapshots, and preset idempotency records
  (`room_agent_access_grants`, `room_user_invitations`,
  `room_invitation_agent_approvals`, `room_agent_preset_idempotencies`)
- `RoomService` — room/conversation creation, membership, message dispatch (`server/src/modules/rooms/service.ts`)
- `RoomConversationSummaryService` — owner-funded asynchronous rolling summaries and
  member-visible freshness (`server/src/modules/rooms/conversationSummaryService.ts`)
- `RoomConversationTitleService` — immediate zero-cost first-message titles plus an
  asynchronous low-token `room_conversation_title` provider-task refinement;
  the sending user's eligible default Provider is the fallback, and a Space
  task policy can route this work to a free or cheaper chat model
- Room API routes under `/api/v1/rooms/*`
- Shared Room UI (`apps/web/src/modules/agent_groups/AgentGroupsPage.tsx`) at
  `/rooms` for the cross-Project index and `/projects/:projectId/rooms` inside
  the persistent Project Shell

## Navigation And Ordering

- Opening a Rooms route without an explicit selection enters the newest
  visible Room and then its newest conversation; the creation form is an
  action, not the page's default content when Rooms already exist. The client
  resolves that selection behind a loading state and never renders an
  intermediate choose/create page.
- The selected Room never replaces Room navigation: the sidebar always keeps
  the Room list and an explicit `New Room` control visible.
- Conversation lists are ordered by immutable `created_at DESC, id DESC`.
  Message activity and asynchronous title refinement must not reshuffle them.
- The one-click Project empty state creates a Room named from the Project.
  Clients present the retired `Project conversation` default as
  `<Project name> Room` for existing records.
- Accepting one proposed Inquiry question continues only that accepted
  question. The continuation reports pending siblings from the original batch
  and is not allowed to create rewritten copies of them. Superseded duplicate
  Proposal cards remain visible, non-interactive audit data labelled as merged;
  they must not disappear after live-status reconciliation.

## Key Model

```
Room:
  id, space_id, project_id, project_folder_id (optional)
  created_by_user_id, title, status (active|archived), roster_revision

RoomUserMember:
  id, space_id, room_id, user_id, role (owner|member), status (active|removed)

RoomAgentMember:
  id, space_id, room_id, agent_id, role (manager|member), status (active|removed)
  # exactly one active manager per Room (partial unique index)
  # manager is the hidden Space Assistant; specialists are added later

sessions (Room-backed conversation):
  room_id, project_id set; user_id, agent_id NULL
  # ck_sessions_conversation_owner enforces this split against the
  # user-owned chat-session shape on the same table

messages (Room conversation message):
  sender_agent_id — set when the sender is an agent, alongside the existing
  user_id for a human sender

Room conversation summaries:

- `room_conversation_summary_versions` is append-only and keeps one active
  version per conversation. Each version carries an exclusive
  `covered_through_message_id`/timestamp cursor, provider/model audit metadata,
  and the owner-attributed usage snapshot.
- `room_conversation_summary_states` is mutable scheduling state with a lease,
  retry/backoff, and `waiting_provider` status. Summary model calls are queued
  only after the uncompacted prefix crosses the raw 6,000-token threshold and
  never run in the send transaction. A missing or no-longer-eligible owner
  provider leaves the state waiting with an actionable setup status.
- Runtime Context renders the active summary (up to 2,000 tokens) plus only
  uncaptured recent turns (up to 6,000 tokens). The cursor is exclusive and the
  assembler asserts that the two ranges do not overlap. The current trigger
  message is never silently truncated.
- Every Room turn closes visibly in the conversation. A terminal execution
  failure produces an Agent reply with the sanitized reason; it is not
  converted into a generic review hold. A genuine authorization pause writes
  a Run-scoped Agent reply explaining what needs approval and where to decide
  it. If approved, the eventual result replaces that pause reply for the same
  Run before the turn is marked complete.
- A `degraded` Room Run with non-empty model output publishes that output as
  the Agent reply and retains the warning status for diagnostics. A failed
  managed tool or auxiliary write must not replace usable conversational text
  with a synthetic `Room task failed` message.
- Room prompts enforce write/report consistency: listing a decomposition in a
  reply does not count as creating Project objects. If an Agent says it split
  work into N Project research questions, it must invoke
  `inquiry.propose_thread` once per question and report the actual
  created/proposed count or any failure in plain language.
- Once an accepted Inquiry Thread exists, an explicit user instruction to
  start or continue research is an execution boundary: prompt guidance
  (`RESEARCH_EXECUTION_POLICY`) tells the Manager to act now using whichever
  research-execution tool its Room allowance currently grants, not to ask
  which part to start or turn the instruction into another confirmation
  loop. Two tools are granted: `agent.delegate` to an available Research
  specialist for an ad hoc investigation, and `research.start_acquisition`
  (plan Phase 4) to start a tracked, monitored acquisition Workflow directly
  — a background pipeline (question assessment → query evaluation → strategy
  materialization/activation → initial intake) that reports back through the
  same completion-event mechanism `agent.delegate` uses. The two are not
  mutually exclusive: an ad hoc delegated investigation and a tracked
  acquisition Workflow may run on the same Thread at once.
  **Which tool (or tools) to use, and whether to wait for a delegate's result
  before replying, is the Manager's own judgment call, not a server-side
  gate**: no request text is pattern-matched to force a specific tool or an
  automatic `agent.wait_for_results` call — a prior mechanism that did this
  was removed as brittle (fixed phrasing only) and because it took a real
  choice away from the model. If the Manager does not wait and its turn ends
  before a delegated child run finishes, the delegation completing later
  still reaches the conversation on its own: `AgentGroupRunLifecycleProjector`
  posts a `ConversationContinuationRegistry` event continuation
  (`agent_delegation_result`) the moment nothing is left waiting on that
  child, so the Room does not go silent just because the Manager chose not
  to block (plan Phase 3). A Manager that *did* wait is unaffected — that
  case already resumes through the pre-existing dependency-wait path and
  never reaches this second notification. `research.start_acquisition`
  reports the same way: `research_pipeline_outcome` (started, the question
  failing FINER assessment, or a stage failure) and `research_workflow_terminal`
  (the Operation's own later `failed`, `completed`, or `waiting_review`) — see
  `.agent/architecture/SYSTEM_ACTIONS.md` for the full event/idempotency
  shape. `research.cancel_acquisition` is the matching in-Room stop, so a
  report about running research never forces the user out to the web UI to
  act on it.
- Proposal-card continuation is a system execution instruction, not a human
  chat utterance. The dedicated Proposal-continuation endpoint accepts only a
  Proposal id; the server verifies that it is decided, visible, belongs to the
  same Project and originated in the same conversation, then resolves the
  instruction through `ConversationContinuationRegistry`
  (`.agent/modules/proposals.md`) rather than a Rooms-owned per-type
  switch — Rooms holds no domain knowledge of what an accepted or rejected
  Proposal means next. The registry's typed directive and structured context
  travel alongside the rendered instruction text in the hidden message's
  `metadata_json` (`continuation_directive`, `continuation_context`). It is
  idempotent per conversation/Proposal, remains
  attributable in the canonical Run trace, uses a hidden `system` Room message,
  and is excluded from the visible transcript. An in-flight or successful
  continuation reuses its Run; when every prior Run explicitly failed or was
  cancelled, retry reuses the same hidden instruction but creates fresh Runs.
  The generic message endpoint
  cannot create hidden messages; the next visible message is the Agent's result.
- Summary generation uses the active Room owner's eligible API provider and
  attributes usage to that owner. A Room without an API keeps working; its
  summary remains queued/waiting until the owner configures one.
```

A Room requires Project writer authority to create, and every human roster
member must already have Project read access. All later Room operations
re-check that ACL, so Project revocation immediately removes Room access. A
Room's optional Project Folder binding is fixed at creation and governed by
the normal read-only sandbox boundary (`architecture/EXECUTION_MODEL.md`).

### Mutable roster and Room-only privacy

The managed `system_assistant` participant is the hidden, system-controlled
Manager and is immutable through the roster API. Project-writer Room members
may add visible existing Agents or instantiate one of the server-defined
presets, and may remove specialists without deleting the Agent or historical
messages. Preset creation is retry-safe when the caller supplies an
`Idempotency-Key`.

An Agent with `visibility=private` or `visibility=selected_users` remains
restricted in all ordinary Agent surfaces. Adding it to a Room requires the
owner to explicitly confirm the exact active Room members who receive
`room_agent_access_grants`; preset instantiation uses the same explicit
confirmation before sharing the newly created private Agent. Those grants are
scoped to one Room, can be revoked independently, and are never imported by
generic Agent visibility checks. A member removal revokes their future grant
while preserving historical output.

Human invitations snapshot the active private-specialist roster at the Room's
`roster_revision`. The invite becomes active immediately only when every
owner approves; otherwise it stays pending and each affected owner sees only
their own approval action. A specialist add/remove, Agent status change, or
owner change invalidates a stale snapshot rather than silently broadening it.
The current owner may transfer ownership to an active Room member with Project
writer authority. If the owner loses Project-writer authority, a Project owner
or Space owner/admin may atomically claim the suspended Room; this reactivates
or inserts the claimant's Room membership without deleting history.

## Per-message identity

The instructing human for a Room-dispatched run is resolved from the
triggering message's sender, never from the Room or a stored group owner
(ADR 0002). `RoomService.sendMessage` opens a fresh `agent_run_group` per
message with `manager_user_id` set to the current speaker; the run created for
that dispatch carries that speaker's `instructed_by_user_id`. This is a
security boundary, not a convenience: `instructed_by_user_id` is the retrieval
viewer identity, and it determines whose CLI credential capacity a
conversation backend spends (`modules/agents.md`, ADR 0008).

## Conversation backend

Each Room recipient resolves a `Space × room_recipient work scope × user ×
Agent` CLI binding from the speaker's own credential grants — never a
space-shared profile. Runtime Context owns its vendor-cache session and
acknowledged Event cursor; the Room session remains canonical conversation
storage, not the CLI binding identity. See `modules/agents.md` for the shared
direct-chat/Room execution model.

## Project state context (Phase A)

`RoomService.sendMessage` builds a domain-neutral "Project state" text block
once per dispatch (`buildRoomProjectStateContext`, `rooms/service.ts`) from
the same generic Project Overview contract the Project Overview page uses
(`ProjectOverviewService.getOverview`: mode projection's
`current_state_summary`/`next_actions` plus `attention`), and prefixes it onto
every recipient run's prompt (`roomRunPrompt`,
`agentGroups/service.ts`). It never reads a specific domain's tables and fails
open to no prefix on any error, so a Project state read never blocks sending a
message. This is the mechanism behind plan
`.agent/plans/project-conversational-advancement-plan.md` decision 3: the Room
agent's contract stays domain-neutral, and a Mode/domain extends what the
agent knows by registering with the Overview/attention registries, not by the
Room learning about it.

The block carries Project definition status separately from Mode work state.
A published Brief goal/core problem means user-visible initialization is
complete even when no Inquiry Thread, Workflow, or Run exists. Audit metadata
such as publication timestamps never substitutes for that definition, and
Room agents are explicitly instructed not to collapse these two states.

Agent-drafted structural changes (see `project.propose_definition`,
`inquiry.propose_thread`,
`inquiry.record_conclusion`, and `inquiry.promote_knowledge` in
`architecture/SYSTEM_ACTIONS.md`) surface back
into the conversation as an inline Proposal review card
(`RoomActionPreviewCard`, `apps/web/.../AgentGroupsPage.tsx`), reusing
`loadProjectChatActionPreviews` — the same generic proposals-by-run-id lookup
`finalizeChatTurn` already writes onto a Room assistant message's
`metadata_json.action_previews` for every project-bound Room run. That
snapshot is written once at Run finalization and never updated again, so the
card re-checks the live Proposal (`proposalsApi.get`) on every mount rather
than trusting it — otherwise a reload, or a second Room member's browser,
would show a stale, still-decidable card on an already-decided Proposal. The
card accepts or rejects through the standard Proposals API directly; there is
no inline editing — a revision is requested in conversation and the agent
re-drafts a fresh Proposal.

## Conversation tool allowance

An Agent gets the Room's conversational actions because it was spoken to in a
Room, not because of how that Agent was configured:
`AgentGroupRunService.dispatchMessageInTransaction` passes
`ROOM_CONVERSATION_TOOL_ALLOWANCE` as the Run's `scenario_tool_allowance`
whenever the group has a `room_id`, and non-Room groups keep the AgentVersion
allowance untouched. See `architecture/SYSTEM_ACTIONS.md` for why the scope
moved and what stayed fail-closed.

Those Room-owned System Action ids authorize server tools; they are not
runtime-profile capabilities. Routing excludes registered System Action ids
from its capability hard filter, so a valid conversation backend does not have
to duplicate the Room allowance in its AgentVersion or runtime profile.

Room creation adds only the creator and the hidden Space Assistant. The manager
is system-controlled and cannot be selected, replaced, or removed. Later roster
mutation adds/removes specialist Agents through Room-owned authorization, with
explicit confirmation before a private Agent is shared. The shared Run
repository rejects the managed manager for ordinary
Experiment, Knowledge, Automation, Task, and Agent run producers; Room root,
grouped, and delegated dispatches carry the only internal Room authority
marker. There is no product surface for `tool_permissions_json`, so Room
scenario permissions remain a Room execution concern rather than silently
depending on a specialist's private Agent configuration.

The allowance holds four proposal-gated actions — propose a Project
definition, create an Inquiry Thread, record a conclusion, and promote
Knowledge — plus two directly-executed, idempotency-guarded actions:
`agent.delegate` and `research.start_acquisition` (plan Phase 4). Delegation
is still bounded to one level, two specialists, and the Room's concurrency
cap; neither directly-executed action is a general Agent permission.
Retrieval is excluded on purpose: it would execute under the message sender's
identity, including their `private` content, and answer into a conversation
every Room member can read. Grounding a drafted conclusion in Project material
needs a retrieval path scoped to what the Room may read, which does not exist
yet.

Both direct action executors clamp their Proposal to the Room Run's
`selected_users` visibility and inherit the active Run grants transactionally.
The knowledge-promotion action keeps its intermediate Candidate private to the
instructing user, so no Room-derived draft becomes Space-visible before the
Room-scoped Proposal review.

## Opening a Room

A Room exists in order to be spoken to, so the server creates its first
Conversation in the same transaction as the Room and manager membership.
`openRoom` consumes that returned Conversation rather than issuing a second
create request. Inside a Project with no Room yet, the empty state offers one
"Start a conversation" button regardless of ordinary Agent count. The server
first ensures the Space Assistant and verifies that the creator has an eligible
API or explicitly granted CLI backend; otherwise no Room or Assistant partial
state is committed.

The Room page has independent catalog, Room-detail, and conversation-message
loading boundaries. Selecting a Room or conversation preserves the page shell,
catalog, roster, and unaffected panels while only the selected panel loads.
Mutation responses are applied directly: sending appends the returned user
message, and conversation creation appends the returned conversation. These
interactions must not re-enter the page-level `Loading Rooms` state or refetch
unrelated catalogs.

When a Room is open, conversation is the dominant surface: a compact left rail
contains Room metadata, the conversation switcher, collapsed Room creation,
and collapsed roster controls; the center column owns the available width and
scrolls messages inside a viewport-height card; Project state remains a narrow
supporting rail. Runtime/backend controls are collapsed under Run settings so
they do not compete with the message history and composer.

## Project state panel (Phase B)

`AgentGroupsPage.tsx`'s Room view renders `RoomProjectStatePanel` beside the
conversation, fetched once per Room load via the same
`projectsApi.getOverview` call the Project Overview page uses — no
Room-specific read model. It shows `mode_projection.current_state_summary`,
`mode_projection.next_actions`, and `attention`, each item deep-linking
(`SpaceLink`) into the Area that owns it; a fetch failure degrades to
"Project state unavailable" rather than blocking the Room. This is ambient
awareness, not a second command surface — the panel has no actions of its
own, only links out.

The Inquiry kind→stage vocabulary (`StageId`, `STAGE_ORDER`, `STAGE_LABELS`,
`STAGE_HELP`, `STAGE_FOR_KIND`, `kindsInStage`) moved from
`apps/web/src/modules/projects/inquiryArea/stages.ts` into
`packages/protocol/src/inquiry.ts` (as `Inquiry*`-prefixed exports;
`stages.ts` re-exports the original names as aliases so its four page
consumers are unchanged) so a future non-frontend consumer of this
classification — a per-Thread "stage" line in the Room's Project state
context, or a Project-level stage rollup — shares one definition instead of a
second copy. No such consumer exists yet: a Project-level stage rollup was
scoped out of Phase B (it would need new aggregation across a Project's open
Threads, which is not the "small mapping move" this phase is) and stays a
deferred item pending real usage evidence.

## API Surface

- `POST /api/v1/rooms` — create a Room (writer authority on the Project)
- `GET /api/v1/rooms` — list Rooms, optional `project_id` filter
- `GET /api/v1/rooms/:roomId` — Room detail with rosters
- `GET /api/v1/rooms/:roomId/agent-candidates` — visible existing Agents and
  separately typed preset factories
- `POST /api/v1/rooms/:roomId/agents` — add/reactivate a specialist with
  explicit private Room-share confirmation
- `POST /api/v1/rooms/:roomId/agent-presets` — instantiate and add a preset
- `DELETE /api/v1/rooms/:roomId/agents/:agentId` — remove a specialist and
  revoke future Room grants
- `GET/POST /api/v1/rooms/:roomId/invitations` — list or create human
  invitations; pending invitations carry owner approvals
- `POST /api/v1/rooms/:roomId/invitations/:invitationId/decision` — approve or
  reject one owned private-Agent share
- `GET /api/v1/rooms/pending-approvals` — owner-scoped pending private-Agent
  approvals across readable Rooms
- `DELETE /api/v1/rooms/:roomId/members/:userId` — remove a non-owner member
- `POST /api/v1/rooms/:roomId/owner-transfer` — transfer to an active Project
  writer Room member
- `POST /api/v1/rooms/:roomId/owner-claim` — recover a suspended Room for a
  Project owner or Space owner/admin
- `POST /api/v1/rooms/:roomId/conversations` — open a durable conversation
- `GET /api/v1/rooms/:roomId/conversations` — list conversations
- `GET /api/v1/rooms/:roomId/conversations/:sessionId/messages` — paged history
- `GET /api/v1/rooms/:roomId/conversations/:sessionId/summary` — active summary,
  cursor, freshness/retry state, and owner-only provider/usage metadata
- `POST /api/v1/rooms/:roomId/conversations/:sessionId/messages` — send a
  message; supports direct `@agent` recipient segmentation or manager
  coordination, and optional explicit per-recipient backend selection

## Invariants

- Room membership never widens Project authority.
- Room-only grants never widen global Agent visibility; every grant check also
  requires an active membership in the same Room.
- There is exactly one active Manager and it is always the system-managed
  Assistant; roster mutation cannot replace or remove it.
- Invitation activation is atomic with member insertion and grant creation;
  any roster revision, owner, or Agent-status mismatch invalidates approvals.
- There is at most one active Room owner. Removing an owner requires transfer;
  claim is permitted only while the previous owner can no longer write the
  bound Project.
- Project-originated Room navigation stays inside the Project Shell. The
  Project sidebar and Overview link use `/projects/:projectId/rooms`; the
  global `/rooms` route remains the cross-Project index, not a second Room
  implementation.
- A Room does not turn `agent_run_groups` into a conversation container; each
  message is its own collaboration task.
- The vendor CLI runtime session, when resumed, is permitted runtime state and
  never a source of truth — Rainver retains full replay capability (ADR 0004).
