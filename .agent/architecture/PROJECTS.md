# Projects

## What is a Project?

A **Project** is a goal-oriented knowledge and activity container.
It organises activities, artifacts, proposals, agent runs, and owned Project Folders around a long-lived objective.
It is the stable ownership and context boundary for durable objects — not a task manager or execution environment.

A Project may carry `focus_area_id`, pointing at the long-term focus area it
serves. That is navigation only: it is not containment, it transfers no read
access, and Project membership is unaffected. See
[ADR 0015](../decisions/0015-focus-area-classification.md).

## What is a Project Folder?

A **Project Folder** is the logical file/code identity owned by a Project.
Physical checkouts are modeled separately as `workspace_locations`, each bound
to one `hosts`/ExecutionHost. Server-host Locations are where agents inspect
files, create sandboxes, run commands, collect diffs, and validate changes;
remote trusted-host Locations run in the daemon-owned checkout. Files & Code
reads for a remote Location are authorized by `projectFolders`, then pulled
through `hosts`' `connectionRegistry` and executed by the daemon's shared
`@rainver/folder-read` package. Capability code belongs to the logical
Project Folder, not to one machine.

## Project vs Project Folder

| Concern | Project | Project Folder |
|---|---|---|
| Purpose | Goal / knowledge / context | Logical file/repository identity |
| Holds | Activities, artifacts, proposals, runs, memory | Repository identity and capability code |
| Created by | User — named objective | User or system — registers a logical repository |
| Cardinality | One Project → zero or more Project Folders | One Folder → one Project; one Folder → one or more Locations |
| Capability outputs | Digests, artifacts, proposals, project memory | Capability code itself |

A Project owns zero or more Project Folders directly (`project_folders.project_id`, non-null, single-owner FK) — there is no link/association table and no Folder role vocabulary. A Folder may have several physical Locations, but a Location belongs to exactly one Folder and one ExecutionHost. A physical checkout cannot be shared across Projects; multiple questions/features over one repository belong in one Project as Threads, Tasks, Decisions, Experiments, or Workflows.
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
| `active_brief_version_id` | FK → project_brief_versions | Current immutable Brief version, constrained to the same Project/Space |
| `active_instruction_version_id` | FK → project_instruction_versions | Current approved Project Instruction, constrained to the same Project/Space |
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

### ProjectFolder (logical, owned, not linked)

A Project Folder is a registered logical repository identity owned by exactly
one Project — there is no association/link table and no Folder role
vocabulary. `project_folders.project_id` is a direct, non-null,
single-owner FK.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | Primary key |
| `project_id` | FK → projects | Direct owner; not nullable |
| `space_id` | string | Must match the owning Project's space |
| `kind` | string | `code` \| `data` \| `docs` |
| `is_primary` | boolean | At most one primary Folder per Project |
| `protected` | boolean | Safety flag gating destructive path operations; not an ACL |
| `repo_url`, `default_branch` | string \| null | Logical repository metadata |
| `snapshot_retention_days`, `snapshot_max_count` | int \| null | Code-patch rollback snapshot policy; falls back to the Space default |
| `status` | string | `active` \| `archived` \| `stale` |
| `created_at` / `updated_at` | datetime | |

### WorkspaceLocation (physical checkout)

`workspace_locations` binds a Folder to one ExecutionHost. It carries the
server-only `root_path` or remote display label, branch/head/dirty observations,
and the persisted `execution_ready` fact. A remote Location never carries a
server path. A Folder has at most one active execution Location. New work and
new attachments select only that active row; an explicitly replaced Location
becomes stale and remains executable only for initialized Conversations that
already pin it. Archived rows are non-executable history. Task Runs may bind
to the active Location directly. Project Conversations pin their Primary
Location (or a Conversation-owned managed workspace) in the execution context
and never consult a Folder-level preferred Location.
An initialized Conversation may also retain same-Host attachment pins when a
new active checkout is selected. Trusted remote Hosts can receive explicit
read/write attachment grants; server-host attachments are read-only so a Run
cannot bypass the managed worktree and patch-application boundary.

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

### Project Kernel

Every Project is created with an immutable, published `project_brief_versions`
v1 row, even when all optional Brief fields are empty. Later edits append a
draft; a writer submits it for review and only a Project owner or Space
owner/admin may publish it and move `projects.active_brief_version_id`.
Each Brief version freezes the Project status, current focus, confirmed
decisions, workspace identity/boundary, source references, and
authorship alongside goal/scope/success/constraints/assumptions. Goal-only UI
edits carry forward the user-owned aggregate fields; the server snapshots the
current Project-owned status/focus/mode in the same transaction.

A Project's **mainline Room** is a second structural singleton on the same
footing ([ADR 0018](../decisions/0018-room-as-visibility-boundary.md) decision
4): created in the same transaction, present from the start, empty until a
user explicitly opens a Conversation draft. "A Project with no Room" is not a
state, so no caller handles its absence. Project/Room creation provisions no
Assistant and opens no Conversation; the explicit draft action performs lazy
manager provisioning and exposes execution preflight. `PgProjectRepository.create`
writes `rooms` and `room_user_members` directly through `PgRoomRepository`,
rather than through `RoomService`, because that service opens its own
transaction and asserts writer authority on a Project that does not exist yet.

