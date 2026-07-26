# Projects

## What is a Project?

A **Project** is a goal-oriented knowledge and activity container.
It organises activities, artifacts, proposals, agent runs, and owned Project Folders around a long-lived objective.
It is the stable ownership and context boundary for durable objects — not a task manager or execution environment.

## What is a Project Folder?

A **Project Folder** is a file, code, and execution boundary.
It is where agents inspect files, create sandboxes, run commands, collect diffs, and validate changes.
Capability code belongs to a Project Folder.

## Project vs Project Folder

| Concern | Project | Project Folder |
|---|---|---|
| Purpose | Goal / knowledge / context | File / execution / sandbox |
| Holds | Activities, artifacts, proposals, runs, memory | Files, repos, capability code |
| Created by | User — named objective | User or system — maps to filesystem path |
| Cardinality | One Project → zero or more Project Folders | One Project Folder → exactly one Project |
| Capability outputs | Digests, artifacts, proposals, project memory | Capability code itself |

A Project owns zero or more Project Folders directly (`project_folders.project_id`, non-null, single-owner FK) — there is no link/association table and no Folder role vocabulary.
A physical Folder cannot be shared across Projects; multiple questions/features over one repository belong in one Project as Threads, Tasks, Decisions, Experiments, or Workflows.
Capability code lives in a Project Folder; its outputs (digests, artifacts, proposals, memory) belong to a Project.

## Information flow

External information should enter the system through the canonical provenance chain:

```
Activity -> Artifact -> Proposal -> Knowledge / Memory / Card
```

Do not write external information directly into active memory.
Each step adds trust validation and human review opportunity.

## Data model

### Project

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | Immutable primary key |
| `space_id` | FK → spaces | Hard access boundary; always included in queries |
| `owner_user_id` | FK → users (nullable) | Who controls the project for ACL |
| `name` | string | Unique among active projects within the space (service-layer check) |
| `description` | text (nullable) | Optional long-form description |
| `status` | string | `active` \| `archived` \| `deleted` |
| `current_focus` | text (nullable) | Generic foreground/display focus for non-Inquiry work; Auto Research does not read or write it as a Question authority |
| `settings_json` | JSON (nullable) | Flexible per-project configuration |
| `template_key` | string | Creation-time Project Template; first-class, not stored in settings JSON; provenance only — never gates Area/capability visibility |
| `primary_mode` | string | Current presentation/progress focus; changing it does not move domain data |
| `active_brief_version_id` | FK → project_brief_versions | Current immutable Brief version, constrained to the same Project/Space |
| `created_at` / `updated_at` | datetime | Standard timestamps |
| `archived_at` | datetime (nullable) | Set when archived |
| `deleted_at` | datetime (nullable) | Soft-delete marker |

Archiving is a centralized, transactional lifecycle operation. It preserves
historical Tasks, Runs, Artifacts, Memory, and Corpus content, while pausing
active Automations, Project Source bindings, and Source post-processing rules,
pausing the active research workflow, cancelling non-terminal managed research
operations, and cancelling queued/running Workflow Executions while blocking
all non-terminal nodes, cancelling their queued/running Jobs and child Runs,
and terminalizing the coordinator Run so no reconciler can continue the
archived Project or leave a permanent `waiting_for_dependency` record.
Reactivating a Project does not automatically resume any of those components;
each must be reviewed and resumed through its owning module.
Project-scoped mutation gates reject writes while the Project is archived;
only the centralized Project lifecycle update/archive path may act on an
archived row. This prevents delayed proposals, retries, or schedulers from
restarting work after the archive transaction commits.
Work producers serialize with archive by locking the Project row in the same
transaction that creates a managed operation, automation execution, Source
post-processing run, Source binding, or research workflow/stage. Initial-intake
draft saves, research-question changes, and incremental-trigger consumption use
the same fence. The aggregate lock order is Project, then Operation/Automation,
then Research Workflow.

### ProjectFolder (owned, not linked)

A Project Folder is a registered persistent physical folder/repository owned
by exactly one Project — there is no association/link table and no Folder
role vocabulary. `project_folders.project_id` is a direct, non-null,
single-owner FK.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | Primary key |
| `project_id` | FK → projects | Direct owner; not nullable |
| `space_id` | string | Must match the owning Project's space |
| `kind` | string | `code` \| `data` \| `docs` |
| `is_primary` | boolean | At most one primary Folder per Project |
| `execution_enabled` | boolean | |
| `protected` | boolean | Safety flag gating destructive path operations; not an ACL |
| `root_path`, `repo_url`, `default_branch` | string \| null | |
| `snapshot_retention_days`, `snapshot_max_count` | int \| null | Code-patch rollback snapshot policy; falls back to the Space default |
| `status` | string | `active` \| `archived` |
| `created_at` / `updated_at` | datetime | |

A Folder has no separate owner, visibility, membership, or access-level
authority — it inherits its owning Project's ACL completely. Unregistering a
Folder removes only the registration row; it never deletes, moves, or
rewrites the physical directory. A physical folder cannot be shared across
Projects, and V1 has no Folder transfer between Projects.

### ProjectMember (project memory ACL)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | Primary key |
| `space_id` | FK -> spaces | Same hard boundary as Project |
| `project_id` | FK -> projects | Project whose concrete memory can be read |
| `user_id` | FK -> users | Space member receiving project-level access |
| `role` | string | `owner` \| `member` \| `viewer` |
| `status` | string | `active` \| `revoked` |
| `created_at` / `updated_at` | datetime | |

`project_members` is the ACL used by memory read/retrieval surfaces for
project-scoped memory. It does not make project memory public. In shared spaces,
concrete project memory is readable only by the project owner or an active
project member; `viewer` can read gated memory but cannot mutate project
metadata or public summaries.

### ProjectPublicSummary

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | Primary key |
| `space_id` | FK -> spaces | Space-public discovery boundary |
| `project_id` | FK -> projects | Unique current summary per project |
| `summary_text` | text | Redacted, high-level project brief only |
| `topics_json` | JSON array | Public aliases/topics for retrieval |
| `highlights_json` | JSON array | Public high-level highlights |
| `source_refs_json` | JSON array | Pointer metadata only; no raw memo/doc content |
| `redaction_version` | string | Sanitization contract version |
| `review_status` | string | `draft` \| `approved` \| `archived` |
| `updated_by_user_id` | FK -> users (nullable) | Last human updater |
| `generated_by_run_id` | FK -> runs (nullable) | Optional generating run, same project/space |
| `created_at` / `updated_at` | datetime | |

Project public summaries are intentionally separate from project memory. They
are designed for cross-project discovery and inspiration: approved summaries are
space-public and indexed as retrieval object type `project_public_summary`.
They must be sanitized before write; source refs may identify public pointers
but must not embed raw private memory, memo excerpts, document bodies, or other
concrete project content.

### Project Kernel and Templates

Every Project is created with an immutable `project_brief_versions` v1 row,
even when all optional Brief fields are empty. Later edits append another
version and move `projects.active_brief_version_id`; they never overwrite a
Brief. `project_mode_transitions` is likewise append-only. A Primary Mode
transition changes Project-shell presentation only — every installed Project
Area remains reachable independent of `primary_mode`, and the transition does
not convert, copy, or reclassify domain rows.

