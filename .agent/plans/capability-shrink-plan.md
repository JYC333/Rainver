# Capability Shrink Plan

Date: 2026-08-13
Status: IN PROGRESS — item 1 completed; items 2–7 remain unscheduled

## Execution status

This run schedules item 1 only. Items 2–7 retain their existing triggers,
dependencies, and phase boundary. Overall base: `14d32114`.

| Item | State | Reviewers | Findings | Commit |
|---|---|---|---|---|
| 1 — authority documents | completed | 2 completed | 2 major, 2 minor | `a0c1e5c4` |
| 2–7 | not scheduled in this run | | | |

External-review consent is run-scoped to item 1's four authority documents and
its execution ledger, the runtime-boundary Phase 5 implementation, and the final
combined range plus relevant repository context. The user's explicit invocation
of `$phase-gated-implementation` authorizes the required discovery, closure, and
integration review transmissions. No push, PR, deployment, destructive cleanup,
or capability-shrink item 2–7 implementation is authorized.

Item 1 base: `14d32114`. Its owned paths are ADR 0009,
`CAPABILITY_WORKFLOW_SKILL_SYSTEM.md`, this glossary, the higher-precedence
capability clauses in `BOUNDARIES.md`, and this compact execution ledger.
Acceptance is that these authorities agree: the imported package is the source
of truth for skill content; agent-space owns provenance, trust,
policy, binding, pinned delivery, and audit; package declarations never grant a
tool, hook, or MCP authority; Runtime Context Delivery remains mandatory; and
the still-present normalization/conversion code is named as transitional rather
than falsely described as removed. Intended commit title:
`docs: amend skill content authority`.

Item 1 readiness: the authorities now agree on package content authority,
agent-space control-plane ownership, the Skill/System Action/Workflow split,
mandatory Runtime Context Delivery, and untrusted package declarations. The
architecture document explicitly names `NormalizedSkill`, conversion, current
capability bindings, and normalized renderers as transitional implementation so
this documentation-only item does not claim items 2–7 have landed. No code,
schema, protocol, route, or runtime behavior changes. Verification: complete
scoped diff inspected; terminology search inspected; `git diff --check` passes.

| Invocation ID | Role | State | Remote session | Result |
|---|---|---|---|---|
| CS-ITEM1-DISCOVERY | discovery | completed | `01a001db-6317-7432-a75a-a66b97f0ad9c` | 2 major: B21 contradicted the amended authority; glossary stated target binding semantics as current |
| CS-ITEM1-CLOSURE | closure | completed | `01a001df-77e2-73a0-b627-73eb6ac962ab` | both major findings closed; 2 minor ledger inconsistencies repaired before commit |

## Purpose

Stop maintaining an agent-space-native skill standard. Keep the parts that are
genuinely agent-space's: where a skill came from, which version, what it asks
for, who approved it, which agents may use it, and which snapshot a run used.

The position to move to:

> An external Agent Skill package is the source of truth for its own content.
> Agent-space owns provenance, trust, policy, and binding — not a canonical
> re-representation of the skill.

And a boundary that must survive the shrink, because it is the thing most likely
to be lost by treating "capability" as a single word:

> **Skill** = a procedure a model should follow.
> **System Action / Tool** = something the model can invoke that mutates
> agent-space state, gated by `agentToolGateway` and policy.

The first is content and should be external. The second is agent-space's own
API and must stay owned, versioned, and gated. Today both live under
"capabilities" and that is the source of the confusion.

## Entry trigger

The managed-execution prerequisite was satisfied on 2026-08-14. The whole plan
may now be pulled in one block when scheduled.