`project_instruction_versions` follows the same lifecycle; only the active
published Instruction is runtime-authoritative. Brief writer authority and
Instruction/publish owner-level authority are rechecked and locked inside the
mutating transaction, so concurrent member revocation wins deterministically.
A Project has no type field ([ADR 0019](../decisions/0019-project-has-no-type-field.md)).
There was a `primary_mode` — `research`, `delivery`, `operations`,
`learning`, "how work advances" — chosen at creation, changed from Settings
and logged in `project_mode_transitions`; by the end it was read in one place,
to pick one of four wordings for the same five Loop stages, while every
Project was in fact created as `research` with no chooser and advanced by
research-shaped conversation policies regardless. What kind of work a Project
is, is derived, never declared: the accepted Brief's goal says how it advances
and the Agent reads it every turn, and what the Project comes to hold (Threads
and Sources, or Tasks and file changes, or recurring Tasks) is its shape. A
Project may change shape as it goes. No surface shows a type label. When a
kind of work needs structure the shared model lacks, the answer is a new
object owned by an Area, never a mode that switches behaviour.

`inquiry` and `decision` are entities with their own surfaces, not ways of
advancing work: asking is how research starts and deciding is where it ends,
and a Project that advances by delivery makes decisions too. Inquiry's pending
Candidates reach the shell through its attention adapter.

### Creation presets nothing

Creating a Project writes a name and an optional Brief. It binds no Sources,
creates no Workflow, installs no starter content, and records no type.

User-visible Project initialization is complete when the active published
Brief defines a Project goal or core problem. Publication/review metadata does
not establish that state by itself, and downstream Inquiry Threads, Workflows,
Runs, Sources, Providers, or Folders are not initialization prerequisites.
Those records describe readiness or work progress after initialization. The
Overview exposes this distinction as `definition_status`; a Project may be
initialized while nothing is under way yet.

There was a **Project Template** here, and its removal is worth recording
because the concept was rescued twice before it was retired. It began as a
project type carrying `sections` and `starter_workflow_template_keys`; R1
deleted those workflow templates for changing no concrete behaviour, leaving a
descriptor nothing consumed. It was then re-purposed as a source-binding
bundle, justified as *the only thing that writes a `profile_key` into a
binding's `extraction_policy_json`* — true at the time, and falsified shortly
afterwards when the Project Sources surface gained its own extraction-profile
selector for new and existing bindings, with a registry default behind it.
Nobody noticed the justification had expired. A later pass stripped its
Primary Mode and `sections`, leaving a pack that saved roughly three clicks in
the Sources Area and only when the Space already held matching connections.

Every job it ever held has another home: classification is derived from the
goal and the Project's contents (ADR 0019); starting shape is each Area's
empty state; extraction profiles are chosen per binding in Project Sources;
Workflows are started explicitly. Nothing should reintroduce a creation-time
preset without first naming which of these it is not.

Academic research is a set of Sources and an extraction profile, not a project
type. Binding active arXiv and OpenAlex channels with the `academic_paper_v1`
profile is done from Project Sources like any other binding; paper/citation
objects are represented through the core relation/object model and surfaced
through the project corpus and graph lens, not through a second project
hierarchy. The generic standing/focus Project Research surface belongs to the
Research Area and is reached the same way by every Project. Material triage,
reading state, Project Notes, and report snapshots do not share the Project
Overview surface either.

Screening criteria are generic with one declared extension point. `include_keywords`,
`exclude_keywords`, the date range and `required_evidence_fields` apply to any
domain. `source_restrictions` is where material may come from — journals,
outlets and sites are one concept, so it replaced the academic-only `venues`.
Domain-specific axes live in `domain_criteria_json`, whose **legal keys come from
the extraction profiles the Project's active source bindings name**: writing a
key no bound profile declares is refused with the legal set named, rather than
accepted and ignored. `academic_paper_v1` declares `methods`, which is what that
column used to be; `generic_document_v1` declares none, so a Project screening
only web material has no domain axis to screen on. This is the middle path
between a fixed paper-shaped column every domain carries and an unconstrained
JSON bag nobody can validate.

The Project Sources surface reads and writes these criteria. It renders generic
fields for every Project and renders each domain-specific field only when the
API's `available_domain_criteria` reports that an active bound extraction
profile declares it. Saving criteria updates the `project_criteria` snapshot on
existing non-archived project post-processing rules; Auto Research rule creation
and reuse load the same current criteria. The structured screening instruction
therefore applies keywords, exclusions, domain axes, date bounds, source
restrictions, and required evidence fields to every item decision instead of
leaving the criteria as storage-only metadata.

Project source bindings may select an extraction profile through
`extraction_policy_json.profile_key`. The registry owns dispatch while each
domain registers its materializer: `academic_paper_v1` creates
`space_objects` + `sources` + `academic_papers`, and
`generic_document_v1` creates a generic `source` object keyed by the
SourceItem's canonical URI. Initial ingest only creates Project item links and
SourceItem corpus rows. Materialization runs later, when the Project corpus row
reaches `relevant` or `included` through either automated screening or an
explicit user triage action.

Both profiles write the resulting Reference through
`source_item_references`; the existing corpus promotion then replaces the
SourceItem target with `object_id` while preserving triage/read state and
SourceItem provenance. Newly materialized objects carry
`space_objects.primary_project_id`, so the shared content-access predicate
requires Project membership, and they are graphable through the ordinary
`source` ontology registration without a lens-specific branch. Materializer
failures are isolated behind a savepoint so one rejected item does not abort the
surrounding source/corpus transaction.

Migration choice for the ingest-to-triage behavior change: existing Reference
objects and already-promoted corpus rows are left unchanged. There is no
destructive rewrite or bulk reassignment of their Project scope. Future
materialization, including reruns for SourceItem rows that have not yet acquired
a Reference, follows the post-triage rule.

