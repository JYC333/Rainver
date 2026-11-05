# Source material processing

Sources owns material acquisition and retained reading documents. Search queries
and saved links enter the same `source.material.submit` contract, Run-scoped
submission validator, policy gate and reading document writer. Reader displays
material; it does not execute a webpage worker in the browser.

## Authority and execution

A query keeps its existing goal/version/collection lease, exact preview and
scheduler ownership. A saved link is processed in place: its operation is an
`extraction_jobs` row marked `material_processing`, and execution is an ordinary
canonical `agent_run` job. The extraction worker never claims these coordinated
rows. This adds no scheduler, model loop, CLI adapter or credential channel.

`materialProcessing/dispatch.ts` guards both shapes before actual dispatch and
submission. The public payload has one `processing_id`; Space, user, item or
immutable goal/version, Agent/Profile and configuration come from the persisted
Run. Collection grants only `source.material.submit`; Reader saved-item investigation also grants the bound `source.material.investigate` feedback action. It does not include
`authorization.request` or broad Source writes. The gateway retains its registered
approval configuration and binds policy checks to the actual goal or item.
Invalid submissions follow the same gateway policy/audit path and have at most
three corrections in the same Run. URL, observation time, size, retention and
credential-text checks precede persistence. Actual permissions failures never
become a correctable formatting error.

Existing goal selections remain pinned, including advertised model/mode values.
The item preparation API can bind explicit selections for callers, and Reader exposes the same explicit Agent/Profile/model/mode selection through Execution settings. An active operation
refuses a changed selection. Unbound items select an eligible owned Agent's
existing default Profile. Configured OpenCode profiles use the ordinary adapter;
no managed Room assistant is borrowed for a headless Run. If no executable owned
selection exists, the caller must configure/select one rather than changing
Agent, provider, model or account silently.

Collection prioritizes broad relevant discovery: brief relevance checks and distinct
links across appropriate query angles and sources, without requiring a body or a
deep analysis report. Deep reading is a separate manual operation. The Agent
uses existing runtime permissions without a collection-imposed total duration;
explicit owner-set canonical budgets still apply. Saved-item preparation retains
its separately admitted ten-minute default. The collecting Agent
submits retrieved source text or clearly attributed synthesis with supporting
URLs. Read failure and link-only results are not fabricated into a body. An actual
empty search remains distinct from an unavailable tool or failed read. Native
request counts and cost can be unknown.

HTML extraction retains positive integer image dimensions through the shared
Reader normalizer and keeps figure captions as text. Images explicitly marked
`aria-hidden="true"` or with `role="presentation"` / `role="none"` are omitted;
empty or absent alt text alone never makes an image decorative. CSS from the
source page is not carried into Reader. This affects new extraction only; no
stored document or historical version is rewritten.

## Storage and recovery

Run settlement is a projection boundary: material processing uses
`reconcileTerminal`, and native-search reconciliation is restricted to the
named terminal Run. These callbacks never cancel active Runs while holding
finalization ownership. Deadline checks and stop commands stay in the ordinary
read/tick recovery path; both paths reuse the same idempotent result acceptance.