**Reviewed 2026-08-14 and left intact.** An earlier revision of this section
split the trigger per item and scheduled items 1 and 3 between the replatform's
P1+P2 and P3, on the claim that amending ADR 0009 was a prerequisite of its P4.
**That claim was false.** The managed loop path — `managedRetrievalTools.ts`,
`managedApiAdapter.ts`, `agentToolGateway.ts`, `runtimeHost/service.ts` —
contains no skill reference at all. Skills enter upstream at
`runtimeContext/productionAcquisition.ts` and are already inside the accepted
Delivery before a loop runs, so P4 neither reads a skill nor has cause to read
these documents.

What survives the correction is smaller and does not justify splitting the plan:

- Items **1** (amend ADR 0009 and its two architecture documents) and **3**
  (delete the dead pack/template layer) genuinely carry no dependency. If an
  idle window appears they can be pulled forward at no cost.
- The documents being wrong is a **latent** hazard rather than an active one.
  They misdirect any agent doing capability-adjacent work, and none of the
  replatform's remaining phases — pricing deletion, the loop, OAuth, a usage
  column — is capability-adjacent.

Two context switches to close a hazard that nothing between here and there can
trigger is a worse trade than carrying it. Item 1 still runs first *within* this
plan, for the reason its own section gives.

The dependency for the rest is not organizational. `SkillBinding` has to describe
how an approved skill reaches a runtime, and today no runtime in this instance
consumes a skill at all — no CLI is installed, and the managed path renders
skills into prompt text. Designing the binding shape before one real agent
runtime consumes one real skill means designing against the renderers, which is
what produced the current shape. Item 6 additionally rewrites the caller of
`runtimeContext/gateway.ts`, which P4 also touches; running them together
invites a merge conflict in the one place this plan calls its most important
compatibility surface.

Items 2 and 4–7 are also deliberately not concurrent with
[scope-model-plan.md](scope-model-plan.md). These are two separate convergences —
one on the harness boundary, one on the scope model — and running them together
means two large refactors landing against each other's tests.

## Current implemented baseline

Verified against `master` on 2026-08-13. `server/src/modules/capabilities/` is
4650 lines across 12 files.

### What is persisted

`capability_versions`, `capability_enablements`, `capability_runtime_bindings`,
`skill_sources`, `skill_packages`, `skill_package_files`,
`skill_local_overlays`, `project_workflow_profiles`.

### What is not persisted, and is already nearly empty

There is no `capability_packs` table and no `workflow_templates` table. Both are
code-only registries, and both are close to vestigial already:

- `workflowRegistry.ts` — `listBuiltInWorkflowTemplates()` returns
  `[...(registryOverrideForTests ?? [])]`. **In production this is an empty
  array.** Only tests populate it. This is the residue of removing the four
  label-only research workflow presets, and it was the right removal.
- `syncBuiltinWorkflows()` in `workflowAssets.ts` (184 lines) iterates that
  empty list on every sync.
- `packRegistry.ts` — one pack, `research`, whose `workflow_template_ids` is
  already `[]` with a comment recording the D2 rule that a preset is admitted
  only when it changes concrete behavior.
- `assertPackReferencesValid()` validates workflow template references that
  cannot exist in production.
- `registry.ts` (19 lines) lists built-in capability definitions, which are
  exactly the research pack's capabilities and nothing else.

So the "capability pack + workflow template" layer is one hardcoded pack, an
empty template registry, and the machinery to validate references between them.
Deleting it is far less risky than its 4650-line total suggests.

### Two parallel lifecycles over the same content

```
CapabilityStatus:    draft | proposed | testing | available | enabled | disabled | archived
SkillPackageStatus:  imported | reviewed | rejected | converted | archived | superseded
```

An imported skill traverses the second, is `converted`, and then traverses the
first as a different object. `skillImporter.ts` (625 lines) is largely that
conversion, and `NormalizedSkill` is its intermediate representation.

### The renderers

`runtimeRenderers.ts` (142 lines) exposes `renderClaudeSkill`,
`renderCodexSkill`, `renderGenericPromptSkill`, and `renderAllRuntimeSkills`.
`RuntimeRenderMode = "render_skill" | "inline_prompt" | "native_executor" |
"mcp_tool"`.

