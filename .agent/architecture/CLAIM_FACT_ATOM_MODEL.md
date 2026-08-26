# Claim / Fact Atom And Core Object Model

Status: current-state architecture. The Phase 1-5 backend foundation is
implemented in the baseline schema/backend. Claims are global
`space_objects`-backed atoms, and FK-backed `object_relations` is the canonical
relation graph for Knowledge, Claims, Sources, and Notes.

Deferred product work: frontend claim workspaces, full source monitoring /
source-drift evaluation, richer Context Brief claim-review UX beyond the
implemented Claim Candidate Packet, Memory-derived claim extraction, and future
domain modules such as people/assets/events/tasks.

This document replaces the earlier Knowledge-only claim table sketch. The audit
found that Rainver already uses `knowledge_items` as the canonical Wiki
model, not as a generic root object table. The implemented backend shape is now:

```
space_objects
-> knowledge_items / notes / sources / future people/assets/events/tasks...
-> global claims
-> claim_sources / object_relations
```

Knowledge remains the first product surface that creates and displays claim
atoms, but claims are not Knowledge-owned rows.

## Current Summary

### Current database model

There is no current `knowledge` table to rename. The existing canonical Wiki
table is already `knowledge_items`.

Current Knowledge-adjacent tables:

| Table | Current role |
|---|---|
| `space_objects` | Common identity/visibility/provenance root for Knowledge items, Notes, Sources, and future core objects. Domain status belongs to the extension tables (B12D). |
| `knowledge_items` | Proposal-gated canonical Wiki page extension. Uses `knowledge_kind`; `claim` is not a valid kind. |
| `knowledge_item_sources` | Wiki item-to-source evidence links. |
| `notes` | Direct-CRUD working knowledge extension attached to `space_objects`, intentionally separate from governed Wiki items. |
| `sources` | Evidence/provenance extension attached to `space_objects`, not a `KnowledgeItem` type. |
| `provenance_links` / `evidence_links` | Provenance lineage and candidate/context evidence links. Evidence links are not accepted object lineage. |
| `claims` / `claim_sources` | Proposal-gated global semantic atoms and curated evidence/source paths. |
| `object_relations` | Proposal-gated FK-backed object graph edges over `space_objects`; the only canonical relation graph. |
| `retrieval_objects` | Derived retrieval index with closed object types: `knowledge_item`, `note`, `source`, `claim`, `memory_entry`, `project_public_summary`. |

Current independent roots that should not be folded into Knowledge include
`projects`, `project_folders`, `activity_records`, `runs`, `artifacts`, `proposals`,
and `memory_entries`.

### Current dependencies

Knowledge is already a first-level product module:

- API routes use `/api/v1/knowledge`.
- Frontend routes use `/knowledge`, `/knowledge/wiki`, `/knowledge/notes`,
  `/knowledge/sources`, and `/knowledge/cards`.
- Proposal types use `knowledge_*` for governed Wiki item writes. Relations use
  `object_relation_create` / `object_relation_delete`.
- Protocol and retrieval types expose `knowledge_item`, `note`, `source`, and
  `claim` for the Knowledge retrieval surface.
- Artifact links and retrieval citations resolve Knowledge objects by their
  current object type names.
- Project public summaries carry their own source refs for project retrieval;
  those refs are derived citation metadata, not Knowledge ownership.
- Maintenance and Context Brief flows should create review packets/proposals,
  not direct canonical Knowledge or claim writes.

Refactoring the internal object root was therefore a schema/API/protocol/backend
coordination task. Since there is no production data requirement, the
implementation is a clean coordinated baseline change, not a
legacy-compatibility layer.

## Model Boundaries

### Knowledge is not currently the system root

The current model does not force Projects, Memory, Artifacts, Activities, Runs,
or Proposals into Knowledge. Knowledge is acting as true knowledge: Notes,
governed Wiki items, Sources, and their relations/evidence.

The earlier conceptual leak was `knowledge_items.item_type='claim'`. Phase 1
removed that value and renamed the field to `knowledge_kind`. A Wiki page can
still describe a claim, but a durable fact/claim atom needs different behavior:

- smaller unit than a page,
- direct evidence rows,
- contradiction/supersession edges,
- validity time fields,
- holder/perspective fields,
- source-policy revalidation,
- retrieval as an assertion rather than as a document.

### `object_relations` is the relation root

`object_relations` replaced the older polymorphic and per-domain relation tables.
Relation proposals resolve to FK-backed `space_objects` endpoints, and retrieval
uses `retrieval_edges` only as a rebuildable projection of active
`object_relations` plus curated source links.

### Constraint Lessons Apply Only At The Constraint Layer

Rainver should keep discipline around small canonical types, aliases/subtypes,
migration review, and audit. It should not copy a page-oriented schema-pack
runtime as the authoritative application model.

The relevant lesson is "constrain type proliferation." The answer here is a
small fixed root object taxonomy and fixed claim kinds, not per-space dynamic
schema packs.

## Implemented Decisions

### 1. Do not rename `knowledge` to `knowledge_items`

There is no `knowledge` table. `knowledge_items` already exists and should keep
representing governed Wiki content.

### 2. Introduce `space_objects` before broad new domains

Future People, Assets, Events, Tasks, Documents, and similar durable domain
objects should not be modeled as KnowledgeItem subtypes. They should share a
common identity/permission layer and then attach domain-specific
extension tables, each owning its own status (ADR 0012).

### 3. Claims must be global, not `knowledge_claims`

Use `claims`, `claim_sources`, and `object_relations`, not
`knowledge_claims`. Knowledge can be the first UI and proposal source, but a
claim may be about a project, person, task, event, asset, source, artifact,
memory-derived summary, or Wiki item.

### 4. Remove `claim` from `KnowledgeItem.knowledge_kind`

`claim` is no longer a valid Knowledge item kind. Page-level assertions should
be represented as:

- `claims` rows for atom-level facts/takes;
- `knowledge_items` rows for explanatory pages, summaries, procedures,
  decisions, lessons, questions, and answers.

### 5. Proposal is workflow, claim is data

A proposal is the review envelope for a possible write. A claim is the canonical
semantic assertion after approval. One proposal may create, update, supersede,
archive, or relate many claims, but proposals are not themselves facts.

## Claim, Fact, And Take

`claim` is the durable semantic atom.

`fact` is an objective or evidence-backed claim kind. It still has confidence,
evidence, validity time, and status; "fact" does not mean immutable or
unquestionable.

`take` is a perspective-bearing claim, normally with a holder. Examples:
"Alice prefers X", "the team believes Y", "this source argues Z", or "the
agent's current assessment is W." Takes should use the same `claims` table with
`claim_kind` such as `belief`, `preference`, `commitment`, `interpretation`, or
`question`.

## Implemented Backend Model

### `space_objects`

Common durable object identity. Use this for app-owned objects that need shared
relations, retrieval identity, citations, permissions, or cross-domain claims.

Implemented fields:

- `object_id` (the claim id; PK/FK to `space_objects(id, space_id)`)
- `space_id`
- `object_type`: fixed enum. The implemented `ck_space_objects_object_type`
  values are `knowledge_item`, `note`, `source`, `person`, `organization`,
  `claim`, `inquiry_thread`, `decision_case`, and `experiment`. The CHECK and
  the entity registry are asserted to agree by `test/ontologyRegistry.test.ts`
  — `relationship` was dropped when that test was added, because it had no
  extension table, no entity, and no writer. Domains discussed elsewhere in
  this document as future work (`project`, `asset`, `event`, `task`,
  `document`) are **not** in the enum; `project` and `project_folder` are
  registered *entities* without being `space_objects` rows (B12G).
