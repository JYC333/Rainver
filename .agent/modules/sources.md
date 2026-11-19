# Module: Sources

## Status

Implemented for built-in RSS, Atom, watched web page, arXiv, OpenAlex,
Semantic Scholar, credentialed Brave Web Search and Agent-assisted search
(`agent_native_search`) providers
(with HTML-first extraction), manual URL, candidate evidence,
reader, structured reader document extraction, and project_folder/project
routing flows.
Source Recipe plan/create/dry-run/activate routes, proposal activation,
scan-worker materialization, `source_runs` read model, and declarative-pipeline
bridge into `source_recipe_versions` are wired backend-side. Custom Source
proposal payloads/appliers and the Space/Instance Settings surfaces are wired.
Sources list/detail pages do not author Sources; they open the Following setup.
Custom Source repair/rollback are backend-only; credentialed sources have only
the `/sources/access` credential-creation page. Rate limiting,
artifact retention, and an observability read model exist. There is no
browser or Python handler evaluation.


Goal orchestration is implemented in `sources/goals/`, with topic setup in
`SourceGoalPage.tsx` (`topics/TopicCreate.tsx`), goal management, the
adjustment conversation and explicit legacy-source compatibility mapping. See [Source Goals](../architecture/SOURCE_GOALS.md) for authority,
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

The four public planning/control operations are core-owned:
`source.backfill.preview` is a metadata query; `source.backfill.create_plan`,
`source.backfill.pause` and `source.backfill.resume` are user-only commands.
Their existing POST URLs are thin adapters to the same registrations as the
query/action gateway. Commands require an explicit `Idempotency-Key` header.
The create body still requires its separate domain `idempotency_key`, used by
Research/monitoring orchestration too; transport replay does not replace it.
Responses use the core outcome envelope with a small plan receipt; the typed
browser create helper rereads the authorized plan detail after success.

All paths reload current Source manage/read authority, including receipt replay.
Project-linked writes pin the active Project and revalidate writer access before
binding/operation, channel/connection and plan locks. References must resolve in
the current Space and channel, with matching Project scope. Domain-key reuse
cannot change the scope authorized for a new command. Plan, segments, operation
link, mandatory policy audit and transport receipt commit or roll back together.
Preview writes no business rows or command receipt. These operations perform no
network work, approve no plan and add no Agent grant. `propose_start`, its
existing Agent preauthorized grant path and the canonical start applier remain
separate, unmigrated capabilities; consent, provider egress and execution quotas
are unchanged.

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
the provider-owned setup schema and category taxonomy. API clients can create a manual monitor through
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

Project binding happens through the Project Sources surface and
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
hour/minute, and weekly schedules choose weekday/hour/minute. The API
stores the normalized UTC rule in `source_channels.schedule_rule_json` and
returns it as `schedule_rule_json` alongside the computed `next_check_at`.
After each scheduled scan, the next run is recomputed from the rule so schedules
do not drift based on job completion time. The scheduler task owns only runtime
cursor/state (`next_run_at`, `last_run_at`, status, and operational metadata),
not the user-facing recurring rule. Source Detail displays `fetch_frequency`
read-only; manual sources have no recurring rule and run only through explicit
Scan actions.

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
shared Sources materializer. Source Detail shows origin and monitor status and
offers monitor pause/resume and scan, with editing routed to Following setup;
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

A guarded request may carry a bounded body (≤ 64 KiB) only with an explicit
`maxRedirects: 0` and a non-GET/HEAD method, so a body is never replayed to a
redirect target; the pinned undici transport sends it on the wire. Its only
consumer is the Gmail OAuth transport below.

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

The Reader's Read again uses the material-processing operation
(`MaterialProcessingPanel`, see
[Source material processing](../architecture/SOURCE_MATERIAL_PROCESSING.md)); it
saves a new version and keeps the current one. The `queue_content` item action
and `extract_text` job path remain the deterministic re-extraction route for API
callers; it creates a new extracted source snapshot/artifact and updates
`source_items.extracted_artifact_id`.

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

