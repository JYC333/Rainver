# Module: Sources

## Status

Implemented for built-in RSS, Atom, watched web page, arXiv, OpenAlex,
Semantic Scholar, and credentialed Brave Web Search providers
with HTML-first extraction), manual URL, candidate evidence,
reader, structured reader document extraction, project_folder/project routing flows,
Level 2 Source Recipe creation through Phase 8, and the Custom Source backend
create flow through Phase 8.
Source Recipe plan/create/dry-run/activate routes, proposal activation,
scan-worker materialization, the `/sources` Create Source card, Source Detail
normal/Advanced split, `source_runs` read model, and declarative-pipeline
bridge into `source_recipe_versions` are wired. Custom Source proposal
payloads/appliers, Sources frontend create/detail surfaces, and Space/Instance
Settings surfaces are wired. Custom Source repair/rollback (Phase 9) and
credentialed source support (Phase 10) are implemented backend-only (no
frontend surface yet). Phase 12 hardening (rate limiting, artifact retention,
an observability read model) is implemented; Phase 11 (browser/Python
evaluation) was deliberately skipped.

## Purpose

Sources is the canonical boundary for raw source material before it becomes
durable product knowledge, memory, tasks, or project state. It captures,
normalizes, extracts, snapshots, and links candidate material while preserving
proposal gates for durable writes.

Direct Source, Source Recipe, Custom Source, manual URL, and standalone
Evidence creation use the shared creation-context resolver. The source chain
stores `project_id`: Connections created inside a Project are shared and
Project-scoped; context-free Sources are private in Personal Space. Items,
Snapshots, Evidence, Reader annotations, and their grants inherit the parent
Source/Document context rather than choosing a new default.

The frontend module id is `sources`, the route is `/sources`, and API paths use
`/api/v1/sources/*`. Sources owns the user-facing Source configuration
(external origins) and their Monitors (provider searches, feed subscriptions,
and page rules), backed internally by Connections and Source Channels. It owns scan schedules, screening rules,
recommendation/subscription state, and delivery permissions; it does not own
the reading experience. Reading
Sources-derived content (item streams, item full-text plus annotations, digests,
screened items) lives in the separate Library module (`/library`):
`apps/web/src/modules/library/LibraryItemReaderPage.tsx` is the single-item
reader, gaining prev/next across a day's briefing items when reached from
`/library/digests/:connectionId/:date`, and falling back to a standalone
`/library/items/:itemId` route with no day context. The shared
annotation/inspector/selection-toolbar capability components live under
`apps/web/src/components/reader/` so Library does not import UI from
`modules/sources`. Sources supplies a permission- and consent-aware document
resolver to the independent Reader backend; it does not own Reader routes or
annotation persistence.

Project Sources is likewise an acquisition/control-plane surface: it binds
Sources, displays health, runs scans/backfills, and synchronizes the Project
Corpus. Article-level triage/read review and WHY/HOW/WHAT cards live in the
Project Research Area Reading List, not on the Project Sources page.

The normal Sources frontend should not render source item feeds, extracted
evidence feeds, or run-history tables. It may show scan/configuration status
needed to manage subscriptions; detailed run rows remain backend audit/state
for jobs, rules, and troubleshooting.

## Owns

- Source Provider, Connector, and Provider–Connector catalog mapping. Connector
  implementations are system-published; Instance Admin only controls status
  and priority.
- Space-scoped `SourceConnection` configuration, consent, policy, trust, and
  transport/handler provenance. Connection does not own query or scheduling.
- User-facing Sources and their Monitors. A Monitor is backed by a
  `SourceChannel` query, endpoint, fingerprint, schedule, and subscription.
  Channel is an internal execution boundary, not a required user-facing term.
  Scheduler cursor/watermark/
  conditional-fetch state is stored in the Channel's `scheduler_tasks.metadata_json`.
- `SourceChannelItemLink`, which preserves every channel hit for a globally
  deduplicated `SourceItem`.
- `SourceItem` candidate records.
- Space-shared objective item annotations: domain, depth, genre, topic
  candidates, summary, plus annotation-v2 normalized stance target/polarity.
  Stance describes the item's conclusion, never a reader's view or relevance.
- `ExtractionJob` scan, extraction, snapshot, manual URL, and normalization
  jobs.
- `SourceSnapshot` records backed by artifacts.
- `ExtractedEvidence` candidate citable evidence.
- `EvidenceLink` relevance and context-selection links.
- The producer side of the Projects routing hook. Project-owned
  `ProjectSourceBinding` and `ProjectSourceItemLink` rows are managed by the
  Projects module; Sources only hands newly materialized items/evidence to the
  hook.
- Sources reader annotations and comments.
- The source recommendation/subscription state machine. Serendipity discovery
  creates only `pending` recommendations for active space-shared channels;
  `GET /api/v1/sources/recommendations` and the Sources page let the reader
  explicitly Follow, Dismiss, or Mute them. Pending is never treated as a
  subscription. An explicit Information Digest "Never this direction again"
  block may dismiss only still-pending system recommendations linked to that
  blocked domain; it never changes an accepted subscription.
