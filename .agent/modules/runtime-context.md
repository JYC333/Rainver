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
Delivery includes an optional numeric `context_estimate` projection of the
accepted allocation buckets for usage diagnostics; it is not another planner.
CLI aggregate usage cannot measure the input size of a single Delivery, so its
Snapshot `actual_tokens` and window reconciliation remain unmeasured instead
of recording only uncached input as the actual size. Cumulative measured
buckets and the runtime's last occupancy report remain in the usage record.

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
`input_resource` descriptors in Delivery. Planning and transaction-time authorization
use the same message renderer; authorization reloads the message-owned descriptors
in the source Space and compares the complete text, including attachment metadata.
Conversation continuity excludes
the same current message. At ACP dispatch, conversation-input hydration adds
images and resource links, but does not add a second descriptor text block when
Delivery already contains it. The adapter sends Delivery instead of the raw
Run prompt. A session handoff uses its own Run request as current input and
does not hydrate the pending user's message attachments. A delegated child
Run (`runs.delegation_id` set) also uses its own Run request — its delegation
instruction — as current input even though it inherits its parent's
`chat_turn` record: the person's message is the parent's input, and a child
handed it would act as a second coordinator on that message
(`currentRuntimeContextInputRef`). ACP hydration applies the same boundary, so
inherited chat-turn metadata does not attach the parent's images or resource
links to a delegated child's request.

When the current input is a Run request, an identical task instruction is not
also acquired as `run_instruction`. A Room delegation's prompt is assembled
from standing context and a handoff followed by that same instruction, and the
assembling code records `run_request_includes_instruction: true` on the child's
`model_override_json` (`agentGroups/service.ts`, read by
`runtimeContext/runRequest.ts`). Acquisition, delivery revalidation and
canonical Run-request history read that recorded fact; they never infer
assembly from matching text, so a prompt that merely ends with its instruction
keeps both. Distinct instructions remain authoritative and intact.

## Continuity

Conversation and task continuity is an ordered ledger of canonical refs, not a
route-owned prompt cache. Runtime events are append-only per typed work scope.
Terminal events create deterministic Micro Checkpoints; bounded semantic
extraction may publish a validated Semantic Checkpoint only after rechecking the
selected head and every canonical ref. Immutable corrections supersede invalid
semantic state without rewriting history. CLI bindings keep an acknowledged
cursor and rotate fail closed when scope, generation, session state, or replay
authority is invalid.

A direct conversation's raw tail follows the canonical visible message path
through the triggering message, including messages whose ledger capture is
still missing. Clock timestamps and delayed event arrival cannot reorder that
tail or admit later messages. A checkpoint excludes only the messages its
ledger prefix actually captured; the prefix ends before any known message
outside the trigger's path. The current message stays available to acquisition
and is excluded from historical rendering.

A Room recipient's Work Context scope is one Conversation with that
recipient: a `room_conversation_recipients` row, created on the first Run that
resolves it (`policy/executionControlSnapshots.ts`) or when a person first sets
its retrieval switch, and authorized through the
recipient's Room membership in `workContextService.ts`. Its ledger, checkpoints,
CLI bindings and Setup belong to that Conversation alone; another
Conversation's transcript never enters its history (ADR 0014 §11 amendment).

Room Runs from before per-Conversation scopes have control snapshots naming
the whole-Room recipient scope. The upgrade split (`0003_repair_upgrade_backfills`)
moved their events and replayable capture gaps to the Conversation scopes but
left the snapshots alone, because they are audit records. Continuity therefore
counts a Run as in scope when its snapshot names the scope, or when the scope
is the `room_conversation_recipients` row for that Run's own Conversation and
the snapshot names that row's recipient (`controlInScope` in
`continuity/service.ts`). Canonical-ref checks, reconciliation's terminal
check, gap recovery and the extraction egress policy all use this rule. A Run
of another Conversation with the same recipient is still foreign. Cursor
checks against an invocation snapshot keep the old ledger's own coordinates
and do not cross the split.

Reconciliation records what it finds as a `reconciliation_mismatch` gap and
re-derives it from durable rows on every scan. A later clean scan therefore
resolves that gap. Capture gaps close only when their buffered event is
replayed.

A binding that follows a Host thread's ACP session is also keyed by that
thread, so one scope never has two vendor sessions sharing a cursor. Bindings
for server-local CLI state carry no thread. A Run that parks mid-turn (`waiting_for_dependency` or
`waiting_for_review`) writes the session its binding names back to its
`host_thread.runtime_session_id`. Its next attempt then resumes that session
instead of the one it was created with.

CLI history selection is owned by `continuity/cliHistory.ts`. Generic tool-start,
tool-completion and invocation-finalization progress stays in the audit ledger
but is not replayed to the model; meaningful tool outcomes and failures remain.
On a healthy resume, a successful Delivery acknowledgement for the exact same
binding proves the session already knows that Run's request, replies and tool
outcomes. They are not replayed. Unacknowledged Runs and other bindings remain
eligible, and a fresh or security-rotated session reconstructs them normally.
An acknowledged Run's `run_terminal` outcome is treated the same way. An
assistant message from a failed, cancelled or orphaned Run is rendered as one
`earlier attempt <status>` line, and an identical notice from repeated attempts
is said once; the ledger keeps every event.

