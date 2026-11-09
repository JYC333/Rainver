# Operation execution contract

Status: permanent normative specification, owned by systemActions with the
canonical database/policy/Proposal owners. Stage-1 contract accepted in
`95d61d90`; all four implementation stages have passed their stage-specific dual
reviews. Plan 1 is complete within its documented scope: overall code and final
documentation have passed Claude/Antigravity dual review. Reviewed scope is
`3e3af010` through `c3156a48` plus this documentation-only correction.

Normative companion to [ADR 0028](../decisions/0028-operation-execution-core.md).
Current enabled APIs are documented in [SYSTEM_ACTIONS](SYSTEM_ACTIONS.md), and
executable evidence and enablement exclusions in
[Operation core acceptance](OPERATION_CORE_ACCEPTANCE.md). Do not infer completed
business-family migration from this specification. TypeScript shapes below are
specification notation, not exports. This document replaces the retired Plan 1
contract location and remains the permanent owner specification.

The accepted Plan 1 baseline enabled the metadata query and cancellation
command, for their registered user/Agent surfaces. Subsequent core registrations
are documented in SYSTEM_ACTIONS; the human-only collaboration participant
command and user-only action-grant create/revoke commands do not add any Agent
authority. Their formal REST adapters share core keys, policy decisions and
transactions with generic POST; internal authorization-request approval retains
its own admission and joins the same domain writer without recursive dispatch.
No production approval mapping is enabled by the grant family. Automation,
system-job and MCP adapters are not enabled here. Subsequent user-only
Project operation create/cancel commands also share the core; their internal
orchestrator progress writers and dedicated Research cancellation semantics
remain separately owned as documented in PROJECTS and SYSTEM_ACTIONS.
Project Board configure/exact-column movement additionally retain their existing
Agent surfaces, verified Run/person/Project identity and grants; the migrated
user adapters use the same domain transaction and revision gates.
Task status/delete and Agent-only report/complete/review/handoff now join those
same core-owned transaction and receipt rules. Human completion acknowledgement
and Agent complete/review semantics remain distinct. Task cleanup writes durable
Job intents; workers alone contact Hosts. Their internal writers join the branded
query port without recursive dispatch. Approval behavior below is
implemented through canonical services and exercised by test registrations;
production approval mappings remain off. P5 internal transition progress and
remaining writer migrations are recorded in the acceptance matrix.

## Registration and actor context

A migrated operation registers id, positive version, `kind`, allowed actors,
explicit surfaces, input/output Zod, resource resolver, policy adapter,
`tx: core_owned`, domain-error classifier and optional approval mapping. Startup
rejects duplicate ids, missing policy/schema/executor/resolver, query approval
mappings, query business effects and `self_managed` generic registrations.
Legacy definitions are not inferred to be migrated. Resource resolution after
schema normalization must be read-only and verify ownership in authenticated
Space. A raw input resource id is only a lookup candidate; input `space_id`,
`user_id`, origin, grants and approval proof never select authority.

```ts
type ActorContext = {
  principal: { kind: 'user' | 'agent' | 'automation' | 'system'; id: string };
  on_behalf_of_user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  origin: 'manual' | 'scheduled' | 'delegated' | 'continuation' | 'system_event';
  surface: 'web' | 'public_api' | 'agent_tool' | 'external_mcp' | 'system_job';
  space_id: string;
  effective_origin: string; // resolver's root vocabulary, including 'unverified'
  root_run_id: string | null;
  continuation_hops: number;
};
```

The internal server context additionally carries verified identity/token/grant
references, lineage/budget evidence and the resolved resource/audience closure;
none is accepted from operation input or returned as domain output. The same
context is passed per invocation to a process-level executor; no singleton may
retain it, its Run, or its transaction client.

| Caller | Construction and policy identity |
|---|---|
| Session user | principal and on-behalf id equal authenticated user; no Agent/Run; immediate and effective origin manual; active Space membership required |
| Agent Run | principal/agent equal stored Agent id; Run and instructing user loaded from server; immediate Run origin translated explicitly; effectiveRunTrigger supplies root person/origin; immutable Run grants plus live reach/token expiry required |
| Automation | stored automation principal and responsible person, explicit scheduled cause/capabilities; never infer manual from an owner id |
| System Job | registered service principal and stored Job cause/scope; null person only for explicitly service-capable operations; system_event is never manual |

A delegated/continuation Agent uses the resolver's verified responsible person,
not the Room creator, manager or Agent owner. If that differs from an existing
Run's supposed instructing identity, fail closed rather than broadening reach.
Rootless/broken chains remain unattended; person-required operations reject a
null responsible person. Known legacy root vocabulary is preserved in
`effective_origin`, not coerced to one of the immediate actor origins.

The complete translation of the seven writable Run origins in
`packages/protocol/src/common.ts:RUN_TRIGGER_ORIGIN_VALUES` is:

| Stored Run trigger_origin | Immediate ActorContext.origin |
|---|---|
| `manual` | `manual` |
| `automation` | `scheduled` |
| `autonomous` | `system_event` |
| `job` | `system_event` |
| `system` | `system_event` |
| `delegation` | `delegated` |
| `continuation` | `continuation` |

This is a provenance translation only: an autonomy tick is an unattended system
event, not proof of a calendar schedule. Policy still consumes the separately
verified effective root (`automation`, `autonomous`, `job`, etc. are preserved).
Unknown immediate or resolved root values fail closed before dispatch; do not
default them to manual, scheduled or system_event. The resolver's explicit
`unverified` sentinel remains an unattended result, never attended authority.
The protocol also accepts legacy `user`, `api`, `workflow` on read only; this
actor builder refuses them as execution origins rather than inventing aliases.
Existing record decoding is unchanged. All seven mappings, legacy/unknown
execution refusal and root inheritance are protected by the executable evidence
linked in [Operation core acceptance](OPERATION_CORE_ACCEPTANCE.md).

Sessions keep existing Origin/Sec-Fetch-Site CSRF checks. No arbitrary public
API token scheme or MCP implementation is introduced. Internal-only calls use
an explicit internal context; the absence of a public surface is not authority.

## Policy and transaction sequence

1. Resolve registered supported version and enabled actor/surface. Authenticate
   and check current reach before disclosing operation/resource existence.
