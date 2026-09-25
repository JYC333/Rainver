# ADR 0023: Authentication Foundation Schema Epoch

Date: 2026-09-23

## Status

Accepted and implemented. The instance has no schema history or user data that
must be preserved, and the operator explicitly authorized replacing the current
pre-release migration chain with one baseline. Applying this decision to a
database that has any prior Rainver migration is not supported; recreate that
database instead. This decision does not itself delete or reset a database.

## Context

The authentication implementation was developed as three provisional,
maintenance-only migrations after the 2026-09-21 ACP runtime-authority
baseline. The finished target has one Better Auth-backed identity model,
registration intents, invitation reservation, hashed session and verification
identifiers, and security audit events. It deliberately has no legacy OAuth
session path and no duplicate `auth_action_tokens` table.

Keeping the provisional add/correct/drop sequence would make every new
installation create a table only to remove it, retain an empty-auth preflight
for data that does not exist, and present an upgrade path that this instance
does not need. B58 also rejects compatibility code for the retired shape.

## Decision

Generate `server/migrations/0000_baseline.sql` directly from the current
Drizzle schema against an empty chain, add the declared `vector` extension,
and replace the SQL, snapshot, and journal as one new schema epoch. The
canonical chain contains only `0000_baseline.sql`; the provisional
`0001_auth_foundation.sql`, `0002_auth_constraints.sql`, and
`0003_auth_adapter_refactor.sql` files and their snapshots are removed.

The generated baseline contains the final authentication schema directly:
`users`, `auth_accounts`, `user_sessions`, `auth_verifications`,
`registration_intents`, `auth_security_events`, and the final
`space_invitations` reservation fields and constraints. It does not contain
`auth_action_tokens` or a compatibility view, alias, backfill, or dual-read
path.

The new baseline is frozen after this change. Later schema changes append new
numbered migrations under B59.

## Operational consequences

- A database that recorded any checksum from the prior epoch is incompatible
  with this build and must be recreated. No migration or restore shim is
  provided.
- Backup preflight continues to reject a migration identity or checksum that
  is absent from the current chain.
- No running database is reset as part of the repository change.
- Fresh-instance and schema-drift tests pin the single-file chain and the new
  baseline checksum.

## Revision history

- 2026-09-23 — accepted and implemented for the completed authentication
  foundation.