Stable standing items keep one item id across Runs so the acknowledged-item
filter recognises them: the item id hashes an identity key instead of the
source ref, the group goal (`run_instruction`) keyed by its Run group and the
Room identity by its Agent. Their `source_ref` still names the Run whose row
supplied the text, and the gateway revalidates them against that Run. Item ids
also hash the text, so a changed goal or identity is a new item and is
delivered again. A delta Delivery opens with a
one-line continuation notice instead of the full ACP channel notice, and the
remote Host adapter sends a short Work Skill reminder instead of the full
pointer; any tool-grant change already rotates the binding to a full Delivery.
The one exception is the input-resource tools (`input_resource.read/search`),
granted only for a turn whose message carries resources. They are left out of
the binding fingerprint, so an attached message does not rotate the session
twice; the turn's resource descriptors name the tools, `$RAINVER_CLI list`
lists them, and every call is still checked against that turn's own grants.

One CLI replay budget, `CLI_REPLAY_TOKENS` (6,000 estimated tokens,
`continuity/cliHistory.ts`), bounds both paths: a delta above it rotates, and
the reconstruction that replaces it fits it whole. An authorized semantic
checkpoint rendered into the reconstruction counts against it: up to 3,000
tokens (`CLI_CHECKPOINT_TOKENS`) verbatim, a larger one as its beginning,
labelled as an incomplete excerpt whose full record remains in Rainver. Recent
history takes what the checkpoint, header and coverage notice leave. An
incomplete boundary event is explicitly labelled as an excerpt with its
canonical ref; omitted history has a coverage notice. Complete event refs remain
on the Delivery item for audit, and delivery authorization recomputes the same
selection from canonical sources. The current input, standing instructions, and
explicit or pinned inputs are separate items and are not trimmed by this budget.
No semantic summary is invented when a Provider is unavailable, and the notice
explicitly forbids assuming decisions from omitted history. This budget is not
a claim about an ACP model's capacity.

A Run executes on a CLI binding under its execution lease. The lease names its
holder Run and a fencing generation that every acquisition raises and every
rotation carries over. It lasts five minutes without renewal; the holder renews
it once a minute while it runs. A lease whose holder Run is no longer live is
free at once, and the same Run's next attempt is not held off by its own dead
attempt. A Run waiting for another holder waits at most ten minutes, and stops
waiting when it is itself no longer live; either way it fails with the
retryable `cli_execution_lease_unavailable`. A Delivery carries the fencing
generation it was planned under, and acknowledgements and vendor-session
records are refused once another Run has taken the lease over. Preparation
preserves the caller's acquired generation and rechecks it both before history
selection and in the Delivery persistence transaction; a stale attempt cannot
adopt its successor's generation. Lease acquisition requires the acquiring Run
to remain queued or running even when the binding is free; binding preparation
also locks and checks that Run before creating or rotating state. An overflow
reconstruction moves the lease onto the replacement binding. A missing vendor
state rotates once per lease: asking again answers with the binding the lease
already holds. Both replacements retain the holder Run, so its restarted
attempt or the successor of a stopped holder can acquire without waiting for
the lease expiry.

## Knowledge retrieval switch

Whether a conversation searches the knowledge base on its own is the person's
choice. A direct chat or Room recipient retrieves only when its Work Context
Setup's `retrieval_preferences.enabled` is true, so a new conversation starts
with retrieval off. Root tasks and workflows keep retrieving unless their setup
turns it off. `GET`/`PUT /api/v1/runtime-context/work-contexts/:scopeId/retrieval`
read and set the switch and its `preferred_domains` as the next Setup version
for that person and scope; a direct chat's scope is its session. A Room
recipient's switch is addressed as
`/api/v1/runtime-context/room-conversations/:sessionId/recipients/:memberId/retrieval`,
which resolves that Conversation's scope for a person active in the Room. Its
`GET` is read-only: it never creates the `room_conversation_recipients` row,
and a recipient without one reads as off with a null `work_context_scope_id`
and `setup_version`; the `PUT` (or the first Run) creates the scope. Either
way the choice holds for that one conversation. The direct-chat composer shows one switch;
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
- Delivery revalidates the latest Setup version and its effective bindings:
  an unset Project or Project Folder inherits the persisted Run's binding,
  matching execution-control snapshot resolution. The transaction locks the
  Run and checks live Project and Folder access, including Folder status;
  explicit Setup bindings take precedence over Run defaults.
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

## Explicit original Skill packages

Canonical message input parts pin Skill package ids and SHA-256 versions.
Acquisition resolves reviewed `skill_bindings` using the control snapshot's
Project/Agent/user scope, including Setup overrides. Each required delegated
instruction carries original package files; the Gateway rechecks live scope
bindings and complete content before `Delivery.skill_packages` is accepted.
Run-specific source versions retain files on continuation deliveries. Only
accepted Delivery files reach the Host work surface and ACP resource links;
normalized conversion/rendering is not involved in this path. Disabling a
binding or changing stored bytes invalidates an outstanding plan. See
[Skill library](../architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md).
