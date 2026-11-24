# Artifacts

Artifacts are durable managed records for run output, operational intermediates,
and system archives. They are an audit/export boundary, not the primary reading
model for domain reports. User-facing structured documents such as Project
Research Reports are materialized into their owning domain and opened with the
shared Reader.

`surface_role` makes the product boundary explicit: `user_output`,
`operational`, or `system_archive`. Ordinary `GET /api/v1/artifacts` lists omit
`system_archive`; audit callers may request `include_system_archives=true`, and
known IDs remain readable/exportable under normal access policy.

An `Artifact` records its production context with `artifacts.run_id` when it was
produced by a run. Task attachment is a separate product relationship:
`task_artifacts` links a task to selected artifacts as output, evidence, or other
task-level material. `task_artifacts.run_id` is the task attachment's run context
when the attachment is tied to a task run; `artifacts.run_id` remains the
artifact's producing run. They usually match for run-produced task output, but
manual or reused attachments can keep the task attachment run null while the
artifact's production context remains unchanged.

## Product API

- The server owns the client-facing artifact read/export
  routes:
  - `GET /api/v1/artifacts` (a list first runs an indexed probe on its filters
    alone; when no row matches, it returns the empty page without planning the
    read-rule SQL, which only removes rows. Otherwise one statement evaluates
    the read rules once and returns `total` with the page, so both come from
    one snapshot, and a page past the end still carries the total. Order is
    `created_at DESC, id DESC`, so equal timestamps page without repeats or
    gaps. Run I/O and `/runs/{id}/artifacts` use the same list.)
  - `GET /api/v1/artifacts/{artifact_id}`
  - `GET /api/v1/artifacts/{artifact_id}/export`
- Artifact reads are scoped by space identity and artifact visibility.
  `access_level=summary` returns metadata without inline content; export
  requires effective `full` and 404s otherwise.
- Project-Folder-scoped `space_shared` artifacts store `artifacts.project_folder_id`.
  List accepts an optional `project_folder_id` query and, when present, filters
  on that column. Detail and export authorize from the artifact row through the
  content-read predicate and the room-run read check. A folder id supplied by
  the caller is not required and is not compared to the row. The content-read
  predicate still applies the artifact's own folder: personal-space Project
  Folders are readable inside the personal space; shared-space Project Folders
  are readable through linked Projects where the user is the project owner or
  an active project member. Project Folders with no readable linked Project
  fail closed for non-owner reads.
- Export returns inline artifact content when present, or a file download from
  managed artifact storage when `storage_path` is present.
- Artifact Detail exposes identity, scope, permissions, producing Run, storage
  provenance, and export. It does not act as a domain report renderer.
- Browser export keeps the response status for access-refusal handling and
  checks the requesting session before accepting the response and again before
  saving the file. Logout or cancellation prevents a late response from
  triggering a download.
- List and detail Export controls follow `exportable`. An export refusal
  clears stale data and rereads the current metadata: summary-only content can
  remain visible with Export disabled, while a revoked object shows the
  not-found/not-accessible state. A transient detail read failure has its own
  error state rather than claiming that the object is missing.

## Plugin core port