The `project_research` module (`/api/v1/projects/{id}/research/*`, see below)
adds a project-owned research workflow foundation on top of Project Corpus:
research profile state for the general workflow API, workflow/stage/checkpoint
state, Artifact-per-stage links, project screening criteria, and a
evidence-matrix read model. The general workflow-start endpoint may require
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
Question-assessment confirmation creates an immutable context version carrying
the confirmed wording, scope, sub-questions, assessment, and Thread/session
provenance. Repeating confirmation while that same confirmation remains current
is idempotent and returns the existing context version. The web assessment
workspace compares its working wording and framework with that durable snapshot,
so unchanged content is displayed as confirmed rather than generating another
version.
Editing an approved research profile returns it to `draft` for general
workflow consumers. The module dispatches through existing Runs/Artifacts
rather than a parallel execution system. Its integrity gate writes an
`integrity_report` Artifact and a pending checkpoint after checking
workflow-scoped claim links for missing citations, missing evidence or
explicit gaps, evidence outside the project corpus, and missing experiment
provenance.

### Research Area

`/projects/:projectId/research` is the project-owned, three-tab Area for the
Reading List, Checklist, and immutable Report snapshots. Project Notes are a
separate surface at `/projects/:projectId/notes`; the reserved research roles
described below supply baselines to research services without creating a
duplicate Notebook tab:

- Project research notes are ordinary Notes, not a table of their own. Each is a `notes` row
  under the project's auto-created Knowledge Notes collection
  (`note_collections.system_role='project'`) carrying `primary_project_id`, so a
  project may have any number of them, or none. They store canonical Tiptap
  JSON, server-derived normalized text and hash, and an optimistic version.

  Four of them carry a **system-reserved role** in `notes.project_role`
  (`understanding`, `questions`, `ideas`, `experiments`), scoped to
  `notes.role_project_id`, with a partial unique index enforcing one note per
  role per project. The role is what identifies the research baseline —
  **never the note's title**, which is a creation-time default the user is free
  to change. Membership belongs to the registry in
  `modules/knowledge/noteProjectRoles.ts`; the column carries only a format
  constraint (B12F). `server/test/noteProjectRoleGuard.test.ts` fails if any
  code resolves a project note by title again.

  A role with no note is a reported state, not an empty one:
  `resolveNotebookNote` returns `{ present: false, role, reason }`, and the
  focused monitoring comparison stops its stage and records
  `comparison_missing_baseline_role`; a standing batch records
  `blocked_baseline` and the missing role. Neither compares new material
  against an absent understanding.
- the Reading List is a Project Corpus read model joined to
  `research_evidence_cards`. A deep-analysis run resolves
  `project_research.evidence_card`, creates the initial WHY/HOW/WHAT card directly,
  and records run/prompt provenance. Once a person edits a card, AI
  regeneration never overwrites it.
- `research_checklist_items` is the ordered progress document. People use CRUD
  directly; synthesis ideas/limitations and integrity alerts add
  `origin='agent'` items directly, dismissable like any other item.

Reading-list cards carry a "jot a note" action (`POST
/api/v1/knowledge/notes/jot`) that creates or appends to a note and records the
`note_link` in one call. It is offered only on rows with an `object_id`: a
corpus row targets exactly one of `object_id` / `source_item_id` /
`evidence_id`, and only the first is a `space_objects` row a link can point at.
Papers reach it because `academic/paperMaterializer` materializes them as
Source objects.

AI writes to the notebook are direct co-edits, not proposals (revised D2).
Every write path — user save, seeding, monitoring, ad-hoc analysis, rollback —
goes through the shared note writer (`knowledge/noteWriter.ts`), which bumps
the optimistic version, records a full-content row in `note_revisions`
(source, block-op diff, user/run attribution), and refreshes the retrieval
projection. The last of those used to be the caller's job, and only the
user-facing route did it: a "current understanding" an agent had maintained for
weeks stayed stale in search until a human saved it by hand. Starter notes are
created through the same writer as any other note rather than by a second
implementation of the same insert. AI edits are expressed as block-level ops (`append` / `insert` /
`replace` / `delete` against top-level Tiptap blocks), so untouched blocks are
carried over byte-identical and user formatting survives. The UI highlights the
latest AI edit with its diff and offers one-click rollback; restoring any
revision writes a new version, so history is never destroyed. An ad-hoc run
whose base version was overtaken degrades to a clearly labeled append instead
of merging blindly.

The first completed synthesis seeds only empty version-1 role-carrying notes.
Later report snapshots never overwrite evolved notes; legacy projects with
reports but no notebook are seeded from the latest non-rejected report on first
Area initialization. Area initialization also adopts pre-role starter notes by
title once — the only legitimate title match left, because it reconstructs the
binding the old resolver created rather than being a binding of its own. The Ask-AI entry is separately budgeted: at most
`RESEARCH_ADHOC_DAILY_RUN_LIMIT` `research.adhoc_analyze` runs per project per
UTC day, enforced at queue time. Its output contract is a `notebook_update` ops
document applied by the research reconciler on run completion. `POST
.../research/reports` queues a `synthesis_only` operation over the current
reviewed corpus to create a new immutable snapshot. Materialization creates the
normal domain-owned `idea_review` checkpoint. Under the checkpoint policy
(`researchCheckpointPolicy.ts`, `.agent/architecture/SYSTEM_ACTIONS.md`) that
checkpoint is an informational record: it is auto-waived at creation, the
operation continues, and `reconcileIdeaReviewStage` completes it on the next
tick — the report's idea candidates stay reviewable on the report itself.

Notes also persist referenced source-item ids, on `note_revisions.refs_json`.
Applied AI updates merge their `refs` into that set — each write starts from
the latest revision's list — so integrity monitoring audits the material the
living understanding actually depends on instead of inferring citations from
prose. `notes.refs_json` used to hold a second copy of the same list, kept in
step by hand and read back by nothing; it was removed (N8), leaving one owner.