2. Parse/normalize input using its Zod schema; resolve server-owned scope and
   applicable access/Source/audience/precondition dependencies. A failure returns
   no private validator detail before authorization. Invalid schema input never
   calls a business executor, reserves a command key, creates a Proposal or
   consumes domain attempt allowance; see the explicit legacy exception below.
3. For a command, require key and begin a core transaction. Try the scoped
   advisory transaction lock first (the same lock is used by replay, approval
   decisions and cleanup). Failure returns 409 without waiting or executing.
   Then lock any linked Proposal followed by the existing request row, before
   acquiring authorization/resource closure locks. An absent request has no row
   lock; its later insert remains protected by the key lock and unique constraint.
4. Lock the authorization/resource closure using owning-domain lock order, then
   evaluate current policy via a transaction-aware PolicyGateway port. A pure
   preliminary evaluation may happen earlier; it is not a durable decision.
   Revalidation in this transaction is authoritative. Write one final operation
   decision record per invocation; a denial uses the controlled independent audit
   path after business rollback. Required audit failure withholds any result.
5. Under reservation, reconcile a pending request against its locked linked
   Proposal as specified below, then compare existing request fingerprint and
   return its
   authorized result or dispatch new work. Current deny always wins over replay.
   Current require_approval prevents new execution. An already terminal success
   or failure may replay if access still permits: never create a new Proposal
   for completed work. A changed execute gate alone does not require approving
   historical work again. Visibility checks still control release.
6. New allow: insert the provisional request and savepoint; execute domain work,
   validate output, write mandatory operation outcome audit/Job intents and
   terminal outcome, commit. New require_approval: validate mapping, atomically
   persist Proposal + pending request and audit, commit; no business mutation.
7. After commit, notify workers/SSE. Catch/report hook failure internally while
   returning the committed result. A connection lost during COMMIT returns an
   infrastructure error with the same key retry instruction; do not assume
   rollback succeeded or run business work again in that invocation.

The common lock order is key try-lock → linked Proposal (if any) → existing
request row (if any) → authorization/resource closure in owning-domain order.
All command, replay, approval and cleanup paths follow it. Within each operation,
its domain resolver specifies canonical closure lock order and participates in
existing membership/audience mutation locks; locking a missing grant row alone
cannot prevent a new audience member. Approval paths that own a Proposal lock
must first resolve the immutable request link without locking, acquire the key
lock, then Proposal, request and domain closure locks in that same order. Adapt
canonical apply/decision ports before enabling this mapping; do not invert
locks by calling a top-level operation inside an already-locked applier.

### Controlled transaction port and legacy helper compatibility

The core issues a host-branded, invocation-scoped query-only transaction port,
not a structurally truncated `PoolClient`. It has no `connect`, `release`, pool
lookup, BEGIN/COMMIT/full ROLLBACK or transaction ownership; core-owned savepoints
use a separate private host port. Domain savepoint statements are supported only
through host translation to private scoped names; they cannot target host/core
savepoints. Repositories receive only the query port; canonical
Proposal apply joins the same raw client through a private owner-controlled
bridge, not a new top-level transaction. The core alone retains/releases that
raw client and invalidates the branded port on exit.

`withQueryableTransaction` first recognizes the host-issued active transaction
brand. Its legacy fallback recognizes checked-out pg clients by `release()` and
otherwise joins when `connect` is absent. The branded query-only port has neither
method and joins the existing transaction without entering the pool branch.
Do not merely remove `release` while retaining `connect`: that shape can issue
an unintended BEGIN/COMMIT. Preserve existing raw Pool/PoolClient behavior for
legacy callers and reject expired/branded-port misuse. Real-PG tests must prove
nested service calls use the same backend/transaction, no nested BEGIN/COMMIT
occurs, and outer rollback removes all nested writes. Passing an interface or
brand does not sandbox trusted in-process code; imports/pool escape remain
review/static-guard and real-PG acceptance obligations.

### Legacy invalid-submission compatibility

`gateway.ts:invalidInputExecutors` currently has a dispatcher registration for
`source.material.submit` that calls `sources/materialProcessing/submission.ts`
on invalid schema input, after the existing Run-bound policy gate. That service
checks active Run/grants/bound processing context and live Source policy,
commits a bounded submission-attempt counter even for invalid formats, then
throws `source_material_submission_invalid` (service status 422). Existing duplicate/limit
branches include `source_material_submission_already_recorded` (409) and
`source_material_submission_limit` (service status 429). These are service
statuses, not a claim that the legacy Agent wire preserves them; retain its
actual existing dispatcher/transport translation until migration. Attempts do not increment Run/model
attempts. Existing dispatcher failure events and downstream corrected-submission
handling depend on these outcomes.

Keep this family on the explicitly inventoried legacy adapter, including the
hook, its error body/codes/status translation, attempt limits, failed-attempt
records and correction behavior. No generic entry or new strict core route may
silently replace it. The new core has no invalid-input executor extension: a
schema rejection performs no domain execution or domain attempt write (controlled
security/denial audit remains distinct). This family is outside the pilots;
future migration requires an explicit domain attempt-admission contract that
preserves bounded invalid-attempt/failure-record semantics without executing an
invalid top-level command. Legacy compatibility requires preserving invalid,
limit, already-recorded, corrected-valid and unauthorized cases, including
persisted counters/failure events and absence of unauthorized content. Schema
strictness alone is not compatibility acceptance for this legacy family.

Queries open a host-owned `BEGIN READ ONLY` data transaction, run the same
current gates/row predicates and validate output. Their policy/B11 audit writer uses separately bounded host-owned pool capacity,
not the read client or a spare connection from the same exhausted data pool. Required B11 access audit
must finish before returning content. No progress writes, consent creation,
quota use, Job enqueue or hidden command is allowed in a query. A query whose
existing service writes access audit must migrate to the controlled audit port
before becoming a generic query. Output and stored replay bodies are sanitized
and reauthorized for the destination; retention/egress changes may suppress a
previously stored body. New generic GETs never serve shared caches or unchecked
304s. Authorization is evaluated at the protected data read/mutation, not assumed
to remain forever valid after response delivery.

