# Source Connector Consent

Status: implemented first pass (2026-06-25)

This document defines the source / connector permission model used by source
connections before broad ingestion-heavy context work expands. Code remains the
source of truth; active enforcement points are
`server/src/modules/sources/sourceConsent.ts`,
`server/src/modules/retrieval/sourcePolicy.ts`, and
`server/src/modules/retrieval/egress/egressPolicy.ts`.

## Model Choice

The source catalog is split into independent provider, connector, mapping,
connection, and channel layers. New executable providers/connectors are shipped
as code and seed changes; there is no runtime connector upload surface:

- `source_providers` describes external source identity and query semantics.
- `source_connectors` describes system-owned protocol/parser implementations.
- `source_provider_connectors` is the many-to-many capability mapping.
- `source_connections` owns per-space credentials, consent, policy, trust, and
  transport configuration.
- `source_channels` owns channel lifecycle and schedule. A single connection may
  back multiple channels. For search channels, `source_search_specs` is the
  executable, versioned query authority and may reference a selected research
  query attempt. Feed, page, and custom-source channels retain endpoint data on
  the channel because they do not carry a semantic search query.
- Search query meaning and provider compilation are owned by the Research query
  planning module. Connector handlers only build requests from an already
  compiled `source_search_specs` contract and normalize provider responses.
- `source_items`, `source_snapshots`, and `extracted_evidence` carry imported
  objects and derived evidence.

`source_connections.consent_json` and `source_connections.policy_json` are
normalized into versioned JSON documents on create/update. Retrieval projections
carry explicit source connection ids and reload current source policy snapshots
at read/egress time.

Ordinary users select a Provider and configure a Channel. Instance Admins may
enable/disable catalog entries and change mapping priority, but cannot upload or
define executable connectors.

## Consent JSON

New and updated source connections normalize consent to:

```json
{
  "schema_version": 1,
  "owner_user_id": "user-id",
  "subject_user_ids": ["user-id"],
  "allowed_reader_user_ids": ["user-id"],
  "allowed_agent_ids": [],
  "allow_space_admins": true,
  "allow_local_provider_egress": false,
  "allow_external_model_egress": false
}
```

The owner is always the authenticated user creating or updating the connection.
Subjects, readers, and agents are explicit allow-lists. Space admins may be
allowed by flag, but that does not bypass the normal Space/User policy boundary.
Provider egress is off by default at the source layer; a connection must
explicitly allow local or external provider egress before its source policy can
claim that egress class.

Retrieval search, Context Brief, graph traversal, and managed-run retrieval
tools consume the subject/reader/agent/admin gate for rows that carry explicit
source connection refs. Context assembly and source read APIs still need
source-aware integration.

## Policy JSON

New and updated source connections normalize policy to:

```json
{
  "schema_version": 1,
  "source_egress_class": "internal_only",
  "retention_policy": "metadata_only",
  "import_trust_level": "normal",
  "derived_write_policy": "proposal_required",
  "allowed_import_targets": ["activity", "source_artifact"],
  "revalidation": {
    "required": true,
    "viewer_scoped": true
  }
}
```

Allowed egress classes are `internal_only`, `local_provider_allowed`, and
`external_provider_allowed`. The source egress class must be backed by consent.
Retention is tied to capture policy: `reference_only` may keep
`metadata_only` retention, `extract_text` requires at least `full_text`, and
`archive_original` requires `full_snapshot`.

`source_egress_class` is connected to retrieval provider content egress for
rerank, synthesis, and embedding backfill. The source gate composes with the
space-level `retrieval.space.settings` `external_egress_enabled` switch and
provider destination classification. RSS/Atom/web page connector scheduling and
worker ingest consume capture/retention policy; full context assembly remains
deferred.

`derived_write_policy` is intentionally limited to `proposal_required` or
`disabled`. Source-derived Knowledge and Memory writes must not bypass the
existing proposal -> approval path.

## Interaction With Space / User / Agent Permissions

Source consent narrows what a connector is allowed to import and expose. It does
not replace:

- Space membership and owner/admin checks.
- Domain read gates for Knowledge, Memory, Project, Activity, or Artifacts.
- Agent runtime configuration and tool opt-in.
- Provider credential and egress policy checks.

Retrieval treats source policy as an additional gate. A result remains visible
only when both the domain read gate and the source policy allow the viewer /
agent / egress destination. Context assembly should adopt the same rule before
source-derived artifacts or Evidence Packs become attachable.

## Import Targets

