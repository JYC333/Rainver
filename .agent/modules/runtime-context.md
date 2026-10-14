# Module: Runtime Context

Runtime Context is the single authority that turns a physical model invocation
into an authorized, budgeted, immutable Delivery. Managed adapters, direct Chat,
Room turns, and local CLI adapters all enter through
`RuntimeContextInvocationGateway`; they do not assemble context themselves.

## Ownership

`server/src/modules/runtimeContext/` owns:

- typed acquisition from the Run, execution-control snapshot, Work Context,
  canonical messages, checkpoints, and Retrieval authority;
- deterministic normalization, precedence, deduplication, budget planning, and
  managed/CLI rendering;
- immutable Invocation Delivery and safe Invocation Snapshot lifecycle;
- scope-sequenced Context Events, gap reconciliation, Micro Checkpoints,
  Semantic Checkpoints, corrections, and CLI cursor continuity.

Canonical bodies remain in their owning domains. Runtime Context persists refs,
delivery evidence, safe projections, and continuity state; it is not a second
Memory, Message, Project, Policy, or Retrieval store. Retrieval authorization
stamps each item's `owner_user_id` and visibility from the canonical source so
`context_taint_json` can require contributing-owner egress review.

## Invocation contract

For each physical provider or CLI call orchestration supplies an invocation id,
the instructing user and Space, a `TurnContextRequest`, the immutable
execution-control snapshot id, adapter/provider/model identity, and a unique
Usage source id. `prepareInvocation()` reacquires and reauthorizes live inputs,
plans a `RuntimeContextEnvelope`, authorizes it against the control snapshot,
and persists one accepted `InvocationDelivery` plus its safe snapshot draft.

The adapter may only render the accepted Delivery. It cannot fetch additional
context, reorder items, change precedence, rebudget, or reuse a Delivery for a
different physical call. It acknowledges delivery and finalizes the invocation;
tool loops prepare a new Delivery for every physical provider request.

An explicit native ACP model selection is read from the Run's session config
before planning and recorded on the Delivery. ACP config options do not report
model context limits, so every runtime-native ACP session uses a null window
(`acp-runtime-managed.v1`) instead of a guessed 16K limit or per-model Rainver
exceptions. Required and pinned content remains intact; optional ranked content
has a separate 16,384-byte-estimate budget. A ranked item that does not fit is
cut to the remaining budget: conversation continuity keeps its end (the turns
just before the current message), anything else its beginning, and at equal
rank continuity is placed before a retrieved hit. The CLI enforces its actual model
limit and any rejection is surfaced as a runtime error. A Profile bound to a
Rainver ModelProvider uses the shared model catalog and its numeric window
plan, including the conservative unknown-model fallback.

The Delivery renderer keeps delegated instructions and reference data before
user input, and places the current message last even when a Room recipient
instruction is another `user_input` item. The ACP adapter preserves that
Gateway-owned order.

For an ordinary `chat_turn.v1` Run, the current input is the canonical user
message. Acquisition includes that message's text and immutable
`input_resource` descriptors in Delivery; conversation continuity excludes
the same current message. At ACP dispatch, conversation-input hydration adds
images and resource links, but does not add a second descriptor text block when
Delivery already contains it. The adapter sends Delivery instead of the raw
Run prompt. A session handoff uses its own Run request as current input and
does not hydrate the pending user's message attachments.

## Continuity

Conversation and task continuity is an ordered ledger of canonical refs, not a
route-owned prompt cache. Runtime events are append-only per typed work scope.
Terminal events create deterministic Micro Checkpoints; bounded semantic
extraction may publish a validated Semantic Checkpoint only after rechecking the
selected head and every canonical ref. Immutable corrections supersede invalid
semantic state without rewriting history. CLI bindings keep an acknowledged
cursor and rotate fail closed when scope, generation, session state, or replay
authority is invalid.

A Run executes on a CLI binding under its execution lease. The lease names its
holder Run and a fencing generation that every acquisition raises and every
rotation carries over. It lasts five minutes without renewal; the holder renews
it once a minute while it runs. A lease whose holder Run is no longer live is
free at once, and the same Run's next attempt is not held off by its own dead
attempt. A Run waiting for another holder waits at most ten minutes, and stops
waiting when it is itself no longer live; either way it fails with the
retryable `cli_execution_lease_unavailable`. A Delivery carries the fencing
generation it was planned under, and acknowledgements and vendor-session
records are refused once another Run has taken the lease over. An overflow
reconstruction moves the lease onto the replacement binding. A missing vendor
state rotates once per lease: asking again answers with the binding the lease
already holds.

## Knowledge retrieval switch

Whether a conversation searches the knowledge base on its own is the person's
choice. A direct chat or Room recipient retrieves only when its Work Context
Setup's `retrieval_preferences.enabled` is true, so a new conversation starts
with retrieval off. Root tasks and workflows keep retrieving unless their setup
turns it off. `GET`/`PUT /api/v1/runtime-context/work-contexts/:scopeId/retrieval`
read and set the switch and its `preferred_domains` as the next Setup version
for that person and scope: a direct chat's scope is its session, so the choice
holds for that conversation; a Room recipient's scope is its
`room_agent_members` row, so the choice holds for that Agent across the
person's conversations in the Room. The direct-chat composer shows one switch;
the Room composer shows one per Agent the next message reaches (the manager
when nobody is named). Governing policy can still forbid retrieval.
The switch also withholds the managed retrieval tools from a Run planned under
an off setup, and narrows them to the chosen domains under an on one
(knowledge, memory, projects → Project summaries, sources; inquiry has no
tool of its own; no choice keeps every tool) — `runRetrievalChoice` reads both
from the Run's frozen setup. It never affects material the person attaches or pins: explicit
references and `input_resource` descriptors reach the turn either way.

## Security boundaries

- All acquisition is Space- and instructing-user-scoped and revalidated in the
  Delivery transaction.
- A Room Proposal continuation may use its server-created hidden `system`
  message as the current turn only when the message is in the same Room
  conversation, carries the internal-continuation markers, names the same
  requesting user, and that user is still an active Room member. It is
  delivered as `system_approved` input and is never treated as a visible human
  message.
- Policy, credential, external-egress, tool, and budget decisions come from the
  immutable execution-control snapshot; Runtime Context does not reinterpret
  those authorities.
- Sealed replay payloads are separately encrypted and separately authorized;
  normal Run and trace reads expose only safe Invocation Snapshot projections.
- Adapters receive no provider secrets through context and no raw replay body
  through normal delivery reads.
- Delivery is passed directly at the invocation boundary and is never written
  to `CLAUDE.md`, `AGENTS.md`, Cursor rules, or another vendor context file.
  There is no compatibility alias or dual write/read path. ADR 0014 records
  the decision.
