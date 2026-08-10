# ADR 0012: Ontology Ownership And Language-Layer Alignment

Date: 2026-08-04

## Status

Accepted - 2026-08-04

Supersedes decisions 1, 2, and the cross-domain half of decision 3 in
[ADR 0011](0011-inquiry-domain-model.md). ADR 0011 was rewritten to its
remaining scope (Inquiry domain modelling and Workflow node extension) on the
same date; it explicitly deferred this decision in its own Non-Goals
("Reshaping Ontology/canonical-relation ownership (separate future
decision)").

## Context

`space_objects` was introduced as a shared identity/status/visibility root for
Knowledge items, Notes, Sources, and Claims. ADR 0011 then decided that new
Project-owned domains (Inquiry Thread, Experiment, Decision Case) would *not*
be `space_objects` rows, on the grounds that the shared root carried too much
and that domain shapes differ.

An audit of the implemented schema and services found that reasoning does not
hold, and that the split has produced concrete defects.

### The root table carries no domain data

`space_objects` is 18 generic columns: identity, `object_type`, title/summary,
status, visibility/access level, ownership, project and Project Folder scope,
created-by user/agent/run, and timestamps. Every domain field already lives in
an extension table (`knowledge_items`, `notes`, `sources`, `claims`). The root
shares *identity and visibility*, not *shape*. Differing domain shapes are an
argument for separate extension tables, not for a separate root.

### Root membership never implied proposal gating

At least six modules insert `space_objects` rows directly without a proposal:
`relations`, `publications`, `projectResearch/areaService`,
`academic/repository`, `academic/paperMaterializer`, and
`knowledge/repository` (Notes). Only `knowledge_items` and `claims` are
proposal-gated. The belief that joining the root meant accepting Knowledge's
governance was not accurate.

### The split duplicated the shared columns and dropped the governance ones

`inquiry_threads` re-declares `id`, `space_id`, `owner_user_id`,
`created_by_user_id`, `created_at`, and `updated_at`. It does *not* have
`visibility`, `access_level`, `created_by_agent_id`, `created_by_run_id`,
`archived_at`, or `deleted_at`. Inquiry Threads are therefore outside the
single-read-gate model that `CONTEXT_AND_RETRIEVAL_LAYER.md` invariants 2-4
depend on, have no per-object visibility (only Project membership via
`assertProjectReadable`), and have no FK-level agent/run provenance.

### Two real couplings did exist

- `ck_space_objects_status_by_type` branches on `object_type`, so every new
  domain must edit a root-table constraint. Inquiry has two orthogonal states
  (`lifecycle_status` and `attention_state`) that cannot both occupy one
  shared `status` column.
- `object_relations`'s sole writer is `modules/knowledge/proposalApplier.ts`,
  and the proposal gate is a property of the table rather than of the edge.
  Thread parent/child structure is a direct, high-frequency user action and
  does not belong behind Knowledge's review flow.

These are the defects this ADR fixes. They do not justify removing a whole
domain from the ontology.

### Domain link tables duplicated the canonical edge table

`inquiry_thread_relations` is a column-for-column subset of `object_relations`
with no domain-specific attributes, and four of its seven `relation_kind`
values (`supports`, `contradicts`, `supersedes`, `related_to`) are literally
the same tokens `object_relations` already carries.
`inquiry_thread_note_links` points at `notes.object_id` — one endpoint is
already an ontology object. Both exist only because Thread is not a
`space_objects` row. ADR 0011's "narrowly owned domain join table" exception
requires a genuinely different lifecycle, which is not the case here.

### The Language layer has three conflicting vocabularies

Relation type is independently constrained in three places with different
value sets:

| Authority | Count | Values it alone allows |
|---|---|---|
| `object_relations` CHECK | 15 | `affiliated_with`, `cites`, `authored_by` |
| `space_object_kind_relation_hints` CHECK | 18 | `explains`, `prerequisite_of`, `example_of`, `applies_to`, `summarizes`, `updates` |
| `inquiry_thread_relations` CHECK | 7 | `decomposes_into`, `proposes` |

The protocol layer mirrors the first two as two unrelated enums
(`OBJECT_RELATION_TYPE_VALUES`, `OBJECT_SCHEMA_RELATION_TYPE_VALUES`). The
consequence is a live defect: a relation hint may be declared for a relation
type that `object_relations` will reject on write, and a real edge type
(`authored_by`) cannot have a hint declared for it. Nothing detects the drift.

### Type membership is likewise recorded in three unaligned lists

