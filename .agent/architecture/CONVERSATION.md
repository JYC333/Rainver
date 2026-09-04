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
generic options in the same bottom row. `ConversationView` supplies the generic
message list used by direct and notebook chat; Room keeps its audience,
reference, routing, and proposal-aware transcript while reusing
`ConversationTurn` and `ConversationComposer`.

The four states are one bubble, not four components. Within the bubble, parts
remain in protocol order; the renderer does not regroup all work ahead of all
assistant messages:

- **working** — the steps as they happen, text streaming under them.
- **blocked** — stopped, waiting on the person, said plainly and with somewhere
  to go and act.
- **done** — the reply is the bubble; the work folds into one line above it.
- **failed** — the same bubble carries the failure, and the steps stay open,
  because when something went wrong the steps are what explains it.

Nothing about a Run appears under the person's message. Run links are not part
of the shared conversation rendering.

An initialized Conversation restores execution from its persisted
Conversation × Agent binding and Host thread. The current runtime-profile
catalog remains the chooser for a new Conversation, not the authority for
whether an existing pin survived a server or daemon restart. Current Host
heartbeat, installation and workspace readiness are still checked before a
send.

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
