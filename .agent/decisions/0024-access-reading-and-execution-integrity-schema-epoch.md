# ADR 0024: Access, Reading And Execution Integrity Schema Epoch

Date: 2026-10-15

## Status

Accepted and implemented. The operator reset the production database and
explicitly authorized folding this release's schema changes into a new
baseline instead of appending a migration. Applying this decision to a
database that recorded any checksum from the previous epoch is not supported;
recreate that database instead. This decision does not itself delete or reset
a database.

## Context

The 2026-09-26 host-thread-tool-field baseline was the only migration any
real database had applied. This release then added one migration with its
schema changes (launch binding, publication records, reauthentication grants,
report days, reading eligibility and subscription periods, lease fencing,
asset placement, run lineage and settlement, among others). Because the
previous build keeps serving while a release's migrations run (B59), that
migration only expanded the schema: it left retired columns and a retired
table in place, added a required column as nullable with a backfill, and
added two checks `NOT VALID`, with the contract steps deferred to a later
release.

With no database to bring forward, those compatibility steps protect nothing
and would make every new instance carry columns no code uses.

## Decision

Generate `server/migrations/0000_baseline.sql` directly from the current
Drizzle schema against an empty chain, add the declared `vector` extension,
and replace the SQL, snapshot and journal as one new schema epoch. The chain
contains only `0000_baseline.sql`.

The contract steps land in the baseline directly:

- `policies` is gone; nothing reads or writes a persisted generic policy.
- `project_public_summaries.review_status`, `hosts.daemon_server_url` and
  `source_channel_user_subscriptions.subscribed_at` / `unsubscribed_at` are
  gone.
- `workflow_executions.responsible_user_id` is `NOT NULL`.
- `ck_evolvable_asset_versions_system_scope_placement` and
  `ck_evolvable_assets_system_owner_placement` are ordinary validated checks.

Apart from these, the baseline's schema equals the previous baseline plus
the folded migration, compared object by object on scratch databases.

## Operational consequences

- A database or backup from the previous epoch has no upgrade path and must
  be recreated; restore preflight rejects its migration checksum.
- Later schema changes append numbered migrations under B59 again.
- `baselineSchema.test.ts` pins the new baseline checksum.

## Revision history

- 2026-10-15 — accepted and implemented.