`CONTENT_RESOURCE_DEFINITIONS` (14 entries, table granularity, with a
`publishable` flag), the `retrieval_object_type` domain/enum (8 entries,
subtype granularity), and `GraphProjectionRepository`'s
`space_objects`/`object_relations` assumption are three de-facto interface
registries that cannot be cross-validated because they operate at different
granularity. Each new domain must be added to each of them, with no mechanism
to catch an omission.

### Audit scope, and what was deliberately left alone

This ADR's audit covered the Language layer only: `object_type`, relation
vocabulary, and the type lists consumed by the read gate, retrieval, and graph
projection. Two categories were examined and **deliberately not changed**, and
one was not examined at all. Recording this prevents the audit's silence from
being read as a clean bill of health.

**Deliberately separate, not drift.** B12A already routes durable links by
meaning, and six of its seven rows are not competing with `object_relations`:
`knowledge_item_sources` / `claim_sources` are curated citation and evidence
paths, `provenance_links` / `evidence_links` are lineage and candidate
association, `note_links` is UI navigation with no graph authority, and
`relation_source_links.link_type` is a target discriminator
(`activity` / `source_item` / `evidence` / `external`), not a semantic edge
vocabulary. These stay as they are. Only tables whose columns and vocabulary
duplicate `object_relations` — `inquiry_thread_relations` and
`inquiry_thread_note_links` — are absorbed.

**Four further type lists — resolved.** Examined and settled in the
implementation phase; recorded here so the audit's outcome lives with its
scope.

- `context_snapshot_items.item_type` (13) and `cards.source_type` (6) **are**
  entity lists and became `ContextIncludable` / `CardSourceable` interface
  declarations. Both carry the stored token separately from the entity type,
  because the stored strings differ (`activity` is stored as
  `activity_record`, `memory_entry` as `memory`) and rows exist behind them.
  Two members turned out not to be entities at all: `manual_context` is a
  sentinel for text the user typed inline, and `idea` had no table and no
  writer, so it was dropped rather than modelled.
- `provenance_links.source_type` was **not examined here** and turned out to be
  the worst of them: the list existed four times, and two of the copies
  silently dropped what they did not recognize. Audited 2026-08-06 and settled
  the same way as the two above — a `ProvenanceSourceable` declaration, with
  `external_source` kept as an explicit sentinel and `run_step` renamed to
  `run` because it stored a run id under a step's name. Recorded in
  `architecture/MEMORY_ACTIVITY_PROVENANCE.md`.
- `evolution_strategy_assets.target_type` (8) is **not** an entity list and
  stays independent. Its members name evolvable asset kinds — `capability`,
  `workflow`, `agent_version`, `runtime_skill_binding` — and `system` is used
  as a scope wildcard in queries (`target_type = 'system'`), not as a reference
  to any row. Modelling it as an interface would have forced non-entities into
  the entity registry to satisfy a surface resemblance.

### Comparison basis

The reference model for this decision is the Palantir Foundry Ontology's
Language / Engine / Toolchain decomposition. The Action and Security columns
of that model are already met or exceeded here (`SYSTEM_ACTION_REGISTRY`
carries denser metadata than a Foundry Action Type; proposals are a
first-class reviewed entity rather than submission criteria embedded in an
action). The Data column is where this system diverges, and the Language layer
is where the divergence is fixable. The Engine and Toolchain columns are
deliberately not adopted — see Non-Goals.

## Decision

### 1. Root contract

`space_objects` is an identity-and-governance root, not a lifecycle root. Its
contract is:

- identity: `id`, `space_id`, `object_type`, `title`, `summary`
- governance: `visibility`, `access_level`, `owner_user_id`,
  `primary_project_id`, `project_folder_id`
- provenance: `created_by_user_id`, `created_by_agent_id`, `created_by_run_id`
- lifecycle presence: `created_at`, `updated_at`, `archived_at`, `deleted_at`

`status` leaves the root. Each extension table owns its own status column and
its own state machine. `ck_space_objects_status` and
`ck_space_objects_status_by_type` are removed. The `space_object` entry in
`CONTENT_RESOURCE_DEFINITIONS` changes its `activePredicate` from
`status <> 'deleted'` to `deleted_at IS NULL`, matching every other entry in
that registry.

Retrieval projection and proposal governance are **capabilities a type may
implement**, not an entry fee for joining the root.

### 2. Field placement rule

A field belongs on the root only if a **cross-domain mechanism reads it**.
"Every domain has this field" is not a reason. Under this rule `visibility`,
`access_level`, `owner_user_id`, the created-by columns, and the
archive/delete timestamps belong on the root because the read gate, retrieval,
graph projection, and provenance queries read them; `status` does not, because
no cross-domain mechanism consumes it.

