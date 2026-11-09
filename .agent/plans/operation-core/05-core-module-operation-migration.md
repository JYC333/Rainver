# Plan 5 — Core Module Migration to the Operation Core

Status: not started. Depends on the [implemented Plan 1 core contract](../../architecture/OPERATION_EXECUTION_CONTRACT.md) (overall review pending).
Incremental and open-ended; no big-bang migration.

## Goal

Converge core module writes onto the operation core so the UI and Agents share
one implementation of every capability, policy is checked in one place, and
idempotency, errors and audit are uniform.

## Why (findings from the 2026-11 route audit)

- ~1002 routes (436 GET, 566 mutating) across 85 route files; the web client is
  4432 hand-written lines.
- Route-layer policy enforcement is inconsistent: knowledge (49 write routes),
  inquiry, memory, tasks, rooms and agents have none at the route layer; the
  `policy.action_grant` pair enforces create in the service and revoke in the route.
- Same capability, two behaviors: UI `task.create` has no Zod validation or
  policy and accepts `visibility`, `policy_json` and other fields; the Agent
  version has a strict schema, a policy gate and forced `space_shared`.
- Only 4 route files read `Idempotency-Key`; at least three error envelopes.
- ~46 route-level role checks (`requireSpaceOwnerOrAdmin`, `requireInstanceAdmin`)
  would be lost by a generic entry unless moved into operation metadata or services.

## Rules

1. **Standing rule from plan 1**: a new core capability is defined as an
   operation first; its route is an adapter.
2. **Migrate when touched**: changing a module's write path migrates that path.
3. **Order by readiness, then Agent demand**: shared service and matching policy
   first; capabilities Agents use daily next; semantically divergent ones last.
4. **Divergent semantics become separate operations** after a product decision,
   never an actor branch inside an executor.
5. During each migration the old route becomes an adapter with an unchanged URL;
   in tests, old and new paths run side by side and results are compared.
6. Each migrated route passes `origin: "manual"` and gets explicit user rules, so
   rules such as `ruleUnattendedProjectWrite` do not newly require approval or deny.

## Batches

| Batch | Operations | Readiness |
|---|---|---|
| 1 | `research.cancel_acquisition`, `source.backfill.*`, `project.operation.*`, `source.recipe.*`, `policy.action_grant.*` | Route-layer enforce and registry entries already exist |
| 2 | `board.configure`, `task.delete` / `move` / `set_status` | Service shared; only policy differs |
| 3 | Note and Source object actions | Redefine policy first (`note.promote_to_knowledge` maps to `knowledge.create`, default `require_approval`; `note.link.create` is reserved) |
| 4 | Project Work, Inquiry, Tasks by Agent demand | Per module |
| 5 | Memory write, `task.create`, proposal decision | Needs product decisions on divergent semantics |

Permanent exemptions (kept as reasoned custom routes): SSE streams, WebSocket,
multipart upload, file/Range download, auth, Run tool surface, `/internal*`,
host daemon channel, the 8 state-changing GETs (reviewed case by case).

## Work items (per batch)

- [ ] Real schemas and output DTOs for the batch's registry entries.
- [ ] Role checks moved into operation metadata or services.
- [ ] Route converted to adapter; shrink the exemption list.
- [ ] Side-by-side comparison test; one policy decision record per request.
- [ ] Retire module idempotency tables in favour of `operation_idempotency`.
- [ ] Web client calls move to the typed `call` / `query` helpers.

## Watch

- Policy decision record volume once all user writes record decisions; measure
  and decide sampling for low-risk reads.
- UI list latency once reads go through `executor.query`; keep a benchmark.