Mandatory command operation audit is separate from the best-effort RunEvent hook.
PolicyGateway accepts an injected transaction audit port; successful
decision/outcome records join the command transaction. B11
read audit and independent denial audit keep their distinct semantics. On a
confirmed full rollback, a controlled independent failure audit records the
invocation without success or business content; it must not duplicate a committed
operation decision. COMMIT uncertainty must first resolve the invocation/request
record before any reconciliation audit is appended. Never
pretend a separate pool statement rolls back with executor writes.

## Key, fingerprint and durable states

Unique request identity:
`(space_id, principal_kind, principal_id, on_behalf_of_user_id,
authority_scope_id, operation_id, idempotency_key)`.

Encode null distinctly (SQL NULLS NOT DISTINCT or explicit non-null tagged
encoding), never an empty-user wildcard. `authority_scope_id` is a stable
server-resolved opaque context identity: Project plus conversation/Room audience
identity for Room calls; Run identity for genuinely Run-bound operations;
explicit member/service scope otherwise. Scope identifies the audience, not
its current membership revision: revocation must deny a retry, not allocate a
fresh key namespace and repeat work. Resource targets within that scope belong
to the fingerprint; changing target within the same scope yields 422. Different
Rooms/principals remain separate. Transport/surface is not a namespace.

Use PostgreSQL `pg_try_advisory_xact_lock` on a domain-separated deterministic
hash of that tuple, then a unique row constraint on the full tuple. Hash
collisions may cause conservative temporary 409s, never merge rows or replay
another identity. Key length/format is bounded transport input. Replaying across
transports requires equal actor and scope as well as key.

### Explicit retry key propagation

The CLI implements `rainver call <action> --idempotency-key <key> [input]`
without changing the action's input schema. The invoking client/person chooses
and retains the key before the first attempt, then supplies the same key,
operation version, input and actor/scope for a deliberate retry. A new model
call without an explicit reused key is a new intent; equality of action/input
or similar model utterance never infers retry. The CLI never automatically
reinvokes a write on a timeout, 409, lost response or restart. Core durable dedupe
applies only to migrated commands; legacy families keep their own semantics.

The implemented chain is CLI option → distinct `ToolRequest.idempotency_key` →
direct HTTP or file bridge/Host forwarding → `Idempotency-Key` header →
Run route/CanonicalToolCall.id → executor scoped key. `ToolRequest.id` remains a
fresh transport correlation UUID per attempt, including explicit-key retries,
so bridge filenames and in-flight response correlation never collide. The parser
and Host bridge validate/preserve the explicit key independently of that id.
The additive bridge capability file advertises explicit-key support. With an
older Host lacking that capability, the CLI refuses before sending the write;
it never silently substitutes a UUID for the explicit key.

With no explicit key, the CLI uses its fresh correlation UUID for that invocation;
the legacy Run route also generates a UUID if the header is absent. Running the
command again is therefore a new call, not a response-loss retry. New generic
command entries require the header. No existing grant or legacy retry contract
is widened by this transport option.

[Operation core acceptance](OPERATION_CORE_ACCEPTANCE.md) links actual CLI/HTTP/
file-bridge response-loss and process-death evidence for the cancellation pilot,
plus same-key replay, concurrent 409, changed-input 422, distinct correlation ids,
old-Host refusal and fresh-call behavior. These local executable checks do not
claim deployed old-Host/image or mixed-version rollout acceptance.

### Stable request fingerprint and separate approval preconditions

Fingerprint SHA-256 over a versioned canonical JSON encoding of only the
operation version, normalized caller-supplied input and stable resolved target
IDs (within the authority scope). Never include server-observed resource
versions, status, audience membership revisions or other mutable preconditions.
A caller's explicit `expected_version` is part of its input and remains included;
a server-read current version is not. Object keys sorted recursively; arrays
ordered; explicit null retained; undefined omitted only by the registered
normalization; reject non-JSON values. Schema defaults must be deterministic
across retries; no current timestamp or mutable-state default in the fingerprint.
Exclude request ids/surface. Keep stored version/encoding version to avoid
reinterpretation after upgrades. Exact supported stored version may replay;
same key with different version, normalized caller input or stable target IDs
is 422, never a new namespace. Removed stored version returns
`operation_version_unsupported`; it does not run the latest implementation.

For example, cancellation moving a target from version 8 to 9 must not change
the fingerprint of the same-key, same-input retry. Reauthorize current result
visibility, then replay the terminal output without rerunning mutation/version
preconditions. Server-observed versions and other preconditions are stored
separately only when freezing a pending approval, and compared on acceptance for
drift/supersession. They are not recomputed into the request fingerprint on
pending or terminal retry. Real-PG acceptance covers a successful version
increment followed by replay and fixture pending-approval version drift; see
[Operation core acceptance](OPERATION_CORE_ACCEPTANCE.md).

| Durable request state | Stored data | Allowed transition |
|---|---|---|
| absent | no committed row | new allow → succeeded/failed; mapped gate → pending_approval |
| pending_approval | frozen request, one same-Space Proposal link, no execution result | accepted apply → succeeded/failed; reject → rejected; expired → expired; stale/superseded → superseded |
| succeeded | validated sanitized domain output + original success HTTP status | retention cleanup only |
| failed | classified sanitized deterministic error + original HTTP status | retention cleanup only |
| rejected | linked Proposal rejected, no business output | retention cleanup only |
| expired | linked Proposal no longer actionable, no business output | retention cleanup only |
| superseded | frozen input/version/precondition no longer applicable | retention cleanup only |

There is no durable `in_progress`/`accepted` request state. Execution is only a
transaction-local reservation; accepted is a Proposal decision, not an extra
opportunity to execute the request. Pending retries return the same Proposal.
Terminal states never transition back to executing with the same retained key.

Only a registered domain classifier makes an error replayable. Roll back
executor savepoint writes, then persist the error/outcome audit and failed state.
Invalid output, mandatory audit/enqueue failure, SQL errors, deadlocks, timeouts
and unknown exceptions roll back the transaction with no cached failure. A
COMMIT uncertainty is resolved by a later same-key invocation. Business state
and a success request can never be committed independently.

