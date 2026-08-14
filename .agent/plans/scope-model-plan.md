# Scope Model Plan

Date: 2026-08-13
Status: BLOCKED ON ADR

## Purpose

Raise Domain to a first-class long-term Scope alongside Project, and generalize
the content governance interface that is currently written against Project only.

The user-facing model this converges on:

> A user's long-term world has exactly two Scopes. **Project** has an end state.
> **Domain** does not. Everything else is an object, a relation, a lifecycle
> state, or a system capability.

Project already is such a Scope and is not being rebuilt. Diary and Finance are
already real product modules with their own schemas, services, jobs, and UI. The
missing piece is the layer between them: the thing that says "my personal
finances" as opposed to "the Finance feature is installed".

This is not a course correction. `PROJECTS.md` already defines Project as a
durable ownership boundary rather than a task manager or execution environment,
and ADR 0012 already established the aggregate-root discipline that this plan
applies one level up. What is proposed is the next step of the same idea, not a
replacement for it.

## Entry trigger

**An ADR must land first.** Two of its decisions determine what the code looks
like, and both are cheaper to settle in prose:

1. **Naming.** `Domain` already carries meanings in this codebase (below). The
   ADR decides which name the internal model uses.
2. **Whether Scope is a security tenant.** It must not be. Space remains the
   isolation boundary; Scope organizes and gates content within a Space. If that
   is not written down first, the generalized read gate will drift into a second
   tenancy model.

This plan is independent of [runtime-routing-plan.md](runtime-routing-plan.md)
— different files, no shared surface. It should not run concurrently with that
plan: this is the deepest change in the current plan set, it touches the read
path of every content type in the system, and the ontology it re-cuts landed on
2026-08-04/05 and has not yet been exercised by sustained real use. The managed
execution work that previously shared this scheduling warning completed on
2026-08-14.

## Current implemented baseline

Verified against `master` on 2026-08-13.

### Project is already a Scope

`space_objects` carries `owner_user_id`, `primary_project_id`,
`project_folder_id`, `visibility`, `access_level`, plus presence columns
(`archived_at`, `deleted_at`) and deliberately no `status`. `primary_project_id`
has its own index and a composite FK to `(projects.id, projects.space_id)`.

`db/spaceObjectWriter.ts` enforces it:

```
if (entity.requiresProjectScope && !input.primaryProjectId) throw
```

Four ontology object types declare `requiresProjectScope: true` in
`ontology/entities.ts` — inquiry thread, decision case, experiment, research
workflow.

`space_object_project_shares` widens the scope half of the read predicate
without touching visibility or grants, and is documented as doing exactly that.

### Domain does not exist anywhere

A repository-wide search for `domain_id`, `ScopeKind`, or `ContextScope` returns
nothing. (`source_quota_buckets.scope_kind` is a rate-limiting key and unrelated;
`policy/executionControlSnapshots.ts` has `workContextScopeId`, which is a run's
work context, also unrelated.)

### Diary and Finance are Modules without Domains

- `diary_entries` columns: `id`, `user_id`, `entry_date`, `content`,
  timestamps. No `space_id`, no scope of any kind. Diary data is user-global.
- `finance_books` columns include `space_id` and `created_by_user_id`. The
  aggregate top is `FinanceBook`; there is nothing above it.

So the system today has a Finance app and no Finance domain, and a Diary that
does not sit inside any Space at all.

### The governance interface is project-shaped but single-authority

This is the finding that makes the change tractable rather than sprawling.

`ontology/entities.ts` declares `projectColumn` once per content-accessible
entity — 15 declarations, one file. `access/contentAccessRegistry.ts` derives
`ContentResourceDefinition` from that registry on every read (deliberately not
snapshotted, so plugin-registered entities are visible). `contentScopeSql()` in
`access/contentAccessSql.ts` builds the scope predicate in **one place** for all
of them, with the share term appended only for resources that declare one.

`usage/attribution.ts` and `proposals/egressReviewApplier.ts` each read
`projectColumn` for their own SQL as well.

The generalization is therefore a change to one declaration field, one predicate
builder, and two additional readers — not a change to 15 tables. That is the
whole reason ADR 0012's registry consolidation was worth doing, and this plan
gets to spend it.

