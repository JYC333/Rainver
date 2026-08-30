# Module: Rooms

## Status
**IMPLEMENTED** — schema, service, and API routes live in `server/src/modules/rooms/`.

## Purpose
A Room is a persistent, project-bound, multi-party collaboration container: a
human and agent roster plus multiple durable conversations. It is the
frontend-facing surface for dispatching work to agents from inside a
conversation.

The Project's **Conversations** page is where they are read, and
`/projects/:projectId/rooms` is one Room's own surface — its roster, run
settings and full transcript — reached from that list. There is no
cross-Project Rooms index and no Rooms entry in the top navigation: a Room is
a visibility boundary rather than a place, so a picker in front of it would
charge every reader for a layer most Projects never use. This replaced the old
Project Chat surface and the hardcoded default-Assistant chat entry — neither
exists anymore.

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
- Thread references — content picked from another thread or an imported
  session, copied once with provenance and a disclosure gate
  (`server/src/modules/rooms/threadReferences.ts` resolves and gates;
  `server/src/modules/rooms/referenceService.ts` prepares before the
  transaction and copies inside it; the endpoint stays on `RoomService`)
- `RoomConversationTitleService` — immediate zero-cost first-message titles plus an
  asynchronous low-token `room_conversation_title` provider-task refinement;
  the sending user's eligible default Provider is the fallback, and a Space
  task policy can route this work to a free or cheaper chat model
- Room API routes under `/api/v1/rooms/*`
- Shared Room UI (`apps/web/src/modules/agent_groups/AgentGroupsPage.tsx`) at
  `/projects/:projectId/rooms`, inside the persistent Project Shell
- One conversation component
  (`apps/web/src/modules/agent_groups/conversation/RoomConversation.tsx`):
  messages, paging, sending, Run progress/streaming, polling, scroll-follow
  and inline Proposal cards with continuation. The full Room page renders it
  as `variant="full"` (adds routing, per-agent backends, the summary) and the
  Project chat panel (`projects/sidecar/ProjectChatSidecar.tsx`) as
  `variant="panel"` with focus refs. There is no second conversation
  implementation; a behaviour a conversation needs is added there once.

## Navigation And Ordering

- Opening a Rooms route without an explicit selection enters the newest
  visible Room and then its newest conversation. The client resolves that
  selection behind a loading state and never renders an intermediate
  choose/create page.
- The selected Room never replaces Room navigation: the sidebar always keeps
  the Room list, and a `New Room` control beside it for a viewer who can write
  the Project. Opening one is a dialog, not a form on the page: it asks who
  can see the Room, because the audience is what a Room is
  ([ADR 0018](../decisions/0018-room-as-visibility-boundary.md)). One dialog
  serves both this page and the Project conversation list, and its candidates
  are the Project's **readers** — `inviteUser` refuses anyone who cannot read
  the Project, so a Space-wide list offers people the server rejects.
- Conversation lists are ordered by immutable `created_at DESC, id DESC`.
  Message activity and asynchronous title refinement must not reshuffle them.
- A Project showing no Rooms has failed to load them, since every Project is
  created with its mainline (ADR 0018 decision 4). The empty state offers a
  retry, never creation: a Room made there would be a second shared one beside
  the mainline it could not see. Clients present the retired
  `Project conversation` default as `<Project name> Room` for existing
  records.
- Roster controls follow the authority each one needs, not one flag. Invite,
  remove, transfer and the specialist controls go through the server's
  `withRoomWriter` and are shown only to a Project writer. Deciding a
  private-Agent share is the Agent owner's, who may be a reader and is exactly
  who a blocked invitation waits on; claiming a suspended Room is the Project
  owner's or a Space owner/admin's. Folding those two under write authority is
  how a reader gets locked out of a decision only they can make.
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
  # manager is the hidden Project Assistant; specialists are added later

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
  `inquiry.create_thread` once per question — at most five in a turn — and
  report the actual created count or any failure in plain language. The
  questions exist immediately; the Agent is told not to ask for confirmation
  per question, because the person sees each one in the Project's updates and
  can archive it in one click.
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

