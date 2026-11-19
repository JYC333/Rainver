# Plan 7 — Legacy Plugin Migration

Status: started by the user on 2026-11-19 (old plugin entries have no users;
Diary and Finance migrate together; pages are redesigned later, so only the
necessary consumer wiring is in scope). Codex is the only writer. The coordinator and Antigravity review afterwards. Nothing is deployed, published or run against a
live instance or its data.

| Batch | State | Evidence |
| --- | --- | --- |
| Diary | Implemented, privately committed, awaiting review | [Diary package](../../architecture/OFFICIAL_OPTIONAL_MODULES.md#diary-package); `server/test/diaryPluginDb.test.ts`, `apps/web/src/__tests__/diary-page.test.tsx` |
| Finance | Implemented, awaiting review | [Finance ledger package](../../architecture/OFFICIAL_OPTIONAL_MODULES.md#finance-ledger-package); `server/test/financeLedgerPluginDb.test.ts`, `apps/web/src/__tests__/finance-page.test.tsx` |

## Decisions taken at start (2026-11-19)

- Same plugin ids (`diary`, `finance_ledger`); enablement rows and settings
  carry over. The legacy descriptor, routes, page route and adapters are retired
  with no compatibility layer or dual write.
- The initial implementation included an offline copy from the old public
  tables. The follow-up removed it once the owner confirmed there were no
  legacy records to carry over. The installer initializes only the package
  schema and existing migration journals remain intact.
- Diary stays user-level and `sensitive`; save/delete are person-only and the
  only Agent write is an append Proposal. No Agent permission is widened.
- Platform changes only where the migration needed them: removal of the legacy user-scoped proposal-subject check, which had no
  remaining legacy user-scoped package.

## Finance scope

- The manifest registers 24 operations. The UI uses the host operation port
  from the Space navigation entry. Finance contributes no Jobs or schedules.
- Books stay Space-scoped. Private accounts and their derived ledger data keep
  owner filtering. Imports are scoped to their uploader. Validation returns
  codes and visible directive IDs. Posting proposals use the sensitive
  class, and the canonical applier rechecks pending entries under the book lock.
- Reuse / Dependency Check. The operation manifest, PluginDb, canonical
  proposal registry and Web host operations cover registration, SQL, approvals
  and UI calls. The existing ledger domain and Beancount parser cover business
  behavior. No new dependency or external alternative is needed for this migration.

## Boundaries

Product/private-data and deployment acceptance are separate from repository
verification. No dual-write, implicit migration, new approval engine or
permission widening.

See the [ADR 0030 platform interfaces](../../decisions/0030-plugin-agent-data-access.md),
[P5's completed scope](05-core-module-operation-migration.md), and the
[program index](README.md).
