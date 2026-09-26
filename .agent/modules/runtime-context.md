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
has a separate 16,384-byte-estimate budget. The CLI enforces its actual model
limit and any rejection is surfaced as a runtime error. A Profile bound to a
Rainver ModelProvider still uses the shared model catalog and its numeric window
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

## Retired architecture

The old Context Compiler/Builder/Prepare service, Context Profiles, routing
manifests, Context Snapshots/Digests, manual context artifact attachment flow,
route-owned chat bundle, session-summary cache, and vendor context-file
rendering have been deleted. Do not reintroduce compatibility aliases or dual
write/read paths; ADR 0014 records the decision and Git history records the
migration.