### Automatic Project Research lifecycle

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
Human-review checkpoints are workflow-scoped records whose
`machine_result_json.operation_id` identifies the one operation projection
they govern. Operation lists use that operation id, not workflow id alone,
when rendering review attention.
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
The baseline-to-monitoring transition seeds each Source scheduler cursor from
the latest publication timestamp actually included in that channel's baseline,
then schedules the first recurring scan at the next configured cadence
boundary. It never uses activation time as a publication watermark and never
queues an immediate scan. Project Research remains the authoritative
publication-window filter; provider-side date constraints are an optimization.
If a selected channel contributed no baseline item, it inherits the baseline's
global publication watermark rather than starting an unbounded live scan.
`scanned_at` records when a scan ran, while operation `watermark.before/after`
and `scan_window_start/end` record the publication window.
Managed Research runs retain fail-fast ownership at the operation boundary, but
transient Run Supervisor failures (including provider network and rate-limit
errors) receive the normal bounded automatic physical retry first. Exhaustion
does not create a separate Supervisor review gate: the terminal run remains
failed, the Workflow Execution projects the underlying run error and stage into
the operation diagnostics, and the explicit Research Retry action remains
available.
When a Source history import exhausts its immediate automatic fetch retry,
transient failures enter Sources-owned deferred backoff instead of failing
Research. If another provider has already collected papers, screening and
synthesis may continue with an explicit coverage warning; the delayed window
keeps retrying in the background. Papers recovered before screening closes join
the current intake, while later papers are queued for the next incremental
update. With no collected papers, the operation remains active in background
recovery because there is nothing honest to screen. Permanent failures record
`source_history_backfill_failed` with safe per-source diagnostics and retain
the explicit operation Retry action. Research and Operations surfaces never
expose the provider query or endpoint in technical diagnostics.
HTTP 429 is transient but bypasses the immediate retry and enters deferred
backoff directly, so the worker does not hammer the same provider quota window.

Initial literature intake is saved independently as a `not_started` workflow
draft. Saving a draft persists the context/strategy selection,
history scope, monitoring field, and execution selection without creating a
backfill plan or execution operation. Materialized Source Monitors are derived
from the strategy rather than accepted as client-selected channel ids. Every
Inquiry-scoped draft writes one structural `about` edge from the
`research_workflow` root object to the pinned `inquiry_thread`. That active edge
is the sole Workflow-to-Thread authority; `primary_thread_id` survives only as
a derived API field. Partial unique indexes over the edge's
`primary_inquiry_thread` role enforce one active pin on each side, including
under concurrent writers. The Workflow root carries Project scope, visibility,
provenance, title, and timestamps, while `project_research_workflows` carries
only domain status and execution state. Reads require the Workflow root and
filter the edge unless both endpoints are readable. The server reuses that
aggregate under the Project mutation lock, and the Project start route resumes
only its editable draft or sends started research to the existing operation.
`state_json` keeps the versioned wording snapshot used by execution but is
never an ownership fallback.
Before discovery, the setup UI asks which providers to evaluate: arXiv and OpenAlex
start selected, while anonymous Semantic Scholar is opt-in because its traffic
shares a provider-wide rate-limit pool. The project UI shows a compact intake summary and opens the full setup
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
post-processing rule, and history plan. Research screening recovery batches
are high-priority Source jobs. Each managed structured-output execution has a
two-minute adapter deadline and at most two job attempts. Managed provider
deadlines abort the underlying HTTP request; CLI deadlines terminate the child
process group before returning, so retry never overlaps a still-owned execution.
Operation progress distinguishes
a queued batch from one actively being processed by the model; exhausted
attempts become an explicit retryable screening failure.
The shared Jobs worker retains its conservative ten-minute orphan lease;
Research latency is bounded by its adapter-owned deadline rather than by
shortening the global recovery policy for unrelated job families.
The user's explicit Start action
authorizes the history import for this Project Research operation; Auto Research
does not create a second `source_backfill_start` proposal. Generic Source and
agent-triggered history plans remain proposal-gated. After the history window
and post-processing drain, a `screening_gate` checkpoint records the screening
result; it pauses for approval only when the screened corpus exceeds
`SCREENING_AUTO_CONTINUE_CORPUS_LIMIT`, and otherwise auto-waives and
continues into synthesis (checkpoint policy — see
`.agent/architecture/SYSTEM_ACTIONS.md`).
The resulting `evidence_matrix` includes `relevant`, `included`, and `maybe`
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
`[project-research.synthesis] validation_failed` log line. An `idea_review`
checkpoint is recorded (and auto-waived — it no longer gates) before the
source schedule is activated.

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

Incremental focused runs are created by successful project-bound post-processing or an
explicit trigger after monitoring is active. A 48-hour overlap around the
stored `submittedDate`/`lastUpdatedDate` watermark protects against scan gaps,
while arXiv id/DOI/source-item dedupe keeps the corpus idempotent. After
incremental screening is approved, the managed `research.monitor_compare` pass
resolves `project_research.monitor_compare` and compares every relevant/maybe
material item with the current `understanding` section. It classifies each item as
`supports`, `contradicts`, or `new_direction`, writes the stance and comparison
detail to the evidence card and scan outcome, and completes without producing
a new formal report. Formal synthesis remains an explicit report-snapshot
action.

