# ADR 0015: Focus Area As Classification, Not Scope

Date: 2026-08-16

## Status

Accepted - 2026-08-16

Touches [ADR 0011](0011-inquiry-domain-model.md) and
[ADR 0012](0012-ontology-ownership-and-language-alignment.md) only in
vocabulary: this decision takes care not to reuse the word those ADRs already
own. Nothing in them is superseded. [ADR 0006](0006-plugin-module-architecture.md)
keeps sole authority over modules.

## Context

A user's durable work has two shapes and the system only models one of them. A
Project has an end state; it is finished and archived. But "my finances", "my
health", "Rust" have no end state — they accumulate. Today the material that
belongs to such an area is scattered: notes in one place, knowledge items in
another, the Projects worked on for it in a third, with nothing joining them.

The obvious framing is wrong, and this ADR exists partly to rule it out. Making
a focus area a second scope beside Project — participating in the content read
gate, owning members, generalising `contentScopeSql()` — treats an organising
device as an access boundary.

Access is already decided by one predicate with five conjuncts: active Space
membership; the scope term (`contentScopeSql()`, today Project and Project
Folder, plus the project-share widening); `visibility`; `access_level`; and a
final disjunction of the ways a reader may qualify — being the owner, the object
being space-shared, holding a `content_access_grants` row, or the oversight
override that [ADR 0013](0013-personal-team-content-boundary.md) owns.

**Project scope is one of those conjuncts.** That is exactly what a focus area
must not become: adding a second organising concept to this predicate would not
add safety, it would add a second place where "who can see this" is decided.

## Decision

**1. A focus area is a user-created durable aggregation.** It aggregates what
already exists — Projects, Notes, Knowledge — and produces no data of its own.
Creating one is a few clicks; it needs no code, no migration, no deployment.

**2. Three concepts, told apart by who creates them and when.**

| | Created by | When | Deliverable |
|---|---|---|---|
| Module | a developer | build time | code: an in-tree `ServerModule`, or an official optional plugin (`migrations` + `server` + `web` + `plugin.json`) |
| Project | the user | run time | a row; has an end state |
| Focus area | the user | run time | a row; has no end state |

Bookkeeping needs double-entry, accounts and balances; journalling needs a
timeline. Those are real domain models, so they are modules — whether shipped in tree or
as an optional plugin, both of which ADR 0006 governs. Learning Rust needs no code — it needs a durable place to put
notes. That is a focus area.

**3. A focus area does not participate in access control.** It is a
classification. `contentScopeSql()` is not extended, a focus area has no member
roster of its own, and pointing content at an area changes who can read it by
exactly nothing.

**4. A focus area may be empty, and content may point at none.** Unclassified
content is a legal state, not a defect awaiting cleanup. Inbox is the view over unclassified
material, not a third kind of container.

**5. A Project may point at a focus area.** That is aggregation for navigation.
It is not containment, and it transfers no read access: being able to read a
focus area's page tells you nothing about the Projects listed on it, each of
which keeps its own `project_members` roster.

**6. A module is not a focus area, and a focus area gains nothing by "binding"
one.** A module's data lives in the module's own tables and is reached through
the module's own surface.

**7. The internal identifier is `focus_area`. Product language remains
"Domain".**

Decision 7 is the one that will look arbitrary later, so its reasoning is
recorded here rather than left to be rediscovered.

`domain` is already this codebase's DDD vocabulary. ADR 0011 and ADR 0012 use
"domain aggregate roots", "domain-internal tables", "domain fields" and "domain
shapes" for Inquiry Thread, Experiment and Decision Case. The word also appears
as `plugins/official/*/server/src/domain/` directories — inside the two modules
a reader would first associate with this feature — as `RetrievalToolDomain` and
`SourcePostProcessingRetrievalDomain`, and as `source_items.source_domain`, a
hostname.

Naming a classification field `domain` does not merely risk confusion. It
attaches an entire framework: aggregate-root discipline, ontology membership,
and the access governance that follows from both. That is not hypothetical —
the specification that preceded this ADR did exactly that, describing the
concept as "a first-class long-term Scope" and planning to generalise the
content governance interface to accommodate it.

`ContextScope`, the alternative that specification proposed, is worse on two
counts: it collides with `workContextScopeId` (104 references under `server/src`, on the
execution path, meaning a run's work context rather than any content scope), and
the word
"Scope" asserts precisely the access boundary decision 3 denies.

`focus_area` says what the thing is, collides with nothing, and carries no
inherited framework.

## Consequences

- The implementation is a thin table, two nullable pointers
  (`space_objects.focus_area_id`, `projects.focus_area_id`), an aggregation
  view, and a navigation entry. No access path changes.
- Every existing content read predicate must be unchanged, demonstrated by the
  existing suite passing unmodified.
- Deciding whether something is a module or a focus area is now a question with
  an answer: does it need code.
- A focus area cannot express "this content is more sensitive". That is
  `visibility` and `access_level`, as it already was.
- Should a focus area later need to carry durable semantics — a knowledge
  background an agent loads when working in that area, for instance — that is a
  new decision on top of this one, not an extension implied by it.

## Non-Goals

- Not a second access scope. Decision 3.
- Not a container: content points at a focus area, it does not live inside one,
  and a focus area does not own what points at it.
- Not hierarchical. A Project pointing at an area is a pointer.
- Not a module host. Decision 6.
- Not a replacement for tags. A focus area is single-valued and has identity —
  a name, a description, a lifecycle. Tags are neither.
