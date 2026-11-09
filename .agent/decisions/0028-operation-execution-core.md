# ADR 0028 — One operation execution core, multiple authenticated entries

Date: 2026-11-05
Status: accepted after stage-1 dual review; committed in 95d61d90.
All four stages and the overall code/final documentation passed Claude/
Antigravity dual review. Plan 1 is complete within its documented scope:
`3e3af010` through `c3156a48` plus the documentation-only correction.

## Context and implementation boundary

The [Operation Core Program](../plans/operation-core/README.md) authorizes a
phased design. This ADR freezes the implementation contract for its first plan;
its design is not a claim that all operations have migrated. The current core
enables the metadata query and cancellation pilot only; production approval
mappings remain off. Enabled entries are recorded in the System Actions guide.
The executable detail and acceptance obligations are in the [execution contract](../architecture/OPERATION_EXECUTION_CONTRACT.md).
The present [System Actions guide](../architecture/SYSTEM_ACTIONS.md) continues
to describe the implementation until individual migrations land.

Historical evidence inspected when accepting stage 1 (`95d61d90`), before core
implementation (not a description of the current implementation):

- `systemActions/registry.ts` already caches validated definitions. The per-call
  rebuild is the Run-bound executor map/policy in `systemActionDispatcher.ts`,
  not the registry. `gateway.ts` checks key presence, validates output after the
  service returns, and has no transaction owner. RunEvents are best effort.
- `systemActions/effectiveRunTrigger.ts` resolves parent/cause lineage, including
  broken chains; the resolver returns root origin separately from transport.
- `policy/auditWriter.ts` currently uses its own pool statement. An injected
  transaction-aware policy audit port is required before claiming atomic audit.
- `routeUtils/common.ts:withQueryableTransaction` joins a checked-out client;
  `db/tx.ts:withTransaction` owns BEGIN/COMMIT. Neither is a capability sandbox.
- `proposals/applyService.ts:acceptInTransaction` and `rejectInTransaction`, the
  payload schemas and `ProposalApplierRegistry` are the canonical approval path.
  There is no general operation-resume payload/applier today. Its compensation
  callbacks and direct dependency-supersession writers are not atomic request
  integration; each requires an explicit migration gate.
- `projectResearch/researchOperationCancel.ts` already commits cancellation,
  reconciliation and a durable `research_operation_cancel` Job together.
  Source pause/resume definitions are metadata, not generic executable entries.

All code paths above are relative to `server/src/modules/` except `db/tx.ts`.

## Decision

### 1. One core, explicit migration

Extend the existing System Action boundary into an operation executor; retain
System Action ids and one registry. Entries authenticate, assemble validated
transport input and server-owned identity, then map the outcome. Domain services
retain their authorization predicates; the core owns operation admission and
policy, transaction, dedupe, approval integration and output validation. An
adapter does not repeat the operation policy decision.

New core capabilities are operations first once Plan 1's pilots pass. Existing
REST URLs and response contracts remain stable through adapters. Only a fully
migrated, explicitly enabled actor/surface/version pair may use generic entries.
Existing `public_api` metadata alone enables nothing. Legacy Run families stay
on the legacy dispatcher until migrated; immutable Run grants are neither
rebuilt nor widened. This is a tracked migration under B66, not a second tool
system or a permanent alias under B58. Plan 5 retires legacy paths individually.
The legacy `source.material.submit` invalidInputExecutors path preserves its
bounded invalid-attempt writes, errors and failure events. It remains outside
the pilots: the new core strictly rejects invalid schema input without domain
execution, and must not silently replace that legacy admission/error contract.

Routes have exact method/path migration inventory entries or reasoned transport
exemptions; `/internal*`, an annotation, or membership in a registry cannot grant
a new bypass. `operations/routeInventory.json` captures the real route inventory;
`operationRoutes` checks actual module and bundled-plugin registrations for drift.

### 2. Shared behavior, separate authority and origin

People and Agents share domain operations, never identity or authority (B6/B7).
Effective authority is current person authority intersected with delegated Agent
and Run grants and the token's scope. System/automation principals have explicit,
registered service capabilities, not implicit superuser authority. A personless
principal cannot invoke a person-required operation.

Build actor context only from authenticated server records. Keep immediate
origin (`delegated`, `continuation`, etc.) for provenance separately from the
verified effective root used by policy. Translate existing Run `delegation` to
actor `delegated`; the contract maps all seven stored Run origins explicitly
(manual, automation, autonomous, job, system, delegation, continuation) and
rejects legacy/unknown execution origins. Do not change stored Run vocabulary.
A user session supplies `manual` explicitly. Missing/broken lineage is `unverified`, never manual.
Continuation inheritance relies on existing persisted cause/budget evidence;
this plan adds no inferred budget or authority.

