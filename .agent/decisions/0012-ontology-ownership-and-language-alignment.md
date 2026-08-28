# ADR 0012: Ontology Ownership And Language-Layer Alignment

Date: 2026-08-04
Rewritten: 2026-08-27

## Status

Accepted.

Supersedes decisions 1, 2, and the cross-domain half of decision 3 in
[ADR 0011](0011-inquiry-domain-model.md), which was rewritten to its remaining
scope (Inquiry domain modelling and Workflow node extension) on 2026-08-04.

Current state of the implemented ontology lives in
[`architecture/ONTOLOGY.md`](../architecture/ONTOLOGY.md). This document holds
the decision and its reasoning only; behaviour changes update that document,
not this one.

## Context

`space_objects` was introduced as a shared identity/status/visibility root for
Knowledge items, Notes, Sources, and Claims. ADR 0011 then decided that new
Project-owned domains (Inquiry Thread, Experiment, Decision Case) would *not*
be `space_objects` rows, on the grounds that the shared root carried too much
and that domain shapes differ. An audit of the implemented schema and services
found that reasoning does not hold, and that the split had produced concrete
defects.

**The root table carries no domain data.** Every domain field already lived in
an extension table. The root shares *identity and visibility*, not *shape*.
Differing domain shapes argue for separate extension tables, not a separate
root.

**Root membership never implied proposal gating.** Six modules inserted
`space_objects` rows directly without a proposal. Only `knowledge_items` and
`claims` were gated. The belief that joining the root meant accepting
Knowledge's governance was simply inaccurate.

**The split duplicated the shared columns and dropped the governance ones.**
`inquiry_threads` re-declared `id`, `space_id`, `owner_user_id`,
`created_by_user_id`, and the timestamps, but had no `visibility`,
`access_level`, `created_by_agent_id`, `created_by_run_id`, `archived_at`, or
`deleted_at`. Threads were therefore outside the single-read-gate model that
`CONTEXT_AND_RETRIEVAL_LAYER.md` invariants 2–4 depend on, had no per-object
visibility, and had no FK-level agent/run provenance.

**Two real couplings did exist**, and they are what this ADR actually fixes:

- `ck_space_objects_status_by_type` branched on `object_type`, so every new
  domain had to edit a root-table constraint. Inquiry has two orthogonal
  states that cannot share one `status` column.
- `object_relations`'s sole writer was `knowledge/proposalApplier.ts`, and the
  proposal gate was a property of the *table* rather than of the *edge*.
  Thread parent/child structure is a direct, high-frequency user action and
  does not belong behind Knowledge's review flow.

**Domain link tables duplicated the canonical edge table.**
`inquiry_thread_relations` was a column-for-column subset of
`object_relations` with no domain-specific attributes, and four of its seven
values were literally the same tokens. `inquiry_thread_note_links` pointed at
`notes.object_id` — one endpoint was already an ontology object. Both existed
only because Thread was not a `space_objects` row.

**The Language layer had three conflicting relation vocabularies** —
`object_relations` CHECK (15 values), `space_object_kind_relation_hints` CHECK
(18), `inquiry_thread_relations` CHECK (7) — mirrored in the protocol as two
unrelated enums. The consequence was a live defect: a hint could be declared
for a type `object_relations` would reject on write, and a real edge type
(`authored_by`) could not have a hint at all. Nothing detected the drift.

**Type membership was recorded in three unaligned lists** —
`CONTENT_RESOURCE_DEFINITIONS` (table granularity),
the `retrieval_object_type` enum (subtype granularity), and
`GraphProjectionRepository`'s assumption — operating at different granularity
and therefore impossible to cross-validate. Each new domain had to be added to
each, with no mechanism to catch an omission.

### Audit scope

This ADR's audit covered the Language layer: `object_type`, relation
vocabulary, and the type lists consumed by the read gate, retrieval, and graph
projection. Recording what it did *not* cover prevents the audit's silence
from being read as a clean bill of health.

**Deliberately separate, not drift.** Six of B12A's seven durable-link tables
are not competing with `object_relations`: `knowledge_item_sources` /
`claim_sources` are curated citation and evidence paths, `provenance_links` /
`evidence_links` are lineage and candidate association, `note_links` is UI
navigation with no graph authority, and `relation_source_links.link_type` is a
target discriminator, not a semantic vocabulary. Only
`inquiry_thread_relations` and `inquiry_thread_note_links` — which duplicate
`object_relations`'s columns *and* vocabulary — are absorbed.

