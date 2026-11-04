# Problem engine cross-domain acceptance

This guide maps the implemented first-version behavior to reproducible checks.
The implementation and final whole-plan independent reviews are complete.
Subsequent test-only cleanup removed old-model adapters, dedicated archives
and imported stage events. This is not production or real-model acceptance.
[ADR 0027](../decisions/0027-problem-engine-research-separation.md) owns the
architectural decisions; current APIs belong to [Inquiry](INQUIRY_PROBLEM_ENGINE.md),
[Research](PROJECT_RESEARCH_CALLS.md), [Task/Board](TASK_BOARD_MODEL.md) and
[Project Work](PROJECT_WORK.md). The P1 contract is a historical design archive.

## Twelve observable scenarios

Run named server files from `server/` with REQUIRE_TEST_POSTGRES=true. The new
`problemJourneyDb` is a durable integrated journey, not a mocked read model:
it uses canonical Task creation/status/completion, Inquiry association/work/
round commands and Board reads. Its Run is an external-execution fixture; no
model execution is claimed. Existing focused tests remain valid independent
invariants; the complete suite supplements this mapping rather than replacing it.

| # | Behavior and concrete evidence |
|---|---|
| 1 | `problemJourneyDb.test.ts`: direct Task in-progress→canonical complete before any Thread exists; no Step, Loop or Research created. Completion records its existing evaluation-override semantics, not fabricated review. |
| 2 | Same journey: three Tasks in inbox/ready/blocked, another problem references the same Task; Board/canonical Task/association status agree before and after completion. `inquiryTaskAssociationsDb` adds concurrent many-to-many/permissions. |
| 3 | Same journey selects Act and explicitly skips Plan without Research, then returns to Plan. `researchProblemCallsDb` invokes the existing capability with the same problem method and preserves the originating round. |
| 4 | Same journey closes without change and replays once, with Task input/reason and zero Iterations; `inquiryProblemEngineDb` checks Updates and append-only compensation. |
| 5 | Same journey keeps return history into round 2 with no inherited output flags. `inquiryProblemEngineDb` separates actual input/output/acceptance; `inquiryProblemReadModelDb` covers persisted current-round facts. |
| 6 | Same journey completes every linked Task while both problems stay active, then blocks work without changing cognition/round. `inquiryTaskAssociationsDb` adds a linked failed Run and settlement isolation. |
| 7 | `researchProblemCallsDb`: current snapshot becomes requires_assessment after position-only revision; late completion stays in its original round. Adoption uses explicit Verify/cognitive authority, never execution success as judgment. |
| 8 | `researchProblemCallsDb`, `researchOperationRepairDb`, `inquiryProblemEngineDb`: cancel/late result, same-call retry/attempt fencing, dead preflight recovery, same-key replay/payload conflict and concurrent closeout. |
| 9 | `problemWorkspaceRepairDb`, `researchOperationRepairDb`, `inquiryTaskAssociationsDb`, `researchProblemCallsDb`: Task/Thread/Run/Source/report/egress gates and metadata-only Stop. `researchGroup` adds a private leaf reached through an input-Artifact graph; full report/call/archive reads must all refuse derived content. |
| 10 | `problemUpgradeDrillDb` verifies the formal migration and backup/restore, removal of old-model tables/events, preservation of normal Task identity and normal history ACLs. `problemWorkspace.browser.ts` opens old report/operations/run links and unbound history without guessing a Thread. |
| 11 | That Chromium journey runs Project mother navigation→problem→Task→Open question, browser back, normal Research progress/limit controls, Standing actions and old links, desktop and 390px narrow. Screenshots are actually inspected by the implementer; fixture/no-production boundaries remain explicit. |
| 12 | `projectWorkActionsDb`, `taskAssociationRepairDb`, `planGraphExecutionDb`, `projectResearchStandingDb`, `researchAreaDb`: explicit batch/ordinary-create limits and links, required-output acceptance, review notifications, responsibility/actor/Run provenance, independent Plan and routine monitoring. Full-package regression is required at the final gate. |

## API and tool use

Read IDs through their actual authorized list/read endpoint. `inquiry.list_threads`
is a compact bounded summary; `inquiry.read_problem` exposes bounded full history
and returns expected version/revision. Inspecting a stage or changing a page tab
writes nothing. Use `inquiry.record_work` for explicit method selection, work,
skip/return or references. The open primary Step alone owns current next work.
Use `inquiry.link_task` / `inquiry.list_tasks` / `inquiry.reference_task_result`
for canonical Task links/results; no Task copy or method status is introduced.