Project Templates are code-owned creation defaults selected when a Project is
created. A Template bundles an initial Primary Mode and starter Workflow
Template keys. It is not a permanent Project type or a post-create feature
gate — Template origin is provenance only and must never gate which Areas or
capabilities a Project shows. The selection is stored in the first-class
`projects.template_key` column. The canonical module and routes are
`server/src/modules/projectTemplates/`, `/project-templates`, and
`/projects/{projectId}/template`; there are no Preset compatibility aliases.

The built-in Templates are `blank` and `academic_research`. Academic Research reuses normal Project
Sources plus the arXiv, OpenAlex, and Semantic Scholar providers and their monitors, `academic_paper_v1` extraction profile
key, and `academic_citation_v1` graph lens id. Its advertised sections are
`source_monitoring`, `corpus`, and `project_graph`; paper/citation objects are
represented through the core relation/object model and surfaced through the
project corpus and graph lens, not through a second project hierarchy. Academic
projects render a compact Academic Research workflow/status surface with
adaptive query discovery, provider monitors, and an entry to the dedicated
Research Area. Paper triage, reading state, living documents, and report
snapshots no longer share the Project overview surface.

A project source binding whose `extraction_policy_json.profile_key` is
`academic_paper_v1` materializes matching academic-provider source items into a
paper object (`space_objects` + `sources` + `academic_papers`, deduped per
space by DOI, arXiv, OpenAlex, and Semantic Scholar ids) before the normal Project Corpus sync runs — see
`materializeAcademicPaperFromSourceItem`
(`server/src/modules/academic/paperMaterializer.ts`). Once a
`source_item_references` row links the SourceItem to the Reference object, the
object is picked up by the existing corpus/graph sync with no Profile-specific
wiring. The materializer performs its dedupe read and all Reference writes in
one transaction and serializes overlapping DOI/provider identities with
transaction-scoped advisory locks. Those provider identifiers are stored in
trimmed lowercase canonical form; the schema rejects non-canonical direct
writes, including empty values and surrounding whitespace, so equivalent
variants cannot bypass the identity lock or uniqueness checks. Project routing
isolates this best-effort materialization behind a savepoint, so a rejected
paper cannot leave the surrounding Source transaction unusable.

The `project_research` module (`/api/v1/projects/{id}/research/*`, see below)
adds a project-owned research workflow foundation on top of Project Corpus:
research profile state for the general workflow API, workflow/stage/checkpoint
state, Artifact-per-stage links, project screening criteria, and a
literature-matrix read model. The general workflow-start endpoint may require
an approved profile, while the Auto Research initial-intake endpoint collects
its own research question and execution selection in one explicit setup action.
Question refinement persists a versioned bounded research context and returns
its `research_context_version_id`: `scope.in` and
`sub_questions` guide provider-specific query planning and become short
post-processing inclusion criteria, while `scope.out` guides query planning and
becomes exclusion criteria. Canonical `must_have` and `nice_to_have` criteria
also cross the materialization boundary into screening and synthesis; they are
never reconstructed from the executable provider query. The complete research
question remains the screening objective. The same normalized context is persisted in workflow/operation state
and supplied explicitly to synthesis and critique, so discovery, screening, and
reporting use one scope without copying a potentially long question into a
200-character criterion field. Discovery creates a project-owned
`research_query_strategy` from that immutable context version. Provider plans
are evaluated independently for at most three attempts; every attempt stores
its semantic query, exact compiled provider query, preview observation,
decision, and fingerprint. Selected attempts are materialized atomically into
`source_search_specs`, Source Channels, and Project Source bindings. Initial
intake accepts only the materialized `query_strategy_id`; it never adopts or
mutates a free-floating strategy. `server/src/modules/research/queryPlanning/`
owns semantic planning, the adaptive ladder, and provider compilation. Preview,
scheduled scans, and history backfill all execute the selected spec's same
`compiled_provider_query_json`; no later stage recompiles it or substitutes the
complete research question.
Editing an approved research profile returns it to `draft` for general
workflow consumers. The module dispatches through existing Runs/Artifacts
rather than a parallel execution system. Its integrity gate writes an
`integrity_report` Artifact and a pending checkpoint after checking
workflow-scoped claim links for missing citations, missing evidence or
explicit gaps, evidence outside the project corpus, and missing experiment
provenance.

### Research Area

`/projects/:projectId/research` is the project-owned Area for three living
research documents plus immutable report snapshots:

- `research_notebooks` owns one notebook per project. Its fixed
  `research_notebook_sections` rows (`understanding`, `questions`, `ideas`,
  `experiments`) store canonical Tiptap JSON, server-derived normalized text and
  hash, and an optimistic version. Reader resolves a section id as document type
  `research_notebook`, so ordinary annotations and hash-mismatch behavior apply.
- the Reading List is a Project Corpus read model joined to
  `research_paper_cards`. A deep-analysis run resolves
  `project_research.paper_card`, creates the initial WHY/HOW/WHAT card directly,
  and records run/prompt provenance. Once a person edits a card, AI
  regeneration never overwrites it.
- `research_checklist_items` is the ordered progress document. People use CRUD
  directly; synthesis ideas/limitations and integrity alerts add
  `origin='agent'` items directly, dismissable like any other item.

AI writes to the notebook are direct co-edits, not proposals (revised D2).
Every write path — user save, seeding, monitoring, ad-hoc analysis, rollback —
goes through `notebookWriteService.writeNotebookSection`, which bumps the
optimistic version and records a full-content row in
`research_notebook_section_revisions` (source, block-op diff, user/run
attribution). AI edits are expressed as block-level ops (`append` / `insert` /
`replace` / `delete` against top-level Tiptap blocks), so untouched blocks are
carried over byte-identical and user formatting survives. The UI highlights the
latest AI edit with its diff and offers one-click rollback; restoring any
revision writes a new version, so history is never destroyed. An ad-hoc run
whose base version was overtaken degrades to a clearly labeled append instead
of merging blindly.

The first completed synthesis seeds only empty version-1 notebook sections.
Later report snapshots never overwrite evolved sections; legacy projects with
reports but no notebook are seeded from the latest non-rejected report on first
Area initialization. The Ask-AI entry is separately budgeted: at most
`RESEARCH_ADHOC_DAILY_RUN_LIMIT` `research.adhoc_analyze` runs per project per
UTC day, enforced at queue time. Its output contract is a `notebook_update` ops
document applied by the research reconciler on run completion. `POST
.../research/reports` queues a `synthesis_only` operation over the current
reviewed corpus to create a new immutable snapshot. Materialization creates the
normal domain-owned `idea_review` checkpoint: the execution-per-pass graph may
finish, but the operation and report remain `waiting_review` /
`awaiting_review` until a project writer approves or rejects the checkpoint.

Notebook sections also persist referenced source-item ids. Applied AI updates
merge their `refs` into that durable set, so integrity monitoring audits the
papers the living understanding actually depends on instead of inferring
citations from prose.

### Automatic academic research lifecycle

Initial intake starts with a stateless, managed-Provider question-refinement
interaction. The client may carry at most three rounds of clarification; the
server evaluates answerability plus FINER dimensions and returns bounded
rewrites, sub-questions, scope, and clarification prompts. Refinement is a
hard start gate: discovery and initial intake stay disabled until the assessment
passes (answerable with mean FINER score at least 3) or the user adopts one of
the bounded suggested rewrites. Drafts may still be saved before the gate
passes; the legacy-named `question_refine_skipped` state field records whether
the gate is still outstanding. Saving or starting intake binds the selected
Research Workflow to an immutable Inquiry Thread revision. It does not copy the
Question into `projects.current_focus`.

