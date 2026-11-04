# Research calls and Inquiry result assessment

Current Research call and result authority is constrained by [ADR 0027](../decisions/0027-problem-engine-research-separation.md).
The problem workspace, Task boundary and [isolated upgrade](PROBLEM_ENGINE_UPGRADE.md)
are implemented. The P1 contract is a historical design archive; this guide owns
the current call/API contract.

## Identity and admission

Research uses the existing Workflow, `project_operations`, Jobs and immutable
Workflow Executions. There is no new Call lifecycle table or parallel executor.
The initial Operation is the logical invocation identity; `research_call.v1`
in `research_call_json` records Thread version, cognitive position fingerprint,
originating round/boundary, invocation Step, optional foreground source Step,
method stage, gap, typed input references, output expectations, requested scope
and trusted initiating user/Run. `research_step_id` is unique and references the
original Step through a Project/Space composite foreign key (`NO ACTION` on
standalone Step deletion). It is never chosen by kind or the earliest timestamp.

`researchProblemCalls.ts` owns admission/reconciliation adapters. Explicit
initial intake creates the Operation and bound background `invoke_research`
Step in the same transaction as existing Source provisioning. The Agent's
asynchronous `research.start_acquisition` also creates/reuses the Workflow and
binds an Operation/Step in the queue transaction, before provider planning.
The queued Job is linked to that Operation and the accepted Frame context is
pinned before planning. Material intake resumes the same
Operation and retains its immutable call/Step/round instead of starting another
logical call. Provider query planning and all Source setup still use their
existing gates. Planning failure stays on that original Operation.

Request idempotency includes instructing user/Run, Project, Thread and request
key; fingerprint comparison rejects scope changes. Repeating a Job reads its
durable outcome; if admission committed before that outcome was saved, the
rerun reports the admitted start instead of re-running preparation. Agent requests require the dispatcher’s canonical action-call
identity, namespaced by instructing user and Run; there is no Thread-id fallback.
Same-key changed payloads conflict. A new key while the Thread has an active
bound call returns `already_starting` and its Operation id only after full call
authorization and scope/version comparison. Omitted scope fields continue the
original accepted bounds; explicit changes conflict rather than widening them.
A caller unable to read an active call's inherited Thread/Run gets a generic
409 without its identity. Metadata permission alone cannot continue withdrawn
content: full content denial returns 409 and does not enqueue new work or return
`already_starting`. A legitimately replayed receipt grants no result or restart
rights. The alias receipt remains stable after completion. A fresh key after completion
starts a new call. Direct daily/incremental monitoring retains its existing path and
does not manufacture problem Steps merely because its Workflow has a Thread.

Caller options `problem_call` on initial intake accept a gap, up to 20 typed
input references, output expectations, optional initiating method stage and
expected problem versions. Scope remains the existing history/provider input;
these options cannot grant Source, credential, budget or publication rights.
The background Step does not replace the current primary or choose next work.
Step DTOs expose the actual invoke_research kind and persisted method/work/round facts.

## Attempts, cancellation and reconciliation

After material admission, existing Workflow Executions remain the attempt/pass
history. Explicit retry increments `research_attempt` once at the accepted retry
Execution; concurrent retries share that execution. Setup retry reuses the
original Operation. Pre-intake preparation uses its existing Job mechanism:
explicit retry serializes under the Project/Operation locks, reuses the call
and Step, increments the attempt once and binds a new Job. The old Job cannot
fail or admit the newer attempt because writes check `acquisition_job_id`.
Exhausted/dead preparation Jobs become explicit failed Operations through the
handler or the existing reconciliation entry. Source/pipeline internal retry,
budgets and provenance remain authoritative.

