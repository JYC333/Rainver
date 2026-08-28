# ADR 0014: One Runtime Context Gateway, Separate Retrieval Authority

Date: 2026-08-08
Rewritten: 2026-08-27

## Status

Accepted; the clean cutover landed 2026-08-10 (commit `a98f6752` holds the
phase evidence). Current state lives in
[`architecture/MEMORY_CONTEXT_RUNTIME.md`](../architecture/MEMORY_CONTEXT_RUNTIME.md)
and [`modules/runtime-context.md`](../modules/runtime-context.md); this
document holds the decisions and their reasoning.

## Context

Before this decision, runtime context was assembled by several overlapping
paths: normal Runs, Chat, lightweight CLI, Room continuation, automation,
context preview, session condensing, and vendor-file compilation shared
neither a planner nor a delivery contract. Context Profiles, routing
manifests, Context Packs, digests, chat candidates, manual context, session
summaries, compiler budgets, and adapter-specific limits split authority
across the stack. Observable consequences:

- a preview did not describe the eventual invocation;
- Chat could prepare context twice while another CLI path bypassed prepare;
- explicit inputs and retrieved candidates had no common typed shape;
- higher-scope policy merged additively instead of constraining;
- session summaries were not a complete continuity mechanism;
- the persisted snapshot could precede the actual rendered payload;
- adapters owned truncation and prompt composition;
- repository development guides (`AGENTS.md`, `.agent/`, vendor files) could
  be treated as product runtime inputs;
- a worktree isolated Folder mutation without isolating the CLI process from
  the server container.

The product needs one auditable entry and exit for model-visible context
while keeping retrieval, policy, usage accounting, and adapters as separate
authorities.

## Decision

### 1. The Runtime Context Gateway is the only product context port

Every Chat, Run, Room recipient, Automation, managed Agent invocation, and
local CLI delivery that executes a user task uses `RuntimeContextGateway`:
`preview`, `prepareInvocation`, `acknowledgeDelivery`, `ingestRuntimeEvent`,
`finalizeInvocation`. No caller assembles model-visible context, invokes a
compiler, or applies an adapter-owned budget outside it.

Bounded internal model tasks (retrieval rerank/rewrite/synthesis, embedding,
checkpoint extraction) are not Agent task-context entrypoints. They go
through their owning domain and the governed Provider task boundary, may
share the low-level Delivery/Usage/Audit primitives, and must not call back
into Runtime Context or trigger recursive retrieval. An executable inventory
of every production entrypoint (`runtimeContext/invocationInventory.ts`)
is compared against source imports by boundary tests so a new bypass cannot
land unseen.

The gateway is a facade: planning, policy resolution, explicit reference
resolution, retrieval coordination, window allocation, rendering, continuity,
and snapshots remain purpose-specific components.

### 2. Retrieval remains a separate engine

Retrieval owns relevance-driven discovery, live access revalidation, ranking,
and trace. Runtime Context owns when retrieval is requested and which
authorized results fit. Inputs enter through three channels — direct
providers (fixed or required context), the explicit resolver (user-selected
references), and Retrieval (relevance-selected candidates, including episodic
memory) — and normalise to one `ContextItem` before planning. Unifying the
item shape does not merge the authorities.

### 3. Hard controls and model-visible context are different products

Policy is the authority for read scope, egress, tool grants, sandbox,
approval, persistence, and output contracts. Runtime Context consumes an
immutable `ExecutionControlSnapshot` and does not reproduce Policy in prose.
Hard controls are enforced by server gateways outside the model. Text is
rendered with one of three roles: `delegated_instruction` (approved Agent
Instructions, Project Instructions, bound Runtime Skills), `user_input`
(current task, explicit notes), `reference_data` (Project Brief, memory,
checkpoints, retrieval, evidence, attachments, tool results). Reference data
never becomes an instruction because it ranked highly or came from a trusted
source.

### 4. Policy precedence is typed and deterministic

