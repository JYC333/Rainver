# Module: Sources

## Status

Implemented for built-in RSS, Atom, watched web page, arXiv, OpenAlex,
Semantic Scholar, and credentialed Brave Web Search providers
(with HTML-first extraction), manual URL, candidate evidence,
reader, structured reader document extraction, and project_folder/project
routing flows.
Source Recipe plan/create/dry-run/activate routes, proposal activation,
scan-worker materialization, the `/sources` Create Source card, Source Detail
normal/Advanced split, `source_runs` read model, and declarative-pipeline
bridge into `source_recipe_versions` are wired. Custom Source proposal
payloads/appliers, Sources frontend create/detail surfaces, and Space/Instance
Settings surfaces are wired. Custom Source repair/rollback and credentialed
source support are backend-only (no dedicated frontend). Rate limiting,
artifact retention, and an observability read model exist. There is no
browser or Python handler evaluation.


Goal orchestration is implemented in `sources/goals/`, with conversational setup
in `SourceGoalPage.tsx`, goal management and explicit legacy-source compatibility
mapping. See [Source Goals](../architecture/SOURCE_GOALS.md) for authority,
API, runtime, repair, coverage and remaining deployment acceptance boundaries.

See [Source material processing](../architecture/SOURCE_MATERIAL_PROCESSING.md) for
the unified query/saved-link submission, content writer, recovery and Source-owner
text-storage decision.

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
When a Source management action receives 403/404, the UI drops the previous
Source state and rereads the currently authorized list. A successful read can
restore a Source whose management permission alone was denied. A read denied
with 401/403/404 also clears prior state; an ordinary refresh network failure
keeps the last readable snapshot for retry.
Source management pages reset for the current user and Space, and the detail
page also resets for its Source, so earlier reads cannot repopulate a different
scope.

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
  subscription. `GET /api/v1/sources/followed` lists other members' channels
  the person follows or has left, and
  `POST /api/v1/sources/channels/:channelId/subscription` leaves (`muted`) or
  follows again (`subscribed`); every transition opens or closes a
  `source_channel_subscription_windows` period, which historical reading
  eligibility reads (`modules/library.md`). A personal item is unique per
  owner: extraction, custom-source and external-discovery materialization
  reuse only the writer's own personal copy of a URL (or the Project's copy),
  never another member's. An explicit Information Digest "Never this direction again"
  block may dismiss only still-pending system recommendations linked to that
  blocked domain; it never changes an accepted subscription.
- Materialization of bounded external-discovery samples as owner-private,
  metadata-only `SourceItem` rows, followed by the ordinary annotation job.
  Information Digest owns the probe budget and standby pool, not this Sources
  normalization boundary.
- Per-user source item read state (`source_item_user_states`), used by Library
  and the reader.
- Custom Source handler versions, handler runs, backend create/test/activate
  flow, and scan-job scheduling.
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
completed extraction jobs and resumes eligible plans, one plan at a time: a
plan whose reconcile fails is moved to the back of the `updated_at` order and
the rest of the pass continues, then the pass reports the failure.
Project-initiated plans
may link to a ProjectOperation for product-level progress.

The item budget is reserved page by page. A Project Research operation owns one
total shared by its sibling monitor plans; a standalone plan owns its own.
Every plan mutation (dispatch, reconcile, start, retry, continuation) takes the
operation row first, then segment rows, then the plan row, so a reconcile and
a page continuation finishing together never deadlock.
Under the operation (or plan) lock, used budget is every segment's imported
items, including the pages a still-running segment has read
(`window.consumed_items`), and each other running segment reserves its current
page. Dispatch sizes a segment from what is left, and the extraction worker
reserves each continuation page the same way, inside one transaction, before
queuing it. A page the shared budget no longer covers is not fetched: the
segment stops partial at that page, and a continuation resumes from it.
Concurrent segments therefore never import more than the operation's
`max_items`.

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
full width each time. For the same reason, the last page of a budget is
shrunk to the remaining items only for item-offset connectors; a page-numbered
API keeps its width and only the first remaining items of that page are kept.

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
prefixes, versioned ids, and slash ids), deliberately outside the generic
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
fetch once.

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
hour/minute, and weekly schedules choose weekday/hour/minute. The web form
takes local times and converts every frequency, the hourly minute included,
into the UTC rule it submits, and reads a rule back as local time. The API
stores the normalized UTC rule in `source_channels.schedule_rule_json` and
returns it as `schedule_rule_json` alongside the computed `next_check_at`.
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
explicit declarative pipeline creation, fixture testing, inside-envelope activation,
manual and scheduled scan queueing, handler-run history, and trusted endpoint
fetching into the handler input. Retained `typescript_node` Level 3 versions
are readable but execution is permanently blocked (`handler_language_removed`);
the old generator, code-artifact writer and runner have been removed. Handler
creation requires explicit `generation_mode: "pipeline"`; old-code repair returns
409 before generating or mutating anything. No setting, historical approval or
rollback restores code execution. `declarative_pipeline_v1` handler versions stay
readable and executable. An operator can explicitly bridge one
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
shared Sources materializer. Source Detail manages origin and monitor settings;
handler/recipe authoring APIs remain backend-only. User-facing item reading and
brief review happen in Library.