The central managed Operation state writer reconciles its exact Step in the
same transaction. Recovery re-reads current status/attempt under locks, never
trusts a terminal callback's stale payload. Only a change of the bound Step's
status (settled, abandoned or reopened by retry) advances `problem_revision`;
a new pass, attempt or Operation sub-status updates only the reconcile receipt,
so reconcile sweeps do not invalidate readers' revision tokens. Settlement locks
the Project row without requiring it to be active: an archived Project still
records how an in-flight call ended. Success ends only this invocation;
failure/cancellation abandon this execution Step and retain diagnostics and
legal partial artifacts. None of these writes accepts a judgment or closes a
problem round. A missing/inconsistent binding throws; zero updated Steps is not
success. When reconciliation owns the transaction, it attempts a pending
diagnostic only after rollback. Diagnostic failure preserves the original error.
Nested callers never write into an aborted transaction: the transaction/Job
owner must handle failure after rollback; no successful reconciliation is implied. A problem call without its explicit binding is a conflict; direct nonproblem
operations are `not_problem_call`. No historical binding is guessed.

Cancellation uses the existing durable cancelled status and queued process-stop
handler. The request reason/time is retained separately from process-stop
confirmation. Late results cannot reverse cancelled status or a superseded
attempt. Clearing old focus or archiving a Thread does not cancel an admitted
execution: its Step keeps its original provenance and settles through Research.
A user cancels that specific Operation through Research; the generic Project
Operation cancel route delegates research Operations to the same service, so it
queues the same process stop, reconciles the Step and applies the Thread change
gate. No new primary is opened.

An explicit history extension whose earlier Operation failed or was cancelled
starts a new logical call under a fresh retry key; the ended call and its Step
remain history and are never replayed or revived.

## Results and explicit adoption

`research_result.v1` contains the call snapshot, current attempt/Execution,
actual status, bounded report findings/support/references, limitations, gaps,
legal artifact pointers, canonical usage-ledger totals and failure/cancellation/
reconciliation diagnostics. Full reports remain reachable through existing
report routes. Findings carry explicit truncation when a preview is bounded.
Execution bookkeeping alone does not make a snapshot stale; Thread definition,
cognitive position or round changes mark `requires_assessment`. A late result
continues to belong to the original call.

HTTP routes under `/projects/:projectId/research/operations/:operationId`:

- GET `/result`: read the versioned result package.
- POST `/adopt-result`: explicit current-version applicability/reason,
  counterevidence and remaining gaps; writes current-round Inquiry Verify work.

Agent tools `research.read_result` / `research.adopt_result` use separately
granted `research.result.read` / `research.result.adopt` policies. Adoption is
origin-gated like other problem writes; older Run grants do not gain either
action implicitly. It atomically checks the current result attempt and both
problem versions and records an idempotent `assess_result` fact with its
Operation target, typed inputs and canonical Updates event. The fact cites at
most 20 evidence references (report archives first); the pinned Operation,
attempt and execution keep the complete result reachable. A retry/replaced
result conflicts. Adoption does not write protected cognitive fields; a further
explicit `recordIteration` remains the only cognitive writer.

Reads and adoption recheck full Thread, inherited Run, typed input, Source
connection/item consent/retention, producing Run and Artifact permissions.
Report citations are resolved through the existing reference resolver; withheld
sources do not leak through copied finding text. Agent tool returns separately
resolve original Source provenance (including report/evidence/artifact inputs)
and call the canonical fixed-Run-destination egress gate; human read access is
not treated as model-egress consent. Content-bearing Operation reads enforce the
new binding permissions too. Content-bearing Workflow projections also require
full access to their pinned Thread; new Workflows for nonshared Threads start
private, without copying or broadening grants. Stopping a specifically
authorized call remains possible after Source content permission is withdrawn;
it reads no withdrawn body and grants no restart or result access. Agent
Operation discovery can still return authorized call ids/status/Thread pointers
with a generic title for stopping them; it returns no Source-derived body. Result pointers do not grant content access.
HTTP Operation list/detail first filter bound calls by Project, full Thread and
inherited initiating-Run metadata access. Authorized calls retain their existing
full Operation projection after the full content gates pass: Workflow identity,
run kind, phase, partial flag, history limit, Steps and links remain available to
the existing workbench controls. This is not a metadata-only API for all users.

Only explicitly classified content-dependency denial (typed inputs, Source
items/connections or retention-cleared Source dependencies) degrades a bound
call to the strict metadata whitelist: id, Space/Project, status/version/time,
generic title, redacted null identity/intent fields, empty Steps/links,
`content_withheld` marker and Stop pointer. Metadata authority is rechecked
before degrading. Thread/Run denial never falls back; malformed bindings,
projection failures, SQL errors and arbitrary 404s propagate. Withheld rows do
not expose Source names, call payloads, cached progress or diagnostics, and have
no Workflow identity to attach a cached research question. Stop independently
requires write permission. Results and model egress retain full gates.