Source discovery is owned by the `research` module. `POST
/api/v1/research/query-strategies/evaluate` plans and evaluates provider-specific
queries from a persisted context version. The planner stores a bounded semantic
intent, builds at most three provider-specific attempts, and uses observed hit
count, sampled relevance, diversity, and duplicate rate to accept, broaden, or
narrow the next attempt. Provider compilation is centralized in
`ResearchProviderCompiler`; source connectors execute compiled queries and do
not reinterpret research questions. `POST
/api/v1/research/query-strategies/{id}/materialize` is the explicit confirmation
boundary that atomically creates the selected Source Monitors and Project Source
bindings. Provider failures are independent; a surviving selected provider can
still be materialized. Secrets remain in the trusted fetch channel. The
project-owned strategy id follows initial intake for reproducibility. The setup
surface exposes the assessment, selected provider queries, attempt observations,
and coverage warnings; raw model reasoning remains an internal implementation
detail.

Monitoring records immutable performance observations against the active query
version. A rolling window may propose one broader or narrower successor only
after the minimum sample count, hysteresis threshold, and cooldown are met. The
successor is evaluated from the stored semantic intent, never from a new LLM
reinterpretation. Activation remains proposal-gated, archives the replaced
Source channel/binding/scheduler task atomically, and retains activation history
for rollback.

Automatic research uses a long-lived workflow plus a managed
`project_operations` domain projection. Baseline and incremental work reuse the
same operation/step/link tables; progress JSON carries the run kind, query
fingerprint, source binding/rule/plan ids, watermark before/after, current
stage, checkpoint ids, and idempotency key. Each observation, retry, resume,
rescan, or terminal-Run event starts a new immutable Workflow Execution pass;
completed executions are never reopened and their DAGs never cycle.
Production callers enter through
the logic-free `pipeline/researchPipelineService.ts` command façade; the
internal orchestrator is its composition root and delegates stage behavior
to the purpose-specific services. `pipeline/operationProjectionWriter.ts` is
the single persistence adapter for updating the long-lived operation
projection from the current pass. It does not decide execution flow.
The pipeline's purpose-specific
services own lifecycle decisions: `pipeline/retryService.ts` routes failed
stages and preserves idempotent retry behavior behind explicit coordinator
ports; `pipeline/synthesisCoordinator.ts` owns synthesis/critique/revision
queueing, completed-draft validation, critique artifacts and report
materialization, empty approved-corpus completion, and synthesis-stage recovery.
`pipeline/initialIntakeCoordinator.ts` resolves the
project-owned discovery strategy and owns Source-channel validation, project
bindings, research post-processing-rule configuration, and user-authorized
initial backfill provisioning. The
`pipeline/screeningCoordinator.ts` owns screening progress, corpus counts, the
human review gate, and valid zero-source completion.
`pipeline/monitoringCoordinator.ts` owns durable incremental scan summaries,
zero-result scan convergence, post-processing completion routing into baseline,
historical, or incremental operations, monitoring comparison run lifecycle and
materialization, and the handoff into adaptive
query-performance feedback. Sources owns fetching, pagination,
post-processing cursors, evidence materialization, and source policy.

Initial literature intake is saved independently as a `not_started` workflow
draft. Saving a draft persists the context/strategy selection,
history scope, monitoring field, and execution selection without creating a
backfill plan or execution operation. Materialized Source Monitors are derived
from the strategy rather than accepted as client-selected channel ids. The project UI shows a compact intake summary and opens the full setup
editor only on request. A saved draft keeps explicit Edit setup and Start
research actions visible. Once the initial intake operation is created, the
setup summary is removed; runtime progress is shown by the operation, stage
status, artifacts, monitor state, and human-review checkpoints. Saving a draft
applies the returned workflow to the project page's local research state, so
unrelated project data is not reloaded. Initial intake execution resolves the
strategy's materialized monitors and existing project bindings; it does not
create an implicit query, attach a strategy to an operation, or duplicate a monitor. Its history mode is either an explicit
bounded arXiv `from`/`to` range or an explicit `all_available` choice.
The latter freezes the current time as `to` and walks back to the arXiv safety
floor (`1991-01-01T00:00:00Z`); a max-item cap is partial rather than complete
and can be resumed from the persisted Source cursor only after the user
explicitly raises the item limit in Project Settings. Recovery actions never
choose or add an item budget.
Once a Project Research operation exists, its
`progress_json.history.max_items` is the sole writable budget authority;
project-owned Source backfill plans link to that operation and do not mirror
the total in `strategy_json`. Standalone Source backfill plans retain their
own plan-level budget. The research execution-profile service resolves the
selected Model Provider/model and
automatically reuses or provisions the system-managed research Agent/profile;
Research does not expose runtime adapter, CLI credential, Agent, or profile
overrides. It reuses or creates the selected monitor's project binding,
post-processing rule, and history plan. The user's explicit Start action
authorizes the history import for this Project Research operation; Auto Research
does not create a second `source_backfill_start` proposal. Generic Source and
agent-triggered history plans remain proposal-gated. After the history window
and post-processing drain, a `screening_gate` must be approved before synthesis.
The resulting `literature_matrix` includes `relevant`, `included`, and `maybe`
corpus rows, is refreshed on retries, and is attached explicitly to the managed
synthesis run as a bounded evidence pack. Its source-connection metadata keeps
the normal source-consent and provider-egress checks in force. Synthesis is not
queued when that matrix is empty. Zero search items, zero relevant screened
items, and a corpus that cannot support a coherent cited report are completed
research outcomes with review/adjust-scope actions; they are not failed
operations. A small non-empty matrix is still synthesized as-is.
The synthesis instruction is resolved through the Prompt Library asset
`project_research.synthesis` and its resolved version/hash are captured in the
Run contract. Synthesis output is schema-validated and must carry
source/evidence references;
intake also snapshots `report_depth=quick|full`. Quick reports are bounded to
five findings and skip the revision loop. Every valid synthesis draft is
reference-numbered and then receives a second managed
`synthesis_critique` run inside the synthesis stage. Critique results are
durable `research_critique` artifacts and are projected in
`progress_json.synthesis_critique`. A full report with a critical critique is
revised at most once; a second critical result, or any quick-report critical
result, is retained in report limitations with an unresolved marker. Only the
post-critique report is materialized into `project_research_reports` and moved
to `idea_review`. The periodic reconciler can recover an unqueued critique or
revision from operation state, preserving the level-triggered lifecycle.
It uses a success-only result envelope for every non-empty approved corpus.
The model must synthesize the evidence that exists and state weak coverage,
conflicts, and unsupported aspects in the report limitations; corpus size alone
is never a rejection condition. Empty search results and an empty approved
corpus are resolved deterministically before model invocation and projected as
completed no-report outcomes with review and scope-adjustment actions. The setup
UI keeps the reassessed research definition and selected provider queries
concise and editable, shows coverage warnings alongside the selected query, and
places the full adaptive-attempt history in optional detail. Successful artifact
`content` must be emitted as the contract's JSON object. The materializer stores
that object as JSON text and rejects prose, JSON-encoded strings, and Markdown
code fences instead of normalizing them after the run.
If inner artifact JSON or its protocol shape is invalid, the operation stores a
stable error code plus safe diagnostics (artifact id/type, length, SHA-256,
preview/tail, parser error and position where available), the run is marked
`degraded`, and a failed `validation_completed` run event is written. Full
artifact content remains available through the artifact record; logs only add a
bounded, redacted preview/tail for diagnosis. The operation and Run detail
views expose the same diagnostics, and the server emits a structured
`[project-research.synthesis] validation_failed` log line. An `idea_review` checkpoint is the final gate before
the source schedule is activated.

