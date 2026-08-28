# Capability Shrink Plan

Date: 2026-08-13; revised 2026-08-14
Status: **PAUSED 2026-08-21**, re-pointed 2026-08-23 — items 1–6 below remain
unscheduled and stay unscheduled while the execution-topology and Project
control-plane work (Machine/ExecutionHost/WorkspaceLocation dispatch + Task
spine; P0/P1 shipped 2026-08-23, that plan now retired — git history holds
it) is the active line of work (the retired phase-1 control-center plan's
D2/D12 froze the knowledge/capability half of the system to keep attention on
one active line; that constraint carries forward). `acp-runtime-replatform-plan.md`,
this plan's prior resume condition, is retired — its remaining ACP-cleanup
scope was completed and narrowed inside that plan's P0. Resume this plan as a
cleanup batch after that P1 work's real-usage window closes, not before (see
[tasks/deferred-register.md](../tasks/deferred-register.md)'s "Project
kernel — P2" section).

## Execution status

Two items have landed and have been removed from this document; Git history is
the authority for what they did.

| Landed | Commit |
|---|---|
| Amend ADR 0009 and the authority documents | `a0c1e5c4` |
| Delete the workflow template layer | `4009c281` |

The second was originally the first half of a single "delete the pack and
template layer" item. It was split during implementation because the capability
half turned out not to be dead code; that finding is recorded under item 2
below. Everything remaining is unscheduled.

Review consent is run-scoped to the item being implemented plus relevant
repository context, and reviewers are local subagents in this session. No push,
PR, deployment, destructive cleanup, or implementation of an unscheduled item is
authorized.

## Purpose

Stop maintaining an rainver-native skill standard. Keep the parts that are
genuinely Rainver's: where a skill came from, which version, what it asks
for, who approved it, which agents may use it, and which snapshot a run used.

The position to move to:

> An external Agent Skill package is the source of truth for its own content.
> Rainver owns provenance, trust, policy, and binding — not a canonical
> re-representation of the skill.

And a boundary that must survive the shrink, because it is the thing most likely
to be lost by treating "capability" as a single word:

> **Skill** = a procedure a model should follow.
> **System Action / Tool** = something the model can invoke that mutates
> Rainver state, gated by `agentToolGateway` and policy.

The first is content and should be external. The second is Rainver's own
API and must stay owned, versioned, and gated. Today both live under
"capabilities" and that is the source of the confusion.

## Entry trigger

The managed-execution prerequisite was satisfied on 2026-08-14. What still gates
the remaining items is not organizational.

`SkillBinding` has to describe how an approved skill reaches a runtime, and
today no runtime in this instance consumes a skill at all — no CLI is installed,
and the managed path renders skills into prompt text. Designing the binding
shape before one real agent runtime consumes one real skill means designing
against the renderers, which is what produced the current shape.

Focus areas ([ADR 0015](../decisions/0015-focus-area-classification.md)) are
independent of this plan and do not overlap it: a focus area is a
classification that touches no access path and no capability surface.

**First real consumer (recorded 2026-08-28).**
The agent work surface plan (shipped and retired 2026-08-28; commits
`fd3d8358`, `da0af91e`, `9239d1c2`) delivers one builtin
skill — the Rainver Work Skill — as a file to a real CLI runtime on a paired
host. It ships as a code module (`capabilities/workSkill.ts`) rather than a
`SkillPackage` row: this plan's target shape is what it was written against —
content Rainver owns, no `SkillPolicy`, delivery decided by scope rather than
by an enablement — but none of it is persisted, and `runtimeSkillProvider` was
not touched, because the Runtime Context gateway flattens a rendered skill's
files into prompt text and this Skill has to arrive as a file. Modelling it as
one builtin `SkillPackage` with a `runtime`-scoped `SkillBinding`, and giving
`runtimeSkillProvider` the implicit-binding path that would resolve it, is
therefore **carried into this plan** rather than done ahead of it: it is the
concrete first case for items 1 and 5, and the second builtin skill — the
research procedures item 2 reclassifies — needs only a narrower binding scope
on the same mechanism.

## Current implemented baseline

Verified against `4b0adfe4` on 2026-08-14, then narrowed by the workflow
template deletion.

### What is persisted

`capability_versions`, `capability_enablements`, `capability_runtime_bindings`,
`skill_sources`, `skill_packages`, `skill_package_files`,
`skill_local_overlays`.

### The capability pack layer is small but live

There is no `capability_packs` table; `packRegistry.ts` holds one hardcoded
`research` pack and `registry.ts` (19 lines) lists exactly that pack's
capability definitions. Their size invites deleting them outright. **That would
break live paths**, which is why item 2 reclassifies rather than deletes:

- `getBuiltInCapabilityDefinition` has eight live call sites, including
  `runtimeSkillProvider.ts:145` — the file this plan separately marks as
  must-not-delete. It resolves a built-in capability's
  `default_runtime_bindings` into Runtime Context skill candidates.
  `repository.ts` uses it for import-conflict detection and
  `riskLevelFromPermissions`; `proposalApplier.ts` and `service.ts` also read it.
- The eight `research.*` ids are hardcoded across six Project Research files
  (`executionProfileService.ts`, `pipeline/synthesisCoordinator.ts`,
  `areaService.ts`, `monitorComparisonService.ts`, `synthesisOnlyExecution.ts`,
  `standingComparisonService.ts`), are written to `runs.capability_id`, and are
  matched by SQL `WHERE` clauses against historical rows.

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
they render *from* a canonical Rainver representation, which is what forces
the conversion layer to exist.

### What must not be deleted

