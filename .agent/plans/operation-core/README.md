# Operation Core Program

Date: 2026-11-05
Status: Plan 1 is complete within its documented scope. Its four stages and
overall code/final documentation passed Claude/Antigravity dual review. Reviewed
scope is `3e3af010` through `c3156a48` plus the documentation-only correction.
Stage 1: `95d61d90`;
stage 2: `466f88ef`; stage 3: `2edce778`; stage 4: `c3156a48`. The completed Plan 1
temporary ledger is retired into the permanent
[execution contract](../../architecture/OPERATION_EXECUTION_CONTRACT.md),
[SYSTEM_ACTIONS](../../architecture/SYSTEM_ACTIONS.md) and
[acceptance matrix](../../architecture/OPERATION_CORE_ACCEPTANCE.md).
Plans 00/02–06 remain unfinished. No deployment or whole-program completion is
implied. Plans remain forward-looking outside the explicit current
implementation described in the architecture guides.

## Goal

Every write in Rainver executes through **one operation execution core**, and
every capability a plugin adds is usable by both people and Agents through that
same core. URLs stay plural: existing REST routes, a generic operation entry,
the Agent tool entry and a later MCP entry are thin adapters that all call the
same `executor.execute(opId, input, actor)`.

The first product built on this is the PhD application plugin, which doubles as
the pilot for the plugin contract.

## Principles shared by every plan

1. **One execution core, many entries.** Validation, policy, idempotency,
   transaction, audit and approval live only in the core. Entries authenticate,
   assemble input, build the actor context and map results to their transport;
   they never authorize.
2. **A plugin operation is a System Action.** Namespaced
   `plugin.<plugin_id>.<entity>.<verb>`, registered from a static manifest,
   gated by plugin enablement, executed by the same core.
3. **People and Agents share operations, not authority.** An Agent's effective
   authority is the intersection of the instructing person's authority and its
   grants. Where product semantics genuinely differ, they are different
   operations, modeled explicitly — never an `if (agent)` inside an executor.
4. **The host guarantees side-effect classes.** A plugin may raise its gating,
   never lower it; a read operation gets a read-only transaction.
5. **Plugins are first-party, same-process and fully trusted.** Third-party
   plugins are out of scope; ports stay serializable so that can change later.

## Plans and order

| # | Plan | Depends on | Can run in parallel with |
|---|---|---|---|
| 0 | [Audit defect fixes](00-audit-defect-fixes.md) | — | everything |
| 1 | [Implemented core — Plan 1 reviewed and complete](../../architecture/OPERATION_CORE_ACCEPTANCE.md) | — | 0 |
| 2 | [Plugin operation platform](02-plugin-operation-platform.md) | 1 | 0 |
| 3 | [PhD application plugin (pilot)](03-phd-application-plugin.md) | 2 | 4 |
| 4 | [Plugin Agent access and data sensitivity](04-plugin-agent-access-and-sensitivity.md) | 2 | 3 |
| 5 | [Core module migration to the operation core](05-core-module-operation-migration.md) | 1 | 2, 3, 4 |
| 6 | [Later extensions](06-later-extensions.md) | 2 | — |

Plan 1 implementation and overall dual-review approval are recorded in the
permanent owner documents above. Plan 5 is incremental and open-ended: its
standing rule ("new core capabilities are operations first") takes effect
as soon as plan 1 lands, and existing modules migrate when touched.

Until plan 4 lands, sensitive plugin data (diary entries, private finance
accounts) stays invisible to Agents — the fail-closed default, not a gap.

## Documents to rewrite when the program lands

- [SYSTEM_ACTIONS](../../architecture/SYSTEM_ACTIONS.md) — the core becomes
  actor-neutral with user, Agent and later MCP entries.
- [OFFICIAL_OPTIONAL_MODULES](../../architecture/OFFICIAL_OPTIONAL_MODULES.md)
  and [ADR 0006](../../decisions/0006-plugin-module-architecture.md) — the
  plugin contract becomes manifest + operations + scoped database port.
- [DATABASE_AND_TRANSACTIONS](../../architecture/DATABASE_AND_TRANSACTIONS.md)
  — core-owned operation transactions, plugin schema and role isolation.
- [SECURITY_AND_ACCESS_BOUNDARIES](../../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
  — plugin data classes, owner consent, Agent read audit.
- [ADR 0028](../../decisions/0028-operation-execution-core.md) already records
  the Plan 1 core decision; later plugin implementation needs its own updates.


Plan 1's production scope is one research.cancel_acquisition pilot plus the
metadata query. No approval-bearing business family is enabled: the eight legacy
Proposal writer families remain for later migration and fail closed on generic
approval paths. Test-only mechanism evidence is not production migration closure.
The permanent acceptance matrix records real faults, cutover limits and review
status. Preserve the independent/uncompleted plans 00/02–06.