When a failed synthesis operation is retried, the retry clears the old
`synthesis_progress` snapshot and writes the new run id and queued/started
timestamps immediately. If that retry deterministically finds an empty approved
matrix, the operation transitions directly to the completed no-relevant-sources
outcome instead of reporting a stale-state conflict.
The workbench therefore does not have to wait for a
later reconciliation tick before showing the new attempt's age. While the run
is active, that read model also projects the linked `agent_run` job status,
attempt count, worker heartbeat/update timestamps, and latest run-event type.
The UI uses these fields to distinguish waiting for a worker, an active worker,
an old heartbeat, and a completed worker whose result has not yet been
reconciled. This is operational health/progress telemetry, not a model-generated
percentage: the synthesis agent does not currently emit a reliable inner-step
completion percentage. Project detail's Recent Runs list re-fetches canonical
run status while a project run or research operation is active, so it does not
retain a stale `running` badge after the run detail has reached a terminal
state. If the scheduler projection is still stale, the workbench offers a
repair-only reconcile action; it observes the terminal run and advances or
fails the operation without queuing a second run.
`synthesis_run_id` is the authoritative run binding;
`synthesis_progress.run_id` is telemetry only and is never used as a
compatibility source of identity.

During screening, the operation's progress JSON also exposes a durable
`screening_progress` read model: total/classified/unclassified papers, batch
size, total/completed/active/failed batches, relevant/maybe/excluded counts,
missing-full-text and evidence counts, and a human-readable next-step message.
Each recovery batch updates this state when it starts and finishes, so the UI
can distinguish batch preparation, active screening, and a review-ready gate;
`running` alone is not the research progress contract.

After a bounded baseline is complete, `historical_backfill` creates a separate
managed operation against the same workflow, monitor bindings, and rules. It
rejects overlapping coverage and runs through the same explicit intake action,
screening, synthesis, and idea-review gates. While it runs, successful source
post-processing still materializes items but queues live items in the workflow;
the queue is flushed into one incremental operation after the historical
operation reaches a terminal review state. This keeps ingestion available while
preventing concurrent operations from overwriting workflow state.

Incremental runs are created by successful project-bound post-processing or an
explicit trigger after monitoring is active. A 48-hour overlap around the
stored `submittedDate`/`lastUpdatedDate` watermark protects against scan gaps,
while arXiv id/DOI/source-item dedupe keeps the corpus idempotent. After
incremental screening is approved, the managed `research.monitor_compare` pass
resolves `project_research.monitor_compare` and compares every relevant/maybe
paper with the current `understanding` section. It classifies each paper as
`supports`, `contradicts`, or `new_direction`, writes the stance and comparison
detail to the paper card and scan outcome, and completes without producing a
new formal report. Supporting evidence is recorded silently; contradictions
and new directions append one labeled, dated block to the `understanding`
section directly (a rollbackable `ai_monitoring` revision carrying source
refs). Formal synthesis remains an explicit report-snapshot action.

Every completed live scan has an append-only `research_scan_summaries` outcome
for each participating research workflow. Reconciliation-backed outcomes store
the scan window, completion time, new-item count, relevant/maybe/excluded
counts, comparison details, and supports/contradicts/new-direction counts; a
successful zero-item source scan also writes an explicit zero row.
Consequently the project timeline can distinguish "scanned, no updates" from
an absent day, which means no scan was recorded. Workflow and operation rows
remain mutable projections, while scan summaries are stable across later
question re-screening.

Each incremental scan also appends a query-performance observation for the
strategy that produced it. The feedback policy evaluates at most the latest
five comparable observations and requires at least three before acting. It uses
new candidates, screening acceptance (relevant plus maybe), duplicate rate,
optional screening-queue latency, and optional core-concept coverage. Separate
broadening and narrowing bands provide hysteresis, and a 14-day cooldown starts
after either activation or proposal creation. Stable zero/low-volume,
high-relevance scans may propose broadening; only overloaded scans with weak
conservative acceptance or sustained queue pressure may propose narrowing.

A feedback decision evaluates a fresh, maximum-three-attempt strategy from the
active strategy's stored semantic intent. It never recompiles the long research
question as a provider query and never edits an active Source Channel in place.
The evaluated replacement is presented as a
`research_query_strategy_activation` proposal. Approval materializes its exact
selected compiled queries and atomically archives the previous version's
channels/bindings, activates the replacement, updates the workflow projection,
and appends an activation-history row. Strategy versions and activation history
remain listable for audit; explicit manual activation of an earlier materialized
version records a rollback activation instead of rewriting history.

A separate daily `project_research_integrity_monitor` job checks DOI references
from accepted Notebook sections and non-rejected reports against the production
Crossref work record, including Retraction Watch `updated-by` metadata.
Retractions, corrections, expressions of concern, and reinstatements are
deduplicated in `research_integrity_alerts`. New events are pinned into the
daily scan digest, create a pending monitoring `integrity_gate`, and add an
agent-origin checklist item directly; repeated checks do not duplicate those
review obligations.

The selected Workflow's pinned Inquiry Thread revision is compared with the
current version of that same Thread before any new judgement run. If they
differ, Auto Research source post-processing rules skip without advancing
their source cursor, post-processing reconciliation queues incoming items
instead of creating an old-question incremental operation, and explicit
incremental runs, historical extensions, failed-operation retries, and empty
backfill rescans return `409` until the drift is resolved. This protection also
applies to the automatic source-processing path, so revising an Inquiry
Question cannot silently create new AI screening decisions under the old
revision.

Question changes are resolved explicitly by a project writer. The workflow
keeps the latest and previous question/version; source-processing decisions
store `research_question_version` and remain append-only, and screening
coverage only counts decisions from the operation's version. The corpus read
model selects the newest decision per item/version while preserving every
human-confirmed `triage_status`.

`GET /projects/{id}/research/question/impact` reports affected paper/report
counts. `POST /projects/{id}/research/question/resolve` accepts `rescreen`,
`synthesis_only`, or `apply_forward`: all three refresh the profile and Auto
Research rule judgement fields; re-screen resets only unconfirmed AI corpus
projection and runs the normal screening/review/synthesis gates, synthesis-only
reuses the corpus, queues a new synthesis, and still stops at idea review;
apply-forward leaves existing decisions and artifacts unchanged. The older apply-forward endpoint delegates
to the same transaction. Active or queued research/source-processing work must
finish before resolution begins.

Operation progress is derived from the same effective stage used by the
operation steps. A failed operation retains its failed stage in
`progress_json.failed_stage`; the UI must render that stage as failed rather
than falling back to the sentinel `current_stage = failed`. The progress bar,
detail counters, and step indicator therefore remain consistent even when a
screening batch fails part way through.

Project Research has a level-triggered recovery invariant:
every research stage must be recoverable by the periodic reconciler from the
durable operation, workflow, source, checkpoint, and run tables alone. Event
hooks for source post-processing and terminal agent runs are latency
optimizations. A hook may persist append-only input observations, then
enqueues an execution nudge; it never advances the projected research stage
itself. The nudge starts or settles the operation's current immutable Workflow
Execution pass. The pass Action observes durable state and applies the next
domain projection update, so a lost hook cannot stall an operation.

