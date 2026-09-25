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
  (`apps/web/src/modules/conversation/ConversationSurface.tsx`):
  messages, paging, sending, turn streaming, polling, scroll-follow and
  inline Proposal cards with continuation. The full Room page renders it as
  `variant="full"` (adds routing, per-agent backends, the summary) and the
  Project chat sidecar (`projects/sidecar/ProjectChatSidecar.tsx`) as
  `variant="panel"` with focus refs. There is no second conversation
  implementation; a behaviour a conversation needs is added there once.

  What a *turn* looks like is not this component's: it renders each one
  through `modules/conversation/ConversationTurn`, the single renderer the
  Agent chat panel also uses, so a turn looks the same wherever it is read.
  (The notebook panel shares the message list, `ConversationView`, but has no
  Run behind its replies and so never passes a turn.) The Room owns audience
  and membership; the Conversation module owns transcript, composer,
  execution preflight, and turn rendering. See
  [`architecture/CONVERSATION.md`](../architecture/CONVERSATION.md).

  Discussions render in that same component: messages sharing a
  `discussion_id` fold into one collapsible `DiscussionGroup` with Stop /
  extend controls, discussion notices render as cards, and the full Room
  variant adds an "Open a discussion" dialog beside the composer. The client
  calls `roomsApi.openDiscussion` / `discussions` / `discussion` /
  `stopDiscussion` / `extendDiscussion` (`apps/web/src/api/client.ts`); see
  the Rendering section of `architecture/CONVERSATION.md`.

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
- The shared Conversation execution-context control is fully visible while a
  draft still needs confirmation. After a healthy initialization it collapses
  by default in both the full Room and Project sidecar, retaining one disclosure
  row for Host/CLI/cwd inspection and attachment management. A blocked pinned
  Host or runtime opens the control automatically so recovery is never hidden.
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
- Runtime Context renders the active summary plus only uncaptured recent
  turns. For a Room turn both budgets are shares of the recipient's model
  window — summary 3 %, recent 15 %, one summary batch 30 %
  (`roomContextBudgets`) — never below the 2,000 / 6,000 / 12,000-token floors
  a small or unknown model gets; the window is the one the runtime reported for
  the thread, else the catalog entry for the pinned model. When no summary is
  coming (the state is `waiting_provider` or `failed`) the recent window widens
  by one summary batch rather than dropping what a summary would have covered
  — at most to half the share at which the session rotates (30 % of the
  window at the default 60 %), so a fresh session does not start next to the
  rotation line — and the Room shows "Summary not configured" to every member. While
  summaries run, the tail a summary leaves uncovered is the 6,000-token floor
  for every recipient, since the summary is one per conversation; a larger
  recent budget matters on a fresh session, before the first summary, and
  when no summary is coming. The cursor is
  exclusive and the assembler asserts that the two ranges do not overlap. The
  current trigger message is never silently truncated. Tokens are the shared
  character-class estimate (`usage/modelCatalog.estimateModelTokens`: a
  run of ASCII letters, and whitespace, a quarter token a character; a run of
  ASCII letters and digits that holds a digit — numbers, hashes, UUIDs,
  base64 — three quarters; other ASCII punctuation half; any other character
  one), not UTF-8 bytes. Measured against real tokenizers it stays at or
  above the real count on prose, code, ids and encoded data. The summary
  scheduler's SQL threshold gate (`conversationSummaryService.ts`)
  approximates it in the database: every ASCII character a quarter, every
  multi-byte character one. It under-counts digits and punctuation, which only
  delays a summary; the provider path measures the exact batch.
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
  to block (plan Phase 3). A child that changed files carries its `[Changes]`
  block (file list with counts and a `rainver://artifacts/<id>` link, never
  the patch) in the delegation result itself — in a Room only, since only a
  Room turn has the resource tools to follow the link — so the `delegation_result`
  message, the continuation and its retry job all hand it on; a turn whose
  instruction carries such a link is granted the resource tools that read it. A Manager that *did* wait is unaffected — that
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
Room's optional Project Folder binding is fixed at creation and remains a
read-only retrieval/context scope; it is not a Conversation execution
Location or Primary Workspace (`architecture/EXECUTION_MODEL.md`).

### Host-bound specialists and direct chat

A specialist Agent may bind its runtime profile to one of the caller's own
remote Hosts and either a Workspace Location in this Project (`location`) or a
daemon-created private workspace (`managed`). The Room roster keeps the normal
Agent identity and uses `trigger_policy = owner_only`: only the Host owner can
dispatch it, while another member sees a visible system notice and no Run is
created. A stale or offline Host is handled the same way, with no queueing or
replay when it returns.

The Project's own Assistant (the Room manager) is provisioned when a user
explicitly opens a Conversation draft. The draft's execution preflight shows
the Agent, Host, CLI installation, Primary Workspace, and attachments. A
Project with no Folder connected defaults the Primary Workspace to a managed
workspace on the Host, and the preflight says so beside the choice with a link
to Files & Code — the fallback is a visible choice, not something that
happens quietly while the person believes the Agent is in their code. Runtime
profile defaults are suggestions only; initialization pins the selected
Conversation×Agent bindings, including a model/provider and runtime
configuration/policy snapshot. Later profile/Host changes cannot reconfigure
or rebind that Conversation; incompatible Host/CLI changes block the Run.
There is no server fallback to a different Host, CLI, or workspace.

