# Rainver — Claude Code Guide

These are repository development instructions, shared by Codex and Claude Code.
Paths are relative to the repository root. They and `.agent/` are independent
of Rainver's product-runtime context, prompts, and Skills; see
[ADR 0004](.agent/decisions/0004-context-wrapper.md). Product approval workflows
do not add a proposal cycle to authorized IDE edits; operating the product
still requires its own permissions and gates.

## Task Scope And Authorization

- Explanation, diagnosis, and review authorize investigation and recommendations,
  not repairs. Implementation requests authorize scoped edits and reasonable
  verification: complete that work instead of stopping at a plan.
- Advance settled, authorized work autonomously. Ask only when missing information
  materially affects the result and cannot be resolved from context, or the next
  action exceeds authorization. Continue independent work; silence is not approval.
- Deployment, publication, messages, credential changes, and important-data
  deletion need authorization for that action. Existing explicit authorization
  remains valid within scope; command examples and Skills do not grant it.
- Preserve unrelated uncommitted work; do not reset, stash, or remove it for
  cleanup or testing. Commit and push only when authorized.
- Preserve the user's language, model routing, and delivery preferences. Use
  Skills only within their triggers; ordinary work does not require a staged
  plan, multiple models, or sub-agents.

## Required Context

Before code changes, read [INDEX](.agent/INDEX.md), select the smallest relevant
[context bundle](.agent/context-bundles.yaml), and actually read its relevant
policies and owning module guide before editing. Briefly identify that route
and the constraints affecting the work in a progress update.

- Prefer a detailed domain bundle over a broad primary bundle; `default` is a
  fallback, not an addition. `docs` routes reading; `code_roots` scopes searches,
  not exhaustive file loading. If no bundle fits, use INDEX's module map.
- Read [BOUNDARIES](.agent/BOUNDARIES.md) for structure, ownership, API, security,
  policy, data-model, migration, or product-agent behavior changes.
- Read [REUSE_AND_DEPENDENCY_POLICY](.agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md)
  before substantial new behavior, dependencies, or shared infrastructure.
- Read [TESTING_STRATEGY](.agent/architecture/TESTING_STRATEGY.md) before changing
  tests; use [COMMANDS](.agent/COMMANDS.md) for run/build/test and operations commands.
- Questions and documentation-only changes need the affected documents and
  relevant references, not every implementation bundle. Reuse already-read
  context; follow links only for task dependencies. For a stale path, search
  the relevant area and report what remains unresolved; ask only if it blocks
  a material decision. Do not silently skip necessary constraints.

## Source Of Truth

Code establishes current implementation facts. The main authorities are:

1. `server/src/db/schema/` — schema authoring
2. `server/migrations/` — generated/applied SQL artifacts
3. `server/src/` — backend implementation
4. `packages/protocol/src/` — public DTOs and wire contracts
5. `apps/web/src/modules/registry.ts` — active frontend modules and navigation

[BOUNDARIES](.agent/BOUNDARIES.md) and accepted [decisions](.agent/decisions/)
constrain changes. Existing code does not waive safety or authorization. When
facts and constraints disagree, cite both, preserve the boundary, and resolve
only what the task authorizes; continue unaffected work.

## Repo Rules

- Keep runtime data, user workspaces, sandboxes, secrets, databases, and logs
  outside the source repo. `RAINVER_ROOT` is the host parent of `dev/`, `test/`,
  `prod/`; `RAINVER_HOME` is the running instance root.
- The backend source root and Compose service name are `server`. Author schema
  changes in Drizzle and generate migration artifacts using COMMANDS.
- Product memory writes use the canonical applier and the approval conditions
  in [ADR 0003](.agent/decisions/0003-memory-proposal-flow.md) / B10. Do not add
  direct table writers or bypass the required proposal, provenance, or review gates.
- Credentials follow [ADR 0008](.agent/decisions/0008-credential-channel-isolation.md).
  Do not pass provider API keys through ambient or CLI subprocess environments.
- `.agent/architecture/` describes current implementation; update affected guides
  and API/usage docs with the change. Plans and deferred work do not authorize
  scope expansion. `.agent/reports/` is temporary, not authoritative; do not
  rewrite unrelated docs or remove reports as incidental cleanup.

## Working Pattern

- Keep work within the requested module/context. Before substantial new behavior,
  search existing code, helpers, fixtures, installed dependencies, and the reuse
  policy's canonical mechanism index. Evaluate a mature external option for
  commodity capability before custom implementation. Record the required short
  Reuse / Dependency Check in the plan or change description, not a new approval
  cycle; the policy's section 9 exempts small fixes from that written check.
- Implement the smallest behavior that satisfies the request. Avoid speculative,
  unused, duplicate, or convenience-only code. Prefer purpose-specific modules;
  before adding substantial behavior to a large file, check nearby sizes and
  extract along existing ownership boundaries when low-risk and useful to the task.
- Add/update focused tests that protect changed behavior and meaningful invariants.
  Documentation needs guide/link checks; presentation needs suitable visual/build
  checks, not tests mirroring implementation.
- Run explicit affected tests from the owning package (`test/<pattern>` for
  server, `src/<pattern>` for web), including consumers when needed. Broaden only
  for identified impact, failures, or required gates. Per COMMANDS, the full suite
  runs before an authorized commit or in CI, not after every local edit.
- Durable behavior tests use shared real PostgreSQL, never a fake DB fallback.
  If unavailable, report skipped verification separately from passes and complete
  independent checks; do not reset real data to make tests run.
- Finish with scoped changes, affected documentation, verification results and
  limitations. Once sufficient checks pass, stop repeating review/test loops
  unless new evidence warrants them. For blocked work, name the remaining action;
  do not claim tests or CI passed without evidence.

Keep the body of AGENTS.md and CLAUDE.md synchronized; only their title differs.
`server/test/agentGuides.test.ts` checks this and the documentation routes.