These are adapter glue and are fine as adapter glue. What is not fine is that
they render *from* a canonical agent-space representation, which is what forces
the conversion layer to exist.

### What must not be deleted

`runtimeSkillProvider.ts` (370 lines) is consumed by
`runtimeContext/gateway.ts` at two call sites — `PgRuntimeSkillProvider(db)
.loadCandidatesForRun(...)` — and by `productionAcquisition.ts`. Runtime Context
depends on it to decide which approved skills a run may receive. It narrows; it
does not go away.

### The architecture documents state the opposite position

`CAPABILITY_WORKFLOW_SKILL_SYSTEM.md` line 13: runtimes "are not the source of
truth for agent-space capabilities." `GLOSSARY.md` says the same of
`RuntimeSkillBinding`. ADR 0009 decides it explicitly.

This plan reverses part of that decision. Per the repo convention, **amend ADR
0009 in place with an `Amended` section** rather than writing a superseding ADR,
so there is one authority rather than two.

The amendment is narrower than "ADR 0009 was wrong". Its untrusted-import
posture — imports disabled by default, no script execution, no dependency
installation, vendor permission declarations treated as requests only — is
correct and is kept verbatim. What changes is one clause: agent-space stops
producing a canonical re-representation of skill *content*. Provenance, trust,
and policy remain agent-space's and become the whole of what it owns.

## Work

### 1. Amend ADR 0009 and the two architecture documents

Do this first, not last. The current documents are a live instruction to any
agent reading them, and code that contradicts them is worse than either.

### 2. Collapse to three persisted concepts

```
SkillPackage    source, version/commit/hash, files, license, metadata, risk scan
SkillBinding    scope (user | space | project | domain | agent), enabled,
                pinned version, runtime compatibility
SkillPolicy     requested permissions, granted permissions, trust/risk,
                approval state
```

`skill_sources`, `skill_packages`, and `skill_package_files` already carry most
of the first. The work is mostly in what stops existing around them.

One lifecycle, not two. `SkillPackageStatus` survives; `CapabilityStatus`'s
seven states do not apply to imported skill content.

### 3. Delete the pack and template layer

`packRegistry.ts`, `researchPack.ts`, `registry.ts`, `workflowRegistry.ts`, and
the pack/template routes in `routes.ts`, plus `CapabilityPackDescriptor` and
`WorkflowTemplate`.

`workflowAssets.ts` needs a decision rather than a deletion: `syncBuiltinWorkflows`
becomes dead with the registry, but `resolveWorkflowVersionId` and the
evolvable-asset integration may have live callers. Check before removing, and
keep whatever `project_workflow_profiles` genuinely needs — user-authored
workflow presets that change real configuration are the case ADR 0009's D2 rule
kept, and they stay.

The research capabilities themselves are not simply deleted. Each is either a
skill (content, becomes a `SkillPackage`) or a system action (becomes a
registered tool). Classify each one; do not let the pack's removal silently drop
a capability that Project Research depends on.

### 4. Drop the conversion layer

`NormalizedSkill` and the `imported_skill → CapabilityDefinition` path in
`skillImporter.ts` go. What the importer keeps is the part that is actually
agent-space's: fetch, hash, file inventory, risk scan, permission extraction,
and approval state.

The skill's own files remain the content of record. A run receives the package,
not a regenerated description of it.

### 5. Demote the renderers to adapter glue

`runtimeRenderers.ts` stays but renders from `SkillPackage` rather than from a
canonical definition. A runtime that needs a specific on-disk layout gets one
generated for it; that generated file remains an adapter artifact, which is the
one part of the current GLOSSARY wording that stays true.

If the Pi work shows that a runtime consumes the package directly with no
rendering at all, the corresponding renderer is deleted rather than kept
"for symmetry".

