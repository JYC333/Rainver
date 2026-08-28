# Ontology

Current state of the object/entity/relation layer. Decisions and their
rationale live in [ADR 0012](../decisions/0012-ontology-ownership-and-language-alignment.md);
when behaviour changes, update **this** document in the same change and leave
the ADR alone.

Owned by `server/src/modules/ontology/`.

## 1. Two kinds of thing the system can reference

**Entity** — anything the system can reference, gate, project, or cite. The
Entity registry (`ontology/entities.ts`) is the single list. It spans two
storage shapes:

- **Ontology objects** — rows with a `space_objects` root plus a domain
  extension table. They can participate in `object_relations` edges.
- **Independent roots** — their own table, no `space_objects` row. They are
  full Entities (they declare interfaces, pass the read gate, appear in
  retrieval) but they do not carry semantic edges.

Registered today:

| Shape | Entities |
|---|---|
| Ontology objects | `space_object` (root) and its subtypes: knowledge item, note, source, claim, `inquiry_thread`, `experiment`, `decision_case`, `research_workflow`, `project_public_summary` |
| Independent roots | `task`, `run`, `proposal`, `artifact`, `activity`, `memory_entry`, `project`, `project_folder`, `agent`, `user`, `source_connection`, `source_item`, `source_snapshot`, `extracted_evidence`, `reader_annotation`, `token_usage_event`, `imported_session` |

`ontologyRegistry.test.ts` asserts that every registered Entity implements
every interface it declares, and that no per-mechanism type list exists in
`src/` outside the registry.

## 2. Which domains join the ontology

Two questions, in order. The first was left implicit until 2026-08-27 and is
the one that decides whether `task` is an ontology object.

**Does the domain join the ontology at all?** Only if its objects need to
participate in **cross-domain semantic relations** — `about`,
`decomposes_into`, `supports`, `proposes`, `derived_from`. Inquiry Thread,
Experiment, and Decision Case do. Task, Run, Proposal, and Artifact do not:
they are the execution and output spine, and what connects them is an
**execution binding** (`task_runs`, `task_artifacts`, `task_proposals`,
`task_entity_links`), not a semantic assertion. An execution binding records
*which work advanced which thing*; a semantic edge asserts *something is true
about the world*. They have different governance, different vocabularies, and
different readers.

**Within a joining domain, which of its tables become objects?** Only
aggregate roots: independent identity, referenced by other domains, or needs
its own visibility. Revision histories, event streams, per-user state, and
internal configuration are internal structure, not objects. Applied to
Inquiry's 13 tables, one joins (`inquiry_threads`) and ten stay
domain-private.

## 3. Root contract

`space_objects` carries identity, governance, provenance, and lifecycle
*presence* — nothing domain-specific:

```
identity     id · space_id · object_type · title · summary
governance   visibility · access_level · owner_user_id
             primary_project_id · project_folder_id
classification focus_area_id            (never read by the access predicate)
provenance   created_by_user_id · created_by_agent_id · created_by_run_id
presence     created_at · updated_at · archived_at · deleted_at
```

**No `status` column.** Domain lifecycle state belongs to the owning extension
table, which has its own state machine. Cross-domain readers filter on
presence (`deleted_at IS NULL`), not on status.

**A field belongs on the root only if a cross-domain mechanism reads it.**
"Every domain has this field" is not a reason. `visibility`, `access_level`,
`owner_user_id`, the created-by columns, and the presence timestamps qualify
because the read gate, retrieval, graph projection, and provenance queries
read them.

**The root never branches on `object_type`.** No constraint on
`space_objects` may name a subtype; the root is ignorant of what extends it.
`object_type` carries a format check only. This is what lets a new domain
join without editing a shared table.

`title` is a projection of the domain's own label. The owning domain writes it
in the same transaction and the writer truncates rather than failing.

## 4. Link types: endpoints and governance

Governance belongs to the **edge**, not to the table. `object_relations` is
not a proposal-gated surface; each link type declares whether its writes are
direct or proposal-gated, together with its legal endpoints
(`ontology/linkTypes.ts`).

A link type may carry several declarations, because the same word means
different things in different domains — `supports` between two Threads is
working structure a user drags into place; `supports` between two Claims is a
reviewed assertion. **The most specific endpoint match wins**, with an
`any`/`any` declaration as fallback.

| Declaration set | Endpoints | Governance |
|---|---|---|
| 19 generic semantic types (`related_to`, `references`, `same_as`, `part_of`, `depends_on`, `source_for`, `derived_from`, `cites`, `summarizes`, `about`, `explains`, `example_of`, `applies_to`, `supports`, `contradicts`, `supersedes`, `refines`, `updates`, `prerequisite_of`) | any → any | proposal |
| `affiliated_with` | person → organization | proposal |
| `authored_by` | source → person | proposal |
| Thread structure (`decomposes_into`, `proposes`, `depends_on`, `supports`, `contradicts`, `supersedes`, `related_to`) | inquiry_thread → inquiry_thread | direct |
| `derived_from` | decision_case → inquiry_thread | direct |
| `about` | research_workflow → inquiry_thread | direct |
| `references` | inquiry_thread → note | direct |