### Host-bound specialists

A specialist Agent may bind its runtime profile to one of the caller's own
remote Hosts and a Workspace Location in this Project. The Room roster keeps
the normal Agent identity and uses `trigger_policy = owner_only`: only the
Host owner can dispatch it, while another member sees a visible system notice
and no Run is created. A stale or offline Host is handled the same way, with
no queueing or replay when it returns.

Each Room × Agent owns one live `host_threads` row. It pins the Location,
adapter, installation, and opaque vendor session. A first turn, a changed
conversation, or a reset sends Project state plus that conversation's summary
and uncovered messages, preceded by the conversation title. Later turns in
the same conversation send only messages since that Agent's previous turn.
Reset context clears the vendor session and marks the thread `session_reset`;
resuming a broken vendor session also publishes a visible reset notice.
Removing the specialist closes the thread, and re-adding it creates a fresh
one. Room prompt context is prompt content, not server-brokered Runtime
Context; credentials, memory reads, and provider state do not cross to the
Host.

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
(`ProjectOverviewService.getOverview`: `definition_status` plus `attention`,
and the Task the person is looking at, see `PROJECT_WORK.md`), and prefixes it onto
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

Agent-drafted changes that still wait for a person (see
`project.propose_definition` and `inquiry.promote_knowledge` in
`architecture/SYSTEM_ACTIONS.md`; opening a Thread and recording a conclusion
no longer do) surface back
into the conversation as an inline Proposal review card
(`RoomActionPreviewCard`, rendered by `conversation/RoomConversation.tsx`), reusing
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

Room creation adds the creator, and nothing else. The hidden managed
Assistant — the **Project's own instance**, so two Projects have two Agents
that start identical and accumulate their own token attribution and
evolution — is provisioned by the Room's **first message**, not by its
creation.

**A Room is a visibility boundary** ([ADR 0018](../decisions/0018-room-as-visibility-boundary.md)):
its roster answers *who may see these conversations*, and the only reason to
open a second Room is to exclude someone. Which agents take part in a given
exchange is per-message recipient selection inside one Room, not a second
Room.

**The layer is invisible until a visibility decision has to be made.** The
Project's Conversations page shows conversations, and a Project with only its
mainline never says the word "Room". Conversations of a limited Room appear in
the same list, in a section titled by its roster ("With Alice and Bob · 2
agents") with the roster surface reached from that section. Creating a
conversation offers two things — *in this Project*, or *with a limited group…*
— and the second is a roster picker whose completion creates the Room. There
is no Rooms entry in the top navigation and no cross-Project Rooms index;
`/projects/:projectId/rooms` remains, as one Room's own surface, and a
conversation's header there names the Room's audience when it is a limited one.

A Room nobody has spoken in holds no conversation, so a query over
conversations would hide it — and a Room is reached *through* a conversation.
`GET /projects/:projectId/conversations` therefore also returns `empty_rooms`:
the viewer's Rooms with nothing in them yet, named the same way, so a group
opened and then abandoned is still reachable rather than stranded.

**A Project's mainline Room is created with the Project** (`rooms.is_mainline`,
one active per Project, enforced by a partial unique index). "A Project with no
Room" is therefore not a state, and `getProjectMainline` reports its absence as
a broken invariant rather than returning null — no caller branches on it.
Mainline membership *is* Project membership: the Project's creator is enrolled
with it, and everyone else the first time they open it
(`GET /projects/:projectId/mainline-room`, which the Project chat panel binds
to). Because that membership follows the Project, the roster API refuses to
remove someone from the mainline — remove them from the Project instead.
Rooms opened afterwards are never mainline and keep the invite-only roster.