**"Directly" means without a canonical re-representation — not without a
Delivery.** Clarified 2026-08-14. Skill content is model-visible durable
context, so it reaches a run through Runtime Context Delivery on the same terms
as everything else the model sees, including the per-turn hash binding that
`deliveryAuthorizer.ts` verifies. What this plan deletes is agent-space's second
description of the skill; the authorization path that makes the skill's presence
in a prompt explicable afterwards is not part of the deletion.

### 6. Narrow `runtimeSkillProvider` to a binding resolver

Its job becomes: given a run, return the approved skill packages this run may
receive, at pinned versions, with their policy state. Not: own a skill execution
framework. The two `gateway.ts` call sites keep working across the change —
this is the compatibility surface that matters most in this plan.

### 7. Separate System Actions from Skills in the API and UI

`systemActions/agentToolGateway.ts` (590 lines) is already the right thing and
is not touched by this plan. What changes is that it stops being presented as a
kind of capability. The user-visible surface becomes two things — **Skills**
(imported, external content) and **Tools / System Actions** (agent-space's own
gated API) — rather than one "Capabilities" page covering both.

## Non-goals

- Not deleting the system tool/action layer. It grows in relative importance.
- Not building a skill marketplace or registry client.
- Not executing skill scripts or installing skill dependencies. ADR 0009's
  untrusted-import posture is preserved exactly.
- Not letting a skill package become a tool authority. "The package is the
  source of truth for its own content" is about content; declared permissions,
  tools and hooks remain requests that only the System Action Registry can
  grant. Gate 8 asserts it.
- Not changing `project_workflow_profiles` semantics for user-authored presets.
- Not touching Workflow execution (`workflow_executions` and friends). The
  Skill/Workflow boundary — soft procedure versus enforced process — is stated
  here as a rule but its enforcement side is not this plan's work.
- Not adding Domain-scoped skill bindings. `SkillBinding.scope` lists `domain`
  above because the enum should anticipate it; the binding is only wired once
  [scope-model-plan.md](scope-model-plan.md) lands.

## Completion gate

1. ADR 0009 amended in place; `CAPABILITY_WORKFLOW_SKILL_SYSTEM.md` and
   `GLOSSARY.md` updated in the same change.
2. An external Agent Skill package imports, is risk-scanned, is approved, binds
   to an agent, and reaches a run — without being converted into a
   `CapabilityDefinition`.
3. `NormalizedSkill` and `CapabilityPackDescriptor` no longer exist.
4. One lifecycle governs imported skill content.
5. Runtime Context still resolves skill candidates for a run through both
   `gateway.ts` call sites.
6. Every research capability from the deleted pack is accounted for — each
   reclassified as a Skill or a System Action, with none silently dropped.
7. Skills and System Actions are distinct in the API surface and in the UI.
8. An imported skill package that declares tools, hooks, or an MCP server gets
   none of them: nothing it declares is callable without a System Action
   Registry entry, asserted by a test rather than resting on the ADR 0009
   posture. This is the inverse of gate 6 and the direction external skill
   ecosystems are moving.
9. Skill content still reaches a run through Runtime Context Delivery, with the
   same authorization references as any other model-visible context.

## Dependencies

- Requires: completed managed execution architecture with the
  `managedAgentLoop` port and Runtime Context Delivery boundary. Satisfied
  2026-08-14; see
  [runtime-adapters.md](../modules/runtime-adapters.md) and
  [EXECUTION_MODEL.md](../architecture/EXECUTION_MODEL.md).
- Recommended: after `scope-model-plan.md`, so `SkillBinding.scope` can include
  `domain` at the time it is written rather than being widened later.
- Note for future external runtimes: the "no ambient skill or plugin discovery"
  rule that today's CLI adapters get from a freshly cleared private `HOME` is a
  property of their `RuntimeAdapterSpec`, not of this plan. Any new external
  harness inherits it explicitly or reopens the same authority question from
  the vendor side.
