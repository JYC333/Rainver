# Platform Reuse Cleanup

Date: 2026-08-24
Status: active checklist. Consolidates the build-vs-reuse audit (verified
against code on 2026-08-24) so replacement decisions stop scattering across
discussions. Completed replacements are NOT recorded here — git history and
`.agent/architecture/` hold them. Remove a row once it lands.

Trigger-gated rows are deliberately kept in this file rather than
`../tasks/deferred-register.md` so the whole reuse audit stays in one place.

Rows marked **unverified** carry a current-state claim that has not been
checked against the code; verify before scheduling.

## Replacement items

| Item | Current | Target | Priority | Trigger | Status |
| --- | --- | --- | --- | --- | --- |
| Credential / CLI multi-account | Self-built login engine + usage probes (`server/src/modules/providers/cli/loginEngine.ts`, `usageProbe.ts`) | Official CLI login owns OAuth; Rainver owns a `CredentialBackend` abstraction, Profile, Run→Account binding, routing, audit. MIT references: CC Switch, clauth, codex-auth | P0 | None — next up after gateway consolidation | Not started |
| Multipart upload parsing | Hand-written `parseMultipartUpload` (`activity/routes.ts`, single site) | `@fastify/multipart` | P1 | None — low-risk commodity cleanup | Not started |
| HTML → article extraction | Self-built `stripHtml` / `htmlToReaderPmDoc` (`sources/contentParsing.ts`) | `@mozilla/readability` + DOM parser + sanitizer; Rainver keeps reading objects, highlights, Source, AI analysis | P1 | None | Not started |
| Custom Source pseudo-sandbox | Child-process monkey-patch runner (`sources/customSources/customSourceRunner.ts`; its own header admits it is not OS-sandboxed) | Reuse the existing namespace-based `sandboxRunner` (NOT Bubblewrap — none exists in this repo) | P1 | None | Not started |
| Backup mechanics | Self-built tar.gz + pg_dump + retention (`backups/service.ts`) | restic owns archive/snapshot/storage/retention; Rainver keeps backup policy, manifest, restore flow, audit | P1/P2 | None | Not started |
| Local retry/backoff | ~10+ independent implementations (`sources/sourceConnectionFetch.ts`, `runs/supervisor.ts`, `retrieval/embeddingStore.ts`, …) | `p-retry` for non-durable local calls only; durable retry stays with the job engine | P1/P2 | Opportunistic — adopt when touching a call site | Not started |
| Job queue | Self-built Postgres queue (claim/heartbeat/reclaim/attempts in `jobs/repository.ts`, scheduler loops in `scheduler/registry.ts`) | pg-boss | P1/P2 | Before unattended execution scales up (Project Steward). Precondition: extract domain logic that mutates Run/Task from queue internals. **Explicitly NOT a prerequisite for first real-usage Project testing** — automation's `agent_run` enqueue rides the current queue, which already has the needed semantics | Not started |
| Non-interactive subprocess | Raw `spawn` call sites across server + host-daemon | `execa` for non-interactive commands; PTY/TUI stays `node-pty` | P1/P2 | Opportunistic | Not started |
| Throttle | Ad-hoc where present | `p-throttle` | P2 | Only when real duplicate implementations show up | Not started |
| REST contract / typed client | Hand-written route DTOs + frontend API client (**unverified**: client size/duplication not audited) | Zod/Fastify schema → OpenAPI → generated typed client shared by web, future CLI, SDK | P2 | Not a Project blocker | Needs verification |
| AuthN plumbing | Hand-written Google OAuth + session cookies (`auth/oauth.ts`) | Better Auth for identity/session/OAuth plumbing only; Space, membership, visibility, Policy stay in Rainver | P2 | When auth surface grows (more providers, MFA, org SSO) | Not started |
| Spaced repetition | Naive `+1 day` interval scheduling (`learning/service.ts`) | `ts-fsrs`; learning objects, Project binding, mastery stay in Rainver | P2 | When Learning gets real usage | Not started |
| Finance decimal arithmetic | **unverified**: actual float/decimal pain point in `plugins/official/financeLedger.ts` not confirmed | `decimal.js` for math primitives only | P2 | Verify pain point first | Needs verification |
| Beancount text compat | DB-native ledger already treats Beancount text as import/export format only (matches target posture) | `tree-sitter-beancount` or mature parser as the compat adapter, if/when import parsing grows | P2 | Import/export fidelity demands it | Not started |
| Eval harness | **unverified**: evolution module is asset/promotion machinery; no self-built evaluator harness located | Promptfoo as sandbox evaluator engine; Evolution Case, promotion authority, result normalization stay in Rainver | Conditional | Evolution evaluation work actually starts | Needs verification |
| Operational telemetry | None dedicated | OpenTelemetry for operational telemetry only; never a substitute for the Run/Event/Usage durable ledger | P2 | Multi-instance / control-center operations need it | Not started |
| Source crawling engine | Scheduled fetch + retry + recipe interpreter (`sources/`); **no Playwright or crawler engine exists** — earlier claims of one were wrong | Crawlee, if browser-rendered crawling becomes a need; SourceRecipe, consent, provenance, policy stay in Rainver | Conditional | A source genuinely requires browser rendering / large-scale crawl | Not started |
| Declarative authorization | Hard invariants + Proposal + policy code | Cedar POC | Conditional | Declarative rule volume actually grows | Not started |
| Durable workflow engine | Run/Job/Workflow via `automations/workflowExecutionService.ts` graph scheduler | Restate | Conditional | Only if timer/signal/human-pause/saga complexity outgrows the current spine | Not started |
| External agent interop | None | A2A / official MCP SDK | Deferred | External interop demand exists | Not started |
| Frontend event wire | Persisted Run events | AG-UI (POC only; never replaces persisted events) | Deferred | — | Not started |
| Live plugin composition | ADR 0009 PluginHost | Cordis-style runtime composition | Deferred | No trigger observed | Not started |
| LLM protocol translation | None needed — every target provider exposes an Anthropic/OpenAI-compatible endpoint; the provider proxy is pass-through by design | Portkey Gateway sidecar (TS, MIT, stateless data plane — caller supplies keys per request, fitting the server-holds-keys model; note the pending Palo Alto acquisition) downstream of the provider proxy, or embedded `@musistudio/llms`; verify streaming/tool-call fidelity on the Anthropic-ingress→non-Anthropic path before adopting | Conditional | A required provider lacks an Anthropic/OpenAI-compatible endpoint | Not started |