- Materialization of bounded external-discovery samples as owner-private,
  metadata-only `SourceItem` rows, followed by the ordinary annotation job.
  Information Digest owns the probe budget and standby pool, not this Sources
  normalization boundary.
- Per-user source item read state (`source_item_user_states`), used by Library
  and the reader.
- Custom Source handler versions, handler runs, backend create/test/activate
  flow, and first scan-job integration.
- Source Recipe versions, deterministic planning, dry-run preview,
  activation/proposal flow, and recipe scan-job integration.

## Does Not Own

- Knowledge `Source` as curated wiki evidence.
- Memory writes.
- Wiki writes.
- Task writes.
- A second Project-specific source model; Project-scoped Sources use the same
  canonical Source tables and `project_id`.
- Runtime adapter marketplace.
- Capability marketplace.
- General plugin marketplace.
- Credential storage.
- Project Research notebooks, paper cards, checklist items, or their proposal
  appliers. Sources only invokes the Research Area card materializer after a
  successful project-bound deep-analysis run.

## Current Implementation

### History import / backfill

Sources owns durable `source_backfill_plans`, ordered segments, and quota
buckets. Preview is deterministic and non-durable; creating a plan is
idempotent per space. Starting a plan is proposal-gated, and segment execution
reuses ordinary `extraction_jobs`, so existing item/evidence dedupe and the
Projects routing hook remain the only materialization path. Quota exhaustion
pauses a plan until `next_eligible_at`; the Sources scheduler reconciles
completed extraction jobs and resumes eligible plans. Project-initiated plans
may link to a ProjectOperation for product-level progress.

History-import fetches retry a transient network failure or upstream 5xx once
inside the same extraction job, with the connector's normal request preparation
and arXiv politeness interval applied to each attempt. Permanent 4xx responses
are not retried. If both attempts fail, the job and segment retain safe
structured diagnostics (provider, upstream status, failure kind, transport
error name/code, elapsed and deadline milliseconds, attempt count, page sizes
attempted, and retryability; never query text, endpoint URLs, response bodies,
or credentials) for the owning operation.

Failures are classified as `upstream_http`, `timeout`, or `network`, and those
are three different operator actions — ask for less, wait longer, or check
connectivity. Collapsing timeouts into `network` (with a null status) once cost
a real investigation: a provider that answered 5xx after ~30s was recorded as
unreachable.

The per-request deadline scales with the page requested
(`backfillFetchTimeoutMs`): a flat budget is simultaneously generous for a
10-row page and too tight for a 100-row page of a broad boolean query, where a
provider legitimately needs tens of seconds.

**Page-size narrowing.** When a provider times out or returns 5xx, the page is
re-requested down a quartering ladder (100 -> 25 -> 10, floor 10) before the
segment is failed. A provider that cannot assemble 100 rows of a broad query
often serves 25 without complaint, and failing outright discards one source's
entire contribution — after which Research reports a confident "no relevant
material" over a corpus missing half its inputs. Narrowing applies only to
connectors declaring `supports_page_size_narrowing` (offset is counted in
items: arXiv, Semantic Scholar); a page-numbered API such as OpenAlex cannot
express "same position, fewer rows", so narrowing it would skip results. A
width that succeeds is carried into subsequent pages rather than re-testing the
full width each time.

Backfill offsets are **item-based**, taken from `window.offset` /
`consumed_items`. Deriving the offset as page index times a fixed width skipped
results on any page narrower than that width — the normal case on a budget's
last page, and the permanent case after narrowing.

A retryable failure that survives the ladder moves the segment back to
`pending`, pauses the plan until `next_eligible_at`, and retries after
1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, then at most once per day.
This provider-friendly repair cadence is not a failed Research operation.
Permanent failures remain terminal and use the separate operation Retry action.

For the Academic Research initial literature intake, an arXiv date window is a logical segment,
not one API page. The extraction worker pages at up to 100 items (less after
narrowing, or when the remaining budget is smaller), persists the item offset
and cumulative segment count, and marks a segment exhausted only
after a short page. Reaching the operation's `max_items` budget is recorded as
`partial` and requires the user to explicitly raise the item limit in Project
Settings before resuming; recovery actions never allocate a default budget. It
is never reported as an exhausted historical range. Each request records the selected
`submittedDate` or `lastUpdatedDate` field, while arXiv id/DOI dedupe remains
in the normal item materialization path. For Project Research, the item cap is
owned by `project_operations.progress_json.history.max_items`; linked Source
plans do not mirror it in `strategy_json`. Standalone Source plans retain their
plan-level budget, and the execution cursor applies the remaining budget as
each segment starts.