**Four further type lists, resolved during implementation.**
`context_snapshot_items.item_type` and `cards.source_type` are entity lists and
became `ContextIncludable` / `CardSourceable` declarations, each keeping the
stored token separate from the entity type because the stored strings differ.
Two of their members were not entities at all: `manual_context` is a sentinel
for inline text, and `idea` had no table and no writer, so it was dropped.
`provenance_links.source_type` was not examined initially and turned out worst
— the list existed four times and two copies silently dropped what they did
not recognise; audited 2026-08-06 and settled as `ProvenanceSourceable`.
`evolution_strategy_assets.target_type` is **not** an entity list and stays
independent: its members name evolvable asset kinds and `system` is a query
wildcard, so modelling it as an interface would force non-entities into the
registry to satisfy a surface resemblance.

**`memory_relations` was missed entirely.** Found 2026-08-27. It is a fourth
relation vocabulary with a live 8-value CHECK overlapping `object_relations`
in five values, unconstrained polymorphic endpoint columns, one writer and no
reader. It is not absorbed — `memory_entries` is an independent root, so its
edges cannot live in `object_relations` — and its disposition is deferred.
Recorded in `architecture/ONTOLOGY.md` §8 so the next audit does not
rediscover it.

### Comparison basis

The reference model is the Palantir Foundry Ontology's Language / Engine /
Toolchain decomposition. The Action and Security columns are already met or
exceeded here (`SYSTEM_ACTION_REGISTRY` carries denser metadata than a Foundry
Action Type; proposals are a first-class reviewed entity rather than
submission criteria embedded in an action). The Data column is where this
system diverges and the Language layer is where the divergence is fixable.

## Decision

### 1. The root is an identity-and-governance root, not a lifecycle root

`status` leaves `space_objects`; each extension table owns its own status
column and state machine. `ck_space_objects_status` and
`ck_space_objects_status_by_type` are removed, and the `space_object`
`activePredicate` moves from `status <> 'deleted'` to `deleted_at IS NULL`,
matching every other entry in `CONTENT_RESOURCE_DEFINITIONS`.

Retrieval projection and proposal governance are **capabilities a type may
implement**, not an entry fee for joining the root.

### 2. Field placement rule

A field belongs on the root only if a **cross-domain mechanism reads it**.
"Every domain has this field" is not a reason.

**The root must not carry constraints that branch on `object_type`.** The root
is ignorant of its subtypes. This is the rule that lets a new domain join
without editing a shared table, and it is why decision 10's Project-scope
invariant is enforced outside the database.

### 3. Governance belongs to the edge, not to the table

A declaration names the link type, its legal endpoint object types, and
whether its writes are direct or proposal-gated. `object_relations` is no
longer a table-level proposal-gated surface.

Governance is keyed on **link type *and* endpoint pair**, not link type alone.
Recovering Inquiry Thread showed why: `supports` between two Threads is
working structure a user drags into place and must stay a direct write;
`supports` between two Claims is a semantic assertion that must stay reviewed.
Keying on the word alone would force one of them to change behaviour, and
inventing `thread_supports` to avoid that would split one semantic relation
into two words every cross-domain query then has to match — the duplication
this ADR exists to remove. A link type may therefore carry several
declarations; the most specific endpoint match wins, with `any`/`any` as
fallback.

The `ontology` module owns `space_objects`, `object_relations`,
`space_object_profiles`, and `space_object_profile_relation_hints`.
`knowledge` becomes an ordinary domain on top of it and gives up sole-writer
status. Domains keep their own write sites and call the shared endpoint/
governance check; where a concern genuinely spans both (proposal creation,
Claim lookup) it is passed in as an explicit seam rather than duplicated or
absorbed. Without that boundary the ontology module would accumulate every
domain it indexes.

### 4. What joins the ontology

Two questions, in order.

**Does the domain join the ontology at all?** Only if its objects need to
participate in cross-domain **semantic relations**. Inquiry Thread,
Experiment, and Decision Case do. Task, Run, Proposal, and Artifact do not:
they are the execution and output spine, and what connects them is an
**execution binding** — *which work advanced which thing* — not an assertion
about the world. Execution bindings have their own tables (`task_runs`,
`task_artifacts`, `task_proposals`, `task_entity_links`), their own
vocabulary, and their own readers.

