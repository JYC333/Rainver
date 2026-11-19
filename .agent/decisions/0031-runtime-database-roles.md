# ADR 0031 — Least-privilege runtime and backup database roles

Date: 2026-11-16
Status: accepted; implemented as an explicit operator procedure. Not activated
on any instance by this change.

## Context

Bundled Compose derives `SERVER_DATABASE_URL` and the server's
`BACKUP_DATABASE_URL` from the bootstrap `POSTGRES_USER`, which the image
creates as a superuser that also owns every core object. A compromised server
process could therefore change schema, roles or the migration journal.

## Decision

| Role | Login | Holds | Used by |
| --- | --- | --- | --- |
| Bootstrap owner (`POSTGRES_USER`) | yes | all ownership | explicit offline commands only: migrate, plugin install/reconcile, restore, role reconcile |
| `rainver_app` (configurable) | yes, NOINHERIT | CONNECT/TEMP; DML on `public`; sequences; read-only migration journal; plugin runtime roles as SET-only memberships | the server process |
| `rainver_backup` (configurable) | yes | `pg_read_all_data` | the server's scheduled `pg_dump` |
| Plugin runtime/DDL roles | no | unchanged (P2) | `SET LOCAL ROLE` inside an operation; DDL offline only |

- Roles are created and repaired only by `migrateCli runtime-roles-reconcile`
  on the owner channel; never by start, deploy, update or HTTP. Passwords are
  sent as client-computed SCRAM verifiers. An existing role whose *effective*
  privileges exceed its target fails closed — unsafe attributes, owned
  objects or the database, database or schema CREATE, memberships beyond the
  reviewed ones (transitively), table/sequence rights beyond its own, a
  writable migration journal, a SECURITY DEFINER function it can call
  (EXECUTE plus schema USAGE) whose owner is not provably within the same
  target, or default privileges for future objects. A definer owner is judged
  by what it can actually do, not by its attributes alone: it must carry no
  role attribute, own no database, schema, relation, type or large object
  (an owner can TRUNCATE, ALTER or DROP what it owns), own no function other
  objects depend on, and hold no effective privilege beyond the target —
  including through its own callable definers, to a bounded depth; an owner
  that cannot be resolved or proven fails closed. Default privileges count
  when they reach the role directly, through PUBLIC or through a role it
  inherits from (PUBLIC's built-in EXECUTE/USAGE on functions/types excepted).
  Nothing is reassigned and no grant the reconciler did not make is revoked;
  `plan` lists the findings. Reconcile, activated startup and definer-owner
  judgement count ownership with one shared catalog check (database, schemas,
  relations, standalone types and large objects in any lasting schema, plus
  functions for the runtime role); session-temporary schemas are excluded.
  Every indirect membership is a finding, so the recursion's depth cap only
  stops cycles.
- `migrate up` re-protects the migration journal for an existing app role, so
  roles reconciled on an empty database before the first migration do not
  inherit journal DML through default privileges.
- Owner and role secrets reach the one-off owner container by inherited
  variable name only, never on the docker argv or in output.
- Future owner migrations reach the app role through default privileges; a new
  plugin package's runtime role is granted during the same offline install.
- Restore keeps `pg_restore --no-owner --no-acl`; both restore scripts then
  re-grant with `runtime-roles-reconcile --if-present`.
- `RAINVER_DB_REQUIRE_RUNTIME_ROLE=1` makes the server refuse to start as an
  owner or attribute-bearing role, or as a role that has drifted beyond the app
  target (the same effective-privilege check). Activation and rollback are URL switches with
  application services stopped; the previous owner URL is kept in the instance
  `.env` and excluded from the server environment. Ordinary start no longer
  rewrites an activated URL.

## Consequences

The owner credential remains on the host for offline maintenance. Activation is
a separate, explicitly authorized operation per instance (backup first, `plan`,
`apply`, `activate`, start, verify; `rollback` if needed) and is documented in
[deployment](../modules/deployment.md#least-privilege-database-roles-adr-0031).