Before a Room send can commit, the server locks the Conversation execution
context and compares the current Primary Workspace's Git branch, commit, and
readiness with the persisted baseline (`assertConversationGitBaseline`). When
branch and commit moved to exactly the values the host reported at the exit
of this Conversation's most recent writing Run in that Location
(`last_run_git_branch/head`, from the diff upload's `git_after`, recorded only
when that Run started from the accepted HEAD with the directory's lease held —
`modules/hosts.md`), the Conversation's own Agent moved them: the send
advances the baseline in place — the same write as the refresh route, which
also clears the last-Run HEAD — and continues. A done Task's merge that
fast-forwards the checkout records its merged commit there the same way for
the conversation the Task came from, when that conversation had accepted the
main branch's previous tip (`modules/hosts.md`, "Merging a done Task"). Any
other move, and
any readiness change, returns `409` and rolls back the send transaction, so
no Room message, group, or recipient Run is persisted; the explicit
execution-context Git refresh route is the only other way to advance the
baseline. Uncommitted changes are never compared. The direct-chat send and
the execution-context summary's `can_send` apply the same rule
(`sessions/conversationGitGate.ts`). This remains true for direct API callers
and for image-only messages, not only for the preflight UI.

The shared conversation turn controls stop active Runs through the canonical
Run stop route, retain partial output on cancellation, and show the exact
per-Run `remote_diff` Artifact when a Host uploaded one. That Artifact is
this Run's own change: the daemon captures the working tree as a git tree
object before the process starts and diffs it against the tree at exit,
through a private index file, so a later recipient's diff does not repeat
every earlier Agent's uncommitted edits and the person's staged index is
never touched ([hosts.md](hosts.md), diff capture). The same Artifact is how
one Agent's change reaches another: as a `[Changes]` list and link, see
serialized recipients below. Retry is manual and
idempotent: it checks every failed/degraded recipient Run (`run_ids`; a
delegated child in `delegated_run_ids` is not a recipient), revalidates the
original image/file parts against current recipient capabilities, reuses the
original user Message, and records new retry Run ids in that message. Drafts
are kept in destination-scoped sessionStorage as validated logical references;
they never contain image bytes, absolute Host paths, or credentials.

A message addressed to several Agents creates one Run per recipient in one
transaction, but they execute one at a time: the Conversation has one
directory. Every recipient after the first is parked `waiting_for_dependency`
(scope `conversation_serialization`, `agentGroups/waitScopes.ts`) behind
*every* earlier recipient, and the lifecycle projector admits it when those
are terminal. An admitted recipient keeps the prompt it was dispatched with —
identity block, conversation window, execution rules, assigned task — with
the earlier recipients' replies appended under a `[Replies already given to
this same message]` heading, because its conversation window closed at the
person's message. An earlier recipient that changed files (a non-empty
per-Run `remote_diff` Artifact, latest upload) has a `[Changes]` block under
its reply: `git diff --stat`-style lines derived server-side from the stored
diff (path, `+added -removed`, at most 20 files and a summary line, an honest
"at least … truncated" header when the stored diff was cut) and the link
`rainver://artifacts/<id>`. The patch never goes into the prompt; the admitted
Run gains `input_resource.read/search` to read it on demand
(`agentGroups/runChangeBlock.ts`; the read authority is in
`architecture/SYSTEM_ACTIONS.md`). The `agent.wait_for_results` continuation
lists the same block under each completed result. That is deliberately not the `agent.wait_for_results`
resume shape, which replaces the prompt with a continue instruction: a Run
that never ran has nothing to continue. The parked Runs hold the turn, so
the next message waits in the queue until the chain completes (or gets `409`
when sent without `queue`; see "A person's message during a turn" under
Discussions).

Each Conversation × Agent owns one live `host_threads` row. It pins the
Location or managed mode, Agent/container identity, adapter, installation, and
opaque vendor session. A first turn, a changed conversation, or a reset sends
Project state plus that conversation's summary and uncovered messages,
preceded by the conversation title. Later turns in the same conversation send
only messages since that Agent's previous turn. Reset context clears the
vendor session and marks the thread `session_reset`; the directory stays.

A host-bound turn's `host_prompt_context` opens with the Agent's own identity
block (`agentGroups/agentIdentityPrompt.ts`): the owner's `role_instruction`
first, then the Agent's persona, then the notes it learned where this Room's
audience already reached. The notes come from the Memory module's own delivery
query — **not** through the retrieval adapter, because agent-scope entries are
excluded from the person-facing retrieval index outright (memory search runs as
the instructing person, so an indexed note from a limited Room would come back
in any Room that asked). Both memory sections are bounded: the persona is
clamped, and notes are taken newest-first, whole notes only, skipping one too
large for what is left rather than stopping at it.

The block and the Room execution rules form the turn's **standing context**
(`agentGroups/roomStandingContext.ts`), and it is sent **when it changes**, not
on every turn: into any vendor session that is not being resumed, and into a
resumed one only when its sha256 differs from `host_threads.identity_digest`,
the digest of what that session last received. A revised persona, a roster
change that alters which notes may be delivered, or a rules edit is a new
digest and goes out on the next turn; an unchanged block is not repeated, so a
resumed session no longer grows by one copy per turn and its prefix stays
stable for vendor caching. The digest is written **only** by the terminal
outcome of a Run that carried the block and completed
(`PgHostThreadRepository.recordRunOutcome`, `landed`): a dispatch that never
reached the runtime, or failed, records nothing and the next turn sends the
block again — a digest that said "sent" for a turn that never landed would
silently withhold the Agent's identity, which is the worse failure. A vendor
session replaced under a Run that did not carry the block clears the digest,
and a reset clears it outright.

What re-sending cannot do is **retract**: a note delivered on turn 1 is in the
vendor session, and adding a member to the Room afterwards stops it being sent
again but does not take it out of what the Agent is already reasoning from.
Only an explicit context reset does that. ADR 0003 §4 is precise about this —
the audience filter guards the moment of dispatch — and this is the same
accepted residual, not a solved problem.

A specialist reached by `agent.delegate` gets the same block: it runs in the
same vendor session as one that was @-mentioned — `host_threads` is unique per
Conversation × Agent — so without it the same Agent would run with its role and
persona on one turn and without them on the next, depending only on how it was
reached.

