# Reuse and Dependency Policy

Date: 2026-08-23

This is the single source of truth for **what to reuse, what to install, and
what to build** in this repository. It applies to every coding agent and every
human change. Module structure rules live in
[`MODULE_DEVELOPMENT_GUIDE.md`](MODULE_DEVELOPMENT_GUIDE.md), test-layer rules in
[`TESTING_STRATEGY.md`](TESTING_STRATEGY.md), and architectural invariants in
[`../BOUNDARIES.md`](../BOUNDARIES.md); this document governs the reuse decision
that comes before all of them and does not restate their contents.

## The Principle

> The code Rainver maintains long-term should mostly be what a generic
> implementation cannot replace: domain semantics, authority, governance,
> policy, data model, and product behaviour.
>
> Generic protocol, parser, scheduler, queue, retry, serialization, date/time,
> file-format, transport, and commodity-infrastructure work should reuse a
> mature implementation — internal first, then an already-installed dependency,
> then a well-maintained external one — unless a recorded reason says otherwise.

The measure is **total maintenance cost and architectural fit**, not lines of
code. Adding a dependency to avoid twenty lines is as much a failure as
hand-writing a cron engine. Neither "we can build it ourselves" nor "there is a
package for it" is a decision on its own.

---

## 1. Mandatory Pre-Implementation Search

Before implementing substantial new behavior, a refactor that introduces or
replaces a shared mechanism, or a substantial helper, complete the applicable
searches below in the working tree. Search the owning area first and expand by
concept; a listed directory is not a requirement to read all its files. For a
small fix within an existing mechanism, inspect that mechanism and its relevant
tests rather than repeating an unrelated repository/dependency survey. Section 9
defines when a written Reuse / Dependency Check is required.

1. **Same module.** Read the owning module's directory listing and its
   `index.ts` facade. Something adjacent usually already exists.
2. **Whole repository.** Search for an existing `helper`, `service`,
   `repository`, `port`, `adapter`, `registry`, `utility`, `schema`, `parser`,
   `fixture`, or shared infrastructure covering the concern. Search by the
   *concept*, not by the name you were about to invent — the existing one is
   almost never called what you would have called it.
3. **Installed dependencies.** Read the relevant `package.json`
   (`server/`, `apps/web/`, `packages/*/`) before concluding nothing can do
   this. Check §5's Canonical Mechanism Index first; it is shorter than the
   manifests.
4. **Recorded rules.** Search `.agent/` for the concern. If a canonical
   mechanism is already designated, use it or change the designation — never
   quietly add a second one.
5. **Test infrastructure.** Search `server/test/support/`, `apps/web/src/test/`,
   and neighbouring test files for an existing fixture, factory, builder, DB
   helper, auth helper, request helper, runtime/provider fake, protocol fixture,
   or assertion helper. See §7.
6. **Only then** design something new — and if the concern is generic, §4 still
   applies before you write it.

Useful starting commands:

```bash
rg -n "<concept>" server/src apps/web/src packages --type ts
rg -n "<concept>" .agent
cat server/package.json apps/web/package.json          # installed dependencies
ls server/src/modules/<module>                          # neighbours first
rg -n "export" server/src/modules/<module>/index.ts     # the facade surface
ls server/test/support                                  # shared test infrastructure
```

---

## 2. The Reuse Ladder

Work down this ladder and stop at the first rung that genuinely fits:

1. **Reuse an existing repository capability** — a facade export, port,
   registry, shared repository, or shared helper.
2. **Reuse an already-installed dependency** — the one this repo already uses
   for that concern (§5).
3. **Adopt a mature external library, SDK, or open standard** — for commodity
   capability, after the evaluation in §4.
4. **Extend an existing internal abstraction** — when the concern is a real
   variant of something we already own.
5. **Build a new internal implementation** — last, and with a recorded reason
   when §4 or §10 applies.

```
existing internal solution
    > existing approved dependency
    > mature new dependency
    > new custom infrastructure
```

**The ladder is not an obligation to preserve a bad abstraction.** If the
existing internal code is the wrong shape, or is a hand-rolled version of
something a mature library does properly, do not extend it to avoid the
conversation. Say so, and propose replacement or migration instead — reuse that
grows technical debt is not reuse.

---

## 3. What Rainver Owns

**Own it. Do not outsource, and do not let a dependency take it over:**