## Reference implementations (not dependencies)

Complete products reviewed and rejected as substrates (per the boundary: no
full agent platform becomes an internal base; only protocols/SDKs/thin daemons
enter the dependency tree). Kept here as design references for specific
mechanisms.

- **IM.codes** (`github.com/im4codes/imcodes`, MIT; reviewed 2026-08-24).
  Messaging/control layer for terminal coding agents: Browser/Mobile → WS →
  self-hosted Server (relay) ← outbound WS ← Daemon → tmux/ConPTY or SDK
  transports. Same relay topology as Control Plane ← `rainver-host`; no
  ACP-style runtime protocol layer (per-vendor SDK transports). Worth
  borrowing when the need arrives, not now:
  - **Agent-to-agent send semantics** — target resolution by label/session
    name/agent type, `--reply`, broadcast, with circuit breakers (depth
    limit, rate limit, broadcast cap). Reference for Room `@agent` routing if
    agent-initiated cross-agent messaging is ever added.
  - **Localhost preview tunnel** — daemon proxies local dev servers through
    the existing WS connection (HTML rewrite + runtime URL patch, HMR
    works). Candidate far-future `rainver-host` capability for viewing
    agent-produced results from mobile. No trigger yet.

## Do not replace (guardrails)

- **Retrieval orchestration** — ACL, visibility, provenance, evidence are the
  hard part; Postgres FTS + pgvector already underneath (`retrieval/`).
- **Runtime/model routing** — capability, host, sandbox, trust, credential,
  cost, verification; no generic router fits.
- **Verification authority** — external lint/test are callable, but "what
  counts as passing" belongs to Rainver.
- **Finance accounting core** — DB-native ledger; Beancount is a design source
  and compat format only (already implemented this way).
- **Action/Tool authority** — `SystemActionGateway` owns semantics, grants,
  Policy, Proposal, Audit; third parties only ever supply transport/runtime.

## Ordering

1. **Credential/Profile multi-account (P0).** The only reuse item that
   materially improves real-usage Project testing (multi-account Codex/Claude
   + hosts). Nothing else in this file blocks that testing.
2. **Commodity cleanups** — multipart, readability, custom-source sandbox.
   Small, independent; interleave freely.
3. **Project real-usage testing runs on the current job queue.** pg-boss comes
   after the queue/domain boundary cleanup and before unattended execution
   scales up — swapping queue infra immediately before first acceptance
   testing would make every failure ambiguous (product bug vs migration bug).
   Let real usage surface actual queue pain first.
4. **restic, Crawlee, and the P2/conditional rows** follow their triggers.