A sibling Agent waiting on another's Run is shown that Run's **task**, never
its prompt (`runs/runAssignedTask.ts`): the prompt carries the other Agent's
persona and notes, and the Agent is the memory boundary.

Direct chat sends the same block, with the person in that chat as the audience:
they receive the persona and the notes learned in Rooms whose roster still
contains them, plus notes taken in that chat when they are the Agent's owner.

Like the conversation history beside it, the block is prompt content and not
server-brokered Runtime Context: it enters no Delivery, no snapshot and no
checkpoint of its own, and it is regenerated every turn rather than replayed.
A run dispatched to the **server** host is still brokered through the Runtime
Context Gateway for everything else it is given — only a remote host skips that
— so "not Runtime Context" describes this block, not the whole turn.

The Agent's CLI state on that machine is scoped the same way. Its runtime
profile — login, vendor sessions, and whatever the CLI remembers on its own —
is keyed by **Agent × container**: this Conversation for a Room turn, the owner
for a direct chat ([`hosts.md`](hosts.md), "The runtime profile"). Two
specialists in one Room, and one specialist in two Rooms, therefore share
nothing the CLI remembers, which is the substrate half of
[ADR 0003](../decisions/0003-memory-proposal-flow.md) §6 — Rainver owns the
Agent's identity and its distilled Memory, and the CLI's own auto-memory stays
delegated scratch it never reads or imports.

The same owner-only gate permits a direct chat with a host-bound Agent. Direct
chat has one `host_threads` container per Agent × owner, renders recent messages
from that session (not a Room summary), and exposes
`POST /api/v1/agents/:agentId/chat/reset-context`. Deleting the direct session
closes and archives both the Agent's runtime profile and, when Rainver managed
it, the workspace; the first later message may opt into restoring the newest
archive, but never restores the vendor session. Removing a Room specialist
follows the same archive-not-delete rule, with offline archives replayed on the
daemon's next heartbeat — with one distinction the shared Conversation cwd
forces: the departing Agent's **profile** is always archived, while the
**workspace** follows only when the last Agent leaves the Conversation.

`POST /api/v1/agents/:agentId/host-state/reset` clears an Agent's CLI memory on
one Host outright: every profile archived, no workspace touched, and that
Agent's vendor sessions on the Host retired.

What a remote Host receives is prompt content, not server-brokered Runtime
Context; credentials, memory reads, and provider state do not cross to the
Host. Managed directories remain per container, so a direct chat cannot see a
Room's files and one Room cannot see another's files without an explicit pull.

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
viewer identity. It does not select or replace the Conversation's CLI runtime;
all speakers use the same pinned Conversation × Agent runtime while retaining
their own authorization and attribution (`modules/agents.md`, ADR 0008).

## Conversation backend

Each initialized Project Conversation owns one immutable Host and Primary
Workspace. Every participating recipient uses a `Conversation × Agent` CLI
profile and `host_threads` row pinned to that same Host, execution directory,
adapter, and runtime installation. The Conversation binding also owns the
initialization-time model/provider and runtime configuration/policy snapshot;
changing the reusable profile is not a Conversation mutation. A later speaker never re-resolves the
binding from personal credential grants, and delegation reuses the target
Agent's pin instead of selecting the first usable default. The Room session
remains canonical conversation storage. See `modules/agents.md` for the shared
direct-chat/Room execution model.

The shared composer accepts PNG, JPEG, and WebP images by paste, drop, or an
accessible picker. Uploads become authenticated pending media immediately and
remain removable until send; historical images use the authenticated media
route rather than public URLs. In an initialized Project Conversation, typing
`@` combines active Agent mentions with bounded Files results from the Primary
and attached Folder Locations. Each File result shows its source and relative
path, and selecting it creates a structured file reference shown as a path chip
inside the message input; the server
re-authorizes and snapshots the text file before dispatch. Image-only messages
are valid when every selected runtime/model supports images, otherwise the
composer names the incompatible Agent and blocks send. For a Host-owned ACP
profile, support comes from the selected installation's initialize capability;
Provider/model metadata is part of the decision only when the profile has a
server Provider binding. A normal Host Run receives the managed file as a
server-issued ResourceLink and relative path; a manual retry uses the original
immutable snapshot instead. User-uploaded images remain actual multimodal
image inputs rather than being silently converted into workspace files.
Conversation Folder attachments are writable by default; the user can choose
Read only for an explicit read-only grant, and the selected Host namespace still
confines both modes to the authorized Location root. The Files & Code sidecar
adds the selected current-file state only while that Area is mounted; it is
visible as a removable `Current file` bar and is not a global attachment entry.
The send freezes saved/draft bytes into an immutable message resource without
putting the body in the prompt. The Agent reads that resource lazily through
the Run-scoped `input_resource.read/search` tools.

## Project state context (Phase A)

`RoomService.sendMessage` builds a domain-neutral "Project state" text block
once per dispatch (`buildRoomProjectStateContext`, `rooms/service.ts`) from
the same generic Project Overview contract the Project Overview page uses
(`ProjectOverviewService.getOverview`: `definition_status` plus `attention`,
and the Task the person is looking at, see `PROJECT_WORK.md`), and prefixes it onto
every recipient run's prompt (`roomRunPrompt`,
`agentGroups/service.ts`). It never reads a specific domain's tables and fails
open to no prefix on any error, so a Project state read never blocks sending a
message. This is the mechanism behind the retired conversational-advancement
plan's decision 3: the Room agent's contract stays domain-neutral, and a Mode/domain extends what the
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
(`RoomActionPreviewCard`, rendered by `modules/conversation/ConversationSurface.tsx`), reusing
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
whenever the group has a `room_id`, independent of whether the Run executes on
the server Host or a remote trusted Host. Host kind changes how the same
Run-scoped tool surface is delivered, not which Room-owned actions the Run may
use. Non-Room groups receive `CONVERSATION_TOOL_ALLOWANCE`. See
`architecture/SYSTEM_ACTIONS.md` for why the scope moved and what stayed
fail-closed.