**A personal Room** (`rooms.personal_for_user_id`, at most one active per
person per Project) is a Room whose audience is one person: where private
continuation lands so it is not seeded into the Project's shared channel.
`createRoom` with `personal: true` reuses the existing one rather than opening
a second. The marker is cleared the moment anyone else joins, so a Room with
two people in it stops being reused for content meant for one.

### Deciding what a turn proposed

A Room turn's proposals (a research question, a Project definition, a
conclusion, a promotion) are decided where they were made. The Run snapshots
them onto its message as `action_previews`; the shared `RoomConversation`
component — so both the full Room page and the Project chat panel — renders
each as a card with Accept / Reject, and a decision continues the
conversation in place (`continueAfterProposal`). They also
reach the Project's attention list (`proposals/projectIntegration.ts`), each
row linking back to that conversation, so Pulse and the shell say a decision
is waiting without anyone opening the Space-level Review page.

A person can also decide in words. `proposal.decide` is a Room-allowed System
Action the Assistant invokes when the user says to accept or reject a proposal
this conversation produced. The Agent carries the decision and never authors
it: the policy rule refuses the action on any trigger origin but the person's
own turn (`unattended_project_write`), the executor refuses any proposal not
created by a Run of this same conversation, and the decision is applied through
the same `PgProposalApplyService.accept/reject` as the button, recorded against
the instructing person. B10 holds: every durable Agent write is still a
proposal a person decided.

`GET /projects/:projectId/conversations` (`listProjectConversations`) is the
Project's one list of everything said: every active conversation in every
active Room the viewer is a member of, mainline first, then by last activity,
each with its Room, its last message and its message count. Reading it enrols
the viewer in the mainline exactly as opening the Project does. It backs the
Conversations destination in the Project shell; the Rooms page stays the full
per-Room surface.

A Project **viewer** is a Project member and is therefore in the mainline, and
may converse there: asking the Project's Assistant "is this one done?" is the
panel's whole purpose, and reading the answer is what a viewer is for. What a
viewer says cannot change the Project's work — every Task-addressed action an
Agent takes on their instruction requires writer authority on the Project and
is refused. Speaking *first* is no longer a separate authority either: the
mainline is created with the Project, so a viewer can be the one who opens the
Project's conversation, and that message provisions the Assistant the same way
any other first message does. The manager
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

Creating a Room creates a Room. **The first message creates the first
conversation**, in the transaction that writes the message
([ADR 0018](../decisions/0018-room-as-visibility-boundary.md) decision 5), so
an empty conversation is impossible by construction rather than forbidden by a
rule. `POST /api/v1/rooms/:roomId/messages` — no session id — is that entry
point, and the conversation it creates comes back on the response. It is how a
Room's first conversation begins and how a further one does, so "start a
separate thread" is not a create followed by a send: it is a send with nothing
to continue.

The Project's Assistant is provisioned on the same first message, and it is
there that an ineligible backend is reported (`conversation_backend_required`).
Keeping it off Room creation is what lets the mainline be created with the
Project: a Space with no eligible API or granted CLI backend would otherwise be
unable to create a Project at all. A first message that fails commits nothing —
no Assistant, and no conversation whose only content was a message never sent.

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
Room-specific read model. It shows whether the Project has a goal and the
same `attention` list Pulse and the shell show, each item deep-linking
(`SpaceLink`) into the Area that owns it — nothing invented for the panel; a
fetch failure degrades to
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

## Thread References

A **reference** is content a person picks from one conversation — or from an
imported CLI session — and copies *once* into another thread. It is content,
not a pointer: resolved at the moment it is attached and never re-read
afterwards. That is what keeps one act of disclosure from becoming an ongoing
one, and keeps what an Agent knows inside a thread the same for everyone who
speaks in it
([ADR 0018](../decisions/0018-room-as-visibility-boundary.md)).

It lands as a `role: 'system'` message with `metadata_json.room_display =
'reference'` and the provenance in `metadata_json.reference`. Being a message
is the whole design: it is then the thread's own content — rendered in the
transcript with its origin, compacted by the thread's own summary job,
archived with the thread — and needs no per-thread slot, no per-turn injection
and no new acquisition path.