Backfill strategy JSON explicitly carries `history_mode`: `bounded_range` keeps
the generic source default (including its bounded fallback when callers omit
dates), while `all_available` is supported only by arXiv and is resolved to the
connector safety floor `1991-01-01T00:00:00Z` through a frozen `to` timestamp.
The mode is part of the query fingerprint and is never inferred from missing
dates, so an ordinary source backfill cannot accidentally become a full-history
import. Historical research operations use the same bounded plan shape for
earlier ranges and store coverage on the workflow for overlap checks.

For generic Source history imports, starting a plan is proposal-gated:
`source_backfill_start` -> `ProposalApplyService` -> internal
`source.backfill.start`. Project Research is an explicit user action: the
initial-intake or historical-extension request records the user's scope and
starts its linked plans directly through the Project Research orchestrator.
Agents and generic Source routes cannot use that path.

The Source Detail `History import` tab consumes these read models: it previews
date windows and quota without writing, creates an idempotent draft, shows
segment/item rollups and `next_eligible_at`, and offers propose-start and
owner/admin pause/resume controls. Raw extraction-job and segment diagnostics
remain an Advanced concern. The generic Source Detail start action remains
proposal-gated; Project Research uses the explicit intake action described
above and does not expose that path to agents.

Built-in source connections are seeded for RSS, Atom, web page, and arXiv
connectors. The extraction worker scans feeds and pages, creates candidate
items, queues follow-up extraction or snapshot jobs, writes artifacts for
captured content, and creates candidate evidence where appropriate.

### Research providers and monitors

Academic Sources is a UX grouping over normal `source_channels`, not a
database boundary. The global Sources page presents each provider origin as a
Source and each independent query/category rule as a Monitor; the Channel term
remains an implementation detail.
The provider catalog is exposed through `GET /api/v1/sources/providers`.
Academic search providers are `arxiv`, `openalex`, and `semantic_scholar`;
`web_search` is a credentialed, untrusted web tier. The arXiv entry includes
the provider-owned setup schema and category taxonomy used
by the shared Add Source dialog. Users can create a manual monitor through
`/api/v1/sources/channels`; the server resolves the active provider mapping,
compiles the request through the research provider compiler, and creates a
one-to-one `source_search_specs` snapshot. Adaptive Project Research creates
monitors only by materializing a selected query attempt. Credentials and policy
remain on the Connection; immutable executable query state belongs to the
Search Spec, while schedule, watermark, and project bindings remain
Channel-owned.

OpenAlex and Semantic Scholar use JSON connector handlers with provider-native
cursor/offset state and normalize DOI, arXiv id, native id, authors, venue,
publication date, citation/reference counts, and abstract into the same source
item metadata contract. `paperMaterializer` recognizes that provider-neutral
contract and deduplicates `academic_papers` by DOI, arXiv id, OpenAlex id, or
Semantic Scholar id. Academic provider identifiers are persisted in trimmed
lowercase canonical form, with schema enforcement so case variants share one
paper identity and empty/whitespace variants are rejected. Project routing
contains best-effort academic materialization in a transaction savepoint before
continuing link and Corpus reconciliation. Brave results remain external URL items and their
Connection is created with `trust_level=untrusted`; screening instructions
require independent or scholarly corroboration before high confidence.

`POST /api/v1/research/query-strategies/evaluate` evaluates each selected
provider independently for at most three attempts and persists the semantic
intent, exact compiled query, preview observation, decision, and selected
attempt in the normalized research-query tables. Web search additionally
requires the Space external-egress switch and a managed Source credential.
Confirming a strategy through
`POST /api/v1/research/query-strategies/{id}/materialize` atomically creates Search
Specs, ordinary Channels, and Project bindings; only subsequent Sources scans
and materialization may populate corpus. Preview, initial backfill, and
recurring scans execute the same selected compiled query snapshot.
The arXiv setup schema supports topic search, category streams, and all-paper
streams. Category streams compile to `cat:<category>` or an OR expression and
use `submittedDate` descending by default, so daily scans behave like a new-
papers monitor with normal Source dedupe. Use one Source with multiple Monitors
when they share the same origin; create separate Sources only when the
external origin or governance boundary differs. No source-preset create or
preview API remains.

For an automatic research monitor, a successful scan stores the selected
monitoring timestamp together with ETag/Last-Modified values. The next daily
scan asks for a 48-hour overlap through now, starts at page zero, and relies on
the same source-item/arXiv-id/DOI dedupe. Historical backfill jobs do not
advance the live monitoring cursor.
`scheduler_tasks.next_run_at` is only execution timing.
`metadata_json.cursor.last_published_at` is the publication watermark, and
`cursor.overlap_hours` defines the connector overlap. Activating a monitor
schedules the next configured cadence boundary rather than scanning
immediately. arXiv, OpenAlex, and Semantic Scholar push the derived lower bound
into their provider request where supported, while Project Research applies the
same publication-window boundary after materialization so provider ordering or
page-size differences cannot create false incremental runs.