The root must not carry constraints that branch on `object_type`. The root is
ignorant of its subtypes.

### 3. Ontology module owns the ontology tables

A new `ontology` server module owns `space_objects`, `object_relations`,
`space_object_profiles` (renamed from `space_object_kinds`), and
`space_object_profile_relation_hints`. `knowledge` becomes an ordinary domain
on top of it and gives up sole-writer status.

Governance is declared **per link type and endpoint pair**, not per table: a
declaration names the link type, its legal endpoint object types, and whether
its writes are direct or proposal-gated. The ontology module dispatches
accordingly through a writer registry, mirroring the existing
`ProposalApplierRegistry` pattern. `object_relations` is no longer a
table-level proposal-gated surface.

*Amended 2026-08-04, during P3.* This originally said governance is declared
per link type alone. Recovering Inquiry Thread showed that is too coarse: the
same word carries different governance in different domains. `supports`
between two Threads is working structure a user drags into place and must stay
a direct write; `supports` between two Claims is a semantic assertion that
must stay reviewed. Keying governance on the link type alone would have forced
one of those two to change behaviour, and inventing `thread_supports` to avoid
it would split one semantic relation into two words that every cross-domain
query then has to match — the duplication this ADR exists to remove. A link
type may therefore carry several declarations; the most specific endpoint match
wins, with an `any`/`any` declaration as the fallback.

### 4. What joins the ontology

A domain table becomes a `space_objects` row if and only if it is an
**aggregate root**: it has independent identity, is referenced by other
domains, or needs its own visibility. Revision histories, event streams,
per-user state, and internal configuration are not objects — they are internal
structure of an aggregate.

Applied to Inquiry's 13 tables: `inquiry_threads` joins;
`inquiry_thread_relations` and `inquiry_thread_note_links` are deleted and
their edges move into `object_relations` (their `decomposes_into` and
`proposes` values enter the canonical link-type vocabulary); the remaining ten
(`*_revisions`, `*_events`, `question_states`, `hypothesis_states`,
`iterations`, `personal_focus`, `project_settings`) stay domain-private.
Experiment and Decision Case aggregate roots join on the same basis.

### 5. Definition authority is code, and the registry is open

`object_type`, `link_type`, governance level, and endpoint constraints are
declared in code, in registries that modules **register into** at boot —
core domains register the core types, plugins register their own. This
preserves compile-time checking while keeping the ontology extensible by
third-party modules through the existing PluginHost path (plugins already
ship and run their own migrations).

Closed-set validation moves from database CHECK constraints to the
application-layer registry; the database keeps only format constraints. The
existing CHECKs are demoted rather than extended, because three mutually
inconsistent CHECKs already failed to catch drift and therefore are not
functioning as a second line of defence. A consistency test replaces them.

The code/data boundary is explicit:

- **Behaviour-determining definitions live in code** — `object_type`,
  `link_type`, governance level, endpoint constraints. Each requires an
  implementation to honour it.
- **Presentation- and organisation-determining definitions live in data** —
  `object_profile`, field schema, UI config, retrieval policy, relation hints.
  Their absence degrades presentation; it does not produce incorrect
  behaviour.

### 6. Entity registry and Interface as an explicit primitive

**The registry's subject is an Entity, not only an ontology object.** An
Entity is anything the system can reference, gate, project, or cite:
`space_objects` subtypes *and* independent roots such as `run`, `proposal`,
`artifact`, `activity_record`, `task`, `memory_entry`, and `project_folder`.
This is not a new idea in this codebase — `CONTENT_RESOURCE_DEFINITIONS`
already spans exactly that mixed set, and `space_object` is one of its
fourteen entries. Unification therefore does not require every domain to
become a `space_objects` row; it requires one registry in which
`space_objects` is one kind of entity.

An Entity declares which interfaces it implements:

- `ContentAccessible` — with its owner/project/Project Folder column mapping
  and active predicate
- `Retrievable` — with its retrieval adapter
- `Graphable`
- `Evidenceable` — may be referenced by `claim_sources`
- `ContextIncludable` — may enter a context snapshot
- `Governed` — canonical writes go through proposals

**Declaration granularity is chosen by the interface, not fixed globally.**
`ContentAccessible` is declared once for `space_object` and covers every
subtype, because the read gate reads root-table columns; splitting it per
`object_type` would fragment a registry that is correctly unified today.
`Retrievable` is declared per `object_type`, because retrieval policy and
adapters genuinely differ per subtype. Each interface states its own
granularity.