The allowance is decided once, by `conversationToolGrantInput()`
(`systemActions/scenarioToolAllowance.ts`), for every way a person or a Room
talks to an Agent: a Room message, a delegation the Room's Agent makes
(`createDelegatedChildRun` carries it), and a direct chat opened in a Project.
Before that, a delegated child declared nothing and could call no action, and
direct chat kept a three-action list from before scenario allowances existed.
The Room allowance carries both halves of delegation (`agent.delegate` and
`agent.wait_for_results`), the Project write surface, `task.plan.propose`
(proposal-gated), and the two Source proposals.

What the Room prompt tells the Agent (`roomRunPrompt`, the policy constants
in `systemActions/conversationPolicy.ts`) names the action for each thing a
person says: a stated goal → `project.propose_definition`
(`PROJECT_DEFINITION_ACTION_POLICY`); a request for a plan or next steps →
`task.list` then `task.create` per step, with timing in `due_at` /
`start_after`, and a recommendation grounded in `task.list` (status, priority,
dates, blockers) and `inquiry.list_threads` (each Thread's recorded
`next_step`) (`PLAN_ACTION_POLICY`). The Project-state block lists pending
decisions (attention class `gate`) before anything else and carries each
item’s summary, so an Inquiry next step arrives with its rationale and a
pending proposal is never crowded out by a busy board. A conversation turn
gets eight model turns in the managed loop (`CONVERSATION_MAX_MODEL_TURNS`),
twice a dispatched Task's default, because the policies chain reads and
writes before the reply.

The same policy tells the Agent that `task.create.required_outputs` is only for
file Artifact types collected as deliverables. A reply, inspection, or edit to
an existing workspace file must use `definition_of_done` and `task.report`
instead, because a conversation Run does not have the remote output-delivery
action that satisfies a declared file output.

A revised goal supersedes the pending draft: `proposeDefinition` reuses the
pending proposal only for the same Run (a retry) or an identical definition;
a later turn with different wording marks the earlier draft `superseded` and
creates a new one, so "actually, make it Y" cannot hand back — and Accept
cannot publish — X.

Those Room-owned System Action ids authorize server tools; they are not
runtime-profile capabilities. Routing excludes registered System Action ids
from its capability hard filter, so a valid conversation backend does not have
to duplicate the Room allowance in its AgentVersion or runtime profile.

Room creation adds the creator, and nothing else. The hidden managed
Assistant — the **Project's own instance**, so two Projects have two Agents
that start identical and accumulate their own token attribution and
evolution — is provisioned when a user explicitly opens a Conversation
draft, before any message is sent.

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
them onto its message as `action_previews`; the shared `ConversationSurface`
component — so both the full Room page and the Project chat panel — renders
each as a card with Accept / Reject, and a decision continues the
conversation in place (`continueAfterProposal`). One kind of card is rendered
for one person only: a proposal that names its decider by identity rather than
by role — an Agent's persona, which is its owner's alone
([ADR 0003](../decisions/0003-memory-proposal-flow.md) §5) — carries
`decidable_by_user_id`, and the surfaces drop it for everyone else. It stays in
the shared snapshot rather than being filtered server-side, because that
snapshot *is* the card: dropping it there would take it from the owner too. So
a member who asked the Agent to change what it has become sees the reply and no
card, which is the intended answer — they cannot accept it, and buttons that
refuse are worse than nothing.

What that does **not** do is keep the proposal's own title off the wire: it
stays in the message's `metadata_json`, which every member of the Room reads.
That is consistent with ADR 0018 — the request was made in this Room, so its
text is this Room's content — and the hiding is about who is asked to decide,
not about who may read what was said. They also
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
proposal a person decided. The executor returns the gateway's
`{ modelResult, summary }` shape (a flat object made a decision that *was*
applied read back as a failure) and hands the model the same continuation
instruction the Accept button dispatches as a follow-up turn
(`ConversationContinuationRegistry.resolve`, as `next_step`), so a decision
typed into the conversation unblocks the same work a click does. A
Project-scoped proposal's `required_approver_role: "owner"` means the
Project's owner: `enforceApplyPolicy` treats a Project owner-level user as
satisfying it even when their Space role is `member`, which is what the
applier's own `assertProjectOwnerLevel` asks.

`GET /projects/:projectId/conversations` (`listProjectConversations`) is the
Project's one list of everything said: every active conversation in every
active Room the viewer is a member of, mainline first, then by last activity,
each with its Room, its last visible message and its visible-message count.
Internal execution instructions (`room_display = internal`) are excluded from
that preview and count, as they are from the transcript. Reading it enrols
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
Project's Conversation draft, and that explicit draft action provisions the
Assistant. The manager
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
is bounded to one level and two specialists per turn (`max_depth: 1`,
`max_fanout: 2`, prospective counts — the third request is refused and
recorded as refused, and a refused request does not consume the budget).
There is no concurrency budget on a Room group: delegated children execute
one at a time because the Conversation shares one directory, and a parent
that delegates and then waits in the same turn admits its children when it
parks — before that, the two waited on each other. Neither
directly-executed action is a general Agent permission.
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

Creating a Room creates a Room. A visible, explicit Conversation-draft action
opens the first Conversation and its execution preflight
([ADR 0018](../decisions/0018-room-as-visibility-boundary.md) decision 5).
The draft may be abandoned without a message or Run. It shows the Agent, Host,
CLI installation, Primary Workspace, and attachments; the first message is
accepted only after that context is initialized. The Project's Assistant is
provisioned by the draft action, so backend failure is reported before any
message is written and Project/Room creation remains independent of backend
configuration.

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
imported records. References are attached through
`POST /rooms/:roomId/conversations/:sessionId/references` after an explicit
Conversation draft exists; sending is always addressed to that Conversation.