arXiv-specific parsing lives in `connectors/arxiv.ts` (query URL building, Atom
response parsing, and id/URL normalization for abs/pdf/html URLs, `arXiv:`
prefixes, versioned ids, and legacy slash ids), deliberately outside the generic
feed parser. `connectors/arxivThrottle.ts` is a best-effort process-local polite throttle
(default 3s minimum interval, injectable clock/sleep for tests) that wraps
only arXiv network calls.

The Channel scan handler for the `arxiv`–`arxiv_api` mapping parses the Atom response into
paper records and upserts `feed_entry` items with the base arXiv id (no
version) as `source_external_id`, the canonical abs URL as
`canonical_uri`/`source_uri`, comma-joined authors, the abstract as excerpt,
and arXiv metadata (id/version/authors/categories/primary category/doi/
journal ref/comment/abs/html/pdf URLs) in `metadata_json`. Each scan fetches
the configured `max_results` and relies on item dedupe; incremental query
rewriting is not implemented.

Text extraction and snapshot jobs detect arXiv abs/pdf/html source URLs and
resolve content HTML-first: try `arxiv.org/html/<baseId>` (succeeds only when
structured reader extraction yields non-empty plain text), fall back to
`arxiv.org/pdf/<baseId>` (raw PDF artifact plus `pdf_text_v1` reader
document), then the original URL if distinct. Snapshots store the raw content
actually used. Created snapshots/reader artifacts record
`content_source_format`, `content_source_url`, `arxiv_id`, and
`fallback_from`/`fallback_reason` when PDF fallback occurred. Non-arXiv URLs
keep the existing single-fetch behavior.

The main `/sources` Create Source dialog is provider-neutral. It loads the
provider catalog, renders provider-owned setup fields (including the arXiv
category picker), and creates a reusable Source with one or more independent
Monitors. Project binding happens through the Project Sources surface and
`project_source_bindings`; creating a monitor outside a project does not bind it
implicitly. Templates reuse the same provider and monitor models. Graph
presentation is derived from active binding profile descriptors: for example,
the academic profile advertises the core `academic_citation_v1` lens, while the
generic-document profile does not advertise a specialized lens. A Project's
stored Template key is provenance and is never consulted for this decision.
Source health is exposed as read models instead of raw run tables:
`/sources/source-health` reports source-level health for visible connections.
Project binding health is Project-owned at
`/projects/{projectId}/sources/health`.

Project Research screening readiness is coordinated through the Sources-owned
`SourcePostProcessingRecoveryService`. It checks classification coverage,
replays only the scoped source items when ingestion advanced without a
processing run, and returns a typed ready/waiting/failed result to the Project
Research orchestrator. The orchestrator owns only operation/workflow state;
it does not issue Source recovery SQL or enqueue Source processing jobs.
Server-managed Source post-processing runs carry the typed managed-execution
policy in their immutable run contract and use fail-fast handling. A CLI or
provider failure therefore remains a Source/Research operation failure that
can be retried, rather than becoming a generic runtime supervisor review.

Scheduled source connections use frequency-specific rules rather than a raw
"next run" picker. Hourly schedules choose a minute, daily schedules choose
hour/minute, and weekly schedules choose weekday/hour/minute. The API stores
the normalized UTC rule in `source_channels.schedule_rule_json` and returns
it as `schedule_rule_json` alongside the computed `next_check_at`.
After each scheduled scan, the next run is recomputed from the rule so schedules
do not drift based on job completion time. The scheduler task owns only runtime
cursor/state (`next_run_at`, `last_run_at`, status, and operational metadata),
not the user-facing recurring rule. Source Detail can edit both
`fetch_frequency` and the schedule rule; manual sources have no recurring rule
and run only through explicit `Run now`/Scan actions.

Capture policy behavior:

- `reference_only`: save the item record, source metadata, scan timestamps, and
  any feed/API excerpt; do not fetch the original page/document.
- `extract_text`: queue `extract_text` follow-up jobs after scans and store a
  reader document/plain text when extraction succeeds.
- `archive_original`: queue `snapshot` follow-up jobs, persist the original
  HTML/PDF snapshot, and derive reader text from that archived copy.

Custom Source backend support is implemented for draft connection creation,
deterministic handler generation, fixture testing, inside-envelope activation,
manual and scheduled scan queueing, handler-run history, and trusted endpoint
fetching into the handler input. `typescript_node` remains the generated-code
Level 3 fallback. Existing `declarative_pipeline_v1` handler versions remain
readable and executable for compatibility; operators can explicitly bridge one
into a new paused Level 2 recipe source and draft `source_recipe_versions`
row. New normal source creation uses Source Recipes, not pipeline-as-handler
rows.

