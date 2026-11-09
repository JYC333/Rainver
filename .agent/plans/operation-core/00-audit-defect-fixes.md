# Plan 0 — Audit Defect Fixes

Status: not started. Independent of the other plans; can run in parallel.
Found by the 2026-11 plugin and route audits and re-checked against the code.

## 1. finance_ledger proposals cannot complete

- `ProposalApplierRegistry.apply` calls `validateProposalPayload`
  (`server/src/modules/proposals/applierRegistry.ts`), whose
  `ProposalPayloadSchema` is a closed `z.discriminatedUnion`
  (`server/src/modules/proposals/payloadSchemas.ts`) without
  `finance_ledger.post_directive` / `finance_ledger.post_import_batch`, so every
  real accept fails validation.
- Nothing outside `proposalAppliers.ts` creates these proposals.
- Agent `proposal.decide` builds the apply service without the plugin host
  (`proposalDecisionExecutor.ts`), so plugin appliers are missing on that path.
- Tests call the applier directly and bypass the registry.

Fix:
- [ ] Plugin proposal types contribute payload schemas that join validation.
- [ ] Every accept path (HTTP, Agent `proposal.decide`, other `fromConfig` callers)
  receives plugin appliers.
- [ ] Write paths that actually create these proposals (import batch, directive posting).
- [ ] End-to-end test through the registry and the accept route.

## 2. Autonomous Runs keep every read grant

`server/src/modules/runs/repository.ts` strips only side-effecting grants for
`trigger_origin === "autonomous"`; read grants all remain.

- [ ] Strip reads of personal or sensitive data in autonomous Runs (full rule in
  [plan 4](04-plugin-agent-access-and-sensitivity.md); the interim fix keeps any
  plugin read out of autonomous Runs).

## 3. Agent reads on behalf of the owner leave no audit

`content_access_logs` enforces `viewer_user_id <> owner_user_id`
(`server/src/db/schema/contentAccess.ts`), so an Agent reading its instructing
owner's private content records nothing.

- [ ] Agent read record keyed by `run_id` (shape in plan 4); this item can land
  first for core private content.

## 4. The server connects as a PostgreSQL superuser

Bundled compose initializes the official image with `POSTGRES_USER`, which is a
superuser (`rolsuper`, `rolbypassrls`), and the server uses it
([DATABASE_AND_TRANSACTIONS](../../architecture/DATABASE_AND_TRANSACTIONS.md)).
A superuser can switch to any role, run `COPY … PROGRAM`, and read server files.

- [ ] Add `rainver_app` (LOGIN, NOSUPERUSER, NOBYPASSRLS); `REASSIGN OWNED` core
  objects to it; keep the superuser for migrate, extensions, backup and restore.
- [ ] Update ops scripts, restore flow and documentation; record an ADR.

Needs separate authorization: it changes deployment, credentials and the restore
procedure. It does not block plan 2, but plan 2's role guard means much more once
this lands.

## 5. Plugin installer cannot record failure

A failing migration rolls back the whole install transaction, so
`plugin_migrations.status = 'failed'` is never written. Fixed inside
[plan 2](02-plugin-operation-platform.md)'s migration runner work; listed here so
it is not lost if plan 2 slips.