*Added 2026-08-27.* This question was left implicit, and its absence made the
second question below read as a universal test. Under that reading `task`
qualifies — it has independent identity, is referenced by other domains, and
has its own visibility — while decision 6 lists it as an independent root. The
two were not in conflict; the scope qualifier was missing.

**Within a joining domain, which of its tables become objects?** Only
aggregate roots: independent identity, referenced by other domains, or needs
its own visibility. Revision histories, event streams, per-user state, and
internal configuration are internal structure of an aggregate, not objects.

Applied to Inquiry's 13 tables: `inquiry_threads` joins;
`inquiry_thread_relations` and `inquiry_thread_note_links` are deleted and
their edges move into `object_relations`; the remaining ten stay
domain-private. Experiment and Decision Case aggregate roots join on the same
basis.

### 5. Definition authority is code, and the registry is open

`object_type`, `link_type`, governance level, and endpoint constraints are
declared in code registries that modules **register into** at boot — core
domains register core types, plugins register their own. This preserves
compile-time checking while keeping the ontology extensible by third-party
modules through the existing PluginHost path.

Closed-set validation moves from database CHECK constraints to the
application-layer registry; the database keeps only format constraints. The
existing CHECKs are demoted rather than extended, because three mutually
inconsistent CHECKs already failed to catch drift and were therefore not
functioning as a second line of defence.

**A demoted constraint with no replacement is strictly worse than the
constraint it replaced.** Demotion is conditional on the registry actually
being asked, and on a test asserting it rejects everything the CHECKs used to
reject.

The code/data boundary is explicit. Behaviour-determining definitions live in
code — each requires an implementation to honour it. Presentation- and
organisation-determining definitions live in data — their absence degrades
presentation, not correctness.

### 6. Entity registry and Interface as an explicit primitive

**The registry's subject is an Entity, not only an ontology object.** An
Entity is anything the system can reference, gate, project, or cite:
`space_objects` subtypes *and* independent roots. This is not a new idea here
— `CONTENT_RESOURCE_DEFINITIONS` already spans exactly that mixed set.
Unification does not require every domain to become a `space_objects` row; it
requires one registry in which `space_objects` is one kind of entity.

An Entity declares which interfaces it implements. **Declaration granularity
is chosen by the interface, not fixed globally**: `ContentAccessible` is
declared once for the root and inherited by subtypes because the read gate
reads root columns, while `Retrievable` is per `object_type` because adapters
genuinely differ.

Every per-mechanism type list converges onto these declarations. A test
asserts that every registered Entity implements every interface it declares,
and that no per-mechanism type list exists outside the registry.

Two further per-type declarations were added while implementing this, both
because a polymorphic mechanism needed to know something per type and the
alternative was another hardcoded list: `requiresProjectScope` (decision 10)
and `domainStatus` — Inquiry Threads vanished from the generic graph exactly
once because such a hardcoded list existed and did not include them.

### 7. Multi-user scope

Targets: multiple users sharing one deployment, self-hosted deployments, and
third-party plugins extending the ontology through code. Does **not** target
user-facing self-service modelling, which would additionally require a generic
UI renderer and generic CRUD appliers.

### 8. Action types bind to object types

`SystemActionDefinition` carries an optional `applies_to: ObjectType[]`, and
`systemActionsForObjectType()` is the lookup a surface uses to ask what
applies to an object it is rendering. Actions that do not operate on a single
object leave it unset.

The binding was deferred at first because nothing in the registry operated on
an ontology object, then landed with its first three definitions
(`note.promote_to_knowledge`, `note.raise_as_question`,
`note.link_to_evidence`).

Two things were learned in that round and are worth keeping:

- Registering an action requires naming a policy action. That is a
  **registration requirement, not a governance gain** — a `reserved` action
  that no code path evaluates gates nothing, and who performed the write is
  already on the canonical row. The first attempt claimed it "buys
  auditability"; that reasoning did not survive checking.
- Adding an object-bound action does **not** widen the agent surface. The tool
  gateway admits a definition only when it is `agent_tool` visible *and* lists
  `agent` as an actor. Making one agent-callable is a separate product
  decision, now guarded by a test rather than by the field being unused.