Grains: a whole conversation (carried as its summary), specific messages, a
whole imported session (its `imported_history_summaries` row), or specific
imported records. Two ways in — `references` on the session-less send, written
in the same transaction as the message that creates the conversation, and
`POST /rooms/:roomId/conversations/:sessionId/references` for a thread that
already exists.

Reuse / Dependency Check (recorded at close; the plan omitted it)
- Existing repository capability found? Yes — `contentAccessSql` /
  `projectReadAccessSql` for every audience, `readImportedSessionForViewer` for
  the transcript gate, the `Idempotency-Key` + fingerprint table pattern from
  Room creation, `fitTextToTokenBudget` for clipping. The Room conversation
  summary service was evaluated and rejected for imported sessions: it compacts
  a growing thread behind a lease, and a session's records are fixed.
- Existing installed dependency found? `zod`, `pg`, `node:crypto` — nothing new.
- Mature external option evaluated? n/a — domain logic.
- Chosen approach: extend (one new message kind; two tables —
  `imported_history_summaries`, `room_first_message_idempotencies`; three
  routes — the session-less send, the attach, and `/projects/:id/readers`).
- Why: a reference is content already governed by the Room's own gates; the
  only new authority is the disclosure calculus, which asks existing predicates.

### Disclosure is confirmed, and names who gains

Copying from a narrower audience into a wider one publishes that content to
people who could not read it. That is a person's act and it is allowed, but it
is **server-enforced**: the attach is refused with a coded 409
(`reference_disclosure_confirmation_required`) naming `gains_access_user_ids`
until the request carries `confirm_disclosure`. A confirmation that cannot say
who is being let in is not informed consent (ADR 0013). The client echoes back
the ids the refusal named rather than a bare `true`, because a roster can grow
between the refusal and the answer.

Audiences are measured by asking the read gates, never by describing them: the
mainline's is `projectReaderIds` (the roster lags — membership is materialised
on first open), a limited Room's is its roster **intersected with** Project
readability, and an imported session's is `contentAccessSql` at `full` with
`includeOversight: false`. Oversight is audit, not a route to publish, and not
a licence to spend.

### Trust follows provenance, however many hops back

Content from another Rainver thread is `domain_approved`; content from a
vendor CLI transcript is `external_untrusted` and is **fenced** in the message
body — quoted between nonce-suffixed markers, with the vendor-controlled title
inside the fence, under a line saying it is information to read and never
instructions to follow. Built at attach time so it survives the turn render,
the CLI replay and any later summary of the thread.

The label is derived from the *conversation*, not from the rows picked out of
it: if anything in a thread came from outside Rainver, everything picked from
that thread carries `external_untrusted`. Deliberately blunt. An Agent's reply
quoting a transcript, and a summary condensing one, are both untrusted content
wearing no markers — a per-message rule would miss them, and missing them is
what lets vendor text arrive labelled as a colleague's word. The cost is that
a purely internal message picked out of a once-tainted thread is over-labelled
and fenced too; that is the safe direction, and it is the intended one.

Neither label is user evidence. The checkpoint extractor derives `confirmed`
from `role = 'user'` alone, and a reference is a system-role message, so it
can never be read as the person having confirmed what it contains.

### Cost and ordering

An imported session's summary is generated **on demand** — when a whole-session
reference needs one and none exists — in the attach path but before the
transaction opens, because it is a model call and the attach holds the Room
row lock. It is metered to the session's *owner*, so the caller must first
prove they can read that session and reach the destination Room; both gates
run before anything is spent. See
[imported-sessions.md](imported-sessions.md).

A reference is written strictly before the message it arrives with, on a
timestamp floored above the conversation's own maximum, so a thread reads in
the order it was assembled.

### Idempotency

