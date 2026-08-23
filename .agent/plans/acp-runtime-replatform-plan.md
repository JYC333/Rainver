# ACP Runtime Replatform

Date: 2026-08-22
Status: **APPROVED** (grilling session 2026-08-22); **both prerequisite
verifications passed the same day** (§4) — so P1 is unblocked and starts on
the user's explicit instruction, per the phase-gated discipline.

Replaces `control-center-phase2-plan.md`, which shipped its P1–P3 (normalized
event pipeline, conversation semantics, conversation UI) and was deleted
2026-08-22; its execution ledger lives in git history, its durable
current-state description in [modules/hosts.md](../modules/hosts.md) and
[ADR 0016](../decisions/0016-control-plane-execution-hosts.md). That plan's
still-live decisions are carried forward in §6 below, and its acceptance gate
becomes this plan's §5.

---

## 1. Why this exists

Phase 2's acceptance gate asks one question: **does the conversational
surface actually replace the user's real habit of running a coding CLI by
hand on a machine?** On the first real-usage day it became clear a
claude-only build cannot answer it — the user's daily workflow alternates
`claude` and `codex`, and remote dispatch implements only `claude_code`
(`codex`/`opencode` are detected but rejected: their
`argument_rendering_strategy` is `ndjson_rpc`, which the remote path has no
execution model for). Running the two-week window claude-only would prove
the claude slice works, which is a weaker and different claim.