Manual URL source capture is a separate item creation route. It can optionally attach
the saved URL to a `SourceConnection` and queue content extraction. A manually
saved URL may later change its attached source; source-scanned items keep their
original connection as provenance and are not source-reassignable.

### Outbound fetch boundary

Every live fetch this module makes — connection scan, backfill page, manual URL,
`extract_text`/`snapshot`, the Custom Source pre-fetch, and the declarative
pipeline and Recipe interpreters' `fetch_page` / `follow_link` /
`download_asset` / `paginate` steps — goes through `fetchGuarded`
(`outboundUrlSafety.ts`), the server's entry into `@rainver/outbound-guard`.
The guard refuses an address inside this instance's own network, connects to
the address it checked rather than resolving the name a second time, re-checks
every redirect hop, drops a connection credential the moment the chain leaves
the first origin, and reads the body under a byte ceiling and a deadline. Do not
add another HTTP client here, and do not put a credential in `headers`: the
fetch options keep `credentialHeaders` separate so it cannot be replayed to a
redirect target.

A Custom Source or Recipe fetch composes its policy envelope's
`allowed_network_origins` into that same guard, so the origin allowlist and the
address check are consulted together on every hop rather than as two steps a
caller could get half right.

Every entry point that fetches takes an optional guard
(`SourceExtractionWorker`, `PgSourcesRepository`, the scan workers, the Recipe
create/dry-run services). Production passes nothing and gets the instance's
strict guard; tests pass one pinned at their own fixture server, because the
production guard has no way to switch itself off.

### Reading a decision item, a briefing and a screening list

A review action that republishes a Source item's content — `extract_evidence`
writes it into Evidence, `create_proposal` writes it into a Proposal body —
reads the item as the reviewer and demands full access
(`sourceItemFullContentReadClause`): the ordinary item gate, connection consent
included, plus the level, and without oversight, because supervising a member's
item is not permission to publish it. A Proposal built from Source material
takes the narrowest visibility of what it quotes rather than a hard-coded
`space_shared`, and an item served at `summary` narrows it to `private`.

A briefing's run list is reached through the reader's own subscription, but its
output artifacts are ordinary content and go through the Artifact predicate. The
Project Research screening review reads its items as the reviewer, so a
reviewer's own subscription is what makes a connected item readable there.

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
profile, and Standing state. The direct-binding UI defaults Standing off
(explicit opt-in), so adding a source alone does not initialize deep research.
Template recommendations retain their declared profile and Standing-on contract.
When Standing comparison is explicitly enabled, the binding service idempotently
ensures the Project's four Research baseline Notes. Lightweight information
monitoring keeps comparison disabled and has no Research-baseline prerequisite.

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
evidence selection reads for project-bound agent runs. When a binding is paused
or removed, or its filters come to exclude an item, its item links are archived
together with the evidence links it created for those items.

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
  agent and define trigger, input window, and actions. Listing a channel's
  rules, runs, backlog, briefings or source runs takes the connection's read
  decision; creating, updating or running a rule takes authority over the
  connection (`sourceConnectionAccess.ts`), an Agent the author can read, and
  Project writer authority for a bound `project_id`.
