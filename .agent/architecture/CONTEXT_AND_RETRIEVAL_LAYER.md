# Context & Retrieval Layer

Status: implemented (current through 2026-07-06). This is a current-state
architecture doc. Follow-up quality work and risk watch items live in
[`ROADMAP_AND_FUTURE_RISKS.md`](ROADMAP_AND_FUTURE_RISKS.md).

Rainver's knowledge retrieval is a deterministic recall **substrate** plus a
**context layer** layered on top: hybrid recall,
multi-hop graph recall, intent-aware ranking, a synthesized + cited Context Brief
with gap analysis, read-only maintenance scans, explicit artifact-backed context
attachments, egress governance, Context Ops read models, and a governed agent tool
surface. These are rainver-native mechanics, and the Rainver DB stays
authoritative.

Per-module current-state lives in `.agent/modules/knowledge-base.md` and
`.agent/modules/memory.md`; the code is the source of truth.

## Capability status

| Capability | State |
|---|---|
| Projection tables + engine ⊀ domain-adapter boundary | solid |
| Recall: exact/alias/lexical/graph/relational/vector, max-pool, RRF, evidence, create-safety | solid |
| Access revalidation / memory gating / project-summary gating | strongest area |
| Eval harness (recall@k + MRR/nDCG/NamedThing/relational/staleness/per-mode/leak-fuzz) | solid eval/report substrate; aggregate-only eval reports can persist as owner-private `retrieval_eval_report` artifacts; manual brief diagnostics can generate aggregate eval reports from saved owner-private Context Brief gap metadata; Artifacts UI can trigger/render diagnostics and record evidence-backed `retrieval_calibration_decision` artifacts for per-mechanic adopt/defer/reject decisions; the `retrieval.space.settings` scoped setting's `ranking_config` can ship gated mechanics only when the referenced `space_shared` calibration artifact passes the configured aggregate eval/evidence gate |
| Vector + ANN (halfvec HNSW at default dim) + intent ranking | solid; access-neutral ranking calibrated with floor-ratio gating + deterministic post-RRF cosine blend + runtime-gated visible-edge backlink / candidate-owned salience / richer dedup / autocut mechanics + aggregate boost-attribution/score-bucket/drop telemetry; true BM25 / non-default-dim ANN deferred |
| Reranker + query rewriter (gated, skippable, audited) | solid; rerank payload bounded by a token (char-proxy) budget |
| Context Brief: synthesis + citations + two-tier gap analysis | solid; selected Knowledge, Memory, Project, and Sources briefs can persist as owner-private `retrieval_brief` artifacts through separate routes; gap findings are advisory artifact metadata, not a proposal channel |
| Ask Space (unified entry point) | core product slice; `POST /api/v1/ask-space/think` (`modules/askSpace`) runs the per-domain Context Brief pipeline across Knowledge (default) + opt-in Memory/Project/Sources/Inquiry through `RetrievalSearchService`, reusing each domain's own read gate and Memory access logging; returns per-domain cited answers, optional opt-in cross-domain `combined_answer`, aggregate gap summary, domain-tagged provenance, and proposal-first follow-up descriptors (Claim Candidate Packet / maintenance scan, surfaced only with Context Ops scan authority); combined synthesis reuses `ProviderSynthesizer` and the same external-egress/source-policy gate over the union of included sources, and Memory is excluded from the combined prompt unless `combine_include_memory` is explicitly set; optionally persists per-domain `retrieval_brief` artifacts plus an owner-private `ask_space_session` artifact; creates no Memory proposals and performs no canonical writes; web `Ask Space` page + `ask_space_session` renderer |
| Personal aggregated retrieval | `POST /api/v1/me/retrieval/search` fans the explicit retrieval object-type list across every active member Space, running and live-revalidating each Space independently. Results persist only as source-Space pointers; `/me/retrieval/pointers/resolve` re-authorizes. Single-source summaries land owner-private in their source Space. Multi-Space conclusions require disclosure followed by explicit Personal-Space storage, full pointer lineage, and pointer-only per-source egress records. |
| Claim Candidate Packet | solid backend/product slice; `POST /api/v1/knowledge/claims/candidate-packets` plus the web API client and artifact renderer is the explicit bridge from selected retrieval brief / retrieval maintenance / diagnostics / Memory maintenance artifacts into `claim_candidate_packet` artifacts and proposals; brief uncited-claim candidates include deterministic holder/perspective, validity/observation, and governed source-ref hints when available; accepting the packet creates valid child pending claim/claim-relation/object-relation proposals only and records skipped invalid children; `space_ops` packets default to `space_shared` source artifacts and require explicit `promote_private_sources_to_space_ops` opt-in plus `private_source_promotion_confirmed = true` to include the caller's private source artifacts |
| Maintenance scan (duplicate/orphan/thin/stale/relation, read-only) | solid; manual route plus Context Review Cycle route/Automation target produces report artifacts and optional packet proposals |
| Egress governance (per-space external-egress switch) | solid; backend + Space Settings UI implemented; external/local/internal destination vocabulary implemented; DB-backed chat candidates use the conservative external-provider egress gate until chat provider routing is passed into the collector |
| Source / connector consent | implemented across the retrieval read plane; source connections normalize versioned consent/policy JSON and enforce connected retention/proposal-target checks; the reader/agent/admin read gate + source-egress gate are consumed by search, Context Brief, graph/relational traversal, managed-run tools, rerank/synthesis/embedding egress, maintenance scans, relation discovery, Context Ops drill-down, claim evidence rendering, non-creator artifact attachment, and DB-backed chat candidates with explicit source ids; the connector→projection linkage is covered by a real-DB test; connector refresh/purge edge cases and future chat artifact/evidence-pack attachments remain deferred |
| Agent retrieval tool surface (viewer-scoped, audited) | solid; opt-in managed `model_api` / `ts_agent_host` tool loop for Knowledge `retrieval.search` / `retrieval.brief`; explicit Memory, Project public-summary, and Sources domain tools; manual and preflight modes; runtime-host tool calling supports OpenAI-compatible and Anthropic providers; Agent UI exposes the Memory/Project/Sources opt-in |
| Runtime Context acquisition | retrieval results remain access-safe candidates; managed/CLI invocations acquire them only through Runtime Context typed acquisition, deterministic planning, live Delivery authorization, and safe Invocation Snapshot audit. There is no manual artifact-attachment bypass or `/context/build` surface |
| Context Ops read model + Context Health page | operator console; `GET /api/v1/context-ops/summary` and the web `Context Health` page aggregate whole-space index/embedding/source health plus the current operator's private maintenance, diagnostics, explain, brief, feedback, and Memory provenance loop; `GET /api/v1/context-ops/drilldown` turns the index-freshness, embedding-backlog, source-warning, maintenance-report, diagnostics-report, explain-report, and recent-brief aggregates into bounded, access-safe detail lists/summaries (object lists pass the same adapter read gate **and** source read policy as search; source-warning details are owner-scoped unless owner/admin; artifact sections reuse owner-scoped/`space_ops`-gated summary queries); the page also exposes maintenance-scan, diagnostics-report, targeted explain, explain preset/comparison, Context Review Cycle scan triggers, and artifact-level or batched Claim Candidate Packet actions for supported recent briefs/reports (with optional packet creation and a Memory maintenance toggle) gated by `context_ops_scan_mode`; `POST /api/v1/context-ops/review-cycle/run` and Automation target `context_ops_review_cycle` run the broader read-only/proposal-first cycle and return `degraded`/`warnings` when optional packet stages fail after reports are saved; the `retrieval.space.settings` scoped setting's `context_ops_review_mode` can additionally expose shared `space_ops` reports/packets to owners/admins or all members without weakening private packet creator-only review |
| Context observation reports | implemented lightweight Context Ops entry; `POST /api/v1/context-ops/context-observations/scan` summarizes the current Context Ops window into red/yellow/green observations, daily observation text, periodic distillation suggestions via `suggested_target`, and source refs; it can persist a private `context_observation_report` artifact with `canonical_format = context_observation_report.v1`; response and artifact payload always include `canonical_write_performed = false` and do not write Memory, Knowledge, Capability, or Assistant preference rows |
| Object Schema Registry / object schema | implemented core runtime slices; fixed `object_type` plus governed per-space `object_profile`, active-profile retrieval filters/metadata, Space Settings registry UI, field-schema proposal validation, relation hints, object-schema export/import, and deterministic Context Ops schema suggestions |

