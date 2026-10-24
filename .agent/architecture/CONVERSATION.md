# Conversation

How a conversation is stored, how an Agent's turn is read back out of it, and
which component owns each of those.

## The message tree

`messages` is a tree, not a list. Every message carries `parent_message_id`,
and `sessions.head_message_id` names the leaf the conversation currently ends
at. A linear conversation is the degenerate case: each message's parent is the
one before it, and the head is the last.

The tree exists so a message can be edited, resent or regenerated without
destroying what came before — those actions are a later plan, but the fields
they need are here, because retrofitting a parent pointer onto a conversation
that already has history is the migration nobody wants to run.

Reading the visible path is the operation that has to be cheap, since every
page of every conversation performs it. Two materialized columns make it a
prefix match rather than a walk:

- `path_depth` — how deep this message sits.
- `branch_path` — the path from the root, as a sortable string.

`visibleMessagePathSql` (`modules/sessions/messagePath.ts`) is the one place
that knows their encoding. It uses `starts_with` rather than `LIKE`, because a
branch path can legitimately contain `%` and `_`. The prefix match is flat.
Do not walk the conversation with a recursive query on each page.

`uq_messages_branch_position` keeps two concurrent appends from claiming the
same position. `lockConversationForAppend` takes the conversation's lock as its
own statement before the insert, and `withBranchPositionRetry` retries with
jittered backoff — both because in READ COMMITTED a statement's snapshot is
taken *before* it waits on a lock, so the loser of a race would otherwise
compute its position from a view of the tree that is already stale.

`messages.run_id` links an assistant message to the Run that produced it. It is
a real column with a partial unique index (`uq_messages_assistant_run`), so an
assistant message is 1:1 with its Run. `metadata_json.run_ids` is the separate
Room fan-out case, written only onto the dispatching message — a person's
message, or the system row a continuation writes — when one send addressed
several Agents.

## Explicit Skill inputs

Both direct and Room composers support `/` and `@` Skill selection. The typed
input part stores `skill_package_id`, `package_hash` and an authoritative
display name, with four distinct Skills per message. It is saved in
`message_input_parts`. Selecting a Skill inserts `/display_name` at the current
input position in both composers, rather than adding a separate attachment row.
The Room composer holds it as an inline atom like an `@Agent` mention; the
direct composer highlights it behind its textarea, and Backspace/Delete beside
it removes the whole reference.
Editing away that reference removes its typed selection; typing the name alone
does not select or authorize a package. Restored older drafts append their
previously separate selections to the text. Message history keeps the inline
position, while older messages without inline references retain visible chips.
A Skill-only turn is
valid, including a Room segment that is only its `@Agent` address. Every
recipient of the effective route — the addressed Agents, or the manager when
the message is handed to it to arrange — is checked against the effective
package binding before send.
Retries reuse the original message selections and revalidate current authority.

Browser drafts persist only opaque references; asynchronous attachment
validation restores each untouched field without replacing new text or Skill
selections. Runtime Context renders the canonical selection descriptors and
separately authorizes original file delivery; files are not hydrated as normal
image/file attachments or injected from client text.

## The turn projection

A Run's work is recorded in one of two logs: `run_events` for a managed Run,
`host_thread_events` for one that executed on a paired machine. Which of those
a turn lives in is a fact about the backend, not about the conversation, so no
client is told.

`modules/runs/turnProjection.ts` folds either log into one ordered
`TurnPart[]` — `text`, `reasoning`, `tool_call`, `plan`, `diagnostic`,
`action_preview` — and `turnReadModel.ts` assembles a `RunTurn` from it. The
host fold follows Zed's ACP thread semantics: message and thought entries keep
protocol order, while `tool_call` and every later `tool_call_update` upsert one
entry by `tool_call_id`. Pending, running and terminal updates therefore never
become separate rows. One pure fold, two sources.

A notice the server itself raises reaches a turn as a code, not prose: the
host `status: run_quiet` silence notice becomes an `info` diagnostic with
`error_code: "run_quiet"` (an English `text` fallback for other clients), and
`ConversationTurn` words a known code through i18n
(`conversation_ui.turn.run_quiet`) in the reader's language. Any other
diagnostic is the runtime's own text and renders verbatim.