The existing policy gateway remains authoritative; the core must not call pure
`engineCheck` as an enforcement substitute. Revalidate mutable authorization
under the same locks protecting the mutation/replay. Record one final operation
policy decision per invocation, including retries. A preliminary evaluation may
be pure; the final transactional evaluation uses the supported policy port and
writes its required audit. Proposal-apply and content-access decisions remain
separate obligations. Denial audit survives independently of aborted business
work; no business writes may commit merely to preserve a denial record.

### 3. Commands and queries are explicit contracts

Every migrated definition declares `kind: command | query`, real input/output
schemas, resource/audience resolver and policy adapter. `side_effects: none`
alone is insufficient evidence of a query. Progress acknowledgement, quota
consumption or starting work is a command even if its old route uses GET.

Commands require a caller-stable idempotency key and core-owned transaction.
Queries have no write dedupe or approval creation; they execute domain reads in
an explicitly read-only data transaction. A separate host-controlled audit port
preserves B11 on every cross-person registered-content read, not just sensitive
ones. Fail-closed audit must commit before content release. Query content still
requires Source, row, Room audience, retention and destination checks. New generic
queries use `Cache-Control: private, no-store`; GET is not permission to reuse a
response or return 304 before current checks. No general public cache is added.

### 4. Atomicity and reliable work

For commands, one core-owned PostgreSQL transaction acquires the key try-lock,
then any linked Proposal, existing request row and authorization/resource closure
locks in that order, before executor writes, validated output, mandatory
operation audit, required Job intents, and the terminal request record. Give
services a host-branded query-only port over that same checked-out client.
`withQueryableTransaction` recognizes its active brand first, then falls back to
legacy Pool/PoolClient detection; the port has neither connect nor
release. Do not strip release while retaining connect and accidentally enter
the pool branch. The raw client stays private to core/canonical apply ownership;
legacy raw-client helper behavior remains intact.
Reject independent pool access, outer transaction-control statements and nested dispatch
in migrated execution. Review and real-PG escape tests are required; a TypeScript
interface alone is not transaction containment for trusted in-process code.

Put executor work behind a savepoint. The branded port may host-translate domain
savepoint labels without exposing outer transaction control or core savepoints.
Only declared deterministic domain errors
may be rolled back to that savepoint and durably cached as failures. Unexpected
SQL/transport errors, invalid output or required audit failure roll back everything.
Classify errors by explicit type/code, never message matching or all HTTP 4xx.

Required asynchronous effects are durable Jobs inside the transaction. Wake-ups
and SSE after commit are rebuildable notifications; their failure cannot change
a committed result into failure. Workers remain retry-safe, not exactly-once
external delivery. No external calls in the transaction. `self_managed` is reserved
and rejected by generic entries; multi-commit/external families stay legacy until
their own recovery boundary is specified and tested.

Canonical Proposal appliers with rollback compensation, independent commits or
required postCommit effects are ineligible for core-owned mappings. Registration
must review the complete effect path and accept only transaction writes/durable
Jobs, with allowlisted rebuildable notifications after commit. Unexpected
compensation callbacks are contract violations, not proof that external effects
were undone. Separate legacy recovery acceptance cannot grant generic entry
access or the core atomicity claim.

### 5. Idempotency is scoped transport retry, not domain history

Freeze identity scope, fingerprint of normalized caller input/operation version/
stable target IDs, non-waiting lock, state transitions and seven-day terminal
retention as specified in the execution
contract. Acquire a transaction-scoped try-lock before touching the unique key;
a blocking unique INSERT is not concurrency rejection. No separately committed
`in_progress` row exists. Death before commit rolls back reservation and writes;
response loss after commit replays without executing again. Server-observed
resource versions/status/preconditions are excluded from that fingerprint; a
successful mutation changing them cannot turn its same-input retry into 422.
Caller-supplied optimistic versions remain caller input. Mutable preconditions
are a separate frozen approval snapshot used for acceptance drift detection.

The CLI implements `call <action> --idempotency-key <key> [input]` through direct
HTTP/file bridge/Host to the core. Each attempt has a fresh correlation UUID,
separate from an explicitly reused key. The bridge capability check refuses
explicit-key mode before sending on unsupported Hosts. Without an explicit key,
the CLI uses its fresh UUID; the Run route retains its missing-header UUID
fallback. Neither fallback establishes cross-invocation retry identity: a new
model call is a new request. No write is automatically retried. Actual pilot
response-loss/process-death evidence is linked in the acceptance matrix; this is
not a claim of deployed old-Host/image verification.

Authorization and result visibility are current on every replay. Do not replay
content after audience/Source/authority revocation. Version belongs to the stored
fingerprint, not the unique key; incompatible upgrades cannot silently re-execute.
Domain uniqueness, optimistic versions and command histories remain independent.
Module idempotency/history tables are not removed by this plan.

### 6. Approval has one canonical owner