### Plugin enablement scope is a different axis and will be confused with this

`OfficialPluginScope = "space" | "user"` in `packages/protocol/src/plugins.ts`.
Diary declares `scope: "user"`, Finance declares `scope: "space"`.

That field answers **who decides whether the module is turned on**. It does not
answer where the data lives. Once `ContextScope` exists, the two will look like
members of the same enum and someone will merge them. Rename or document
whichever survives, and state the distinction in the ADR.

### The naming problem is worse than "Domain is taken"

Four live meanings already:

| Usage | Where | Meaning |
|---|---|---|
| `domain/` directory | `plugins/official/diary/server/src/domain`, `plugins/official/finance_ledger/server/src/domain` | DDD layer |
| `RetrievalToolDomain`, `SourcePostProcessingRetrievalDomain` | sources, retrieval | tool/content grouping |
| `source_domain` | sources | a hostname |
| prose "domain event", "domain command" | inquiry and elsewhere | DDD |

The first one is the trap: the DDD `domain/` directories live inside precisely
the two modules that would back the first two user Domains. `diary/server/src/domain/repository.ts`
would sit next to a Domain binding meaning something entirely different.

`Area` is equally unavailable — 15 web files use `*AreaPage` / `*AreaLayout` for
Project Areas.

**And `ContextScope` collides with something already on the runtime path.**
Added 2026-08-14. `policy/executionControlSnapshots.ts` carries
`workContextScopeId`, read in `runtimeContext/invocationSnapshotService.ts`,
`runtimeContext/managedRenderer.ts` and `runs/orchestrationService.ts`. It
resolves a room recipient, session or task — a run's *work* context, genuinely
not a content scope, so the model below is unaffected. The collision is in the
name, and this plan is the one arguing that names are the risk here.

The live hazard is not present-day confusion between the two; it is what
happens next:
once Domains exist, "this run belongs to a Domain" becomes a natural request,
and `workContextScopeId` will look like where it goes. The ADR must state that
work context and content scope are two axes, and that a Domain-bound run
carries a `ContextScope` reference rather than a Domain id smuggled into
`workContextScopeId`. This is the same trap as `OfficialPluginScope`, which the
plan already writes down — the difference is only that this one is on the
execution path.

**Recommendation for the ADR:** the product language stays **Domain**, because
it is the right word for the user. The internal model is `ContextScope` with
`ScopeKind = "project" | "domain"`. No type, service, or column is named
`Domain*`.

## Work

### 1. ADR

Decides: naming per above; Scope is not a security tenant; Scope root carries
only identity, Space, ACL, visibility, and lifecycle presence while Project
Kernel and Domain aggregate keep their own extensions; enablement scope is not
context scope; Inbox and Archive are lifecycle states rather than a third Scope.

That last one is load-bearing. Without it, the first unclassified capture will
motivate a third top-level container, and the two-Scope model stops being a
model.

Amend rather than supersede where an existing ADR conflicts — ADR 0011's
project-ownership decision and ADR 0012's ontology decisions are both touched.

### 2. A thin Domain aggregate

Identity, `space_id`, name, purpose, status, visibility, ACL. Nothing else.

Specifically no `domain_type` enum and no per-domain special fields. A
`domain_type = "finance"` column that makes Finance behave differently is the
mechanism by which this model would become as rigid as the thing it replaces.
Module capabilities reach a Domain through a binding table, not through the
Domain's own type.

### 3. Generalize the scope governance interface

Rename the declaration and widen the predicate:

```
projectColumn      →  primaryScopeColumn   (+ the scope kind it holds)
requiresProjectScope  →  requiredScopeKinds
projectShare       →  scopeShare
```

`contentScopeSql()` gains a Domain branch beside its Project branch. The
existing comment about not emitting `OR false` for undeclared resources applies
identically to the new branch: a resource that declares no Domain scope must
produce the predicate it produces today, unchanged, so that this does not add a
branch to every content read in the system.

**Do not add `domain_id` to `space_objects` or to any domain table.** The
generalization is of the interface, not a duplication of the column. Whether the
root gains one nullable `primary_scope_id` replacing `primary_project_id`, or
keeps `primary_project_id` and adds a sibling, is a real design choice to make
during implementation with the FK and index cost in view — but "one column per
Scope kind" is not one of the options.