Standing comparison is a separate Project-level service and does not require a
research Workflow or Inquiry Thread. A per-binding
`standing_comparison_enabled` switch lets `ProjectSourceRoutingService`
collect only newly landed or genuinely reactivated material; Sources does no
analysis. Enabling it
idempotently ensures the four role Notes (`understanding`, `questions`, `ideas`,
and `experiments`). One pending batch per Project accumulates a 15-minute window, sends
at most six eligible corpus items per comparison Run, and admits at most 20
standing comparison Runs per UTC project-day. Project row locking serializes
collection, dispatch, and budget admission. A missing `understanding` role is
durably visible as `blocked_baseline`; a writer can repair and requeue blocked
or failed batches from Standing overview.

Terminal standing Runs write `research_evidence_cards` and a workflow-free
`research_scan_summaries` row (`workflow_id IS NULL`). A `new_direction` also
writes an advice card carrying `source.raise_as_question` and an idempotent
Inquiry Thread input. Background comparison is inert: it never creates a
Thread or edits a Note. A Project writer may explicitly action the card; that
command locks the card and creates or returns the idempotent Inquiry Thread in
the same transaction, then marks the card actioned. Repeated clicks cannot
create duplicate Threads. Dismiss is a separate terminal user choice.

Every Project overview is the presentation entry point for both research modes;
Nothing about a Project's creation gates either mode. Its controlled **Standing
overview** is selected first and
shows the daily budget, open advice, and recent Project inflow without requiring
a Workflow or Thread. Advice and inflow rows are filtered through the same
SourceItem read policy as Project Sources, so Project membership alone never
reveals a private source owner's title, excerpt, or derived advice. The sibling
**Focus workbench** contains the existing
Thread-scoped stage progression and controls. The Research Area remains a
separate three-tab document surface: Reading List, Checklist, and Reports.

Every completed live scan has an append-only `research_scan_summaries` outcome:
focused scans are scoped to a participating research Workflow, while standing
scan windows are scoped directly to the Project. Reconciliation-backed outcomes store
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
selected compiled queries. Activation is rejected while an active Research
operation still consumes the previous channels; after those consumers are
terminal, activation atomically archives the previous version's
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
| GET | `/projects/{id}/folders/{folderId}/tree` \| `/file` \| `/git/status` \| `/git/diff` | Files & Code reads; the requested active remote Location round-trips through the owning host daemon |
| PUT | `/projects/{id}/research/initial-intake` | Save or update the explicit body `workflow_id`; omitting it creates a new draft Workflow |
| POST | `/projects/{id}/research/initial-intake/start` | Start or idempotently resume the explicit body `workflow_id`; omitting it creates/reuses by its selected Inquiry Thread |
| GET | `/projects/{id}/research/workflow` | List research workflows for the project |
| GET | `/projects/{id}/research/scan-summaries` | List immutable monitoring scan outcomes newest-first; an absent date is not synthesized as a zero-result scan |
| GET | `/projects/{id}/research/standing` | Read the standing switch aggregate, daily budget use, recent inflow, batches, and open advice |
| POST | `/projects/{id}/research/standing/advice/{adviceId}/action` | Idempotently create the advised Inquiry Thread and mark the card actioned after Project writer authorization |
| POST | `/projects/{id}/research/standing/advice/{adviceId}/dismiss` | Dismiss standing advice after Project writer authorization |
| GET | `/projects/{id}/research/question/assessment?thread_id=…` | Restore the Thread's durable assessment session, ordered messages, latest structured framework, and explicit assessment baseline |
| POST | `/projects/{id}/research/question/refine` | Persist one Thread-scoped user turn, run refinement from server-owned completed history, and return the updated durable session; `establish_assessment_baseline` atomically promotes a successful result to the comparison baseline |
| GET | `/projects/{id}/research/question/assessment/confirmations?thread_id=…` | List immutable confirmed framework snapshots newest-first |
| POST | `/projects/{id}/research/question/assessment/confirm` | Confirm the current framework; an unchanged repeat returns the current confirmation without creating another context version |
| POST | `/projects/{id}/research/workflow/{workflowId}/stages/{stageKey}/run` | Record a workflow stage transition, optionally linking a `run_id` |
| POST | `/projects/{id}/research/workflow/{workflowId}/trigger` | Trigger an incremental run after baseline monitoring is active |
| POST | `/projects/{id}/research/workflow/{workflowId}/history-backfill` | Extend a bounded baseline into a non-overlapping earlier arXiv range |
| GET | `/projects/{id}/research/workflow/{workflowId}/checkpoints` | List checkpoints for a workflow |
| POST | `/projects/{id}/research/workflow/{workflowId}/checkpoints/{checkpointId}/decide` | Record a human decision (`approved` / `rejected` / `waived`) on a checkpoint |
| POST | `/projects/{id}/research/operations/{operationId}/retry` | Retry a failed managed research operation from its persisted stage |
| POST | `/projects/{id}/research/operations/{operationId}/cancel` | Cancel a running research operation: the row goes terminal synchronously and a job kills its Runs, screening batches, backfill plans, and pass Execution, and waives its pending checkpoints |
| POST | `/projects/{id}/research/operations/{operationId}/reconcile` | Repair a stale operation projection from the canonical run; never re-queues the run |
| PUT | `/projects/{id}/research/operations/{operationId}/item-limit` | Explicitly raise the active research item limit from Project Settings and resume a partial import if needed |
| PUT | `/projects/{id}/research/item-limit` | Save the explicit body `workflow_id`'s draft intake limit; omitting it creates a new partial draft |
| POST | `/projects/{id}/research/question/apply-forward` | Explicitly apply the selected `workflow_id`'s revised Inquiry Thread to future runs; existing decisions and artifacts remain unchanged |
| GET | `/projects/{id}/research/question/assessment/confirmations` | List immutable confirmed assessment-framework snapshots for one `thread_id` |
| POST | `/projects/{id}/research/question/assessment/confirm` | Confirm the current model/user-adjusted framework and create a new immutable Research Context version |
| GET | `/projects/{id}/inquiry/threads/{threadId}/revisions` | List immutable full Thread revisions newest-first for wording/version history |
| GET | `/projects/{id}/research/question/impact?workflow_id=…` | Count papers screened under one explicit Workflow's previous Question version and its synthesis reports |
| POST | `/projects/{id}/research/question/resolve` | Resolve one explicit `workflow_id` with `rescreen`, `synthesis_only`, or `apply_forward` |
| GET | `/projects/{id}/research/reports` | List immutable structured reports, newest first |
| GET | `/projects/{id}/research/reports/{reportId}` | Read combined content, Reader projection, safe resolved references, provenance, integrity, and archive descriptors |
| POST | `/projects/{id}/research/reports/{reportId}/integrity` | Run report integrity and attach its system archive |
| GET / PUT | `/projects/{id}/research/screening-criteria` | Read / upsert generic criteria plus profile-declared domain axes (keywords, date range, source restrictions, required evidence fields) |
| GET | `/projects/{id}/research/evidence-matrix` | Evidence matrix read model over included/maybe corpus objects, with optional academic metadata and evidence/annotation counts |
| POST | `/projects/{id}/research/evidence-matrix/rebuild` | Backfill the project corpus from sources, then return the refreshed matrix |
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
`rejected`. Evidence matrix and integrity archives are explicit report FKs.
Historical Artifact links and synthesis Artifact list routes do not exist.