Reuse / Dependency Check (recorded at close; the plan omitted it)
- Existing repository capability found? Yes — `contentAccessSql` /
  `projectReadAccessSql` for every audience, `readImportedSessionForViewer` for
  the transcript gate, the `Idempotency-Key` + fingerprint table pattern from
  Room creation, `fitTextToTokenBudget` for clipping. The Room conversation
  summary service was evaluated and rejected for imported sessions: it compacts
  a growing thread behind a lease, and a session's records are fixed.
- Existing installed dependency found? `zod`, `pg`, `node:crypto` — nothing new.
- Mature external option evaluated? n/a — domain logic.
- Chosen approach: extend (one new message kind; the
  `imported_history_summaries` table; the attach and
  `/projects/:id/readers` routes).
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

## Discussions among a conversation's Agents

A Room conversation's Agents can address each other. The mechanism is one
object, `room_discussions` (`rooms/discussionService.ts`,
`rooms/discussionRepository.ts`), living inside the conversation's single
timeline: every message and task group in a discussion carries
`discussion_id`, and each message records the **wave** it belongs to in
`metadata_json.wave`. A wave is one task group — the message that dispatched
it and its recipients' replies — and waves count from the person's message
(0). There is no second navigation level; the client folds a discussion into
one block (*Room = channel, Conversation = thread, discussion = a grouped run
inside a thread*; a second thread level waits on the trigger in the deferred
register).

**The constraints a change must keep.** Agent-to-Agent discussion is bounded
so that spend never grows without a person's say: every Agent-triggered turn
is charged to a container a person started, and past its budget an Agent's
`@` is a held notice a person may accept, never a Run. Emergent and explicit
discussions are one mechanism at two budget levels, not two features. A round
is a wave and an Agent speaks at most once per wave (the one-segment-per-Agent
rule), so turns per round ≤ participants and a discussion's turns are bounded
by rounds × participants with no separate turn cap; the fan-out ceiling of 5
(ADR 0017) caps participants. Waves run one after another because the
Conversation's Agents share one directory (the serial chain below, and the
Location lease in [hosts.md](hosts.md)); parallel participants would need a
worktree each and a merge, which is deferred. Whether to delegate a sub-task
or discuss is the Manager's own judgment, as for delegate-vs-research above;
the server never pattern-matches text to choose, and what each turn reads
follows from the action that created it, never from a mode switch
([CONVERSATION.md](../architecture/CONVERSATION.md), "What each turn reads"). `"all"`
is a participant option of the open-discussion request, never a token in
message text; everyday messages keep explicit `@`. Reaching a cap is never
silent, and whatever ends a discussion, the Manager reports on it. Every
turn in a discussion, the closing one included, acts with exactly the
authority of the person who owns the container (B8A), so its writes meet the
same gates that person's own turn would (memory writes under B10).