Retain terminal rows seven days from terminal time, including decisions made
long after pending creation; cleanup takes the same try-lock and rechecks state
and timestamp. Never purge actionable pending rows. Expiry is evaluated on
retry/decision and scheduled cleanup under those locks: existing Proposal
`expired` is a derived read property, not a new stored Proposal status. Expiry
terminalizes the request and leaves the original Proposal unacceptably expired.
Supersession uses the existing Proposal superseded status. After cleanup a key
is a new request; long-lived business uniqueness remains the domain's duty.
Sensitive result retention may be shorter: redact/delete its body and return
`operation_result_unavailable` until key expiry, never re-execute to reconstruct it.

## Approval mapping and resolution

Each enabled mapping is a code-owned registration with: gate reason, existing
Proposal type, strict payload schema, freeze/preview builder, approver resolver,
input/version/precondition validator and transactional resume/apply function.
Mapping absence is not permission to create an unapplyable Proposal.

Gate reason is a discriminated value: `hard_gate` plus an existing
`SystemActionGateClass`, `unattended_origin` plus the policy rule id, or
`explicit_checkpoint` plus the owning workflow checkpoint. Do not add an eighth
hard-gate class or let an operation nominate an arbitrary bypassable policy rule.
Only server-created, transaction-local approved context names the satisfied gate.

Frozen request envelope (stored with the request, linked from the domain Proposal):

```ts
type FrozenOperationApproval = {
  request_id: string;
  operation_id: string;
  operation_version: number;
  input_fingerprint: string;
  normalized_input: unknown; // narrowed by the registered input schema
  resource_scope: unknown;   // narrowed by the registered resolver
  requester: ActorContext;
  gate: { kind: 'hard_gate'; gate_class: string }
      | { kind: 'unattended_origin'; rule_id: string }
      | { kind: 'explicit_checkpoint'; checkpoint_id: string };
  preconditions: unknown;    // separate server-observed approval snapshot; NOT input_fingerprint
};
```

The public operation input never carries this as proof. The linked request is
the immutable authority; Proposal edits that disagree with it are stale. Existing
Proposal payload shape is preserved; any new link is server-managed metadata.
The link must be one-to-one, same Space, unique on each side. Payload hash is
verified at acceptance. Existing domain payload validators may be permissive;
the new mapping must enforce its own strict frozen projection as well.

Business migration inventory (no production approval mappings are enabled):

| Operation | Current payload/applier | Core migration decision |
|---|---|---|
| `research.cancel_acquisition` | none; direct `ResearchOperationCancelService.cancelOperation` | enabled production pilot; no approval mapping. `research.acquisition.cancel` is outside the current origin-gated set; do not add a stop approval. An unexpected require_approval fails with mapping unavailable |
| `source.backfill.preview` / `create_plan` / `pause` / `resume` | existing SourceBackfillPlanningService through the transaction port | enabled user-only ordinary family; preview metadata query, explicit-key commands with live Source/Project authority, separate domain uniqueness and atomic audit/receipt. No approval mapping or execution/egress permission |
| `project.source.bind` / `update` / `unbind` / `backfill` | canonical ProjectSourceBindingService and routing | enabled user-only ordinary consumption family; active Project/current Source delivery checks and atomic derived writes/audit/receipt, with no activation approval or Agent authority |
| `source.backfill.propose_start` | `source_backfill_start`, payloadSchemas + registerSourceBackfillProposalAppliers → SourceBackfillExecutionService.start | existing money gate and canonical apply; remain legacy until request linking/output/authority revalidation are migrated. Approving must start that frozen plan, not file a second proposal |
| `project.propose_definition` | `project_brief_publish` → registerProjectDefinitionProposalAppliers → ProjectKernelService | direction gate; preserve existing domain applier and requester/approver provenance. Unmigrated legacy family; not enabled by Plan 1 |
| other require_approval operations | only the currently registered domain payload/applier is eligible | unsupported origin/checkpoint resumption remains fail-closed until an operation-specific schema and canonical applier are registered; no catch-all resume-any-id proposal |

Gate metadata cross-check against `packages/protocol/src/systemActions.ts`
(all non-null registry gate classes in the inspected source; not new mappings):

| Existing operation | Registered gate_class |
|---|---|
| `source.channel.propose_activation` | `money` |
| `project.monitoring.propose` | `money` |
| `project.monitoring.propose_details` | `direction` |
| `project.source.propose_bind` | `money` |
| `project.propose_definition` | `direction` |
| `source.backfill.propose_start` | `money` |
| `task.plan.propose` | `direction` (conditional proposal) |
| `inquiry.promote_knowledge` | `exposure` |
| `note.promote_to_knowledge` | `exposure` (objectAction helper) |

The cancellation and pause/resume candidates have null gate_class. Memory's
conditional domain gates still follow ADR 0003; a null registry gate does not
exempt those domain checks. Core registration compares a mapped hard gate to
the canonical registry value; unknown/mismatched gates fail closed. Do not
infer exposure merely because an operation is Source-related.

### Mapping eligibility: atomic effects, not compensation

Existing `ProposalApplyResult.rollback` and `ProposalTransactionResult.rollback`
compensate external effects; applyService can invoke them during error recovery,
and its top-level wrappers may run postCommit/rollback outside the transaction.
Presence of `acceptInTransaction` is therefore not proof an applier is atomic.

Before enabling a core-owned mapping, registration must declare and review its
entire effect path as transaction-only writes plus durable Job intents. Exclude
appliers that depend on rollback compensation, independent commits or required
postCommit effects. A postCommit callback is eligible only as a documented
allowlisted rebuildable notification, with all required work already durable;
a dropped/failed notification cannot change the result. The private apply bridge
must reject unexpected compensation callbacks or unclassified required effects,
roll back the database work and flag a contract violation; runtime rejection is
not evidence that an already-performed external effect was undone. Code/effect
review is mandatory before registration, alongside real-PG failure/commit-loss
and lost-notification tests. Ineligible appliers remain legacy/self-managed;
they need their own separately reviewed recovery acceptance and still cannot
claim this core's all-or-nothing guarantee or enter its generic routes. No such
exception is enabled in the current core. Existing mapped-candidate names above are
inventory, not a declaration that their complete effect paths passed this gate.