An operation plugin that declares `artifacts.create` can create one private
inline Artifact (markdown or text, at most 64 KiB, `artifact_type =
plugin_output`, `surface_role = user_output`) inside its command, through the
shared `insertArtifactRow` writer. The person must write the active Project
(the Task writer's gate); an Agent may only target its Run's Project from a
person's own turn, the row records that Run as producer, and the
`artifact.plugin_create` policy action applies the sensitive-read egress
invariant. The Artifact commits or rolls back with the plugin command
([ADR 0030](../decisions/0030-plugin-agent-data-access.md)).

## Sources

- Content-backed artifacts come from `output_json.artifacts`.
- File-backed artifacts come from `produced_artifact_paths`.
- Plain run `output_text` is display/conversation output and does not create an
  Artifact by itself.
- Sources raw snapshots and reader documents are server-produced artifacts.
  `source_reader_document` artifacts use
  `canonical_format="reader_document_json"` and store structured Reader JSON
  with remote image references, not downloaded image binaries.
  Both stay behind their Source item: get, list and export admit a viewer
  only while the Reader would open that item (`sourceDerivedArtifactReadableClause`
  in `sources/sourceItemAccess.ts`), not by the visibility copied onto the
  artifact at capture.
  Inline content and export also require full access to the current origin
  item or snapshot; a snapshot path checks the snapshot's own visibility and
  level as well as its item's. Summary-only origins leave artifact metadata
  readable but withhold the body. Reader document loading applies these same
  origin gates plus the artifact's own full-content and Room gates, so opening
  a document cannot bypass an export refusal.

## Retrieval-derived Briefs and Explain reports

`retrieval_brief`, `retrieval_explain_report` and `ask_space_session` bodies
and metadata are derived from other Space objects.
`retrieval/artifactRelease.ts` is their one release gate and
`retrieval/releaseClosure.ts` the one closure it runs (shared with
`releaseContentRequest`):

- **Contributions.** A Brief/Explain contributes `item_refs`, `citations`,
  `gap_analysis.stale/thin`, any ref-shaped gap record and `target`, all in
  one registry (mixed-domain fails closed; Explain must be Knowledge). An Ask
  Space session records `contributions` — every answering domain's complete
  refs, including a domain whose own Brief failed to save, since the combined
  answer, gap summary and provenance derive from it. Every `provenance` entry
  and every nested `brief_artifact_refs` Brief (same owner, type
  `retrieval_brief`) must lie inside that domain's contributions. A session
  without `contributions` (written before this gate), an unknown domain, a ref
  outside its domain, or a missing/foreign nested Brief fails closed.
- **Domain lineage, one ordered lock set.** Knowledge/Memory: root
  (`space_object`/`memory`), extension row (`knowledge_items`, `notes`,
  `claims`, `sources`), Source connections, accepted `provenance_links` and
  `claim_sources` with their claim roots. Inquiry: the Thread root
  `space_object` (grants, shares, Project audience) and `inquiry_threads`.
  Project summary: the Project audience, its
  `project_public_summary_publications` row and the publication's Source
  connections. Source: its `source_item`/`extracted_evidence` closure. Order
  (all `FOR SHARE`): Project audiences (sorted) → person, Space, folders, roots
  with shares and grants, Source channels/subscriptions/windows → every
  domain's extension rows (sorted) → provenance/claim-source rows. This is the
  order the real writers take: Note save/rollback/metadata/role/relocation,
  Knowledge and Claim update/archive, the Source object update and Inquiry
  operation admission all lock the root before the extension (and Claim
  sources after it); the only extension-before-root writers, the Inquiry
  Thread services, first take the Thread's Project `FOR UPDATE`, so they
  serialize with the closure on the Project; publication publish/revoke
  X-lock only the publication row. The writer-by-writer contract is in
  `releaseClosure.ts`. Rediscovery after waiting must match, else 409 (fails
  closed).
- **Decision.** Each ref needs its canonical root decision `full`
  (`contentDecisionFromDb` on `space_object`/`memory`; a Thread or Knowledge
  root at `summary` does not prove its full content is readable), its adapter's
  current read, and `revalidateForRelease` (canonical Source lineage and
  policy). Source adapters are full-only; a Project summary has no per-person
  root and rests on its live publication, active Project and Source policy.
  Explain additionally needs the current Space maintenance role.

Any withheld, unknown or unparseable dependency (or a lineage change while
waiting) withholds the whole derived object — never only a snippet:
list/detail keep the row's id/title/type with `content`, `metadata_json` and
storage cleared, `exportable=false`, `access_level='summary'`; export returns
404; `contentDecisionFromDb('artifact')` returns `deny`; the Reader's artifact
loader, Claim Candidate Packet sources and eval-diagnostics aggregates skip it;
the Context Ops Explain drill-down clears its diagnostic codes. Released
list/detail/Reader/packet reads are audited through the release path only when
the whole object is released; decision-only checks and aggregates are not.
Persisted Knowledge/Memory reports have their own closure, below; other
Artifact types are unchanged.

Persistence settles the same way after provider I/O
(`settleRetrievalArtifact`): one short transaction locks the current Job claim
(`lockCurrentJobClaim`, when a Job runs it), re-runs that closure for the
owner (and Explain's role), and only then inserts the row; provider and
combined-synthesis I/O stay outside it and an unknown outcome is not retried.
A lost claim (`JobEffectLeaseLost`) or withdrawn authority
(`RetrievalArtifactWithheld`) writes nothing; Brief callers report
`artifact_error`, Explain reports `retrieval_explain_persist_withheld`, and
Ask Space reports `session_artifact_error: ask_space_session_withheld`.
Context Ops Brief summaries list only the owner's own query title and surface.

## Persisted Knowledge and Memory reports

A report written by a Knowledge/Memory report operation (or the Context Ops
review cycle and observation scan) is the same derived body as that
operation's poll result, so it passes the same gate on every read.
`CONTEXT_REPORT_ARTIFACT_OPERATIONS` (`retrieval/artifactRelease.ts`) maps each
stored type to its operation: `retrieval_maintenance_report`,
`memory_maintenance_report`, `retrieval_eval_report` (a `product_diagnostic`
one is a diagnostics report), `retrieval_calibration_decision`,
`claim_contradiction_report`, `claim_candidate_packet`,
`relation_discovery_report`, `object_schema_suggestion_report`,
`context_review_cycle_report`, `context_observation_report`.
`retrievalArtifactWithheld` runs `withheldContextReport`
(`retrieval/contextReports.ts`, shared with `releaseContextReport`) in one
transaction: every typed reference in the stored metadata
(`contextReportReferences`: `findings[].objects`, proposed-action endpoints,
Memory targets, source/evidence Artifacts, proposals, activities) pinned in the
shared closure order, the operation's current authority
(`authorizeContextReport`: person, Context Ops scan opt-in or admin for
`knowledge.eval.report`, Space-wide reviewer for a `space_ops` report), `full`
on every reference, then the canonical Source policy gate. Any refusal, lost
authority, lineage change, missing metadata, or a maintenance finding without
well-formed `objects` refs (an older or damaged record) withholds the report
whole. A referenced Artifact is decided by `contentDecisionFromDb`, so a
Claim Candidate Packet or review-cycle report falls with a withheld source
report.

Exits that apply it: Artifact list/detail/export (as above, and the stored
"N findings" title becomes the type label, e.g. "Retrieval maintenance
report"), `contentDecisionFromDb('artifact')`, the Reader artifact loader,
Claim Candidate Packet sources, eval-diagnostics aggregates, and Context Ops:
the summary's maintenance `finding_counts` and diagnostics codes/trend
metrics are aggregated only over released reports, the maintenance and
diagnostics drill-downs return a withheld report under its type label with
no codes or finding count, and a maintenance packet whose report is withheld or missing
is listed by its type label. `recent_report_count` and
`pending_packet_count` still count the viewer's own rows.

Producers run their scan and insert in the one Job transaction that holds
the current claim and report authority (`runContextReport`), with no
provider I/O, so there is no post-I/O settlement. The Context Ops
review-cycle/observation routes and the retrieval maintenance automation
target also write without provider I/O; their reports are gated on read like
any other.

**Dependency closure per stored shape.** A report is only as checkable as
the references its producer stores beside its numbers. Producers that
aggregate (and so would otherwise drop the objects behind a count) record the
complete contributing set and stamp `dependency_closure: {version: 1}`
(`REPORT_DEPENDENCY_CLOSURE_VERSION`, `retrieval/reportClosureContract.ts`).
A stamped report whose closure is empty is a legitimate empty report and is
released; an unstamped aggregate (an older record whose producer dropped the
references) fails closed. `[]` alone is never read as "no dependencies".

| Stored type | What its numbers/text derive from | Recorded closure | Unchecked/legacy shape |
|---|---|---|---|
| `retrieval_maintenance_report`, `memory_maintenance_report` | findings | `findings[].objects` | finding without well-formed `objects` → withheld |
| `retrieval_eval_report` (`product_diagnostic`, incl. review-cycle diagnostics) | released Briefs, maintenance and eval reports of both windows | `source_artifact_ids` (each rechecked recursively) + stamp | unstamped → withheld |
| `retrieval_eval_report` (submitted, `knowledge.eval.report`) | the submitter's own request | its typed refs | — |
| `retrieval_calibration_decision` | evidence reports | `evidence_artifacts[].artifact_id` | — |
| `claim_contradiction_report` | claim pairs | finding claim ids | — |
| `claim_candidate_packet` | source reports | `source_artifacts[].artifact_id` | — |
| `relation_discovery_report` | candidate endpoints/evidence | candidate object ids, `evidence_refs` | — |
| `object_schema_suggestion_report` | every visible row of a kind, a published Project public summary included | one `evidence_refs` entry per counted row (`visible_usage_count === evidence_refs.length`; a summary's ref is `{object_type: 'project_public_summary', object_id: <project id>}`) + stamp | unstamped, or a positive count without its rows (including an older Project-summary finding with `[]`) → withheld (also at poll); a zero count with `[]` is released |
| `context_review_cycle_report` | child maintenance/diagnostics/Memory/claim reports | child `artifact_id`s | — |
| `context_observation_report` | released maintenance/diagnostics reports of the summary | `source_artifact_ids` (`getSummaryWithSources`) + stamp | unstamped → withheld |

A published Project public summary is not exempt for being Space-public.
The scan counts it only while its publication exists, its Project is active
and the publication's `source_refs_json` Sources pass the viewer's Source
policy. Its ref is then rechecked by `withheldContextReport` through the
Project retrieval registry, inside the same shared release closure
(`lockRetrievalReleaseClosure` / `withheldPinnedReleaseRefs`) that Ask Space and
Briefs use. That closure pins the Project audience and the publication row,
requires the live publication and an active Project (the adapter's
`revalidate`), and applies the Source policy to the publication's Source
references. Withdrawing the publication, archiving the Project or revoking a
referenced Source's consent therefore withholds the stored report and its poll
result. The summary has no content resource of its own and records no content
read. A referenced
report Artifact is rechecked through `contentDecisionFromDb` →
`retrievalArtifactWithheld`; the chain of reports on that path is tracked
(`AsyncLocalStorage`), so a cycle or a chain deeper than 8 fails closed
instead of recursing.

**Report-derived Proposals.** A review packet (`retrieval_maintenance_packet`,
`memory_maintenance_packet`, `retrieval_diagnostics_packet`,
`relation_discovery_packet` by `report_artifact_id`; `claim_candidate_packet`
by `packet_artifact_id`) and a child generated from one
(`report_artifact_id`, `source_report_artifact_id`,
`source_maintenance_report_artifact_id`,
`source_candidate_packet_artifact_id`, or a `derived_review` Artifact
provenance entry), at the top level or nested in the child's packet context,
repeat their report's findings in title, summary
(`proposed_content`), rationale and provenance. Those dependencies are frozen
in the payload when the Proposal is generated
(`proposalReportDependencies`, `retrieval/proposalReportDependencies.ts`) and
checked now by `proposalReportWithheld` (`retrieval/proposalReportRelease.ts`):
each named Artifact must exist, be a gated report and pass its closure. A
packet without its report reference fails closed. The shared child INSERT
(`acceptReviewPacket`) stores each producer's payload as built, so the
extractor reads every producer's actual shape:

| Packet → child types | Where the child names its report |
|---|---|
| `retrieval_maintenance_packet` → `object_relation_create` | top level: `source_maintenance_report_artifact_id`, `provenance_entries` (`derived_review` Artifact) |
| `memory_maintenance_packet` → `memory_archive`, `memory_update` | top level: `source_report_artifact_id` |
| `claim_candidate_packet` → `claim_create`, `object_relation_create` | `metadata.claim_candidate_packet.{source_candidate_packet_artifact_id, provenance_entries}` plus the candidate's `metadata.source_artifact_ids` (the Brief / maintenance / diagnostics / Memory maintenance / contradiction report it was read from) |
| `relation_discovery_packet` → `object_relation_create`, `knowledge_create` | `metadata.relation_discovery_packet.source_report_artifact_id` |
| `retrieval_diagnostics_packet` | acknowledge-only, no children |

A child carrying a nested packet context that names no report (an older or
damaged record) fails closed. A Proposal with no packet context (an
ordinary `claim_create`, `knowledge_create`, imported-history `memory_create`)
keeps only its own gates. Exits: Proposal
list/detail (`PgProposalRepository.releaseReportFields` — the type label as
title, empty `proposed_content`/`rationale`, null `title_parts`/provenance;
id, type, status, visibility and decision fields unchanged, so the
Proposal's own view permission and revision semantics stay), and Context Ops
packet titles. Acceptance (`acceptInTransaction`, also reached by Agent
`proposal.decide`) pins the same closure before the Proposal row lock, refuses
409 while withheld, and refuses 409 if the locked payload names different
reports; the B10 applier and its provenance run unchanged afterwards.
Reject stays available.

Known limits: scan-footprint counts (`scanned`, `candidates_examined`,
`sources_scanned`, `links_extracted`, `scanned.visible_usage_rows`) and the
Context Ops health counts embedded in observation/review-cycle reports
(Source-policy warnings, embedding backlog, Memory access counters,
`pending_packet_count`) carry no object identity and are not part of the
closure; `recent_report_count`/`pending_packet_count` still count the
viewer's own rows; a reference whose type has no content resource
definition fails the whole report closed.

## Storage Rules

- File artifacts are copied or registered into managed artifact storage.
- The database stores a durable relative storage reference, not a sandbox absolute path.
- Sandbox paths are temporary execution details.
- Artifact records must remain scoped to the owning run and space.
- The server resolves file-backed exports under
  `ARTIFACT_STORAGE_ROOT` (default:
  `$RAINVER_HOME/storage/artifacts`).

## Path Safety

- Unsafe paths are rejected.
- Rejected artifact paths are recorded as `materialization_errors`.
- Path traversal, absolute path input, missing files, and paths outside the allowed runtime output root must not create artifact records.
- Export rejects absolute paths, NUL bytes, path traversal out of managed
  artifact storage, sandbox-root reads, missing paths, and non-regular files.

## Bound Research archives

Report archives/evidence/integrity artifacts are not independent publications.
Their existing report foreign keys, producing Workflow/Run and Operation output
IDs establish provenance; copied titles, visibility or metadata do not grant
access. The canonical Artifact ACL additionally checks originating Thread/Run
and direct Source dependencies for list/count/detail/export and references.
Full content reads also validate call input references and originating research
artifact dependencies (bounded to 200 distinct artifacts; excess requires
reconciliation). Reader uses the same gate. Missing direct authority hides the
archive; classified input-content withdrawal may return only a generic summary
without body, source-derived title, storage location or producing context.
Export still requires full access. Legacy unbound artifacts retain existing
rules. No stored content is rewritten on withdrawal and no new publication or
visibility state is introduced.

The same transitive input gate now applies when reading the owning Research
call/report, preventing an archive's denied leaf from being bypassed through a
domain report. Graph enumeration is bounded and cycle-deduplicated in SQL;
Project/Thread/Run predicates and at-most-40-reference batches reuse canonical
ACLs. See [cross-domain evidence](PROBLEM_ENGINE_ACCEPTANCE.md#artifact-graph-evidence-and-limits)
for the measured dense-origin/200-node envelope and its limits.

For bound Research output, every **direct** origin of the requested Artifact
must pass its Project/Thread/Run and Source gates. Unreadable direct origins
hide the Artifact, including its list count. An otherwise readable root whose
**transitive input** origin is unreadable instead has a generic summary:
no original title, body, metadata, storage, owner, producing Run, proposal or
folder context; preview/export are disabled. This summary is not a grant to
Reader content, report/result bodies, download or model egress. An origin
reached both directly and through an input remains direct. Binding conflicts
and database failures propagate; they are not content-withheld fallbacks.

A malformed dependency binding can therefore fail an entire list page with
409 instead of returning partial rows. Operators must use the bounded problem
engine audit/reconciliation procedure in
[upgrade compatibility](PROBLEM_ENGINE_UPGRADE.md) before retrying; never
repair this by treating corruption as an authorization summary.