### Inquiry and Experiment capabilities

Inquiry is Project-owned but not stored as `space_objects`. Its canonical
Question/Hypothesis Threads, working relations, Iterations, Signals,
Candidates, Review Packets, and Delta Briefs live in the Inquiry module.
The Project Research module owns the narrow assessment relationship from one
Thread to one durable question-assessment session. Its ordered message rows
retain successful and failed user turns, assistant replies, and per-turn
structured output; the session caches the latest recommended wording,
refinement framework, and immutable Research Context Version. The server
builds every model turn from completed durable messages rather than accepting
browser-supplied history. Unsent wording edits and Alternative selections are
volatile page state; model responses update only the Assessment Session, not a
Research Workflow draft or the canonical Thread. Explicit Confirm is the sole
action that revises the Thread and hands the confirmed wording to Research
Setup. It writes the user turn before the provider call,
then records the assistant turn and framework in a short post-provider
transaction; a provider failure marks the already-saved user turn failed.
The resolved prompt asset is a stable system instruction. Dynamic Project
context and candidate wording travel in the latest user message, while prior
turns use their real user/assistant roles and `cache_strategy=conversation`;
no provider-specific conversation id is an authority. If a model returns a
sub-question longer than the 200-character refinement contract, the server
runs one independent, schema-constrained repair request containing only the
overlong items and their source indexes. The server locally replaces those
indexes, preserves every valid sub-question byte-for-byte, and reconciles the
user-visible reply with the actual split; the original wording, FINER
assessment, scope, and clarification fields remain authoritative. The repaired framework is persisted
only after the complete contract passes, and a failed repair creates no
Research Context Version. Detection, repair start, and terminal repair status
are appended to the durable user turn as processing events; the assessment UI
polls that turn while the foreground request is active and restores the same
trace from conversation history afterward.
`retrieval_objects` and the Inquiry/Combined graph are rebuildable read models:
every retrieval result is revalidated against the canonical Project ACL, and
graph responses enforce one bounded node budget across Inquiry and
`space_objects` producers.

Experiment is a separate Project capability, not a Project type and not a
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
  `/rooms?project={id}`. A Room may own multiple durable Conversations; each
  explicit draft pins one Host, CLI installation, and Primary Workspace in its
  Conversation execution context, then each message opens one auditable
  collaboration task whose Runs retain the validated `project_id`, pinned
  execution context, speaker identity, task group, and session. There is no
  separate Project Chat route or execution authority. Projects without a
  Folder visibly default to a Conversation-owned managed workspace; a Folder
  Location can be selected explicitly before initialization or attached later
  with same-Host, per-Conversation access. Existing Conversations never rebind
  when Folder Locations change; their stale pinned Location remains executable
  until it is explicitly archived or otherwise becomes unavailable.
  Creating a Room requires Project writer authority and every human roster
  member must already have Project read access. All later Room operations
  re-check that ACL, so Project revocation immediately removes Room access.
- Project creation atomically records the initial Brief; there is no Project
  type, permanent or otherwise (ADR 0019).
- Project Detail also shows recent Sources recommendations from project-linked
  source post-processing decisions. These are selected/maybe candidate items for
  review and follow-up; accepting durable Knowledge still goes through proposal
  review.
- **Publishing a public summary** (`review_status` other than `draft`) requires
  project-**owner**-level authority — the project `owner_user_id`, an active
  Project member with role `owner`, or a space `owner`/`admin`. A project
  `member` (writer) can stage drafts but cannot self-approve. The draft
  generator only ever writes `draft`. This gives Project owners a review gate
  before content becomes space-public.
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

The Project Shell reads `/projects/{id}/overview`, which composes the active
Brief Version, `definition_status`, the four available Modes, per-user
Attention through registered domain adapters, and `in_progress` — the
Project's unfinished Operations. A per-Mode projection and per-entity summary
rows used to ride along, and were removed when the front page stopped
rendering them — an API field with no reader is the speculative code the repo
forbids.