- Domain semantics and the domain data model
- Authority, governance, and policy hard invariants
- Proposal / Approval semantics
- Run semantics and run auditability
- Project semantics
- Memory and Runtime Context semantics
- Provenance and evidence rules
- Space isolation, visibility, and access rules
- Product-specific orchestration decisions

**Do not maintain these merely because we can:**

protocols and protocol clients · parsers · serialization formats · multipart ·
MIME · cron · date/time and timezone handling · job queues · scheduler engines ·
retry/backoff · HTTP proxy semantics · auth/session/OAuth plumbing ·
HTML/XML/RSS parsing · crawling primitives · file-type detection · SSE/WebSocket
framing · decimal/math algorithms · common ranking and scheduling algorithms ·
archive/backup engines · standard observability · standard client/server
transport.

> **Keep the domain boundary; outsource the generic engine where appropriate.**

The Project, Run, and Policy services are ours. The queue, parser, protocol, and
date library underneath them need not be. This is the same principle already
recorded for agent runtimes — *never build our own agent loop, skill runtime,
tool registry, subagent orchestration, or trajectory engine*
([`../tasks/deferred-register.md`](../tasks/deferred-register.md)) — applied one
layer lower.

---

## 4. Mandatory Third-Party Evaluation

If the capability is commodity (anything in §3's second list) and no internal
implementation exists, **check the ecosystem before writing code**. Custom
implementation of a commodity capability requires justification; adoption does
not.

Evaluate at least:

- project maturity and release cadence
- active maintenance (recent, real, not a single dependabot commit)
- API stability
- TypeScript and Node 24 / ESM-CJS compatibility with this repo's build
- security record
- license compatibility
- ecosystem adoption
- dependency and transitive-dependency cost
- operational and bundle/runtime cost
- whether it fits Rainver's authority boundary (§3)
- **whether adopting it actually deletes meaningful maintenance burden**

GitHub stars are not evidence. A popular unmaintained package is worse than a
small maintained one.

A new server runtime dependency additionally requires an entry in
`ALLOWED_BARE` or `ALLOWED_BARE_BY_FILE` in
`server/test/boundaries.test.ts` — prefer the file-scoped form so the dependency
cannot spread beyond the module that needs it — and a row in §5's index.

---

## 5. Existing Dependency First — Canonical Mechanism Index

**Before installing anything, or hand-writing anything, check this table.**
If this repository already has a canonical mechanism for a concern, new code
uses that mechanism. Do not let module A use the canonical one, module B
hand-roll a second, and module C install a third.

This index is deliberately short. It records only cross-cutting concerns that
are easy to reinvent, and only where a canonical choice actually exists today.
It is not a dependency catalogue: `server/package.json`,
`apps/web/package.json`, and `packages/*/package.json` remain the truth about
what is installed.

### Backend mechanisms

| Concern | Canonical mechanism | Where to look |
|---|---|---|
| HTTP server | `fastify` | `server/src/server.ts`, module `routes.ts` files |
| Route registration | `ServerModule` + route registry | `server/src/gateway/routeRegistry.ts` |
| Route helpers (pool access, identity, pagination, parsing, errors) | `routeUtils` support package | `server/src/modules/routeUtils/` |
| Request/response validation and shared DTOs | `zod` | `packages/protocol/src/`, module schemas |
| Control plane ↔ host daemon WebSocket frames | `zod` discriminated unions in `@rainver/protocol`, parsed once at each end and typed on send — **never rebuilt field by field**; the dependency-free `sandbox/runner.mjs` is the one hand-written mapping and is pinned by `server/test/sandboxRunnerClient.test.ts` | `packages/protocol/src/hostWire.ts`, `server/src/modules/hosts/{routes,connectionRegistry}.ts`, `packages/host-daemon/src/commands/run.ts` |
| Database access | `pg` with hand-written SQL, confined to repositories | `server/src/db/`, module `repository.ts` |
| Schema authoring | `drizzle-orm` — **declaration only, never a query layer** | `server/src/db/schema/` |
| Migration artifacts | `drizzle-kit` generate into the committed baseline | `server/migrations/0001_baseline.sql`, `pnpm run schema:generate` |
| Transactions | `withTransaction`, `withQueryableTransaction` | `server/src/db/tx.ts`, `server/src/modules/routeUtils/common.ts` |
| Visibility predicates, role helpers, content-access SQL | `access` support package | `server/src/modules/access/` |
| Outbound HTTP to model providers and CLI runtimes | `undici` + `ProxyAgent` through the network-profile transport | `server/src/modules/networkProfiles/transport.ts` |
| Other outbound HTTP (source fetch, skill import, tool download) | native `fetch` at the call site — there is no shared client for these today; do not invent a second proxy or retry mechanism for them without changing this row | `server/src/modules/sources/sourceFetch.ts` |
| WebSocket server | `@fastify/websocket` — **hosts channel only** | `server/src/modules/hosts/routes.ts` |
| Server-sent events | `streaming` module | `server/src/modules/streaming/` |
| Scoped settings | `ScopedSettingsStore` + typed descriptors | `server/src/modules/settings/` |
| Recurring in-process work and its cursor state | `SchedulerRegistry` + `PgSchedulerTaskStore` (`scheduler_tasks`) | `server/src/modules/scheduler/` |
| Durable async jobs and their retry/attempt semantics | `JobHandlerRegistry` + job worker | `server/src/modules/jobs/` |
| Cron expressions and next-run computation | `cron-parser`, confined to `schedule.ts`, behind the unchanged `computeNextRunAt` / `parseSchedule` / `InvalidScheduleError` façade — replaced a ~245-line hand-rolled parser/DST engine. Evaluated 2026-08-23: MIT, actively maintained, Node 24/ESM-CJS-compatible, adopted by `pg-boss` itself (`^5.7.0`); pulls in one transitive dep (`luxon`). Verified against the old implementation before the swap: day-of-month/day-of-week OR semantics match; the DST spring-forward gap does not — cron-parser/Luxon shift the instant forward by the gap length instead of skipping to the next valid day. That behavior change was evaluated and accepted (not preserved), confined to schedules whose configured minute falls inside a timezone's ~1hr yearly transition window; locked in by a regression test. | `server/src/modules/automations/schedule.ts` |
| Proposal-gated writes | proposal applier registry | `server/src/modules/proposals/` |
| Agent task/conversation context | `RuntimeContextGatewayPort` facade | `server/src/modules/runtimeContext/` |
| Model invocation and provider credentials | `providers` (+ `runtimeHost` for server-owned execution) | `server/src/modules/providers/` |
| Managed agent/tool loop | `managedAgentLoopPort` + binding over `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` | `server/src/modules/runs/managedAgentLoopPort.ts` |
| Runtime adapter metadata (commands, flags, parsers, limits) | `RuntimeAdapterSpec` | `server/src/modules/runtimeAdapters/specs.ts` |
| Project Folder path safety | `PathPolicy` | `packages/folder-read/src/pathPolicy.ts` |
| Full-system backup | `BackupService` | `server/src/modules/backups/service.ts` |
| XML parsing | `fast-xml-parser` | `server/src/modules/sources/` |
| PDF text extraction | `unpdf` — confined to the extractor | `server/src/modules/sources/pdfExtract.ts` |
| YAML | `yaml` | catalog/manifest readers |
| PTY | `node-pty` — confined to the CLI login engine | `server/src/modules/providers/cli/loginEngine.ts` |
| Date/time | **no library by design** — native `Date`/`Intl`, `timestamptz` in Postgres, timezone-aware helpers in the owning module. Exception: cron next-run computation, which needs real calendar/DST arithmetic and uses `cron-parser` (see the row above) — everything else (storing, comparing, formatting an instant) stays native. | `server/src/modules/automations/schedule.ts` |

### Runtime / execution-host mechanisms

| Concern | Canonical mechanism | State | Where to look |
|---|---|---|---|
| Vendor coding-CLI conversation protocol | **Agent Client Protocol (ACP)** via the official `@agentclientprotocol/sdk` (server dependency, confined to `cliConversationProtocol.ts`); the server is the ACP client, the daemon relays bytes and parses nothing | **Current** for all three implemented CLI runtimes (claude, codex, opencode — all `protocol: "acp"`). Rainver owns JSON-RPC framing (envelope, request ids) and the request/response lifecycle (`initialize`/`session/new`/`session/resume`/`session/set_config_option`/`session/prompt`/`session/update`) as a hand-rolled phase dispatcher — by design, not gap: no SDK hook reproduces its tested start()-independent, phase-named anomaly handling (D6, twice-corrected during the retired execution-topology plan's P0 — git history). The SDK's contribution is the ACP schema/method vocabulary itself: wire shapes are checked against SDK-exported types (e.g. `PermissionOption`) rather than trusted by convention; it is not doing runtime schema validation and its higher-level client API (`client()`, `connectWith()`, `ClientContext`, `ActiveSession`) is unused. Rainver also keeps canonical event normalization, permission decision (`runPermissionPolicy.ts`), Run/thread ownership, and usage/audit. `gemini_cli` is `implementation_status: "planned"` and speaks no protocol yet. | `server/src/modules/runs/cliConversationProtocol.ts`, `server/src/modules/runs/runPermissionPolicy.ts`, `server/src/modules/runtimeAdapters/specs.ts` |
| ACP adapters for vendors without native ACP | pinned npm packages spawned as executables by the host daemon | Current; exactly two (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`). If a vendor ships native ACP, delete the dependency. **Do not write a protocol adapter.** | `packages/host-daemon/package.json` |
| Host daemon ↔ control plane transport | native global `WebSocket` (Node 24) + duplex stdin frames | Current; the daemon has no runtime dependency other than the two ACP adapters — keep it that way. | `packages/host-daemon/src/commands/run.ts`, `packages/host-daemon/src/execution.ts` |

### Frontend mechanisms

| Concern | Canonical mechanism | Where to look |
|---|---|---|
| HTTP calls to the backend | the typed API client — never bare `fetch` in a component | `apps/web/src/api/client.ts` |
| Routing | `react-router-dom` + the module registry | `apps/web/src/modules/registry.ts`, `apps/web/src/App.tsx` |
| Module/nav registration | module registry with lazy entry points | `apps/web/src/modules/registry.ts` |
| Form controls and primitives (incl. `Select`, `DatePicker`) | `apps/web/src/components/ui/` over Radix — **never a bare `<select>`** | `apps/web/src/components/ui/` |
| Class composition | `cn()` over `clsx` + `tailwind-merge`, with `class-variance-authority` for variants | `apps/web/src/lib/utils.ts` |
| Styling | Tailwind v4 | `apps/web/src/index.css` |
| Icons | `lucide-react` | components |
| Toasts | `sonner` | `apps/web/src/core/Shell.tsx` |
| Graph rendering | `@antv/g6` behind the graph renderer boundary | `apps/web/src/components/graph/core/createGraphRenderer.ts` |
| Rich text editing | TipTap | `apps/web/src/components/editor/` |
| Markdown → editor document | `markdown-it` | `apps/web/src/components/editor/markdownToProseMirror.ts` |
| Drag and drop | `@dnd-kit` | components |
| Conversation / Agent-turn UI | **AI Elements** (Vercel's shadcn registry) — copied source under `components/ai-elements/`, not a runtime dependency, so it is edited in place like any other component here; re-add through the CLI rather than merging | `apps/web/src/components/ai-elements/`, `components.json` |
| Markdown rendering (chat) | `streamdown` — via AI Elements' `MessageResponse`; tolerates the half-formed markdown a stream produces mid-token | `apps/web/src/components/ai-elements/message.tsx` |

### Testing mechanisms

| Concern | Canonical mechanism | Where to look |
|---|---|---|
| Test runner (all packages) | `vitest` | `server/`, `apps/web/`, `packages/*` |
| Real PostgreSQL for durable behaviour | shared Testcontainers instance via `getTestPostgres(__filename)` | `server/test/support/sharedPostgres.ts` |
| SQL/parameter shape without a database | captured-SQL helper | `server/test/support/sqlCapture.ts` |
| Provider HTTP fakes | shared upstream mock | `server/test/support/mockUpstream.ts`, `server/test/support/piAiHttp.ts` |
| Frontend test environment | jsdom + Testing Library, configured once | `apps/web/src/test/setup.ts`, `apps/web/vitest.config.ts` |

---

## 6. Existing Repository Capability First

Search before writing a helper, function, or service — especially for a
cross-module concern. Look for a public facade, a shared support package, a
port, a registry, a shared repository, a shared policy or transaction helper, a
shared path/security helper, or a shared test fixture. `MODULES.md` lists the
support packages and facades;
[`MODULE_DEVELOPMENT_GUIDE.md`](MODULE_DEVELOPMENT_GUIDE.md) owns the facade,
port, registry, and extension-point rules in detail.

When the helper you need exists but is not exported by a facade, pick one of
three — **never a fourth**:

1. Add a **narrow export** to the existing facade.
2. **Extract** it to the correct shared owner (support package or shared module).
3. Keep it private and reach it through the owning module's **service or port**.

Copying the implementation to avoid a module boundary is not one of the options.
Neither is a deep cross-package import; the deep-import allowlist stays empty by
default.

---

## 7. Tests Reuse Test Infrastructure

The rules for what to test and which layer to test it in live in
[`TESTING_STRATEGY.md`](TESTING_STRATEGY.md). This section adds only the reuse
obligation.

Before building test setup, search for an existing fixture, factory, builder,
Testcontainers helper, DB helper, auth helper, request helper, runtime or
provider fake, protocol fixture, assertion utility, or integration harness —
`server/test/support/` first, then a neighbouring test file for the same domain.

- Do not stand up a second Testcontainers instance, an ad-hoc database, or a
  fake `Queryable` in place of the shared PostgreSQL infrastructure for a
  durable-behaviour test.
- Do not re-implement a fake runtime or fake provider that already exists.
- When the same setup appears a **second or third** time, promote it into
  `server/test/support/` instead of copying it again.
- A shared helper is preferable to a copied one even when the copy is shorter.

---

## 8. No Parallel Implementations

**One semantic concern, one canonical implementation.** If you find yourself
adding a second one because you are not sure where the first lives, stop and
finish the search from §1 — "I could not find it" is not a licence to build it.

When an old implementation, a new implementation, and a migration adapter must
coexist for a while, the change that creates that state must name, in the plan
or the architecture doc:

- the **canonical owner** — which one is authoritative,
- the **compatibility layer** — what the adapter is for and who may call it,
- the **deprecation path** — what deletes the old one and what triggers it.

A migration state with no recorded end is a permanent duplicate. Where a clean
cutover is possible (no running instance to migrate), prefer it — that is the
call ADR 0016's replatform work made deliberately and twice.

---

## 9. Reuse / Dependency Check In Change Plans

Any substantial change — a new subsystem, new infrastructure, a new shared
mechanism, or a new dependency — records a short **Reuse / Dependency Check** in
its plan or change description before implementation begins:

```
Reuse / Dependency Check
- Existing repository capability found? <what, or "no — searched X, Y, Z">
- Existing installed dependency found?  <what, or "no">
- Mature external option evaluated?     <name + verdict, or "n/a — domain logic">
- Chosen approach:                      <reuse | adopt | extend | build>
- Why:                                  <one or two sentences>
```

Five lines is a complete answer. A bug fix, a small behaviour change, or work
entirely inside one module's existing mechanism needs none of this. A new
subsystem or infrastructure mechanism must not land without it — the point is
that the next agent can see the decision was made, not that a document exists.

---

## 10. When Custom Implementation Is Right

Building it ourselves is correct when any of these hold:

- It is Rainver domain semantics, authority, or governance (§3).
- A third-party solution would take over authority we must keep — policy,
  approval, credential handling, Space isolation, provenance.
- The license is incompatible.
- A security or trust boundary requires an explicit local implementation we can
  audit.
- The dependency's complexity, transitive cost, or operational burden exceeds
  the complexity it removes.
- The ecosystem options are immature, unmaintained, or effectively abandoned.
- API, runtime, or platform incompatibility (ESM/CJS, Node 24, our build).
- A genuinely small implementation is more stable and clearer than adopting a
  large framework for one function.

Record the reason where its importance says it belongs: a code comment for a
local call, an architecture doc for a mechanism, an ADR for a decision that
constrains future work. One or two sentences that say *why not the obvious
library* is enough — a reader six months later needs the reason, not an essay.

---

## 11. Enforcement

**Automated** (these fail the suite):

- `server/test/boundaries.test.ts` — the server may import only allowlisted bare
  packages; several are confined to a single file or directory. A new server
  dependency cannot spread silently, and adding one is a visible, reviewable
  edit.
- `server/test/agentGuides.test.ts` — `AGENTS.md` and `CLAUDE.md` keep pointing
  at this policy and share one canonical core; every runtime dependency in
  `server/package.json` appears in §5's index.

**Review-only** (not automatable without brittle string matching):

the pre-implementation search itself, the reuse ladder, third-party evaluation
quality, the Reuse / Dependency Check, and whether a custom build was justified.
These belong in code review and in the plan, and no test is added to fake
coverage of them.