The first-pass default import targets are `activity` and `source_artifact`.
Broader targets such as `knowledge` and `memory_proposal` are represented in the
policy vocabulary but should only be enabled deliberately. Even when enabled,
canonical Knowledge and Memory changes remain proposal-gated.

Imported material can flow through these durable surfaces:

- Activity records for timeline / inbox review.
- Sources items and source artifacts for source provenance.
- Extracted evidence for reviewable derived facts.
- Knowledge or Memory proposals after explicit user / operator review.

## Retention And Trust

Retention is stored in normalized `policy_json.retention_policy` and mirrored by
`source_items.retention_policy` as connected items are created or queued.

For items with a `connection_id`, manual URL queueing and item `queue_content` /
`archive_snapshot` actions cannot request retention broader than the source
connection policy allows. The extraction worker repeats the same check before
writing full-text or raw-snapshot artifacts, so already-queued jobs cannot bypass
the source policy. `queue_content` is treated as `full_text` because the current
worker persists extracted text artifacts. `extract_evidence` does not fetch or
persist broader source content; it remains a candidate-evidence action and is
not currently retention-escalating.

Import trust tracks the connection `trust_level` and should be carried into
extracted evidence or proposal provenance when future ingestion flows automate
more of this path.

## Derived Writes

Summary runs may create Knowledge or Memory proposals only when the connected
source policy allows that target:

- `allowed_import_targets` must include `knowledge` before a Knowledge proposal
  is created from connected source/evidence.
- `allowed_import_targets` must include `memory_proposal` before a Memory
  proposal is created from connected source/evidence.
- `derived_write_policy = "disabled"` blocks those derived proposals even when
  the target appears in the allow-list.

Unconnected manual source capture keeps the existing user-driven behavior. Connected
source material is constrained by its source policy. Mixed-source summary
proposal requests fail closed when any connected input disallows the requested
target. Summary runs that only create the review artifact and do not request a
Knowledge/Memory proposal are not blocked by the proposal-target policy; the
default `source_artifact` target covers that review artifact path.

## Enforcement Design

Source policy enforcement narrows access; it never widens domain authority. A
source-derived object is readable or egressable only when all applicable gates
allow it:

```text
Space/User/Agent/domain gate
+ source consent/policy gate
+ provider/egress destination gate
+ live read revalidation
= surfaced content
```

### Paths That Consume Source Policy

Implemented in the retrieval MVP:

- Retrieval search and Context Brief candidate revalidation.
- Graph and relational traversal, including every intermediate hop.
- Managed-run retrieval tools, after the per-call retrieval tool policy decision
  and before surfaced results are returned.
