# ADR 0012: Ontology Ownership And Language-Layer Alignment

Date: 2026-08-04

## Status

Accepted.

Supersedes the original 2026-07-23 separation of Project-domain roots and
relationships in [ADR 0011](0011-inquiry-domain-model.md). The current ADR 0011
already reflects this decision and governs the domain-specific application.
This statement does not supersede its current aligned decisions 1–3.

Current state of the implemented ontology lives in
[`architecture/ONTOLOGY.md`](../architecture/ONTOLOGY.md). This document holds
the decision and its reasoning only; implementation changes update that document. Changes to an accepted decision
update its scope/status and affected ADR references as well.

## Context

A shared root should centralize identity and governance without absorbing
individual domains' data or lifecycle. Separate Project-domain roots had
duplicated identity columns while omitting visibility and provenance; separate
link tables duplicated `object_relations`. Conversely, subtype-dependent root
constraints and table-wide proposal gating coupled otherwise independent domains.
The decision removes those couplings rather than splitting the shared authority.

Registry declarations replace divergent per-mechanism type lists. The distinction
between ontology objects and other entities is essential: execution bindings,
curated evidence, UI navigation, and memory relations are not interchangeable
semantic edges and are not absorbed merely because they link two records.
`memory_relations` remains outside the ontology with its disposition deferred;
see [ONTOLOGY §8](../architecture/ONTOLOGY.md). Evolvable asset kinds likewise
are not entity types and must not be forced into an Entity interface.

The vocabulary is informed by the Foundry Language / Engine / Toolchain
separation. Borrowed terminology does not imply feature parity or transfer
Rainver's policy and proposal authority to another model.

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
  data-preservation boundary, and registered Attention adapter decisions
  remain in ADR 0011. Project Mode wording is governed by ADR 0019.
- Inquiry gains per-object visibility, which it did not have. This is a
  capability increase and requires the default above.
- `graphService.getCombinedProjectGraph`'s manual union of two projections is
  removed once Threads are ontology objects.
- Schema changes follow [BOUNDARIES B59](../BOUNDARIES.md): a baseline reset
  is conditional on having no data to preserve and requires authorization for
  any deletion. Otherwise use a migration that preserves existing data.
- Current implementation detail belongs in `architecture/ONTOLOGY.md`.

## Non-Goals

- Dynamic schema packs, or moving ontology definitions into per-space data.
- An Object Set query language, a typed client SDK, or Workshop-style
  application construction from the ontology.
- Ontology branching, releases, or staged rollout. Data preservation still
  follows B59; this non-goal grants no reset permission.
- Converting capabilities/prompts into ontology-bound Functions.
- Renaming `SYSTEM_ACTION_REGISTRY` or Proposal to Foundry vocabulary.
- A second generic relation table, or dual-writing any semantic edge.
- User-facing self-service modelling. If ever adopted, the migration path is
  to seed registry entries as data rows, not to move the registry into data.