`runtimeSkillProvider.ts` (370 lines) is consumed by
`runtimeContext/gateway.ts` at two call sites — `PgRuntimeSkillProvider(db)
.loadCandidatesForRun(...)` — and by `productionAcquisition.ts`. Runtime Context
depends on it to decide which approved skills a run may receive. It narrows; it
does not go away.

## Work

### 1. Collapse to three persisted concepts

```
SkillPackage    source, version/commit/hash, files, license, metadata, risk scan
SkillBinding    scope (user | space | project | agent), enabled,
                pinned version, runtime compatibility
SkillPolicy     requested permissions, granted permissions, trust/risk,
                approval state
```

`skill_sources`, `skill_packages`, and `skill_package_files` already carry most
of the first. The work is mostly in what stops existing around them.

One lifecycle, not two. `SkillPackageStatus` survives; `CapabilityStatus`'s
seven states do not apply to imported skill content.

### 2. Reclassify the research capabilities

Depends on item 1's target shape. The research capabilities are not simply
deleted. Each is either a skill (content, becomes a `SkillPackage`) or a system
action (becomes a registered tool). Classify each one; do not let the pack's
removal silently drop a capability that Project Research depends on — see the
baseline section above for the six files that read these ids. `packRegistry.ts`,
`researchPack.ts`, `registry.ts` and `CapabilityPackDescriptor` are removed
here.

### 3. Drop the conversion layer

`NormalizedSkill` and the `imported_skill → CapabilityDefinition` path in
`skillImporter.ts` go. What the importer keeps is the part that is actually
Rainver's: fetch, hash, file inventory, risk scan, permission extraction,
and approval state.

The skill's own files remain the content of record. A run receives the package,
not a regenerated description of it.

Before extending the importer (today: GitHub only, hand-written fetch against
`raw.githubusercontent.com`), evaluate the Agent Skills ecosystem's own
tooling — the skills.sh directory and its installer, and the reference tooling
of the `SKILL.md` standard — as the fetch and inventory layer, per
`architecture/REUSE_AND_DEPENDENCY_POLICY.md`. What stays Rainver's either
way is provenance, hash, risk scan, approval and binding. (Noted 2026-08-28.)

### 4. Demote the renderers to adapter glue

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
`deliveryAuthorizer.ts` verifies. What this plan deletes is Rainver's second
description of the skill; the authorization path that makes the skill's presence
in a prompt explicable afterwards is not part of the deletion.

### 5. Narrow `runtimeSkillProvider` to a binding resolver

Its job becomes: given a run, return the approved skill packages this run may
receive, at pinned versions, with their policy state. Not: own a skill execution
framework. The two `gateway.ts` call sites keep working across the change —
this is the compatibility surface that matters most in this plan.

### 6. Separate System Actions from Skills in the API and UI

`systemActions/agentToolGateway.ts` (590 lines) is already the right thing and
is not touched by this plan. What changes is that it stops being presented as a
kind of capability. The user-visible surface becomes two things — **Skills**
(imported, external content) and **Tools / System Actions** (Rainver's own
gated API) — rather than one "Capabilities" page covering both.

## Non-goals

- Not deleting the system tool/action layer. It grows in relative importance.
- Not building a skill marketplace or registry client.
- Not executing skill scripts or installing skill dependencies. ADR 0009's
  untrusted-import posture is preserved exactly.
- Not letting a skill package become a tool authority. "The package is the
  source of truth for its own content" is about content; declared permissions,
  tools and hooks remain requests that only the System Action Registry can
  grant. Gate 7 asserts it.
- Not touching Workflow execution (`workflow_executions` and friends). The
  Skill/Workflow boundary — soft procedure versus enforced process — is stated
  here as a rule but its enforcement side is not this plan's work.
- Not adding focus-area-scoped skill bindings, and `SkillBinding.scope` should
  not anticipate one. A focus area is a classification, not an execution range —
  it decides no access and bounds no run, so "this skill is available within my
  finances" has no meaning. See
  [ADR 0015](../decisions/0015-focus-area-classification.md).

## Completion gate

1. An external Agent Skill package imports, is risk-scanned, is approved, binds
   to an agent, and reaches a run — without being converted into a
   `CapabilityDefinition`.
2. `NormalizedSkill` and `CapabilityPackDescriptor` no longer exist.
3. One lifecycle governs imported skill content.
4. Runtime Context still resolves skill candidates for a run through both
   `gateway.ts` call sites.
5. Every research capability from the deleted pack is accounted for — each
   reclassified as a Skill or a System Action, with none silently dropped.
6. Skills and System Actions are distinct in the API surface and in the UI.
7. An imported skill package that declares tools, hooks, or an MCP server gets
   none of them: nothing it declares is callable without a System Action
   Registry entry, asserted by a test rather than resting on the ADR 0009
   posture. This is the inverse of gate 5 and the direction external skill
   ecosystems are moving.
8. Skill content still reaches a run through Runtime Context Delivery, with the
   same authorization references as any other model-visible context.

## Dependencies

- Requires: completed managed execution architecture with the
  `managedAgentLoop` port and Runtime Context Delivery boundary. Satisfied
  2026-08-14; see
  [runtime-adapters.md](../modules/runtime-adapters.md) and
  [EXECUTION_MODEL.md](../architecture/EXECUTION_MODEL.md).
- Note for future external runtimes: the "no ambient skill or plugin discovery"
  rule that today's CLI adapters get from a freshly cleared private `HOME` is a
  property of their `RuntimeAdapterSpec`, not of this plan. Any new external
  harness inherits it explicitly or reopens the same authority question from
  the vendor side.