Level 2 Source Recipe support is implemented for recipe-first source creation.
`source_connections.handler_kind = 'recipe'` rows point at
`source_recipe_versions` through `active_recipe_version_id`. The deterministic
planner can classify RSS, Atom, web-list, and web-page inputs, produce a fixed
recipe shape plus sample preview, create a paused recipe connection with a
draft version, dry-run the recipe without writing Sources output, and activate
it directly when the policy envelope stays inside approved bounds. Permission
deltas create a `source_recipe_activation` proposal; accepting the proposal
activates the recipe version through the proposal applier, and rejecting it
releases the version back to draft. Manual and scheduled recipe scans enqueue
Sources extraction jobs and materialize validated recipe output through the
shared Sources materializer. Source Detail presents product tabs
(Overview, Plan, Preview, Post-processing, Advanced). It keeps handler
versions, raw JSON, and policy/sandbox details under Advanced; user-facing item
reading and brief review happen in Library.

Manual URL source capture is a separate item creation route. It can optionally attach
the saved URL to a `SourceConnection` and queue content extraction. A manually
saved URL may later change its attached source; source-scanned items keep their
original connection as provenance and are not source-reassignable.

### Reader and structured extraction

`extract_text` and the extracted side of `snapshot` jobs fetch source HTML and
materialize an `source_reader_document` artifact. This artifact is JSON
(`canonical_format="reader_document_json"`) containing:

- `plain_text` for content hashes, text-range anchors, search/excerpts, and
  annotation verification.
- `content_json` as read-only Tiptap JSON for the Reader UI.
- HTML reader documents use `image_policy="remote_reference"`; image nodes keep
  resolved remote `http`/`https` URLs and do not download image binaries.
- `extraction_method="structured_html_v1"` for HTML and `pdf_text_v1` for PDF.

Reader documents preserve common article structure such as headings,
paragraphs, lists, blockquotes, code blocks, horizontal rules, links, and
remote image references. PDF URLs store the raw PDF as an
`source_raw_snapshot` artifact (`mime_type="application/pdf"`, file-backed
`storage_path`) and derive a `pdf_text_v1` reader document from those bytes.

The Reader UI is a read-only surface. It supports block-level reading rhythm,
selection toolbar annotation creation, annotation notebook/inspector, comment
threads, and proposal-gated downstream actions from existing annotations. It is
not an editable document surface.

Already extracted items may be re-extracted from the Library item stream or
Reader header. Re-extraction uses the existing `queue_content` item action and
`extract_text` job path; it creates a new extracted source snapshot/artifact and
updates `source_items.extracted_artifact_id`.

Projects consume Sources through Project-owned `project_source_bindings`,
`project_source_item_links`, project filters, evidence links, and the
Project-owned `project_corpus_items` read model.
`ProjectSourceBinding.project_id` is required and does not depend on any
Project Folder association. Project writers directly bind existing active Sources;
agent-initiated bindings remain proposal-first. Project Sources pages can create
or save URLs into a project collection through an already-bound source, run scans,
backfill existing source items/evidence, and inspect source health. Projects do
not own raw source connections.

Each binding persists an extraction profile and a
`standing_comparison_enabled` switch. The profile registry has exactly one
default; ordinary writer-created bindings use `generic_document_v1` unless the
writer explicitly selects another registered profile, and unknown keys are
rejected. The Project Sources UI exposes the registry descriptors, active
profile, and Standing state. The direct-binding UI defaults Standing on. Template
recommendations persist their declared profile and also default Standing on;
both paths idempotently ensure the Project's four Research baseline Notes before
monitoring begins.

Removing a Project binding disconnects it from normal Project reads and UI. The
row is retained as an internal archive for operation/backfill/proposal history;
re-adding the same Source restores that archived binding.

An `SourceItem` keeps one primary `connection_id`, but deduped items may have
`SourceSnapshot` rows from multiple source connections. Project filters and
evidence auto-linking treat both the primary item connection and same-item
snapshot connections as source provenance, so one paper or URL captured by
multiple bound sources remains visible to each bound project without duplicating
the raw item.

### Project linking and source post-processing

When a source item matches an active `project_source_bindings` row for a
project, materialization writes an active `project_source_item_links` row. The
Projects-owned `ProjectSourceRoutingService` then creates active
`context_candidate` `evidence_links` targeting that project. Item links are idempotent
through `uq_project_source_item_links_binding_item`; evidence links remain
idempotent through `uq_evidence_links_active_dedupe` and are what run-context
evidence selection reads for project-bound agent runs.

The same materialization pass syncs Project corpus rows in
`project_corpus_items`: SourceItem rows, Reference-object rows when a
`source_item_references` bridge exists, Evidence rows, and Evidence
Reference-object rows. Corpus sync does not move source item decisions into a new
decision table. `source_post_processing_item_decisions` remains the
source-item-level post-processing record; Project corpus rows may point to the
latest decision and map its relevance into project `triage_status` while keeping
project `read_status` separate from the personal Library state.