`assertLinkTypeAllowed()` (`ontology/validation.ts`) enforces both halves —
governance *and* endpoints. Every write site calls it. Writing a structural
edge through review, or a semantic assertion directly, is rejected as a
category error rather than accepted as a preference.

## 5. Definitions live in code

`object_type`, `link_type`, governance, and endpoint constraints are declared
in code registries that modules register into at boot. Core domains register
core types; plugins register their own through the existing PluginHost path.

Closed-set validation is in the application layer, not in database CHECK
constraints. The database keeps **format** constraints only
(`^[a-z][a-z0-9_]{0,63}$` on `link_type`, an open `object_type`). This is safe
only because something actually asks the registry: `ontology/validation.ts` is
that replacement, and `ontologyRegistry.test.ts` asserts it rejects everything
the demoted CHECKs used to reject.

The code/data boundary:

- **Behaviour-determining** → code: `object_type`, `link_type`, governance,
  endpoint constraints. Each needs an implementation to honour it.
- **Presentation-determining** → data: `space_object_profiles`, field schema,
  UI config, retrieval policy, relation hints. Their absence degrades
  presentation, not correctness.

## 6. Interfaces

An Entity declares which interfaces it implements. **Declaration granularity
is chosen by the interface, not fixed globally** — `ContentAccessible` is
declared once for `space_object` and inherited by every subtype, because the
read gate reads root columns; `Retrievable` is declared per `object_type`,
because adapters genuinely differ.

`ContentAccessible` · `Retrievable` · `Graphable` · `Evidenceable` ·
`ContextIncludable` · `CardSourceable` · `ProvenanceSourceable` · `Governed`

Two further per-type declarations exist for the same reason the interfaces do
— a polymorphic mechanism needs to know something per type, and the
alternative was another hardcoded list:

- `requiresProjectScope` — the entity is Project-owned, so the writer enforces
  its Project scope instead of each caller remembering (see §7).
- `domainStatus` — where the type keeps its status, so the shared status
  helper resolves it without a hardcoded table list.

`CONTENT_RESOURCE_DEFINITIONS`, the `retrieval_object_type` list, the graph
projection's type assumption, the Runtime Context source-reference types,
`cards.source_type`, and `provenance_links.source_type` all converge onto
these declarations.

## 7. Write path and its guards

`server/src/db/spaceObjectWriter.ts` is the **only** place that builds
`INSERT INTO space_objects`. It was introduced to consolidate 11 hand-written
inserts. It enforces:

- the object type is registered, and is the root or extends it
- `requiresProjectScope` entities carry a non-null `primary_project_id`
- at least one of user / agent / run provenance is present
- `visibility` / `access_level` are legal values, defaulting to
  `space_shared` / `full`
- `title` is non-empty and truncated to the column width

A rule enforced at eleven call sites is a rule that will be missed at the
twelfth, and the miss is silent (B12H).

**Why the Project scope check is load-bearing:** the access predicate reads
`(project IS NULL OR projectReadAccess)`. A null Project on a Project-owned
object does not narrow access — it removes the Project gate entirely and
leaves only visibility. A forgotten `primary_project_id` is a silent
disclosure, not a stricter default.

This is enforced by the single writer plus a source-scanning test, **not** by
a database constraint, because such a constraint would have to name subtypes
and §3 forbids the root from branching on `object_type`. The guard is the
first test in `server/test/spaceObjectWriter.test.ts`: it asserts no file in
`src/` outside `spaceObjectWriter.ts` contains `INSERT INTO space_objects`,
and it is deliberately asserted *before* any of the writer's own rules,
because hardening a choke point is worthless if a domain can hand-roll the
insert next to it.

The graph/relation projection must not expose pre-filter counts — unifying
edges into one table concentrates that requirement in one layer.
`countVisibleObjects` applies `contentReadSql` before counting.

## 8. Known debt

**`memory_relations` is outside the ontology and outside the registry.**
Audited 2026-08-27, found untouched by the ADR 0012 audit:

- `relation_type` has a live 8-value CHECK whose vocabulary overlaps
  `object_relations` in five values (`supersedes`, `contradicts`,
  `related_to`, `supports`, `applies_to`), and which was never demoted
- `source_type` / `target_type` are unconstrained `varchar(64)` — a
  polymorphic endpoint vocabulary with no registry behind it
- one writer in `src/` (`memoryApplyProvenance`, hardcoded `'supersedes'`),
  **no reader**; seven of the eight allowed values have never been written

It is not absorbed: `memory_entries` is an independent root, not a
`space_objects` row, so its edges cannot live in `object_relations` today.
Deciding between "shrink to what is written" and "model as a declared link
type set once memory joins the ontology" is deferred; recorded here so the
next audit does not rediscover it.

## Non-goals

- Dynamic schema packs, or moving ontology definitions into per-space data
- An Object Set query language, typed client SDK, or app construction from the ontology
- Ontology branching, releases, or staged rollout
- A second generic relation table, or dual-writing any semantic edge
- User-facing self-service modelling (defining object types from the UI)