## Invariants (load-bearing — do not relax)

1. **Rainver DB is authoritative.** Retrieval tables are derived projections,
   rebuildable from canonical Knowledge/Memory/Project/Sources tables. No external retrieval runtime,
   dependency, or system of record.
2. **Single live read gate.** `revalidate` runs on every candidate *before* any
   reranker, synthesizer, or other LLM stage sees its content. LLM stages only
   ever score/read the already-visible set.
3. **Access-safe signals.** Ranking, graph, salience, and gap signals are computed
   only from data the viewer can read, or from access-neutral metadata. A signal
   derived from objects the viewer cannot read (e.g. backlink counts over private
   rows) leaks their existence and is forbidden.
4. **Every hop revalidates.** Multi-hop / typed-edge / relational recall
   revalidates each surfaced object and respects `project_members` and the
   `restricted` owner-only tier. Graph expansion starts only from visible seeds.
5. **Cross-space stays fail-closed.** Nothing widens the current-space-only scope.
6. **Canonical writes stay proposal-gated.** Derived index writes may be
   automatic; accepted `ObjectRelation` and Memory create/update/archive
   stay on the proposal/approval flow. Maintenance emits *batched review
   candidates*, never one proposal per finding, never silent canonical writes.
7. **Provider calls use the ADR 0008 channel.** Embeddings, rerank, rewrite, and
   synthesis route through `provider_task_policies` + the credential channel, and
   record pointer-only `policy_decision_records` audit (task, model, counts,
   surface — never content).
8. **Vendor files / CLIs are adapters, not source of truth.** The agent-facing
   retrieval tool surface is rainver-controlled; external tools never become
   the context system of record.

## Context Observation Reports

`POST /api/v1/context-ops/context-observations/scan` is the lightweight Context
Configuration entry into Context Ops. It reuses the access-safe Context Ops summary,
then produces a `context_observation_report.v1` shape:

- red/yellow/green observation items
- aggregate counts
- source refs to summary sections or recent context-brief artifacts
- `suggested_target` hints (`memory`, `knowledge`, `capability`,
  `assistant_preference`, or `review_only`)
- `access_safety` with `aggregate_or_review_refs_only = true`,
  `raw_private_content_included = false`, and
  `canonical_write_performed = false`

When `persist_report=true`, the scan writes one private
`context_observation_report` artifact. It never writes active Memory,
Knowledge, Capability, Assistant preference, or Proposal rows. Any future
promotion from observation to Memory/Knowledge/Capability/Preference must go
through the existing proposal/review packet boundaries.

## Engine & domain adapters