`RuntimeContextPolicy` is strongly typed and immutably versioned: hard
constraints intersect and only narrow at lower scope; selection preferences
use the most-specific explicitly set value; `false`, an empty allowlist, and
explicit disable are real values; user and work-scope preferences cannot
loosen a governing constraint; the resolved policy and every contributing
version are snapshotted. Instruction authority is resolved from typed roles,
never inferred from text order; conflicting authoritative instructions
produce one deterministic winner or block preparation.

### 5. Product-owned Project context replaces workspace guide discovery

Project runtime context is two versioned objects: `ProjectBriefVersion`
(reference data — goal, status, focus, confirmed decisions, constraints,
primary mode, Folder identity/boundary, sources, review metadata) and
`ProjectInstructionVersion` (delegated instruction, Project owner-level
approval). Contributors may propose reference content; model-derived
conclusions require user confirmation; promotion to Instructions uses the
owner path.

Root `AGENTS.md`, `.agent/**`, `CLAUDE.md`, and similar repository guides are
development-time material only. Server, gateway, adapters, sandboxes, tests,
and acceptance gate never read them as runtime authority. An explicit import
may create a reviewable product object; it never creates an implicit
file-discovery path ([ADR 0004](0004-context-wrapper.md)).

### 6. Work Context Setup is stable configuration, not a per-turn draft

`WorkContextSetup` is created for an explicit work scope and versioned when
changed: Project/Folder/Agent binding, pinned references, exclusions,
retrieval and continuity preferences, governing policy base — references,
not embedded text. It and the Project Brief are runtime content
configuration, not governance Policy; changing them cannot loosen
Space/Project/Agent Policy.

Each turn supplies only a `TurnContextRequest` (current input, optional
one-off references). Additions and reference updates may be delivered as
deltas to a stateful CLI. Ordinary removal stops future use but cannot claim
the vendor forgot delivered content; safety revocation, deterministic
forgetting, or an authoritative instruction/control change rotates the
vendor session. A sensitive one-off reference uses a separately isolated
session when its retention boundary requires later forgetting.

### 7. The Context Engine owns one model-aware window plan

`ContextWindowPlan` is the sole authority for prompt/history/context
allocation, using a shared model catalog and tokenizer and accounting for
provider overhead, output reserve, input, instructions, history,
checkpoint/tail, skills, attachments, and retrieval together. Usage stays a
separate accounting module that reconciles planned versus actual but does not
decide fit. Adapters render an accepted delivery and report exact token count
or overflow; they never truncate, summarise, retrieve, reprioritise, or drop.
Required, pinned, and current-task content is never silently reduced;
optional ranked material may be trimmed deterministically with a recorded
reason.

### 8. Preview and execution use the same planner

Preview returns a structured plan, not rendered prompt text. Execution reruns
the planner and revalidates permissions, egress, source versions, and object
status; a required or pinned change blocks execution, optional retrieval
drift is recorded. Clients cannot submit a rendered preview as executable
context.

### 9. Snapshots represent actual deliveries

Each provider invocation or CLI delivery receives an immutable Invocation
Snapshot after payload validation; managed tool loops snapshot each provider
call; stateful CLI snapshots record the full or delta delivery actually sent.
Long-term snapshot data is safe metadata, references, hashes, budget
decisions, control references, and outcome. Raw rendered payloads, where
policy permits, live only in a short-retention encrypted Sealed Payload with
separate authorization and audit; Run Trace and product APIs never expose raw
context.

### 10. Continuity is an event ledger plus checkpoints

The SessionSummary/condenser system is replaced, not wrapped. A
pointer-first ordered `ContextEvent` ledger records semantic events referring
to canonical Message, Run, Artifact, Snapshot, Tool Result, and policy
records; it does not persist streaming deltas.