Lists use id-keyset pages of at most 100 rows (`limit`, `after_id`); a full page
returns `X-Next-Cursor`. The web client exhausts pages before sorting by recency,
so authorized older/active calls are not silently dropped. Metadata eligibility
runs in one SQL query; per-row full projections reuse existing permission and
refresh paths, including Source checks. Both bound full reads and independent nonproblem
projections therefore retain bounded per-row query costs (at most 100 rows per
page). There is no new cache or authorization relaxation.

A withdrawn or retention-cleared input, report or Artifact makes the entire
result unavailable (404), even if some other evidence remains readable. No
partial synthesis or cached report is exposed. Authorized metadata/history and
Stop remain available. Restore legitimate current authorization where retained
content exists, or explicitly request fresh research within accepted bounds;
deleted evidence is not recreated and a new request does not widen consent.

Independent Research and monitoring Operations are not problem calls: the
result route returns a conflict for them, and their reports and operations stay
under the existing Research APIs.

FINER is an optional Frame capability. Its sessions, confirmations, versions
and failures are retained, and manual assessment/query-planning routes keep
their method-specific contract. Direct acquisition builds an immutable
accepted-Thread context without synthetic FINER scores. It conservatively
inherits previously confirmed scope limits and records their source; it never
replaces the Thread wording. The internal accepted-Thread planning basis is
revalidated against current Thread version/permissions and is not an HTTP/model
approval flag. No routine monitoring or direct Task needs this process.

## Reuse and verification

Reuse / Dependency Check: existing Operation/Workflow/Job owners, transaction
helpers, canonical work-event writer, content/Source gates, report reference
resolver and `PgUsageRepository.summarizeRunUsage` supply the mechanisms. Zod and
Drizzle are installed contract/schema tools. No scheduler, graph/state-machine
library, new retry engine or external dependency is needed for these domain
bindings. Schema is authored in `projectOperations.ts`; generated migrations
0013/0014/0015 extend it without changing any applied migration or rewriting old IDs.

Real-PG identity, late-result, partial-artifact, permissions and preparation
recovery cases are in `researchProblemCallsDb.test.ts`; original acquisition and
synthesis retry fixtures additionally cover queue-to-intake continuity and
concurrent real Workflow Execution retry. Existing research, Source governance,
protocol and Inquiry consumer suites protect the retained execution chain.

Targeted repair coverage is in `researchOperationRepairDb.test.ts`: actual HTTP
metadata after withdrawal/retention, Stop, bounded pages/Thread denial, concurrent
continuations and durable aliases, canonical action identity, composite tenant
FKs and SQL-abort diagnostics. The web client covers metadata Stop and
exhaustive pagination.

## Problem workspace and page routing (P5)

Research execution is embedded in the selected problem, not another five-stage
workbench. `POST /projects/:projectId/research/acquisitions` is an authenticated
human command: the server sets manual trigger origin at the policy gate (never
accepts origin/Run identity from the body), then reuses the P3 acquisition service.
Omitted item/date limits stay omitted; the existing bounded default, approvals,
credential budget, Source authority and pipeline remain in force. Reading a page
never initializes an Area, queues acquisition, or adopts evidence.

`GET /projects/:projectId/inquiry/threads/:threadId/research-operations` pages
50 bound calls, gated by Project, full Thread and originating Run metadata
permissions. Each row uses the existing authorized Operation projection: full
progress/Workflow/partial/limit controls for full content readers, the P3 strict
metadata whitelist only on classified content dependency loss. No new metadata
exception is introduced. Withheld calls can still be stopped by an authorized
writer; result and egress remain fully gated. A running list polls reads every
five seconds; checkpoints are matched to their actual Operation.

Old page links preserve query context before navigation is reduced:

| Old page | Destination |
|---|---|
| `/research?research=new&thread=…`, `tab=focus` | `/inquiry?thread=…&section=research`; without Thread only the chooser |
| `/research?tab=standing` | `/inquiry?section=standing`: Project monitoring summary, no automatic creation |
| `/research?tab=reading|checklist|reports|runs` | `/inquiry/records`, same tab, object IDs and filters |
| `/operations` | `/inquiry/records?tab=runs`, retaining `open` and other context |
| `/research/reports/:id` | Same report object route; return preserves explicit context |

Records remain Project-scoped, including unbound and cross-problem history;
no Thread is inferred from missing metadata. Reading and Sources monitoring
retain direct entries and require no FINER/Thread. Map, candidate review and
experiments retain their existing problem views. API `/research` routes are
unchanged. Source withdrawal can withhold complete synthesized results; the
metadata/status/Stop path remains, and content needs renewed authorization or
an explicitly requested new study. No partial synthesis is reconstructed.

The records Reports tab uses `GET /research/report-page` (50 rows, explicit
cursor), not the exhaustive list. Bound report metadata and detail now
reuse the same P3 call content gate; Area metadata also uses this repository,
so it cannot bypass withdrawal with a cached report title. Only classified
content dependency loss omits a report row; Thread/Run metadata gates are
applied in the query, and unexpected errors still fail. Operation metadata and
Stop remain the recovery path when report content is withheld. Independent nonproblem
reports keep their existing reference-resolution contract.

Bound call history is ordered by persisted creation time/ID descending, so the
latest admitted call (including the Thread's sole active call) is on the first
page. Cursors remain opaque Operation IDs within that same Project/Thread.
The Reading tab exposes the existing bounded material pagination and preserves
its bounded filter/Thread/Workflow context through Reader return links.
Project Pulse's bounded bound-call projection reuses the same authorized
Operation read; attention notices use only source-free bound-call metadata.

### Standing and report publication boundaries (P5 repair)

The Problems header's Monitoring overview mounts the existing Standing panel at
`section=standing`, with daily comparison budget, recent inflow, explicit advice
creation/dismissal and failed-batch retry. Project write authority and lifecycle
gate actions; read-only viewers retain the summary. This Project summary does
not select or create a problem and does not duplicate the Focus workbench.

Area initialization selects only unbound report candidates and retains their
existing report gate; an unreadable bound result cannot block creation of a
clean Area or fallback to an older legal unbound baseline. Idea-review
checkpoints use the same report call gate as report detail. Bound reports are never automatically copied into shared
Project Notes, including when the initiating author can read them: authorization
to read a result is not publication authorization. Materialization follows the
same rule. Independent nonproblem reports retain their domain publication behavior.
Research archives are system outputs, not independently published snapshots;
see [Artifacts](ARTIFACTS.md). Withdrawal leaves metadata/Stop recovery, never
cached report/idea text. Unexpected errors propagate instead of being treated
as content withdrawal.

Report/call page cursors are opaque existing IDs within the authorized page
scope. Malformed, unknown, cross-scope or inaccessible cursors return 422;
clients return a received cursor unchanged. Content-withheld calls retain valid
metadata cursors; reports require the complete content gate.

## Transitive input artifacts

Full call/result/report reads validate all originating input Artifact dependencies,
not only the immediate copied Artifact ACL. The shared Artifact gate uses a
bounded recursive PostgreSQL UNION (cycle deduplication, 201 identities to detect
the 200-distinct-Artifact limit), batches existing Project/Thread/Run metadata
predicates with provenance lookup, then uses the same canonical typed-reference
and Source content checks as a direct call read. Reference groups remain scoped
to the owning Project and at most 40 per query; no cached grant or new ACL exists.
A denied leaf withholds derived content, while the current call's own authorized
metadata and Stop retain their existing behavior. Malformed bindings/oversized
graphs fail with a reconciliation conflict, not successful partial synthesis.
The traversal is a read query, not another operation lifecycle or repair writer.

Model egress is separate from human read entitlement. Result egress reuses the
same validated input-Artifact origin set and applies the existing per-operation
Source/target-owner egress policy once to each proven origin (deduplicated by
Operation identity). A readable leaf marked internal_only still refuses model
egress. This performs checks only; it creates no Run, spends no new budget and
does not invoke a provider. Unbound history retains its existing policy path.