**Containers and budgets.** Every Agent-triggered turn is charged to a
container: by default the person's message that started the turn. When the
last Run of a wave has completed its chat turn (`finalizeChatTurn` →
`RoomDiscussionService.afterTurnFinalized`), its replies are parsed for
`@Name` mentions of roster Agents with the same segmenting rule the composer
uses (`parseAgentMentions` in `packages/protocol/src/roomDiscussions.ts`; code
spans are never read as addressing anyone). Mentions of another Agent open an
**emergent** discussion on that message (the group's trigger message; for a
wave started by a delegation or research result that is the continuation's
hidden instruction, not the person's message — kept so, because the timeline
folds a discussion from its origin and anchoring it on the person's message
would split the block around the Manager's own reply): round cap 2 (the
person's round plus one the Agents opened) and the fan-out ceiling of 5 Agent-triggered turns
(ADR 0017). Two replies of one wave addressing the same Agent give it one
turn whose content is both addressed parts. A person opens an **explicit**
discussion with `POST …/discussions` — topic, participants (explicit, or
`"all"`, refused above five), shape `open`/`debate`, round cap (default 3 open,
2 debate) and a spend cap on priced Runs (default
`ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD` (protocol), USD 2 — a constant, as
there is no Space setting for a pipeline's bounded spend to default to;
subscription Runs are bounded by rounds). One discussion per conversation is active or waiting at its cap
(partial unique index); opening a second returns 409 naming it.

Every Agent-origin continuation charges the container: a delegated child
charges it when spawned (`chargeDelegatedChild`), and an
`agent_delegation_result` continuation joins the source's wave and delegates
only from what the container has left (`agentOriginContinuation`), never past
a discussion's spend cap. Inside a discussion the count is the row's
`turns_used` (an emergent discussion's waves count too; an explicit one's are
bounded by rounds); otherwise it is one counter on the task group of the
person's message, `budget_json.container_turns_used`, which every branch of
the chain charges through its `budget_json.container_group_id` pointer. A
completion turn can therefore no longer delegate again with a fresh budget.
A research acquisition an Agent starts (`research.start_acquisition`) carries
its turn's group (`origin_group_id`, through the pipeline job and the
Operation's progress), so its result and status turns are charged to that
container too; one a person starts opens its own. The
container model itself is described with the other execution budgets in
[EXECUTION_MODEL.md](../architecture/EXECUTION_MODEL.md) ("Containers and
Agent-triggered budgets").

**Waves.** The next wave is an ordinary domain-event continuation
(`agent_mention`, keyed `<discussion>:<wave>`) with one recipient segment per
addressed Agent, dispatched as the container's owner — so a wave has the
serialization, identity block, prompt and authority of that person addressing
the Agent directly (B8A) and no more. An Agent the owner could not trigger — an
owner-only specialist on someone else's machine, or a private Agent the
dispatcher's own visibility check would refuse them — gets a `not_admitted`
notice (`metadata_json.discussion_notice`) and no Run; when that leaves nobody
to set working, no closing turn is spent either. A wave spans every task
group stamped with it — its dispatch plus any delegation result joining it —
and advances once, from the dispatching group, over all their replies.
Participants read the shared window (messages since their own last turn). In
a **debate** the first round answers independently — the serialized "replies
already given" block is withheld — and every later round goes to all
participants to critique, each handed every answer of the round before.

**Ending.** A wave in which nobody addresses anyone converges; a wave that
would pass the round cap, a spend at or above the cap, or a spent fan-out
budget stops at `cap_reached` with a `cap_reached` notice naming the Agents it
held back (`held_mentions_json`); a person may stop it (`…/stop`, any member;
the running turn finishes). Whatever the reason, the Manager then gets one
closing turn (`agent_discussion_closing`) addressed to the person — agreements,
disagreements, next steps, who did not respond and why — outside the round cap
and inside the spend cap; its reply is `conclusion_message_id` (only the
closing turn keyed to the discussion's current round count concludes it). A
discussion at its cap stays open to `…/extend { rounds }`, which records who
added them, turns an emergent discussion explicit ("open a discussion"), and
dispatches the held Agents as the next wave. Adding rounds is a new decision
to spend, so the discussion then runs for the person who made it: their
authority re-checks the held Agents, their subscription executes the waves,
and they get a spend bound (another budget of the same size when the cap was
reached). A wave that loses the conversation's turn to a concurrent message is
retried by the `room_discussion_advance_retry` job, and so is one that met a
transient database failure (deadlock, serialization conflict, timeout, lost
connection). Advancing is idempotent per group: once a wave is complete, every
group in it is stamped `agent_run_groups.advanced_at` in the advance's own
transaction, and an advance that finds its group stamped does nothing — so a
retry, a queue release and a second finalization reaching the same wave never
announce, merge or dispatch twice. A late group of an advanced wave (a
delegation result) is advanced once itself, and names only the Agents its own
replies addressed. A wave that cannot be
dispatched for any other reason — the Host offline, the container's owner no
longer in the Room — closes the discussion with a `failed` notice rather than
leaving it running with nothing behind it. Discussion notices are posted by
the conversation, attributed to no one, so they are written even when the
person the discussion ran for has left. A delegation result that arrives
after its discussion stopped or reached a cap still reports into it, but
delegates nothing and opens nothing new; Agents a late or superseded reply
addresses are named in a `not_admitted` notice, never silently dropped.

**A person's message during a turn** is queued, not refused: a person must be
able to steer a running discussion, and a mid-turn injection into the vendor
session is deferred (deferred register), so the message enters at the next
turn boundary — the running turn finishes first — and every later turn sees
it. The same queue replaced the plain `409` outside discussions. The queue is
its own table rather than a hidden message in the tree, so nothing that reads
the message tree has to filter it out.
`POST …/messages` with `queue: true` (the client's default for a message
without attachments) returns 202 with the queued message when another turn
holds the conversation, or when earlier messages are still waiting (a queued
message never overtakes them); it waits in `room_queued_messages`
(`rooms/messageQueue.ts`), outside the message tree, so no prompt, replay or
summary sees it until it is posted. A send, a release and a discussion's
advance all take the conversation's `room-discussion:` advisory lock first; a
send with attachments, or without `queue`, does not queue and so can go ahead
of waiting messages when the turn is free.
When a turn completes and the conversation's turn is free, the oldest waiting
message is posted as an ordinary message with the request it was sent with, as
its sender (`RoomDiscussionService.releaseQueued`). Inside a running
discussion it is posted by the advance of the wave that just completed, in the
same transaction, ahead of the wave the Agents' replies asked for: the
person's message joins the discussion as a new first round (`round_base`; the
round cap counts from it, the spend cap does not), and the Agents that wave
addressed are held and follow it. Agents are held only behind a message that
was actually posted; a withdrawn or failed one lets the advance continue as
usual, and a turn taken by something else retries the advance. From a Project
writer (who may open and extend discussions) the new rounds are that person's
decision (B8A): they become the discussion's owner, within the spend cap
already set. Anyone else's message is one more round within the bound the
discussion already has. In a debate nothing is held: the next critique round
answers the replies to the person's message. A message with
attachments is never queued (its parts are claimed at send). A waiting message
that cannot be posted is marked failed and the next one is tried (a turn still
taken, an addressed Agent's host thread still on the turn that just ended —
409 `room_agent_turn_in_progress` — or a transient database error leaves it
waiting instead); it stays
listed to its sender only, with the refusal's reason (an internal error reads
"The message could not be posted."), until they dismiss it. Every
queued message also enqueues a `room_queued_message_release` job
(`rooms/queuedMessageReleaseJob.ts`), deferred while the turn is taken, so a
message is released even when no turn boundary did it — the turn ended just
before it was queued, or the server stopped in between (a release that lands
in the moment between a wave's last Run ending and its advance posts the
message outside the discussion; the wave then advances as usual and the
Agents the message's turn addresses join its held Agents); a transient database
error defers the job rather than spending an attempt, and a discussion whose
advance failed and closed posts what waited for it at once. Its sender takes it
back, or dismisses a failed one, with `DELETE …/queued-messages/:id`.
`GET …/messages` returns what is waiting, and the viewer's own failed
messages, beside the page as `queued`. Without `queue`, a taken turn is the 409 it always was
(`conversation_turn_in_progress`; like every coded Room refusal, its body
carries `detail` for the reader beside `code`).

**Cost lines, by funding source.** The two ways a Run is paid for are bounded
differently because only one of them can be attributed: a priced Run has a
money figure of its own, so a discussion's spend cap bounds priced Runs only;
a subscription's window utilization is account-wide — shared with everything
else the login runs — so it is shown, never charged to a discussion, and
subscription Runs are bounded by rounds, by the window itself, and by the
quota gate below. `GET …/discussions/:id` returns `usage: {
priced_usd, subscription: [{ account_label, tokens, window }] }`: money on
priced Runs (catalog-costed `token_usage_events`; the spend cap bounds only
these), and one line per CLI login the discussion's Runs spent — a Run spends
its host thread's copy (`host_id`, `runtime_key`, `runtime_installation`) when
it is not bound to a ModelProvider — with this discussion's tokens there and
the account's fuller window (`kind`, `utilization`, `resets_at`) from the
latest cached reading (`host_runtime_usage`; no probe on a read). The
percentage is account-wide and never charged to the discussion
(`rooms/subscriptionLogins.ts`). The client reads the detail when the
discussion's record changes — once per wave, not per poll — and the group
header renders one line per funding source, marked past the Space's warning
line.

**Subscription quota gate** (`rooms/quotaGate.ts`). The gate coordinates a
shared subscription by trigger origin (ADR 0017): turns Agents set going
spend the account unattended and stop at a reserve line, keeping the rest of
the window for the person, while a person's own message is their decision in
that moment and is never held — it proceeds until the CLI itself refuses. A
held turn deliberately does not keep the conversation's turn (below), so a
person is never queued behind Agents waiting for a window. The Space
policy `subscription_quota` (`warn_pct` 70, `reserve_pct` 85; a
`ScopedSettingsStore` descriptor in `providers/subscriptionQuotaPolicy.ts`,
edited on the Providers page) draws two lines. Every **Agent-triggered**
admission — the first Run of a domain-event continuation (a discussion wave,
its closing turn, a delegation result, a research result:
`dispatchMessageInTransaction` with `agent_origin`), a delegated child
(`queueDelegatedChildrenInTransaction`), and a serialized recipient inside a
continuation group (`queueWaitingDependencyRunIfReady`) — replaces its job
enqueue with `admitAgentOriginRun`: it reads the login the Run spends (the
cached reading; probed through `usage_probe` first when older than 60 s,
waiting at most 5 s inside the admission's transaction), and at or past
`reserve_pct` the Run stays `queued` with no job and
`output_json.waiting_for_quota = { window, resets_at, utilization,
account_label, login, held_at, job }`. A held Run does not hold the
conversation's turn: `conversationTurnTaken`
(`sessions/conversationRuntimeSessionRepository.ts`) skips it and every Run
parked waiting on it, transitively (a serialized recipient behind it, a parent
waiting for it) — never a queued Run whose job is enqueued, which is about to
run — and, since a group runs one Run at a time, every Run of the held Run's
group that is parked on a dependency or queued with no job (a recipient
serialized after one whose delegated child is held, say); a held or parked Run
that has its job again is about to run and holds the turn. So a person's
message goes ahead at once while Agents wait. Those Runs also let go of their
Agents' host threads (`dispatch_lock_id`, claimed when each was created), so a
person may address any of those Agents meanwhile; a lock is claimed back in
the name of the Run it was taken for — a handoff turn runs under the lock of
the recipient it prepares, and claims in that recipient's name. Whenever a
Run's job is enqueued its waiting markers are cleared. Admission takes both back: a held Run is admitted only when no
other Run holds the conversation — its own group's running Runs and queued
ones with a job included, since a group runs one Run at a time — and its host
thread is free; otherwise it stays held. Any other admission in a group that
gave the turn up (its held Run was cancelled, say) checks the same
(`enqueueWhenTurnFree`): it parks the Run (`output_json.waiting_for_turn`,
carrying its job), which does not hold the turn either and is admitted when
that turn completes (`admitTurnParkedRuns`, and on the minute pass). A person's message sent
directly, or released from the queue, while the discussion's latest wave waits
rather than being done stays outside the discussion (no new round, no change
of owner). The Agents addressed by a non-discussion turn while a discussion is
running — that person's turn, or a late delegation or research result — join
the discussion's held Agents (in a debate they are named as not admitted
instead); they are checked against the discussion owner's authority when it
next advances and run in its next wave if it has one, or are named in its cap
notice when it ends there, as an emergent discussion held at its first Agent
wave does. A refusal read through an unreadable probe keeps its effect:
only a readable reading can say the window is no longer full. A notice is posted once per window —
a `quota_hold` discussion notice, or, outside a discussion, a
`subscription_quota_hold` system notice — and the discussion stays `active`;
its detail's `quota_hold` drives the header's "waiting for the window (resets
HH:MM) · continue anyway". What admits a held Run: "continue anyway"
(`POST …/conversations/:id/quota/continue`, Project writer), which admits every
held Run of the conversation on a login that person may spend
(`mayContinueLogin`: its host's owner, or for the built-in host — which has no
owner — a Space owner or admin; whose subscription it is decides whether its
reserve is spent, so a Run on another member's login stays held) — now, or,
while a person's turn holds the conversation, once it is over
(`continued_by_user_id` on the marker) — and records
`quota_override_by_user_id`/`_at` on the discussions that had such a Run held,
so their later turns on that person's logins are not held again (the record
spares no other member's login); each hold says whether the viewer may
continue it (`can_continue`); the
`subscription_quota_hold_release` scheduler task each minute, over every held
Run a page at a time, which admits once the login is below the line or the
window's reset time has passed, and otherwise refreshes the marker (and says
so again) when the window holding it or its reset time changed; and a delegated
child's FIFO re-evaluating its head, which admits it the same way. Stopping a
discussion does not cancel a held wave, which runs after admission and then
closes it; the Agents it held are named in its "already ended" notice.
Stopping a discussion held at its cap ends it for good: the rounds on offer
are given up and a closing turn still waiting for the window is cancelled, so
no conclusion arrives hours later; a person who wants one asks for it.
Adding rounds to a discussion stopped at its cap, or opening a new one over
it, cancels a closing turn still held from that cap — the whole closing group
that has not started, a handoff turn before the Manager's included — (and frees
its Agents' host
thread), which would otherwise run first once the window resets. A delegation
result that meets a taken turn, a busy Agent or a transient database error is
retried by its job, never dropped. A person's own message is never held; past
`warn_pct` the composer shows the account's line (`GET …/quota`). Nothing
known about a login (no reading, an unreadable probe, a runtime without a
subscription, a Run bound to a ModelProvider) admits. A ModelProvider-bound Run
never spends a subscription: the binding excludes subscription providers
(`runs/remoteProviderBinding.ts`) and the provider proxy's lease needs an API
key, so such Runs are priced and bounded by the spend cap.