For managed research, the immutable `workflow_executions` pass and its
node-to-Run links are the execution authority.
`project_operations.progress_json.current_stage`,
`project_research_workflows.current_stage`, and `project_operation_steps` are
transactionally maintained domain/UI projections, never independent workflow
graphs. `project_operations.current_execution_id` identifies the pass allowed
to apply stage outcomes; `generation` increases for every new pass. Each
projection write increments `project_operations.version` and uses a locked
compare-and-set stage precondition so stale or late writes cannot overwrite a
newer pass. Only one active Workflow Execution may govern an operation, and
only one active/waiting-review research operation may exist per workflow.
Creation and initial activation of a managed research operation are one
transaction, so a uniqueness loser cannot leave a draft for the reconciler.
Successful Source post-processing runs carry `research_reconciled_at` as the
durable recovery marker consumed by level-triggered reconciliation. Extracted
Evidence deduplicates non-null content hashes per `(space_id, source_item_id)`
regardless of extraction method, so crash/retry or alternate extractors cannot
create two identities for the same source content. Each distinct extractor,
semantic type, run, artifact, and metadata payload is retained as a deduplicated
`metadata_json.evidence_observations` entry on that canonical Evidence row.
That observation array is system-owned provenance: ordinary Evidence metadata
updates preserve it even if a client supplies a field with the same name.
Human Reader Annotation Evidence remains annotation-owned and ACL-scoped
(`source_object_type = reader_annotation`); it deliberately leaves
`source_item_id` null and therefore never merges private annotation provenance
into the canonical Source content identity. When its document is Source-backed,
`origin_source_item_id` (and, for snapshot annotations, `source_snapshot_id`)
retains an explicit access-policy origin. Evidence reads, context selection,
retrieval revalidation, and provenance policy resolution enforce that origin's
Source gate without adding it to the content-identity uniqueness key. Summary
proposal import-target checks, Project Corpus admission/reads, and research
artifact materialization revalidate the same origin instead of trusting the
Evidence row's visibility alone.
SourceItem/Evidence `summary` access is metadata-only: reader DTOs redact
excerpts, URIs, hashes, metadata JSON, storage/index references, and Artifact
links. Content-bearing durable or model-facing derivations (Activity/Source
summaries, Context selection, post-processing, literature matrices, and
critiques) require effective `full` access to every Source, Evidence, and
Snapshot input. Their intermediate Artifacts are owner-private; sharing is a
separate explicit publication/review decision and never follows from Project
membership or Space oversight alone.

Research workflows may contain multiple Source Monitors for independent
scanning. The workflow stores channel ids, binding ids, query fingerprints,
per-channel coverage, and pending incremental channel events; it does not store
a provider-specific query as its source of truth. Monitor configuration remains
owned by Sources, while the workflow only records which monitors are included
and how their collected corpus participates in the research lifecycle.
Pending incremental Source items are a durable workflow queue. Both append and
consume paths lock Project then Workflow in one transaction; consumption only
removes the queue key in the transaction that merges the items into an existing
operation or creates their new managed operation.

### project_id on durable objects

The following tables carry `project_id` columns with database foreign keys to
`projects.id`. Unless noted otherwise, the column is nullable and existing rows
with `project_id = NULL` are unaffected.

| Table | Column added |
|---|---|
| `runs` | `project_id` |
| `activity_records` | `project_id` |
| `artifacts` | `project_id` |
| `proposals` | `project_id` |
| `memory_entries` | `project_id` |
| `automations` | `project_id` (composite FK `(space_id, project_id)`; optional, `agent_run` target only, requires project writer authority to bind — see [modules/automations.md](../modules/automations.md)) |
| `project_source_bindings` | `project_id` (required; composite FK `(space_id, project_id)`; source consumption requires project writer authority) |
| `project_source_item_links` | `project_id` (required; materialized Source item collection rows for project source bindings) |
| `project_corpus_items` | `project_id` (required; project-owned corpus/read model over object, source item, and evidence links) |

`project_source_bindings` and `project_source_item_links` are Project-owned
consumption configuration/read-model records, authored in
`server/src/db/schema/projectSources.ts` and served by the Projects module.
`source_connections` stay space-scoped under Sources. The binding is the
project boundary: the same source connection can be bound to multiple projects
because the uniqueness constraint includes `(space_id, project_id,
source_connection_id, binding_key)`.

`project_corpus_items` is Project-owned. It reconciles Sources output into the
project's working corpus:

- Corpus upsert/update and automated Source reconciliation serialize on the
  Project row. This is both the archive write fence and the identity fence:
  target resolution occurs after the lock, so a concurrent SourceItem→Reference
  bridge cannot create parallel source-target and object-target rows. Background
  routing only selects active Projects, and explicit sync rejects a Project that
  becomes archived while waiting for the lock. Multi-Project routing computes
  and sorts the exact active affected-Project set before any write, then scopes
  every Corpus sync to that set; stale links from archived Projects neither
  expand the lock set nor block an active Project's reconciliation;

- `status` is link lifecycle (`active` / `archived`);
- `triage_status` is the project-level judgement (`new`, `relevant`, `maybe`,
  `excluded`, `included`);
- `triage_confirmed_by_user` is set whenever a human explicitly sets
  `triage_status` through the Corpus API. Automated screening-decision sync
  (`syncProjectCorpusSourceDecisions`) must not overwrite `triage_status` or
  `last_reviewed_at` once this is true — AI screening only suggests, the user
  confirms;
- `read_status` is project-level reading progress (`unread`, `skimmed`,
  `read`, `discussed`). It is shared team review state for the Project, not a
  particular member's reading history. Personal progress is owned solely by
  `source_item_user_states.read_status`; the two fields are never synchronized.

When the corpus item's object is a materialized academic paper (see above),
the corpus DTO's `object.academic` field carries joined `academic_papers` +
`sources` metadata (`arxiv_id`, `doi`, `publication_date`, `venue`,
`paper_type`, citation counts, `authors`, `categories`, `source_uri`); it is
`null` for non-paper objects.

`source_post_processing_item_decisions` remains the source-item-level
post-processing decision/audit record. Project corpus rows may point at the
latest relevant decision through `source_decision_id`, but project triage/read
state is not stored on source items and does not mutate Library state.

## API routes

All routes are under `/api/v1/projects` and require authentication.
Space scoping is enforced via the `space_id` query parameter resolved by `get_identity`.

