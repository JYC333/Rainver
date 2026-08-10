# Decision 0014: One Runtime Context Gateway, Separate Retrieval Authority

Date: 2026-08-08
Status: Accepted; implemented

## Context

Runtime context is currently assembled by several partially overlapping paths:
normal Runs, Chat, lightweight CLI, Room continuation, automation, context
preview, session condensing, and vendor-file compilation do not share one
planner or one delivery contract. Context Profiles, routing manifests,
Context Packs, digests, chat candidates, manual context, session summaries,
compiler budgets, and adapter-specific limits split authority across the stack.

That split has observable consequences:

- a preview is not guaranteed to describe the eventual invocation;
- Chat can prepare context twice while another CLI path bypasses normal prepare;
- explicit inputs and retrieved candidates have no common typed representation;
- higher-scope policy is merged additively instead of deterministically
  constraining or overriding lower-scope preferences;
- session summaries are not a complete or uniform continuity mechanism;
- the persisted snapshot can precede the actual rendered provider payload;
- adapters can still own truncation or prompt composition decisions;
- repository development guides under `AGENTS.md`, `.agent/`, and vendor
  equivalents can be treated as product runtime inputs;
- a worktree can isolate Folder mutation without isolating the CLI process from
  the server container and other instance data.

The product needs one auditable entry and exit for model-visible context while
keeping retrieval, policy, usage accounting, and adapters as separate
authorities.

## Decision

### 1. Runtime Context Gateway is the only product context port

Every Chat, Run, Room recipient, Automation, managed Agent invocation, and
local CLI delivery that executes a user task must use `RuntimeContextGateway`.
The public application-facing operations are:

- `preview`
- `prepareInvocation`
- `acknowledgeDelivery`
- `ingestRuntimeEvent`
- `finalizeInvocation`

No caller may assemble model-visible context, invoke a context compiler, or
apply an adapter-owned context budget outside this gateway.

Bounded internal model tasks such as Retrieval rerank/rewrite/synthesis,
embedding, and checkpoint extraction are not Agent task-context entrypoints.
They continue through their owning domain and the governed Provider task
boundary, may share the low-level typed Delivery/Usage/Audit primitives, and
must not call back into Runtime Context or trigger recursive retrieval.

The gateway is a facade, not a monolith. Planning, policy resolution, explicit
reference resolution, retrieval coordination, window allocation, rendering,
continuity, and snapshots remain purpose-specific internal components.

### 2. Retrieval remains a separate engine

Retrieval owns relevance-driven candidate discovery, live access
revalidation, ranking, and retrieval trace. Runtime Context owns when retrieval
is requested and which authorized results fit into an invocation.

Inputs enter through distinct acquisition channels:

- direct providers supply fixed or required context;
- the explicit resolver resolves user-selected references;
- Retrieval discovers relevance-selected candidates, including episodic
  Memory.

All channels normalize to a common `ContextItem` before planning. Unifying the
item shape does not merge the authorities or let Runtime Context implement its
own search.

### 3. Hard controls and model-visible context are different products

Policy remains the authority for read scope, egress, tool grants, sandbox,
approval requirements, persistence, and output contracts. Runtime Context
consumes an immutable `ExecutionControlSnapshot`; it does not reproduce Policy
rules in prose.

Hard controls are enforced by the relevant server gateways outside the model.
Text is rendered with one of three semantic roles:

- `delegated_instruction`: approved Agent Instructions, approved Project
  Instructions, and approved bound Runtime Skills;
- `user_input`: the current task and explicit user notes;
- `reference_data`: Project Brief, Memory, Checkpoints, Retrieval results,
  Evidence, attachments, and Tool Results.

Reference data never becomes a system/developer instruction merely because it
was ranked highly or came from a trusted source.

### 4. Policy precedence is typed and deterministic

The existing Context Profile/Context Pack/routing-manifest model is replaced by
a strongly typed, immutable-versioned `RuntimeContextPolicy`.

- hard constraints are intersected and may only become narrower at a lower
  scope;
- selection preferences use the most-specific explicitly set value;
- `false`, an empty allowlist, and explicit disable are real values, not
  equivalent to absence;
- user and work-scope preferences cannot loosen a governing constraint;
- the resolved policy and every contributing version are snapshotted.

Instruction authority is not inferred from text order. The planner resolves
typed roles and precedence before rendering, and conflicting authoritative
instructions either produce one deterministic winner or block preparation.

### 5. Product-owned Project context replaces workspace guide discovery

Project runtime context consists of two separate, versioned objects:

- `ProjectBriefVersion` is reference data: goal, status, current focus,
  confirmed decisions, constraints, primary mode, workspace identity/boundary,
  source references, and review/publish metadata;
- `ProjectInstructionVersion` is delegated instruction and requires Project
  owner-level approval.