`inquiry.close_round` closes unchanged work using explicit expected versions and
idempotency identity. A cognitive conclusion uses the guarded conclusion path
with explicit round intent. Candidate adoption and cognitive undo remain
position-only. `research.start_acquisition` reuses bounded admission/approval/
Source policy, and omitted limits stay omitted. `research.read_result` reports
applicability; `research.adopt_result` explicitly assesses in Verify. A successful
research execution neither settles the problem nor completes Tasks. Task actions
use `task.set_status`, completion/review and canonical outputs; removed stage
calls have no active action/HTTP handler and never translate to Board status.

`task.create_batch` is for the person's explicit list, with its existing 100-item
per-call bound and provenance/deduplication; ordinary creation keeps its turn
ceiling. Source monitoring, reading and standalone Tasks require no problem or
FINER sequence. FINER remains optional Frame work. Plan is still one Task's
execution graph; no generic engine scheduler or new execution container exists.

## Artifact graph evidence and limits

`researchGroup.test.ts` includes a separate dense-origin fixture: 202 explicitly
bound Operations and 201 output Artifacts, with independent leaf Thread authority.
It starts from canonical bindings and makes schema-valid historical-output
fixtures with distinct logical-call/Step IDs; it does not infer real history by
kind. Actual PostgreSQL EXPLAIN ANALYZE/BUFFERS, 200-distinct-node traversal,
cycle termination, 201-node rejection, leaf revocation, read-versus-internal_only-model-egress and query counts are
recorded in unique evidence directories. Material/model execution is a fixture.

The full content gate uses bounded SQL graph enumeration and the existing
metadata/reference/Source predicates; Project-specific reference batches retain
the existing 40-reference limit. There is no persistent authorization cache,
new ACL, new relation writer or parallel operation lifecycle. Egress follows the
same proven origins and retains the existing per-operation Source/target-owner
policy: human-readable internal-only material is never thereby model-exportable. Limits fail with
reconciliation diagnostics, never partially exposed synthesized text.

This fixture proves neither arbitrary branching density, many private Sources
per node, every reporting/egress graph nor production hardware latency. P6's
10,000-output/one-bound-origin sample remains a separate light-density case.
The combined evidence is a supported tested envelope, not proof of all loads.

## Reproduce and inspect

Use [COMMANDS](../COMMANDS.md) for package types/build/schema and full suites.
Run `test/problemJourneyDb.test.ts` and the mapped server files explicitly for
affected checks; `test/researchGroup.test.ts` owns the Artifact cases. Set
`PROBLEM_ENGINE_EVIDENCE_DIR` to retain unique SQL/graph evidence directories.
For Chromium, build the web app and set CHROMIUM_EXECUTABLE plus optional
`PROBLEM_BROWSER_EVIDENCE_DIR`, then run the existing
`vitest.problem-workspace-browser.config.ts`. It uses real Fastify/app.inject and
isolated PG, with peripheral auth/shell/plugin fixture responses; it makes no
real provider/egress calls. Inspect actual screenshots in mother and destination
surfaces before recording visual acceptance. A DOM/no-overflow assertion alone
is not visual acceptance.

The current Rainver action catalog has no screenshot-upload/export action that
returns a cross-Run Artifact resource ID. Run-local output collection is not an
upload acknowledgement and host paths are not cross-sandbox resource IDs. Record
actual implementer inspection and retrieval limits honestly; never claim the
independent reviewers saw pictures when they did not.

## Remaining scope

Upgrade/backups/application compatibility are owned by [the upgrade guide](PROBLEM_ENGINE_UPGRADE.md).
Production deployment, real-model execution, old-binary cutover and deep/high-fanout
stress beyond the measured envelope are not certified here. Current normal
Task/problem/Research history remains readable under its canonical ACLs. Old
Task Loop runtime, DTOs, dedicated archive schema and imported stage-event
display are removed; authorized test retirement exported dedicated old records
to private operator recovery material before removal. Applied migration SQL
and external backup/conversion archives remain version/recovery records, not
runtime compatibility. The completed temporary implementation plan and phase
reports are retired; current behavior is owned by the guides linked above.

P7 targeted repair adds mixed HTTP Artifact-list coverage: ordinary output,
healthy bound output and a readable root with a private transitive origin can
coexist. Only the dependent root becomes a generic summary; direct-origin
withdrawal removes that root from both rows and total. The measured bounded
read count applies to the **no-Source** dense fixture only. Source items and
channels still require per-origin/per-connection canonical checks; neither the
15-read ceiling nor that fixture's latency is a bound for Source-bearing graphs.