| Method | Path | Description |
|---|---|---|
| GET | `/projects` | List projects in the authenticated space |
| POST | `/projects` | Create a project |
| GET | `/projects/{id}` | Get a project |
| PATCH | `/projects/{id}` | Update name / description / focus / settings |
| POST | `/projects/{id}/archive` | Archive a project |
| GET | `/projects/{id}/summary` | Counts: activities, artifacts, pending proposals, Project Folders, active runs, memory entries |
| GET | `/projects/{id}/corpus` | List the project corpus over collected source items, evidence, and graph objects |
| POST | `/projects/{id}/corpus` | Upsert a project corpus entry for an object, source item, or evidence target; requires project writer |
| PATCH | `/projects/{id}/corpus/{corpus_item_id}` | Update project-level corpus lifecycle, triage, read status, role, relevance, confidence, reason, or metadata; requires project writer |
| POST | `/projects/{id}/corpus/backfill-source-items` | Recompute project corpus rows from current project source item links, evidence links, source-object pointers, and source post-processing decisions; requires project writer |
| GET / POST | `/projects/{id}/sources/bindings` | List or create Project-owned source bindings |
| POST | `/projects/{id}/sources/propose-bind` | Agent-only proposal path for `project_source_bind`; Project writers use direct binding creation |
| PATCH / DELETE | `/projects/{id}/sources/bindings/{bindingId}` | Update or disconnect a Project binding; removal is internally archived for audit and omitted from normal binding reads |
| POST | `/projects/{id}/sources/bindings/{bindingId}/backfill` | Idempotently rematerialize already-collected source items into the Project |
| POST | `/projects/{id}/sources/bindings/{bindingId}/propose-backfill` | Create an operation, history-import plan, and start proposal |
| POST | `/projects/{id}/sources/propose-setup` | Idempotently create one Project operation, paused Source draft, activation proposal, and dependent binding proposal |
| GET | `/projects/{id}/sources/health` | Read binding-level collection health |
| GET / POST | `/projects/{id}/operations` | List or create product-level Project operations |
| GET | `/projects/{id}/operations/{operationId}` | Read operation steps, links, and projected progress |
| POST | `/projects/{id}/operations/{operationId}/cancel` | Cancel a non-terminal grouping record |
| GET | `/projects/public-summaries` | List approved high-level project summaries in the current space |
| POST | `/projects/public-summaries/search` | Search only `project_public_summary` retrieval objects |
| GET | `/projects/{id}/public-summary` | Read the approved high-level public summary for a project |
| PUT | `/projects/{id}/public-summary` | Create/update the sanitized public summary. A bare write stages `review_status = draft` (project writer authority). Publishing (`approved`) or unpublishing (`archived`) requires project-owner-level authority |
| POST | `/projects/{id}/public-summary/draft` | Generate and store a sanitized **draft** public summary via the `project_public_summary` provider task; records a best-effort `policy_decision_records` audit of the model call |
| GET | `/projects/{id}/members` | List project-level memory ACL members |
| POST | `/projects/{id}/members` | Add/update a project memory ACL member |
| DELETE | `/projects/{id}/members/{user_id}` | Remove a project memory ACL member |
| GET | `/projects/{id}/folders` | List Project Folders owned by this Project |
| POST | `/projects/{id}/folders` | Create a Project Folder (managed dir, clone, or connect existing) |
| GET / PATCH | `/projects/{id}/folders/{folderId}` | Read / update a Project Folder |
| DELETE | `/projects/{id}/folders/{folderId}` | Archive a Project Folder |
| POST | `/projects/{id}/folders/{folderId}/unregister` | Remove only the registration row; never touches disk |
| POST | `/projects/{id}/folders/scan` | Scan for unregistered directories eligible to connect |
| GET | `/projects/{id}/folders/{folderId}/tree` \| `/file` \| `/git/status` \| `/git/diff` | Files & Code reads |
| GET | `/project-templates` | List built-in Project Template descriptors |
| GET | `/projects/{id}/template` | Read the Project's creation-time Template key |
| GET / PUT | `/projects/{id}/research/profile` | Read / upsert the project's research profile (draft until approved) |
| POST | `/projects/{id}/research/profile/approve` | Approve the research profile; required before a workflow can start |
| PUT | `/projects/{id}/research/initial-intake` | Save or update the explicit body `workflow_id`; omitting it creates a new draft Workflow |
| POST | `/projects/{id}/research/initial-intake/start` | Start or idempotently resume the explicit body `workflow_id`; omitting it creates/reuses by its selected Inquiry Thread |
| GET | `/projects/{id}/research/workflow` | List research workflows for the project |
| GET | `/projects/{id}/research/scan-summaries` | List immutable monitoring scan outcomes newest-first; an absent date is not synthesized as a zero-result scan |
| POST | `/projects/{id}/research/workflow/start` | Start a research workflow (requires an approved profile) |
| POST | `/projects/{id}/research/workflow/{workflowId}/stages/{stageKey}/run` | Record a workflow stage transition, optionally linking a `run_id` |
| POST | `/projects/{id}/research/workflow/{workflowId}/trigger` | Trigger an incremental run after baseline monitoring is active |
| POST | `/projects/{id}/research/workflow/{workflowId}/history-backfill` | Extend a bounded baseline into a non-overlapping earlier arXiv range |
| GET | `/projects/{id}/research/workflow/{workflowId}/checkpoints` | List checkpoints for a workflow |
| POST | `/projects/{id}/research/workflow/{workflowId}/checkpoints/{checkpointId}/decide` | Record a human decision (`approved` / `rejected` / `waived`) on a checkpoint |
| POST | `/projects/{id}/research/operations/{operationId}/retry` | Retry a failed managed research operation from its persisted stage |
| POST | `/projects/{id}/research/operations/{operationId}/reconcile` | Repair a stale operation projection from the canonical run; never re-queues the run |
| PUT | `/projects/{id}/research/operations/{operationId}/item-limit` | Explicitly raise the active research item limit from Project Settings and resume a partial import if needed |
| PUT | `/projects/{id}/research/item-limit` | Save the explicit body `workflow_id`'s draft intake limit; omitting it creates a new partial draft |
| POST | `/projects/{id}/research/question/apply-forward` | Explicitly apply the selected `workflow_id`'s revised Inquiry Thread to future runs; existing decisions and artifacts remain unchanged |
| GET | `/projects/{id}/research/question/impact?workflow_id=…` | Count papers screened under one explicit Workflow's previous Question version and its synthesis reports |
| POST | `/projects/{id}/research/question/resolve` | Resolve one explicit `workflow_id` with `rescreen`, `synthesis_only`, or `apply_forward` |
| GET | `/projects/{id}/research/reports` | List immutable structured reports, newest first |
| GET | `/projects/{id}/research/reports/{reportId}` | Read combined content, Reader projection, safe resolved references, provenance, integrity, and archive descriptors |
| POST | `/projects/{id}/research/reports/{reportId}/integrity` | Run report integrity and attach its system archive |
| GET / PUT | `/projects/{id}/research/screening-criteria` | Read / upsert project screening criteria (keywords, methods, date range, venues, required evidence fields) |
| GET | `/projects/{id}/research/literature-matrix` | Literature matrix read model over included/maybe corpus papers, with academic metadata and evidence/annotation counts |
| POST | `/projects/{id}/research/literature-matrix/rebuild` | Backfill the project corpus from sources, then return the refreshed matrix |
| GET / POST | `/projects/{id}/experiments/definitions` | List or create Experiment Definitions |
| GET / PATCH | `/projects/{id}/experiments/definitions/{definitionId}` | Read or update a Definition |
| GET / POST | `/projects/{id}/experiments/definitions/{definitionId}/versions` | List or create immutable executor-config Versions |
| POST | `/projects/{id}/experiments/definitions/{definitionId}/versions/{versionId}/approve` | Explicitly approve a draft protocol Version; only approved Versions may create Runs |
| GET | `/projects/{id}/experiments/definitions/{definitionId}/runs` | List Experiment Runs with inaccessible managed Run/Artifact references redacted |
| POST | `/projects/{id}/experiments/definitions/{definitionId}/versions/{versionId}/runs` | Create a manual or managed-code Experiment Run |
| POST | `/projects/{id}/experiments/definitions/{definitionId}/versions/{versionId}/runs/launch` | Atomically create an Experiment Run, governed Run, and dispatch Job from an approved managed Version |
| POST | `/projects/{id}/experiments/definitions/{definitionId}/runs/{runId}/complete` | Terminalize a Run and atomically record Observations |
| GET / POST | `/projects/{id}/experiments/definitions/{definitionId}/runs/{runId}/observations` | List or record raw Observations |
| GET / POST | `/projects/{id}/experiments/definitions/{definitionId}/interpretations` | List or create an Interpretation over terminal Runs from that Definition |
| POST | `/projects/{id}/experiments/interpretations/{interpretationId}/review` | Mark a draft Interpretation reviewed |
| POST | `/projects/{id}/experiments/interpretations/{interpretationId}/convert-to-signal` | Convert a reviewed Interpretation to an Inquiry Evidence Signal |
| POST | `/projects/{id}/review-sessions` | Compose bounded Inquiry and Knowledge packets without owning Candidate state |
| POST | `/projects/{id}/knowledge-candidate-extractions` | Queue AI extraction from one immutable Note/Thread/Interpretation source through a governed Run |