Explicit Interest Profile history backfill uses
`SourceAnnotationService.backfillHistory`: newest-first discovery (1–500,
default 500), current subscription/item/Source closure locked through commit,
new annotation rows only, and the mandatory existing annotation Job in the same
transaction as the operation audit and receipt. Replays reauthorize the recorded
Source references and subscription; failed existing annotations still use the
recovery path below. No provider IO occurs in this intent transaction. See the
[Interest Profile owner boundary](information-digest.md#interest-profile-operation-boundary).

### Annotation failure and recovery

Pending annotation timestamps are normalized to ISO strings at the repository
boundary, so prompt hashes and pre-send comparisons use the same JSON values.

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
one annotation job. The keyed `reading.annotation.retry` owner commits the
reopened rows, notification, mandatory Job, policy audit and receipt together.
Recovery, frozen annotation inputs/owners, canonical Delivery and result release
share Reading/Source locks and current Job claim fences. External execution
remains outside transactions; a lost or indeterminate claim cannot repeat IO.

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
  repair auto-apply, otherwise creates a proposal. The generate/test step runs
  outside any transaction; its activation or proposal then commits in one
  transaction under the Source's Project writer authority, the caller's Space
  role and the Source and channel rows (FOR UPDATE), re-verifying management,
  non-deletion, unchanged Source and channel status, this repair's
  `repair_pending` and the tested-against active version — a Source paused,
  deleted or taken out of the caller's hands meanwhile is not revived (409).
  Rollback activates a
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

Sources' database guards (migration `0005_project_reading_and_source_goals.sql`) derive `reading_body_hash` only from
retained Reader text: a canonical Reader artifact pointer, or the latest extracted
snapshot when Reader has no pointer. Text is NFC/whitespace normalized before
hashing. First retention establishes revision zero; replacing a known body with
different text advances `reading_body_revision` and records its change time.
Feed rescans, raw snapshot bytes, HTML noise and first extraction do not advance
it. Late historical snapshots do not replace the current fallback body. These
guards cover older application writers during rolling upgrades, as well as the
current normal, custom and monitoring Sources materialization paths.

Private completion binds `source_item_user_states.read_body_revision` to that
revision, the sole read-version binding; there is no `read_content_hash`
column. Existing data is baselined without rewriting
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

ReadingStart, Sources list/detail and Project MonitoringPanel route creation to
the Following topic setup (`topics/TopicCreate.tsx`) and editing to the topic's
adjustment dialog, rather than a provider/query form. Backend taxonomy, compilers/search, legacy APIs, Source display,
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

R4 Project-private favorites/deep-reading routes live in `sources/deepReading/`
and use the existing material processing Run/Job/check/submit path. Favorite
is only a private user-state boolean; the report remains an independent private
analysis Snapshot with exact supplied-original lineage, never a body rewrite.
Public route/list/cancel contracts are documented in [Library](library.md#project-favorites-and-private-deep-reading-api-r4-ui-in-r5)
and [material processing](../architecture/SOURCE_MATERIAL_PROCESSING.md#project-private-deep-reading-r4).


### Project consumption core adapters

Project Source binding create/update/unbind and retained-material backfill are
user-only core commands under project.source.bind policy, owned by Projects.
The four existing URLs and both typed browser API facades use the same
transaction-bound ProjectSourceBindingService and canonical routing. Project
writer/active scope, Source metadata and restricted delivery gates survive;
pausing an existing consumption binding does not require Source ownership.
Receipt replay rechecks current authority. Source consent, egress, extraction,
new history-start approval and proposal-first binding remain independent.
See [Projects](../architecture/PROJECTS.md#core-source-consumption-commands).


### Removed connection-level URLs

Connections are internal provenance created by Source Channels. The former
connection-level list/create/read/update/delete, draft, proposal,
recommendation, subscription and scan URLs (eight mutating methods and two
GETs) are not registered; a request reaches the unknown-route 404 like any
absent URL. There is no fixed-refusal handler or inventory exemption for them.
Underlying `source_connections` rows, provenance, schema and data are
unchanged. Live Channel subscription and the connection-scoped Custom Source
handler and Recipe read models keep their own authorization and lifecycle;
operationRoutes checks the removed URLs are absent and those neighbours remain
registered.


### Personal subscription core commands

source.channel.set_subscription and source.recommendation.decide are user-only
core commands behind the retained Channel subscription/recommendation URLs.
The typed Sources browser API supplies explicit request keys. The audited
source.subscription.manage action governs only the current person's existing
subscription row; it grants no Source configuration, content, egress or Agent
permission. Recommendation decisions require a currently active, shared Source;
resolved decisions can replay their own receipt, while a new decision still
requires pending status. Leaving/rejoining an existing subscription does not
require Source ownership or bypass its current read/consent gates.

Subscription state, opening/closing delivery windows, automatic interest-fact
cleanup, policy audit and receipt share one transaction. The canonical service
also performs cleanup inside its own transaction for direct Pool callers.
Accepted topics and dismissed candidate decisions remain; previously delivered
material keeps historical eligibility subject to current Source access. No
provider IO or automatic write retry is introduced.


### Core-owned recipe draft creation

Human recipe draft creation uses `source.recipe.create` (generic command and
retained formal POST) with a required explicit idempotency key. Canonical
Personal/Project creation context is resolved before key admission and checked
again inside the core transaction. The existing RecipeCreate/Channel writer
joins the scoped Queryable transaction: paused Source/Monitor, draft version,
scheduler intent, policy audit and receipt are atomic. The browser returns the
shared protocol creation DTO; it never substitutes its browsed Space as the
content destination. No external IO or auto-activation occurs. Role/domain/
credential/read checks and explicit name/schedule failures remain in the owning
services. Planning, dry-run, activation and pipeline bridge stay separate.


### Monitor controls through core

Monitor update and manual scan enqueue now use source.channel.update/scan for
formal and generic APIs, with explicit keys and the existing creator-only
service boundary. Save includes Source label/scheduler/audit/receipt in one tx.
The Channel writer keeps versioned-query conflicts, canonical schedule parsing
and Goal scheduling ownership. Its DTO serializes pg Date timestamps before
shared protocol validation, preserving the existing JSON wire representation.
Recipe draft creation uses those same typed Channel validation failures, with
no duplicate schedule pre-validation. Scan writes the canonical extraction Job
and returns202 as a completed enqueue command, not a completed scan. Replaying
a key does not repeat Job creation; current creator/membership/Job references
are checked before receipt release. Existing workers and UI surfaces remain
authoritative; no new Agent calls or automatic retries.

### P5-2 public Monitor creation

`source.channel.create` now joins update/scan as a user-only core command.
POST `/api/v1/sources/channels` is a thin adapter with explicit Idempotency-Key;
`createChannel` uses the same generic operation and retains its SourceChannel
return contract. One transaction owns channel/connection/search spec/subscription/
scheduler writes, policy audit and receipt. Domain fingerprint reuse is retained.
The existing creation-context owner chooses Personal/private or Project/shared
placement, with live Project writer authorization. Exactly this named durable
creation may use the existing human creation port; arbitrary durable/Agent/grantable
commands remain refused. The public schema rejects internal force/draft/actor
fields, preserving existing consent/policy/config and legitimate provider inputs.
This creates/schedules a Monitor, not a completed scan or approved Source effect.
Recipe activation, backfill approval and external execution are unchanged.

### P5-2 Source review repair: Monitor parent and domain admission

An explicit `source_connection_id` makes Monitor creation a child operation.
It is discovered only in the authenticated request Space, with current canonical
Source manage/read authority and the existing Project writer predicate. It never
finds a different Space from that id, rewrites a principal, widens parent reach,
or requires the UI to repeat the parent's Project. An explicit mismatching
Project conflicts. Only new-root creation retains the existing Personal/private
or explicit Project/shared placement. This exception is purpose-bound to the
named human-only Monitor command; Agent and other durable guards are unchanged.

Create and control resolve the real parent without row locks before key admission.
After keys, authoritative locking is Project -> parent Source -> Monitor, with a
parent owner/visibility/Project recheck; changed scope conflicts without late keys.
The parent uses an update lock before child locks, since a Monitor control can
rename it; independent child saves must not upgrade shared parent locks later.
Creator remains required for update/scan: canonical Source management is additional,
not an admin replacement for creator. Deleted parents are hidden for reads, writes
and retained receipts. Subscription opt-out is independent and remains available.
A create receipt does not redirect after its parent's Project changes.

Domain creation admission uses one owner/Space transaction advisory gate, shared
by ordinary Monitor creation and Recipe's existing canonical channel writer.
Public roots acquire it before Project/Source rows; joined writers only try the
gate (or reenter their already admitted root), never wait behind it after domain
locks. This serializes implicit-parent and explicit-parent fingerprint lookup /
creation without converting fingerprint semantics to request keys or adding an
incorrect cross-parent unique index. Different explicit parents and Recipe's
intentional fresh-owned-Source creation remain distinct domain identities.
Research selected-attempt materialization retains its separate attempt-id identity
and provenance; this repair does not collapse it into a public Monitor by fingerprint.

Create caches only explicit SourceChannelMutationError, ResearchQueryInputError,
SourceGovernanceInputError and known creation/scope conflicts. These types are
raised at their actual validation/conflict sites; no blanket helper-422 wrapper
exists. Unknown HttpError422/409 causes internal failure, full rollback and failed
audit recovery, with no terminal cached request or reflected domain message.
The public creation policy request retains source_channel/null-id, as the old
REST enforceSources call did, with one core policy decision per invocation.

### Source reference locks (P5-2 bounded N1 correction)

Source reference readers that pin both rows (Project bind/update, backfill and
recommendation decisions) explicitly lock the parent Source, then the exact
channel still attached to that parent. They do not rely on JOIN/RTE rowmark
order. Activation's canonical applier uses the same order with update locks;
the Custom Source handler activation helper takes its existing parent update
lock before selecting/locking a channel. Predicates, approval and delivery-scope
checks remain in their existing owners. A changed channel parent is refused;
no different parent is locked late. Subscription opt-out remains channel-only.

Monitor creator status does not override current Project write authority: after
that authority is revoked, update/scan and receipt replay are refused. Parent
update locks intentionally serialize controls for the same Source, including
scans and retained receipt authorization, and wait against reference share locks.
This costs concurrency within one parent but prevents lock upgrades after child
locks. It adds no global gate/retry and does not serialize unrelated Sources.

### P5-2 rules and manual dispatch

Rule create/update and manual run/drain, plus extraction `/jobs/:id/run`, now
use strict user-only core operations: `source.processing.rule.create/update/dispatch`
and `source.extraction.dispatch`. Five retained URLs are thin adapters; typed
browser calls use the same commands with caller keys. No Agent visibility/grant
or production approval mapping is enabled. Existing JSON configuration defaults,
canonical normalizers, derived-import consent and managed Agent writers remain
owners. The managed Agent prompt writer has an explicit transaction port so
Agent/version, rule/schedule, policy audit and receipt commit together.

Dispatch returns a required Job receipt (`pending`), not a completed processing
Run/extraction. Rule run/drain execute through the existing post-processing worker;
manual extraction uses the same existing repository/Recipe/Custom Source/worker
implementation. Extraction running conflicts, finished Jobs return `noop`; pending
intents for the same user/extraction are reused under the domain Job row lock.
This preserves domain state/history independently of transport request keys.
The Source list and detail toast say queued, not completed.

Request keys precede sorted Project admission and parent Source -> channel/item
-> rule/extraction row locks. Discover actual Source/Project scope before keys,
recheck under locks and reject drift instead of locking a new parent late. Full
content Job ACLs and the existing scan management gate remain distinct. Rules
require current Source management and actual Project writer authority; configured
Project and Agent references retain their own live checks. Replay reauthorizes;
soft deletion/foreign Space/revoked Project authority remain hidden.

External execution has no open core DB transaction. Manual Jobs have one attempt;
the existing `jobs.result_json` records a start fence before external I/O and its
result receipt before worker acknowledgement (`sourceDispatchExecution.ts`). Both
writes, and the busy-claim release, carry the queue's own current-claim predicate
(`status='running'`, `claimed_by`, `attempts`): a worker whose claim was reclaimed,
exhausted, cancelled or taken by a later attempt never starts external work
(`SourceDispatchLeaseLost`) and never writes a late receipt — the start fence stays,
so a later claim reports the outcome unavailable instead of repeating it. Delivery
under the same live claim replays the stored receipt. A crash/failure after starting without a durable result is indeterminate:
it fails rather than repeating possibly irreversible effects or claiming success.
An operator may inspect the existing Job/Run result and issue a new explicit
command; there is no automatic mutation retry or cross-I/O atomicity claim.
Dispatch freezes the selected rule revision; a changed revision is refused before
execution, with a second check inside the existing rule claim. Original event /
scheduled worker paths remain unchanged. run-once/decision actions that derive
content or invoke external work are outside this DB-only family; approval /
activation and Note policy remain in their later checkpoints.
Worker Job receipts contain only IDs/status/counts, not Source text, decisions or
content-bearing extraction metadata. Those remain in their existing Source
history tables behind current Source ACLs; the general Jobs reader does not gain
a second content channel.
Configuration admission uses the canonical rule configuration fingerprint, not
`updated_at`: cursor/fire progress from a preceding run must not invalidate the
next queued manual intent. A changed Agent/Project/status/trigger/input/actions
configuration still refuses stale dispatch before effects.

P5-2 bounded review follow-up: manual intents remain isolated by user, policy
record and Job receipt. They are not merged across users. An exact canonical
claim-busy error for this dispatch resource is pre-effect admission: clear only
its start marker and use existing JobDeferredError/deferJob (which restores the
attempt). Never reset an unknown-effect marker or treat an unrelated child claim
as permission to repeat. Cross-user/manual/automatic overlap is tested against
real PG canonical claim and terminal/noop writers. Distinct manual rule intents
still run in sequence; event/scheduled in-flight skips keep their existing meaning.

The rule configuration fingerprint intentionally does not pin the Agent prompt /
version: execution continues to use its current available version, as before,
with live Agent permission checks. This is not frozen approval or additional
Agent authority. PgAgentRepository's general constructor requires a Pool; Source
commands receive only its two bound InTransaction writer methods, not the full
repository/Pool. No checked-out client is cast to Pool. The writer implementations
continue to use their explicit query port and the default-Agent rollback tests.

Source list/detail now explain enqueue vs completion and link through the existing
SpaceLink to Job Queue. The existing failed Job/result view warns when a Source
start fence has no receipt: external effects may already have occurred and the
task will not automatically execute again. Check Source history and Job logs;
a known pre-I/O rejection can be resubmitted explicitly with a new key after its
cause is corrected. No new monitor/dashboard or approval copy is introduced.

Source-goal compatibility mapping, pause, scheduler takeover and rollback lock a known
Project, then Source connections, then their channels. Multi-channel rollback locks
all known parent connections before any child, matching legacy channel updates and
the connection locks required by binding foreign keys. Changed parent identity is
refused instead of acquiring a newly discovered parent after a channel lock.

### Source item and extracted-evidence object commands through core

Retained URLs → human-only core commands (`sources/sourceObjectOperations.ts`,
adapters in `sourceObjectOperationRoutes.ts`): `POST items/manual-url` →
`source.item.save_url`; `PATCH items/:itemId` → `source.item.update`;
`POST items/:itemId/actions` → `source.item.queue` (`queue_content`,
`archive_snapshot`; policy `source.item_create`) or `source.item.triage`
(`mark_selected`, `mark_ignored`, `read_later`, `mark_discussed`,
`extract_evidence`; policy `source.item_update`); `POST evidence` →
`source.evidence.create`; `PATCH evidence/:evidenceId` → `source.evidence.update`;
`POST evidence-links` → `source.evidence.link`. They reuse the canonical
`PgSourcesRepository` writers in one core transaction with audit and receipt.
Context-free URL/evidence creation is placed by the access owner (Project
shared, else Personal private); a named connection/source/artifact keeps the
request Space. With a connection, `project_id` may restate the connection's own
Project or, for a connection without one, name a Project the caller writes
(checked under the Project writer lock); a different Project is a cached 422.
Evidence from a source item/artifact may restate the source's Project, never
differ from it.
Queue actions only write the extraction Job intent consumed by the existing
worker; no provider or network IO runs in the transaction. The retrieval
projection refresh runs behind its own savepoint inside operation transactions.
Receipts are identity only; the browser rereads items/evidence through the
authorized GET in the receipt Space. A retention-policy refusal is a cached
consent refusal (409, `metadata.code = source_retention_policy`). The remaining Source families moved in the block continuation are described
below, the Goal family after them.

### Source block continuation: material, post-processing, retrieval, recipes, Custom Sources

Human-only, ungrantable core commands with explicit keys (definitions in
`packages/protocol/src/noteSourceBlockOperations.ts`; Agent surfaces unchanged):

- Material processing (`materialProcessing/operations.ts`): `source.material.start`
  writes the queued Run, the material operation row and the `agent_run` Job intent
  (`MaterialItemProcessingService.startIn`, also used by Project deep reading);
  `source.material.cancel` marks the Run cancelling and settles the operation in the
  transaction and stops the process after commit (stale cancelling Runs are swept);
  `source.material.request_storage` submits one pending `source_material_retention`
  proposal per Source policy under a Source row lock; `source.material.show_markdown`
  keeps its version fence (409 `metadata.code=reading_version_changed`). The state GET
  settles overdue/finished Runs, so it now requires `stateChangingReadAllowed`.
- Post-processing (`postProcessing/operations.ts`): decision actions split by their
  retained policy (`source.processing.decision.queue` for queue_content/extract_evidence,
  `.review` otherwise). rerun_item/deep_analysis and one-off runs
  (`source.processing.run_once`) write a single-attempt `source_post_processing_event`
  Job (`manual_decision` / `manual_run_once`) executed behind the Source dispatch start
  fence; the worker rechecks the reviewer's decision reach and the admitted rule
  fingerprint, or repeats one-off admission. Run-once now resolves the Monitor the
  inputs were delivered through (the legacy handler looked a connection id up as a
  channel id and could never find it).
- Retrieval (`retrievalOperations.ts`): search, Context Brief and provider query
  preview are request commands (202 Job receipt, Job type `source_retrieval_request`);
  embedding/rewrite/rerank/synthesis and provider fetches run in the Job outside any
  transaction behind the start fence. Preview spends its per-connection quota at
  admission (429 `source_preview_quota` rolls back) and freezes the credential id,
  never its header. The general Jobs reader withholds this Job type's result;
  `GET /sources/retrieval/requests/:jobId` releases it to the requester only, through
  the canonical retrieval gate (`RetrievalSearchService.revalidateForRelease`: the
  Source adapter's revalidation with subscription/history eligibility and Evidence
  provenance, then the Source consent/archive policy, B11 read audit). An object is
  released whole and fully readable or withheld; there is no stripped summary copy.
  Once any source of a brief is withheld, its synthesized answer and model gap
  findings (`uncited_claims`, `contradictions`, `missing_topics`) are dropped and the
  deterministic `stale`/`thin` lists keep only releasable sources. `source.retrieval.reindex`
  rebuilds the projection and queues its embedding backfill in one transaction (Space
  owner/admin).
- Backfill: `source.backfill.start.propose` (retained propose-start URL) reuses the
  backfill authority (manage, Project refs, plan lock) and the canonical start
  proposal writer; a proposed plan returns its pending proposal. Agent auto-grant stays
  on the Agent action `source.backfill.propose_start`.
- Recipes (`sourceRecipeOperations.ts`): planning and dry-run are request commands
  (`recipe_plan` / `recipe_dry_run`), the dry-run outcome recorded by its status-fenced
  writer; `source.recipe.activate` activates in-envelope or submits the canonical
  `source_recipe_activation` proposal. Dry-run and activation now require current
  Source management (the legacy handlers only required the Source to exist).
- Custom Sources (`customSources/operations.ts`): drafts (access-owner placement),
  pipeline generation (429 rate limit rolls back), activation, rollback and the
  pipeline bridge are DB commands; handler test and repair are request commands
  (`custom_test` / `custom_repair`) whose worker reuses the existing short per-step
  transactions. Every connection command requires current management (the bridge did
  not check it). Credentials accept the secret once: the request fingerprint keys it by
  HMAC, and no receipt, audit or Job stores it. Space policy (Space admin) and instance
  runner settings (instance admin) are commands.

Dedicated refusals are `SourceObjectRefusal` at their throw sites (409/422, optional
content-free `metadata.code`); the web client promotes `metadata.code` to the error code.

### Source block Goals family

The 21 retained goal-setup / goal control URLs are human-only, ungrantable core
commands (`packages/protocol/src/sourceGoalOperations.ts`, registrations in
`goals/operations.ts`, policy `source.goal.manage`, explicit transport key, strict
input = the existing request schema plus URL targets). The Agent goal actions
(`source.goal.read/sources/inspect/write_version/repair_candidate`,
`source.material.submit`) and the collection worker are unchanged. Every goal
command takes the Goal writer lock (`goals/transaction.ts#lockGoal`): the goal's
Project row first (FOR UPDATE, as the legacy, compatibility and activation writers
take it), then the goal row, then pins the Project writer's membership, and the owner
rechecks under those locks. Every domain Goal writer, the topic-analysis writers and
the scheduler cohort use the same Project → Goal order, as do a briefing/reading
Delivery (Project audience share → Goal share; `lockReadingRunAuthority` includes the
Following goals' own Projects), so no writer holds a Goal while waiting for its
Project. Goal creation takes the Project row FOR UPDATE before the writer check's
share lock. A collection batch commit (`materialization.ts`) holds the same closure
(Project and Goal share, binding FOR UPDATE, then the Source connection's read
authority: row, the owner's subscriptions, content ACL) and re-verifies the goal and
Source under it: a pause/delete, Project writer removal or Source change either
commits first and refuses the batch or waits for its commit. A valid lease alone is
not execution authority. Receipts are identity plus the
state the caller acts on; a replay is released only to the goal's current manager (a
deleted goal's own delete receipt included); plans, previews, messages and theme
results stay behind the GET readers.

- Creation (`source.goal.setup.begin`, `source.goal.create`) uses access-owner
  placement (Project when named, else Personal), Project writer pinned; begin commits
  the topic, its Session choices and its optional follow (and its queued planning
  Run) in one transaction.
- `source.goal.setup.message` commits the authenticated message, its adjustment cycle
  and the queued planning Run + `agent_run` Job intent together; a refused admission
  leaves no message or dispatch claim (cached refusal with `metadata.code`). The
  domain message key still deduplicates.
- `source.goal.preview.request` is a request command: admission (exact current
  version, one in flight, three per version) and a single-attempt
  `source_retrieval_request` Job (`kind: goal_preview`) commit together (202). The
  Job runs behind the Source dispatch start fence, repeats admission under the
  person's current authority before any Source execution (a stopped goal or changed
  version marks the preview `stale` and executes nothing) and stores through the
  existing preview writer, which checks the goal again. The result is read through
  `GET /sources/goals/:goalId` (`previews`); the browser polls while one is running.
  The old synchronous 120-second request path is gone.
- explore/check keep their existing queued Run / `source_goal_tick` Job intents;
  edit, save, follow, feedback, resume, rollback, source confirmation, repair publish
  and compatibility mapping/rollback are DB commands over the existing writers.
- Cancellation is an intent in the command: pause/delete mark every live goal Run
  cancelling, an activation (follow/save/resume/begin) marks superseded native
  collections cancelling (`markSupersededCollectionsIn`), and theme cancel marks the
  analysis Run cancelling and settles its briefing `cancelled` (settlement accepts
  only a queued briefing, so a late Run result cannot land). The process stop is
  after commit (`stopCancellingGoalRuns`, `stopThemeRoundRun`); the Run sweep finishes
  an interrupted one.
- Refusals: domain 400/409/422, exhausted budgets (429, reported 409 with
  `metadata.status`), named `source_*`/`theme_*` refusals and the owned Agent/Profile
  requirement are cached with `metadata.code`; access refusals without a code are
  hidden (404).


### a83 final authority and effect follow-up

Stored retrieval release uses one complete, ordered Source/provenance/ACL closure
and one transaction for canonical revalidation, live canonical Source lineage
and B11 commit. Multiple hits do not lock their shared dependencies in hit order.
Repair and collection final transactions lock/recheck active user plus active
Space membership, including conflicts with auth account disable. Collection
leases use actual database time after waiting for locks and at the final commit
decision. See [DB owner rules](../architecture/DATABASE_AND_TRANSACTIONS.md#source-result-release-and-final-source-commits-a83-follow-up).

The dispatch's start CAS is reservation, not permission to do later I/O. Its Job
credential reaches actual Source HTTP, provider HTTP, Host launch (after capacity
waiting) and durable Job enqueue boundaries. Cancel/reclaim revoke later starts;
started unknown outcomes are not reissued. Existing domain permission, consent,
provenance, spending, approval and credential/HMAC gates remain in force. See
[Job ownership](../architecture/EXECUTION_MODEL.md#manual-source-job-execution-ownership).

The Host Source broker's Job-authority wrapper forwards through a fresh function;
its scope metadata may be read-only and is never reassigned on the original broker.


Annotation manual retry and interest history/recommendation preparation discover
the complete bounded Source/Project set before person locks. Their existing
Reading mutation closure pins current users/memberships after Project audiences;
execution consumes that locked selection and rechecks discovery before writes.
Operation replay locks retained result references before core actor locks.
No deadlock exception is converted to success or an application retry.

## Personal Gmail connections (connection lifecycle, new-mail monitors, legacy Project selections)

Open acceptance items and known limits are in the
[deferred register](../tasks/deferred-register.md#gmail--real-environment-acceptance-and-limits).
Implemented: the OAuth connection
lifecycle, owner-private new-mail monitors (below, "New-mail monitors"),
reading a legacy selected thread with a mandatory owner-read audit, and the
owner's browser UI. The manual thread search and adding selections were
retired in V2. An Agent reads mail only through the on-demand read below
("On-demand Agent reads", ADR 0032/0033 §6) — in any ordinary conversation of
a Project (the owner's private one, a Room or the mainline), in the owner's own
turn, after their opt-in and their one standing consent for that Project and
mailbox, on the conversation's own runtime — and through the scheduled digest
read of a confirmed digest. No delegated or system path reads mail, and an
Agent otherwise only drafts a monitor as the owner's private proposal. Code: `server/src/modules/sources/gmail/`, schema
`server/src/db/schema/gmail.ts` (migrations `0020_gmail_oauth_connections`;
`0021_gmail_revocation_obligations` added an automatic-revocation table that
`0022_gmail_drop_remote_revocation` drops again with
`gmail_connections.revocation_status`; `0023_gmail_thread_selections_read_audit`;
`0031_gmail_agent_read` adds the opt-in and the Agent read audit columns;
`0033_gmail_project_agent_read_consent` adds the Project consent binding to
`plugin_data_grants` and ends earlier per-Run Gmail consents;
`0034_gmail_consent_binding_and_shape` freezes the consent on its request and
closes the shape check's NULL holes),
DTOs `packages/protocol/src/gmail.ts`.

- **No automatic remote revocation.** Google revokes per grant (client +
  account), so a revoke sent for one connection also cuts another Space's or
  person's connection of the same Google account and tokens a newer attempt
  already exchanged, and no local lock, lease or timer proves when Google
  stopped processing a revoke. Rainver therefore never calls Google's revoke
  endpoint: disconnect removes local authority only and reports
  `remote_revocation: "not_requested"` with `manual_revocation_url`
  (`GMAIL_MANUAL_REVOCATION_URL`, Google Account → Third-party apps &
  services), where the person removes Rainver's access themselves. Refused
  callback tokens are discarded, not revoked. The grant (and any access token
  already issued, until it expires) stays valid at Google until the person
  removes it. Disconnect deletes Rainver's stored copy; a request already past
  its pre-send recheck (below) is not recalled.
- **Rows.** `gmail_connections` (one per owner + Space + Google `sub`; not a
  SourceConnection, no visibility column, no catalog connector) and
  `gmail_oauth_attempts` (state SHA-256 only, 10 min expiry, single use). An
  `active` row always has its `gmail_oauth` credential; other statuses have none
  (CHECK). Generation +1 on connect, reconnect/credential replacement,
  reauth transition and disconnect.
- **Locks.** Every Gmail transaction that writes or admits a send — start,
  callback consume, both pre-send rechecks, install, disconnect, forget and each
  refresh step — takes: active person (`lockActivePerson`, or the operation
  core's actor pin before `authorize`) → the owner + Space mutex
  (`lockGmailOwnerSpace`, `pg_advisory_xact_lock` on
  `gmail-owner:<space>:<user>`, which exists even with no attempt or connection
  row) → attempts → connection → credential. Disconnect/forget take the mutex and
  the connection row `FOR UPDATE` in `authorize`, so no `SHARE` lock is upgraded
  later and two commands with different idempotency keys serialize instead of
  deadlocking.
- **Configuration.** Optional `GMAIL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`
  (all or none; the redirect URI must be the instance origin plus exactly
  `/api/v1/sources/gmail/oauth/callback`; https in prod unless loopback). Server process only.
  A dedicated Web OAuth client is recommended. The Google sign-in client ID
  and secret can also be reused by registering the Gmail callback alongside the
  sign-in callback. Unset → start
  answers `503 gmail_not_configured` and the list reports `configured:false`.
- **Start.** `POST /api/v1/sources/gmail/oauth/start` (exact transport exemption
  in the route inventory: it issues a one-time state) supersedes the person's
  unconsumed attempts and returns Google's URL with `openid gmail.readonly`,
  `access_type=offline`, `prompt=consent`, `include_granted_scopes=false`, S256
  PKCE (verifier = HMAC(HKDF(master key, "gmail-pkce-v1"), state), never stored).
  Its cleanup is limited to the caller in this Space: unconsumed attempts and
  consumed ones older than the 10 min install window; other people's and other
  Spaces' attempts, and a consumed attempt still inside its window, stay.
  `reconnect_connection_id` must be the caller's own connection; the attempt
  records its generation.
- **Callback.** `GET /api/v1/sources/gmail/oauth/callback` consumes the attempt
  (`consumed_at IS NULL AND user_id = session user`, row locked after the
  owner + Space mutex, then `expires_at >` the database's actual time read once
  after those locks — `gmailLockedNow`'s `clock_timestamp()`, not the
  transaction-start `now()` — which is also stored as `consumed_at`) in a
  transaction that, before the code is spent, requires the person to be active
  and an active member of the attempt's Space (`lockActivePerson`, else
  `gmail_connection_unavailable`) and a reconnect target to still be theirs at
  the recorded generation (else `gmail_connection_unavailable` /
  `gmail_oauth_superseded`); a refusal still consumes the attempt, and the code
  is spent at most once. After DNS, immediately before the token POST (and
  before each profile-read send), `admitAttemptSend` rechecks in a short locked
  transaction that the person is still an active member, the consumed attempt
  still exists inside its window and a reconnect target is unchanged; otherwise
  nothing is sent and the callback ends with that code. It validates the ID token from the direct token
  response (`iss`, `aud`, `exp`, `sub`), refuses missing/excess scopes
  (`evaluateGrantedGmailScopes`), reads the mailbox address with
  `users.getProfile` through the Sources broker with `gmailSourceRequestPolicy`
  (whose authorize step is `admitAttemptSend`) and the stable-subject
  quota, and installs the credential and connection in one transaction after
  `lockActivePerson`. The install requires its consumed attempt row to still
  exist (≤ 10 min old) and a reconnect target still at the recorded generation,
  else `gmail_oauth_superseded`: a disconnect deletes the owner's attempts in the
  Space and a successful install deletes the others, so a paused or older
  callback (first connect included) cannot reinstall. Same subject → same row
  (new credential row replaces the old; a missing refresh token keeps the stored
  one only for that proven account); a reconnect that signs in as another
  account is `gmail_account_mismatch`. It redirects (303, `no-store`,
  `no-referrer`) to `/sources?gmail=<fixed code>`; request logs already drop the
  query. Every refusal after the exchange discards the fresh tokens unstored.
- **Refresh.** `resolveGmailAccessToken` (`gmailTokenRefresh.ts`) follows the
  once-only protocol (row locks, `in_flight` lease with keyed fingerprint, POST
  outside transactions, settle only for the same attempt, generation and
  credential). Each of its transactions first requires the owner's current
  authority (`lockActivePerson` on the snapshot's Space), so a disabled user or
  removed member gets no cached token, sends no refresh POST, and a result
  arriving after removal is discarded (`gmail_authority_revoked`).
  The POST's `beforeSend` (after DNS) reruns the same locked check plus "this
  `in_flight` attempt and credential are still current"; a disconnect or
  membership removal during name resolution therefore sends nothing.
  `invalid_grant` → `reauth_required` (credential deleted);
  429/5xx/other refusal/not sent → `transient` with backoff; sent without an
  answer → `uncertain`, retried after the lease. Mail reads resolve the token
  through it on every hop.
- **Disconnect / forget.** Core commands `source.gmail.connection.disconnect`
  (`POST …/connections/:id/disconnect`) and `source.gmail.connection.forget`
  (`DELETE …/connections/:id`), user principal, `public_api` only, policy
  `source.gmail.connection.manage`, owner-only hidden 404. Disconnect sets
  `disconnected`, deletes the credential (refresh and access token), bumps the
  generation and deletes the owner's attempts in the Space in the operation
  transaction — the same for the REST adapter and `/api/v1/actions`. It sends
  nothing to Google and enqueues no Job; the receipt is
  `{…, remote_revocation: "not_requested", manual_revocation_url}` and a
  same-key replay returns it. Forget deletes a row that holds no credential
  (an active row is `409`); it first ends that connection's active Agent-read
  consents and pending consent requests, and the deletion cascades its
  attempts, thread selections, monitors, matches and sync cursor. Ended
  consents and approved requests stay as evidence: a consent names its
  connection only as a snapshot (no foreign key since migration
  `0035_gmail_consent_history_and_request_end`), so history never blocks
  Forget and never admits again.
- **Transport.** `gmailOAuthTransport.ts` sends the token exchange and refresh
  POSTs through `fetchGuarded`: HTTPS, exactly the fixed
  `oauth2.googleapis.com/token` URL (there is no revoke POST),
  `maxRedirects: 0` with a bounded form body, 64 KiB response cap, 10 s
  deadline. Outcomes carry only a class and Google's OAuth error code.
  Each POST requires an `admit` step run in `beforeSend` as the last await
  before dispatch; a refusal is `not_sent`. A writer committing after `admit`
  returns and before the bytes leave still sees that one POST; settlement
  discards its result.
- **Quota.** Durable keys from `gmailQuotaGroups` (stable `sub` per account,
  per-owner group); forget/reconnect and credential replacement cannot reset a
  Google cooldown (`server/test/gmailConnectionDb.test.ts`).
- **Project selection (legacy).** `gmail_project_thread_selections` holds
  references only (connection, Project, Google thread id, optional
  `read_after`/`read_before`; no subject, snippet, address or body). V2 retired
  adding them (`source.gmail.selection.add`, `POST /api/v1/sources/gmail/selections`
  and the search route are gone); existing rows are kept. Core command
  `source.gmail.selection.remove` (`DELETE …/selections/:selectionId`), policy
  `source.gmail.selection.manage`, user-only, `public_api` only, ungrantable:
  a hard delete of the caller's own row under the mutex, without Project access
  (cleanup after losing it); once the row is gone even a same-key replay is the
  hidden 404. Forget cascades a connection's selections.
  `GET /api/v1/sources/gmail/selections` lists only the caller's rows
  (`project_readable` false when they lost access). Nobody else — Project
  owner, Space admin or member — can list, read or remove them.
- **Reads.** `POST /api/v1/sources/gmail/selections/:selectionId/read`
  (`cursor`) is an exact transport exemption: synchronous, owner-only, POST so
  cursors never sit in a URL; a core query cannot do external IO or write the
  audit, and a command result would retain mail. Sequence (`gmailMailReads.ts`):
  admission transaction → outside every transaction, a broker from
  `gmailSourceRequestPolicy` (exact URL per hop — profile, thread metadata, one
  full message; `threads.list` is no longer admitted — no redirects, 21
  physical sends per page, 2 MiB / 15 s per response, stable-subject quota,
  the page signal) → in-memory normalization → release transaction (recheck +
  audit row) → serialization after commit with `private, no-store`, `no-referrer`.
- **Read authority.** One predicate (`gmailReadAuthority.ts`) at admission, as
  the broker's `authorize` before every hop's credential and every physical send,
  and in the release transaction: Project + Space + the caller's Project
  membership `FOR SHARE` (`assertProjectReadableLocked`) → `lockActivePerson` →
  the owner + Space mutex → the caller's connection `FOR SHARE` (`active`) → the
  caller's selection `FOR SHARE`; after admission also the same generation and
  selection window.
- **Page deadline and bounded transactions** (`gmailReadDeadline.ts`). Each
  search or read page has one signal: the client's disconnect plus
  `GMAIL_READ_LIMITS.pageDeadlineMs` (60 s, the whole page — not 21 × 15 s; the
  broker's 15 s per send sits inside it). Every database step of the page runs
  in `withGmailReadTransaction` under that signal: the selection route lookup,
  admission, each per-send authority check (with the broker's narrower per-send
  signal), token refresh (all three steps; its lease wait also stops on abort),
  quota admission and cooldown (the broker receives the page's runner instead
  of the pool) and the final release. Pool acquisition gives up on abort and
  releases a client that arrives later unused (the pool's own 5 s connect
  timeout is `503 gmail_authority_busy`); each transaction keeps `lock_timeout`
  3 s / `statement_timeout` 5 s cut to the time left (a full-length timeout is
  `503 gmail_authority_busy`, one cut by the deadline `504
  gmail_upstream_timeout`). On abort `pg_cancel_backend` (pid +
  `backend_start`) goes through the separate `getGmailReadControlPool` (max 2,
  1 s connect/query/statement timeouts, 2 s overall) so it works while the main
  pool is exhausted; the target client stays checked out until that request
  answered, then ROLLBACK and release — so a late cancel cannot reach a
  transaction that reuses the backend. A failed or timed-out cancel destroys
  the target client at once. From acquisition on every client-side wait is
  bounded: BEGIN, the pid/timeout marker query, the work and COMMIT follow the
  signal (before the marker no cancel is possible, so an abort there destroys
  the client); the cleanup after an abort (cancel answer, work settling,
  ROLLBACK) has one `cleanupMs` (2 s) budget, and a ROLLBACK after an ordinary
  error is bounded by the signal and that budget. A wait a bound ends destroys
  the client (closing the connection ends its transaction in PostgreSQL);
  only an answered cancel + settled work + successful ROLLBACK returns it to
  the pool. So an unresponsive database ends a call at most 2 s after its
  abort (a page at most 60 s + 2 s). Abort is `499 gmail_cancelled`, the page
  deadline `504 gmail_upstream_timeout`. No transaction is held across Google
  IO. A `GmailReadError` from the page runner (quota admission/cooldown, token
  refresh) keeps its class instead of the broker's wrapped `502`.
  The selection and read-audit lists (`listGmailSelectionsBounded`,
  `listGmailReadAuditBounded`) run in one such transaction under the client's
  disconnect and the page deadline — including the Project readability lookup
  after the selection query — because plain SELECTs still wait behind an
  `ACCESS EXCLUSIVE` table lock; owner filtering is unchanged.
  Foreign/vanished/no access → `404 gmail_not_found`; the
  owner's own change → `409 gmail_connection_inactive | gmail_reauth_required |
  gmail_connection_changed | gmail_selection_changed`. A disconnect, membership
  removal, user disable, selection removal or window change between the last
  fetch and release therefore releases nothing and writes no audit row.
- **Pages and limits.** Read: `threads.get` returns the whole thread (no message
  paging), so the server filters by the window (the reply's thread `subject` is
  the oldest *in-window* message's, `null` for an empty window), keeps the newest 500
  (`thread_message_limit`), pages newest first by 20 and fetches each with
  `messages.get format=full`. Per page: raw bytes ≤ 8 MiB (no send that could
  pass it: `page_raw_bytes`), normalized ≤ 1 MiB (`page_text_bytes`), text ≤
  256 KiB per message (`text_truncated`); a response over 2 MiB is an
  `omitted: too_large` entry and a Google 404 `omitted: unavailable`, each
  with its Gmail link. Truncation reasons are always listed; nothing is cut
  silently. Text is plain only (`gmailMessageText.ts`): text/plain preferred per
  alternative, HTML through `stripHtml` with block breaks, declared charsets via
  `TextDecoder`, attachments (a filename or `Content-Disposition: attachment`,
  checked before walking any multipart) counted once, never walked or fetched, no markup, images or
  links. `gmail_url` (`https://mail.google.com/mail/u/?authuser=<email>#all/<id>`)
  carries no token.
- **Cursors.** `gmailCursor.ts`: `base64url(payload).HMAC` (HKDF(master key,
  "gmail-cursor-v1")), binding owner, Space, connection, generation, Project,
  the selection, its thread, its window and the last released message's
  (internal date, id) boundary — the next page is the messages strictly after it
  in the newest-first order, so mail added or deleted between pages neither
  repeats nor skips; expiry 15 min issued and
  judged on `clock_timestamp()` after the admission locks. A cursor reused with
  another window, Project, selection or generation, tampered or expired,
  is refused before any Google request (`409 gmail_cursor_invalid |
  gmail_cursor_expired | gmail_connection_changed`).
- **Owner-read audit.** `gmail_read_audit_events` (not `content_access_logs`,
  whose B11 CHECK forbids owner = viewer): owner, actor (CHECK `= owner`),
  connection/Project/selection (SET NULL), `thread_read` (older rows may say
  `thread_search` from the retired search),
  thread id, item count, truncated, request id, time — never query text,
  headers, snippets or bodies. Inserted in the release transaction; any failure
  there is `503 gmail_audit_unavailable` with no content. Owner-only list:
  `GET /api/v1/sources/gmail/read-audit`. Pruned with `content_access_logs` by
  the same retention task and setting (`pruneContentAccessLogs`).
- **Nothing at rest.** No Job, operation result, event, SourceItem, cache table,
  file or shared push holds mail; selection/audit rows hold ids only; errors and
  logs carry fixed `gmail_*` codes only (`server/test/gmailMailReadDb.test.ts`).
- **Web UI** (owner only; typed consumer `apps/web/src/api/gmail.ts`, which
  parses every reply with the protocol schemas and names the Space and an
  AbortSignal on each call; calls go through `apiTransport` in
  `api/client.ts`). *Connections*: `modules/sources/gmail/GmailConnectionsCard.tsx`
  on `/sources/access` below the unchanged administrator credential form,
  entered from the Sources page header ("Access and Gmail"). It lists the
  person's connections, starts OAuth (connect / reconnect for a non-active row)
  and shows Google's URL as a "Continue to Google" link the person clicks —
  never an automatic redirect, and only when `gmailConsentUrl` (`api/gmail.ts`)
  accepts it: exactly `https://accounts.google.com/o/oauth2/v2/auth`, no
  credentials or written port (even `:443`/`:0443`, checked on the raw
  authority before URL normalization); anything else shows `consent_invalid` and no link; `configured:false` explains that an instance
  administrator configures the server and offers no secret field. Disconnect
  confirms that it is local only and then links `GMAIL_MANUAL_REVOCATION_URL`;
  forget is offered for non-active rows. The callback's `/sources?gmail=<code>`
  lands on `GmailCallbackLanding` (route in `App.tsx`), which forwards only a
  known result code to the preferred Space's Access page; the card shows it
  once and removes it from the URL. *Monitoring*:
  `modules/sources/gmail/GmailMonitorsCard.tsx` below the connections card:
  pending drafts (Accept / Decline through the ordinary proposal decision,
  `api/gmail.ts` `monitorDrafts` lists only well-formed `gmail_monitor_create`
  payloads), the person's monitors per mailbox with criteria, status, match
  count, Pause/Resume and Delete (confirmed), a content-free check line (push
  or scheduled, last/next check, `baseline`/`recovering`, partial recovery,
  last error code) and recent matches as "Open in Gmail" links only. *Project*:
  `modules/projects/sourcesArea/gmail/ProjectGmailThreads.tsx` in the Project
  Sources settings tab (`?tab=settings`, after "Manage linked sources"): a
  pointer to Gmail monitoring, own connection choice and the person's earlier
    selections with Read / Remove (no search box and no Select). `GmailThreadReader.tsx` is a dialog: 20 newest-first messages per
  page (Older / Newest by server cursor), manual Refresh, timestamps, per-message
  and thread Gmail links, explicit truncation/omission/attachment notes; text is
  rendered as React text only (no HTML, images or links from mail). *Scope and
  stale replies*: `modules/sources/gmail/useGmailScope.ts` aborts every call of
  a scope when it changes or on `invalidate()` and resolves late replies to
  nothing; list reads run on a named channel where only the newest
  call can land, so a refresh after a write is never overwritten by an older
  read. Every clearing refusal from selections, remove, monitor commands or
  the reader goes through one path per surface (Project connection `clear`,
  card `clear`): it invalidates all earlier calls and removes selections,
  monitors, the open reader, the consent link and receipt together (a hidden
  404 or `changed` then re-reads the list in the new generation); the Project
  panel remounts per person + Space + Project and per connection, the reader
  per selection, and the card tags its content with person + Space, so old mail
  disappears in the same render. 401/403/404 and the owner's own withdrawal
  (`reauth`, `inactive`, `changed`) clear shown content (`GMAIL_CLEARING_FAILURES`);
  rate limit, deadline and busy keep the same-scope page with a retry. Writes
  keep one idempotency key per intent until success, so a retry after a lost
  reply replays the receipt; a second click on an in-flight intent does nothing.
  Nothing is put in localStorage, a query cache or Cache Storage (Workbox keeps
  `/api/v1/` `NetworkOnly`, pinned in `src/__tests__/api-entrypoint.test.ts`).
  The Inbox opens a `gmail_monitor_matches` pointer at `/sources/access`
  (`modules/activity/ActivityQueue.tsx`).
  Tests: `src/__tests__/gmail-api.test.ts`,
  `modules/sources/__tests__/GmailConnectionsCard.test.tsx`,
  `modules/sources/__tests__/GmailMonitorsCard.test.tsx`,
  `modules/projects/__tests__/ProjectGmailThreads.test.tsx`; built-app fixture
  `src/__tests__/gmail-sources.browser.mjs` (synthetic APIs, both themes and
  locales, 390/1280 px, screenshots to `GMAIL_SHOTS`).

### New-mail monitors (Gmail V2 first version)

Code: `sources/gmail/gmailMonitors.ts` (rows, applier, owner commands,
wake-up, retention), `gmailMonitorProposal.ts` (Agent tool),
`gmailMailboxSync.ts` (sync), `gmailSyncRequests.ts` (wake-ups, retry floor,
reconnect resume), `gmailSyncContract.ts` (sync allowlist),
`gmailMonitorCriteria.ts` (matching), `gmailWatch.ts` (`users.watch`),
`gmailPush.ts` (push intake), `gmailSyncJob.ts` (Job); schema in
`db/schema/gmail.ts` (migrations `0027_gmail_new_mail_monitoring`,
`0028_gmail_sync_progress_and_retry`).

- **Rows.** `gmail_monitor_rules`: owner, Space, connection (FK cascade),
  optional `project_id` (SET NULL; a context label, never an audience), purpose
  (≤ 280), fixed-field `criteria` (`from_any` address/`@domain`, `subject_any`
  phrases, `label_any` label ids; each non-empty field must match, any value
  within it; ≥ 1 criterion), `active|paused`, `active_since`, `proposal_id`
  (unique), match count. At most 20 per connection. `gmail_mailbox_sync_states`:
  one history cursor per connection (`baseline|ok|recovering`, `history_id`,
  `recovery_after`/`recovery_partial`, lease, `sync_requested_at`,
  `next_poll_at`, failures, last error code, durable retry floor
  `retry_not_before`, in-record progress `record_history_id`/`record_offset`,
  watch expiry and the watch renewal's own `watch_error_code`/`watch_retry_at`/
  `watch_failure_count`, last push).
  `gmail_monitor_matches`: (monitor, Gmail message id) dedup ledger, ids only,
  pruned after 30 days with the content-access retention task.
- **Drafting.** `source.gmail.monitor.propose` (Agent tool, conversation
  allowance) turns the person's words into criteria and inserts a private
  `gmail_monitor_create` proposal (visibility `private`, owner = instructing
  person, `project_id` NULL; the Run's Project is only `target_project_id` in
  the payload, kept only if the owner can read it). Refused
  (`gmail_monitor_private_turn_required`) unless the stored Run is the owner's
  own `manual` turn (`effectiveRunTrigger` + `scenarioOrigin`; not delegated,
  continuation or unattended) and `runAudience` is that person alone — the
  ADR 0030 personal-write scenario. No Gmail request, no criteria in the tool
  result, and no proposal id in the summary the dispatcher persists as Run
  evidence; replay by Run + idempotency key returns the same draft. The tool
  call itself is reduced at the ACP boundary (`runtimeAdapters/privateToolCalls.ts`,
  applied in both the host-thread and Run-event normalizers before anything is
  persisted, so also before the live turn stream polls it): its arguments,
  command line, output and error never reach `host_thread_events` or Run
  events — only the call id, status, kind and the action id as title — before
  the draft exists, on a refusal, and after. The person's own message keeps
  its Room read rules. The scenario
  check, the replay lookup and the insert run in one transaction after the
  owner's person lock and owner + Space mutex, so concurrent same-key calls
  produce one draft and the check sees any audience change committed first.
- **Confirmation.** The owner's own accept/reject (`/api/v1/proposals/:id/accept`)
  only. Like every owner-only Gmail card (`OWNER_ONLY_PROPOSAL_TYPES`: monitor,
  digest, private check), it is never listed or decided by the Agent's
  `proposal.list_pending`/`proposal.decide` and never auto-accepted by an
  action grant; the apply service refuses it (hidden 404, nothing written)
  unless the person decides directly (`isPersonActingDirectly` →
  `ownerCardDecision`, `assertOwnerCardDecision`), and the monitor, digest and
  check appliers refuse without that flag too. The applier refuses
  anyone but the proposal owner (hidden 404; private visibility already hides
  it from others), requires the owner's active connection, sets `active_since`
  to the database time, creates the cursor row and queues a sync. With no
  other active monitor on the connection the cursor (re)starts at `baseline`.
  Decision authority is by identity: `gmail_monitor_create` is in
  `OWNER_ONLY_PROPOSAL_TYPES` (`ontology/entities.ts`), so the apply service
  names the proposal owner as its only decider (anyone else: hidden 404 on
  accept, reject and replay) and passes `private_owner_decision` to the
  `proposal.apply` gate, whose `proposal_apply_private_owner_allow` branch lets
  that owner decide as any active member (audit code `approved_private_owner`).
  The branch is reachable only for owner-only types, an active membership and
  no explicit `required_approver_role`; no other proposal or role changes.
- **Owner-only reads.** The content-access registry's `ownerOnlyPredicate`
  marks these proposals and the `gmail_monitor_matches` operational alerts as
  readable by their owner alone: `contentAccessSql` drops the space-shared,
  grant and Space-oversight branches for them, so generic proposal and activity
  lists, details, Home, decision candidates and every reader built on the
  content predicate hide them from Space owners and admins in any oversight
  mode. The Run that drafted such a proposal is owner-only too (the `run`
  declaration's predicate: a proposal of an owner-only type created by it), so
  its list entry, detail, trace, turn and turn stream, I/O and tool results
  deny oversight. Readers that bypass the predicate exclude them explicitly
  (`contentOwnerOnlySql`): the Home activity counts, the demotion-impact
  output list, internal activity evidence, capture filing (a match reminder
  is refused, 422). `ContentAccessService` lets only the owner manage an
  owner-only row and refuses any widening — visibility other than `private`
  or grants — with 409 `owner_only_content`. Chat action previews mark the
  draft card as decidable only by its owner: the turn read and turn stream
  show it only to that viewer (`actionPreviewsForViewer`; with no viewer only
  shared cards), and it is never snapshotted into shared messages.
- **Sync** (`syncGmailMailbox`, Job `gmail_mailbox_sync`, payload = connection
  id). Claim → fetch → settle, lock order person → owner + Space mutex →
  connection → cursor. Claim takes a 3 min lease only for an active owner,
  active connection and ≥ 1 active monitor (else records
  `gmail_authority_revoked | gmail_connection_inactive | gmail_reauth_required`
  and parks without any Google call, cursor kept). Fetch outside transactions
  through a Sources broker built from `gmailSyncRequestPolicy`: `history.list`
  (`historyTypes=messageAdded`, pages ≤ 5) or, for `baseline`/`recovering`,
  `users.getProfile` first and then one `messages.list q=after:<epoch>` page
  (40); then `messages.get format=metadata` (Subject/From/To) for ≤ 40 new
  messages, matched in memory and dropped. Every send rechecks person,
  connection, generation and lease. Quota: the account/owner groups plus a
  sync-only group (50/min, 1500/day). Settle (same locks, lease and generation
  unchanged): ledger insert `ON CONFLICT DO NOTHING` only for monitors still
  active *in the version the sync checked* (id + exact `active_since`; a pause
  and resume during the sync is a new version, so the old batch cannot remind
  about paused-period mail),
  match counts, one private content-free Inbox pointer per monitor
  (`OperationalAlertService`, kind `gmail_monitor_matches`, `project_id` NULL,
  payload monitor/connection ids and the new count), and the cursor (numeric,
  forward only) in one transaction — committed before any watch renewal. If any active monitor's id + version
  differs from the claim (accepted, or paused and resumed meanwhile), the
  cursor and record progress stay where they were and a follow-up reads the
  range again with the current versions. A sync that reaches the message
  bound stops at the last fully processed history record and requests a
  follow-up; when the bound falls inside one record (a record can hold more
  new mail than one sync reads), the record's messages are taken in sorted-id
  order, the position reached is persisted as in-record progress beside the
  unchanged cursor, and the follow-up resumes from it — the cursor passes the
  record only once all of it is checked; a failed retry keeps both and the
  ledger absorbs any overlap. Google
  404 for the cursor → `recovering` from the last success minus 10 min (never
  before the oldest active `active_since`, ≤ 7 days); a further page or older
  gap is `recovery_partial`. Failures keep the cursor and set the durable
  retry floor `retry_not_before` (exponential, or the quota/cooldown retry
  time if later) and put back the request mark their claim consumed — unless
  a reconnect superseded the sync (connection generation changed): then only
  its lease is dropped.
- **Retry floor.** Every wake-up honours `retry_not_before`: a push or monitor
  change before it only marks `sync_requested_at` and queues nothing; the
  heartbeat skips the row; a Job queued earlier finds the claim refusing
  (`waiting`, no Google call, mark kept). Once it passes, the heartbeat queues
  the pending request. A successful settle clears it.
- **Reconnect.** Reinstalling the same account on an existing row (inside the
  install transaction) clears authority error codes and their floor, keeps a
  Google rate-limit/quota floor, drops a lease still held by the old
  generation's sync, sets the next check to now and queues a sync when the
  connection has an active monitor; the cursor is kept. The superseded sync
  then can neither settle nor write its failure code or retry floor back.
- **Schedule and push.** The Sources heartbeat (`gmail_mailbox_sync_scheduler`)
  queues one Job per due cursor (`next_poll_at` passed or a request pending;
  never a second while one is pending/running). Next check: 15 min, or 6 h
  (never past the watch's expiry) while a `users.watch` is current and its
  last renewal did not fail. With `GMAIL_PUBSUB_*` configured the sync renews
  `users.watch` (fixed POST through the outbound guard, topic only) when under
  24 h remain or after a failed renewal once `watch_retry_at` passes; Rainver
  never calls `users.stop`. The renewal runs only after the increment is
  committed: that settle keeps (refreshes) the sync's lease, the renewal gets
  its own page deadline rather than what the increment left, and its outcome
  is settled in its own bounded transaction under that lease, which it then
  releases. Renewal outcomes are recorded on the watch fields only: a refusal,
  Google failure, uncertain send, quota wait, the renewal's own deadline or
  the single request's own 15 s deadline (`startGmailWatch` holds that signal
  and reports `timeout` whether or not the POST was dispatched, never
  `uncertain`) sets `watch_error_code` (`gmail_watch_refused|unavailable|uncertain|
  not_sent|quota_exhausted|timeout`), backs off `watch_retry_at` (at least
  Google's `Retry-After` on a 429, or a 503 that carries one, which also cools
  the account/owner/sync quota groups as the broker does for GETs), shows push
  as `inactive`. Loss of authority in the renewal's recheck (person,
  connection, generation, lease, token) is rethrown, never reported as a
  watch outcome: the already committed increment stays, the sync reports
  `failed` and the row records the authority code. `POST
  /api/v1/sources/gmail/push` (body ≤ 8 KiB) accepts only an RS256 OIDC token
  from Google's JWKS with the configured `aud`, verified service-account
  `email`, valid `exp`/`iat`, and the configured subscription; it uses only the
  notification's `emailAddress` to mark that mailbox's monitored connections
  and queue a sync — `historyId` is never trusted or stored. 401 on any
  authentication failure, 204 otherwise, 404 when push is not configured.
- **Push configuration: what is checked where.** Static configuration
  (`loadGmailPushConfig`, at start-up) can check only what the four strings
  say: all four `GMAIL_PUBSUB_*` set together with a `GMAIL_OAUTH_CLIENT_ID`;
  full Pub/Sub resource names; topic and subscription naming the *same*
  project id; the push audience is exactly this instance's push path (https
  outside local dev); the service account has a service-account address form.
  It cannot check which Google Cloud project the OAuth client belongs to (a
  client id carries a project *number*, not the id), that the topic exists,
  that `gmail-api-push@system.gserviceaccount.com` may publish to it, or that
  the subscription pushes to this audience as that account. Only a real
  `users.watch` success for a connected mailbox in that project — recorded as
  `watch_expires_at` with no `watch_error_code` — and a verified push arriving
  afterwards show the same-project setup works. That acceptance needs an
  authorized real Google project and mailbox; the repository's tests use a
  Google stub, and this batch did not perform it.
- **Owner surface.** `GET /api/v1/sources/gmail/monitors` (monitors, sync
  status, 50 recent match ids with Gmail links); `source.gmail.monitor.set_status`
  (resume restarts `active_since` at now, so mail received while paused never
  reminds) and `source.gmail.monitor.delete` (ledger cascades). Forget of the
  connection cascades monitors, cursor and ledger.
- **Nothing at rest.** No subject, sender, snippet or body is stored or
  logged; Job results carry status, counts and fixed codes only
  (`server/test/gmailMonitorSyncDb.test.ts` scans the tables).

### On-demand Agent reads (ADR 0032, ADR 0033 §6)

Decision: [ADR 0032](../decisions/0032-gmail-on-demand-agent-read.md) as
amended by [ADR 0033](../decisions/0033-gmail-project-consent-and-private-delivery.md)
(§1–4, §6), on [ADR 0030](../decisions/0030-plugin-agent-data-access.md)'s
sensitive-data path with the Project-bound exceptions below. Private digests and
owner-sent sharing are under "Private Gmail summaries".

- **Opt-in.** `source.gmail.connection.set_agent_read` (owner, `public_api`,
  person → mutex → connection `FOR UPDATE`) sets
  `gmail_connections.agent_read_enabled`; off by default, cleared by
  disconnect, shown and toggled on the Access page card. It reads nothing.
  Turning it off ends every Project consent on that connection.
- **Project-bound core tool** (`plugins/coreDataTools.ts`, `projectBound`).
  Gmail's tools keep ADR 0030's pin, scenario table, consent row, release
  gate, taint and Agent-read log, but (1) need no isolation proof: the Run
  keeps the conversation's own selected runtime — CLI, Host (built-in or
  paired), native CLI login or ModelProvider, model — and is never selected
  for the model-only channel (`runPinsSensitivePluginTool`,
  `runPinsCoreDataTool` and `pluginDataFacts` skip Project-bound pins); and
  (2) admit a shared audience (`pluginDataEligibility`: the owner's own
  `manual` turn, or a digest's `scheduled` Run), but only while every reader
  of the Run reads the consent's Project (`audienceWithinProject`, at call
  time and in the release gate). The Gmail credential never leaves the server:
  the runtime receives only the bounded result of the broker's read.
- **Offered** (`gmailAgentReadAvailability.ts`, snapshot and every call): an
  active Session of a Project that is the person's own private conversation
  or a Room conversation (a Room or the mainline;
  `GMAIL_PROJECT_CONVERSATION_SQL`), and an active opted-in connection of the
  person. A chat outside every Project, another person's private
  conversation, and delegated, scheduled or system turns are not offered it.
  A private Project chat that may read gets `private` Runs
  (`directTurnVisibility`); its own Conversation container already isolates
  host state per Session, so no Project shares host state with another.
- **Tool** `source.gmail.mail.read` (`gmailAgentReadOperation.ts`,
  operation-core query): `{query?, max_messages? ≤ 5, mailbox_email?}` →
  `{mailbox_email, source: recent_inbox|search, items[], truncated}`; each
  item is the message id, date, Subject/From/To/Cc/Date headers and plain-text
  body (32 KiB, `normalizeMessageBody`). No query lists `labelIds=INBOX`; a
  query is sent as Gmail `q` with `-in:drafts -in:chats -in:spam -in:trash`,
  and any listed message labelled DRAFT/CHAT/SPAM/TRASH is dropped. Requests:
  `gmailAgentReadContract.ts` allowlist (`messages.list` with exactly those
  parameters, `messages.get format=full`), no redirects, six sends, the
  existing broker, quota groups, token refresh and authority recheck per send
  (`pageTransport` in `gmailMailReads.ts`), plus a per-send check that the
  consent is active, the owner is an active person who still reads its
  Project, and the Run is still running. Ten released reads per Run → 429
  `gmail_agent_read_limit`.
- **Consent** (`gmailAgentReadGrants.ts`). The call first checks the
  conversation's audience against the Project (below), then picks its mailbox
  (several opted-in → 409 `gmail_agent_read_mailbox_ambiguous`, listing the
  addresses only when the owner alone reads the conversation; a Room or the
  mainline gets the code alone, as does `gmail_digest_mailbox_ambiguous`) and
  names it as the policy decision's resource. A Run that still carries a withdrawn
  private-read card's binding (`gmailPrivateReadBinding.ts`) is refused every
  call. Missing consent is `operation_consent_required`; the Agent calls
  `authorization.request` and the turn waits (`waiting_for_review`). The
  request freezes owner, the conversation's Project, that connection, its
  generation and the purpose (`authorization_requests.consent_*`, migration
  `0034_gmail_consent_binding_and_shape`). A core data tool's request exists
  only for the mailbox owner, in any conversation: listed
  (`GET /api/v1/runs/:id/authorization-requests`) and decidable by them alone;
  anyone else — other Room members, a Space owner with oversight — gets no row
  and a 404. The list projects each pending card for its owner
  (`consent_state`): `approvable` only while the Run waits for that request,
  the tool is offered in its conversation, the owner reads the frozen Project
  and the frozen connection is active, opted in and at the frozen generation;
  otherwise `ended`, or `superseded` for a card without a frozen binding.
  Approval rechecks each part live under the Project lock and writes exactly
  the frozen binding or nothing; the `authorization_request_reconcile` job
  then requeues **the same Run**, which continues the original request in the
  same conversation (no new conversation, message copy or navigation).
  Opt-out, disconnect, reconnect, re-authorization, forget, leaving the
  Project and account disable end a pending card in the same writer
  transaction (`policy/consentRequestLifecycle.ts`). Approval writes one
  `plugin_data_grants` row: `core:gmail`, scope `project`, read, sensitive,
  the conversation's Project, that connection and its generation, purpose
  `on_demand_read`, no expiry. Every later turn of the owner in any
  conversation of that Project reads under it without asking; another
  Project's conversation never matches (`liveGmailAgentReadConsents` requires
  the Run's Session and Project to be the consent's) and asks again; another
  person's Run never matches. It stops admitting when the connection is
  inactive, opted out or at another generation, and is ended (`revoked`) by
  the owner's revoke (Gmail card or Run panel), opt-out, disconnect,
  reconnect and re-authorization; removing the owner from the Project or
  disabling the account ends it in that writer's transaction. A conversation
  whose audience reaches beyond the consent's Project — or, with no consent
  yet, beyond the conversation's own Project, the owner included — refuses
  with 409 `gmail_agent_read_audience_outside_project` and is never offered a
  card (`pluginDataFacts`). The same audience rule is part of
  `gmailAgentReadConsentTarget`, so `authorization.request` writes no card for
  such a Run, a pending card stops being approvable (`consent_state: ended`)
  when a reader outside the Project joins, and confirming it then writes
  nothing (409).
- **Release gate** (audit transaction; the consent's Project `FOR SHARE` with
  the owner's member row → person → Run `FOR UPDATE` → Gmail mutex →
  connection → consent `FOR SHARE`): rechecks the owner's Project access,
  actor, that the owner is a reader and every reader reads the consent's
  Project, connection generation and opt-in, the conversation and the consent
  bound to that connection, then writes the Run's taint (`plugin_reads:
  core:gmail sensitive`: that Run's outward writes are refused — mail is
  untrusted input — and it materializes no artifact, proposal or activity),
  an `agent_data_read_logs` row (`gmail_message` ids) and a
  `gmail_read_audit_events` row (`agent_read`, Run, Agent and the consent's
  Project, count only). A failure withholds the result.
- **Output and later turns.** The reply is the conversation's: a Room or
  mainline reply is a Room message for its audience; a private Run of the
  owner's private conversation is owner-only for every oversight mode
  (`OWNER_ONLY_RUN_TOOLS` applies to `private` Runs only). The read does not
  mark the conversation `sensitive_conversation` (only a plugin's sensitive
  read does): later turns keep the conversation's runtime. Independently of
  that, every later Run of the conversation inherits the read's taint at
  creation (`runs/repository.ts`, `sensitiveConversationReads`), so the
  mail-derived history keeps its Project constraint on any Host: outward writes
  are refused, nothing is materialized, and `memory.remember` /
  `memory.revise` refuse outright (`hasProjectBoundRead`; Memory is recalled
  in other Projects). Session reflection still creates no Memory proposal for
  a conversation an Agent read mail in. Mail-derived content copied out of
  the conversation keeps the constraint: a Room reference from it is fenced as
  `external_untrusted` and carries `source_project_id` and `sensitive_reads`
  in its provenance, and the owner's shared excerpt (C) carries the same
  fields on its message; `sensitiveConversationReads` reads both back, so
  every later Run of the conversation they land in inherits the read with its
  real owner, and an incomplete answer is refused or inherited conservatively
  ([rooms.md](rooms.md) §Thread References). The owner's excerpt records its
  list with `sensitive_reads_version: 2` and is refused
  (409 `gmail_summary_share_foreign_data`) when its source Run holds anybody
  else's data, a read whose owner is unknown or cannot be proven (an entry
  from before owners were recorded, judged as for references), or malformed
  read metadata (`runSensitiveReads`, the same rule references, inheritance
  and reflection use). Shared text without the version predates it and
  cannot be verified: the conversation holding it is incomplete. The Run page's data panel labels a Project consent "Only in
  this Project (its private conversations, Rooms and mainline)". The
  call's arguments and result never enter the Run's event logs
  (`PRIVATE_TOOL_CALL_ACTIONS`).
- **Management.** The connection list carries `agent_read_grants` (Project,
  name while the owner reads it, created, last use); the Access page card
  lists them with a confirmed revoke (`plugin_data_grant.revoke`). A
  digest's consent (`core:gmail_digest`, purpose `daily_digest` /
  `rule_digest`) is listed and revoked through the same
  `plugin_data_grant.list` / `.revoke`: the grant DTO's `purpose` admits
  every purpose the `ck_plugin_data_grants_shape` check stores, and the
  revoke answers with the revoked consent. The digest then reads as ended
  (`gmail_digest_consent_ended`) and the scheduler's next due pass (daily
  slot or a monitor hit) persists `ended` without a Gmail call
  (`gmailRoomReadAcceptanceDb.test.ts`). The Settings consent panel
  (`PluginDataConsentPanel`) lists these core consents as Gmail / Gmail
  digest with their Project (named via `projectsApi.get` only when it
  returns `current_user_can_read: true`; a limited answer or a 404 shows
  the fallback) and purpose (on demand, daily, monitor hits); ordinary
  plugin consents keep their Space / scheduled-Run scope.
- **Withdrawn hand-off and private check** (ADR 0033 §6). The earlier
  `source.gmail.private_read.request` (a new private conversation) and
  `source.gmail.private_check.request` / `.get` (a Session-less isolated Run
  answering on an owner-only card) are removed: no system action, policy
  entry or conversation allowance names them. Their owner-only cards
  (`gmail_private_read`, `gmail_private_check`; `OWNER_ONLY_PROPOSAL_TYPES`)
  are history: the preview projection never offers one for a decision, the
  web card shows it without decision, link, answer or continuation, Proposal
  lists and details offer no Accept/Reject (`memory/acceptOutcome.ts`), and
  the appliers refuse acceptance (409, writes nothing;
  `gmailPrivateReadHandoff.ts`, `gmailPrivateCheck.ts`). Migrations
  `0038_gmail_private_checks` and `0039_gmail_private_check_withdrawn` closed
  pending cards (`superseded`) and ended unfinished checks (`failed`,
  `gmail_private_check_withdrawn`); delivered rows are kept but no route reads
  them. A Run a check started is refused before dispatch
  (`checkRunExecutionAuthorization`, Work Context rebind) and at launch
  (`sensitiveLaunchRefusal`). A model that still names either tool is reduced
  at the ACP boundary.
- **Web.** The in-conversation consent card (`ConversationRunControls.tsx`)
  shows the frozen mailbox and Project to its owner and states the scope
  (every conversation of that Project, answers visible to the conversation's
  readers). Owner-only Gmail cards (`source.gmail.*`) never show the generic
  "continue to next step" (`ActionPreviewCard.tsx`).
- **Limits.** Whether the Agent recognizes a Gmail need is the model's
  judgment. The conversation's CLI and its model provider process what the
  Agent reads; that is the owner's stated choice on the card, separate from
  Rainver's Project boundary.
- Tests: `server/test/gmailAgentReadDb.test.ts` (real PostgreSQL, stub
  Google: offering in private/Room conversations, consent freeze and
  approval, reuse, every ending, release gate, and the acceptance on a paired
  remote Host's `codex_cli` with its own login: newest five bodies, a
  `superlinear` search and its body, another Project refused, an audience
  outside the Project refused, revocation),
  `server/test/gmailRoomReadAcceptanceDb.test.ts` (Room message → queue →
  launch on the conversation's own runtime → consent card in place → the same
  Run requeued → reads → Room reply; owner-only card; reuse; revocation; and
  the generic claim-refusal regression; audience before mailbox choice and no
  mailbox list in a Room; a reference's second hop keeps the real owner),
  `sensitiveConversationReadsDb.test.ts` (multi-owner, long conversation, old
  references, incomplete answers, ordinary sharing),
  `gmailPrivateReadHandoffDb.test.ts`,
  `sensitiveRuntimeProfileDb.test.ts`, `GmailConnectionsCard.test.tsx`,
  `gmailPrivateReadCard.test.tsx`, `memory/__tests__/conversationCardOnly.test.ts`,
  built-app fixtures `gmail-sources.browser.mjs` and
  `conversation-layout.browser.mjs` (withdrawn card on a Room reply).


### Gmail summaries (digests)

In the owner’s own `manual` turn of an ordinary conversation of a Project — their
private Agent conversation, a Room or the mainline — `source.gmail.digest.propose`
creates an owner-only proposal (`payload.shared_conversation` for a Room). In a
Room or the mainline the owner must be a reader and every reader must read the
Project (`gmailDigestConversationAdmits`; otherwise
`gmail_digest_audience_outside_project`). The confirmation card, shown to and
decided by the owner alone, shows the mailbox, trigger, window and the
delivery conversation (a Room's digest is read by all its members). Daily digests run at the selected
local time and cover the interval from the previous covered boundary through
the scheduled slot. The catch-up bound is 24 hours or the duration of a longer
daily slot interval when local clocks roll back. After a missed slot the
scheduler can catch up through the current time and reports any earlier gap.
Their Gmail request uses only INBOX and server-set time bounds. Rule digests
take no schedule. The sync worker starts delivery after it commits new matches,
and the Sources heartbeat recovers pending deliveries. Rule reads are restricted
to the frozen matched IDs and deduplicate delivered items.

Confirmation writes a standing grant and the digest together. Runtime admission,
each Gmail send, model release and private reply delivery recheck authority.
Only the delivery’s automation-origin Run can read; it runs on the
conversation's own selected runtime (its CLI, Host and login; acceptance in
`gmailMonitorSyncDb.test.ts` on a paired Host's `codex_cli` with its own login).
In a private conversation it is an owner-only turn (`queueUnattendedPrivateTurn`);
in a Room or the mainline it is one scheduled Room turn of that same conversation
(`RoomService.queueUnattendedTurnInTransaction` → `AgentGroupRunService` with
`unattended`: one recipient, `automation` origin, only `source.gmail.digest.read`,
also across a Work Context rebind), and the reply is that conversation's Room
message (`chatTurnFinalizer.ts`). No conversation is created. Drafting,
confirmation, start, the Run's claim (`checkRunExecutionAuthorization` →
`gmailDigestRunAdmits`), every Gmail send, read release and settlement use one
audience rule, `gmailDigestConversationAdmits`. A private conversation's reader
is its owner, and the Run must be owner-only. In a Room or the mainline the
owner must read the conversation through its own gate (`roomAudience`: an
active roster row plus Project readability, or a mainline's Project readers);
the rule never adds them as a reader. A Room's or the mainline's
readers are its Project readers (`roomAudience`), every active
`room_user_members` row, and, once the Run exists, the Run's own audience
(`runAudience`). The roster rows count because removing someone from a Project
keeps their Room row, and a Room Run's grantees come from that roster. All of
them must read the Project (`audienceWithinProject`). A Room that does not
qualify records `gmail_digest_audience_outside_project`. At start nothing is
queued. At claim the Run fails before launch. Before a send the read stops
before contacting Google. In every case the delivery settles as failed with
that code, stores no reply, keeps the frozen daily window for the retry, and
the digest stays active with a visible retry. Gmail text is untrusted and the read is the Run’s only tool. The reply
and the delivery ledger are committed together only after all pages release in
order and the Run succeeds. Partial replies are withheld. Daily retries restart
the same frozen window and preserve the coverage boundary. A window that exceeds
the Run’s read cap pauses immediately with a visible failure. Other delivery
failures pause after three consecutive failures. Explicit resume resets coverage
to the time of resume. The next daily window starts no earlier than that time
and never reuses the earlier failed window. Rule summaries include only hits
recorded at or after resume. Earlier failed delivery records remain available
as history.
Sources → Access and Gmail lists the same mailbox’s
on-demand consents and digests, including the next scheduled run, last delivery
and retry state, with pause and resume (`source.gmail.digest.set_status`) and
revoke (`source.gmail.digest.end`, which ends the digest and revokes its
consent). Daily summary time can be edited
in the existing time zone without renewed consent using the owner-only
`source.gmail.digest.set_time` action. Ending or pausing a digest invalidates
its in-flight delivery, including a fully read delivery awaiting settlement. Migration
`0037_gmail_match_triggered_digests` ends any previously scheduled rule digests and expires their pending drafts. Immediate delivery needs fresh consent.

**Upgrade (scope reconfirmation in migration `0020_gmail_integration`).** Consents and
cards given under the earlier private, isolated scope are not widened: active
Gmail consents are revoked, pending consent cards expire (their Runs cancelled
by the reconcile job), pending digest cards are superseded, unfinished
deliveries fail, and live digests pause with `gmail_digest_reconfirm_required`
while keeping their schedule, conversation and history. Such a digest cannot be
resumed or retimed (409) and is listed as paused, not ended; a new card accepted
in its conversation reactivates the same digest in place with the new consent
(coverage from the confirmation). Another conversation cannot take it over:
drafting there is refused with `gmail_digest_reconfirm_elsewhere`, and a card
from there conflicts (409) without ending the paused digest or its history.
Only a digest carrying that code is protected: an ordinarily paused digest
(`last_error_code` NULL) whose consent has ended is closed when a new card of
the same mailbox, Project and kind is accepted. Tests: `gmailMonitorSyncDb.test.ts` (upgrade
and re-confirmation), `gmailRoomReadAcceptanceDb.test.ts` (mainline digest from
draft to scheduled Room reply, and the later turn's refused Memory and Task;
daily and monitor-hit digests in a mainline and a limited Room; a member removed
from the Project but left on the roster refused at start, claim and before a
send; ordinary roster removal, where a removed member no longer counts and an
owner removed from the Room is refused at start and claim; an ordinarily paused
digest whose consent ended replaced by a new card; a Work Context rebind keeping only the digest read; 0040 with a pending
consent card and an in-flight Room delivery, and re-confirmation in the original
versus another conversation),
`GmailConnectionsCard.test.tsx`.

From a private Gmail reply the
owner can edit an excerpt, select a conversation in the same Project (including
its mainline when available) and post it under their own name. The user-only
`source.gmail.summary.preview` query returns the effective readers of the
selected destination and an audience version. The Project mainline includes
all Project readers. The share action requires that version, rechecks the
current audience within the posting transaction, and records provenance.
If the audience changed, the owner reviews the refreshed list and clicks Post
again. Sharing starts no Agent work.