The Inquiry next-step advice vocabulary is wired to real destinations rather
than display strings, but the entry point is resolved on the **client**: a
server-side focus-kind-to-href map made the server a second authority over web
routes and four of its seven hrefs named routes the app does not have. Advice
never writes work state directly; adoption goes through the ordinary work-state
command. See `modules/` Inquiry documentation for the current shape.

### 9. Naming

Terms align to ontology vocabulary only where the semantics genuinely match
after this ADR's changes: `relation_type` becomes `link_type` (endpoint types
become declared and constrained, so the term becomes accurate);
`space_object_kinds` becomes `space_object_profiles` (removes a `type`/`kind`
near-synonym ambiguity); `Interface` is a concept the system did not have.
`object_type`, `SYSTEM_ACTION_REGISTRY`, and Proposal are unchanged —
`GLOSSARY.md` records the deliberate non-equivalences so borrowed vocabulary
does not imply borrowed capabilities.

### 10. Safety requirements carried by the migration

**`primary_project_id` must be non-null for Project-owned aggregates.** The
scope predicate is `(project IS NULL OR projectReadAccess)`, so a null Project
does not narrow access — it removes the Project gate entirely and leaves only
visibility. A forgotten Project is a silent disclosure, not a stricter
default.

*Corrected 2026-08-27.* This originally said the invariant is "enforced by
constraint, not by convention". That is not implementable alongside decision
2: the constraint would have to name which subtypes are Project-owned, and the
root may not branch on `object_type`. The implementation enforces it at a
single write path instead, and the ADR text was simply never updated to say
so.

The enforcement is therefore: **one writer, plus a test that no second writer
appears.** `spaceObjectWriter.ts` is the only builder of
`INSERT INTO space_objects` (it consolidated 11 hand-written inserts) and
rejects a Project-owned entity without a Project; a source-scanning test
asserts no other file in `src/` contains that statement. A single chokepoint
without such a test is convention, which is what the original wording rightly
rejected — the test is what makes it enforcement. The same pattern applies to
any future table with the same invariant.

Remaining requirements:

- Recovered Threads default to `visibility='space_shared'`, preserving current
  collaboration semantics. Defaulting to `private` would silently change
  behaviour.
- The graph/relation projection must not expose pre-filter counts. Unifying
  edges into one table concentrates this requirement in one projection layer.
- Root `title` is a projection; the domain field is the truth. The owning
  domain writes it in the same transaction.

## Consequences

- `BOUNDARIES.md` B12A is rewritten (`object_relations` ownership and
  per-link-type governance) and B12C is replaced; ontology rules are added for
  field placement, ontology membership, and the code/data boundary.
- ADR 0011 is rewritten to its remaining scope. Its Workflow node extension,
  database-reset cutover, and registered Overview/Attention adapter decisions
  carry forward unaffected.
- Inquiry gains per-object visibility, which it did not have. This is a
  capability increase and requires the default above.
- `graphService.getCombinedProjectGraph`'s manual union of two projections is
  removed once Threads are ontology objects.
- Schema changes use the existing full-environment reset. No legacy-row
  migration path is built.
- Current-state description moves to `architecture/ONTOLOGY.md`. This ADR is
  no longer the place implementation changes are recorded — which is what
  drove it to six layered amendments and let two of its statements drift from
  the code without anyone noticing.

## Non-Goals

- Dynamic schema packs, or moving ontology definitions into per-space data.
- An Object Set query language, a typed client SDK, or Workshop-style
  application construction from the ontology.
- Ontology branching, releases, or staged rollout. The cutover is a database
  reset.
- Converting capabilities/prompts into ontology-bound Functions.
- Renaming `SYSTEM_ACTION_REGISTRY` or Proposal to Foundry vocabulary.
- A second generic relation table, or dual-writing any semantic edge.
- User-facing self-service modelling. If ever adopted, the migration path is
  to seed registry entries as data rows, not to move the registry into data.

## Revision history

- **2026-08-04** — accepted.
- **2026-08-05 / 08-06 / 08-12** — decision 3 keyed governance on endpoint
  pairs as well as link type; decision 8's binding half landed and its
  "auditability" and "agent surface" reasons were both corrected; the advice
  entry point moved to the client.
- **2026-08-27** — rewritten. Current state extracted to
  `architecture/ONTOLOGY.md`; six layered amendments folded into the decisions
  they modify; three defects fixed: decision 4's missing scope question,
  decision 10's unimplementable enforcement claim, and `memory_relations`
  missing from the audit scope.