Once a SourceItem corpus row reaches `relevant` or `included`, Projects
resolves the active binding's extraction profile and materializes the item
behind a savepoint. The generic document profile requires `canonical_uri` and
creates a project-scoped, graphable `source` object; the academic profile uses
the same post-triage trigger. Both profiles link the object through
`source_item_references`, after which the existing corpus promotion preserves
triage/read state and provenance while populating `object_id`.

For deduped items, auto-linking also considers `SourceSnapshot.connection_id`
rows for the same item, not only `SourceItem.connection_id`.

Binding a source to a project can also backfill historical extracted evidence.
`POST /api/v1/projects/{projectId}/sources/bindings` accepts
`backfill_history=true`, and
`POST /api/v1/projects/{projectId}/sources/bindings/{bindingId}/backfill` reruns the
same idempotent materialization later. Backfill does not duplicate source items,
evidence, or corpus entries; it inserts/reactivates missing active project item
links, creates missing project `context_candidate` evidence links, and refreshes
the Project corpus read model for existing `ExtractedEvidence` rows whose parent
item or same-item source snapshot belongs to the bound source.

Remote history import is distinct from this local rematerialization. The
Project binding `propose-backfill` route creates a `ProjectOperation`, a
Sources-owned history-import plan, and its start proposal in one transaction.
Project-scoped idempotency keys are locked before operation creation; safe
retries reuse the original operation/plan/proposal, while cross-Project or
different-parameter reuse fails closed.
After approval, quota-controlled segments reuse ordinary `extraction_jobs` and
the existing routing hook, so no Project-specific ingestion path or duplicate
raw source item is introduced.

After a scan materializes new items, the scan paths emit a best-effort
`source_post_processing_event` job (`postProcessing/eventEmitter.ts`). Sources
owns that job, the rule cursor, and the run audit rows:

- `source_post_processing_rules` bind one source connection to one reusable
  agent and define trigger, input window, and actions.
- `source_post_processing_runs` record each rule/manual execution, input item
  and evidence ids, associated agent run, output artifacts/proposals/jobs,
  cursor before/after, status, and errors.
  These rows are operational/audit state and are not shown as a normal Sources
  page run-history feed.
- When a run finishes with `status='succeeded'`, Sources upserts one Activity
  Inbox pointer row for the run's source connection and rule-local date:
  `activity_records.aggregate_key =
  source:briefing:<source_connection_id>:<local_date>`. The Activity row
  stores counts, run ids, artifact ids, and a short preview only; the full
  digest and per-item content remain in the Library read model. The
  `source_connections.config_json.daily_inbox_briefing` boolean disables or
  explicitly enables emission, otherwise it defaults on when the connection has
  an active post-processing rule. This is the sanctioned cross-domain
  notification write under BOUNDARIES B24A.
- Supported triggers are `items_materialized`, `schedule`, and `manual`.
- Supported actions are `batch_digest`, `per_item_summary`, `extract_evidence`,
  `create_proposals`, and `mark_items`; the default is artifact-only
  `batch_digest`. `mark_items` means the run must produce item relevance
  decisions; it does not mutate shared source items.
- `input_config_json.retrieval_context` can opt a rule into retrieval-backed
  relevance context across Project, Knowledge, Memory, and Sources domains.
  Project context and Knowledge base comparison are separate user-facing choices:
  project context is the targeted judging reference when a `project_id` is set,
  while Knowledge is an optional comparison source and is not enabled by default.
  With a `project_id`, the project public summary is pinned before search
  results. Backend validation rejects project-context search on rules that do
  not have a `project_id`.
- Before sending source item titles, excerpts, evidence, or extracted text to
  an agent run, source post-processing revalidates the selected agent/provider
  destination against the source connection's consent and egress policy. A
  denied source egress, including the space external-egress switch for external
  providers, fails the post-processing run before source content leaves Sources.
- Post-processing agent output is consumed as structured
  `source_post_processing.result.v1`; invalid structure fails the run and does
  not advance the rule cursor. `item_decisions_json` records
  `relevant`/`maybe`/`not_relevant` decisions. Relevance lives in
  `source_post_processing_item_decisions`; item reading state lives per user in
  `source_item_user_states`.
- Project Research screening sends at most 10 source items to one structured
  output run. Explicit recovery jobs are split into the same batches, so a
  large baseline never becomes one oversized model request; each batch remains
  independently auditable and retryable.
- A transient provider transport failure (for example
  `provider_network_error` or `provider_rate_limit`) leaves the recovery job
  pending for the queue's bounded retry attempts. Research is not failed while
  one of those retries is pending; a permanent failure, or an exhausted retry
  budget, is recorded on the failed screening stage and exposed through the
  operation retry action.
- The formal Research result contract is transport-specific at the provider
  boundary: OpenAI-compatible providers use JSON Schema response format,
  Anthropic-compatible providers use a forced structured tool, and Ollama uses
  its JSON format. A plain-text response is not accepted as a Research success;
  provider diagnostics record only safe response metadata such as finish reason,
  block types, and tool names.