Every turn receives a deterministic Micro Checkpoint (cursors, references,
capture status). A structured Semantic Checkpoint is produced by a one-shot
task, normally through the managed API, only on a threshold or meaningful
boundary. Extraction never computes the delta: the server selects ledger
events after `checkpoint_cursor`, supplies the previous validated checkpoint,
and the extractor rolls both into a complete new checkpoint under a strict
schema. Only canonical confirmation events create confirmed facts or
decisions; corrections append an immutable correction event. A validated
checkpoint becomes the active continuity reference automatically, which
grants no authority to write memory, Project Brief, Instructions, or Policy
([ADR 0003](0003-memory-proposal-flow.md)).

Task outcome and context capture outcome are independent
(`context_capture_status` may be `partial` on a succeeded task), derived from
acknowledgements, committed records, cursor checks, and reconciliation.

### 11. Vendor sessions are disposable continuity caches

A `work_context_scope` identifies one direct conversation, one Room recipient
and instructing user, one root task, or one workflow execution, and normally
continues in the same vendor session including across vendor compaction. The
authoritative state is ledger plus checkpoints; a missing, corrupt, reset, or
incompatible vendor session is rebuilt from the latest checkpoint, uncovered
tail, and current context. Two cursors are tracked: `checkpoint_cursor` and
`cli_known_cursor`. New CLI sessions receive a Rainver-authored context
bootstrap as the first ordinary message, then the user message separately;
existing sessions receive only a non-empty deterministic delta before the
user message. No LLM computes the delivery delta, and the checkpoint
extractor never sends its output directly to a continuing session.
Vendor-local transcripts remain an implementation cache, never the ledger
and never the source read by a checkpoint task.

### 12. On the server host, every work scope gets an isolated runtime

Local coding CLIs executed on the server host run in a per-`work_context_scope`
sandbox runtime — a rootless bubblewrap namespace owned by the dedicated
sandbox-runner, never a Docker socket handed to the application server. The
runtime sees only the selected Project/worktree, generated delivery,
allowlisted runtime tool, current credential channel, and Run Exchange; not
the whole `RAINVER_HOME`, other Projects, the source repository, the server
HOME, or instance state. The former unisolated worktree subprocess path was
deleted: Folder mutation isolation alone is not process isolation.

Runtime context is delivered as protocol messages. The vendor context-file
compiler was removed; a future vendor that can only accept a generated file
requires a separate explicit adapter decision.

A paired personal execution host runs under
[ADR 0016](0016-control-plane-execution-hosts.md)'s trusted-host model, where
this decision's isolation guarantees do not apply; the Gateway and delivery
contract apply there unchanged.

## Authorization

Policy mutation uses resource ownership: Space policy — Space owner/admin;
Project or Folder policy — Project owner or Space owner/admin; Agent policy —
Agent owner (a Project-owned Agent also permits the Project owner; Space
owner/admin remains administrative); user preferences — that user; Work
Context Setup — the scope owner within governing policy. Every mutation
records actor, previous version, new version, and typed diff. Revalidation
occurs at preview, preparation, and delivery.

## Clean cutover

No compatibility layer, dual read, fallback, or alias for the replaced
architecture. Implementation deleted Context Profile, Context Pack, routing
manifest, file-bundle/touched-file routing, manual-context stub, Context
Digest, SessionSummary/condenser, duplicate Chat preparation, lightweight CLI
context bypass, adapter-local budget, pre-render Context Snapshot, and
unisolated worktree execution. Schema changes were authored in final Drizzle
shape and folded into the canonical baseline.

## Consequences

- Runtime Context is independently testable and every entrypoint shares one
  contract; Retrieval stays reusable outside invocation assembly; Policy stays
  deterministic and outside the model.
- Context delivery is auditable without exposing raw prompts by default.
- Stateful CLIs are efficient without resume or vendor storage becoming an
  authority.
- Project context is editable by product users without treating repository
  docs as runtime configuration.

## Revision history

- **2026-08-08** — accepted.
- **2026-08-10** — clean cutover completed.
- **2026-08-27** — rewritten. Decision 12 scoped to the server host — ADR
  0016's amendment sweep had missed this document; the isolation mechanism
  named as bubblewrap under the sandbox-runner rather than "Docker or an
  equivalent"; the invocation inventory recorded as the enforcement of
  decision 1.
