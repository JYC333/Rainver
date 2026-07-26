# Hardening Remaining-Work Plan

Date: 2026-07-24
Status: active small backlog and trigger register

## Purpose

Track cross-cutting hardening that is neither owned by the active Project
cutover nor by the orchestration/evolution backlog. Completed P0 history is
removed; implementation truth lives in current architecture and code.

## Immediate prerequisite

### Toolchain pinning and compatibility

Complete 2026-07-24. Complete before the broad Project schema/protocol/frontend rename:

- pinned the supported Node version through `engines` (`>=24 <25` in all
  three `package.json`) and root `.nvmrc` (`24.18.0`), matching the
  `node:24.18.0-slim` base image in `server/Dockerfile` and
  `apps/web/Dockerfile` and CI's `node-version-file: .nvmrc`;
  `server/package.json` engines requirement was originally set to the
  then-current `node:22.22.2-slim` pin and later moved to 24.18.0 LTS in the
  same change, including a rebuild/retest of the native `node-pty` addon;
- aligned React and `@types/react` major versions by upgrading `react` and
  `react-dom` in `apps/web` from `^18.3.1` to `^19.2.8` (the previously
  installed `@types/react`/`@types/react-dom` were already `^19.x`, so the
  runtime was the outlier, not the types); fixed three pre-existing
  test-only async races (`finance-page.test.tsx`,
  `InquiryWorkspacePage.test.tsx`) that React 19's scheduling exposed;
- standardized on npm as the documented package-manager/lockfile policy
  (matching the `package-lock.json` files, `npm ci` in all Dockerfiles, and
  CI) and corrected the `packageManager` field in all three `package.json`
  from a stale, never-actually-used `pnpm@10.32.1` declaration to the
  `npm@11.16.0` bundled with the pinned Node image; added
  `engine-strict=true` via `.npmrc` in each package so
  a Node-version mismatch fails the install instead of only warning;
- confirmed the supported TypeScript version policy is already consistent:
  `^7.0.0` (7.0.2 installed) across `server`, `apps/web`, and
  `packages/protocol`;
- CI now enforces the pinned Node version through `actions/setup-node`
  reading `.nvmrc` directly (`node-version-file: .nvmrc`) instead of a
  second hardcoded value that could drift from it.

This was small risk reduction, not a product feature.

## Routed to active plans

These items are not duplicated here:

- Project/Folder/Profile/Area cleanup is complete; usage-triggered follow-ups
  live in the
  [Project / Inquiry defer register](../tasks/project-inquiry-defer-register.md);
- completed structured runtime I/O, runtime convergence, and governed CLI
  tools are documented in
  [Runs and Outputs](../architecture/RUNS_AND_OUTPUTS.md);
- completed UUID-selector and product-acceptance implementation is documented
  in [Product Acceptance](../architecture/PRODUCT_ACCEPTANCE.md);
- backoff, egress, scheduler catch-up, and unattended failure alerting →
  [unattended-execution-hardening-plan.md](unattended-execution-hardening-plan.md);
- orchestration/evolution work →
  [orchestration-and-self-evolution-plan.md](orchestration-and-self-evolution-plan.md).

## Scheduled but not blocking

### Retention and pruning design

Append-only Run/Event/Evolution/usage data and Artifact storage need explicit
retention semantics. Trigger when the database reaches a few GB, backups exceed
15 minutes, or real Run logs make growth materially visible.

The design must preserve audit obligations, Proposal/Artifact provenance, and
per-type policy; it cannot be a generic age-based delete job.

### Frontend contract generation

Before the Project clean cutover starts broad protocol/frontend edits, run a
small feasibility gate:

- inventory whether the affected Project/Folder/Runtime DTOs all have protocol
  schemas;
- prove one representative generated/shared type path;
- estimate the uncovered client-only surface.

If the affected surface is ready, complete generation/sharing before the broad
rename so the cutover does not hand-edit two authorities. If it is not ready,
record the exact coverage gap and proceed with matching protocol + frontend
edits and drift tests. Do not turn the feasibility gate into a speculative
whole-client rewrite.

After the cutover, full client generation remains triggered by a second real
contract-drift bug or demonstrated maintenance cost.

**Gate run 2026-07-24 — decision: not ready, proceed with matching manual
edits.**

- `packages/protocol/src/schemas.ts` has only a minimal `WorkspaceRefSchema`
  (`{id, name}` pointer). There is no protocol schema for the full Workspace,
  `working_dirs`, `project_workspaces`, Project Profile, or any other DTO the
  clean-cutover plan renames.
- The representative shared-type path is proven and works: 22
  `apps/web/src` files already import real contracts from
  `@agent-space/protocol` (e.g. `GraphPage.tsx`, `UsagePage.tsx`,
  `PublicationsPage.tsx`), and `packages/protocol` typechecks/builds/tests
  clean standalone. This path is hand-maintained (no codegen tool is wired
  into the repo), not generated, but it is real and functioning.
- The uncovered client-only surface is large: `apps/web/src/types/api.ts`
  alone hand-declares 85+ Workspace/Project/Folder/Runtime/Profile
  interfaces and type aliases (`Workspace`, `WorkspaceCreateBody`,
  `ProjectProfileDescriptor`, `AgentRuntimeProfileOut`,
  `ProjectWorkspaceLinkOut`, etc.) with no protocol counterpart.
- No frontend/protocol contract-drift test exists yet anywhere in the repo.
- Building a generation pipeline for this surface from scratch is new
  tooling, not a small gate — out of scope here. The Project model clean
  cutover must hand-edit `packages/protocol` and `apps/web/src/types/api.ts`
  in the same change per renamed entity, and add drift coverage (a test that
  fails if a protocol DTO and its `apps/web` counterpart diverge) for the
  entities it touches, rather than assuming generation will do it.

### Operations runbook consolidation

After unattended hardening, consolidate one operator page covering:

- service placement and health;
- backup/restore and host-loss recovery;
- runtime-tool and credential recovery;
- retry/alert/scheduler diagnosis;
- safe stop and escalation boundaries.

## Watch items

| Item | Trigger |
|---|---|
| Broader browser E2E suite | Second real user, or a frontend regression that loses/corrupts data |
| TLS/rate limiting/CSRF hardening | Any move toward public internet exposure, currently forbidden |
| Multi-user sharing regression expansion | Second member joins a real shared Space |
| Offline queue | Real mobile/offline usage; until then docs must not claim unsupported behavior |
| Large-file/module splits | Next substantive edit to the affected oversized file |
| Master-key rotation | Suspected exposure or a future multi-instance requirement |
| Commercialization posture | A real external-user/product decision |

## Completion/retirement

Remove an item when its behavior is implemented and recorded in current-state
architecture. Retire this file when no scheduled or watch-triggered hardening
remains.
