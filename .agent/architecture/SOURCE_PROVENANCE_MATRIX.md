# Source / Provenance Ownership Matrix

Each table in the source-and-provenance stack has one role. When deciding where
to read or write, pick by role, not by proximity.

---

## Roles

| Role | Definition |
|---|---|
| **Canonical** | Source of truth. Other tables derive from this. |
| **Sources candidate** | Ingested content and derived evidence. Durable (soft-deleted or retention-limited, not removed after review), but not canonical knowledge. |
| **Review artifact** | Proposals or packets that an LLM or human must evaluate before anything is written to canonical tables. |
| **Derived index** | Computed for retrieval/embedding. Never authoritative. Re-derivable from canonical. |
| **Audit lineage** | Record of provenance relationships. |

---

## Table-by-Table

### `source_connections`
**Role: Canonical**
The user-facing, managed connection to an external data source (URL, file, API,
credential set). Every ingest pipeline starts here. `status = 'active'` means
the connection is live and eligible for re-indexing. `deleted_at` is the
soft-delete gate; hard delete is prohibited once any source_items reference it.

### `source_snapshots`
**Role: Sources candidate**
A versioned content snapshot fetched from `source_connections` during ingestion.
Contains raw content before extraction. Persists after review and is referenced
by `provenance_links` for source-policy read gating. Do not treat as canonical—`source_connections` is the
authority on what a source *is*; `source_snapshots` is what it *said* at a
point in time.

### `source_items`
**Role: Sources candidate**
Raw ingested units (one per document, chunk, or API record) before semantic
extraction. Created by `source_extraction` jobs. A durable ingest record: it is
soft-deleted through `deleted_at`, kept per its `retention_policy` /
`content_state`, and is a join target when `provenance_links` resolve a
connection id. Projected into retrieval as `source_item` through the Sources
retrieval adapter, behind the source read gate.

### `extracted_evidence`
**Role: Sources candidate → transitions to Review artifact**
LLM-generated extraction from an `source_item` (claims, entities, relations).
Created as a review artifact for human inspection and kept after the
downstream `claim_create`/`knowledge_create` proposals are decided (soft-deleted
through `deleted_at`). Projected into retrieval as `extracted_evidence` through
the Sources retrieval adapter, behind the source read gate.

### `evidence_links`
**Role: Review artifact**
Links an `extracted_evidence` row to a target object of an allowed
`target_type` (space, project folder, project, user, agent, run, proposal,
artifact, knowledge, memory, task), with a `link_type` (`supports`,
`contradicts`, `derived_from`, `mentions`, `context_candidate`,
`used_in_context`) and a `candidate`/`active`/`rejected`/`archived` status.
Rows are not deleted with their parent evidence.

### `sources` (in `space_objects`)
**Role: Canonical**
A knowledge object of type `"source"` — the *processed* artifact after source
completes. Status `"processed"` (not `"active"`) is the canonical signal that
the source object is ready. This is the object agents see; `source_connections`
is the infrastructure record the system sees.

### `knowledge_item_sources`
**Role: Audit lineage**
Citation lineage from a `knowledge_item` to a `sources` object (the
`space_objects` source row), with `relation_type`, locator, and quote. It does
not carry a connection id. Created and deleted directly by the Knowledge
item-source routes; read by the Knowledge retrieval adapter (retrieval edges)
and item-source listings, not by source-policy read gating.

### `claim_sources`
**Role: Audit lineage**
Sources of a `claim`, each with its own `source_connection_id`. Written during
`claim_create` apply and replaced wholesale (delete then re-insert) when a
`claim_update` payload carries sources. Claim evidence rendering drops rows
whose `source_connection_id` denies the viewer.

### `provenance_links`
**Role: Audit lineage**
Generic many-to-many between a canonical object (`target_type`, `target_id`) and
the source artifact (`source_type`, `source_id`) that produced it. Covers note,
memory, and other object types that lack a dedicated `*_sources` join table. Read
by `loadSourceConnectionIdsForTargets` to resolve the `connection_id` for each
target.

### `retrieval_objects`
**Role: Derived index**
One row per knowledge object that has been projected into the retrieval engine.
`status` mirrors the canonical object's status at projection time (not the
canonical truth). Can be re-built from canonical tables at any time via a
maintenance job. **Never use as source of truth for object existence or
status—always re-check the canonical table.**

### `retrieval_chunks` / `retrieval_edges`
**Role: Derived index**
Chunked text and semantic edge records produced from `retrieval_objects`.
`retrieval_edges.evidence_json` stores the raw similarity/relation evidence
used to build the edge; it is a snapshot, not a live reference. Re-derivable.

### Proposal `payload_json` and artifact `metadata`
**Role: Review artifact**
`proposals.payload_json` captures the *intent* before any canonical write.
Artifact `metadata` (e.g. `object_schema_suggestion_report`) captures the
*analysis result* before a human decides to act. Neither is authoritative; both
expire once accepted/rejected. The canonical tables (memory_entries, knowledge
items, claims, policies) are authoritative post-accept.

---

## Read-gating authority

Source-policy gating (`sourcePolicyAllowsRead`) consults `source_connections`
for consent and policy fields. It resolves connection IDs via
`loadSourceConnectionIdsForTargets`, which reads only `provenance_links` and
resolves each connection id through `source_items`, `source_snapshots`, or
`extracted_evidence`. **Never gate reads on `retrieval_objects`
status alone.**

---

## Write authority

| Operation | Correct writer |
|---|---|
| New source connection | `source_connections` INSERT when a Source Channel is created |
| New source content | `source_items` INSERT via extraction job |
| Promote claim/knowledge | `claim_create` / `knowledge_create` proposal apply |
| Update canonical object | `claim_update` / `knowledge_update` proposal apply |
| Index for retrieval | `retrieval_objects` UPSERT via retrieval engine (derived) |
| Record lineage | `provenance_links` / `claim_sources` INSERT at proposal apply; `knowledge_item_sources` via the Knowledge item-source routes |