**Quota exhaustion is a cap**, never a silent end. A CLI Run whose error text
matches its runtime's `usage.quota_exhausted_patterns` (`RuntimeAdapterSpec`)
fails with `subscription_quota_exhausted` (`runs/retryPolicy.ts`,
`classifyRuntimeFailure`, applied in `remoteHostCliAdapter.ts`), which is never
retried; only the error the turn ended on (or, with none, the last lines of
stderr) is matched, never a notice logged earlier in the Run. A later refusal
on a login overrules an older reading (`refusedWindow` in
`rooms/subscriptionLogins.ts`): the gate reads that login's window as full
until the reading's reset time, or, when no reading says when, one 5-hour
window from the refusal — and not at all once a newer reading shows the window
below full. When a wave contains such a Run whose window has not reset since,
the discussion ends `cap_reached` with `stop_reason = 'quota_exhausted'`,
its "continue anyway" is cleared, the refused recipients are held beside the
Agents the wave's other replies addressed (so adding rounds sets them working
again), and the cap notice carries that window's `resets_at`; the Manager's closing turn then passes the gate like any
Agent-triggered turn, so it runs at once on another login and waits for the
window (or "continue anyway") on the exhausted one.

Residual: two Agents that keep politely addressing each other converge only at
the round cap; there is no earlier detector (deferred register). Residual:
`agent.wait_for_results` has no timeout of its own; a wait ends with the
child's Run timeout or orphan handling. Residual (quota): a gate probe is bounded to 5 s inside the
admission's transaction and the minute re-check to 30 s per login; a host that
is slow to answer is decided on the cached reading.

