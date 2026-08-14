# Server Foundation

> **Status:** current repository fact. Source of truth is `server/`.
> Current ownership is recorded in
> [`SERVER_OWNERSHIP.md`](SERVER_OWNERSHIP.md).

## Role

`server` is the client-facing API service and backend module host.

It has two distinct parts:

- `server`: the permanent service.
- `gateway`: the permanent entry/routing layer inside the service.

Unknown `/api/v1/*` traffic hits the local catch-all and returns
`404 { "detail": "Route not found" }`.

## Source Layout

```text
server/src/
  index.ts
  server.ts
  config.ts
  gateway/
  modules/
  ports/
```

Modules use the convention documented in
[`SERVER_MODULE_CONVENTION.md`](SERVER_MODULE_CONVENTION.md).
`server.ts` stays composition-only; route ownership belongs in modules and the
route registry.

## Boundaries

- Server owns native session-cookie identity resolution, Google OAuth
  login/callback/config, the canonical feature-gated API-key endpoints, spaces,
  runs, artifacts, frontend-support read models, streaming, and product
  routes. DB-persisted API-key storage remains deferred because the canonical
  schema has no `api_keys` table.
- Server migrations own schema migration through explicit ops commands.
- In bundled compose modes, server uses the Postgres owner/app role from
  `POSTGRES_*`; there is no separate per-table app-role provisioning path.
- Credential release stays inside provider/CLI broker channels.
- Deferred feature surfaces fail closed explicitly, generally with 501.

## Database Foundation

Server database access is centralized under `server/src/db/`:

- `pool.ts` owns `pg` pool construction from `SERVER_DATABASE_URL`;
- `tx.ts` provides the shared transaction helper for server-owned write flows;
- `migrator.ts` and `migrateCli.ts` provide a manual migration runner over
  Drizzle-authored schema under `server/src/db/schema/` and generated SQL
  artifacts under `server/migrations/*.sql`.

The migration runner is the generated-SQL applier and remains an explicit ops
command, not a startup hook.

`server/migrations/0001_baseline.sql` is the current consolidated generated
schema baseline for this pre-history phase. Ordinary schema changes start in
`server/src/db/schema/`, run through `pnpm run schema:generate`, and are then
applied by the server migration runner.

## Configuration

Configuration is environment-based and parsed in `server/src/config.ts`.
When adding a new configuration surface, update:

- `server/src/config.ts`;
- `ops/env/.env*.example`;
- `ops/compose/docker-compose.{dev,test,prod}.yml` when the service needs it;
- `ops/scripts/lib/local-compose.sh` when compose env generation changes;
- [`SERVER_OWNERSHIP.md`](SERVER_OWNERSHIP.md).