`room_first_message_idempotencies` keys the session-less send on
`(space_id, user_id, Idempotency-Key)` with a fingerprint of the request. A
duplicated first message would otherwise create a second thread *and* copy its
references into it again. The replay fetches the recorded message by id: the
message a key names is the thread's first, and looking for it in a page of
recent ones fails as soon as the thread grows past that page.

## API Surface

- `POST /api/v1/rooms` — create a Room (writer authority on the Project).
  `personal: true` opens, or reuses, the caller's personal Room in that Project
- `POST /api/v1/rooms/:roomId/messages` — speak without naming a conversation;
  the message creates one and the response carries it. Takes `references` and
  `confirm_disclosure`, and an `Idempotency-Key` header
- `POST /api/v1/rooms/:roomId/conversations/:sessionId/references` — copy
  picked content into a thread that already exists
- `GET /api/v1/projects/:projectId/readers` — who may be invited into a Room
  here. The gate is the answer: a caller absent from the result gets the 404 a
  missing Project gives
- `GET /api/v1/rooms` — list Rooms, optional `project_id` filter
- `GET /api/v1/rooms/:roomId` — Room detail with rosters
- `GET /api/v1/rooms/:roomId/agent-candidates` — visible existing Agents and
  separately typed preset factories
- `POST /api/v1/rooms/:roomId/agents` — add/reactivate a specialist with
  explicit private Room-share confirmation
- `POST /api/v1/rooms/:roomId/agent-presets` — instantiate and add a preset
- `DELETE /api/v1/rooms/:roomId/agents/:agentId` — remove a specialist and
  revoke future Room grants
- `POST /api/v1/rooms/:roomId/agents/:agentId/reset-context` — reset a
  host-bound specialist's vendor session (Host owner and Project writer)
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
- `GET /api/v1/rooms/:roomId/conversations` — list conversations
- `GET /api/v1/rooms/:roomId/conversations/:sessionId/messages` — paged history
- `GET /api/v1/rooms/:roomId/conversations/:sessionId/summary` — active summary,
  cursor, freshness/retry state, and owner-only provider/usage metadata
- `POST /api/v1/rooms/:roomId/conversations/:sessionId/messages` — send a
  message; supports direct `@agent` recipient segmentation or manager
  coordination, and optional explicit per-recipient backend selection
- `GET /api/v1/projects/:projectId/host-execution-targets` — the caller's
  online remote Hosts, this Project's Locations, and reported CLI
  adapter/installation choices for the host-bound Agent selector

## Invariants

- Room membership never widens Project authority.
- A reference is resolved once, under the attacher's identity, with oversight
  excluded, and never re-read. Nothing re-authorizes it per turn, because
  there is nothing live to re-authorize.
- A copy into a wider audience is refused until confirmed, and the refusal
  names who would gain access. Audiences are measured by asking the read
  gates, never by a second description of them.
- Content from outside Rainver is fenced at attach time and labelled
  `external_untrusted`, and that label survives being copied again.
- Room-only grants never widen global Agent visibility; every grant check also
  requires an active membership in the same Room.
- There is exactly one active Manager and it is always the system-managed
  Assistant; roster mutation cannot replace or remove it.
- Invitation activation is atomic with member insertion and grant creation;
  any roster revision, owner, or Agent-status mismatch invalidates approvals.
- There is at most one active Room owner. Removing an owner requires transfer;
  claim is permitted only while the previous owner can no longer write the
  bound Project.
- Room navigation stays inside the Project Shell. A Room is reached from the
  Project's Conversations list — a conversation row, a limited group's ⚙, or
  the chat panel's "Full Room" link — never from top-level navigation. There is
  no global `/rooms` route: it was a picker in front of a layer that should be
  invisible, and every Room already belongs to exactly one Project.
- A Room does not turn `agent_run_groups` into a conversation container; each
  message is its own collaboration task.
- The vendor CLI runtime session, when resumed, is permitted runtime state and
  never a source of truth — Rainver retains full replay capability (ADR 0004).