- A project-bound rule may carry an explicit `runtime_profile_id`; the selected
  profile is captured on its Agent Run rather than silently falling back to the
  agent default.
- `input_config_json.relevance_profile` lets a rule define what "relevant"
  means independent of which actions are enabled: an `objective`,
  `include_criteria`/`exclude_criteria`/`must_have`/`nice_to_have` lists, and
  an optional `decision_policy` (default wording is used when absent). The
  profile is rule-level, so multiple sources can reuse the same agent with
  different screening criteria. Project-bound Auto Research rules additionally
  carry `relevance_profile.project_criteria`, sourced from the Project Research
  screening-criteria record. Criteria saves refresh existing non-archived rules,
  and rule creation/reuse loads the current record; instruction rendering makes
  the Project criteria part of every automated item decision.
  `isRelevanceScreeningEnabled(actions, inputConfig)` (`postProcessing/repository.ts`)
  is the single predicate — screening is active when `mark_items` is on
  **or** `relevance_profile.enabled` is true — and both the prompt
  (`postProcessing/instruction.ts`) and the structured-output validator
  (`postProcessing/resultParser.ts`) use it. When screening is active,
  `item_decisions` must cover every input item even if `mark_items` itself is
  off, so screening runs stay auditable. `matched_context_refs` are validated
  against the retrieval refs supplied to that run; hallucinated context refs
  fail the run instead of being persisted. Applying select/triage/ignore from
  a digest writes only the current user's `source_item_user_states` row.
- When `relevance_profile.enabled`, its `objective` and `include_criteria`
  are folded into the retrieval query ahead of the summary goal/connection
  name fallback, biasing whichever explicitly selected project, knowledge,
  memory, or source context gets pulled in before the agent judges the batch.
- Candidate prefiltering ranks only the current input batch before prompt
  assembly. Items filtered before the LLM are persisted as low-confidence
  `maybe` decisions with `stage="candidate_prefilter"` refs, so `mark_items`
  sends them to triage rather than silently ignoring them.
- Optional deep-analysis follow-up uses array-valued
  `source_post_processing_followups` in extraction job metadata. Multiple
  rules can wait on the same pending extraction job without overwriting each
  other, and generated deep-analysis jobs are appended back to the source
  screening run's `output_job_ids_json` for traceability.
- Source setup may stamp `input_config_json.content_profile`, `summary_goal`,
  `output_instructions`, and `relevance_profile` so the reusable
  post-processing agent receives source-specific content guidance without
  cloning agents. These defaults are selected by the Source Channel setup
  service and provider-specific profiles, not by a frontend preset generator.
  The arXiv profile lives at
  `server/src/modules/sources/catalog/arxivPostProcessingProfile.ts`; generic
  source post-processing remains reusable and does not grow provider-specific
  branches. Public external providers such as arXiv, RSS, Atom, and watched
  public web pages default to allowing external model processing unless
  credentials or advanced source governance override that policy.

When a successful project-bound post-processing run belongs to an active
automatic research workflow, the completion signal is handed to
`ProjectResearchOrchestrator`. It syncs the latest decision into
`project_corpus_items` (preserving `triage_confirmed_by_user`), merges source
item ids into one incremental operation, and creates a screening gate. This is
a narrow completion hook; it does not duplicate Source fetching,
post-processing, or Agent execution. A baseline operation waits for all
backfill extraction and post-processing jobs to drain before opening its gate.
For generic Sources, proposal approval remains the boundary for starting the
history plan. For Project Research, the user's Start action is the history
authorization; the only subsequent human quality gates are screening and idea
review.

Post-processing may reuse the same `agent_id` across many sources. It is not an
Automations `event` trigger and does not use Automations cursors. `DailyCaptureReport`
remains separate: it summarizes a user's daily captured activity, not one
source connection's post-source processing.

### Retrieval projection

Sources is a retrieval domain through `source_item` and `extracted_evidence`
object types. The adapter indexes active candidate material only:

- `source_item`: `new`, `triaged`, and `selected` items; `ignored`,
  `archived`, and deleted items remove their projection.
- `extracted_evidence`: `candidate` and `active` evidence linked to a valid,
  readable parent source item.
- Edges are projected both ways as `has_evidence` and `evidence_for`.

The indexed text is intentionally bounded: item title, author/source URI/domain,
excerpt, and selected preset metadata; evidence title/type/excerpt plus source
title/author/URI. Full raw snapshots and extracted reader documents are not
indexed by default. Materialization, manual URL create/update, extraction,
custom/recipe materialization, and post-processing evidence writes best-effort
refresh the corresponding retrieval projection and enqueue embedding backfill.