ACP tool lifecycles are correlated once at the adapter boundary by
`runtimeAdapters/acpToolCallLifecycle.ts`, shared by the thread and semantic
event normalizers. Every newly persisted tool event has a trace-local id, and
an update whose provider start was absent is preceded by an inferred start.
The projection retains read compatibility for older rows with missing starts
or null ids, but incomplete trace metadata is never presented as a tool
failure; only a provider-reported failed status is one.

Tool output is displayed separately from the provider-reported failure status;
ordinary output and warnings do not become error messages just because a call
failed. A command with a reported nonzero exit has a neutral "Command returned"
summary; its exit code and explanation are available in the expanded details,
since the code alone does not establish a failed turn. Tool failures without
a reported process exit code retain their error indicator.
Host command summaries preserve a reported numeric exit code outside
the bounded output text. New output summaries retain up to 4,000 characters,
keeping the beginning and end with an explicit omitted-middle marker. Input
and output summaries pass the canonical `redactSecretPatterns`
(`runs/evidenceRedaction.ts`) before they are bounded and persisted. Command
summaries carry a truncation flag; the browser also labels older summaries
ending in an ellipsis as incomplete, without inventing lost output or exit codes.
An empty command result is described as no reported output, not as the reason
for failure. Existing stored command JSON summaries are rendered as readable
output and exit metadata rather than as an error JSON blob.

### State is decided once, on the server

`turnReadModel.turnState` is the sole authority for which of the four states a
turn is in, and clients render `turn.state` without re-deriving it. The
derivation needs facts a client does not have:

- A `degraded` Run can still carry a complete reply — the status records a
  non-blocking warning — so it maps to `done`, not `failed`.
- A chat Run reaches `succeeded` several steps *before* its reply is written,
  so only the log's own `chat_completed` event may say a chat turn is done.
  Reporting `done` earlier sends a reader to fetch a reply that does not exist.
  The same successful/degraded chat also retains the conversation turn until
  that marker, so a new human message or queue release cannot insert its
  trigger before the earlier reply and continuity are published. Existing
  same-group recipient/handoff progression keeps its lifecycle-owned admission;
  failed, cancelled and orphaned Runs still release the turn without requiring
  a marker that recovery may never have written. A finalization that keeps
  failing is retried a bounded number of times, then completed as `failed`
  with its error, so it cannot hold the conversation for good.
- `waiting_for_review` is `blocked`: stopped, waiting on a person, resuming
  where it left off once they decide. Not `working` (nothing is happening) and
  not `failed` (nothing went wrong).