`CONTENT_RESOURCE_DEFINITIONS`, the `retrieval_object_type` list, the graph
projection's type assumption, `context_snapshot_items.item_type`,
`cards.source_type`, and `evolution_strategy_assets.target_type` all converge
onto these declarations. A test asserts that every registered Entity provides
an implementation for every interface it declares, and that no per-mechanism
type list exists outside the registry.

Two declarations were added while implementing this, both for the same reason —
a polymorphic mechanism needs to know something per type, and the alternative
was another hardcoded list:

- `requiresProjectScope` marks an entity as Project-owned so the writer enforces
  its Project scope instead of each caller remembering (see decision 10).
- `domainStatus` names where a type keeps its status, so the shared status
  helper resolves it without a hardcoded table list. Inquiry Threads vanished
  from the generic graph exactly once because that list existed and did not
  include them.

**The ontology module owns the registry, the interface declarations, and the
ontology's own storage** — `PgOntologyRepository` holds the object-profile,
relation-hint, schema export/import, and object-relation reads and proposal
writes. It does not own the tables behind the domains that register into it.
Where a concern genuinely spans both — proposal creation, Claim lookup — it is
passed in as an explicit seam rather than duplicated or absorbed. `run`, `proposal`, `artifact`, and `task` remain
owned by their modules, which register their own entities — the same
inversion `ProposalApplierRegistry` already uses. Without this boundary the
ontology module would accumulate every domain it indexes.

### 7. Multi-user scope

The design targets: multiple users sharing one deployment instance,
self-hosted deployments, and third-party plugins extending the ontology
through code. It does not target user-facing self-service modelling (defining
new object types from the UI without code). That would additionally require a
generic UI renderer and generic CRUD appliers, which are out of scope; the
migration path if it is ever adopted is to seed registry entries as data rows.

### 8. Action types bind to object types

*Amended 2026-08-05, during P5.* The binding half of this decision is deferred,
and the user-visible half is delivered without it. Nothing in
`SYSTEM_ACTION_REGISTRY` operates on an ontology object today — the registry
covers retrieval, delegation, source connections, backfills, and Project
operations — so `applies_to` would have been a field no definition sets. The
operations the advice vocabulary names (create a Decision Case, create a
delivery Task, design an Experiment, promote Knowledge) are HTTP routes on
their owning modules, not registered actions; registering them would also mean
adding policy actions and widening the agent's callable surface, which is a
product decision about capability exposure rather than part of an ontology
refactor. `applies_to` lands with the first object-bound action, and the
advisory-step-to-real-action link is delivered through the routes that already
carry their own authorization.

*Resolved 2026-08-05, during NE of the notes-and-knowledge workflow plan.* The
deferred binding half has landed. `applies_to` is set by its first three
definitions — `note.promote_to_knowledge`, `note.raise_as_question`,
`note.link_to_evidence` — and `systemActionsForObjectType()` is the lookup a
surface uses to ask what applies to an object it is rendering.

The deferral gave two reasons. The first, adding policy actions, was
unavoidable: a system action must name one. `inquiry.thread.create` and
`note.link.create` are new; `knowledge.create` already existed and promotion
reuses it.

*Corrected 2026-08-06.* Those two were first registered as `wired_direct` on
the reasoning that registering them "buys auditability rather than a new gate".
That reasoning does not survive checking. No code path evaluates either — they
were two of only three `wired_direct` actions in the whole registry with no
runtime reference anywhere — so nothing is gated by them and no audit record
carries their name; and who performed the write is already on the canonical row
(`space_objects.created_by_user_id`, `note_links.created_by_user_id`), so an
audit record would restate it. Both are now `reserved`, which is what the
registry's own lifecycle vocabulary means by declared-and-not-wired. The
honest form of the first reason is therefore narrower than it was written:
adding the policy actions was a registration requirement, not a governance
gain.

The second reason — "widening the agent's callable surface" — turned out not to
apply. All three are `public_api` with `allowed_actor_types: ["user"]`, and the
agent tool gateway admits a definition only when it is `agent_tool` visible
*and* lists `agent` as an actor, so the agent surface is byte-identical. That
was the substance of the concern, and it is why these could land without
reopening the decision. Making one agent-callable remains a separate product
decision, now guarded by a test rather than by the field being unused.