Tracing that gap down found the real cause is not "codex is missing" but
**we are maintaining vendor protocol adapters ourselves** — and that is not
this project's core capability. The standing principle already recorded in
[tasks/deferred-register.md](../tasks/deferred-register.md) ("never build our
own agent loop / skill runtime / tool registry / subagent orchestration /
trajectory engine") applies one layer lower than we had been applying it.

**The Agent Client Protocol (ACP)** is the industry answer at exactly this
layer, and this repo already speaks it without having noticed: `opencode`'s
spec carries `protocol: "acp"`, `cliConversationProtocol.ts` has a working
`OpenCodeAcpController`, `cliRuntimeMeasurement.ts` has `usageFromAcp`, and
`runtimeEventNormalization.ts` normalizes opencode's `session/update`. It was
treated as opencode's private protocol rather than as a general vocabulary.

## 2. Decisions this plan encodes (agreed 2026-08-22, grilling session)

| # | Decision |
|---|---|
| A1 | **Adopt ACP wholesale; delete every self-maintained vendor protocol implementation.** ACP is the only protocol at the right layer — MCP connects agents to tools, A2A connects agents to agents, AG-UI connects *your own* agent to *your own* UI; none of them let you consume a third-party coding-agent CLI. The official registry lists 39 agents including claude, codex, opencode, pi, gemini, copilot, qwen, cursor, cline, goose. **Most are natively ACP** (a `--acp` flag on the vendor's own CLI); only claude and codex need a wrapper adapter today, and if their vendors ship native ACP those two dependencies simply get deleted. |
| A2 | **Transport = daemon duplex stdin frames; the server is the ACP client.** `launch` gains a keep-stdin-open mode, plus a new `stdin` frame (server → daemon) and a close signal. The daemon still only relays bytes — it never parses ACP. This preserves ADR 0016's "the daemon must not become a vendor protocol translator", and in fact strengthens it: under ACP the daemon does not need to understand even one protocol. **This is not a reversal of phase 2's C7** for codex — C7 rejected writing a *bespoke NDJSON-RPC relay per runtime* in the daemon; ACP is one universal protocol carried over a generic byte pipe. C7's opencode half *is* superseded (see A3). |
| A3 | **C7's `OpenCodeServerAdapter` (HTTP/SSE via daemon tunnel) is superseded and will not be built.** opencode speaks ACP over stdio natively (`opencode acp --cwd <dir>`, already in `specs.ts`), so the same stdio pipe every other runtime uses serves it too. One transport, not two. C7's *rejections* survive unchanged: OpenCode-first as the execution foundation stays rejected (it substitutes API spend for the subscription quota that motivates this whole topology), and host-local engines are still never exposed to inbound network access. |
| A4 | **Migrate both execution paths — remote and server-host — together, per runtime.** `createCliConversationController` is invoked for any spec carrying `invocation.protocol`, on *every* server-host run (chat, Room, Project Research, evolution), not only chat. Leaving server-host on the old controllers would mean the deleted code lives on under another name, and two protocol implementations coexist indefinitely. **No intermediate state.** |
| A5 | **Migration order: opencode → codex → claude.** opencode is already ACP, so the first phase is a pure refactor whose existing tests prove the generalized abstraction holds — the abstraction gets validated in phase one rather than discovered to be leaky in the last one. claude goes last because it is the only path that works today and by far the largest change: it currently has *no* controller at all (argv + stdout parsing), so it gains one while also changing command shape, output parsing, usage measurement, and session-resume mechanism, on both paths. |
| A6 | **Adapters ship as pinned npm dependencies of the daemon; the registry is human reference, never a runtime source of truth.** Exactly two packages (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`); opencode needs none. These are spawned executables, not imported libraries. **An ACP adapter is part of our own client implementation, not a "runtime"** — so hosts.md's standing rule that the daemon never installs or version-manages runtimes (trusted hosts use whatever the machine already has) is unchanged: the vendor CLI underneath must still be present, and the capability probe still checks for it. Adding a future agent = one `specs.ts` entry (`headless_command_template` + `protocol: "acp"`) and **zero protocol code**; per-agent capability differences are negotiated at `initialize`, never hardcoded. Fetching the registry at runtime and executing a command string it supplies is rejected as a supply-chain surface disproportionate to a system this careful about credentials. |
| A7 | **Session continuity uses `session/resume`.** ACP requires `session/load` to replay the entire conversation as `session/update` notifications before responding — correct for an editor rebuilding its window, redundant for us, since A8 keeps our own record. `session/resume` (no replay) is the method we want, and **§4's verification found all three agents advertise it**, so the fallback below is dead code we should not write. *(Fallback, if a future agent ever advertises only `loadSession`: call `load` but suppress every update received before its response resolves. Do not build this speculatively.)* |
| A8 | **`host_thread_events` remains our own durable record — it is not a cache of the agent's session.** Six reasons the agent's replay cannot replace it: (1) it requires that machine to be online and able to spawn a process, while the product's whole shape is reading a conversation in a browser; (2) opening a page would mean waking a remote process and streaming all history, versus one DB read; (3) a Project member who owns no host can still read a thread today (hosts.md), and cross-project landing aggregates threads across machines — neither works from per-host session files; (4) our table holds what the agent does not know (stderr diagnostics, run lifecycle, the message-queue ledger, cross-run thread structure); (5) vendor sessions die — `session_reset` exists today, ACP has `session/delete`, compaction rewrites history, and clearing `~/.codex` erases it; (6) provenance and audit cannot be outsourced to a vendor CLI's local state directory. **Recorded as a future repair path**: P1 made event writes best-effort and silently swallowed, so `session/load`'s replay is the only mechanism that could ever reconstruct a gap — not a routine mechanism, but the one to reach for if data loss is ever found. |
| A9 | **Absorb four things from ACP's richer vocabulary; decline three.** Take: `tool_call.kind` (9 categories — the piece that makes claude and codex *comparable*, e.g. codex's `commandExecution` and claude's `Bash` both becoming `execute`), `tool_call.status` (4 states, adding `in_progress`), **tool result content** (bounded, like the existing input summary — but see §4: codex-acp 1.6.2 returns none, so this field is populated for claude and opencode only), and **`plan`** (appended as snapshots, UI renders only the latest). Decline: the `terminal/*` protocol (its methods run *client*-side, so honoring them from a server whose workspace is on someone else's machine would mean proxying an entire second execution channel back down the tunnel), the `diff` content variant (the daemon's `git diff HEAD` with intent-to-add captures the workspace's true state including changes the agent never reported — strictly better for review), and `usage_update`'s token payload (per-turn usage comes from `session/prompt`'s own `result.usage` instead — **but not the whole event: its `_meta` carries claude's live rate-limit data, see §4**). |
| A10 | **Clean cutover: no compatibility layer, no dual-protocol period.** There are no running instances to migrate. This is the same call phase 2's C2 made for the same reason; recorded again so nobody adds a compatibility shim "to be safe" during implementation. |

### Why tool result content and `plan` are in, having first been ruled out

Both were initially declined as "nice but not worth the schema churn", then
reversed on the evidence of what the acceptance gate actually demands:

- **Tool result content.** Today expanding a tool row shows a 200-char input
  summary and a status badge — *what the command printed is nowhere*, because
  a subprocess's output goes to the agent, not to the agent process's own
  stderr, so the `diagnostic` channel never sees it. The gate requires "≥1
  failure diagnosed via the diagnostics drawer without opening a terminal on
  the host", which is close to unreachable while command output is invisible.
  Capturing what the agent reports as a tool's result gets most of what the
  expensive `terminal/*` route would, for one bounded nullable column.
- **`plan`.** The remote surface's defining use is *dispatch and walk away*;
  the first question on returning is "how far along is it", which a stream of
  tool calls answers poorly and a progress checklist answers directly. Its
  mutate-in-place nature is handled by appending snapshots, keeping the event
  log append-only.

**Accepted risk (documented, not fixed):** tool result content widens data
exposure — it can carry file contents or secrets printed by a command.
`host_thread_events` has no redaction tier (a P1 discovery-review finding,
accepted then on the grounds that remote-host CLI runs are already a
low-trust channel and the daemon already uploads unredacted diffs). Bounded
length is the only mitigation; the exposure category is not new, but it grows.

## 3. Phases

Executed per the phase-gated discipline (independent review + commit per
phase, final cross-phase integration gate — not optional).

### P1 — Generalize the ACP controller (server-host, opencode, no behavior change)

Lift `OpenCodeAcpController` into a general `AcpController`: capability
negotiation from `initialize`, `session/new` / `session/resume` / `session/load`,
`session/prompt`, `session/cancel`, `session/update` handling, and
`session/request_permission` auto-approval. Client capabilities must advertise
`fs` and `terminal` as **false** — otherwise the agent will ask *us* to read
files and run commands, and on the remote path the server cannot reach the
workspace at all. (The existing controller already sends
`clientCapabilities: {}`, which is correct; make it explicit and deliberate.)

Only opencode is wired to it, only on the server-host path, with no behavior
change — the existing suite is the proof the abstraction holds.

### P2 — Daemon duplex frames + the remote ACP channel

`launch` gains keep-stdin-open; new `stdin` frame (server → daemon) and close
signal; `RemoteWsCliCommandExecutor` learns to drive a controller (line-split
incoming `output` frames into the controller, send the controller's writes as
`stdin` frames). opencode becomes the first runtime to prove the remote ACP
path — **and gains remote support as a side effect**, having had none.

### P3 — Codex on ACP (both paths) + schema absorption

`codex_cli`'s spec points at `@agentclientprotocol/codex-acp` with
`protocol: "acp"`; `CodexAppServerController` is deleted; server-host and
remote both run through the general controller. `remote_eligible` in the
runtime-adapters catalog stops keying off `argument_rendering_strategy ===
"argv_template"`.

Schema lands here rather than in P5 so codex arrives with `tool_kind` already
available to render alongside claude: `host_thread_events` gains tool kind,
the fuller status set, a bounded tool-result column, and a plan-snapshot event
type; the conversation UI renders them.

### P4 — Claude on ACP (both paths)

The largest phase. `claude_code`'s spec points at
`@agentclientprotocol/claude-agent-acp`; claude gains a controller for the
first time; stream-json normalization, resume-argv rendering, and
claude-specific usage measurement are replaced by their ACP equivalents on
both the server-host and remote paths.

**Must also settle what §4 documents about claude's usage**: read live quota
from `usage_update`'s `_meta._claude/rateLimit` (the relocated
`rate_limit_event` payload) so `recordLiveQuota` keeps working, and decide
explicitly whether losing the per-model token split is acceptable. Neither
may be discovered in P5 when the old parser is deleted.

### P5 — Legacy deletion and closure

Delete what the migration replaced: `CodexAppServerController`, the
claude/codex/opencode branches of `createVendorEventStream` and
`threadEventNormalization`, `parseVendorStructuredOutput`'s per-vendor
parsing, and any now-dead `argument_rendering_strategy` gating. Update
`hosts.md` and ADR 0016 to describe the shipped state.

## 4. Prerequisite verification — **BOTH PASSED 2026-08-22**

Verified by hand against real adapters on the user's own machine before any
implementation, using a throwaway empty working directory and with
`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, and `OPENAI_API_KEY` all stripped from
the environment so that any dependence on them would fail loudly rather than
silently bill.

**① Subscription billing survives the adapters — PASSED.**
`claude-agent-acp` 0.70.0 reported `apiType=native baseUrl=native` and
advertised `authMethods: []` — it required no authentication because it had
already inherited the existing Claude Code login state; the Anthropic console
showed no API usage for the turn. `codex-acp` 1.6.2 completed a turn with no
API key present in the environment at all, so it used the ChatGPT login state
in `~/.codex`.

**② `sessionCapabilities` — PASSED, better than the plan assumed.** All three
advertise `resume`, so A7's main path applies everywhere and **the
replay-suppression fallback is not needed**:

| Agent | version | sessionCapabilities |
|---|---|---|
| opencode | 1.18.11 | `close` `fork` `list` **`resume`** |
| claude-agent-acp | 0.70.0 | `additionalDirectories` `close` `delete` `fork` `list` **`resume`** |
| codex-acp | 1.6.2 | `additionalDirectories` `close` `delete` `list` **`resume`** |

### Findings from the verification that change or sharpen the plan

- **`codex-acp` bundles its own `@openai/codex` and spawns that by default**,
  not the machine's installed codex. Its platform binary is an npm *optional*
  dependency that does not reliably install under `npx` — the first probe
  failed on exactly that. The adapter documents **`CODEX_PATH`** to run a
  specific executable instead. A6 therefore requires setting `CODEX_PATH` to
  whatever the capability probe found, both to avoid two divergent codex
  versions on one machine and because driving the CLI the machine already has
  is what hosts.md's trusted-host rule means. **`NO_BROWSER=1` is also
  required on a remote host** — one of codex-acp's auth methods opens a
  browser, which a headless machine does not have.
- **Codex has two billing-hijack environment variables, not one**:
  `CODEX_API_KEY` (documented as taking precedence) and `OPENAI_API_KEY`.
  ADR 0008's channel isolation must cover both wherever it covers
  `ANTHROPIC_API_KEY`.
- **`claude-agent-acp` advertises `_meta.claudeCode.promptQueueing: true`** —
  the protocol-level capability behind mid-turn steering already exists.
  Recorded against that deferred item's trigger; **not pulled into this
  plan**, which still builds only the transport (§6).
- **Three update kinds arrive that A9's table does not name**:
  `available_commands_update`, `session_info_update`, and `usage_update`.
  None carries conversational content, so none produces a thread event —
  but two are not simply discardable: `usage_update`'s `_meta` is where
  claude's live rate-limit data now lives, and `session_info_update` carries
  a generated session title (see below).
### A9's absorption decisions, verified against a tool-using turn

A second probe ran a four-step file-touching task against all three agents.

- **`tool_call.kind` — confirmed, and the payoff is real.** The three agents
  independently classify the same operations identically: claude's `Write`,
  codex's `Editing files`, and opencode's `write` all arrive as `edit`;
  claude's `Terminal` and opencode's `bash` both as `execute`; all three
  file reads as `read`. A9's bet — that `kind` is what makes runtimes
  comparable so the frontend never needs to know which one produced a row —
  holds against observed traffic, not just the spec.
- **`tool_call.status` — confirmed**, though granularity differs per agent
  (claude `pending → completed`, codex `in_progress → completed`, opencode
  `pending → in_progress → completed`). Absorbing the full four-value set
  costs nothing and tolerates the variation.
- **Tool result content — confirmed for claude and opencode, ABSENT for
  codex.** claude returned content on 4/4 tool calls (both `content` and
  `diff` variants), opencode 4/4 (`content`). **codex-acp 1.6.2 returned
  none at all** — its tool calls carry a title and a terminal status and
  nothing else. This is not a protocol limitation but an adapter
  implementation choice, and it has a direct product consequence: the
  acceptance gate's "diagnose a failure without opening a terminal on the
  host" is materially weaker for codex, where a failed step shows only
  "List files → completed" with no output. **Recorded as a known asymmetry
  to re-check on adapter upgrades, not designed around** — the column is
  still worth adding for the two runtimes that populate it.
- **`plan` — not observed** on any agent for a task this small. The decision
  to absorb it stands on the spec; re-check when a genuinely multi-step task
  runs, and do not treat an empty plan stream as a bug before then.
- **The `diff` content variant does arrive** (claude emitted it for both file
  writes, with path/oldText/newText). A9's decision to keep the daemon's
  `git diff HEAD` instead is unchanged — it captures the workspace's true
  state including whatever the agent never reported — but it is now known to
  be available should that ever be revisited.

### Usage: per-run tokens connect seamlessly; one attribution gap

ACP carries two distinct usage channels, and only one of them is what our
`CanonicalUsage` models:

- **`session/prompt`'s `result.usage` — use this.** All three agents return a
  complete breakdown that passes `usageFromAcp`'s strict validation
  unchanged, including its requirement that `totalTokens` equal the sum of
  the parts (claude 2+4+8113+6090=14209; codex 6058+6+11008+0=17072;
  opencode 507+15+7296+4=7822). No per-runtime field mapping is needed —
  `cliRuntimeMeasurement.ts` already parses exactly this shape for opencode.
- **`usage_update` notifications — ignore the payload, but read its `_meta`.**
  The payload itself is a different metric: context-window occupancy
  (`used`/`size`) plus a cost figure that is **not trustworthy as real
  spend** (claude reported $0.0656545 for a subscription-billed turn — a
  notional API-equivalent price — and its reported `size` changed from
  200000 to 1000000 mid-turn). Cost stays computed from tokens as today.
  **But `_meta` on the same notification is where claude's live rate-limit
  data now lives**, so this event cannot be dropped at the transport layer —
  see §4.
**One claude-only regression, not two — a later probe reversed the other.**
`cliRuntimeMeasurement.ts`'s three parsers are not equivalent:
`parseClaude` extracts both a **per-model usage breakdown** (from the
terminal result's `modelUsage`, so a turn that used more than one model is
attributed per model) and **live subscription quota** (from claude's
`rate_limit_event`), while `parseCodex` and `parseOpenCode` return `[]` and
`null` for both. ACP's usage channel carries neither:

- **Per-model attribution — degraded, not lost.** `session/new` returns a
  `configOptions` array whose `model` entry carries `currentValue`, so the
  *selected* model is knowable. But claude reports `"default"` rather than a
  concrete model id (its own description glosses that as Sonnet), and
  nothing exposes the per-model split when a single turn uses more than one
  model. So `UsageObservation.model` can be populated with the selection,
  while claude's current ability to attribute one turn's tokens across
  several models is genuinely lost. Total token usage stays exact either way.
- **Free quota refresh — NOT lost; this reverses an earlier finding in this
  section.** claude's per-run `rate_limit_event` feeds
  `credentialBroker.recordLiveQuota()` today. A later probe found ACP
  carries the same payload, relocated: `usage_update`'s `_meta` contains
  `_claude/rateLimit` with `status`, `resetsAt`, `rateLimitType`,
  `utilization`, and `isUsingOverage`. P4 changes where that data is read
  from, not whether it exists. **This means `usage_update` cannot be
  ignored outright after all** — A9 declines its *token* content, but its
  `_meta` is the quota carrier and must be read.

The remaining loss is claude-only; codex and opencode never had per-model
attribution, so P3 is unaffected. P4 must decide whether losing the
per-model split is acceptable (recording the selected model only) before
claude's stream-json parser is deleted in P5.

### Capabilities ACP adds that the current system does not have

`session/new` returns each agent's `configOptions`, and the contents are
worth more than the migration costs:

- **Model switching works on all three — and codex gains it.** Our spec
  currently declares `codex_cli` as `supports_model_override: false`, which
  is true of its CLI but not of ACP: it advertises seven models plus a
  separate `reasoning_effort` scale and a `fast-mode` toggle. claude offers
  default/sonnet/fable/opus and an `effort` scale (low → max); opencode
  offers nine models. `session/set_config_option` is the mechanism, already
  exercised by the existing opencode controller.
- **Permission policy becomes a normalized, per-session setting.** Today
  claude gets a blanket `--dangerously-skip-permissions` and codex gets
  `approvalPolicy: "never"` plus a sandbox string — two vendor-specific
  hacks. ACP exposes a standard `mode` option: claude's
  `auto`/`default`/`acceptEdits`/`plan`, codex's
  `read-only`/`agent`/`agent-full-access`, opencode's `build`/`plan`. This
  is the same improvement A9 noted for `session/request_permission`, and it
  is cross-runtime rather than per-vendor.
- **Reasoning effort is a dimension the system does not model at all.**
- **`session_info_update` carries a generated session `title`** (claude
  produced "Acknowledge instruction without tools" for the probe turn).
  Task threads have no title today; this is free if wanted.

None of these are in scope for this plan — recorded so they are not
rediscovered as surprises, and so nobody assumes the migration is purely a
cost.

### Original statement of the gate (kept for the reasoning)

Two facts are load-bearing enough that discovering them mid-implementation
would be expensive, and neither is settled by public documentation:

1. **Subscription billing must survive the adapter.** This whole topology
   exists to spend subscription quota rather than API credit (the reason
   C7 rejected OpenCode-first, and the reason ADR 0008 isolates credential
   channels). Claude Code bills against the subscription via its OAuth login
   state, but **silently switches to API-key billing whenever
   `ANTHROPIC_API_KEY` is present in the environment** — a documented way
   people have been surprised by real charges. Verify by hand: install
   `@agentclientprotocol/claude-agent-acp`, run one turn, and confirm on the
   usage page that it landed on the subscription. Repeat for `codex-acp`
   (lower risk — it uses `~/.codex`, configurable via `CODEX_HOME`).
2. **`sessionCapabilities`: `resume` or only `load`?** A7's design depends on
   which each adapter advertises at `initialize`. Check both.

**If (1) fails, the conclusion is not that ACP is wrong** — it is that the
migration narrows: codex moves to ACP (its `~/.codex` mechanism is the
cleaner of the two), claude stays on its native stream-json path, and A5's
P4 is dropped. Re-plan at that point rather than proceeding. *(It did not
fail; this branch is now moot and kept only to show the gate had teeth.)*

## 5. Acceptance gate (not a code phase; carried from phase 2, one criterion added)

Functional completion is not acceptance. Over 2 consecutive weeks:

> ≥2 real machines registered and online; the user's daily project work runs
> through the conversational thread surface; **both runtimes exercised in
> real work, with at least one real multi-turn thread each**; ≥5 real
> multi-turn threads per week (≥3 turns each) with live step progress
> visible; ≥3 diffs reviewed from within conversations; queue and Cancel each
> exercised on real work at least once; ≥1 failure diagnosed via the
> diagnostics drawer without opening a terminal on the host.

Only the "both runtimes" clause is new. The rest is unchanged deliberately:
the questions those numbers stand in for did not change because the tooling
got better, and relaxing them because the diagnostics improved would be
giving ourselves a pass we have no evidence for.

This gate is also the entry evidence
[unattended-execution-hardening-plan.md](unattended-execution-hardening-plan.md)
waits for, and it gates the next phase (Room supervision, IA redesign
scoping, mid-turn steering).

**Pre-condition carried from phase 2's P1 discovery review**, still unmet and
still relevant: before trusting the two-week window as representative,
confirm that assistant text actually arrives incrementally against real
daemon output rather than only in a final consolidated message. Under ACP
this becomes "confirm `agent_message_chunk` notifications arrive during a
turn, not just at its end" — the same risk, relocated.

## 6. Standing decisions inherited from phase 2 (still binding)

Carried verbatim in substance from the deleted plan, because they remain
live and their only other home was that document:

- **Room never relays per-turn messages** (phase 2 C1). The thread's direct
  connection to the vendor CLI session is the *only* per-turn conversational
  surface; no LLM intermediary ever relays a turn. Room returns later as a
  **dispatch/supervision entry** ("create a thread on my desktop for X",
  "summarize last night's threads"), never as a relay channel for the work
  conversation itself. `project-conversational-advancement-plan.md`'s Phase
  C/D resume condition and `capability-shrink-plan.md`'s suspension both hang
  off this plan's acceptance gate.
- **One workspace binds to exactly one Project** (phase 2 C9). One directory
  is one execution context at a time — the whole-workspace `git diff HEAD`
  and concurrent runs make sharing physically incoherent. Sharing a repo
  across Projects means a second checkout or `git worktree`, registered as
  its own workspace (manual; automation only if real use proves it painful).
  "Workspace as a first-class peer of Project" is recorded as a long-term
  observation only. Workspace registration stays daemon-CLI-side — real paths
  never reach the control plane (ADR 0016 B64).
- **Rejected, do not re-propose**: tmux-managed persistent processes
  (capture-pane is TUI screen-scraping, send-keys is fragile, and the session
  file rather than the process is the durable asset); OpenCode-first as the
  execution foundation (phase 2 C7, restated in A3); multi-project workspace
  binding (C9); character-level streaming, SSE, or any general browser
  real-time layer (C3 — segment/step-level latency via persisted events plus
  cursor polling is the accepted bar).
- **Mid-turn steering stays out of scope.** This plan builds the duplex
  *transport* because ACP needs it; it does **not** build tool-boundary queue
  injection or soft interrupt. Those remain next-phase work gated on the
  acceptance window.

## 7. Out of scope (recorded once, to kill re-litigation)

- Everything in §6's rejected list.
- The `terminal/*` client-side protocol, ACP `diff` content, and any second
  execution channel proxied back down the tunnel (A9).
- User-defined ACP agent entries (adapter specs as editable data rather than
  code). Adding an agent is already down to one `specs.ts` entry; making that
  entry user-supplied means users can make a host execute an arbitrary
  command, which is a different trust model deserving its own design rather
  than being done in passing. Trigger: wanting an agent we have not
  pre-registered.
- A2A. It is a genuinely separate axis — agent↔agent task delegation, network
  transport, its own identity model (v1.0 under Linux Foundation governance
  since April 2026, with Signed Agent Cards). It composes with ACP rather
  than competing, and would arrive either as agent-space exposing its own
  Agents outward or as a new `runtime_kind` alongside `local_cli`/`model_api`
  — neither touching this replatform. **One design constraint carried now
  because it is free now and expensive later**: keep our internal event
  vocabulary neutrally named (`assistant_text`, `tool_activity_started`)
  rather than renaming to ACP's own terms (`agent_message_chunk`,
  `tool_call`), so a future A2A source — whose task lifecycle
  (submitted → working → input-required → completed/failed/canceled) already
  maps closely onto `runs.status`, with `input-required` matching
  `waiting_for_review` — can normalize into the same table without a second
  migration.
- DeepSeek Harness. Unchanged from its 2026-08-22 evaluation: it is absent
  from the ACP registry, and its disqualifier (Claude/Codex run only as
  one-shot subagents with `inheritsParentContext: false` and no session
  resume) is a property of DSH, not of the protocol choice. Its
  re-evaluation trigger in deferred-register stands.
- Everything phase 1 and phase 2 already deferred — pit 3 (remote
  propose→apply governance), routing location axis, server-host daemon
  unification, cross-host thread migration, multi-user host sharing, host
  isolation raising, the C8 agent-FK shim replacement, the structured
  agent-space-information channel, and `executeRun`'s outer catch having no
  thread-event awareness. See
  [tasks/deferred-register.md](../tasks/deferred-register.md).

## 8. Testing strategy notes

Per [architecture/TESTING_STRATEGY.md](../architecture/TESTING_STRATEGY.md):
controller state-machine behavior gets focused unit tests per ACP method and
notification kind (including capability negotiation, replay suppression under
A7, and permission auto-approval); the daemon's duplex frame handling extends
the existing fake-daemon harness; event persistence, queue state, and dispatch
guards keep using the shared real-PostgreSQL fixture; frontend rendering of
the newly absorbed fields (tool kind, result content, plan snapshots) gets
component tests. No fake-DB coverage.

P1 is deliberately a no-behavior-change refactor so the *existing* suite is
the primary evidence its abstraction is correct.

## 9. Phase execution ledger — P3 closure continuation

This compact ledger records the closure gate for the uncommitted P3 delivery;
full review transcripts remain external supporting evidence, not plan source.

- State: `completed`.
- Phase base: `71c9aa98969eb961d8124630784ac831013fd88c` (P2 commit).
- Delivered scope: Codex ACP on server-host and remote paths; removal of the
  bespoke Codex app-server controller; ACP schema absorption (`tool_kind`, the
  four-state tool status including `in_progress`, bounded tool-result content,
  and appended `plan_updated` snapshots); capability-probe separation for the
  pinned `codex-acp` adapter versus the host's vendor `codex`; preserved vendor
  CLI login/quota probe paths; database artifacts, server routes, and
  conversation UI/tests.
- Explicit exclusions: Claude ACP migration (P4), legacy cleanup and current
  state documentation (P5), terminal/diff ACP surfaces, mid-turn steering,
  user-defined agent entries, and all §6/§7 non-goals.
- External-review consent: the user's explicit invocation of
  `$phase-gated-implementation` authorizes the selected P3 changes, relevant
  repository context, and verification evidence to be sent to the external
  Codex review service for this run. No push, PR, deployment, or destructive
  cleanup is authorized.
- Readiness evidence: server focused tests 107 passed / 34 PostgreSQL-backed
  host-dispatch tests skipped because Docker/Postgres is unavailable; web
  Command Center tests 28 passed; host-daemon tests 33 passed; server, web,
  and daemon typechecks passed; `git diff --check` passed.
- Closure ledger assembled for this continuation (the prior discovery
  transcript was not persisted in the repository):
  - `P3-CHECK-001` (major-risk surface): Codex ACP adapter resolution must be
    distinct from trusted-host vendor capability detection, while login and
    quota probes continue to invoke the vendor CLI. Disposition: repaired;
    closure must verify every entrypoint and direct caller.
  - `P3-CHECK-002` (major-risk surface): both server-host and remote Codex
    execution paths must use the general ACP controller with no surviving
    app-server bypass. Disposition: repaired; closure must verify lifecycle,
    resume, failure, cancellation, and usage behavior.
  - `P3-CHECK-003` (major-risk surface): ACP tool kind/status/result/plan data
    must survive normalization, persistence, API serialization, and UI
    rendering with bounded result content and append-only plan snapshots.
    Disposition: repaired; closure must verify schema and direct consumers.
  - `P3-CHECK-004` (correctness surface): generated migration artifacts and
    focused tests must agree with the new event columns and vocabulary.
    Disposition: repaired; closure must verify SQL and real-DB coverage where
    the shared fixture is available.
- Review invocation: `P3-CLOSURE-1`; role `closure`; state `completed`;
  remote session `01a02be9-3e5b-7280-8741-662ca7abba06`; successful reviewer
  session created in this continuation: 1. Result: all four listed P3 checks
  closed; no new actionable correctness or security finding; coverage complete
  across ACP paths, capability probing, lifecycle handling, schema/API/UI
  propagation, credential-sensitive vendor probes, migrations, and direct
  consumers. The first platform permission attempt created no session and is
  not counted. No complementary or extra closure review was needed.
- Final commit-gate verification: server focused closure suite 145 passed / 34
  PostgreSQL-backed host-dispatch tests skipped because Docker/Postgres is
  unavailable; web Command Center suite 28 passed; host-daemon suite 33
  passed; `git diff --check` passed. Server, web, and daemon typechecks had
  already passed after the final implementation/test changes. The worktree
  contains only the paths listed in this P3 delivery.
- Intended commit title: `feat(acp): migrate codex to ACP and absorb event schema`.

## 10. Phase execution ledger — P4 Claude ACP

- State: `completed`; the final closure review completed with two P1 findings;
  the final repair batch is complete and local phase-gate verification passed.
- Phase base: `af7b77fc00deae424fe543f1dbe8aa54b1db893a` (P3 commit).
- Delivered scope: Claude ACP adapter/runtime-tool wiring on server-host and
  remote paths; general ACP controller support for Claude lifecycle, model
  selection, permission handling, session resume, text/tool/plan events, and
  `usage_update` Claude rate-limit metadata; exact per-run token usage and
  selected-model attribution.
- Explicit exclusions: P5 legacy parser deletion and current-state docs,
  terminal/diff ACP surfaces, mid-turn steering, user-defined ACP agents, and
  all §6/§7 non-goals.
- External-review consent: continuation of the user's explicit
  `$phase-gated-implementation` invocation for this approved plan; the
  selected P4 changes, relevant repository context, and verification evidence
  may be sent to the external Codex review service. No push, PR, deployment,
  or destructive cleanup is authorized.
- Usage decision: ACP does not preserve Claude's historical per-model split for
  multi-model turns. P4 records exact total/per-turn usage and the selected
  ACP model when available; the split loss is accepted as the explicit
  plan-required decision, while live subscription quota is preserved from
  `usage_update._meta["_claude/rateLimit"]` (with the documented nested
  fallback accepted by the controller).
- Review invocation: `P4-DISCOVERY-1`; role `discovery`; state `completed`;
  external review session `01a02c11-1acd-7163-8cfe-db435ca0664d`. Findings:
  stale host-dispatch expectation and incomplete Claude ACP native optional
  dependency readiness. Repaired in one batch.
- Review invocation: `P4-CLOSURE-1`; role `closure`; state `completed`;
  external review session `01a02c1f-ddb8-7803-87fa-36ff8658f100`. Findings:
  failed remote resume retained a stale session id, the PostgreSQL room fixture
  modeled only the old vendor package, and one host-dispatch expectation was
  stale. Repaired in one batch.
- Review invocation: `P4-CLOSURE-2`; role `closure`; state `completed`;
  external review session `01a02c28-be44-7fc3-aab6-b945b44b6642`. Final
  findings: Claude ACP model canonicalization and over-broad remote resume
  invalidation. Repaired in the final batch without another review session
  because the phase's three-successful-session limit had been reached. The
  repair normalizes concrete Claude/provider models to advertised ACP family
  options, preserves the run model for attribution, and marks a session
  invalid only when the `session/resume` handshake itself is rejected.
- Final phase-gate verification: server P4 focused suite 98 passed / 34
  PostgreSQL-backed host-dispatch tests skipped because Docker/Postgres is
  unavailable; the broader repair suite 88 passed / 34 skipped; host-daemon
  suite 34 passed; server and daemon typechecks passed; `git diff --check`
  passed. The worktree contains only the paths listed in this P4 delivery.
- Intended commit title: `feat(acp): migrate claude to ACP`.
- Commit: `d0726009` (`feat(acp): migrate claude to ACP`).
- Readiness evidence: server P4-focused suite 95 passed / 34 PostgreSQL-backed
  host-dispatch tests skipped because Docker/Postgres is unavailable; the
  Claude/remote/runtime-tools subset added after the first pass is 63 passed;
  post-repair runtime-tools/host-dispatch check is 13 passed / 34 skipped;
  host-daemon suite 34 passed; server and host-daemon typechecks passed; `git
  diff --check` passed.
- Review invocation: `P4-DISCOVERY-1`; role `discovery`; the user's explicit
  authorization to transmit the P4 worktree and relevant repository context
  was received before retrying. The prior platform rejection created no review
  session and is not counted. The review returned two findings: the
  PostgreSQL-backed host-dispatch catalog assertion still expected Claude's
  retired vendor command (`claude` instead of `claude-agent-acp`), and runtime
  installation/readiness checked Claude Code's vendor native package but not
  the ACP SDK's platform-native optional package. Repair batch: update the
  catalog assertion and validate/install both Claude native packages, with
  focused regression coverage.
- Review session: `01a02c11-1acd-7163-8cfe-db435ca0664d`.
- Closure invocation: `P4-CLOSURE-1`; role `closure`; it covers the repaired
  P4 worktree and verifies that both discovery findings are closed without
  expanding into P5 legacy deletion.
- Closure result: `P4-CLOSURE-1` found three actionable items: failed remote
  ACP resume kept the stale session id and error classification; the
  PostgreSQL room fixture still modeled only the retired Claude vendor
  install; and the host catalog assertion was still stale in the worktree.
  Repair batch: clear the external id and classify `runtime_session_invalid`
  on failed remote resume, update the room fixture for the ACP adapter plus
  both native packages, update the catalog assertion, and add a regression
  test for stale-session clearing.
- Closure invocation: `P4-CLOSURE-2`; role `closure`; this is the third
  successful P4 review session including discovery and the first closure, and
  is the final review allowed for this phase.
- Intended commit title: `feat(acp): migrate claude to ACP`.

## 11. Phase execution ledger — P5 legacy deletion and closure

- State: `completed`.
- Scope: deleted the pre-ACP per-vendor stdout/structured-output parsers
  (`createVendorEventStream`, `parseVendorStructuredOutput`,
  `parseOpenCodeOutput`, `createVendorTextDeltaStream` in
  `vendorCliAdapter.ts`; every per-vendor function in
  `cliRuntimeMeasurement.ts` except `usageFromAcp`; the raw-stdout branch of
  `createThreadEventNormalizer` in `threadEventNormalization.ts`), the dead
  `argument_rendering_strategy === "argv_template"` disjunct from
  `hosts/routes.ts`'s two remote-eligibility checks, and their now-orphaned
  tests and fixtures. Updated `hosts.md` and ADR 0016 to describe the shipped
  ACP state.
- Re-verification finding (independent, before P5's own discovery review):
  re-running P4's own claimed-passing suite against real PostgreSQL (P4's own
  ledger records its final verification skipped 34 PostgreSQL-backed tests —
  no Docker/Postgres in that build environment) surfaced 4 failing tests in
  `hostDispatch.test.ts`: test-fixture-only bugs (stale claude raw
  stream-json simulation instead of ACP), not production defects — confirmed
  by tracing `resumeHandshakeFailed` classification, subscription-quota
  propagation, and tool_kind absorption were all already correct in
  production code. Fixed by building a reusable `claudeAcpSink()` ACP-shaped
  test-daemon helper and rewriting the 4 test bodies. Committed separately as
  `ad918f75` ahead of P5's own diff, since it was pre-existing test debt this
  re-verification uncovered, not new P5 work.
- Readiness evidence: server full suite 451 files / 3568 tests passed (real
  PostgreSQL); server, host-daemon, and web typechecks passed; `schema:check`
  passed; `git diff --check` passed; legacy-absence grep sweep for
  `CodexAppServerController` and the four named P5 functions confirmed
  genuinely gone.
- Commit: `1cf82747` (`refactor(runs,hosts): P5 legacy deletion for ACP
  runtime replatform`), followed by `cd20b5b8` (two stale `argv_template`
  comment/test-title fixes found in the same sweep, same day).

## 12. Final cross-phase integration gate

- State: `completed`.
- Range reviewed: `f06d411e..cd20b5b8` (the complete P1-P5 implementation,
  8 commits) for `INTEGRATION-DISCOVERY`; `f06d411e..cd20b5b8` plus the
  uncommitted repair diff as one effective range for `INTEGRATION-CLOSURE`.
- Broad verification before discovery: `schema:check` passed; server,
  host-daemon, and web typechecks all clean; server full suite 451/451 files,
  3568/3568 tests (real PostgreSQL); host-daemon suite 34/34; web suite
  668/669 (the one failure, `finance-page.test.tsx`, is an unrelated
  pre-existing beancount-plugin UI test untouched by any commit in range).
- Review invocation: `INTEGRATION-DISCOVERY`; role `discovery`; state
  `completed`. Found 3 minor findings, no blockers or majors: (1) the
  server-host resume path didn't clear a stale `external_session_id` on a
  failed ACP resume handshake, unlike the remote-host path's existing guard;
  (2) `runtimeEventNormalization.ts` retained ~60 lines of pre-ACP per-vendor
  stdout-shape heuristic parsing that had become unreachable dead code once
  every runtime moved to ACP; (3) `AcpController` forwards a requested model
  to codex_cli/opencode with no `supports_model_override` spec gate — flagged
  as a pre-existing, apparently untriggerable behavior predating the
  migration.
- Repair batch (uncommitted at closure time): fixed (1) and (2) directly;
  recorded (3) as an accepted defer in `deferred-register.md`, on the premise
  that no live path supplies a non-null model to a codex_cli run.
- Review invocation: `INTEGRATION-CLOSURE`; role `closure`; state
  `completed`. Verified (1) and (2) closed with no repair-induced regression.
  **Rejected the deferred disposition of (3)**, on the reasoning that a
  codex_cli Agent bound to a custom OpenAI-compatible Model Provider — a
  supported, UI-exposed, server-validated configuration (`AgentFormPage.tsx`,
  `agents/repository.ts`'s `validateModelSelection`,
  `runtimeProviderBinding.ts`'s `buildCodexProviderBinding`) — already
  produces a non-null `runtimeBinding.model`, which `vendorCliAdapter.ts`'s
  ACP-controller construction passed through unguarded, and that
  `codex_cli`'s spec declaring `supports_model_override: false` meant
  codex-acp might not expose a `model` config option via ACP at all.
- Second repair (post-closure, before commit): acting on that reasoning,
  nulled the model for `codex_cli` in the ACP controller construction and
  added a test asserting no `session/set_config_option` is sent for a
  provider-bound codex_cli run. Committed as `4eac1e42`.
- **`4eac1e42`'s model-suppression half was wrong and has been reverted
  (`3faf28fb`)** — caught by the user re-reading §4 of this same plan.
  `supports_model_override: false` in `specs.ts` gates only the retired argv
  `--model`-flag rendering path (`cliCommandRendering.ts`), which already
  no-ops for any `ndjson_rpc`/ACP-strategy adapter regardless of the model
  value — it says nothing about ACP's independent `session/set_config_option`
  mechanism. §4 of this very plan already recorded, from real hands-on
  verification against the actual `codex-acp` binary, that **codex does
  support model switching via ACP** ("Model switching works on all three —
  and codex gains it... already exercised by the existing opencode
  controller"). The closure review's escalation and the repair that followed
  both missed this and treated the argv-only flag as if it also gated ACP.
  Reverted to unconditional model forwarding for every ACP adapter; the test
  was corrected to assert the model *is* forwarded via
  `session/set_config_option`, not suppressed. Full server suite re-verified
  clean (451/451 files, 3568/3568 tests) after the revert.
- The resume-session-id-clearing repair (finding 1) and the dead-heuristic
  deletion (finding 2) from `4eac1e42` were correct and are unaffected by
  this correction.
- No third integration reviewer was spawned for any of this — the mistake
  was caught by the user, not a reviewer, and the correction was verified by
  hand (re-deriving the argv-vs-ACP distinction from `cliCommandRendering.ts`
  and this plan's own §4, plus two full clean suite runs). This is worth
  noting as a process gap: neither the discovery nor the closure reviewer
  cross-checked the finding against §4's own recorded verification evidence
  before accepting the "codex may not support ACP model config" premise.
- Commits: `4eac1e42` (`fix(acp): integration-gate repairs — codex ACP model
  gate, dead heuristic`), `3faf28fb` (`fix(acp): revert incorrect codex model
  suppression from the integration gate`).
- Cleanup follow-up (`1ab0b86b`), prompted by the user directly asking
  whether the old implementation, tests, and docs were fully cleaned up: a
  full-catalog re-sweep of `runtimeAdapters/specs.ts` and the `runs` module
  for `adapter_type === "codex_cli"` special-casing found two more argv-era
  leftovers neither review pass nor the earlier P5 sweep had caught —
  `applyReadOnlyVendorSandbox` (`cliCommandRendering.ts`, dead since P3: no
  spec entry has ever combined an argv `--sandbox` flag with codex_cli after
  it moved to codex-acp) and a redundant `codex_cli ? null : ...` special
  case in `vendorCliAdapter.ts`'s `renderCliCommand` call (harmless — the
  model-arg-rendering block it guarded already no-ops for any
  `ndjson_rpc`-strategy adapter regardless of the model value — but the same
  shape of reasoning that caused the `4eac1e42`/`3faf28fb` mistake, so
  removed to not leave the confusing precedent standing). Full server suite
  re-verified clean (451/451, 3568/3568) after.
- Comment cleanup (`7082464e`), per user feedback: removed
  deletion-history-flavored comments (explaining what old code used to do
  before it was deleted, which adds nothing once that code is actually gone)
  and a comment that pointed at this plan document by path — a plan document
  gets deleted once its work lands, so a source comment citing one by path
  goes stale. Comment-only; no behavior change.
- Effective final range: `f06d411e..7082464e`.
- Not closed by this gate: §5's acceptance gate (2 consecutive weeks of real
  usage) is a distinct, still-open product milestone — every phase's code is
  complete and integration-reviewed, but acceptance has not started.