- Knowledge maintenance scans: each referenced object passes the source read
  gate (over the projection's `source_connection_ids`) in addition to the adapter
  visibility gate, so a source-restricted object never surfaces in a finding —
  even to an owner/admin operator who is not an allowed reader.
- Candidate relation discovery: source-connected Knowledge and inline Artifact
  source text is read only after current source policy allows the viewer; missing
  source-policy snapshots fail closed before optional LLM extraction can run.
- Claim evidence rendering: the direct `GET /knowledge/claims/:id/sources` route
  (and the embedded claim-sources list) drops `claim_sources` rows whose
  `source_connection_id` denies the viewer, fail-closed.
- Context Ops drill-down object lists revalidate every listed object through the
  adapter gate and the source read gate before returning a title.
- Context artifact attachment: a non-creator attaching a source-derived artifact
  (e.g. a Context Brief that records the `source_connection_ids` it synthesized
  from) is re-gated against current source policy; persisted run snapshots stay
  immutable, only future attachment is blocked.
- Chat context candidate collection: DB-backed Knowledge, Source, and Project
  public-summary candidates load explicit source connection ids
  (`provenance_links`, `sources.metadata_json`, and
  `project_public_summaries.source_refs_json`) and apply the current source read
  gate before entering the chat context builder. Activity records still have no
  canonical source connection field, so they remain source-unlinked until that
  model exists.

Implemented for provider content egress:

- Rerank and synthesis payload egress carry the payload source ids plus current
  source policy snapshots into provider invocation, where the actual provider
  destination is classified as internal/local/external.
- Embedding backfill joins chunks to `retrieval_objects`, filters pending chunks
  by source egress policy before provider embedding, and fails closed for missing
  source policy snapshots.
- Chat context candidate collection applies the per-space external egress switch
  to every DB-backed candidate before text can enter the prompt, and
  source-connected candidates additionally apply source egress. The chat
  collector does not receive the final provider destination yet, so it uses the
  conservative `external_provider` destination.
- Current query rewrite is query-string-only; if a future mode includes
  source-derived content, it must use the same payload source gate.

Still deferred:

- Chat-turn artifact attachments or future Evidence Packs are not supported yet;
  if added, they must reuse the same read and egress gates before prompt
  assembly.
- Connector schedulers and workers consume capture/retention and derived-write
  target policy for RSS/Atom/web page ingest; a future end-to-end audit can
  extend the source gate to refresh/purge edge cases. The connector→projection→search
  linkage is now covered by a real-DB test (`retrievalSourcePolicyDb.test.ts`).
- Diagnostics reports aggregate only the operator's own private artifact
  metadata, so they carry no source-derived titles/snippets; if a future
  diagnostic reads source-connected content directly it must add the gate.

### Read Gate Shape

The source gate runs after an object is identified as source-derived and before
its title, snippet, citation, gap signal, graph edge, or diagnostic detail is
surfaced.

Required checks:

- `allowed_reader_user_ids` contains the viewer, or the viewer is the connection
  owner.
- `allow_space_admins = true` plus current space owner/admin authority may allow
  administrative review; `allow_space_admins = false` blocks that path.
- `allowed_agent_ids`, when non-empty, must contain the run agent before a
  managed-run tool or context assembly path can use the content.
- The source connection must belong to the same `space_id` as the requested
  retrieval/context operation.
- Missing, deleted, or cross-space source connection refs fail closed for
  connected/source-derived content.

The source gate must not emit hidden-source counts, hidden object IDs, hidden
titles, hidden graph-neighbor counts, or near-miss hints. A denied source row is
indistinguishable from no match to the caller.

### Egress Gate Shape

Provider content egress is allowed only when both the space-level retrieval
egress setting and the source policy permit the destination:

- `internal_process` is allowed by `internal_only`, `local_provider_allowed`, and
  `external_provider_allowed`.
- `local_provider` requires `local_provider_allowed` or
  `external_provider_allowed`, backed by consent.
- `external_provider` requires `external_provider_allowed`, backed by
  `consent.allow_external_model_egress`.

Source policy denial must happen before candidate content is sent to embedding,
rerank, synthesis, or any future content-bearing rewrite stage. Audit remains
pointer-only: destination class, source-policy class/counts, action, model/task
surface, run id when present, and no query/content/snippets.

### Metadata And Projection Requirements

The canonical source connection remains the enforcement source of truth. The
retrieval MVP carries only explicit source ids in the derived projection and
reloads current source policy for enforcement:

- `retrieval_objects.source_connection_ids_json` is required for source-derived
  retrieval rows.
- Knowledge and Memory projections derive those ids from `provenance_links` to
  `source_items`, `source_snapshots`, or `extracted_evidence`.
- Source projections use explicit `sources.metadata_json.source_connection_id`
  or `source_connection_ids`.
- Project public summaries use explicit `source_refs_json` entries with
  `source_type = "source_connection"` or `source_connection_id`.
- Source policy version/hash is deferred to artifact/context-pack audit
  metadata; enforcement reloads current source connection policy.
- Artifact metadata should snapshot source policy classes/counts and egress
  destination, not raw source policy JSON or source content.

There is no historical-data compatibility path. Rows with no explicit source
refs are treated as ordinary domain-owned objects. Rows that name a source
connection but cannot resolve a valid same-space source connection fail closed
for source reads and provider content egress.

### Test Requirements

Implementation should add leak tests for:

- Reader-denied source content omitted from search, brief citations, graph hops,
  maintenance findings, and diagnostics.
- Agent-denied source content omitted from managed-run retrieval tools and
  context assembly.
- Source external-egress denial blocking external providers while preserving
  allowed internal processing.
- Audit metadata remaining pointer-only.

## Deferred Work

This pass defines and validates the model at source-connection create / update
time, exposes the normalized fields in the Sources UI, enforces the policy on
connected source retention escalation, RSS/Atom/web page scan scheduling,
worker-side full-text/snapshot writes, connected summary proposal creation,
source-aware retrieval reads, context artifact attachment, DB-backed chat
candidates with explicit source ids, maintenance/Context Ops reads, claim
evidence rendering, and retrieval provider content egress. Future work is
mostly connector refresh/purge edge cases and product surfaces that do not
exist yet. A dedicated source table should be considered only if multiple
connectors need to share one consent grant or if source subjects/readers become
independently mutable objects.

Deferred product surfaces:

- Connector refresh/purge edge cases beyond the current scheduler and worker
  ingest policy gates.
- Chat-turn artifact attachments or future Evidence Packs.
- Space-wide source governance docs and API affordances.
