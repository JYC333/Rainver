# Skill Library

## Purpose and ownership

`server/src/modules/skills/` owns safe external Skill import, immutable
package bytes, builtin source seeding, provenance, risk scanning, local overlays, review and scoped
bindings. There are no capability definitions, packs, conversion APIs or product
`/capabilities` page. `/skills` is the library. Diagnostic YAML under
`catalog/capabilities/` remains read-only and is not executable.

## Paths and invariants

- `skillImporter.ts`, `skillSourceFetch.ts`, `skillPackageFiles.ts`: bounded
  GitHub, upload/ZIP and owned-Host CLI imports. Preview/import hashes must match;
  scripts, dependencies, tools, hooks and MCP declarations grant no execution.
- `NormalizedSkill`: parser and risk-scan result, never a replacement content authority.
- `builtinPackages.ts`: code-owned immutable releases, synced per Space at
  startup and new-Space bootstrap. Uses the existing `source_type = 'builtin'`
  kind, pure package builder and snapshot writer. No import/review path and no
  bindings are seeded. The shipped catalog is empty; the only example is a
  test fixture. Release upgrades retain old bytes and binding pins.
- `skillPackageContent.ts`: integrity-checked original files, deliverable only
  after review. New bytes require a new immutable package.
- `skillBindings.ts`: Space, user, Project and Agent bindings to immutable package
  versions; narrower disabled bindings suppress broader enabled bindings.
- `selectedSkills.ts`: the single library resolver, including canonical explicit
  message selections. `runtimeSkillProvider.ts` is a thin Run-scope adapter.
- `proposalApplier.ts`: review (`skill_import_approve`) and library bindings
  (`runtime_skill_binding_update`, operation `skill_package_binding_update`).
  Review can include its first enabled non-Project binding in one approval.
  Apply re-checks scope authority and takes the shared package lock.
- `routes.ts`: `/skill-sources/*`, `/skill-packages/*` and existing
  `/skills/*` selection/index/overlay namespace. Local overlays
  cannot approve content, mutate original bytes or grant credentials.
- Runtime Context acquisition and both Gateway authorization passes resolve the
  same reviewed original packages. Accepted Delivery carries source/planned-item
  references, exact package hash and original bytes; Hosts materialize files.

`workSkill.ts` is separately the required code contract delivered by the work
surface. It is not an optional imported or builtin library package. Research
stage tags belong to `projectResearch/researchStages.ts`; pipeline routing does
not use Skill registrations or research capability requirements.

See [Skills, Tools, And Workflows](../architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md),
[Runtime Context](runtime-context.md), [BOUNDARIES](../BOUNDARIES.md) and
[ADR 0009](../decisions/0009-capability-workflow-open-skill-system.md).

## Verification

Real PostgreSQL fixtures cover approval/binding, original-byte integrity,
Delivery and authorization races (`skillsApprovalDb.test.ts`,
`runtimeContextDeliveryDb.test.ts`). The declaration test proves imported tools,
hooks and MCP actions are unknown to the System Action gateway. The migration
fixture upgrades an old converted package without changing its bytes. Research
pipeline tests protect unchanged stage tags and routing without registrations.
Builtin fixtures in `skillsApprovalDb.test.ts` cover concurrent/idempotent sync,
new versions, immutable prior rows, Space isolation and no automatic bindings;
`runtimeContextDeliveryDb.test.ts` proves acceptance through the existing
binding proposal service reaches a Run's authorized Delivery without import
review, including after a shipped version upgrade. Web library tests cover
English/Chinese source labels, absent import/review controls and binding requests.

## Reuse / Dependency Check

- Existing mechanism: pure package builder, risk scanner, atomic snapshot writer,
  content integrity reader, proposal bindings and Runtime Context Delivery.
- Installed dependencies: existing `pg`, parser and Node crypto; no additions.
- External option: not applicable; seeding/trust/Space authority is domain logic.
- Approach: extend the existing Skill library and startup/Space seed hooks.
- Reason: preserve immutable original bytes and the existing Space foreign keys
  without a second delivery path or schema change.
