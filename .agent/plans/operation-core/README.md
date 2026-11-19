# Operation Core Program

Date: 2026-11-05; remaining scope reorganized 2026-11-16
Status: Plan 1 is complete within its documented scope. Its four stages and
overall code/final documentation passed Claude/Antigravity dual review. Reviewed
scope is `3e3af010` through `c3156a48` plus the documentation-only correction.
Stage 1: `95d61d90`;
stage 2: `466f88ef`; stage 3: `2edce778`; stage 4: `c3156a48`. The completed Plan 1
temporary ledger is retired into the permanent
[execution contract](../../architecture/OPERATION_EXECUTION_CONTRACT.md),
[SYSTEM_ACTIONS](../../architecture/SYSTEM_ACTIONS.md) and
[acceptance matrix](../../architecture/OPERATION_CORE_ACCEPTANCE.md).
Original Plan 2 delivery was recorded complete within its documented scope: stages `992b5d12`,
`a2e623f3`, `20ef5240` and final whole-P2 read-only code review passed
Claude/Antigravity. Independent ACP `b66f1b52` is excluded from that review scope;
review approval does not imply reviewer test reruns. Its temporary ledger is
retired to the permanent [plugin platform contract and acceptance matrix](../../architecture/OFFICIAL_OPTIONAL_MODULES.md#operation-platform-acceptance),
with a minimal redirect retained at the old path.
A later real-PG security follow-up exposed missed PluginDb role-concurrency and
Unicode/$ temp-table boundaries; its [correction passed independent dual review](../../architecture/OFFICIAL_OPTIONAL_MODULES.md#invocation-role-and-session-follow-up).
The historical P2 approvals/test results do not cover that patch.
Plan 5 is complete within its documented migration scope; see the permanent
[P5 closeout](../../architecture/OPERATION_CORE_ACCEPTANCE.md#p5-closeout).
The plugin Agent data-access platform with its typed core-object host ports
([ADR 0030](../../decisions/0030-plugin-agent-data-access.md), current behaviour in
[OFFICIAL_OPTIONAL_MODULES](../../architecture/OFFICIAL_OPTIONAL_MODULES.md#agent-data-access-adr-0030))
and the runtime DB role procedure ([ADR 0031](../../decisions/0031-runtime-database-roles.md))
are complete within their documented supported scope; Codex and Antigravity gave
final focused approval on `e827b557` (2026-11-17). Their plans are retired. What
they leave open — runtime DB role activation, which requires separate operational
authorization, and the sensitive-read paths that remain unsupported (vendor-login
CLI, paired Host, live provider, ACP adapter processes, OpenCode) — is in the
[deferred register](../../tasks/deferred-register.md). P3 (application management
package) has stages 1–3 and its four-area revision with the funding track
implemented; P6 is conditional, and the Diary and Finance migration is tracked in P7.
The implementation is privately saved, not published or deployed.

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

## Remaining work and order

This index is the operation-core program's remaining-work entry. Existing user
and Agent adapters, the operation executor and P2's basic plugin platform are
implemented; do not reopen them to migrate unused plugins.

| Scope | Status / next work | Owner and dependency |
| --- | --- | --- |
| Runtime DB role activation | Implemented as an explicit procedure; not activated; activation needs separate authorization per instance | [ADR 0031](../../decisions/0031-runtime-database-roles.md); [enablement gate](../../tasks/deferred-register.md#enablement-gates) |
| Application management plugin | Stages 1–3 (Project binding, `applications` package with PhD and funding tracks, Notes materials and generated drafts) and the four-area revision implemented; remaining follow-ups and open product decisions in P3. Separate new-product pilot, not a platform completion prerequisite | [P3](03-phd-application-plugin.md); P2 plus the ADR 0030 gates/ports |
| Later platform extensions | Conditional only; not scheduled core blockers | [P6](06-later-extensions.md) |
| Diary/Finance business and data migration | Started 2026-11-19: Diary rebuilt as an operation package (privately committed, awaiting review); Finance next | [P7](07-legacy-plugin-migration.md); no live data migration |

The ADR 0030/0031 platform work reuses the existing executor, Proposal applier,
audit and Job owners. Fixtures and real-PG tests cover consent, revocation, replay,
Room intersections, typed ports, audit/taint rollback and role separation.
Sensitive access is enabled only under the reviewed consent and isolation gates.
Old-plugin migration, new-product delivery and live-instance activation remain
independent follow-on work; none is implied by this platform completion.

## Documentation ownership

Implemented behavior remains in the execution contract, SYSTEM_ACTIONS,
OFFICIAL_OPTIONAL_MODULES, DATABASE_AND_TRANSACTIONS and security/content-access
owner guides. Plans describe future work only. Update the affected owner guide
when a change lands; do not copy temporary execution logs back into this index.
The permanent acceptance matrix preserves completed-scope evidence and limits.