### Reconcile linked Proposal state before pending replay or decision

Retry, accept/reject, expiry and cleanup must inspect the actual linked Proposal
under the common key → Proposal → request → authorization/resource lock order,
revalidate current access, then reconcile atomically before returning pending or
executing. A pending request is not proof its Proposal is still actionable.

| Actual linked Proposal while request is pending_approval | Required reconciliation, without business execution |
|---|---|
| pending, unexpired, valid mapping | remain pending; normal human decision may proceed |
| rejected | request → rejected |
| superseded | request → superseded |
| pending and expired by expires_at, or a recognized expired projection | request → expired; derived expiry still prevents acceptance |
| accepted | verify the matching atomic terminal result as described below; never execute or infer success from Proposal status alone |
| staged, rolled_back, missing, wrong-Space, broken link or unknown status | fail closed as inconsistent; no 202, no execution, no cleanup of evidence |

Respect explicit rejected/superseded status before derived expiry. Terminal request
records remain immutable: reconciliation never overwrites an existing classified
failed result with superseded merely because its Proposal is superseded. Later
rollback of an accepted business change is a separate domain action/history;
it never resets the original request to executable.

For accepted, re-read/verify the same linked request's committed terminal result,
matching operation/version/fingerprint and Proposal, validated output/status,
mandatory audit and required Job intents. Only an existing atomic terminal
record authorizes replay (a retained terminal record with a legitimately removed
result body follows the existing 410 contract). Receipt of a Proposal id, legacy accept result or a
current business row cannot reconstruct that evidence. If the request is still
pending, the atomic pair is missing: return
`operation_approval_state_inconsistent` (503, retryable false), preserve request
and Proposal for operator investigation and withhold success/pending. Do not
fabricate a terminal success, synthesize a result, enqueue work or rerun the
applier. A concurrently finalized pair observed after locks is handled as normal
authorized terminal replay. This is detection, not a repair licence.

Mapping enablement must first inventory and adapt every Proposal status writer,
not only canonical accept/reject. In particular,
`applyService.ts:releaseRejectedSourceChannelDraft` supersedes dependent Proposals
with a bulk UPDATE, and `projects/projectDefinitionProposalService.ts` supersedes
an earlier definition directly. Once either affected Proposal type is mapped,
those paths must update its linked request in the same transaction through the
canonical transition port; no mapped direct UPDATE bypass remains. Unmapped
legacy Proposals keep their current behavior.

For a cascade affecting several mapped requests, pre-resolve the complete set
of dependent Proposal/request links without row locks; acquire all key try-locks
in sorted full-scope identity order before any Proposal locks, then all Proposal
rows in stable id order, request rows in stable id order and domain closure locks.
Revalidate the dependency set under locks. If the set grew, abort that transaction
with a conflict, without partial status writes; do not acquire new key locks
after row locks or automatically rerun the write. All dependency-creation and
status writers for enabled mappings must share the owning dependency/closure
lock protocol so unobserved new edges cannot race the cascade. Existing legacy
code does not implement this protocol. Enablement is blocked until all affected
writers and their concurrent real-PG tests join it. Retry/cleanup reconciliation
is a defensive backstop, not a substitute for atomic mapped status transitions.

An operation whose purpose is proposing a domain change may return a pending
outcome for that domain Proposal on the allow path. Its mapping distinguishes
`proposal_submission` from `blocked_command`: the former's business change is
the canonical domain applier, the latter resumes the frozen command. Neither
executes twice. Returning 202 means the requested business change awaits a
person, even if the operation's name says `propose`. Existing Agent/REST response
shapes remain on their legacy adapter until explicitly migrated.

Acceptance algorithm, after acquiring the common locks and reconciling actual
Proposal/request state above (terminal states never reach execution):

1. Canonical apply verifies visible pending/non-preview/non-expired Proposal,
   existing role/risk/owner/egress requirements and explicit human decision.
2. Using the already locked linked request, verify exactly one pending mapping,
   immutable payload,
   supported stored version, same Space and current preconditions. Re-run
   requester reach and live resource/Source/plugin policies with requester
   identity, plus current approver authority. An expired/revoked Run token may
   not replay through a transport; human acceptance need not resurrect that
   transport token or require the original Run still running. It does require
   the frozen delegation/grant scope still valid and the responsible person's
   present authority. Operations that require a live Run explicitly declare it.
3. A denied authority check refuses acceptance with no execution and leaves
   the Proposal pending for rejection/expiry; it does not convert deny to stale
   or silently transfer authorship to the approver. Version/precondition drift
   commits Proposal/request supersession without executing; transient failure
   rolls back and leaves pending for retry.
4. Invoke the registered internal apply/resume function on the same client,
   behind a savepoint, with only the named gate satisfied. Validate domain
   output; write operation audit, required Jobs, terminal request result, and
   Proposal decision atomically. Classified business failure rolls back the
   savepoint, stores request `failed`, and sets Proposal `superseded` (not
   accepted); output/audit/unknown failures roll back and leave pending.
5. Repeated/concurrent acceptance may return the already authorized terminal
   result or canonical already-decided response; it can never call the executor
   again. Rejection uses canonical reject-in-transaction and writes request
   `rejected` atomically. Expiry reconciliation locks both sides and writes
   request `expired`; existing derived Proposal expiry prevents acceptance.

Normal retry cannot satisfy a gate even if its origin becomes manual. Only
while the linked Proposal remains actionable after reconciliation does it return
the same pending outcome; a person must decide that Proposal.
Existing matching advance ActionApprovalGrants may be used only by operations
already marked grantable, consumed atomically through canonical apply. They
cannot satisfy a fresh-human gate, change approved input or bypass B43. The
execution core never offers deployment resumption from an Agent/system Job.

## Result and error transport

Core success is `{status:'succeeded', data:T}` with the registered HTTP success
status (200/201), pending is
`{status:'pending_approval', proposal_id:string}` with 202. Transport context
carries `http_status`, current `request_id`, `replayed` and current policy record
reference separately. Do not store a live request id in a cached domain body.
Queries use success or error only. A pending result is a normal Agent tool
result, not an exception. Agent adapter builds `{modelResult, summary}` with
status/code preserved in its structured metadata; legacy consumers keep their
existing envelopes until their adapter migration.