- `source_post_processing_runs` record each rule/manual execution, input item
  and evidence ids, associated agent run, output artifacts/proposals/jobs,
  cursor before/after, status, and errors.
  These rows are operational/audit state and are not shown as a normal Sources
  page run-history feed.
- When a run finishes with `status='succeeded'`, Sources upserts one Activity
  Inbox pointer row for the run's source channel and rule-local date:
  `activity_records.aggregate_key =
  source:briefing:<source_channel_id>:<local_date>`. The Activity row
  stores counts, run ids, artifact ids, and a short preview only; the full
  digest and per-item content remain in the Library read model. The
  `source_connections.config_json.daily_inbox_briefing` boolean disables or
  explicitly enables emission, otherwise it defaults on when the connection has
  an active post-processing rule. This is the sanctioned cross-domain
  notification write under BOUNDARIES B24A.
- Supported triggers are `items_materialized`, `schedule`, and `manual`.
- A rule runs once at a time. A run holds the rule's claim, a PostgreSQL
  session advisory lock on its own connection, for its whole length, so a
  person's manual run, a scheduled fire, and a source-event drain never read
  the same cursor window into two LLM passes. Each re-reads the rule under the
  claim. A manual run of a rule already running is refused with 409; a
  scheduled fire or an event drain skips it as `run_in_flight`. A crashed
  process releases its claim with its connection.
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
- Both window-selected and explicitly named post-processing inputs revalidate
  the viewer's current full-content access through the canonical Source item
  gate, including the live connection and current or historical reading
  eligibility. Withdrawal of the connection removes those inputs; a stored
  item id or copied visibility is not continuing permission to process it.
  Oversight is excluded from both visibility and effective-level checks:
  an administrator's audit access cannot upgrade a summary-only input for
  copying into derived content.
- Post-processing agent output is consumed as structured
  `source_post_processing.result.v1`; invalid structure fails the run and does
  not advance the rule cursor. A run's outputs (digest and summary artifacts,
  Evidence, follow-up jobs, proposals, item decisions) and its cursor advance
  commit in one transaction, so a run that fails part-way leaves none of them. `item_decisions_json` records
  `relevant`/`maybe`/`not_relevant` decisions. Relevance lives in
  `source_post_processing_item_decisions`; item reading state lives per user in
  `source_item_user_states`. List/get/action on those decisions reuses
  `sourceItemReadableClause`. `queue_content` and `extract_evidence` additionally
  require `full` item access.
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

### Annotation failure and recovery

`sourceAnnotation` annotates pending items in batches, one job per Space at a
time (a per-Space session advisory lock; a second job answers
`already_running`). A row that is not running says why in `wait_reason`:

| `wait_reason` | Status | Meaning | `next_retry_at` |
| --- | --- | --- | --- |
| `retry_scheduled` | pending | a temporary failure; the next automatic attempt is due | set |
| `provider_unavailable` | pending | the Space has no usable annotator Provider or runtime profile | none |
| `egress_denied` | pending | the Space turned external model egress off | none |
| `consent_missing` | pending | the item's Source has not consented to the destination | none |
| `budget_exhausted` | failed | the episode's attempts are spent; paused until a person retries | none |

The retry schedule lives in `sourceAnnotation/retryPolicy.ts`: three initial
attempts (the second one minute and the third five minutes after a failure),
then one automatic recovery round of three more at thirty minutes, two hours
and six hours, so at most six attempts per failure episode. Rows failing
together share an `episode_id`; `attempt_count` is cumulative within it. A
success or a skip ends the wait: the row leaves its retry schedule and episode
(`wait_reason`, `next_retry_at` and `episode_id` cleared), so a retry that
succeeds is saved once and never offered again. A condition wait spends no
attempt and has no countdown. The egress gate
(`assertSourcePromptEgressAllowed`) names its refusal with a stable `code`, so
a Space-wide egress refusal and a missing Source consent wait separately.

