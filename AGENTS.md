# AGENTS.md

Repository instructions for Codex. This file is intentionally short: it routes
Codex to the `.agent/` source-of-truth docs instead of duplicating them.

## Required Context

Before making code or architecture changes:

1. Read [`.agent/INDEX.md`](.agent/INDEX.md).
2. Pick the smallest relevant bundle from
   [`.agent/context-bundles.yaml`](.agent/context-bundles.yaml).
3. Read [`.agent/BOUNDARIES.md`](.agent/BOUNDARIES.md) before structural,
   ownership, security, policy, data-model, or migration changes.
4. Read [`.agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md`](.agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md)
   before implementing substantial new behavior, adding a dependency, or
   building shared infrastructure.
5. Read [`.agent/architecture/TESTING_STRATEGY.md`](.agent/architecture/TESTING_STRATEGY.md)
   before adding or changing tests.
6. Use [`.agent/COMMANDS.md`](.agent/COMMANDS.md) for canonical run, build,
   test, migration, backup, and compose commands.

Do not load every `.agent/` document by default. Load only what the task needs.

## Source Of Truth

Follow this order when docs and code disagree:

1. Code
2. `server/src/db/schema/` for database schema authoring
3. `server/migrations/` for generated/applied database SQL artifacts
4. `server/src/`
5. `packages/protocol/src/`
6. `apps/web/src/modules/registry.ts`
7. [`.agent/BOUNDARIES.md`](.agent/BOUNDARIES.md)
8. [`.agent/decisions/`](.agent/decisions/)

Docs in `.agent/architecture/` describe current state. When an architecture
change lands, update the relevant `.agent/architecture/` document in the same
change.

## Repo Rules

- Runtime data, user workspaces, sandboxes, secrets, database files, and logs
  must never be stored in the source repo.
- `RAINVER_ROOT` is the host-side parent for mode roots (`dev/`, `test/`,
  `prod/`). `RAINVER_HOME` is the running app instance root.
- `server/` is the TypeScript backend source root. Database schema authoring
  goes through `server/src/db/schema/` and Drizzle-generated migration
  artifacts in `server/migrations/`. The Compose service name remains `server`.
- Memory writes go through proposal -> approval; agents do not directly write
  active memory.
- Credentials follow ADR 0008 channel isolation. Do not pass provider API keys
  through ambient env or CLI subprocess env.
- `.agent/reports/` entries are temporary reports, not source of truth.

## Working Pattern

- Read the relevant docs first, then the code.
- Keep changes scoped to the requested module/context.
- Before implementing substantial new behavior, search the repository for an
  existing implementation, helper, or test fixture; check the installed
  dependencies and the canonical mechanism index; and for generic or commodity
  capability, evaluate a mature external library before writing custom code.
  Follow [`.agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md`](.agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md).
- Implement the smallest code that satisfies the requested behavior. Avoid
  speculative, unused, duplicate, or convenience-only code; add abstraction only
  when it removes real complexity or matches an established local pattern.
- Prefer small, purpose-specific modules over large catch-all files. Before
  adding substantial behavior to an already large file, scan nearby file sizes
  and split along existing ownership boundaries when the extraction is low
  risk.
- Add or update focused tests when behavior changes.
- Database-backed behavior tests must reuse the shared real PostgreSQL test
  infrastructure; do not add fake DB coverage or fall back to fake DB when the
  shared fixture is unavailable. See `.agent/architecture/TESTING_STRATEGY.md`.
- Use the smallest verification command that proves the change; broaden only
  when the blast radius requires it. While iterating, run only the test files
  for the module you touched (`pnpm exec vitest run test/<pattern>`); the full
  suite is for before committing and for CI. See
  [`.agent/COMMANDS.md`](.agent/COMMANDS.md).