`usage/attribution.ts` and `proposals/egressReviewApplier.ts` follow the same
rename.

### 4. Bind Diary and Finance as the first Domain Modules

No business table is rewritten. `finance_books` and `diary_entries` keep their
shapes; a binding is established between the module aggregate and a Domain.

Diary's missing `space_id` is a real prerequisite and belongs to this step: a
Domain lives in a Space, so user-global diary data cannot be bound to one until
it has a Space. Since the working rules record that there is no historical data
to preserve, this is a schema edit to final shape rather than a migration.

Do not require users to create a Domain before using a module. Enabling Finance
binds a default Personal Finance Domain; Domain surfaces appear when a user has
reason to organize, not as a mandatory setup step.

### 5. Scope contribution model

The back end already has the pattern — `projects/attentionRegistry.ts` plus the
per-module `projectIntegration.ts` files (decisions, tasks, inquiry,
automations) — so Project Overview aggregates registered adapters rather than
querying domain tables. Generalize that registry from Project to Scope so a
module can contribute overview cards, attention items, and navigation surfaces
to a Domain the same way.

### 6. Front end follows

Two hardcodings, both real today:

- `ProjectAreaLayout.tsx` declares `groups` as a four-group, fifteen-item
  `as const` literal. Every Project shows Inquiry, Research, Experiments,
  Knowledge review, Delivery, and Operations from birth. Make areas contributed,
  with `primary_mode` deciding emphasis and data presence deciding visibility.
  The back end is already contribution-based; only the front end is not.
- `apps/web/src/modules/registry.ts` registers `diary` and `finance` as
  top-level app entries beside `projects`, `tasks`, and `knowledge`. Adding
  Health, Pets, and Travel the same way produces an app launcher. Navigation
  becomes Home / Inbox / Projects / Domains / Knowledge / Agents, with modules
  reached through the Domain they serve. Shortcuts may remain; the architectural
  first-class position does not.

Step 6 is separable and may land after 1–5.

## Non-goals

- Not rebuilding Project. Its current shape is what this model wants.
- Not rebuilding the ontology. `space_objects`, `object_relations`, and the
  entity registry stay; only the scope governance interface generalizes.
- Not making Scope a security boundary. Space remains the isolation boundary.
- Not adding a third Scope. Inbox and Archive are lifecycle states.
- Not adding new Domain Modules. Diary and Finance are the dogfood; Health,
  Pets, and the rest are what the model exists to make cheap later.
- Not touching Capabilities. That is
  [capability-shrink-plan.md](capability-shrink-plan.md).

## Completion gate

1. ADR landed, with the naming decision, the not-a-security-tenant decision, and
   the work-context-versus-content-scope decision all explicit.
2. A Domain can be created, and an object can be scoped to it, with the read
   gate honoring it.
3. An object scoped to a Domain is unreadable to a non-member on the same
   predicate path that already enforces Project scope — verified against the
   generated SQL, not only against a service-level test.
4. An object scoped to a Domain **is** retrievable by an entitled member through
   the agent retrieval path. Added 2026-08-14: `RetrievalSearchService` reads
   only the derived `retrieval_*` projection and delegates live revalidation to
   the registered domain adapter, which goes through `contentReadSql`. That
   makes over-inclusion safe — revalidation subtracts — but leaves
   under-inclusion invisible: a projection that does not know about Domains
   drops Domain content silently while every access-control test stays green.
   Gate 3 tests the negative direction only, and the positive direction is the
   one an agent experiences.
5. A resource declaring no Domain scope produces a byte-identical predicate to
   the one it produces today.
6. Diary and Finance each bound to a Domain, with no business table rewritten
   and no `domain_type` special-casing.
7. Enabling a module without creating a Domain still works.
8. No identifier named `Domain*` in the internal model.
9. `.agent/architecture/` updated in the same change — at minimum `PROJECTS.md`,
   the ontology document, `GLOSSARY.md`, and
   `FRONTEND_INFORMATION_ARCHITECTURE.md`.

## Dependencies

- Requires: the ADR. Nothing in code.
- Blocks: nothing. Deliberately sequenced after the runtime work rather than
  blocked by it.