Consent and egress are rechecked on every execution. The annotation sweep calls
`recoverWaiting` for Spaces with condition waits, a bounded batch per sweep
taken in Space-id order after the previous batch (wrapping round), so every
waiting Space is visited in turn however many are stuck: it resolves the annotator and
re-runs the egress gate per waiting connection without a model call, and
`requeueParked` reopens only the rows whose condition now holds, filtered by
reason, item, connection, episode and responsible person, and bounded by a
count limit. A person's retry (`POST
/api/v1/spaces/:spaceId/source-annotation/retry`, optional `episode_id` and
`connection_id`) runs the same recheck for their own items, reopens their
scheduled and paused rows (a paused row starts a fresh episode, the only way
the count restarts), at most `ANNOTATION_MANUAL_RETRY_LIMIT` rows, and queues
one annotation job.

`SourceAnnotationRecoveryNotifier` keeps one updatable private operational
alert (`source_annotation_recovery`) per episode, wait reason and responsible
person, the connection owner or else the item owner. Every sweep re-syncs it,
but it returns to unread only when what it says changed (count, reason, next
retry); a notice the person read or dismissed stays so while the episode is
unchanged. It carries the reason, the count of
that person's affected items, the next absolute retry time only while one is
scheduled, and the manual retry pointer; it is archived once the episode has
no waiting rows. `GET /api/v1/spaces/:spaceId/source-annotation/episodes`
returns the caller's own episodes in the same shape. Neither ever counts or
names another person's items.

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

Custom Source extends `SourceConnection` with source-specific
handler versions. A handler run is a controlled way to produce candidate Sources
output, not a way to mutate core product state.

The old `typescript_node` handler generator and executor are removed; their
persisted language value and historical records remain readable. Fixture/live
tests and scheduled/manual scans refuse these versions before credential
resolution or endpoint fetch. Repair refuses them before generation or state
changes. New Goal-generated code uses only the isolated Host contract in ADR
0026; declarative pipelines remain executable. Shared execution settings, limits,
result types and temporary-file cleanup live in `sources/sourceExecutionPolicy.ts`.
See [Sources Custom Source Handlers](../architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md#level-3-generated-handlers).

The interpreter's output may include bounded snapshot files, never direct writes
to Memory, Knowledge, Wiki, Tasks, Project state, policy or credentials.

The server validates handler output and materializes only accepted data into
Sources-owned tables and artifacts.

## Policy

Source consent and source policy govern readers, subjects, agents, model
egress, retention, derived writes, trust, and allowed import targets.

Extraction Job metadata can contain source content. Its list and total use
the same current full-content gate on every named Item/Connection parent;
jobs with no authorizable parent are hidden. Manual execution checks that gate
without oversight before starting and again before returning the result, and
connection scans additionally require the existing connection-management
authority. Knowing a job id or belonging to its Space is not sufficient.

Custom Source policy adds a handler policy envelope for network origins,
credentials, runtime language, browser automation, shell, dependency
installation, resource limits, output limits, and log retention.

Authority over an existing connection (`sources/sourceConnectionAccess.ts`):
reading what hangs off it — Custom Source handler versions, runs and summary,
recipe versions, history imports — takes the connection's own
`source_connection` read decision; changing it — generating, testing,
activating, repairing or rolling back a handler, managing a history import —
takes its owner or a Space owner/admin who reads it without oversight.

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
  previously-active declarative version directly, no proposal; removed code
  versions are rejected before activation.
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
- Legacy generated handler execution is always blocked; new Goal-generated
  code fails closed when its isolated Host capability or policy is unavailable.
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

## Project manual monitoring integration (P1)

Projects' `monitoring/` orchestrator composes the existing Source owners through
`ProjectSourceProposalService`, backfill planning/execution, extraction,
sourceAnnotation and post-processing. Native manual arXiv Channels do not need
Research attempts/FINER. Setup explicitly disables daily inbox processing and
standing comparison, forces an independent paused draft on identity collision,
and preserves activation → binding → history owner approval dependencies.
A monitoring version only accepts an active, Project-bound, manual native arXiv
Source without active foreign processing rules or research workflow ownership.

Managed backfill plans retain the server-only monitoring-version marker. Accepting
the history proposal does not dispatch them: an explicit bounded operation is
required. Pages retain exact existing segment windows/cursors and pending
continuations on quota/total-cap exhaustion. Managed scans require a backfill
job and operation ID. Each physical source fetch attempt (including retries and
page narrowing) enters `projects/monitoringControl.ts`; no duplicate fetch or
materializer is introduced. Item identity advisory locks serialize managed
concurrent materialization before the canonical URI/arXiv/DOI lookup.

Managed capture suppresses automatic annotation/post-processing events; its
explicit bounded item list enters the existing objective annotation queue,
including old items newly associated with the Source. Ordinary background queue
selection excludes these items; post-processing requires the matching operation,
frozen Agent/rule/relevance profile and abstract-only contract. Source-specific
relevance remains in rule/item decisions, never in the global objective summary.
`monitoring/candidates.ts` owns the read/feedback seam over canonical Source rows:
current all-Project-reader full-content checks, snapshot/plan provenance, private
user-state merge and no shared triage or interest-profile learning. Reading
candidates remains in the Project all-candidates destination and canonical Library Reader;
the Sources management page does not become another Reader.

Monitoring quota refusals are a pause, not a permanent Source failure: the first
HTTP attempt and its page/candidate reservation share one Project transaction;
retries and redirect hops reserve only requests, immediately before each physical send through outbound-guard. Reconciliation retains the segment window/offset,
returns it to pending and does not count the quota refusal as a failed Source
attempt. A matching monitoring coordinator is required to claim its extraction
jobs; ordinary pollers cannot steal them. The Sources-owned
`monitoring/recovery.ts` seam restores interrupted pages only after Projects
proves the old coordinator Job stopped, holds its session lock and finds no live
child Run. Already charged work stays charged.

The monitoring Agent read tool is content-free; it does not forward Source text
under human read permission alone. Candidate relevance feedback and read_status
remain independent private fields. Ordinary connector scans and managed capture share the sorted identity locks described below. Other materialization entry points are outside this concurrency guarantee.

Monitoring pre-send refusals use the typed monitoring_admission_denied code and
bounded reason, not message text. Budget, pause, lost authority, confirmed Source
drift and inactive operations retain the same pending segment offset and do not
consume a Source failure attempt; the audit job retains the refusal. This does
not refund any earlier sent attempt. Actual HTTP/network/provider failures stay
on the existing Sources retry/permanent-failure paths, including their attempt
counts and diagnostics.

## Confirmed daily monitoring (P2)

`monitoring/schedule.ts` stores the accepted acquisition cadence in the existing
scheduler_tasks store (`project_information_monitoring`, key Project). The existing
Sources monitoring SchedulerRegistry task calls `monitoring/heartbeat.ts`; no additional timer,
queue, Channel frequency or foreign Automation is enabled. Without a confirmed
schedule there is no acquisition task with active due work. Pause updates both
Project admission and task eligibility in one transaction; resume retains its
original due slot. The heartbeat locks Project before task, rechecks confirmation
and the schedule owner, and calls the same bounded operation service as manual
work. A blocked due slot retains its identity and a content-free reason. Its separate retry_after eligibility backs off for one minute, including unexpected per-Project failures after rollback; eligibility compares timestamps and selection orders by the effective next attempt, so blocked tasks cannot monopolize the first 25 due rows even with a slow heartbeat. Explicit pause/resume clears that backoff. If blocking spans multiple daily slots, recovery attempts the oldest retained slot (partial if its dispatch window ended), then advances the schedule from the current time; it does not replay each missed day.

A daily operation is unique by Project/local date and also uses the existing
progress idempotency key. The coordinator session lock, JobDeferredError and
stopped-Job reconciliation remain authoritative. A stopped daily coordinator may
requeue its same operation only inside its original dispatch window, with no live
child/competitor and no reset of charged counters. If the window ended, later daily
work resumes the durable segments. Native/manual Channel scan and autonomous
annotation/post-processing remain excluded from this managed path.

`monitoring/recent.ts` creates finite recent windows for confirmed daily or explicit manual checks,
using ordinary plan/segment storage and deterministic native query windows. It is
not a public history direct-start or approval. Each day starts a new frozen window
from the last recorded cutoff; existing unresolved recent segments remain as
backlog, with newer windows first. A manual check resumes an unresolved window on the same local date; after
exhaustion it may open a new finite window. The daily slot always opens its newer
cutoff, even if an earlier manual check that day is unfinished. No incomplete page
advances a complete-coverage watermark. History can run only after all preceding
recent pages exhaust or reach terminal failure; pending/limited recent pages block
history. The explicit recent-window total cap is separate from the unchanged
approved history plan cap; neither is automatically increased.

Managed partial pages persist the exact next item offset (or the established
page-number cursor/width for non-narrowable providers), including when the physical
page exactly consumes its allowance. Day/budget/stop-time refusal preserves pending
segments via the P1 typed admission path. The acquisition stop time blocks new
physical requests/model work, while already admitted work may settle; late ready
material belongs to a later full-day Digest. The retained cutoff also exposes the
after-collection publication gap as partial coverage rather than a claim to have
searched the entire calendar day. Sources content stays in the fixed Project
preview/Reader, never in Agent monitoring status output.

Coverage examines every retained recent window: a newer exhausted empty window
cannot hide an older pending offset or failed range. `no_new` is only a statement
about an actually exhausted new window after unresolved recent backlog is accounted
for, never a substitute for not-run or quota-paused work.

Monitoring now registers its own `project_information_monitoring_scheduler` task
in SchedulerRegistry, separate from ordinary scan → extraction. Unexpected
per-Project dispatch or recovery failures are collected while the remaining
selected Projects are attempted, then thrown as an AggregateError through the
existing scheduler failure/liveness/alert path. Recovery failures do not skip the
due-dispatch pass. A broken monitor cannot abort ordinary Source scanning or
extraction; HTTP admission blocks keep their P1 typed state and original slot.

### Generic Project monitoring observations (P3)

`monitoring/pageChanges.ts` reuses structured Reader extraction and normalizes
body text (NFC/whitespace) for SHA-256 identity; `pageObservation.ts` composes
existing Source materialization/artifact/snapshot writers under the canonical
Project/page lock. No additional connector, HTTP client, model pipeline, timer
or queue is introduced. First capture is a baseline; unchanged/noise-only pages
retain the extracted version. A changed body creates a document SourceItem with
page_change provenance and immutable before/after Reader evidence. Page content
revision identity is scoped to Space/Project/page; repeated revisions do not
rewrite old change documents. Existing URL uniqueness remains intact: changes
reference the original URL via metadata and page/snapshot IDs, not fabricated
paper URLs. This is a captured-body comparison, not semantic importance scoring;
dynamic text inside the readable body can still trigger an update.

Sources plans additionally accept current_snapshot for rss/atom/web_page with
page_cursor. This is one bounded current observation, explicitly no historical
coverage. The ordinary start proposal still belongs to the Source owner; page
setup additionally proposes full_text retention, checked before each monitored
dispatch. Generic plans become completed when their saved segment is exhausted,
even if the last page used all of this operation's allowance.

Managed feeds freeze at most min(10,000, the confirmed plan total cap) normalized entries on their original extraction
Job (titles <=1,024, excerpts <=2,048 characters; no raw feed body), with the Job
pointer and consumed_items cursor on the existing segment. Continuation replays
that stored page and still consumes atomic page/candidate admission, but has no
HTTP request to charge. Reconciliation removes observation_items once the segment succeeds and no continuation needs it; counts, fingerprints and audit jobs remain. New daily observations run first; old saved remainder
follows. Expired unseen upstream entries remain unavailable, reported as
current-only coverage. History-cap values never increase at day rollover.

All ordinary connector scans and monitored captures now enter the same sorted
identity advisory locks (canonical/source URI, normalized DOI/arXiv and connector
external identity). The existing scoped resolver and bounded INSERT-conflict
re-read preserve one item and every channel hit. Personal identity remains
owner-scoped; Project identity remains Project-scoped. Normal research gates,
post-processing contracts, typed admission, real retry accounting and consent
checks remain in force.

### Monitoring failure recovery

Explicit Run now retries failed segments in the existing approved history/recent
plans after current Project/Source/version authority and absence of active work
are checked. It preserves the plan, approval, range, offset, attempt count and
consumed budget; it neither raises the total cap nor retries during a GET.
Failed extraction Job rows retain diagnostics. Daily sweeps do not silently
reopen permanent Source failures. Older unresolved ranges remain coverage_partial
after a successful newer observation; only a failed latest observation says
source_failed. Run now can fill the retained gap on the same day.

An unscheduled arXiv check also creates a bounded recent window after the approved
history cutoff, using the confirmed total cap and ordinary per-run/day admission;
it does not install a schedule. Future arXiv history endpoints are rejected on
proposal and activation. A page baseline that becomes unreadable to the Project
audience is a typed permission_changed refusal, retaining the pending offset;
restoring access permits the next explicit check to detect the page change.
Any request already sent remains charged. Upstream HTTP 403 remains a real
Source failure, distinct from this local permission refusal.

## Reading identity, state and material references

`readingIdentity.ts` owns the shared set-based identity resolver for reading and
state writes. A frozen `reading_initial_hash` records Sources' exact original
capture fingerprint alongside canonical URI; operational `content_hash` remains
free to represent metadata, raw bytes or extracted text and is never treated as
a body revision. First extraction does not split that capture family. Equal
verified retained bodies can join different capture fingerprints. Conflicting
retained bodies or genuine revisions partition the family by actual body hash;
an unknown member cannot bridge conflicting versions. Missing canonical URI or
capture/body evidence stays independent; no title similarity or client URL
normalization invents identity. Ownership and historical deliveries are unchanged.

Sources' database guards (`0011`–`0014`) derive `reading_body_hash` only from
retained Reader text: a canonical Reader artifact pointer, or the latest extracted
snapshot when Reader has no pointer. Text is NFC/whitespace normalized before
hashing. First retention establishes revision zero; replacing a known body with
different text advances `reading_body_revision` and records its change time.
Feed rescans, raw snapshot bytes, HTML noise and first extraction do not advance
it. Late historical snapshots do not replace the current fallback body. These
guards cover older application writers during rolling upgrades, as well as the
current normal, custom and monitoring Sources materialization paths.

Private completion binds `source_item_user_states.read_body_revision` to that
revision, the sole read-version binding. Migration 0015 removes the unused,
unpublished `read_content_hash` column introduced in 0009. Existing data is baselined without rewriting
snapshots. Legacy state writes without the new column are bound by a Sources
state guard; non-reading updates cannot renew an obsolete completion. For a
NULL binding from an upgrade interval, the last actual body change time and the
state's own timestamp provide the fallback meaning. Reader opens remain skimmed
and cannot complete new body text using an older completion.

`SourceReadingStateService.update` resolves currently authorized members by the
canonical-URI index, locks rows in order and uses the same identity CTE as queue
reads. One transaction and a per-user/URI advisory lock make group changes atomic.
`SourceItemUserStateStore` records explicit state time independently of incidental
Reader opens. The anchor gets its server-resolved Library/serendipity/Project
origin; copied members get no new interest evidence and retain existing origins,
including legacy NULL. Library `mark_selected`, `read_later` and `mark_discussed`
explicitly write library and upgrade an existing serendipity/project origin;
`mark_ignored` and pure dismissed changes leave a new origin NULL. The
Information Digest service verifies reading context before invoking this writer.

`readingMaterial.ts` provides the Sources-owned bulk association projection for
active bindings, direct saves and Corpus SourceItem/bridge references. Project
`view=all` returns real references in `material_links` and the same Reader target;
Evidence/Notes without a SourceItem stay in their owning views. The Project
recommendation audience calls the same reader FROM/predicate helpers as
`projects/access.ts`'s `projectReaderIds`, including active user and membership
rules. No copied audience SQL is maintained.

The acquisition-only `/sources/project-items` route retains its binding
collection meaning. The complete reading-material contract is
`GET /spaces/:spaceId/projects/:projectId/reading?view=all`.


The reading UI now consumes the shared Information Digest projection rather
than monitoring candidates. Sources retains collection settings, live candidate
processing and diagnostics. Project `tab=raw`/`candidates` reaches those candidates;
`tab=materials` reaches the complete authorized reading-material projection.
Relevant does not imply formal recommendation. Pending decisions link to the
canonical proposals surface, not the raw Activity inbox. Existing per-Source
briefing and item/Reader routes remain valid for deep links and history.

Research Reading List and Project Source annotations open the same SourceItem
Reader with `from=project`, returning to the bounded research reading-list tab or
Source management settings. Reader reload after re-extraction preserves that
origin; opening or synchronizing Project reading never fabricates Library
interest or serendipity feedback. Project association reuses Corpus references
and the retained Reader artifact rather than duplicating the body. Turning off
personal inclusion removes only recommendation contributions, not SourceItems,
Corpus references, saved Library triage, private state or daily snapshot rows.


### Reading quick start

ReadingStart, Sources list/detail and Project MonitoringPanel now route creation
and editing to the shared goal conversation rather than a provider/query form.
The unused SourceMonitorDialog, SourceQuickStartFields, ArxivCategoryPicker,
ScheduleRuleFields and MonitoringScheduleFields frontend authoring components
are removed. Backend taxonomy, compilers/search, legacy APIs, Source display,
subscriptions, history and necessary operational settings remain available.
See [SOURCE_GOALS](../architecture/SOURCE_GOALS.md) for canonical Session/Run
association, one follow confirmation (with optional preview and manual save),
compatibility mapping and the single scheduler owner. No real instance migration occurs from opening a page.

### Isolated Sources execution foundation

[ADR 0026](../decisions/0026-sources-isolated-request-execution.md) describes the
current foundation. Hosts opt in and offer `isolated-v1`; server dispatch generates
execution identities and refuses unoffered Hosts. Trusted mode never weakens it.
A Host offer describes executability only, never authorization. The server must
recheck Host ownership and Source/Space/Project permissions at selection, dispatch,
every physical request and result acceptance; phase two cannot infer access from an offer.
Bubblewrap mounts only the real Node executable, libraries and readonly code;
no handler node_modules, credentials, shell or writable host directory is exposed.
Resources use verified user-systemd cgroups or an administrator-delegated direct
cgroup v2 subtree. Missing capabilities refuse execution; standard-container
acceptance still needs that delegation and has not been performed.

The trusted daemon's pinned BasicCrawler/Cheerio adapter is serial, with a private
queue, scope/code-bound atomic checkpoint and recoverable owner leases. It invokes
isolated handlers for bounded `{items,next_urls}`. The framework concurrency-four
benchmark is not this adapter's throughput. Business cursors and materialization
remain server-owned. Sources broker scopes credentials by exact route on every
hop, requires HTTPS for credentials, combines registry/request cancellation,
preserves binary bytes, and exposes only bounded incremental metadata. Account
and endpoint admission/cooldown are durable and atomic (429 and eligible 503 only,
1s..24h). A cooldown takes one DB clock sample per write for all its groups, and
an in-range HTTP date is stored exactly as given. Current create/scan/repair flows have not enabled free generation; old
Legacy Level 3 remains frozen. The foundation itself added no goal UI; the
current goal model and conversation consumer are described in SOURCE_GOALS.
They reuse the existing scheduler and never add a second scheduler.

The adapter bounds HTML discovery to the first 100 valid HTTP(S) links (URLs at
most 8192 characters), passes `link_coverage` to code and returns aggregate
`coverage` counts (`discovered_links`, `provided_links`, `truncated_pages`). This
never enqueues omitted links or expands broker scope/budgets. Deterministic
HTTP/contract/scope/output failures do not retry; transient network errors and
5xx retain one retry (eligible Retry-After stops for persistent cooldown).
Public `input_json` remains independently capped at 1MiB UTF8. A daemon-only,
readonly `collection.json` transports response/link metadata within 16MiB, with
an 8MiB decoded response-body ceiling (at most 17MiB together with public input);
this is not a new public input field.
Lease owner files are complete before atomic hard-link publication; ownerless
legacy directories do not hold a lease. Release never recursively removes a
new contender. Temporary ownership files are reclaimed only for proven dead
boot/start identities. Direct execution requires trusted `prlimit` to inherit
CORE=0 and FSIZE=output_bytes, in addition to kernel cgroup/tmpfs limits.

Stage-three review fixes: goal adjustment budgets are per explicit user-message
cycle, not goal lifetime; automatic attempts remain finite. Legacy ownership
serializes PATCH/manual scans/backfill dispatch with takeover. Rollback uses full
snapshot CAS, clears effective transfer markers while retaining audit, and restores
original manual/Project scheduling rules. Existing legacy deep links resolve
read-only; paused goal conversation cannot activate collection. See SOURCE_GOALS
for the exact contract and review-fix evidence for executed checks.