`SourceMaterialReadingContentSchema` is a typed inline field on the existing
Source item output. Bodies are not hidden in `metadata_json`, converted through
an empty HTML parser, or written to a temporary handler file. The canonical
Source materializer and ordinary HTML/PDF extraction use
`materialProcessing/documents.ts` for Reader artifacts. `content.format`
(`source_text`/`agent_summary`) is provenance only; `content.syntax`
(`plain`/`markdown`) declares markup. A new submission must declare it: the
intake (`submission.ts`) refuses content without `syntax` with a field error
the Agent corrects in the same Run (at most three submissions in total,
corrections included), and both
Run prompts and the Work Skill name the field. The schema keeps it optional so
stored submissions written before stay readable. Declared Markdown is
converted by the shared `@rainver/reader-document` markdown-it converter (raw
HTML stays text, code is kept verbatim, images become block nodes); `plain`
text, and text of earlier submissions without the field, stays literal
paragraphs. Syntax is never inferred from the text. The declared syntax is
recorded as `reading_content_syntax` (item and artifact metadata). For Agent text (an `agent_provided_v1` artifact) the Reader payload carries
`agent_text_syntax` of the version shown, from that version's own artifact
metadata: `undeclared` (earlier submissions), `plain` or `markdown`. Undeclared
and plain text stays literal; nothing converts it by itself. A writer of that
material (the authority of reading it again, under the Source's storage
policy) may explicitly ask for the version shown to be read as Markdown
(`POST /api/v1/sources/items/:itemId/reading-syntax` with the payload's
`artifact_id` and `source_snapshot_id`; `materialProcessing/syntax.ts`). Under
the item's row lock the shown version is resolved again by the Reader's own
rule (`PgReaderRepository.shownSourceItemVersion`: current extracted artifact,
else the latest readable extracted snapshot, same gates); if it is not the one
named the request fails with 409 `reading_version_changed` and nothing changes.
A `markdown` version is not converted again. The version's stored text is
exactly what the Agent submitted; it is converted with that version's own
kind, format and sources and saved through the canonical writer as a new
version (expected-hash guarded; the shown version and snapshot are kept;
annotations are relocated or listed as not located; read state follows the
writer's revision guards). One material per explicit, confirmed request;
nothing is backfilled. The Reader then reloads the document as a request owned by the
page (page and item mounted, latest request, same session): a reply after the
page left, after A→B→A or after logout changes nothing and is not reported; a
refusal (401/403/404) removes the text, its unsent comments and its
annotations exactly as on first load; an ordinary failure keeps the text shown
and says the new version was saved but not reloaded. "Shown as Markdown" is
said only when that owned reload put the new version on screen. Agent documents keep
`image_policy: none`, which the Reader honours by not loading their remote
images inline. Fetched text is read by its declared media type: HTML through the
structural extractor, `text/markdown` (or a `.md`/`.markdown` URL with no or
an `application/octet-stream` media type — `fetchSource` treats those as text
too) through the same converter, `text/plain`/JSON as plain paragraphs; an
explicit media type always wins over the extension, and an explicitly HTML
candidate (the arXiv HTML rendition) is HTML. Reading an item that already has
text again (Reader's Read again) first explains the impact — a new version is
saved and the current one kept, annotations and comments stay and those that
cannot be placed with certainty become unlocated, nothing else is
reprocessed — and starts only on explicit confirmation, through the same
operation and Run as before. Artifacts and extracted
snapshots inherit the item's current access context. Deterministic extraction
keeps its provenance; Agent content stays unverified and records kind, format,
method and source URLs in a whitelisted Reader DTO.

Saved-item processing commits artifact, snapshot, item revision and final operation
status in one transaction. Item/Source/Agent/Profile authority is rechecked before
write; a concurrent body, membership or policy change refuses stale results.
First fill uses existing body-revision/read-state guards. Explicit re-reading
creates the existing kind of new body revision, not a duplicate material or a
silent annotation reset. Collection deduplication may fill a missing body, but
does not replace an already saved body during ordinary repeated collection.

The existing terminal Run reconciler saves completed work even after Reader is
closed. Opening Reader also reconciles/reports the latest owned operation. Queue
waiting does not consume execution time; an overdue dispatched operation is
cancelled through canonical Run orchestration. Cancellation or real action
refusal prevents a stored submission from being applied. Only field corrections
(and harmless repeated/limited submissions after a valid one) may recover a
`degraded` Run. Private submission/recovery bodies are removed at terminal
settlement. Existing source sample maintenance reapplies retention to goal data.

## Source permission and UI

Metadata-only policy is enforced before starting a reading Run. The UI can
request a single Source-wide `source_material_retention` proposal; only the
current Source owner with current Project write access can accept it through the
canonical proposal applier. A policy hash prevents accepting a stale decision.
It changes only reference capture to text capture and retention to full text;
it adds no archive, reader, credential, external-model egress or network grant.
No legacy default is inferred as human consent, and no bulk live-data migration
runs. Changed Source authority makes old exact-preview proofs stale before a
new automatic model Run is admitted.

Standard API preparation bounds reading to the main resource and up to two relevant
documentation pages; Reader investigation permits up to eight relevant evidence pages, require per-fetch timeouts and stopping after repeated
failures, prohibit dependency installation, and reserve time for submission. These
are Agent instructions, not a guarantee that every external page is readable; the
canonical admitted Run deadline remains enforced. Submission and recovery read
that same contract with the shared Run time-limit resolver; no separate
three-minute expiry exists. Independent items use separate Run/jobs in the
existing concurrent worker pool; per-item serialization only prevents duplicate
preparation of that same item. Host/account concurrency and quota still apply.

Reader and direct URL saving use `MaterialProcessingPanel`: one start/retry,
canonical queued/working/waiting/final status, cancel and actual Run link.
Reloading resumes observation; opening does not itself start a model Run.
Read-only viewers cannot prepare/replace content. The old list-card and URL-dialog
webpage runners are removed. Ordinary extraction endpoints remain tools for
existing API Sources and ingestion, not compatibility shells for the deleted
search-specific action. `source.goal.submit_search_results` is not registered.

Reuse / Dependency Check: canonical Run/job admission, Source extraction records,
Source consent and egress, proposal applier, Source materializer, existing Reader
JSON and read-version guards are reused. Existing HTML/PDF extractors remain
valid deterministic executors. No new dependency, table or instance migration.

## Broad Agent-native collection

New native collection Runs use the code-owned `goals/collectionPrompt.ts`
discovery contract, not the manual investigation method. They collect broadly
within the existing item/time/spending limits; preview alone may use a small
representative sample. A title, excerpt or brief page check can establish
relevance. Missing original text, a publication date or a completed analysis
report does not block a valid link. Optional descriptions/available source text
still follow Source retention policy and the existing submission validator.
Importance does not exclude valid unjudged candidates. Familiar unchanged pages
are avoided; canonical URL deduplication and evidenced-change delivery remain.

`workflow_input_json.source_collection` freezes the authorized topic/Project
context hash and output Project independently of any deep-reading deployment.
The shared closed Work Context, dependency locks, Source audience/egress checks,
originating goal Project access and exact goal/version/Profile/lease checks
still apply at Delivery, dispatch and acceptance. Manual method changes or an
uninitialized/disabled investigation method cannot block new discovery Runs.
Collection output does not claim deep-reading method provenance. Already queued
legacy Runs with `reading_method` retain their admitted method and checks.

## Versioned investigation method

Saved-link preparation and manually triggered investigation resolve
`reading.project_investigation` through the approved-only prompts resolver at
Run admission. Its exact version, content/render hashes, resolution provenance
and authorized Project-context hash are frozen in `workflow_input_json.reading_method`.
A queued Run never selects a newer deployment on recovery. Missing catalog or
production resolution is an explicit initialization error, not a hardcoded fallback.
Catalog sync remains explicit; opening a Reader or the method workspace does not write.

The strategy directs bounded primary-document/example investigation rather than
homepage paraphrase. The existing submit schema, three-submission limit, egress,
retention, URL limits, runtime permissions and ten-minute budget remain code-owned.
Production investigation uses the requester’s existing Source/material access.
Project context is injected only into material canonically bound to that Project;
broader native collection stays topic discovery with no Project WorkContext.
Trial comparisons still require the complete current Project audience. Dispatch, accepted Delivery and final materialization recheck the
frozen context and actual Run destination. Delivery/Source commit reuse the canonical
Source ACL locks; a lost permission cannot be turned into a content write by replaying
an accepted native-search batch. Work Context disables automatic retrieval and pins;
formal Project Runs retain their canonically bound Project context/instructions.

The canonical Source writer records the method provenance and originating Run on
Reader artifacts and items. Reader's improvement entry checks the version actually
shown (including extracted-snapshot fallback); unknown historical attribution stays
unknown. Reprocessing still writes the material's own scope: a Project edition link
does not turn a shared original into a privately Project-specific document.

The controlled comparison workspace is described in [Reading methods](READING_METHODS.md).
Its private trial Runs have no material-submit capability and cannot replace Reader
content, annotations, reading state or Following cursors. Neutral annotations and
closed briefing generation are unchanged; briefing excerpts remain bounded.

## Saved-item investigation and execution selection

Reader preparation now explicitly sends `investigation: true` on the existing
start endpoint. It still executes one canonical Agent Run on the selected ACP
Profile; there is no second server model loop or automatic delegation. Existing
API clients that omit the flag and goal collection keep their existing bounded
submission contract. Starting a different investigation mode while an operation
is active is refused, like changing its execution selection.

The Reader's **Execution settings** reuses `AgentExecutionPicker`: choose an owned
Agent, an enabled existing Profile, and the model/mode options its actual runtime
advertises. OpenCode can use an existing `model_provider` Profile; an installed
Antigravity Profile can use its existing account. Opening settings makes no model
call, creates no Run and changes no credentials. Reset restores topic/default
inheritance. A running operation cannot be changed. The processing projection
shows its actual Agent/Profile/runtime. Selecting another Profile clears the
previous Profile's model/mode overrides.

Investigation admits only `source.material.submit` and the new bound
`source.material.investigate` action, through the existing Dispatcher/Gateway.
`search` wraps the existing Source retrieval registry in lexical mode (no extra
embedding/rewrite/model calls), at most three queries/eight candidates per query;
`read` opens at most five eligible Reader bodies, up to 12000 characters each,
with their own synthesis provenance and explicit truncation. Twelve successful
investigation actions fit within the same admitted ten-minute deadline. There
are no generic Knowledge/Memory tools and no ambient retrieval expansion.

History is filtered to the report audience (without oversight), compatible
visibility/Project scope, Source retention/egress and Artifact/Room access.
Historical references, including bounded inherited references, are frozen in the
operation and rechecked before submission and publication using canonical Source
locks. Frozen versions can still resolve their retained snapshots after a later revision; missing, changed or unauthorized dependencies fail closed. The final Artifact retains
those references; the shared Source-derived Artifact gate checks them on Reader,
Artifact list/detail/export reads too. A history-derived Agent summary is not
copied into the Source excerpt/index. Temporary investigation state is removed
at terminal settlement. No private history is made shared just because its
requester can read it; read/accepted status is not guessed.

`check` accepts the full report draft plus one to three question records with
finding, explanation, citations, limitations and alternative explanations, the
historical comparison, remaining gaps and stopping reason. Records quote report
passages: a checklist beside a shallow report does not satisfy the check. It
returns missing-coverage feedback in the same Agent tool loop. Only the exact
checked `agent_summary` is accepted for an investigation; unavailable primary
material may still follow the existing truthful unavailable/failure path.
This is a deterministic coverage/consistency check, not independent fact checking
or a semantic quality verdict. Ordinary fetches remain runtime tools; observed
round counts and real-model quality are not inferred from a successful submission.
The primary resource may be followed by up to eight relevant evidence pages,
not a fixed quota; no dependency installation, account fallback or unbounded
research is introduced. Source network/retention controls remain authoritative.

### Following purpose in saved-item analysis

Preparation resolves the owned topic's active plan (or retained material version
when no plan is active) and freezes its reference as `reading_following`. The
versioned intent, title and optional `analysis_brief` accompany authorized Project
context in the reading input. Same Space, goal owner, Project and Source-version
binding are required; personal purpose does not copy into shared material.
Legacy plans without a brief use their saved intent, or retained plan summary
when legacy intent provenance is missing; ordinary saved links remain
ordinary reading. Context hash checks at dispatch and acceptance refuse changed
or revoked admitted context. Later draft conversations never rewrite a queued
Run's purpose. Investigation instructions require checked findings to address
that purpose and disclose missing baseline evidence; coverage checking still
does not prove relevance, factual truth or semantic depth.

## Project Reading R1: immutable analysis separate from original

For canonically Project-bound items, and Project Following output referencing a
global material, new Agent output (including declared
`source_text`) is unverified analysis, not a deterministic capture. The canonical
writer creates a private `summary` Source snapshot with `reading_role=analysis`,
its own Reader Artifact, originating Run and optional deterministic original
snapshot reference. It never changes the item's extracted pointer, hash, excerpt,
body revision, annotations or reading positions. One Run/item can publish one
immutable analysis; replay reuses it, differing content conflicts. Original text
still comes from the existing deterministic extraction writer/policy, which marks
its extracted snapshots `original`. No new fetch, archive grant or model call is
introduced by a read. Missing originals remain not retained/unknown, not a
successful original capture inferred from a report. Personal material writes
retain their existing behavior in this phase.

Snapshots add nullable role/Run/original reference fields (migration
`0007_project_reading.sql`).
The original-reference FK stays within one Space/item; Run FK stays in Space.
`original_snapshot_id` associates the latest deterministic original available at
settlement; it is not proof the Run actually consumed that version. Goal
collection does not currently supply an expected original hash. Separately frozen
history refs retain their own exact identities; later stages must freeze the
actual input before claiming a consumed-original version.
Existing rows are not rewritten: read-time classification treats known extractor
metadata as original, Agent artifacts as legacy analysis, everything else unknown.
Existing item and snapshot deep links/anchors/progress retain their identities;
a legacy item showing analysis is not silently switched to another body's
identity. Retained deterministic originals are separately discoverable via the
Reader records projection. A raw archive without readable extraction is not
relabelled a Reader original. No bulk refetch/backfill runs during migration.

Analyses default private to the originating requester (legacy missing Run uses
item owner with unknown Run attribution); they never inherit the item's shared
reader grants. A Project Following can reference a global original without
changing that original's scope/body: the private analysis carries its own Project,
while its canonical item and original snapshot remain global. This does not
promote a private result to shared theme input. Legacy Project analysis remains
readable at its old identity; the old current-item Markdown conversion refuses
409 rather than copying a private analysis into the original slot. Personal
conversion behavior stays unchanged; analysis-specific editing is not a R1 UI.

Artifact/Source snapshot/Project/current Source retention and
original/history dependency gates remain active on generic Artifact and Reader
reads. The frozen actual model destination is recorded from the canonical Run;
retained derived reads also fail closed when Source egress to that destination
is withdrawn. Missing legacy egress consent is not inferred as approval.
Both retention/capture and destination consent apply to the parent Source and
every supporting Source, including analysis-only records without original refs.
Restoring those permissions restores reads; personal single-document semantics
are unchanged. Reader's live availability projection is page-independent and
keeps uncertain, custom, raw or inaccessible original evidence `unknown`.
Publication of shared theme outputs, explicit deep-reading operations and
favorites are later R2–R4 contracts, not implicit sharing of these private rows.

R1 bounds are 200000 persisted text characters per document (the existing Agent
submit per-item limit is tighter at 60000), 16 total original/history dependency
refs, 25 records/page and offset at most 10000. Existing canonical Run duration,
submission count and SourceGoal budgets are unchanged; no token/money hard cap
is claimed. No per-topic/total-stage scheduler is introduced here.

### R2 original preparation for explicitly enabled Project themes

After canonical Following membership materialization, `themePreparation.ts`
queues existing deterministic `queue_content` extraction for at most20 eligible
items per batch, under the existing requester's Source/retention/network/storage
and quota gates. This is only for an exact-version opted-in Project theme and
missing original content or a newly recorded cited change, not a blanket refetch
of duplicate saved items. Existing Project Agent reports are no longer used as
`content_saved` deduplication or overwritten on each check. An Agent report does
not become original evidence; the actual extraction terminal is independently
awaited, with honest pending/failure coverage. Personal material behavior is
unchanged. `sharedOriginalVersions` is the narrow Sources facade for exact,
deterministic historical snapshots: every current Project reader must fully read
the Snapshot, Artifact, original Source and collecting provenance. It never copies
private analysis into theme input. The associated exact original/hash is the text
actually supplied to theme synthesis, unlike R1's settlement-time availability
reference on older individual reports.

## Project private deep reading (R4)

`deepReading/` is the private Project request adapter over this same material
processing pipeline, not a new queue, Agent loop or report database. The public
Project `reading` routes freeze Project + explicit optional Following version,
the deterministic original Snapshot/Artifact/hash actually supplied (at most6000
characters, truncation declared), approved `reading.project_investigation`
version/hash/context and owned Agent/Profile/advertised model/mode. No Following
is inferred for these requests; null means ordinary investigation. A selected
purpose must be active/confirmed and the material must belong to it. The context
contains authorized Project facts, not Project Folder files, Memory or logs.
An unknown/unretained original remains unknown; Agent `source_text` never creates
an original, and report submission requires the existing investigation check.

The existing private canonical Agent Run and `extraction_jobs` row record the
requester, Project, exact original and purpose, method/configuration fingerprint,
input key and generation. The item lock serializes duplicate admission; equal
inputs reuse the operation (including terminal results). `retry_of` / `rerun_of`
name the exact current terminal operation; duplicates reuse its successor,
changed inputs require a fresh request, and at most3 generations share an input
key. Canonical budgets may tighten the requested600 seconds. There are3 total
submissions,12 feedback tool calls,3 history searches,5 history documents and16
dependency references; frozen prompt+instruction are bounded to48000 characters.
There is no token/currency hardcap or quality claim.

Read/list are owner-private and pure: they do not reconcile, generate, mark read
or repair. A Run that ended before result projection shows `settling`, not a
completed report. Canonical terminal reconciliation owns publication/recovery.
Cancellation uses canonical Run stop/ACK using only requester/Project/operation
identity, even after Source or Project access is revoked; it does not expose the
withdrawn prompt/report or pretend `cancelling` is final. Late old submissions
are refused by the existing active Run/operation guards.

The exact original snapshot is revalidated at dispatch/physical Delivery and
publication. Author re-extraction may change the current item hash without
switching the frozen version. R4 passes an explicit original id (or explicit
unknown) to the R1 analysis writer; it no longer selects a settlement-time newer
original for these operations. D/D2 stay independent private summary snapshots,
with server-owned Run origin and history dependency metadata. They never replace
Source text, excerpt, retrieval index, annotations or reading progress. Failed
reruns leave earlier reports available through the operation history.

Full live item/Source, retained-analysis policy, actual Run destination, exact
original, Project/purpose and history permissions protect request, dispatch,
physical Delivery, publication and reads. The generic Run gate uses the same
private dependencies; the Artifact/Reader/records/export SQL gate also checks
R4's Project, exact original's own Source and selected Following's Source so a
private context cannot bypass withdrawal via copied output. Profile freshness
is required for execution; reading a past output does not require the current
Profile fingerprint to match. Automatic retrieval/pins remain closed. Private
history is admitted only for its owner and cannot enter shared themes/totals.
Existing preparation APIs keep their writer semantics and exclude R4 operations
from their old per-item aggregated state; personal preparation is unchanged.

R4 additionally uses the canonical managed fail-fast policy kind
`source_deep_reading` (manual only, **not** a standing credential authorization).
Extra adapter artifacts/files/proposals/activities are rejected by the existing
Run materializer before any such write; only the checked `source.material.submit`
result can produce this private report. A forbidden output becomes a terminal
failed operation, not a new approval hold or an unguarded copied Artifact.

Historical deep-reading access rechecks live permissions rather than requiring
Source configuration bytes to equal admission. The operation exposes only a
`source_configuration_changed` flag when still authorized. For example, granting
another reader access must not erase this requester's past report. Execution
still requires the frozen Source authority fingerprint in
`assertItemProcessingDispatch` before dispatch, submission and settlement; actual
Source/Project/original/history/egress withdrawal withholds every derived read.

R4 private operations are also owner-filtered in the generic Source jobs list
and run-job gate, without an oversight exception or count disclosure. All public
job projections remove internal material submissions and investigation drafts,
including legacy non-deep jobs; durable payloads stay intact for settlement.
Private `deep_project` operations do not occupy deterministic original extraction
slots or the shared theme original barrier. Ordinary jobs with null metadata
retain their existing deduplication and pending-coverage behavior.

The post-processing `queueFullTextExtractionForItems` existing-job merge also
excludes private `deep_project` rows: it must neither append shared follow-ups
to private metadata nor return a private job id as a shared run output. Ordinary
jobs, including null metadata, still deduplicate and merge follow-ups normally.

### R5 private Reading consumers

GET `.../projects/:projectId/reading/items/:itemId/favorite` returns only the
caller's favorite after the same Project-material/full-read gate as the write.
GET `.../items/:itemId/deep-reads/purposes` supplies at most100 current confirmed
material/Following/collecting-connection choices (200-character labels plus a
truncation flag), each revalidated by the canonical deep-reading context. It does
not start a Run, fetch an original or inspect private operation output.
Private operation projections include authorized material title, exact Following
reference and existing execution selection for explicit retries; these are null
when withheld. They never expose internal submission/check payloads.
Reader source-version GET supports authorized independent analysis summary
snapshots in addition to original extracted snapshots; it preserves exact snapshot
identity and the existing live derived-artifact dependency gate. No list/export
or generic Source jobs authority is widened.

R5 operation `purpose_label` is bounded to200 characters, resolved from the frozen
Goal version only after live private-read authorization; it is null on withholding.
Reader records can select one exact snapshot with `snapshot_id` and offset0 under
the same gates. Original availability remains page/filter-independent. This keeps
a report's supplied original reference distinct from an author's newer version.


## Acceptance evidence

[Project Reading acceptance](../../docs/PROJECT_READING_ACCEPTANCE.md) maps durable
private investigation recovery and deterministic original capture tests to A1–A12.
The private SIGKILL test uses the existing Job/Run terminal reconciler, not a GET
to finish work. Cancellation is stored as a failed extraction job with
`source_material_cancelled` and projected as cancelled only after canonical terminal
Run settlement. Synthetic Host evidence is not a live remote Host or semantic quality verdict.

### Following discovery submissions

The shared submit schema includes a bounded optional `coverage.discovery`.
Following collection admission requires it; saved-item preparation and manual
investigation do not acquire this requirement. This reports dynamic search
angles, actual queries/outcomes, remaining gaps and stop reason as unverified
Agent statements. The native collector uses existing canonical Run events as
separate execution evidence and the shared goal selector for filtering/deduplication
before caps. See [Source Goals](SOURCE_GOALS.md#broad-discovery-and-bounded-continuity)
for bounded cross-check context, authority revalidation and persistence.

### Reading tools in Project conversations

Project and Room conversations expose `project.reading.list` (bounded title search
and cursor pagination), `project.reading.records` (original/analysis snapshot IDs
and offset pagination), and `project.reading.read` (an exact snapshot, at most
12,000 characters per page). These read existing retained documents, independently
of Research Operations; no new research, proposal or manual permission grant is
needed. IDs are copied from the preceding list/records result. The tools reuse
Reading membership, Reader resolution and Project reading-record classification;
reads never mark an item opened or update personal progress.

`source.material.investigate` remains restricted to its admitted investigation.
Conversation reads instead recheck current Project membership, the full Run/Room
human audience without oversight, item/snapshot/artifact access, and Source
outbound policy for the Run destination, including original and historical
Artifact dependencies. Private analyses are readable in a private conversation
only when its audience can read them, never widened into a shared conversation.
Unauthorized records are omitted; page continuation does not claim whole-library
coverage. Implementation: `sources/projectReadingTools.ts`.