## API Surface

- `POST /api/v1/rooms` — create a Room (writer authority on the Project).
  `personal: true` opens, or reuses, the caller's personal Room in that Project
- `POST /api/v1/rooms/:roomId/conversations` — explicitly open a Conversation
  draft and its execution preflight; this is the only way to create a Room
  Conversation
- `POST /api/v1/rooms/:roomId/conversations/:sessionId/messages` — speak in an
  initialized Conversation; Host, CLI, Primary, and attachment scope are
  already pinned
- `POST /api/v1/rooms/:roomId/conversations/:sessionId/retry` — manually retry
  a failed or degraded turn using its persisted user input and pinned context
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
  explicit private Room-share confirmation and optional `restore_workspace`
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
  coordination, optional explicit per-recipient backend selection, and
  server-owned `input_parts` for images or authorized text-file snapshots
- `DELETE /api/v1/rooms/:roomId/conversations/:sessionId/queued-messages/:id` —
  take back one's own message still waiting for the turn, or dismiss one that
  could not be posted
- `POST /api/v1/rooms/:roomId/conversations/:sessionId/discussions` — open an
  explicit discussion (Project writer); `GET` lists the conversation's
  discussions, `GET …/discussions/:id` returns one with its waves, cost lines
  (`usage`) and `quota_hold`, `POST …/discussions/:id/stop` (any member) and
  `…/extend { rounds }` (Project writer)
- `GET /api/v1/rooms/:roomId/conversations/:sessionId/quota` — the Space's
  subscription lines, the windows of the logins the conversation's Agents run
  on (cached), and the Agent-triggered Runs held at the reserve line;
  `POST …/quota/continue` (Project writer) admits them now ("continue anyway")
- `POST /api/v1/sessions/:sessionId/execution-context/refresh-git` — explicitly
  advance the initialized Conversation's Git admission baseline (a send
  advances it itself when HEAD is where the Conversation's own last Run left
  it)
- `GET /api/v1/projects/:projectId/host-execution-targets` — the caller's
  online remote Hosts, this Project's Locations, and reported CLI
  adapter/installation choices for the host-bound Agent selector

## Invariants

- Room membership never widens Project authority.
- A Room message carrying an image or file reference validates every selected
  recipient's prompt capability before claiming the turn, inserting the
  message, or creating any recipient Run. One incompatible or unknown image
  target rejects the complete send; it never fans out a partial Room turn.
- Conversation input images are pending, Space-scoped media rows until the
  sender's message claims them in the same transaction. Current-file
  references are re-authorized through Project Folder reads and frozen as
  bounded message-owned resources, so later workspace changes do not rewrite
  transcript or retry input. The older `conversation_file_snapshots` shape is
  retained only for readable historical messages.
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

## What a person reads of a conversation

Every reader of `messages` that answers a person uses
`visibleRoomTranscriptSql` — the page, the pick-by-id surface, the recent
context window — and it is applied unconditionally rather than behind a flag:
`room_display = 'internal'` is written only by `addRoomInternalInstruction`, so
it is vacuous for an ordinary session, and a flag deciding whether to apply the
rule was a second copy of it. Agent replay and continuation lookups still read
the internal rows through `visibleMessagePathSql`, which is why they are stored
in order at all.

A domain-event continuation is the system talking to the Room's own Agents. It
is stored as a `user_instruction` so replay sees it in order, and carries
`room_display = internal` on its agent-group row as well, so the group timeline
does not show machine prose under the manager's name. The group such a
continuation opens is named after the event, not after the instruction text.

The group timeline is gated per message by the Run that produced it: a group is
reached through its root Run, and a child Run inside it can be private or belong
to a Room the viewer left.