One synthesis run atomically materializes one `project_research_reports` row and
one hidden `research_report.archive.v1` Artifact. Reports are readable while
`awaiting_review`; idea approval moves them to `complete`, rejection to
`rejected`. Literature matrix and integrity archives are explicit report FKs.
Historical Artifact links and synthesis Artifact list routes do not exist.

### Inquiry and Experiment capabilities

Inquiry is Project-owned but not stored as `space_objects`. Its canonical
Question/Hypothesis Threads, working relations, Iterations, Signals,
Candidates, Review Packets, and Delta Briefs live in the Inquiry module.
`retrieval_objects` and the Inquiry/Combined graph are rebuildable read models:
every retrieval result is revalidated against the canonical Project ACL, and
graph responses enforce one bounded node budget across Inquiry and
`space_objects` producers.

Experiment is a separate Project capability, not a Primary Mode and not a
second research state machine. One Definition has immutable Versions;
`manual` and `managed_code_comparison` are executor types. Each Experiment Run
requires an explicitly approved Version, freezes its Version config, records
Observations, and may link an existing
managed Run and its Artifacts only after Project, Project Folder, content-access,
and provenance validation. An Interpretation must cite terminal Runs from the
same Experiment. Terminal Runs reject further status transitions and late
Observations, preserving the interpreted evidence snapshot. Review converts
an Interpretation to an Inquiry Evidence Signal and never edits a Hypothesis
directly. Experiment-backed Signals are not accepted by the general Signal
creation route; the reviewed conversion command is the only bridge. The
primary Hypothesis target is required before and frozen after the first Run so
later edits cannot retarget collected evidence. `/projects/{id}/experiments` provides the
end-to-end manual UI.
Managed-code Versions validate and snapshot the Project Folder, editable/protected
scope, setup/run commands, metric parser, timeout, and resource budgets. Launch
atomically creates the Experiment Run, governed Run contract, and dispatch Job.
The ordinary runtime owns sandboxing, credentials, attempts, supervision, and
Artifacts. Terminal reconciliation validates code-patch paths against the
Version scope, captures Run Artifacts, parses structured metrics into
Observations, and completes or fails the same Experiment Run idempotently.

The earlier `project_experiment_campaigns` / runs / provenance implementation
was removed in a clean cutover. There is one Experiment authority and no
compatibility or dual-write path.

## project_id query filter on durable object list APIs

All five durable object list endpoints accept an optional `project_id` query parameter to scope results to a project:

| Endpoint | Parameter added |
|---|---|
| `GET /activity` | `project_id` |
| `GET /artifacts` | `project_id` |
| `GET /proposals` | `project_id` |
| `GET /runs` | `project_id` |
| `GET /memory` | `project_id` |

**Isolation guarantee:** Before filtering, each endpoint validates the requested
project with `assertProjectInSpace(db, space_id, project_id)`, returning HTTP 422
if the project does not exist in the requesting space or has been deleted. This
prevents cross-space enumeration via a guessed project ID. Durable writes that
accept a `project_id` also validate the association: Activity create, Run create,
and runtime materialized proposals reject missing/deleted/cross-space projects
before persisting rows. Runtime proposal materialization also canonicalizes the
proposal payload `project_id` and the `proposals.project_id` column to the same
validated value. Proposal apply carries `proposals.project_id` into
`memory_entries.project_id` only after revalidating the project in the proposal
space.

**Output schemas:** Each corresponding output schema (`ActivityOut`, `ArtifactOut`, `ProposalOut`, `RunOut`, `MemoryOut`, `ActivityRecordOut`) now includes `project_id: Optional[str] = None`. Rows without a project are not affected.

**Frontend:** All five `*Api.list()` functions in `api/client.ts` accept `project_id`. `ProjectDetailPage` uses these to render per-section scoped previews (up to 5 items each) with "View all →" links to the global list.

## Access control

- Project access is scoped by `space_id`. A user can only access projects within their active space.
- Cross-space Folder registration is rejected: creating a Project Folder whose connected/scanned path resolves outside the Project's space returns 404/422.
- Project memory ACL is separate from high-level project visibility:
  `project_members` gates concrete `memory_entries.project_id` reads, while
  `project_public_summaries` is an approved, sanitized, space-public discovery
  layer.
- Project metadata/public-summary/Folder mutations require project
  writer authority: the project `owner_user_id`, a space `owner`/`admin`, or an
  active `project_members.role` of `owner` or `member`. `viewer` is read-only for
  concrete project memory and cannot mutate project metadata or public summary.
- Project source binding creation requires project writer authority and binds a
  Source Monitor directly to a Project. Archiving or unregistering a Project
  Folder does not mutate project source bindings.
- Project Detail shows a compact Sources summary and links to the Project
  Sources surface. Project Sources supports binding sources, backfill, scan,
  pause/remove, health, and the materialized project item collection. Global
  Sources remains the source-level management surface.
- Project conversation enters the project-bound Room surface at
  `/rooms?project={id}`. A Room may own multiple durable sessions; every
  message opens one auditable collaboration task whose Runs retain the
  validated `project_id`, optional Room-bound `project_folder_id`, speaker
  identity, task group, and session. There is
  no separate Project Chat route or execution authority. Projects without a
  Folder may use Room; a selected active execution-enabled Folder is bound once
  at Room creation and remains governed by the normal read-only sandbox boundary.
  Creating a Room requires Project writer authority and every human roster
  member must already have Project read access. All later Room operations
  re-check that ACL, so Project revocation immediately removes Room access.
- Project creation chooses a Project Template and atomically records the initial
  Brief and Mode Transition. A Template is creation-time provenance/defaults,
  not a permanent Project type; Primary Mode can later change without moving
  or converting Folder-owned data.
- Project Detail also shows recent Sources recommendations from project-linked
  source post-processing decisions. These are selected/maybe candidate items for
  review and follow-up; accepting durable Knowledge still goes through proposal
  review.
- **Publishing a public summary** (`review_status` other than `draft`) requires
  project-**owner**-level authority — the project `owner_user_id` or a space
  `owner`/`admin`. A project `member` (writer) can stage drafts but cannot
  self-approve. The draft generator only ever writes `draft`. This gives the
  project owner a review gate before content becomes space-public.
- `settings_json` is free-form per-project configuration and may carry private
  operational detail. `GET /projects` and `GET /projects/{id}` redact it to
  `null` for non-writers; only project writers see it. `name`, `description`,
  and `current_focus` remain space-visible descriptive metadata.
- Project public-summary search is restricted to retrieval object type
  `project_public_summary`. It does not expose project memory, artifacts, docs,
  memo bodies, or other concrete project content.