Ordinary Project contributors may propose reference content. Model-derived
conclusions require user confirmation before they become confirmed Project
context. Promotion to Project Instructions uses the stricter owner approval
path.

Root `AGENTS.md`, `.agent/**`, `CLAUDE.md`, and similar repository development
guides are development-time material only. The product server, Runtime Context
Gateway, adapters, sandboxes, tests, and acceptance gate must not read them as
runtime authority. An explicit user import may create a reviewable product
object; it never creates an implicit runtime file-discovery path.

### 6. Work Context Setup is stable configuration, not a per-turn draft

`WorkContextSetup` is created for an explicit work scope and versioned when the
user changes it. It binds the Project/Folder/Agent, pinned references,
exclusions, retrieval and continuity preferences, and governing policy base.
It stores references, not embedded free-form source text.

This editable setup and the user-editable/reference-oriented Project Brief are
runtime content configuration, not governance Policy. Ordinary authorized users
may change them within the resolved constraints; they cannot edit or loosen the
Space/Project/Agent Policy merely by changing context content.

Each turn supplies only a `TurnContextRequest`: current user input and optional
one-off references. The engine plans the turn automatically. Additions and
ordinary reference updates may be delivered as deltas to a stateful CLI.
Ordinary removal stops future active use but cannot claim the vendor forgot
previously delivered content. Safety revocation, deterministic forgetting, or
an authoritative instruction/control change rotates the vendor session.

A one-off reference is selected for that turn and is not resent on later turns
unless the user selects it again. Because a stateful vendor session may still
remember delivered material, a sensitive one-off uses a separately isolated
session when its retention boundary requires later forgetting.

### 7. Context Engine owns one model-aware window plan

`ContextWindowPlan` is the sole authority for prompt/history/context allocation.
It uses a shared model catalog and tokenizer and accounts for provider overhead,
output reserve, current input, instructions, history, checkpoint/tail, skills,
attachments, and retrieval together.

Usage remains a separate accounting and policy module. It shares model/token
metadata and reconciles planned versus actual usage, but does not decide which
context items fit.

Adapters render an accepted delivery and report exact token count or overflow.
They must not truncate, summarize, retrieve, reprioritize, or silently drop.
Required, pinned, and current-task content is never silently reduced. Optional
ranked material may be trimmed deterministically with a recorded reason.

### 8. Preview and execution use the same planner

Preview returns a structured plan, not client-rendered prompt text. Execution
reruns the same planner and revalidates permissions, egress, source versions,
and object status. A required or pinned material change blocks execution;
optional retrieval drift is allowed and recorded. Clients cannot submit a
rendered preview as executable context.

### 9. Snapshots represent actual deliveries

Each provider invocation or CLI delivery receives an immutable Invocation
Snapshot after payload validation. Managed tool loops create a snapshot for
each provider call. Stateful CLI snapshots record the full or delta delivery
that agent-space actually sent, not an unverifiable claim about the vendor's
internal context.

Long-term snapshot data is safe metadata, source/version references, hashes,
budget decisions, control references, and delivery outcome. Raw rendered
payloads, when policy permits, live only in a short-retention encrypted Sealed
Payload with separate authorization and audit. Normal Run Trace and product API
responses never expose raw context.

### 10. Continuity uses an event ledger and checkpoints

The old SessionSummary/condenser system is replaced, not wrapped. A
pointer-first ordered `ContextEvent` ledger records semantic events and refers
to canonical Message, Run, Artifact, Snapshot, Tool Result, and policy records.
It does not persist streaming token deltas; the final assistant message is
persisted once.

Every turn receives a deterministic Micro Checkpoint containing cursors,
references, and capture status. A structured Semantic Checkpoint is produced by
a one-shot checkpoint task, normally through the Managed API, only on a
threshold or meaningful boundary: substantive task completion, decisions or
artifacts, failure/correction, provider compaction, model/policy change, new
epoch, or an oversized uncovered tail.

Checkpoint extraction never computes the delta. The server deterministically
selects ledger events after `checkpoint_cursor` and supplies the previous
validated checkpoint when one exists. The extractor rolls previous checkpoint
plus event delta into a new complete checkpoint under a strict schema with
source references. Only canonical confirmation events may create a confirmed
fact or decision. Corrections append an immutable correction event and produce
a new checkpoint. Checkpoints are derived reference context; Memory or Project
promotion remains a separate approval flow.

The checkpoint event delta and CLI delivery delta are independent server
calculations. Checkpoint extraction summarizes the former; the latter is sent
directly as typed items and is never passed through the checkpoint API first.

A validated checkpoint becomes the active derived continuity reference
automatically; it does not require approval on every extraction. That automatic
activation grants no authority to write active Memory, Project Brief, Project
Instructions, or Policy.