- A queued `waiting_for_quota` hold is also `blocked`, with `blocked_on = quota`.
  Execution-time recovery has persistent automatic/pause controls in the
  transcript, fixed activity bar and Run detail. It leaves the conversation
  turn free for new messages; a new user message pauses the old automatic
  continuation until explicitly renewed. See the recovery contract in
  [Runs and outputs](RUNS_AND_OUTPUTS.md#attempts-cancellation-and-supervision).
- A turn that ended on the runtime's own question is `done`, not `blocked`
  (`modules/runtime-adapters.md`, interactive requests). The ACP controller cancels the vendor's
  interactive prompt, the Run succeeds with `output_json.asked_user`, and
  `chatTurnFinalizer` writes the question (options as a bullet list, after
  anything the Agent said first) as the reply with
  `metadata_json.awaiting_answer = true`. Nothing is held open: the answer is
  the person's next message, into the same vendor session, and a serialized
  chain or discussion proceeds as after any reply. The web shows "waiting for
  an answer" under such a reply (`AwaitingAnswerMarker`).

A client that re-derives state from the Run's status gets `degraded` wrong.
Do not re-derive `turn.state` on the client.

### Reading a turn back

Two clients need a settled turn from a saved reply, and both go through
`modules/conversation/settledTurn.ts`:

- `settledTurn(turn, state, text)` (`apps/web/src/modules/conversation/`)
  uses the saved prose as authority. A complete Host trace whose concatenated
  text matches that message retains its text/tool boundaries; a partial trace,
  changed finalizer reply or managed turn falls back to the saved text. The caller passes the state,
  because only the caller knows what settled — a reply row is not proof a turn
  is over, since the server writes one at the pause too.
  Completed turns fold earlier prose followed by tools or plans into the existing
  work disclosure. The last prose block always stays visible, including when no
  closing reply followed the work. Active, failed and blocked turns keep progress
  visible. This presentation never infers message boundaries from sentence text,
  exposes reasoning, or changes the durable assistant message.
- `readBackTurnState(state, blockedOn)` settles a `working` turn read from
  history to `done`, since the message is written before `chat_completed` lands
  and a read is not a stream: nothing else would ever correct it. A `blocked`
  turn with `blocked_on === 'workspace'` (queued behind another writer of the
  directory) also reads back as `done`; any other `blocked` is kept.

## The turn stream

`modules/streaming/turnStream.ts` serves one snapshot followed by a frame per
change: `turn.part_appended`, `turn.part_updated`, `turn.state_changed`.

Text arrives two ways. A managed Run streams prose as deltas that are never
persisted, folded here into a trailing `text` part at `STREAMED_TEXT_INDEX`
(past any index the projection can produce) and republished as updates; a host
Run persists its text, so the same part arrives through the poll. Either way
the client sees one growing `text` part, and is told explicitly when to drop
the streamed copy.

`turnDiffFrames` is pure and separately testable, because this is where a
client's view can be corrupted and the failure mode is a frame sequence rather
than a network condition. A part that changed *type* at its index means the
list was reindexed rather than extended, and the whole snapshot is re-sent —
smaller to reason about than asking a client to reconstruct an order it cannot
see.

The stream sends the settled state before it closes. A `blocked` turn is the
deliberate exception: the server holds that stream open, because the turn
resumes where it stopped once somebody decides, so it waits at human pace and
an idle timeout on that connection is the ordinary ending rather than a fault.
A client that treats a blocked ending as an error drops the one turn carrying
the approval link.

The server writes an SSE keepalive comment on every turn poll, even when no
part or state changed, so long commands and approval waits do not leave the
response idle. Comments do not change the turn cursor or create transcript parts.

## What each turn reads

A Room turn's reading model is bound to the action that created it, never to a
mode the conversation is switched into, and the server never infers it from
message text. A person chooses once — by addressing an Agent, or when opening
a discussion — and the Manager's own judgment decides whether to delegate.

- **A participant** — an Agent a person addressed, or one a discussion wave
  addressed — reads the **shared window**: on a fresh or reset vendor session
  the standing context, Project state and the conversation title, with no
  transcript (history is read on demand with `conversation.search` /
  `conversation.read`); on a resumed session only the messages since its own
  last turn, plus the standing context when it changed (`modules/rooms.md`, "Host-bound
  specialists and direct chat"). A recipient serialized behind others also gets the
  replies already given to the same message, each with its `[Changes]` block.
- **A debate** starts independent: in its first round that "replies already
  given" block is withheld, and from the next round every participant is
  handed every answer of the round before to critique. The Manager's closing
  turn is the judge.
- **A delegated specialist** reads the **distilled view**: its standing
  context (when its session does not already hold it), a handoff when its
  session was just renewed, and the Manager's instruction — no conversation
  window. What it changed comes back to the Manager as a `[Changes]` block in
  the delegation result.
- **A summary turn** (the person asked the Agent to summarize the
  conversation) reads only its own request; the session it resumes
  already holds the conversation.

## Rendering

`apps/web/src/modules/conversation/` owns shared conversation presentation.
`ConversationSurface` owns the durable transcript, composer and execution
preflight used by both the Room page and Project sidecar; those callers pass
Room audience and roster into it rather than owning another conversation
renderer. Where a Room message goes is decided in the shared Room composer
(`RoomMessageComposer`), so both callers show the same route line; see
`modules/rooms.md`, "Addressing and routing a message".
`ConversationTurn` renders one Agent turn in whichever of its four states it
is in. Shared `MessageResponse` constrains Markdown to its available width and
allows long words, URLs and inline code to wrap, including inside indented
progress text and narrow embedded panels. Wide fenced code and tables keep
their own scrolling; transcript containers must not hide horizontal overflow
to compensate for prose that cannot wrap.
`index.css` scans the installed Streamdown `dist/*.js` with Tailwind's
`@source`, so list indentation and code/table scrolling utilities are generated
from the renderer itself rather than incidentally from other app components.
The Room page uses an explicit `minmax(0, 1fr)` single grid column below `lg`;
an implicit `auto` column lets unbroken navigation labels widen the entire
conversation even when individual Markdown elements fit their bubble.
`pnpm run test:layout` in `apps/web` checks the built Room and Agent Work routes
in Chromium, including clipping ancestors that root `scrollWidth` cannot reveal.
Room and Project surfaces keep a compact `ConversationActivity` strip
outside the scrolling transcript, above the composer, so later specialist replies
cannot push unfinished work out of view. It names queued, working, cancelling and
blocked Agents using the existing Run/Turn facts; it adds no polling or execution
state. Successful settled delegated reply bodies default to a native disclosure;
failures, blocked/live turns, questions and action cards remain visible. Ordinary
participant replies and discussion replies are not folded merely by author.
`ConversationComposer` is the common input frame used by direct Agent
chat, the Room page, and the Project sidecar; it owns runtime-control layout,
focus treatment, and submission. Room injects its mention-capable editor while
direct chat injects plain text. Both render the selected ACP installation's
generic options through `ConversationAgentSessionConfigs`: one Agent keeps the
fast inline controls, while two or more Agents share one **Agent settings**
trigger whose dialog labels one option row per Agent. `ConversationView`
supplies the generic
message list used by direct and notebook chat; Room keeps its audience,
reference, routing, and proposal-aware transcript while reusing
`ConversationTurn` and `ConversationComposer`. Proposal cards, status
reconciliation and action-preview filtering have one implementation in
`ActionPreviewCard`; Room and Project sidecar offer inline decisions, while
direct Agent chat links to Proposal review.

The four states are one bubble, not four components. The conversation
projection preserves assistant text in protocol order but deliberately omits
reasoning parts and successful tool calls. Those records remain available in
the durable Run audit; they are execution evidence, not conversation content.
Active or failed calls, plans and diagnostics remain visible when they explain
what is happening or what went wrong:

- **working** — active and failed steps as they happen, text streaming under
  them; completed calls and reasoning do not produce conversation rows.
- **blocked** — stopped, waiting on the person, said plainly and with somewhere
  to go and act.
- **done** — the reply is the bubble; any remaining non-sensitive plan or
  diagnostic work folds into one line above it.
- **failed** — the same bubble carries the failure; failed calls and diagnostics
  stay open as the explanation, while successful calls remain hidden.

Completed action previews attached to older or newer assistant messages are
also hidden from the conversation. They are execution records without a
decision to make; proposed and decided Proposal cards, and failed action cards,
remain visible through the shared viewer filter used by Room and direct chat.
Nothing about a Run appears under the person's message. Run links are not part
of the shared conversation rendering.

An initialized Conversation restores execution from its persisted
Conversation × Agent binding and Host thread. The current runtime-profile
catalog remains the chooser for a new Conversation, not the authority for
whether an existing pin survived a server or daemon restart. Current Host
heartbeat, installation and workspace readiness are still checked before a
send. A native copy with no signed-in account remains usable when its ACP
`session/new` probe succeeded. Newly discovered choices and persisted runtime
profiles use the same installation gate; an unavailable ACP session does not
turn a signed-out copy into a selectable runtime.

The execution context records the Primary Workspace's Git branch, commit,
and readiness as observed at initialization, for display and audit only. No
send compares the current checkout to it: the vendor CLI works in the
directory and reads its Git state itself when it needs to. The Run's immutable
contract records the Git snapshot observed at its start, and the Run's
`output_json.workspace_after` where it left the checkout. Conversation
controls do not switch branches, commit, push, or deploy.

Conversation turns expose shared Run controls: active Runs can be stopped via
the canonical Run API and finish visibly as cancelled with partial output;
terminal Host Runs look up their exact `remote_diff` Artifact, including
managed workspaces. Another Agent sees that change only as a `[Changes]`
block (files, `+added -removed`, and a `rainver://artifacts/<id>` link it can
read with `input_resource.read`) appended to a delegation result or to the
replies a serialized recipient is given; the patch itself is never inlined
(`modules/rooms.md`). A turn still working is headed by the Agent's name the
way its finished reply is. When one message starts several serialized Runs,
each Agent gets one named turn in the timeline: the first can work while later
recipients say "Waiting for previous Agent" rather than three simultaneous
"Working" labels. Stop, Retry and change controls stay with that Agent's turn
or reply, never duplicated beneath the person's message. Names come from each
Run's `agent_id` resolved against the roster. Failed turns can be retried with an idempotency key using
the original persisted input and execution pin; the retry links new Run ids to
the original user message rather than adding a duplicate message. The prior
failed Agent reply remains as audit evidence but is marked `retry_superseded`
and leaves the shared visible-transcript predicate, so Room history, summaries
and later prompt tails do not keep showing or replaying an error the person has
already retried. The dispatching message similarly records
`retry_superseded_run_ids`, replacing its old Run controls with the new ones. Draft
recovery stores only validated text and logical input references in a
destination-scoped, seven-day sessionStorage record.

A Room discussion stays in the one chronological timeline. Messages carrying
its `discussion_id` — plus a notice's own reference and an emergent discussion's
`origin_message_id` — form consecutive **segments** with a thin left rail and
a lightweight topic/round/status label (`modules/conversation/DiscussionGroup.tsx`).
An ordinary interjection breaks the rail; a later segment says "Discussion
continues" where it occurs. No reply moves to a separate transcript or folds
automatically when the discussion ends. The newest segment alone carries
Stop while `active` and extend while `cap_reached` — "Add N rounds" with N the
shape's default cap, or "Open a discussion" for an emergent row. Its header
can also show participants, cost, quota hold and the conclusion excerpt. The
list (`GET …/discussions`) is read with the message poll, and only while a
referenced discussion is unknown, running, or has a message newer than the
record held (a closing reply, a wave after another member added rounds); a
read never overwrites a newer record from a stop or extend. Messages are
merged by id, so a message the server revises after sending it — its
discussion stamp, a delegated child listed on it — is picked up in place. A
discussion's consecutive messages form one marked segment; when other
messages intervene, the later stretch is marked again where it happened. While a discussion is active, the shared Room/Project composer offers
"Current discussion" or "Ordinary message". The former sends the exact
`discussion_id`; the latter omits it. The server stores that choice through
the queue and stamps only an explicitly joined message, so release timing
cannot silently switch its destination. An ordinary message's Agent reply
and controls stay in the main timeline at full available width; pending
serialized recipients say they are waiting, not all "Working" at once.

A `system_notice` carrying `discussion_notice` renders as a
card: `cap_reached` offers the extend action while the discussion is still
held there and something waits to continue (Agents held at the cap, or a
debate's next round) — and a discussion held at its cap can be stopped for
good — `not_admitted` names the Agents and the reason with no action,
and `failed` says the discussion ended because it could not continue. A
`cap_reached` card is titled by the cap its reason names — "Round cap reached",
"Spend cap reached", "Turn budget reached" (`fanout_budget`), "Subscription
limit reached" (`quota_exhausted`) — and shows the notice message's own text,
since its reason is a code; so does a `quota_hold` ("Waiting for the
subscription window"). The header's status names the cap from the
discussion's `stop_reason` the same way. Under the header, the discussion's detail
(`GET …/discussions/:id`, read only when a shown discussion's record changes —
once per wave) adds one cost line per funding source: "Priced models · $x of
$cap", and per CLI login its tokens here and the account's window, marked past
the Space's warning line; while Agent-triggered turns are held at the reserve
line it adds "Waiting for the window (resets HH:MM) · continue anyway". Above
the composer `ConversationQuotaLine` shows any login of the conversation past
the warning line and any held turns with the same "continue anyway"
(`GET …/quota`, re-read as the transcript grows and when a shown discussion's
record changes; `POST …/quota/continue`). The detail's `waves[].run_ids` is
also the authoritative live index for Runs started by hidden continuation
messages: the client loads and streams those Runs immediately, so later rounds
show which Agent is working before any reply becomes a visible message.
"Continue anyway" is offered only to a Project writer (`viewer_can_write`),
and only on a hold whose login the viewer may spend (`can_continue`); a hold on
someone else's login reads "Waiting for <account>'s window" with no action.
The full Room variant has an "Open a discussion"
dialog beside the composer (topic, participants or "All Agents", shape, round
cap defaulting by shape, optional spend cap), refusing more than
`ROOM_DISCUSSION_MAX_PARTICIPANTS` client-side; its returned message lands as
a send's does. A live turn explicitly listed in `delegated_run_ids` on the
nearest message a person can see (the dispatching message, or for a
continuation the discussion's origin or the container's message), apart from
the recipients' `run_ids`, and never offered a Retry, reads "delegated by
<Agent>" beside its name; the parent Run's Agent is resolved the same way as
the name (the Room's Manager until that Run is read). A recipient Run's
technical `parent_run_id`, used to serialize a fan-out group in one workspace,
does not by itself mean delegation and never produces that label.

A message sent while a turn is running is not refused: the composer sends it
with `queue: true` (unless it has attachments), and a 202 shows it at the end
of the transcript as "will be sent when the current turn ends" with Cancel for
its sender; the poll replaces that list with what still waits, and the
message appears in place once the server posts it at the turn boundary
(`modules/rooms.md`). One the server could not post stays there with "could
not be sent" and the reason, and Dismiss for its sender.

Direct Agent chat permits preparing the next message's text and attachments
while the accepted turn runs, but does not submit a second active turn. The
server's acceptance consumes only the submitted draft: text edited since the
send, subsequently added attachments and uploads still in progress remain.
New drafts continue to persist during the response, including when the first
acceptance binds the draft to its new Session. Completion, quota waiting and
stream failure do not clear that next draft. Restoring validated attachments
does not issue the shared composer's full reset, which would erase them again.
Slow attachment validation restores only fields that have not been edited
meanwhile, and persists the resulting draft without overwriting those edits.
Both surfaces share this through `conversation/useConversationDraft`: the
stored draft and the per-field edit versions it is compared against are
captured once per destination, a new request lifetime only re-validates, and
parent re-renders (such as a freshly derived Folder source list) do not
restart validation.

Neither surface currently injects a message into an executing vendor turn.
The pinned Claude and Codex ACP adapters support a steering extension, but
Rainver's input, Run and controller lifecycle does not expose it and no
configuration switch enables it. The fixed-version behavior and ended-turn
differences are recorded in [runtime adapters](../modules/runtime-adapters.md).

`action_preview` parts are deliberately not rendered. Both surfaces show a
Proposal from the assistant message's own record instead, which is what
survives a reload and what carries live reconciliation against the Proposal's
real status.

## Dispatching to a paired machine

A remote Task run is admitted like a server one: one Run, created
synchronously, carrying the thread, the adapter, the installation and the
vendor session to resume in `model_override_json.host_thread`. There is no
message queue. Do not add one for a remote Task run.

## Explicit source Space and reusable Run commands

`ConversationSurface` and `ConversationExecutionPreflight` accept an optional
`spaceId`. The Room page supplies its Room's Space, the Project sidecar supplies
its route Space, and direct `ChatPanel` binds to `agent.space_id`.
`ConversationScope` carries that source Space and the panel's abort signal through
message paging, discussions/quota, Run reads/turn streams, backend catalogs,
preflight, file/image input, knowledge retrieval and live Proposal decisions.
`ConversationLink` resolves logical links in that source Space without changing
URL active Space or the global API context. Existing callers without an explicit
source keep the API's active-Space default.

Changing an existing destination remounts the request lifetime and aborts its reads, streams
and pending commands. Late message pages and accepted Proposal callbacks cannot
update the previous destination's parent. Binding an uninitialized Room draft to its first Session preserves its typed
text and picked references. Direct chat preserves its live stream
when its own accepted send supplies a new Session id; selecting another Session,
Agent or Space creates a new lifetime. Drafts retain the existing store and destination keys (globally unique Room,
Agent and Session identities), so previously unsent text remains recoverable.

`runs/useRunActions` is shared by RunDetailPage and ConversationRunControls for
review resume/abandon and authorization decisions; only ConversationRunControls
exposes the shared stop command. RunDetailPage keeps its existing action entries. A command targets one
explicit Run. Authorization approval/rejection uses its owning endpoint and never
also calls resume; Proposal decisions still use the Proposal endpoint and the
existing Room/direct continuation path. Commands reread the canonical Run before
notifying their consumer, never synthesize Task completion. The existing Run
status polling, cancellation polling, Room message refresh and Turn streams remain
the only corresponding update paths; no second sender or execution watcher was
added. Reading a missing execution context does not provision a conversation;
preflight initialization remains an explicit user action.

RoomMessageComposer and ConversationInputComposer both pass the source scope to
session file search and Folder tree/location/snapshot reads. Search cancellation
and panel cancellation combine through `lib/mergeAbortSignals.ts`, which uses
AbortController listeners rather than AbortSignal.any. Direct chat consumes its
self-accepted Session once; an external selection starts a new request lifetime,
including when returning to that earlier Session.

Settled/finished Room streams and completed Run commands abort their own request
controller, releasing composed listeners without aborting the panel lifetime.
ChatPanel keeps the requested and self-accepted Session in one state transition;
StrictMode replay preserves a self-accepted stream while external selection still
replaces its lifetime.

Agent Work (`modules/agent_work/`) embeds these same Room and direct surfaces.
Every mount of either surface, on any page, reports the message ids it rendered,
with a fingerprint of each shown body so a reply updated in place is reported
again, through `useAttentionViewing` to the Shell's attention provider, which records
the personal reads server-side; the optional onMessagesDisplayed callback
additionally tells Agent Work what this open showed, and initial read failures
call onReadError instead. These are display evidence for personal reading
decisions, not another fetch or send path. Room Surface's
readOnly mode keeps its authorized transcript and existing update mechanisms,
hides the composer and omits Proposal/discussion mutation callbacks. Nested
ConversationScope lifetimes preserve the workbench's action user/membership hints;
ConversationRunControls uses them to hide ineligible commands while owning APIs
remain authoritative. Existing page callers keep their prior defaults.

Room retry callbacks are omitted only for an explicitly `readOnly` surface or a
delegated Run, independently of Run owner/instructor standing. Existing Room page
and sidecar callers do not acquire a new `viewer_can_write` gate. Agent Work
chooses `readOnly={!room.viewer_can_write}` for its own embedded transcript, so
its reader mode still has no retry. The server retry service requires a visible
Room, conversation and Run with its original visible user input; the boolean in
`requireRoom(..., true)` requests a row lock, not write authorization. Workbench
Run controls share protocol approval ceilings with server policy, explain insufficient
or missing risk authority, and reserve standing reasons for active Runs. All
command eligibility remains advisory to the server's owning authorizer.

`ConversationSurface` and direct `ChatPanel` report displayed message ids with
their source Space/Session through optional `useAttentionViewing`. The Shell
provider records personal reads through the existing view endpoint; an open
conversation does not suppress new-revision alerts. It is inert outside
AgentAttentionProvider. Display evidence and reading revisions
are described in [Agent Attention](../modules/agent-attention.md#web-workbench).

Sent-message attachments use separate image and file rows in
`ConversationInputPartsView`: image thumbnails wrap together; file references
and immutable current-file resources each occupy a compact row below the
images, without stretching to thumbnail height.


Execution preflight surfaces each Agent's estimated prompt-cache expiry outside
its collapsed details. It uses the runtime-declared TTL and last completed Run,
without a token-count threshold or a universal one-hour assumption; unknown TTLs
do not claim expiry. The existing visible-page 30s refresh advances the notice.
The explicit, confirmed fresh-native-session action passes the current
Conversation id to `/rooms/:roomId/agents/:agentId/reset-context` as `session_id`.
It clears that Agent's native continuity and handoff, not chat history or other
Agents/Conversations. The server retains Project writer/Room member/host-owner
and dispatch-lock checks. Omitting `session_id` preserves the older roster
latest-Conversation action. Reset threads report no last-Run timestamp for cache
expiry until the new native session runs again.

Cache expiry notices are aggregated into one collapsed count summary. The
explicit Agent-specific reset choices are revealed on expansion in a bounded
scroll area. No notice wrapper is mounted when no runtime is expired, keeping
the configured execution row at its compact height.