A blocking `require_approval` is a normal pending outcome only after atomically
creating one valid mapped Proposal and linked request. A missing mapping fails
closed. Operations that already produce domain proposals keep their existing
payload/applier; never wrap a proposal-producing command in a second approval
that would merely approve creating the original Proposal. Gate classes must
match the protocol registry: `source.backfill.propose_start` is `money`, not
exposure; `project.propose_definition` is `direction`; cancellation/pause/resume
have no registered hard gate. The contract cross-checks all non-null registered
gates without enabling any new mapping.

Gate reasons distinguish ADR 0017's exhaustive hard-gate classes from unattended
origin and explicit checkpoints. Origin is not a new hard-gate class. An approval
satisfies only its named gate, never a denial, revoked access, unknown version,
Source withdrawal or B43's administrator-only deployment boundary. Memory still
uses the canonical memory applier and ADR 0003/B10 conditions.

Freeze requester, normalized input, version, resource scope, origin and preconditions.
Human acceptance rechecks both approver and requester's present authority, and
joins `PgProposalApplyService`'s transaction via a registered typed applier and
internal approved execution port. Never call public dispatch recursively or
replace the requester with the approver. Output validation, business writes,
audit, Jobs, request terminal outcome and Proposal decision commit together.
Rejection, expiry and supersession do not execute business work.

Retry, decision and cleanup reconcile a pending request against its locked
Proposal under the same key → Proposal → request → closure order. Actual rejected,
superseded or expired Proposals terminalize the request correspondingly; an
accepted Proposal requires its matching committed atomic terminal result. If
that evidence is missing, return `operation_approval_state_inconsistent`, preserve
the pair and never re-execute or reconstruct success. Mapped status writers,
including dependency cascades and direct definition supersession, must update
requests in the same transaction. Multi-request cascades acquire all scoped key
locks in sorted order before any Proposal/request/closure locks, revalidate the
dependency set and abort on drift. Enablement waits for every affected writer
and its race tests; reconciliation alone cannot make legacy writes atomic.

### 7. Results and future plugin boundary

The core returns domain data or typed pending/error outcomes, preserving HTTP
status; only the Agent adapter produces `{modelResult, summary}`. The detailed
error/status contract is frozen below the ADR, not activated on legacy routes.
Protocol Zod schemas remain the input/output authority; the typed operation table
and Web client helpers derive from them without a hand-maintained second schema.

A plugin operation is a namespaced System Action (`plugin.<plugin_id>.<entity>.<verb>`)
through this same core. Plugins may strengthen gating, never lower it. Initial
plugins remain first-party trusted in-process code; serializable ports preserve
a possible future boundary, not a present untrusted-code sandbox. Plugin
registration, schema isolation and sensitive Agent access remain plans 2/4 work.

## Reuse / Dependency Check

- Existing repository capability found: System Action registry/gateway, policy
  gateway + access predicates, effectiveRunTrigger, Proposal payload/applier
  registry, withQueryableTransaction/withTransaction and PostgreSQL Job queue.
- Existing installed dependency found: Zod for schemas, pg for transactions and
  PostgreSQL locks, Fastify for authenticated transport; manifests inspected.
- Mature external option evaluated: n/a for authority/approval/domain semantics;
  no new commodity engine is needed because transactions, queue and validation
  already have canonical mechanisms. Do not adopt a second workflow/queue engine.
- Chosen approach: extend the existing core and transaction-aware policy/applier
  ports; preserve legacy adapters until each operation meets migration criteria.
- Why: operation semantics are Rainver-owned; replacing the canonical policy or
  Proposal engine would duplicate authority. The original stage-1 change was
  documents only; later implementation reused these mechanisms without a new
  dependency.

## Consequences and acceptance

The [contract](../architecture/OPERATION_EXECUTION_CONTRACT.md) is the permanent
current specification for the implemented core, controlled ports and cancellation
pilot. The [acceptance matrix](../architecture/OPERATION_CORE_ACCEPTANCE.md) maps
fault/restart/local cutover invariants to executable evidence and records current
limits. Production approval mappings and the eight legacy writer migrations
remain disabled/deferred; the fixture mechanism is not production rollout.

Stage-2 implementation clarification: query policy/B11 audit capacity is bounded
separately from held data clients. Canonical Proposal transaction owners use
invocation-scoped sanitized audit recovery after rollback/release, checking
committed ids before independent failure/denial writes; mapped externally owned
transactions require that lifecycle wrapper as an enablement condition. Domain
409/422 translation requires an explicit safe registration classifier. Agent
RunEvent compatibility is adapter evidence, never the mandatory policy audit.
These refinements do not enable production approval mappings; the enabled
cancellation pilot has no approval gate.

Stage-4 executable evidence and production enablement exclusions are maintained in
[Operation core acceptance](../architecture/OPERATION_CORE_ACCEPTANCE.md).
This includes actual process death, wire-level COMMIT acknowledgement loss,
worker reclaim, real CLI/Host bridge response loss and a historical server-source
schema check. Stage-specific and overall code/final documentation reviews have
passed both reviewers; Plan 1 is complete within the documented scope. Test
mappings do not enable any of the eight legacy Proposal writer families, and no
product deployment is implied.