Task outcome and context capture outcome are independent. A task may succeed
with `context_capture_status = partial`, or fail after its important events were
captured completely. The status is derived from acknowledgements, committed
canonical records, sequence/cursor checks, and reconciliation, not only from a
later human review.

### 11. Vendor sessions are disposable continuity caches

A `work_context_scope` identifies one direct conversation, one Room recipient
and instructing user, one root task, or one workflow execution. The same scope
normally continues in the same vendor session, including after vendor automatic
compaction. A new task/conversation creates a new scope and session.

The authoritative state is the event ledger plus checkpoints. A missing,
corrupt, reset, or incompatible vendor session is rebuilt from the latest
checkpoint, uncovered raw tail, and current context. Provider compaction causes
an asynchronous checkpoint but does not inject that checkpoint back into the
same session.

The server tracks two ordinary cursors:

- `checkpoint_cursor`: last event covered by the active checkpoint;
- `cli_known_cursor`: last event successfully delivered to the bound CLI
  session.

New CLI sessions receive checkpoint + raw tail + current context. Existing CLI
sessions receive only the deterministic relevant delivery delta plus current
turn input. No LLM is used to calculate this delta.

For a new vendor session, agent-space sends an agent-space-authored context
bootstrap as the first ordinary message, then sends the current user message as
a separate subsequent message. The bootstrap does not replace, edit, or claim
the authority of the vendor CLI's own system prompt. For an existing session,
only a non-empty context delta is sent before the separate current user
message. The checkpoint extractor never sends its output directly to that
continuing CLI session; a checkpoint is used for reconstruction of a new
session or when later planning selects it as reference data.

Vendor-local transcripts and session files may remain in the isolated
scope-runtime state as an implementation cache. They are not the Context Event
ledger, are not assumed complete, and are never the source read by an
independent checkpoint task. Agent-space builds checkpoint input from its own
canonical messages, events, runs, artifacts, tool records, and snapshots.

### 12. Every work scope gets an independently isolated runtime

Local coding CLIs run in a per-`work_context_scope` sandbox runtime. The scope
may persist for the life of the task, but a new scope receives a new
environment. The runtime can see only the selected Project/worktree, generated
delivery, allowlisted runtime tool, current credential channel, and Run
Exchange. It cannot see the whole `/aspace`, other Projects, the source
repository, the server HOME, or instance state.

The current unisolated worktree subprocess path is deleted. Project Folder
mutation isolation alone is not process isolation. A dedicated sandbox runner
owns Docker or an equivalent reviewed OS-isolation boundary; the application
server is not given a general Docker socket.

Runtime context is delivered as protocol messages, not by making `AGENTS.md`,
`CLAUDE.md`, `.agent/**`, or another discovered workspace file authoritative.
The current vendor context-file compiler is removed. Supporting a future
vendor that can only accept a generated file requires a separate explicit
adapter decision and conformance boundary; it is not a fallback in this
refactor.

## Authorization

Policy mutation uses actual resource ownership, not row existence:

- Space policy: Space owner/admin;
- Project or Folder policy: Project owner or Space owner/admin;
- Agent policy: Agent owner; a Project-owned Agent also permits the Project
  owner; Space owner/admin remains an administrative authority;
- user preferences: the same user only;
- Work Context Setup: the scope owner, within governing policy.

Every mutation records actor, previous version, new version, and typed diff.
Revalidation occurs at preview execution, invocation preparation, and delivery.

## Clean cutover

There is no compatibility layer, dual read, fallback, or alias for the replaced
context architecture. Implementation deletes the old Context Profile, Context
Pack, routing manifest, file-bundle/touched-file routing, manual-context stub,
Context Digest, SessionSummary/condenser, duplicate Chat preparation, lightweight
CLI bypass, adapter-local budget, pre-render Context Snapshot, and unisolated
worktree execution paths.

The repository currently has no historical product data to preserve. Schema
changes are authored directly in the final Drizzle shape and folded into the
canonical baseline migration. If a developer instance needs continuity while
the branch lands, a one-time explicit migration/export may be supplied; runtime
code must not dual-read the old and new shapes.

## Consequences

- Runtime Context becomes independently testable and all entrypoints share one
  contract.
- Retrieval remains reusable outside invocation assembly.
- Policy enforcement remains deterministic and outside the model.
- Context delivery becomes auditable without exposing raw prompts by default.
- Stateful CLIs can be efficient without making resume or vendor storage an
  authority.
- Project context is editable by product users without treating development
  repository docs as runtime configuration.
- The refactor is intentionally breaking and requires coordinated schema,
  server, protocol, adapter, frontend, test, and documentation changes.

## Implementation status

The clean cutover was completed on 2026-08-10. Code, schema, and current-state
architecture documents describe the shipped behavior; this ADR remains the
accepted design record. Phase delivery, independent-review, repair, and final
integration evidence remain available in Git history through commit
`a98f6752`.