Errors: `{error:{code, domain, message, metadata, retryable, request_id}}`.
`domain` is the owning module (or `operations` for core failures), metadata is
an allowlisted JSON object, message is safe text, request_id identifies the
current invocation. Do not return SQL, Zod internals, input bodies, provider
secrets, hidden resource ids or stack traces. Preserve the HTTP status in both
HTTP and Agent translation. Domain errors extend the protocol code vocabulary
with explicit registration when implemented, not arbitrary exception strings.

| Code | HTTP | Retryable | Cached request failure? |
|---|---|---|---|
| `authentication_required` | 401 | false | no |
| `operation_not_found` | 404 | false | no; uniform for unknown op, hidden actor/surface, cross-Space/resource access, denied policy or result visibility |
| `operation_version_unsupported` | 409 | false | no new record; preserve old key binding |
| `operation_invalid_input` | 422 | false | no |
| `idempotency_key_required` | 422 | false | no |
| `idempotency_key_reused` | 422 | false | no; leave original intact |
| `idempotency_in_progress` | 409 | true | no |
| `operation_approval_mapping_unavailable` | 503 | false | no; configuration failure, no Proposal |
| `operation_approval_state_inconsistent` | 503 | false | no new failure; preserve inconsistent pair/evidence, never execute |
| `operation_approval_rejected` | 409 | false | replay terminal rejected |
| `operation_approval_expired` | 409 | false | replay terminal expired |
| `operation_approval_superseded` | 409 | false | replay terminal superseded |
| `operation_result_unavailable` | 410 | false | terminal body removed; do not execute again |
| registered deterministic domain error | registered 409/422 | false | yes, after savepoint rollback |
| `operation_limit_exceeded` | 429 | false | no; bounded admission refusal, full rollback |
| `operation_invalid_output` | 500 | false | no; full rollback |
| `operation_audit_unavailable` | 503 | true | no; full rollback/no content |
| `operation_temporarily_unavailable` | 503 | true | no; DB/Job/COMMIT uncertainty |
| `operation_internal_error` | 500 | false | no; unknown error, full rollback |

`retryable` describes same-key retry eligibility, not permission for the CLI to
automatically repeat a write. False does not prove the DB
committed nothing when infrastructure failed. A client never changes keys to
resolve uncertainty. Check current authorization before returning cached error
metadata, rejected/expired/superseded status or a pending Proposal id. Unauthorized
callers always get the content-free 404 regardless of stored state. Only a
caller already authorized for the operation may learn a missing implementation
or mapping diagnostic.

## Permanent acceptance invariants and enablement boundaries