Sources retrieval is opt-in in user-facing context surfaces: Ask Space defaults
to Knowledge only, managed agent tools expose `source.retrieval.search` and
`source.retrieval.brief` only when a run/profile enables the Sources domain, and
owner/admin maintenance uses the Sources-owned
`POST /api/v1/sources/retrieval/search|brief|reindex` endpoints.

## Custom Source Boundary

Custom Source extends `SourceConnection` with generated, source-specific
handler versions. A handler run is a controlled way to produce candidate Sources
output, not a way to mutate core product state.

Generated/template handler expansion (`typescript_node`) is frozen as the
Level 3 advanced fallback — no new handler languages or arbitrary code
execution features; bug/safety fixes only. See
[Sources Custom Source Handlers](../architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md#level-3-freeze-2026-07-01)
for the Level 1/2/3 split.

Handler code may only read `input.json`, write `output.json`, write files under
sandbox `files/`, and emit captured logs. It must not write
database rows, Memory, Knowledge, Wiki, Tasks, Project state, policy,
credentials, source repository files, or files outside `output.json` and
sandbox `files/`.

The server validates handler output and materializes only accepted data into
Sources-owned tables and artifacts.

## Policy

Source consent and source policy govern readers, subjects, agents, model
egress, retention, derived writes, trust, and allowed import targets.

Custom Source policy adds a handler policy envelope for network origins,
credentials, runtime language, browser automation, shell, dependency
installation, resource limits, output limits, and log retention.

Space Settings owns product policy such as who can create custom sources,
default source policy, allowed domains, per-space download cap, credentialed
source policy, and whether same-envelope repair may auto-apply.

Instance Settings owns runner and sandbox safety such as whether the runner is
enabled, allowed languages, hard network denies, time/output/log/file limits,
browser automation availability, shell availability, and dependency
installation availability. The download cap is intentionally space policy, not
environment or instance config.

`GET/PUT /api/v1/sources/custom-source-settings/space` reads and updates only
the Space product policy, including `download_bytes_max`.
`GET/PUT /api/v1/sources/custom-source-settings/instance`
requires instance-admin authority; it stores the runner availability toggle in
Instance Settings with default `runner_enabled=true`, while hard sandbox limits
remain instance-level server safety config.

Policy envelope behavior:

- Inside approved envelope: activation can be automatic when Space policy allows.
- Policy delta: activation creates a `custom_source_*` proposal, marks the
  tested handler version `pending_approval`, and binds the version to the
  proposal. Accepting the proposal activates the version through the Sources
  Custom Source applier; rejecting the proposal releases the version back to
  `draft`.
- Credentialed source: a draft references a pre-created Custom Source
  credential by `credential_id`, never a raw secret. First activation
  auto-activates only when Space policy allows credentialed sources,
  otherwise a `custom_source_credentialed_source` proposal is required.
- Repair: regenerates a handler version (never mutates the active one in
  place) from the active version's manifest plus overrides; auto-activates
  only when the envelope is unchanged and Space policy allows same-envelope
  repair auto-apply, otherwise creates a proposal. Rollback activates a
  previously-active version directly, no proposal.
- Source Recipe: dry-run-tested recipe versions activate directly when the
  policy envelope is within bounds; envelope broadening creates a
  `source_recipe_activation` proposal and binds the recipe version to it until
  accepted or rejected.

## Invariants

- Raw external source material enters through Sources before becoming durable
  Knowledge or Memory.
- Sources `SourceConnection` is not Knowledge `Source`.
- Sources `ProjectSourceBinding` is project-scoped: `project_id` is required,
  creation requires project writer authority, and project collection visibility
  is controlled by `delivery_scope` (`project_members` or
  `source_subscribers`).
- Custom Source handlers never directly write durable product objects.
- Projects do not create a second source model.
- Source-derived Memory and Knowledge writes remain proposal-gated.
- Evidence selected for run context goes through `EvidenceLink`; Knowledge
  `Source` is not selected directly into run context.
- Generated handler execution fails closed when runner support is unavailable or
  disabled.
- Source Recipe execution uses server-owned primitives, not untrusted code, and
  still fails closed through the same policy/output validation boundary.

## Related Files

- `server/src/modules/sources/`
- `server/src/modules/jobs/`
- `server/src/modules/scheduler/`
- `server/src/modules/policy/`
- `server/src/modules/proposals/`
- `server/src/modules/artifacts/`
- `apps/web/src/modules/sources/`
- `apps/web/src/modules/projects/ProjectDetailPage.tsx`
- `packages/protocol/src/`
- `server/migrations/`

## Related Architecture

- [Sources And Evidence Foundation](../architecture/SOURCE_EVIDENCE_FOUNDATION.md)
- [Source Connector Consent](../architecture/SOURCE_CONNECTOR_CONSENT.md)
- [Source Provenance Matrix](../architecture/SOURCE_PROVENANCE_MATRIX.md)
- [Sources Custom Source Handlers](../architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md)