*Amended again 2026-08-05, during the post-implementation audit.* The entry
point is resolved on the client, not carried in the advice payload. The first
attempt put a focus-kind-to-href map on the server, which made the server a
second authority over web route strings: four of its seven hrefs named routes
the app does not have, and the client already owned a richer map that also
knows whether a literature search is running. `recommended_action` is gone from
the advice payload; the Advice block renders the same destination the confirmed
Next Focus renders, so the suggestion is one click from where the work happens
and there is exactly one place that knows where that is.

The original decision read:

`SystemActionDefinition` gains an optional `applies_to: ObjectType[]`.
Actions that do not operate on a single object (connection creation, backfill
start, `authorization.request`) leave it unset. The Inquiry next-step advice
vocabulary (`NEXT_FOCUS_KINDS`) is wired to real registry actions where a
correspondence exists, so an advisory next step becomes a one-click,
policy-gated, idempotent action rather than a display string. Execution
remains user-initiated; the advice engine still does not take the decision.

### 9. Naming

Terms are aligned to ontology vocabulary only where the semantics genuinely
match after this ADR's changes:

| Current | Becomes | Basis |
|---|---|---|
| `object_type` | unchanged | already aligned |
| `relation_type` | `link_type` | endpoint types become declared and constrained, so the term becomes accurate |
| — | `Interface` | a concept the system did not previously have |
| `space_object_kinds` | `space_object_profiles` | removes a `type`/`kind` near-synonym ambiguity; unrelated to alignment |
| `SYSTEM_ACTION_REGISTRY` | unchanged | it also carries non-object-bound actions, which Foundry Action Types never are |
| Proposal | unchanged | proposals are a first-class entity with their own lifecycle, heavier than submission criteria |

`GLOSSARY.md` records both the mapping and the deliberate non-equivalences, so
that borrowed vocabulary does not imply borrowed capabilities.

### 10. Safety requirements carried by the migration

- `primary_project_id` must be non-null for Project-owned aggregates. The
  scope predicate is `(project IS NULL OR projectReadAccess)`, so a null
  project silently bypasses the Project gate. This is enforced by constraint,
  not by convention.
- Recovered Threads default to `visibility='space_shared'`, preserving current
  collaboration semantics. Defaulting to `private` would silently change
  behaviour.
- The graph/relation projection must not expose pre-filter counts. Unifying
  edges into one table concentrates this requirement in one projection layer;
  it must be implemented there explicitly.
- Root `title` is a projection; the domain field is the truth. The owning
  domain writes it in the same transaction.

## Consequences

- `BOUNDARIES.md` B12A is rewritten (`object_relations` ownership and
  per-link-type governance) and B12C is replaced; new ontology rules are added
  for field placement, aggregate-root membership, and the code/data boundary.
- ADR 0011 is rewritten to its remaining scope. Its Workflow node extension,
  database-reset cutover, and registered Overview/Attention adapter decisions
  are unaffected and carry forward.
- `.agent/architecture/` documents (`MODULES.md`, `CLAIM_FACT_ATOM_MODEL.md`,
  `CONTEXT_AND_RETRIEVAL_LAYER.md`, `PROJECTS.md`) describe current state and
  are updated in the phase that changes the corresponding code, not in
  advance.
- Code comments asserting "Threads are never `space_objects` rows"
  (`inquiry/graphService.ts`, `inquiry/retrievalAdapter.ts`,
  `db/schema/inquiry.ts`, `db/schema/decisions.ts`,
  `protocol/knowledgeRetrieval.ts`) become wrong when the corresponding phase
  lands and are corrected there.
- `graphService.getCombinedProjectGraph`'s manual union of two projections is
  removed once Threads are ontology objects.
- Inquiry gains per-object visibility, which it does not have today. This is a
  capability increase and requires the default described in decision 10.
- Schema changes use the existing full-environment reset
  (`reset-postgres.sh` + `start.sh`). No legacy-row migration path is built.

## Non-Goals

- Dynamic schema packs, or moving ontology definitions into per-space data
  (the Foundry model). Rejected for the reasons in decision 5.
- An Object Set query language, a typed client SDK, or Workshop-style
  application construction from the ontology.
- Ontology branching, releases, or staged rollout. The cutover mechanism is a
  database reset.
- Converting capabilities/prompts into ontology-bound Functions taking object
  sets as input.
- Renaming `SYSTEM_ACTION_REGISTRY` or Proposal to Foundry vocabulary.
- A second generic relation table, or dual-writing any semantic edge.
- User-facing self-service modelling: letting a space owner define an object
  type through the UI. Rejected for the same reason as schema packs — a type
  needs an implementation, and a definition without one degrades behaviour
  rather than presentation. If it is ever adopted, the migration path is to
  seed registry entries as data rows, not to move the registry into data.