[Operation core acceptance](OPERATION_CORE_ACCEPTANCE.md#executable-matrix) maps
these invariants to current executable tests, recorded verification and scope
limits. It is the evidence index; the obligations below do not claim every
business family has migrated. In particular, approval tests use real canonical
Proposal services with test-only mappings. All production mappings remain off;
the [eight legacy writer families](OPERATION_CORE_ACCEPTANCE.md#approval-enablement-boundary-eight-legacy-writer-families)
still require their full effect/status-writer closure migration before enablement.
Use shared real PostgreSQL fixtures for durable behavior, never fake Queryables.
A missing PG run is skipped verification, not passing evidence. Historical-source
cutover checks are local additive-schema evidence, not deployed old-image proof.

| Invariant | Acceptance obligation (current evidence and exclusions linked above) |
|---|---|
| Actor/origin | all seven Run-to-immediate-origin mappings and unknown-value refusal; session manual; Run delegation and continuation effective root; absent/cyclic/wrong-Space lineage and exhausted continuation; same Agent acting for different people, personless service refusal, no singleton context leakage |
| Authorization | expired tokens, membership revocation, distinct Rooms, Source withdrawal, destination/row visibility, including pending/error/success replay; no unauthorized body, metadata or Proposal id |
| Transaction | branded port joins nested withQueryableTransaction on same backend/transaction without nested BEGIN; compensation/required-postCommit mappings refused; notification loss safe; executor/output/audit/Job failures leave neither writes nor success; classified failure savepoint removes writes but records sanitized failure; escaped pool/COMMIT attempt rejected and cannot leak writes |
| Dedupe | successful write increments resource version yet same-input retry replays; explicit CLI key preserved across HTTP/bridge with distinct correlation ids; no automatic write retry; new invocation gets new key; old Host explicit-key refusal; same key replay; changed input/target/version → 422; removed version → explicit conflict; duplicate while first holds lock → immediate 409; null scope encoding and authority isolation |
| Crash | kill real executor process before commit and after commit/before response; retry shows no duplicate writes or stuck executing rows; COMMIT uncertainty resolved by stored key |
| Retention | seven days from terminal decision; pending retained; expiry/accept/reject/cleanup races cannot execute twice; redacted body gives 410 without re-execution |
| Approval | dependency/direct supersession updates linked requests atomically; retry/decision/cleanup reconcile rejected/superseded/expired; accepted-without-atomic-result fails closed and never executes; cascade/accept/cleanup races follow multi-key lock order; one Proposal per key; mapped canonical apply once under concurrent decisions; stale → superseded; reject/expiry/revocation/missing mapping cannot execute; mandatory output/audit rollback preserves pending |
| Query | actual PostgreSQL read-only transaction rejects a write; no consent/progress/Job effects; cross-person B11 audit before release and failed audit withholds body; no unchecked GET/304/cache response |
| Reliable effects | cancellation status + reconciliation + cancel Job commit together; failure before enqueue rolls back; kill after commit before wake leaves worker-discoverable Job; worker retries safe |
| Adapters | legacy source.material.submit invalid/limited/duplicate/corrected/unauthorized cases preserve attempt counters, errors and failure events; new core invalid schema never executes domain work; migrated adapters really call core; one operation policy record per invocation; separate apply/content logs; old URL/body/status/UI consumers stay compatible; non-migrated families get no generic entry |
| Cutover | old/new immutable Run grants still valid without widening; additive schema works with previous server; unsupported versions explicit; no legacy table deletion or schema-epoch reset |

The Plan 1 production baseline enabled `system.actions.list` and
`research.cancel_acquisition`, neither with an approval mapping. Subsequent
registrations, including the user-only collaboration participant command, are
documented in SYSTEM_ACTIONS. Real-PG fixture
registrations exercise canonical approval integration; they prove the mechanism,
not migration of any listed legacy business operation. Future production mapping
enablement additionally requires its own payload/role/policy/precondition tests
and the complete affected writer closure. Source pause/resume was not selected
as a second pilot. Broader migration and plugin work remain program Plans 5/2.

### Public adapter and recovery invariants

The core supplies an immutable, host-authored invocation context to direct
registration execution: request correlation ID and the validated transport
idempotency key (null for an unkeyed query). This optional fourth service-port
argument is not a business DTO, model field, authority token or new key source.
An Agent command needing trusted call provenance must require that context,
combine it with the already verified Run/attempt identity in its owning service,
and retain any separate domain producer keys. Replay never calls the writer
again. Registrations that do not need invocation identity ignore the argument.

Outer transaction control remains host-only. Branded ports may translate domain
SAVEPOINT/ROLLBACK TO/RELEASE labels into private host-owned savepoints, retaining
PostgreSQL stack semantics without access to core/approval savepoints. SQL
literals/comments are not statement separators. A joined owning service must be
exercised against real PG before claiming savepoint compatibility.

Canonical Proposal decision transaction owners recover attempted transactional
policy audits only after rollback/release, independently of business writes.
Recovery first checks original persisted audit ids to resolve COMMIT uncertainty,
then appends missing sanitized failure/denial records, never business output.
Mapped external-transaction callers require the same recovery lifecycle owner;
calling only acceptInTransaction/rejectInTransaction is insufficient and fails
closed. No production mapping is enabled by this seam.

Domain error translation is opt-in at registration: explicitly recognized,
deterministic failures may become safe typed 409/422 business errors and be
cached only after rolling back the domain savepoint. Arbitrary HttpError status,
message and responseBody are not an allowlist. Unknown errors remain generic.
Agent adapter lifecycle/refusal RunEvents use the existing writer and evidence
shape; mandatory operation audit remains the transactional policy seam.


## P5 internal Proposal transition progress

The canonical DB decision and dependent Source rejection paths, direct Project
definition replacement, and monitoring scope/details replacement now join the
purpose-bound Proposal transition port. It reuses the P1 request-key lock
primitive and transaction ownership, not a second decision/apply engine.
Preflight reads freeze a candidate set; all nonwaiting request keys precede
Proposal closure gates/row locks, then request rows and domain locks.
Dependency/key-link growth conflicts instead of acquiring new keys late.
Canonical dependency creation uses the same closure gate, and pending request
attachment rechecks exact frozen payload/status/expiry under the Proposal lock.

Terminalization reads actual Proposal states in the same transaction. Acceptance
requires the mapped applier's validated atomic result, never a synthetic success
from accepted status. Existing result/audit recovery and expiry/retention key
ordering remain. Advance-grant and external code-patch rollback paths refuse a
linked request rather than bypassing its frozen mapping. Unlinked domain
semantics and authority remain canonical.

The port does not authorize mapping enablement. Frozen Memory/import payload
revision, Plan, Run and Skills status owners and the Evolution outer transaction
owner still need their complete lock/effect closure. Retry/cleanup reconciliation
continues as a defensive backstop and is not their atomicity evidence.

## Current P5-4 writer extension (not additional mapping authority)

Proposal transition admission is owned by
`systemActions/operations/proposalTransitions.ts`. A cascade or package review
admits its complete sorted request scope set before Proposal/request/domain locks;
Run recovery sorts that set globally across its candidate Spaces. Creation and
replacement join the corresponding closure gates and recheck membership after
admission. A newly observed replacement outside admission is nonretryable
`operation_conflict` (409): the caller rereads and explicitly starts a new action.
It never triggers a server write retry or late key acquisition.

Frozen pending edits preserve the old draft and request evidence: supersede both
and return a fresh review Proposal, retaining audience/provenance/deadlines but
copying no approvals or operation success. Accepted requests still require an
actual validated atomic result/receipt. Recognition of a core transaction brand
or verification of an existing BEGIN is a precondition for transaction gates;
a raw checked-out client is not itself a transaction owner.

Prepared Run terminal roots bind the exact pre-discovered Run set to the existing
expiring transaction port, admit all keys/fences before domain locks and finish
linked transitions once after domain/required Job work. Pool-owned Project
archive, Plan/Workflow reconcile, Job cancellation/exhaustion, stale autonomous
child cancellation, queued Host merge resolution cancellation and Reading provider
finalization use this boundary. A nested call cannot forge readiness or add a Run
late. Subsequent owner extensions close canonical checkpoint/Research admission,
coordinator/Room direct terminal writers and Evolution selected-member DB owners;
Evolution code-patch effects use a durable Job/receipt boundary described below. An unprepared owner must refuse linked requests before trying keys,
including linked descendants of an unlinked root.
A later reconciliation is not atomicity evidence. No production mapping or public
proposal-decision permission is enabled by these internal changes; current
qualification and exclusions are in OPERATION_CORE_ACCEPTANCE.


Current nested-owner extension (basis33466aee): canonical user acceptance admits
checkpoint/Research-history cascade and related Run Proposal requests in one
sorted set before domain locks. Nested appliers reuse the prepared transaction
closure; Research graph root entry points similarly prepare before their first
locks. Canonical fresh Run insertion records transaction-local membership and
its terminal writer requires it still unlinked. This does not authorize late
key admission, copying a receipt/approval, production mapping or public decision
permission. Evolution now reuses the same complete sorted admission for its Bundle DB owner.
Core-owned Project update/archive and Research report-snapshot commands declare
`runTerminalOwner.discover`. For a new request the executor prepares the exact
Run set before domain locks, using the real host client paired with its branded
port; a child cannot manufacture this authority. It validates output and records
the request before finishing linked transitions once, then expires the owner.
Cached replay does not prepare an owner or retire newly created work. Scope growth
is a rollback/conflict, and mandatory audit recovery remains outside the failed
transaction. This seam supplies no Proposal-decision owner or approval mapping.

The same Project continuation moves Folder create/scan/save/restore behind
private durable intents and required Jobs. Core success is an accepted intent
receipt (HTTP 202), not an assertion that external IO has completed. Only the
owning user with current Project/Folder/Host access can read its status/result.
Workers persist preimages and write intent before IO, recover an uncertain
acknowledgement by comparing exact hashes, and refuse independent changes.
`needs_attention` blocks a fresh same-scope intent. Current authority and policy
are checked again before the final short domain/result transaction. Safe
terminal cleanup must not extend the original draft/revision body retention.
An approved code-patch selection first commits a frozen intent and required Job,
executes effects without a DB transaction and commits all canonical member results
plus the receipt atomically. The private receipt is not caller input. Applying/
compensating/compensation_failed remain explicit; external visibility cannot be
rolled back atomically with PostgreSQL. Existing worker recovery performs one
bounded cleanup handoff and refuses to overwrite independent edits. See
EVOLUTION_SIGNAL_SYSTEM for the exact lifecycle. Writer tests and test-only P1
mappings do not enable any production mapping or new public decision authority.


## Human new-content placement before admission

`userContentCreation` is a server-only registration option for an ungrantable,
public-API-only, user-only draft command with no approval mapping or hard gate.
Startup rejects other definitions. It delegates placement to the access-owned
`resolveContentCreationContext`, never a registration-supplied Space resolver.
Only the authenticated manual person's Space changes: without `project_id`,
their unique active Personal Space receives private new content; with a Project,
canonical current Project read/write and active-same-Space checks apply. Caller
Space/user/Run/origin/grants never select a different principal or destination.
This creates new content; it cannot transfer existing content across Spaces.

The request actor is checked first. Inside the core transaction, placement is
resolved without domain locks before key binding. The key, policy, audit, domain
writes and receipt all belong to the effective creation Space. After reserving
the key, both original membership and destination authority are rechecked; a
changed destination conflicts instead of taking a second key. Project mutation
fences and result visibility checks still run. Audit metadata records the
browsed request Space separately. Replaying from another currently accessible
page for the same person/target shares the original target receipt. The first
registration is `source.recipe.create`; Agent/Run/system/approval paths do not
use this option.


A successful command may return HTTP202 when its canonical effect is durable
enqueue rather than completion of external work (`source.channel.scan`). The
core request is terminal `succeeded`, with a typed pending Job receipt; it is
not `pending_approval` and does not imply a completed scan. Job/receipt/audit
are committed together. Replaying that key returns its original enqueue
receipt even if the Job later advances, without creating another Job.

P5-2 Monitor creation preserves the already authenticated REST human placement:
`source.channel.create` is the only named durable exception to the human content
creation port's draft-only restriction. It stays ungrantable, user-only,
public_api-only, without approval mapping; channel/scheduler creation is DB-only.
Other durable registrations still fail that port's constructor guard. This does
not grant Agent creation, Source owner consent, activation or external execution.

P5-2 review repair: the named Monitor creation port treats an existing Source
as a same-request-Space child parent, not a request to relocate a new root. It
keeps the authenticated actor unchanged and discovers no foreign Space. Only
this named child case bypasses new-root Personal/Project placement. Parent and
Project authority are authoritatively checked after keys and before child writes;
changed parent scope conflicts. Nullable `ResolvedOperation.resourceId` carries
the existing creation policy's null resource id instead of inventing `new`.
Known create input failures use explicit owner validation types; generic helper
HTTP statuses never establish cacheable business-failure authority.

P5-2 Source rule/manual dispatch adds no external work to core transactions.
Create/update use canonical rule and managed Agent transaction writers. Run/drain
and extraction run return required Job intent receipts; worker results are read
from the existing Jobs/Source history, not fabricated in the command response.
Manual Source delivery persists its start fence and receipt in existing Job result
storage. An unknown external outcome never authorizes replay of the effect.
Production approval mappings and Agent reach are unchanged.
A Source manual dispatch may defer through the existing Jobs mechanism only for
its exact canonical pre-effect resource-claim busy error. Release only that start
marker; unrelated child errors/unknown outcomes cannot enable effect replay.
The existing Job result UI distinguishes a failed started-without-receipt Source
intent from a claim that nothing happened. User/audit/receipt isolation remains
per request principal even when another principal or automatic worker owns the
same domain extraction claim.

## Standalone code-patch effect qualification (P5-4, basis7594f2ec)

Standalone accept/rollback use a private frozen DB intent plus required Job,
not synchronous filesystem work inside an approval transaction. Admission and
final commit reuse the complete checkpoint/cascade/Run prepared owner. File IO
uses the existing safe target handles and shared Evolution effect helper outside
DB transactions. The canonical applier accepts only a trusted internal effect
receipt matching payload and current target; final domain, snapshot/history,
mandatory audit, request result and intent receipt commit together. A failed
commit rolls back DB state and starts hash-conditional compensation; unrelated
edits are not overwritten. Lost receipts resume from known exact content, not an
unconditional second execution. A stopped/exhausted Job receives one durable
cleanup handoff, and a failed cleanup requires explicit repair.

A queued decision does not consume another approval or mark its linked request
successful. Existing successful request receipts survive rollback and never point
to a new revision. Production approval mappings remain disabled. Writer/effect
closure alone does not approve a new Source/Memory/person/Agent policy surface;
those later checkpoints retain their own requirements. No current first-party
SystemAction maps/grants `code_patch`; a future action cannot use the internal
receipt capability or bypass human approval by metadata alone.

Human Note draft creation uses the existing draft-only userContentCreation seam.
Its primary_project_id is mapped to the access-owned creation context. An explicit
existing collection is a purpose-bound child exception: it inherits only its
current authorized parent in the authenticated request Space, with no global
lookup/actor-space rewrite. Parent Project drift or mismatch conflicts before
writing; startup still rejects arbitrary durable/Agent creation flags. No new
production mapping or public proposal decision reach follows from this seam.

Note object admission is a bounded collection/placement/role closure, not a
workspace-wide lock or readiness boolean. Existing append gates precede sorted
Project/folder/Note root locks; a second discovery verifies the exact set.
Canonical Note content writers use root-before-extension order for internal ops
as well as public core calls. Body-free receipts require current read authority
on their typed follow-up GET; they never authorize release of an old cached body.