`in_progress` exists because Attention answers "what needs me" and nothing
answered "what is happening": Pulse's In-progress list read the Task board,
and an Operation is not a Task, so a research acquisition screening 873
documents for four hours rendered as "nothing is being worked on right now".
It carries the fields the Research Area's own `researchOperationDetail` and
`researchOperationPercent` renderers read, so the front page shows that same
sentence — "848/873 materials classified" — rather than a second, quieter
version of it, and reaches it without calling an Area's endpoint.

There is no readiness checklist. One used to list a Space-level Provider,
"an Agent" (every Project now has its own), a Source only research work
wants, and a Folder it called optional — configuration state dressed as a
to-do and shown from every Area. A Project needs nothing configured before it
can be talked to or have work put on it. The one Project-level readiness fact
is whether its goal is defined: `definition_status`, which Pulse states until
it is true and then stops. Each Area's own empty state offers its first
action; nothing hides an Area.

Attention is rendered by the persistent navigation shell, which is on screen
from every Area, and by Pulse. Pulse is the Project's front page — goal and
current focus, a prompt to define the goal until one exists (it opens the
same goal dialog as the header's "Edit goal") and a quiet
line pointing at Files & Code (`?setup=folder`, which opens the connect
dialog on arrival) until a Folder is connected, what needs
attention, what is in progress, the latest reported updates — and nothing an
Area owns.
Pulse can edit the goal and current focus directly;
changing the goal appends an immutable Brief draft while preserving the other
fields, then makes review and publish explicit. Submitted Briefs remain visible
in that dialog so an authorized Project or Space owner can complete the publish
handoff. Its Project Instruction dialog uses the same review/publish lifecycle
and resets after publication so another immutable version can be created.
It hosts no Area's working surface — Project Research, Project Sources, and
Project Folders are reached through Research, Sources, and Files & Code, each
of which owns its own creation and configuration actions rather than
delegating them back to Pulse. Workflow creation
remains an explicit user command after its required inputs are ready.
An Area with preserved data remains reachable through grouped navigation
whatever the Project has come to hold.

Inquiry is a Project-owned domain with Question/Hypothesis Threads, typed
relations plus an acyclic primary-parent tree, protected cognitive Iterations,
Definition/Structure/Lifecycle/Work commands, Focus Sets, and Steps.

A Step is one attempt at advancing a Thread: its kind, that it was started,
what it produced, and which round it belonged to. The Next Focus vocabulary is
eight actions — clarify/decompose, search, experiment, read evidence,
synthesize, promote Knowledge, decision case, delivery task — and holds no
states: `pause` restated `attention_state` and `wait_for_monitoring` restated a
running background Step. Steps occupy one of two slots. A Thread has at most
one open `primary` Step, enforced by a partial unique index, because that slot
represents a person's attention; actions with a system operation behind them
(search, experiment) take the `background` slot instead and release the primary
slot immediately, so a running search never stops the Thread being worked on.
`inquiry_threads.next_focus_kind` remains as a projection of the current
primary Step, written in the same statement as any other Thread column so the
per-statement CHECK never observes an inconsistent pair.

The DB-backed invariant is `next_focus_kind IS NULL OR blocked_reason IS NULL`:
a Step and a blocking reason contradict each other. It does not require a
focused Thread to hold either, because a Thread between rounds, or one whose
only running work is a background Step, legitimately holds neither. The CHECK
sees the primary slot only, so the work-state command enforces the same rule
against every open Step: a Thread cannot be blocked while a background search
runs. Clearing the next Step ends background work as well, which is the only
command that calls off a running search; a Thread leaving `active` ends its
open Steps rather than orphaning rows no command could later close. The Shared
Focus WIP limit counts attention rather than activity: a focused Thread whose
only open Step is in the background does not occupy a slot, and counts again
once that Step ends. The limit stays advisory.

A Step with a system operation behind it is completed by that operation
finishing, not by the user saying so: a finished research Workflow closes its
Thread's `search_acquisition` Step and records the Workflow as the Step's
target, on the same post-commit path that queues advice. Manual Steps have no
such fact behind them and end when the round does. Open Steps are readable
Project-wide, which is what lets the Area a user was sent to name the Thread
that sent them and offer the way back.

Opening initial-intake setup is not itself a search and creates no background
Step. The setup dialog remains open until the start request succeeds, so a
failed request preserves both the user's configuration and its error context.
The Research start transaction creates/reuses the pinned Workflow, creates its
first Operation, and only then starts the Thread's `search_acquisition` Step;
all three facts commit or roll back together. Confirming the question closes
the preceding clarification Step but does not claim that acquisition started.

Rounds anchor to Iterations rather than to a separate counter. Recording an
Iteration closes the round's open primary Step as `done` and stamps it with
that Iteration, along with every Step that already settled in that round, so
`iteration_id IS NULL` reliably means "this round"; background Steps still
running keep running into the next one.

That stamping is why round progress is measured against the current round and
not against all-time state: a Thread that has ever concluded would otherwise
read as concluded forever, and the second round would open already finished.
It is also why the stages a person performs by hand are satisfied by that
person having gone and done the work, rather than by the Step reaching `done` —
a hand-done Step is marked `done` only by the close-out that stamps it out of
the round, so waiting for it would never be observable while the round is open.
Evidence gathering is the exception, judged on whether evidence actually
arrived, because a search still running has produced none. The Focus UI exposes
this derived round as one stage workspace: its stage row is the only stage
selector, selecting a stage changes only the adjacent panel, and starting an
action is the separate command that changes Thread work. The workspace keeps
actual current, inspected, completed, and running states distinct. A manual
inspection stays pinned across read refreshes; after a successful action it
follows the newly derived current stage. One suggestion remains visible above
the inspected stage's own actions, while pause, block, early close-out, and
other low-frequency Thread management stay in the Thread menu. A blocked
workspace remains readable with its actions disabled, and Unblock clears only
the blocker rather than implicitly starting a Step.

Signal and Candidate reads revalidate
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

Inquiry Thread Advice is a model-generated recommendation of a Thread's next
step. The UI has one suggestion surface: valid open, non-stale Advice takes its
place there, otherwise an immediate deterministic recommendation fills it.
Users are not asked to distinguish “AI advice” from “system advice”; they may
ignore the current suggestion, which dismisses model Advice and reveals the
fallback. Advice pinned to a superseded revision is withheld because it is not
a valid recommendation for the current state. There is no manual re-analysis
control. Advice is a suggestion surface, never a write path: the recommendation is
stored on its own table and adopting it is routed through the ordinary
work-state command, so `next_focus_kind` keeps exactly one write authority and
one enforcement point for the focused-Thread invariant. A recommendation
outside the defined Next Focus set is rejected rather than stored. Each Thread
keeps one current recommendation, pinned to the Thread revision it reasoned
about; a later revision marks it stale rather than silently outdated.
Generation is queued only after meaningful state changes: an Iteration is
recorded, a material Candidate consolidates, or a search completes, and only
for Threads in the shared Focus set. Duplicate pending/running jobs are fenced,
and any current Advice is retired synchronously when its reasoning context
changes, so the read surface never waits for model latency to stop showing it.
Invalidation changes only open Advice: adopted and explicitly dismissed records
retain their terminal history. A newer event cancels pending analysis and marks
claimed or running analysis superseded; the worker checks that fence before the
provider call and again transactionally before persistence. Actorless events or
Threads outside shared Focus leave no replacement job, preserving the bounded-
spend rule without leaving an old recommendation visible.
The UI may poll ordinary read state every five seconds while work is live and
refreshes on visibility return or a local mutation, but that polling never
invokes the model and idle Threads install no interval. Queuing happens after
the triggering transaction commits and never fails the command that triggered
it.

A Delta Brief is a persisted, read-only, deterministic aggregation over
Evidence Signals in one coverage window — no model call participates. Every
Brief records the window it covered, and the latest Brief is readable so the
next generation continues from that `coverage_end`; a Brief generated without a
`coverage_start` covers the Project's whole history, which is the first-run
case rather than the steady state.

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

All Project routes share one persistent navigation shell in two tiers. Four
promoted destinations are always visible — **Pulse** (the index route),
**Board**, **Updates**, **Conversations** — because they are what a person
opens a Project to do, and a Project is pushed forward through conversation,
so all of it is one list at the first level rather than a Room picker two
clicks down (`GET /projects/{id}/conversations`: every conversation the viewer
can see across the Project's Rooms, mainline first, each opening in its Room;
reading it enrols the viewer in the mainline like opening the Project does).
Everything else sits under a collapsible **Areas** disclosure whose open state
is remembered per browser — six entries, flat: Notes, Inquiry, Research,
Sources, Files & Code, Decisions. The Rooms page (roster, invitations, the
full conversation surface) is reached from Conversations.
What used to be thirteen entries in four groups folded without losing a route:
Raw material and Digest are tabs of Sources (three points on one
source → corpus pipeline); Knowledge review and Experiments are views of
Inquiry (a candidate queue that linked back to Inquiry's Review, and a test of
a hypothesis Thread); Learning and Operations retired to the Space. Every
previous deep link redirects to its new home. Nothing about a Project adds, removes, or reorders an
entry — navigation position carries muscle memory, and a sidebar that grows as
a Project is used costs more than the clutter it saves. An Area with nothing in
it is still reachable and opens on an empty state offering the first action.

A Task that belongs to a Project also opens inside this shell, at
`/projects/:projectId/tasks/:taskId`. It renders the same page as the
top-level `/tasks/:taskId` route, which stays for deep links and for the
cross-Project Tasks list; the difference is that reaching it from the Board
keeps the Areas and the chat panel on screen.

Nothing a Project is used for changes object ownership or visibility.

Board attention is an ACL-filtered Task projection; Automations contribute
`operational_alert` Activity as attention. These adapters register through
the attention registry and do not create Board or Operations tables. The current system
has no Incident aggregate; one must only be introduced with its own demonstrated
lifecycle. Attention rows retain the owning domain's canonical object id only
as transport state and expose a concrete URL: Tasks open Task Detail, Inquiry
Candidates and Decisions open their selected Project-Area records, research
operations open the Research Area's Runs tab with the row selected, and
operational alerts open the Space Inbox filtered to the Project (the
Project-level Operations Area is retired). Pulse does not copy the domain
action workflow.
The Board is the Project's Task surface: lanes are flow statuses, a card
carries its Loop stage and who holds it, and a drag to Done is refused when the
Task has not met what it declared unless the person acknowledges what they are
skipping (`architecture/PROJECT_WORK.md`). The flatter Delivery Area it
replaced is gone and its route redirects. Task Detail remains the full workflow
surface, and its Work tab is where the Loop, the completion requirements, and
the responsibility timeline are read. Research operations, with their
Checkpoint controls, are the Research Area's Runs tab; Automations and Runs
are read at the Space, and project-scoped Automation fire failures persist
`project_id` on their operational-alert Activity so the Project's attention
list can surface them.

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
`/api/v1/projects/{projectId}/operations`; the generic cancellation there
changes only the operation grouping record and never cancels linked execution
objects. Research operations are the exception: their dedicated cancel route
(`/research/operations/{operationId}/cancel`) is policy-enforced as
`research.acquisition.cancel` and also terminates the operation's in-flight
Runs, screening batches, backfill plans, and pass Execution — see
`.agent/architecture/SYSTEM_ACTIONS.md`, `research.cancel_acquisition`.