- Approved public summaries also feed the **system chat candidate collector**
  (source `project_public_summary`), so the shared assistant can surface
  cross-project inspiration. Only the sanitized summary is read; concrete
  project memory stays behind its own ACL.
- **Database-level space/project consistency:** `projects` carries a composite
  candidate key `UNIQUE (space_id, id)`, and `project_public_summaries` and
  `project_members` carry a composite FK `(space_id, project_id) → projects
  (space_id, id)`. A summary or ACL row therefore cannot reference a project in
  another space even via hand-written SQL.

## Non-goals

- Project is not a task manager. Use the Task Board for work items.
- Project does not auto-promote artifacts into memory or knowledge.
- Project is not a Knowledge type; KnowledgeItem rows may reference `project_id`
  as a contextual association only.
- Project public summaries are not a substitute for project memory ACL; they are
  a sanitized discovery layer.
- Research, paper, author, citation, or literature tables are not part of Project.

## Project Kernel and Inquiry

The Project Shell reads `/projects/{id}/overview` and composes the active Brief
Version, Primary Mode projection, per-user Attention, and every registered
Area's summary through registered domain adapters (`area_summaries` — all
installed Areas are always reachable and returned, including empty ones, independent
of `primary_mode` or Template origin). The same response exposes Template
provenance and a readiness checklist for the Brief, Provider, Agent, Project
Source, and execution-enabled Folder. Checklist rows are links to their owning
setup surfaces; required inputs depend on the selected Template, and missing
inputs do not create a starter Workflow or hide an Area. Workflow creation
remains an explicit user command after its required inputs are ready.
Mode transitions append history only;
they do not enable/disable an Area and do not translate domain records. The
same adapter registry is the availability authority: `available_modes` is
returned by Overview, the client renders only those Modes, and the transition
command rejects any Mode without a registered Overview adapter. An Area with
preserved data remains reachable through grouped navigation regardless of
`primary_mode`; that does not make its Mode selectable before it has a real
progress model.

Inquiry is a Project-owned domain with Question/Hypothesis Threads, typed
relations plus an acyclic primary-parent tree, protected cognitive Iterations,
Definition/Structure/Lifecycle/Work commands, Focus Sets, and Current Next
Focus. Focused Threads satisfy a DB-backed exact-one invariant:
`next_focus_kind XOR blocked_reason`. Signal and Candidate reads revalidate
their underlying Project Corpus items through the Corpus owner, and Note links
revalidate canonical content visibility. Authoritative Project/Inquiry domain
mutations lock the active Project row in their transaction so archive cannot
race a producer; per-user seen/snooze/pin presentation state does not restart
Project work and is not part of that fence.

Material Evidence Signals use deterministic/producer idempotency keys and
semantic Candidate grouping. A Candidate appears in lists, packets, Attention,
Overview, details, and decisions only when every contributing Signal's Corpus
item is readable to that user. Accept, merge, gap, defer/reopen, and dismiss are real domain commands,
not status labels; Candidate acceptance and its resulting Iteration commit in
one transaction. The UI closes packets when completed, dismissed from view, or
unmounted; opening a later checkpoint also closes that user's older open
packets and releases their pending Candidates, covering interrupted clients.

## Auto Research Thread scope

Auto Research is Question-centered, not Project-question-centered. Initial
intake either selects an active Inquiry Question or creates a normal Question
from the refined materialized text. Each research Workflow and every Operation
snapshot one immutable scope entry:

```json
{"thread_id":"…","version":3,"kind":"question","statement":"…"}
```

A Project may therefore own multiple one-Question research Workflows. Source
processing rules are namespaced by Thread, and retry/resume, fingerprints,
monitor comparisons, Signals, and provenance retain the same version pin.
The Project shell persists an explicit selected Workflow id as presentation
state. It scopes the workbench's operations, checkpoints, scans, reports, and
commands; it is not a Project-wide Question authority.

When a pinned Thread revision changes, the Workflow pauses at its alignment
guard until the user chooses re-screen, synthesis-only, or apply-forward.
Resolution adopts the already-revised Thread without rewriting it.
`projects.current_focus` is presentation metadata and never participates in
this alignment or resolution path. Monitoring classifies every new comparison
into an Evidence Signal: routine support auto-attaches; contradiction and new
direction are material and consolidate into review Candidates. The removed
synthetic `project_research_workflow` bridge Thread is not a second authority.

## Knowledge promotion source contract

Knowledge promotion never cites a mutable current object. Its source reference
is discriminated and immutable: a Note pins `note_id`, revision id/version,
content hash, and block anchors; an Inquiry source pins an Inquiry-owned full
Thread snapshot id/version/hash; an Experiment source pins a reviewed
Interpretation id/hash plus Definition, terminal Run ids, and reproduction-lock
hash. The full Thread snapshot is required because statement-revision and
Iteration history explain changes but do not alone reconstruct one exact
promoted state.

Eligible domain writes append a typed event to `domain_change_outbox` in the
same transaction. This table is delivery/audit infrastructure, not a central
business-object or relation authority. Revalidation consumes events
idempotently and records `no_impact`, `candidate_created`, or
`already_superseded`; only material `candidate_created` outcomes enter review.
AI-assisted extraction uses the same contract: the queue command pins an exact
source revision/hash into an immutable Run contract, and terminal
reconciliation creates only pending Knowledge Candidates with Run provenance.
Canonical Knowledge still requires the existing promotion Proposal.

## Project navigation and review

All Project routes share one persistent grouped navigation shell:
Project; Explore (Inquiry, Research, Sources, Files & Code, Experiments); Decide & Learn
(Decisions, Learning, Knowledge Review); and Execute (Delivery, Operations).
Changing Primary Mode changes foreground projection, not object ownership or
visibility.

Delivery Overview/Attention is an ACL-filtered Task projection. Operations
composes Project Automations, visible Runs, and visible
`operational_alert` Activity. These adapters register through the Project
registries and do not create Delivery or Operations tables. The current system
has no Incident aggregate; one must only be introduced with its own demonstrated
lifecycle. Attention rows retain the owning domain's canonical object id only
as transport state and expose a concrete URL: Tasks open Task Detail, Inquiry
Candidates and Decisions open their selected Project-Area records, and
Project Operations/operational alerts open the Operations Area with an opaque
query selection. The Overview does not copy the domain action workflow.
Delivery itself provides compact Task-authority commands for assignment,
start, completion, and reopen while Task Detail remains the full workflow
surface. Operations renders Project Operations, alerts, Automations, and Runs;
it distinguishes active/waiting, review, fallback/degraded, terminal failure,
and archived-Project states, and routes recovery to the Automation or Run
authority. Project-scoped Automation fire failures persist `project_id` on
their operational-alert Activity so the Project projection can surface them.

A Project Review Session is an ephemeral composition response over one bounded
Inquiry packet and one bounded Knowledge Promotion packet. The composer stores
no Candidate or decision state; its links return decisions to the owning
domains.
# Project operations

`project_operations` is a Projects-owned grouping/read model over canonical
Runs, Jobs, Proposals, Artifacts, source bindings, and history-import plans.
It never executes or blocks those objects. Ordered optional steps provide a
product progress view; status and `progress_json` are projected from validated,
same-space links when an operation is read. `version` starts at 1 and increments
on every operation projection/state mutation; managed research updates require
the version read under the locked operation-projection row. Public routes live under
`/api/v1/projects/{projectId}/operations`; cancellation changes only the
operation grouping record and never cancels linked execution objects.
