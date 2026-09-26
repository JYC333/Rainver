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
branch path can legitimately contain `%` and `_`. A recursive CTE was the first
implementation and cost O(conversation) buffers per page; the prefix match is
flat.

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

ACP tool lifecycles are correlated once at the adapter boundary by
`runtimeAdapters/acpToolCallLifecycle.ts`, shared by the thread and semantic
event normalizers. Every newly persisted tool event has a trace-local id, and
an update whose provider start was absent is preceded by an inferred start.
The projection retains read compatibility for older rows with missing starts
or null ids, but incomplete trace metadata is never presented as a tool
failure; only a provider-reported failed status is one.

### State is decided once, on the server

`turnReadModel.turnState` is the sole authority for which of D3's four states a
turn is in, and clients render `turn.state` without re-deriving it. That rule
exists because the derivation needs facts a client does not have:

- A `degraded` Run can still carry a complete reply — the status records a
  non-blocking warning — so it maps to `done`, not `failed`.
- A chat Run reaches `succeeded` several steps *before* its reply is written,
  so only the log's own `chat_completed` event may say a chat turn is done.
  Reporting `done` earlier sends a reader to fetch a reply that does not exist.
- `waiting_for_review` is `blocked`: stopped, waiting on a person, resuming
  where it left off once they decide. Not `working` (nothing is happening) and
  not `failed` (nothing went wrong).
- A turn that ended on the runtime's own question is `done`, not `blocked`
  (`modules/runtime-adapters.md`, interactive requests). The ACP controller cancels the vendor's
  interactive prompt, the Run succeeds with `output_json.asked_user`, and
  `chatTurnFinalizer` writes the question (options as a bullet list, after
  anything the Agent said first) as the reply with
  `metadata_json.awaiting_answer = true`. Nothing is held open: the answer is
  the person's next message, into the same vendor session, and a serialized
  chain or discussion proceeds as after any reply. The web shows "waiting for
  an answer" under such a reply (`AwaitingAnswerMarker`).

A client that re-derives state from the Run's status gets `degraded` wrong, and
that is not hypothetical — it happened during this work, on two surfaces.

### Reading a turn back

Two clients need a settled turn from a saved reply, and both go through
`modules/conversation/settledTurn.ts`:

- `settledTurn(turn, state, text)` (`apps/web/src/modules/conversation/`)
  replaces the streamed prose with what was
  actually saved and leaves the work above it. The caller passes the state,
  because only the caller knows what settled — a reply row is not proof a turn
  is over, since the server writes one at the pause too.
- `readBackTurnState(state)` settles a `working` turn read from history to
  `done`, since the message is written before `chat_completed` lands and a
  read is not a stream: nothing else would ever correct it.

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

## What each turn reads

A Room turn's reading model is bound to the action that created it, never to a
mode the conversation is switched into, and the server never infers it from
message text. A person chooses once — by addressing an Agent, or when opening
a discussion — and the Manager's own judgment decides whether to delegate.

- **A participant** — an Agent a person addressed, or one a discussion wave
  addressed — reads the **shared window**: on a fresh or reset vendor session
  the standing context, Project state, the rolling summary and the messages it
  does not cover; on a resumed session only the messages since its own last
  turn, plus the standing context when it changed (`modules/rooms.md`, "Host-bound
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
- **A handoff turn** reads only its own request; the session it resumes
  already holds the conversation.

## Rendering

`apps/web/src/modules/conversation/` owns shared conversation presentation.
`ConversationSurface` owns the durable transcript, composer and execution
preflight used by both the Room page and Project sidecar; those callers pass
Room audience, roster and routing context into it rather than owning another
conversation renderer.
`ConversationTurn` renders one Agent turn in whichever of its four states it
is in. `ConversationComposer` is the common input frame used by direct Agent
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

The execution context also stores the Primary Workspace Git baseline. Direct
Host sends and Room dispatch compare the current branch, commit, and readiness
to that baseline on the server before a send can commit its user message or
Run; a changed workspace returns a refresh-required conflict. The one
exception is a HEAD this Conversation's own Agent moved: the host reports the
branch and HEAD before and after every Run with its diff, the context keeps
the exit HEAD of the last writing Run that started from the accepted HEAD
(`last_run_git_branch/head`), and when the current branch and commit equal it
the send advances the baseline itself — clearing that record — and proceeds. The Run's immutable
contract records the Git snapshot observed at its start, and the Run's
`output_json.workspace_after` where it left the checkout. A user may refresh
the baseline explicitly, but conversation controls do not switch branches,
commit, push, or deploy.

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

`action_preview` parts are deliberately not rendered. Both surfaces show a
Proposal from the assistant message's own record instead, which is what
survives a reload and what carries live reconciliation against the Proposal's
real status.

## Dispatching to a paired machine

A remote Task run is admitted like a server one: one Run, created
synchronously, carrying the thread, the adapter, the installation and the
vendor session to resume in `model_override_json.host_thread`. There is no
message queue — see `modules/hosts.md` for why the one that existed was
removed with the page it served.