A generic engine (`server/src/modules/retrieval/`) owns the derived projection
tables (`retrieval_objects` / `_aliases` / `_chunks` / `_edges`) and all
domain-agnostic mechanics (arms, fusion, ranking, evidence, create-safety,
embeddings, rerank/rewrite/synthesis seams, maintenance). Per-domain adapters own
canonical loading, edge projection, and the single `revalidate` read gate:
Knowledge (`knowledge_item` / `note` / `source` / `claim`), Memory
(`memory_entry`), Projects (`project_public_summary`), and Sources
(`source_item` / `extracted_evidence`). Sources projections index titles,
excerpts, source metadata, preset metadata, and evidence excerpts; raw snapshots
and full extracted reader text are not indexed by default. The boundary is
strict — domains depend on the engine, never the reverse (`BOUNDARIES.md`
B33/B34). Projections carry
`source_updated_at` (the canonical object's last-edit time, distinct from the
projection's own reindex time) so freshness signals are real.

Source post-processing can use retrieval context as optional judging
background before LLM screening. Project, Knowledge, Memory, and Sources context
domains are explicit rule options; Project context requires a `project_id`.
The separate candidate prefilter ranks only the current input batch before
prompt assembly, so older global matches cannot crowd out newly materialized
items. This does not change retrieval's source of truth and does not embed raw
snapshots/full reader text. Optional deep-analysis follow-up remains an Sources
orchestration step: extract full text for selected candidates, then run a
second-stage post-processing pass over those candidate items only.

## Recall

- **Arms.** exact / alias / slug / URL; lexical (`ts_rank_cd` with a BM25-style
  length-normalization flag); **multi-hop typed-edge graph** (bounded BFS to
  `GRAPH_MAX_HOPS`, seeded from every *visible* direct match — exact + lexical +
  vector — revalidating every hop, with hop-decayed confidence; a non-visible
  intermediate node blocks the path); a small **relational intent** arm for
  "related/connected/sources/projects for X" query shapes (deterministic parser,
  visible seed resolution, typed-edge traversal, target filtering, and a
  direct-target fallback for single-type registries such as Project public
  summaries; aggregate-only trace); and a **vector** arm over pgvector.
- **Per-arm max-pool → RRF.** Each arm collapses to one best entry per object
  *before* fusion (so chunk count can't inflate an object), then arms are fused
  with cross-arm RRF (multi-arm agreement still rewarded). The SQL arms pick the
  best hit per object before the fetch window so one chunk-heavy object can't
  exhaust the candidate pool; the vector arm keeps its ANN window then dedupes.
- **Access-neutral ranking signals** apply after fusion and after live
  revalidation/source-policy filtering has produced the visible candidate set:
  source-tier, relation-type weighting for graph/relational candidates,
  name/title-phrase match, recency (half-life decay over the candidate's own
  canonical `source_updated_at`), and a small deterministic post-RRF **cosine
  blend** that nudges a candidate by its OWN best-chunk query/chunk similarity
  (carried separately from evidence so fusion can't drop it). Metadata boosts
  are floor-gated two ways: an absolute fused-score floor AND a **floor-ratio**
  gate (the candidate must reach a fraction of the visible set's top fused
  score, so the floor adapts to result-set scale). Both gates read only
  candidate-owned scores or the revalidated/source-policy-allowed visible-set
  top score — never a hidden object — so a weak candidate cannot win on metadata
  alone. Each signal reads only the candidate's own metadata/evidence (invariant
  3); relation weights are explained through matched-field tags such as
  `relation_weight:supports`, and the aggregate-safe `trace.boost_attribution` /
  `trace.score_buckets` record how often each axis fired and the visible-set
  score distribution (counts only, no ids/titles).
- **Deterministic intent** (`retrieval/intent.ts`) classifies the query string
  into entity / temporal / event / general and selects ranking knobs only — it
  never changes which rows are eligible. The separate relational parser
  (`retrieval/relationalIntent.ts`) only turns high-confidence relation-shaped
  queries into an additional bounded arm. That arm is part of the lexical tier:
  `mode: "exact"` stays exact alias/identity matching only, and unsupported
  relation wording falls back to ordinary recall.
- **ANN.** Baseline is exact pgvector scan; at the default embedding dimension
  (2560) `0001` ships `ix_retrieval_chunks_embedding_hnsw_2560`, a partial HNSW
  index over `embedding::halfvec(2560)`, and the vector arm emits a matching
  constant-dimension halfvec query for dims in `ANN_HALFVEC_DIMENSIONS` (kept in
  sync with the migration); other dims keep the exact scan.
- **Adaptive return** (opt-in, `SearchInput.adaptiveReturn`, default off) trims the
  visible tail at a sharp score cliff so a precise answer is not padded with weak
  results. Trim-only — it never grows the set, reads only the visible candidates'
  own scores, and records `trace.adaptive_return`.

## LLM stages (gated, skippable, audited)

All run only over the already-revalidated visible set (invariant 2), route through
ADR 0008 task policies, degrade to deterministic behavior on any failure, and
write pointer-only audit.

- **Reranker** — post-fusion relevance judge over the visible top-N; space-setting
  gated; native rerank endpoint with a chat-prompt fallback. The payload is bounded
  by a **token (char-proxy) budget** — per-candidate text is truncated and the
  running total is capped — so a few long revalidated texts cannot blow the
  payload; `trace.rerank.moved` / `.truncated` record the aggregate outcome.
- **Query rewriter** — pre-recall, query-string-only. Rewrite results are returned
  in a **separate** `rewrite_items` list, never blended into or co-ranked with the
  primary (original-query) list, so the primary list is never biased by how many
  synonym variants matched.
- **Context Brief** (`retrieval/synthesis.ts` + `modules/retrieval/synthesisProvider`,
  routes `POST /api/v1/knowledge/retrieval/brief`,
  `POST /api/v1/memory/retrieval/brief`, and
  `POST /api/v1/projects/retrieval/brief`, and
  `POST /api/v1/sources/retrieval/brief`) — `buildBrief` reuses the same
  `collectRankedVisible` pipeline as search (so the read gate is never
  duplicated), then synthesizes a cited answer. The synthesis prompt is bounded by
  a per-source AND total document-text **token budget** (later sources keep their
  title so their citation index stays valid), bounding the payload in tokens, not
  just row count. Citations resolve only to surfaced
  sources (invented indices dropped). Gap analysis is two-tier: deterministic
  access-neutral signals (stale via canonical timestamp / thin / low-coverage) plus
  LLM signals (uncited claims, contradictions, missing topics). It self-gates on a
  configured `retrieval_synthesis` task policy — with none, the brief degrades to a
  deterministic-only brief. Callers can opt into durable evidence with
  `persist_artifact: true`, which best-effort writes a `retrieval_brief` artifact
  containing the query, refs, citations, gap analysis, and settings/egress
  snapshot. Knowledge artifacts also keep the request trace summary; Memory and
  Project artifacts omit trace and never copy item snippets/raw content into the
  artifact payload. These artifacts are `visibility = private` with
  `owner_user_id = viewerUserId`, because answers, titles, and citations can
  derive from that viewer's private/restricted readable scope. Gap findings are
  advisory output, never proposal creation and never canonical writes (invariant
  6); briefs are not auto-injected into runtime context. The only current path
  from brief-side uncited claims/contradictions/missing topics into reviewable
  claim work is an explicit Claim Candidate Packet created from selected
  artifacts; accepting that packet creates child pending proposals, not canonical
  claim rows. Memory and Project brief routes stay separate and are scoped to
  `memory_entry` and `project_public_summary` respectively.

## Runtime Context boundary

Retrieval owns candidate discovery, ranking, citations, and its domain read
gates. It does not own invocation assembly. Runtime Context may request bounded
retrieval candidates through `RetrievalCoordinator`, but it reauthorizes them
for the instructing user and exact work scope before an accepted Delivery is
persisted. The planner alone decides precedence, deduplication, and window
budgeting. Adapters never call retrieval directly.

The retired `/context/build` route, Context Preview page, manual artifact picker,
artifact revocation table, Context Snapshot evidence packs, and route-owned chat
candidate bundle have been deleted. Retrieval artifacts remain reviewable
product outputs and proposal inputs; their existence does not make them
model-visible. Any future product flow that promotes an artifact into an
invocation must enter as a typed owning-domain acquisition with the same live
read, source-policy, egress, and Delivery authorization gates.

## Maintenance scan (read-only "context review cycle")

`retrieval/maintenance.ts` (`RetrievalMaintenanceService.scan`, route
`POST /api/v1/knowledge/retrieval/maintenance/scan`, owner/admin) is a READ-ONLY
scan over the projection emitting one batched, clustered report: **duplicates**
(by shared normalized name), **orphans** (no edges), **thin** pages, **stale**
objects (canonical content older than `staleAfterDays`, keyed off
`source_updated_at`), and **relation suggestions** (suggested edges). Every
referenced object passes the same `revalidate` gate as search **and** the same
source-connection read gate (`sourcePolicyAllowsRead` over the projection's
`source_connection_ids`), so a finding never exposes an object/title the operator
cannot read or whose source connection restricts them — even when the operator is
an owner/admin who is not an allowed source reader; per-kind capped with a
`truncated` flag. It writes nothing canonical (invariant 6) — acting on a finding
stays on the proposal/approval flow.

The route remains one-off by default. Callers can pass `persist_report: true` to
write an owner-private `retrieval_maintenance_report` artifact, or
`create_packet: true` to also create one private
`retrieval_maintenance_packet` proposal pointing at that report. Accepting the
packet is creator-owned: the private packet creator must accept it, and a space
admin cannot review another user's private packet through the current applier.
It does not mutate Knowledge directly; it marks the packet accepted and creates
child pending `object_relation_create` proposals for supported
relation-suggestion findings. Duplicate/orphan/thin/stale findings stay
review-only until a user turns them into explicit Knowledge proposals.

The same scan can run as a scheduled or manually fired Automation with
`config_json.target_type = "knowledge_retrieval_maintenance"`. This uses the
existing Automations service rather than a separate scheduler: each fire creates
a durable system Run plus `automation_runs` row, executes the read-only
maintenance scan as the owner/admin actor, persists the private report artifact,
and optionally creates the same private packet proposal when
`config_json.create_packet = true`. The selected Agent is used only for Run
attribution and must exist, be active, and have a current version; the maintenance
path does not run the agent runtime or use model credentials. Scheduled failures
mark the Run failed and advance the schedule once; they do not retry silently
forever or write canonical Knowledge. If a process crashes after creating the
running system Run, the Run participates in the existing stale-running recovery
path (`PgRunRepository.recoverStaleRuns`) on worker startup; the maintenance loop
is not a fully resumable job.

## Candidate-relation discovery

`server/src/modules/knowledge/relationDiscovery.ts`
(`runRelationDiscoveryScan`, route `POST /api/v1/knowledge/relations/discovery-scan`,
Context Ops scan-gated) is the proposal-gated graph review path. It reads
viewer-visible Knowledge item / Note text plus visible Activity
and inline Artifact text. Source-connected Knowledge and Artifact rows also pass
the source read gate; missing or denied source-policy snapshots fail closed.
Activity records currently have no canonical source-connection field, so they
are gated by Activity visibility until that source-linkage model exists. The
deterministic pass extracts wikilinks plus typed hints such as
`[[relation::Target]]`, `[[relation: Target]]`, `[[Target#relation]]`, and
`link_type -> [[Target]]`, then resolves each target against
viewer-visible Knowledge items (exact title/slug = high tier, alias = medium;
unresolved targets only become an opt-in low-tier `knowledge_create` stub).
Source rows and resolution targets are visibility-gated, so discovery can
neither read hidden text nor wire to a hidden object, and an unresolved/hidden
target leaks nothing.

It writes nothing canonical. A scan persists one batched, confidence-tiered
owner-private (or `space_ops`) `relation_discovery_report` artifact plus a
`relation_discovery_packet` proposal (`relationDiscoveryArtifacts.ts`, registered
in the policy action registry + gateway risk map at `medium`). Accepting the
packet is creator-owned (same Context Ops packet rule) and only creates child
pending `object_relation_create` / `knowledge_create`
proposals — never a direct edge or item write (invariants 6, 9). A note source
and a Knowledge item source both propose FK-backed `object_relation` edges over
`space_objects`. Activity and Artifact anchors emit `relation_review_candidate` rows with
no child write action because they are evidence surfaces, not governed graph
endpoints. Optional LLM extraction is request-gated and injectable; without a
provider adapter the public HTTP route rejects `llm_extraction_enabled=true`
with 422 rather than producing a misleading empty LLM pass. The service hook
remains injectable for tests and future ADR 0008 provider wiring. Any enabled
extractor receives only the already-visible/source-policy-allowed source set
plus source-policy snapshots and returns review-packet candidates, not canonical
writes. Scan responses and packets distinguish `candidate_count` from
`proposal_candidate_count` / `review_only_candidate_count`; accepting the packet
records review-only candidates as skipped with `reason=review_only_candidate`
because they intentionally do not create child proposals.

The claim-side analogue (advisory claim trajectory + a deterministic
contradiction-discovery scan that reuses the Claim Candidate Packet flow) is
documented in [`CLAIM_FACT_ATOM_MODEL.md`](CLAIM_FACT_ATOM_MODEL.md).

## Eval / explain artifacts

The eval and bench harnesses still run in tests, but their aggregate outputs can
now be persisted through `POST /api/v1/knowledge/retrieval/eval/report`
(owner/admin only). The protocol accepts only aggregate metrics, counts, case
labels, diagnostic codes, and aggregate rank attribution; it rejects candidate
ids, titles, snippets, and arbitrary content fields. Persisted reports are
owner-private `retrieval_eval_report` artifacts rendered by the Artifacts UI.
This gives operators a durable retrieval-quality review surface without widening
runtime traces beyond aggregate, access-safe data.

Search-quality calibration decisions persist through
`POST /api/v1/knowledge/retrieval/eval/calibration-decisions`. The route is
gated by Context Ops scan access and writes a `retrieval_calibration_decision`
artifact, private by default or `space_shared` only for explicit allowed
`review_scope = space_ops`. Each decision records one mechanic
(`visible_edge_backlink`, `candidate_owned_salience`, `richer_dedup`,
`autocut`, or `semantic_results_cache`), `adopt|defer|reject`, required
access-safety proof, aggregate eval deltas, optional guardrails/rationale, and
refs to visible evidence artifacts (`retrieval_eval_report`,
`retrieval_explain_report`, `retrieval_maintenance_report`,
`memory_maintenance_report`, or `retrieval_brief`). `adopt` decisions require a
non-empty eval delta and at least one visible evidence artifact ref. Private
calibration decisions may cite the current
operator's private evidence artifacts; `space_ops` calibration decisions may
cite only `space_shared` evidence artifacts, so the shared calibration artifact
does not expose private artifact existence or ids. The persisted artifact is
evidence-ref-only: no raw content, snippets, hidden ids, private backlink
counts, or dropped candidate ids are stored, and
`ranking_behavior_changed = false`. It records decision/runtime summary metadata
(`adopt` decisions become `runtime_state = adopted`, but `shipped = false`).
Shipping is controlled separately by the Space Retrieval Settings runtime gate.
The protocol rejects adopting a cross-viewer semantic results cache; only the
existing query-embedding cache is allowed.

Live ranking mechanics are configured through the `ranking_config` field in the
`retrieval.space.settings` scoped setting. For each runtime mechanic, operators
can leave it `disabled`, mark it `adopted`, or request `shipped` with a
calibration artifact id. Because this is a space-wide runtime setting whose
resolved config is visible through Space settings, `adopted`/`shipped` mechanics
must reference a `space_shared` `retrieval_calibration_decision` artifact, not an
operator-private calibration artifact. `shipped` is accepted only when the server
can load a `space_shared` calibration artifact for the same mechanic, with an
`adopt` decision, enough visible evidence refs for
`required_evidence_artifacts`, and a primary aggregate `eval_delta` that meets
`min_primary_metric_delta`. The server writes the per-mechanic eval gate result
back into the resolved settings response. `semantic_results_cache` is forced
disabled and failed by policy. Shipped mechanics are applied only after the
visible candidate set is collected and revalidated: candidate-owned salience can
boost from the candidate's own evidence/confidence/matched fields/vector
similarity; visible-edge backlink can boost from edges whose endpoints are both
already visible candidate refs; richer dedup drops lower-ranked visible
same-title duplicates by object type; autocut enables adaptive return by
default. Traces stay aggregate-safe: boosts, drop reasons, and score buckets are
counts/labels only, not hidden ids or private titles.

Owner/admin operators can also trigger
`POST /api/v1/knowledge/retrieval/eval/diagnostics/report` to generate an
aggregate trend report from recent owner-private `retrieval_brief`,
`retrieval_maintenance_report`, and `retrieval_eval_report` artifact metadata.
The diagnostic builder persists only counts, rates, case labels, diagnostic
codes, surface/object-type counts, matched-field counts, score buckets,
maintenance finding totals, eval metric averages, and current-vs-previous-window
aggregate deltas. It counts low coverage, stale/thin cited refs, uncited claims,
contradictions, missing topics, maintenance finding kinds, and aggregate eval
signals without persisting the original query, candidate ids, titles, snippets,
claim text, contradiction text, or maintenance finding object details. The
resulting report is owner-private and carries
`retention_policy.class = "aggregate_private_artifact"`. Callers can request a
private `retrieval_diagnostics_packet` proposal that points at the report;
accepting that packet is creator-owned, records review acknowledgement only, and
does not write canonical Knowledge or Memory. Self-generated
`suite = "retrieval_quality_feedback_loop"` diagnostics reports are excluded
from subsequent diagnostics aggregation so repeated operator runs do not create
a feedback meta-loop. Trend diagnostic codes are emitted only when the current
and previous windows have enough samples; otherwise the report records
`insufficient_trend_sample`. Memory, Project, and managed-run brief artifacts
are included only when they use the same `retrieval_brief` artifact type and
owner. Stale/thin counts are occurrence totals across briefs, not distinct
object counts. `rank_attribution.evidence_kind_counts` remains empty for this
generated report because brief artifact refs do not persist evidence kind. The
retention field is metadata, not a TTL or cleanup job.

Owner/admin operators can diagnose a specific visible Knowledge retrieval target
with `POST /api/v1/knowledge/retrieval/explain`. The endpoint first requires the
target to exist in the Knowledge retrieval projection and pass the same live
revalidation/source-policy gates as search. It then reports whether the target
appeared in the visible result window, matched fields, evidence kind/source,
score bucket, relation/vector/rerank aggregate signals, and aggregate arm/drop
counts. Optional `retrieval_explain_report` artifacts are owner-private and
store query hash/length instead of raw query text. They include the live
revalidated visible target title for owner/admin operators, but do not store
snippets, raw content, dropped candidate ids, hidden object counts, or private
backlink counts.

The Artifacts UI exposes the manual diagnostics trigger, can request an
owner-private diagnostics packet with `create_packet: true`, shows trend deltas
separately from ordinary metrics/counts, and renders `retrieval_eval_report`,
`retrieval_brief`, `retrieval_maintenance_report`, and
`retrieval_explain_report` artifacts with structured, aggregate-safe views. The
same page has an owner/admin operator entry point for targeted explain reports
and a calibration-decision entry point for saving access-safety-backed
adopt/defer/reject decisions;
Knowledge Home exposes a domain-labeled Context Brief panel for Knowledge,
Memory, and Project public summaries; saving a brief still uses the separate
backend routes above and persists owner-private artifacts.

`GET /api/v1/context-ops/summary` is the current Context Ops read model. It returns
aggregate, UI-facing health data for the active Space plus review-loop state.
Space-level sections are index freshness, embedding backlog, and source
consent/policy warning counts. Private sections remain scoped to the current
operator: maintenance report finding counts/private packets, diagnostics report
counts/trend metric deltas, recent `retrieval_brief` artifact summaries,
retrieval feedback signal/surface counts, and Memory access-log counters
(`context_injection`, `maintenance_scan`, total recent access).

Space-wide review is explicit. The `context_ops_review_mode` field in
`retrieval.space.settings` defaults to `private_only`; `admins` permits owners/admins to review
`visibility = 'space_shared'` packets whose payload has
`review_scope = 'space_ops'`; `members` permits space members/reviewers as well.
Private `retrieval_diagnostics_packet`, `retrieval_maintenance_packet`, and
`memory_maintenance_packet` proposals remain creator-only even when the switch
is enabled. Context Ops aggregates shared space_ops reports/packets only when the
viewer is allowed by that setting; it does not aggregate other users' private
diagnostics or maintenance artifacts.

Scan initiation is separate from review. `context_ops_scan_mode` defaults to
`admins`; `members` permits active space members/reviewers to start retrieval
diagnostics and maintenance scans. Full-space reindex routes remain
owner/admin-only.

`POST /api/v1/context-ops/review-cycle/run` is the broader read-only/proposal-first
maintenance cycle. It requires Context Ops scan access, rejects `space_ops` output
unless `context_ops_review_mode` allows it, and persists a
`context_review_cycle_report` artifact containing aggregate/ref-only source
health, projection freshness, embedding backlog, retrieval maintenance,
retrieval diagnostics, optional Memory maintenance, and Claim Candidate Packet
results. `include_memory_maintenance` defaults to true but is exposed by the
Context Ops manual trigger and Automation config so operators can disable the
Memory scan for cost/privacy-sensitive runs. When `create_packets` is enabled,
the route creates review packets for the participating maintenance/diagnostics
flows and a `claim_candidate_packet`.
For private cycles, the claim packet input includes recent Context Brief
artifacts plus the generated retrieval maintenance, retrieval diagnostics, and
optional Memory maintenance artifacts, so brief-side
uncited/contradiction/stale/thin signals are part of the cycle. For
`space_ops`, the cycle omits private Context Brief artifacts and only builds
shared packets from `space_shared` source artifacts.
Optional packet creation failures are checkpointed as `degraded` warnings on the
Context Review Cycle report; scan/report persistence failures still fail the cycle. None
of these steps write canonical Knowledge, Claims, Object Relations, or Memory
directly.

Automation target `context_ops_review_cycle` runs the same cycle as a managed
system run from the Automations page or scheduler. Preflight requires owner/admin
authority, an active attribution Agent with a current version, and Context Ops
review settings when `review_scope = 'space_ops'`. Success, degraded, and
failure all produce terminal run state; successful/degraded runs include
per-stage artifact/proposal id maps plus `degraded` and `warnings` in output
JSON. Scheduled failures advance the schedule once rather than retrying silently
in the same tick.

The web `Context Health` page is backed by contextOps read models over the summary plus `GET
/api/v1/context-ops/drilldown`, is gated to owners/admins by default, and becomes
available to members when either member review or member scan initiation is
enabled. Drill-down lazily expands the index-freshness (stale projections),
embedding-backlog, and source-warning aggregates into bounded detail lists, plus
four artifact sections — `maintenance_reports`, `diagnostics_reports`,
`explain_reports`, and `recent_briefs` — that return aggregate-safe
report/packet summaries (ids, types, counts, diagnostic codes) for triage.
Maintenance, diagnostics, and brief sections reuse the owner-scoped /
`space_ops`-gated queries as the summary read model; explain reports are
owner-private drill-down only. No other user's private reports leak, and
`includeSpaceOpsReports` is threaded from the reviewer role check for the shared
sections. The Context Health page offers per-row and multi-select guided Claim
Candidate Packet creation from supported drill-down reports/briefs. Explain
reports are available for operator triage and context attachment, but are not
passed directly to the Claim Candidate Packet route unless that route explicitly
supports them.
Object-level drill-downs are restricted to the injected Knowledge retrieval
registry and revalidate every listed object through the adapter read gate **and**
the source-connection read policy — the same two gates as search — so a finding
never exposes a canonical-invisible or source-restricted title (invariant 3/7);
`truncated` reflects readable findings only. Source-warning details list active
source connections the operator owns (owners/admins see all) with policy posture
labels only, never consent/credential payloads. The page also offers
maintenance-scan and diagnostics-report triggers that reuse the existing
`context_ops_scan_mode`-gated routes and can create review packets. It includes a
targeted explain panel with browser-local per-space presets, persisted explain
artifacts, and side-by-side A/B target comparison for the same query/mode/max
result options; it links back to existing Artifacts and Proposal review
surfaces. It does not expose raw queries, snippets, private memory text, hidden
object ids, dropped candidate ids, or artifact content. Cross-person read
history is queried per resource through
`GET /api/v1/content-access/:resourceType/:resourceId/access-logs`; only the
resource owner may query it by default. Richer finding-row follow-up proposal
authoring remains future product work.

## Governance

- **Egress switch (private context).** The `retrieval.space.settings`
  `external_egress_enabled` field
  (default true) is enforced through the `retrievalEgressAllowed(ref, policy)`
  seam at every content-egress point. The policy distinguishes
  `external_provider`, `local_provider`, and `internal_process`: external
  providers are blocked when the switch is off, while local providers (Ollama or
  loopback/localhost URLs) can still serve query embedding, query rewrite,
  rerank, and synthesis.
  Source-derived retrieval payloads add source policy snapshots and payload
  source ids to the same egress policy before rerank/synthesis provider calls;
  provider invocation evaluates them against the actual provider destination.
  Embedding backfill filters claimed chunks before sending text to an embedder.
  Query rewrite stays query-string-only but its provider destination is governed
  by the same external-egress switch.
  Owners/admins can toggle this in Space Retrieval Settings; non-admin users see
  it read-only.
- **Source / connector consent.** Source connections normalize
  `consent_json` and `policy_json` through
  `server/src/modules/sources/sourceConsent.ts`. The first-pass model records the
  source owner, subjects, allowed readers, allowed agents, source egress class,
  retention policy, import trust level, and whether derived writes are
  proposal-gated or disabled. It deliberately reuses `source_connections` rather
  than introducing a new source table. Connected source content/snapshot queueing
  is bounded by the source retention policy, and connected summary runs can
  create Knowledge or Memory proposals only when the source policy allows the
  corresponding import target. Retrieval projections now carry explicit
  `retrieval_objects.source_connection_ids_json` for source-derived objects.
  Knowledge and Memory derive those ids from `provenance_links`; Source rows use
  explicit `metadata_json.source_connection_id(s)`; Project public summaries use
  explicit `source_refs_json` entries; Sources items and extracted evidence derive
  them from the item connection and source snapshots. Search, Context Brief, graph/relational
  traversal, managed-run retrieval tools, maintenance scans, relation discovery,
  Context Ops
  drill-down, claim evidence rendering (`GET /knowledge/claims/:id/sources`),
  non-creator context artifact attachment, and DB-backed chat candidates apply
  source read policy after the canonical domain revalidation gate and before
  surfacing content. Missing,
  deleted, malformed, or cross-space source refs fail closed for rows that name a
  source connection. There is no historical-data compatibility path for source
  refs. The connector→provenance→projection linkage is covered by a real-DB test
  (`retrievalSourcePolicyDb.test.ts`); connector refresh/purge edge cases,
  activity-record source linkage, and future chat artifact/evidence-pack
  attachments remain the deferred consumers. See
  [`SOURCE_CONNECTOR_CONSENT.md`](SOURCE_CONNECTOR_CONSENT.md).
- **Product UI first pass.** Sources exposes source consent/policy controls for
  the normalized JSON fields, Source Detail exposes post-processing retrieval
  context controls, Agent create/detail exposes Memory, Project public-summary,
  and Sources retrieval tool opt-in, Ask Space exposes Sources as a non-default
  domain toggle, Home links allowed reviewers to Context
  Ops according to Context Ops review/scan settings and shows the other
  context-layer operation surfaces, Ask Space also exposes Inquiry Threads
  through the Inquiry adapter's live Project read gate, Context Ops displays backend aggregate health
  summaries, Retrieval Settings exposes review/scan settings, and proposal
  detail can accept retrieval maintenance packets.
- **Agent tool surface.** `modules/retrieval/tool/service.ts`
  (`RetrievalToolService`) is the governed in-platform entrypoint a managed run
  uses to call retrieval / Context Brief — deliberately NOT an MCP server
  (invariant 8). The viewer is ALWAYS the run's instructing user (the agent-facing
  API has no viewer parameter, so a run can never exceed its user's read access);
  every call is audited as the agent/run actor with pointer metadata only; results
  are returned, never auto-injected. Managed `model_api` / `ts_agent_host` runs
  expose `retrieval.search` and `retrieval.brief` as internal tools only when
  there is an instructing user and either the space-level
  `retrieval.space.settings` `retrieval_tool_mode` field or the run/runtime config opts
  in (for example `manual_tool_only`, `preflight_search`, `preflight_brief`, or
  `retrieval_tools.enabled = true`). Knowledge tools stay named
  `retrieval.search` / `retrieval.brief`; Memory, Project, and Sources are never silently
  merged into those tools. They are exposed only by explicit run/runtime
  configuration or capabilities, as `memory.retrieval.search`,
  `memory.retrieval.brief`, `project.summary.search`, and
  `project.summary.brief`, `source.retrieval.search`, and
  `source.retrieval.brief`. Preflight modes remain Knowledge-only and run
  one governed retrieval call before a no-tool model turn, appending the compact
  result as explicit evidence. Each tool invocation now passes through a
  policy-gateway action before search/brief execution:
  `retrieval.search`, `retrieval.brief`, `memory.retrieval.search`,
  `memory.retrieval.brief`, `project.summary.search`, or
  `project.summary.brief`, `source.retrieval.search`, or
  `source.retrieval.brief`. The policy gate verifies the domain is enabled
  for the run, that there is an instructed-user viewer, and reserves source and
  egress denial hooks for the source-policy enforcement slice. It writes
  pointer-only audit metadata (tool/domain/mode/count-style settings, never query
  text or content). The `required_scopes` entries on tool bindings remain
  runtime-host metadata, not the only governance layer. Tool definitions are
  forwarded through the
  pi-ai chat path selected by the server vendor registry. OpenAI, owner-scoped
  OpenAI Codex subscriptions, Anthropic, MiniMax, OpenRouter, DeepSeek, and
  explicit OpenAI-compatible vendors support runtime tools; Ollama runtime-host
  tool-calling support is deferred and
  requests fail explicitly if tools are enabled against that provider. Brief tool results are also surfaced as
  owner-private `retrieval_brief` run artifacts through the existing materializer;
  Memory, Project, and Sources brief artifacts omit trace just like their human-facing
  brief artifact routes.

## Object Schema Registry / object schema posture

Object types stay fixed (`knowledge_item` / `note` / `source` / `claim` /
`memory_entry` / `project_public_summary` / `source_item` /
`extracted_evidence`), encoded as a closed protocol enum and the
`public.retrieval_object_type` SQL domain used by retrieval/object-schema
endpoint columns. **Decision: do not adopt dynamic schema
packs as the runtime primitive.** Rainver keeps the canonical domain boundary
closed and uses the existing Space/User/Agent/Run/Proposal/Artifact governance
instead.

The Rainver-native implementation is a per-space **Object Schema Registry**:
fixed `object_type`, configurable `object_profile`, and an `object_schema` export
view over active registry rows. `object_type` is the closed domain boundary used
by protocol, the SQL retrieval object type domain, retrieval adapters, read
gates, and ownership. An
`object_profile` is a governed label/config layer under one fixed `object_type`; it
must match subtype values that the owning domain adapter can actually project,
for example Knowledge `knowledge_kind`, Source `source_type`, Claim
`claim_kind`, Memory `memory_type`, plus the current single projected kinds for
Notes and Project public summaries. It cannot create new retrieval object types
or move a row across canonical domain ownership.

The implemented data model is:

- `space_object_profiles`: per-space registry rows keyed by
  `(space_id, base_object_type, key)` with `draft|active|deprecated|archived`
  status, version, label/description, bounded `field_schema_json`,
  `extraction_policy_json`, `retrieval_policy_json`, and `ui_config_json`, plus
  proposal provenance. Archive retires the key so historical references do not
  point at a new definition.
- `space_object_profile_relation_hints`: declarative link hints for an
  `object_profile`, with fixed endpoint `object_type`, optional endpoint profile,
  constrained relation type, direction, confidence default, and `required` flag.
  Hints are config only; they never write relations directly.

The implemented server/protocol surface is:

- `packages/protocol/src/objectSchema.ts` defines object-profile list/output,
  proposal request contracts, relation hints, object-schema manifests, and
  deterministic suggestion reports without adding schema-pack values to
  `RetrievalObjectTypeSchema`.
- Knowledge routes expose owner/admin proposal creation for object profile
  create, update/activate, deprecate, and archive; member-visible list/get
  reads; object-schema export/import; and deterministic suggestion scans. The
  storage behind them is `PgOntologyRepository` (B12I); the paths stay under
  `/api/v1/knowledge/`.
- `server/src/modules/knowledge/proposalApplier.ts` applies accepted
  `object_profile_create`, `object_profile_update`, `object_profile_deprecate`, and
  `object_profile_archive` proposals. These appliers write registry rows only and
  do not create canonical Knowledge, Memory, Claim, Project, relation, or
  retrieval projection rows. `object_profile_update` is the draft activation
  path; only `draft -> active` activation is allowed.
- Object-schema export returns `rainver.object_schema.v1` manifests with
  registry definitions only. Import creates draft object-profile proposals and
  never activates definitions directly.

Retrieval projections include nullable `retrieval_objects.object_profile`,
populated by domain adapters from subtype fields such as `knowledge_kind`,
`source_type`, `claim_kind`, and `memory_type`. Search and brief APIs accept
optional `object_profiles` filters under the fixed `object_type` boundary and
surface active profile key/label metadata only after normal read/source-policy
revalidation. The projection slot is not a license to change canonical
`object_type`. `retrieval_policy_json` remains advisory unless a separate
calibrated runtime setting adopts a mechanic with access-safety proof and shared
evidence; object schema config must not become a backdoor for ranking changes.

Context Ops can run deterministic object-schema suggestion scans from visible
aggregate usage and registry rows: missing registry definitions for used kinds,
deprecated kind usage, and active kinds with no current visible usage. Suggestion
reports are artifacts/review surfaces; they do not call providers or mutate
active config. Relation hints guide the injectable relation-discovery LLM
extraction hook and required-hint gap findings without changing the deterministic
wikilink extractor. Required-hint gaps are review-only unless a user accepts an
explicit packet/proposal flow.

Load-bearing boundaries:

1. No dynamic replacement of `RetrievalObjectTypeSchema`.
2. No schema-driven canonical writes.
3. All object schema changes are proposal-gated and require owner/admin
   authority.
4. Source policy and live read gates apply before any schema-driven discovery,
   extraction, relation hinting, provider call, UI drill-down, or suggestion
   report surfaces content.
5. Ranking, salience, backlink, graph, diagnostics, and gap signals may use only
   visible rows or access-neutral metadata.
6. Cross-space behavior stays fail-closed. An object schema from space A never
   changes read, write, cache, discovery, or UI behavior in space B.
7. Object schema config is declarative only. Bounded JSON config rejects
   executable/script/tool, SQL, and regex-like keys.
8. Imported object schemas create draft proposals, not active runtime changes.
9. Schema/kind hints cannot widen source retention, provider egress, connector
   import targets, Memory visibility, Project public-summary scope, artifact
   attachment policy, or canonical write authority.

## Cross-references

- Retrieval and context-layer stabilization roadmap:
  [`ROADMAP_AND_FUTURE_RISKS.md`](ROADMAP_AND_FUTURE_RISKS.md#retrieval-and-context-layer-stabilization).
- Module current-state: `.agent/modules/knowledge-base.md`,
  `.agent/modules/memory.md`.
- Credential channel for all provider calls: ADR 0008.
- Cross-module boundary for engine/adapter ownership: `BOUNDARIES.md` B33/B34.
- Memory-side evolution interplay: `MEMORY_EVOLUTION_PLAN.md`.