- `title` (a projection of the domain's own label, truncated by the writer)
- `summary` or `excerpt`
- `visibility`, `access_level`
- `owner_user_id`
- `primary_project_id`
- `project_folder_id`
- `created_by_user_id`
- `created_by_agent_id`
- `created_by_run_id`
- `created_at`, `updated_at`, `archived_at`, `deleted_at`

Keep the taxonomy small. Aliases, subtypes, or metadata can live on extension
tables until a repeated product need justifies promotion.

Domain status is **not** on `space_objects` (ADR 0012 / B12D, B12E). Each
extension table owns its own `status` column and constraint; the former shared
column, its index, and its `object_type`-branching CHECK are gone. The six
extension tables that own a status are `knowledge_items`
(`draft|active|superseded|archived|deleted`), `notes`
(`active|archived|deleted`), `sources`
(`raw|processing|processed|archived|error`), `claims`
(`active|disputed|superseded|rejected|archived`), and `relation_people` /
`relation_organizations` (`active|archived|deleted`).

A reader that knows its object type reads the extension column directly. A
polymorphic reader uses `db/objectStatusSql.ts`, whose table/column list is
**generated from the `domainStatus` declaration on the entity registry** rather
than hardcoded — a hardcoded list is how Inquiry Threads silently dropped out
of every cross-type query when they joined the ontology, since a LEFT JOIN to a
table nobody listed yields NULL and `NULL NOT IN (...)` is never true. The
registry test resolves each declaration against the schema source, so a
misspelled table or column fails instead of degrading.

Substituting timestamps for status is **not** valid: `status NOT IN
('archived','deleted')` is not `archived_at IS NULL AND deleted_at IS NULL`,
because a Source can be archived without `archived_at` and `superseded`
deliberately writes no timestamp. The one sanctioned substitution is
`CONTENT_RESOURCE_DEFINITIONS.activePredicate` for `space_object`, which uses
`deleted_at IS NULL` — valid only because `deleted` is reachable for Notes and
Knowledge items alone, and both write the timestamp.

### `knowledge_items`

Knowledge-specific extension for governed Wiki content. Prefer
`knowledge_items.object_id` as the primary key and FK to `space_objects(id)`.
The external item id can remain the object id.

Fields that belong here:

- `object_id`
- `knowledge_kind`: fixed enum such as `concept`, `lesson`, `procedure`,
  `decision`, `question`, `answer`, `summary`
- `slug`
- `aliases_json`
- `content`, `content_json`, `content_format`, `content_schema_version`
- `plain_text`
- `tags_json`
- `confidence`
- `verification_status`
- `reflection_status`
- `root_item_id`, `supersedes_item_id`, `redirect_to_item_id`, `version`
- `created_from_proposal_id`, `approved_by_user_id`
- `deprecated_at`

`source` should remain the `sources` table, not a `knowledge_kind`. Notes should
remain direct-CRUD working knowledge, not governed Wiki items.

### `claims`

Global semantic assertions. Claims are proposal-gated for canonical writes.

Implemented fields:

- `id`
- `space_id`
- `subject_object_id`: nullable FK to `space_objects(id)` when the claim is
  about an app-owned object
- `subject_text`: optional unresolved or external subject label
- `claim_kind`: fixed enum such as `fact`, `hypothesis`, `belief`,
  `preference`, `commitment`, `question`, `interpretation`, `instruction`,
  `metric`, `relationship`, `event`
- `claim_text`
- `normalized_claim_hash`
- `holder_object_id`: optional FK to `space_objects(id)` for perspective holder
- `holder_type`, `holder_id`: optional non-object holder only when needed for
  user, agent, source connection, or external actor perspectives
- `confidence`
- `confidence_method`: `human_confirmed`, `source_extracted`,
  `llm_extracted`, `inferred`, `imported`
- `status`: `active`, `disputed`, `superseded`, `rejected`, `archived`
  stored on `claims.status`
- `resolution_state`: `unreviewed`, `confirmed`, `contradicted`, `stale`,
  `needs_source`
- `valid_from`, `valid_until`, `observed_at`
- `created_from_proposal_id`
- `created_at`, `updated_at`, `archived_at`

Candidate claims should live in proposal payloads or private review artifacts
until accepted. Do not index rejected or unaccepted candidates as context facts.

Implemented claim status transitions:

- Create claims as `active` or `disputed`; use `rejected` only when the
  reviewer wants to preserve a negative review record without retrieval
  projection.
- `active -> disputed | superseded | archived`
- `disputed -> active | superseded | archived`
- `superseded -> archived`
- `rejected -> archived`
- `archived` is terminal for the original object. Reintroducing the assertion
  should create a new claim or successor claim via proposal, preserving the
  original archive decision for audit, retrieval history, and source-policy
  revalidation.

`superseded` should include a replacement/superseding claim relation or
the `claim_update.superseded_by_claim_id` packet field, which the applier
persists into claim metadata. `disputed` requires
`resolution_state=contradicted` or `needs_source`; `active` cannot use
`resolution_state=contradicted`. These lifecycle rules are enforced by both
proposal creation and proposal apply. The database keeps enum/check
constraints, not a full status machine.

### `claim_sources`

Claim-specific evidence and source-policy links.

Implemented fields:

- `id`
- `space_id`
- `claim_id`
- `source_object_id`: nullable FK to `space_objects(id)` for Source, Wiki,
  Note, Artifact, or other app-owned evidence objects after root migration
- `source_ref_type`, `source_ref_id`: fallback for run events, extracted
  evidence, source snapshots, or external pointers that are not root objects
- `source_connection_id`: optional FK to a SourceConnection for object-backed
  evidence, but required for any `source_ref_type/source_ref_id` evidence.
  External evidence must first be normalized into a SourceConnection-backed
  source pointer or a governed Source object; raw external refs without
  an id are rejected.
- `source_policy_snapshot_json`: audit snapshot only; runtime revalidation still
  uses current policy
- `locator`
- `quote_excerpt`: short reviewer-visible excerpt only when retention and
  visibility allow it
- `evidence_role`: `supports`, `contradicts`, `mentions`, `derived_from`,
  `cites`, `summarizes`
- `source_trust`
- `confidence`
- `created_at`

`provenance_links` and `evidence_links` can still exist for generic provenance,
but claim truth/evidence semantics should be represented here.

### `object_relations`

FK-backed canonical graph for object-to-object edges, including claim-to-claim
semantic edges.

Implemented fields:

- `id`
- `space_id`
- `from_object_id`
- `to_object_id`
- `link_type`
- `confidence`
- `status`: `candidate`, `active`, `rejected`, `archived`
- `source_claim_id`
- `source_object_id`
- `source_proposal_id`
- API response field `retrieval_projected`: derived boolean; true only when
  both endpoints are object types currently indexed by the Knowledge retrieval
  adapter.
- `created_by_user_id`, `created_by_agent_id`
- `created_at`, `updated_at`

`object_relations` is the governed, proposal-gated FK graph layer for durable
cross-object relations.
Create packets currently accept `candidate` or `active`; delete/archive flows
move accepted rows out of the active graph.

`object_relations` intentionally keeps the wider `space_objects` endpoint model
instead of limiting writes to Knowledge-retrieval object types. Relations that
touch future or non-indexed object types are still canonical graph rows, but
they do not become retrieval graph edges until both endpoint types have a
registered retrieval adapter/projection path. Read APIs expose this as
`retrieval_projected` rather than silently implying every canonical relation is
retrievable.

## Proposal Flow

All canonical claim writes are proposal-gated:

1. Extraction, Context Brief, retrieval diagnostics, maintenance scans, or user
   action creates a proposal/review packet. The implemented
   `claim_candidate_packet` starts from selected `retrieval_brief`,
   `retrieval_maintenance_report`, `retrieval_eval_report`, and
   `memory_maintenance_report` artifacts.
2. The packet contains proposed claims, claim/object-relation candidates,
   review notes, evidence refs, source connection ids, source-policy snapshots,
   confidence, markers, and proposed child proposal payloads when enough
   structure exists. Brief-derived claim candidates carry deterministic
   holder/perspective hints for common take verbs, ISO validity/observation time
   hints when the source text supplies them, and governed claim source refs only
   for source connections with current source-policy snapshots.
3. A reviewer accepts, edits, rejects, links, or supersedes the proposed atoms.
4. The proposal applier writes `claims`, `claim_sources`, and any
   `object_relations` in one transaction.
5. Retrieval projection indexes accepted active claims only after canonical
   write.

Implemented proposal type names:

- `claim_create`
- `claim_update`
- `claim_archive`
- `object_relation_create`
- `object_relation_delete`
- `claim_candidate_packet` (review packet; accepting creates child pending
  claim/object-relation proposals only)

The initial UI can group these under Knowledge review because Knowledge is the
first product surface, but the proposal types should not be `knowledge_claim_*`.

## Retrieval And Policy Integration

Implemented: `claim` is a closed retrieval object type. `knowledge_claim` is not
a type.

Search behavior:

- Index `claim_text`, subject title, holder label, active evidence refs, and
  relation signals.
- Revalidate the claim's own visibility plus every required source gate before
  surfacing a claim.
- If any source-connected evidence lacks a valid source connection id, fail
  closed.
- Claim snippets come from `claim_text` only after revalidation.
- Claim citations resolve to claim refs plus safe evidence refs.
- Hidden contradictory claims must not appear as titles, counts, snippets, or
  "near misses" to unauthorized viewers.

Provider egress uses the same retrieval egress policy as other retrieval rows:
internal process, local provider, or external provider. Audit logs should store
pointer metadata, source-connection counts/classes, destination class, proposal
id, and run id. They must not store hidden excerpts or private claim text.

## Context Brief Gap Mapping

Context Brief findings map to claim work as follows:

- `uncited_claims`: proposed `claims` with `resolution_state=needs_source`
  unless evidence is available; structured or inferable entries can include
  holder/perspective, validity/observation time, and source refs for reviewer
  confirmation.
- `contradictions`: proposed `object_relations` with
  `link_type=contradicts` only when the brief identifies two canonical
  claim ids; otherwise a review note asking the reviewer to inspect the
  conflicting sources first.
- `missing_topics`: reviewer tasks, not claims, unless a concrete assertion is
  supplied or accepted.
- `stale`: claim/source review task, emitted as a review note; do not mutate
  the active claim until a reviewer confirms supersession.
- `thin`: source/object enrichment task, emitted as a review note; not a claim.

## Claim Trajectory And Contradiction Loop

Implemented in `server/src/modules/knowledge/claimReviewLoop.ts`. Both passes only
read viewer-visible claims through the readable space-object gate, so neither can
leak hidden claim existence, counts, or text, and neither writes canonical state.

- `buildClaimTrajectory` returns advisory, read-only change-over-time signals
  (`status_change`, `resolution_change`, `confidence_shift`, `supersession`,
  `kind_divergence`) for the visible claims about one subject, ordered by
  `valid_from`/`observed_at`/`created_at`. Holder display labels resolve through
  viewer-visible `holder_object_id` space objects and otherwise fall back to the
  non-object holder type. Exposed at `GET
  /api/v1/knowledge/claims/trajectory` and attached to Ask Space's claim
  provenance behind `include_claim_trajectory`.
- `scanClaimContradictions` runs a deterministic judge (negation / numeric
  opposition) over source-policy-filtered visible active claims, groups by
  subject, and emits batched, clustered, confidence-tiered findings. It also has
  a request-gated LLM judge hook for future provider wiring. Until the ADR 0008
  provider adapter is connected, the public HTTP route rejects
  `llm_judge_enabled=true` with 422; the service-level hook remains injectable
  for tests and internal callers. Any enabled implementation receives only
  source-policy-allowed visible claims plus current source-policy snapshots. `POST
  /api/v1/knowledge/claims/contradiction-scan` (Context Ops scan-gated) persists an
  owner-private or `space_ops` `claim_contradiction_report` artifact. That report
  becomes proposals only through the existing Claim Candidate Packet flow, which
  now consumes `claim_contradiction_report` artifacts and turns each finding into
  an `object_relation_create` (contradicts) candidate. There is no new claim
  proposal type — the only canonical-write path stays the proposal-gated packet.

## Implementation Record

### Phase 1: clean Knowledge typing

- Implemented: removed `claim` from Knowledge item typing.
- Implemented: renamed the field to `knowledge_kind`.
- Keep Notes and Sources as separate lifecycle models.
- Do not create compatibility aliases for removed item types.

### Phase 2: introduce `space_objects`

- Implemented: added `space_objects` as the common identity/visibility table; status later moved to the extension tables (ADR 0012).
- Implemented: attached `knowledge_items` to it with `object_id` as PK/FK.
- Implemented: attached `notes` and `sources`,
  because retrieval and citations already treat them as object-like rows.
- Keep public Knowledge routes stable unless a separate product rename is
  intentionally chosen.

### Phase 3: move common fields out of Knowledge extensions

- Implemented: moved shared fields such as title, summary/excerpt, status, visibility, owner,
  project/Project Folder refs, created-by fields, timestamps, archive/delete fields
  to `space_objects`.
- Keep content, slug, aliases, tags, verification/reflection, versioning, and
  Knowledge provenance fields in `knowledge_items`.
- Implemented: updated repositories, DTOs, tests, and retrieval adapters in one coordinated
  change.
- Superseded by ADR 0012: status moved to the extension tables and the root's
  type-branching constraint was removed. Kept
  note collection parent/member links same-space through composite foreign keys.

### Phase 4: add global claims

- Implemented: added `claims`, `claim_sources`, and canonical `object_relations`.
- Implemented: added proposal packet types and appliers for claim writes.
- Implemented: claim proposal creation and apply enforce the claim status
  transition rules, terminal archive semantics, and supersession successor
  requirement.
- Implemented: added retrieval projection type `claim`.
- Implemented: claim projection carries direct `source_connection_id` values
  and source-object metadata-derived connection ids for source-policy
  revalidation. Pure `source_ref_type/source_ref_id` rows must carry
  `source_connection_id`; otherwise repository, proposal apply, and the baseline
  schema reject them fail-closed.

### Phase 5: replace or scope generic relations

- Implemented: introduced `object_relations` for FK-backed object graph edges.
- Implemented decision: retire the separate direct-CRUD relation tables and use
  `object_relations` for governed FK-backed cross-object graph writes.
- Implemented: object relation read/apply results expose `retrieval_projected`
  so callers can distinguish canonical wide graph rows from relations currently
  projected into the Knowledge retrieval graph.
- Future domain extensions such as people, assets, events, and tasks should be
  added on top of `space_objects`, not under Knowledge.

## Decision Record

| Option | Pros | Cons | Decision |
|---|---|---|---|
| A. Rename `knowledge` to `knowledge_items` | None; the current table is already `knowledge_items`. | Solves the wrong problem. | Reject as no-op. |
| B. Add `space_objects` + keep `knowledge_items` as extension + global `claims` | Clean long-term root, avoids Knowledge owning every domain, supports cross-domain facts/takes, aligns with source/policy/retrieval boundaries. | Requires coordinated schema, repository, protocol, retrieval, proposal, and frontend updates. | Implemented as the backend foundation. |
| C. Keep current model and add `knowledge_claims` | Smallest immediate implementation. | Hard-codes claims as Knowledge-owned and conflicts with cross-domain claims. | Reject except as a throwaway prototype, which is not needed because no production data compatibility is required. |

## Deferred Follow-Up Work

- Full dynamic schema packs remain rejected as the runtime model.
- Object Schema Registry foundations for per-space `object_profile` definitions and
  field schemas are implemented in the `ontology`-owned object profile registry
  (served under the Knowledge paths) and
  summarized in [`CONTEXT_AND_RETRIEVAL_LAYER.md`](CONTEXT_AND_RETRIEVAL_LAYER.md).
  Claim subtype validation can build on those registry facts, but canonical
  claim writes still stay proposal-gated.
- People/assets/events/tasks product modules.
- Full source monitoring / source-drift evaluator for claim evidence. Runtime
  read/egress revalidation exists, but source-policy change detection and
  scheduled claim-source review remain Context-layer follow-up work.
- Frontend claim workspace and richer Context Brief claim-review UX. Structured
  proposal packets exist; productized review/transformation workflows remain
  deferred.
- Automatic Memory claim extraction. Memory-derived claims need a separate
  privacy, selected-user, summary-only, and access-log design.
- Broad artifact/proposal/retrieval UI redesign beyond the references required
  by the root-object and claim migrations.
- Automated legacy-data migration. The current assumption is clean break/no
  production data; write tests and seed updates instead of compatibility code.
