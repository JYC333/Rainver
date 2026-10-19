# Platform Reuse Cleanup

Date: 2026-08-24. Re-checked against the code on 2026-10-10.
Status: active checklist. Consolidates the build-vs-reuse audit so replacement
decisions stop scattering across discussions. Completed replacements are NOT
recorded here — git history and `.agent/architecture/` hold them. Remove a row
once it lands.

The split is the reuse policy's: Rainver keeps domain semantics, authority,
governance, policy, the data model, and product behaviour. Generic engines
(parsers, queues, retry, archives, HTML extraction, decimal math, observability)
are what a mature implementation should own.

Trigger-gated rows stay in this file rather than `../tasks/deferred-register.md`
so the reuse audit stays in one place.

## Withdrawn on the 2026-10-10 re-check

These rows described code that is not there, or a replacement that would take
over behaviour Rainver already owns. They are not work items.

- **Finance decimal.** `plugins/official/financeLedger.ts` does not exist. The
  ledger already does exact decimal arithmetic with an integer coefficient and
  a scale in `plugins/official/finance_ledger/server/src/domain/decimal.ts`.
  There is no float path to replace, and `decimal.js` is not needed.
- **Eval harness.** `server/src/modules/evolution/evaluationHarnessService.ts`
  exists. Promotion treats `verification_engine.v1` as the pass/fail authority.
  Promptfoo does not become that authority.

## Replacement items

| Item | Current | Target | Priority | Trigger | Status |
| --- | --- | --- | --- | --- | --- |
| Credential / CLI multi-account | One ambient CLI login per host. Login and usage probes: `packages/host-daemon/src/login.ts`, `usageProbe.ts`. Server: `providers/managedOAuth.ts`, `subscriptionOAuth.ts`, `subscriptionQuota.ts`. No `CredentialBackend`, and a Run does not bind an account | Official CLI login owns the OAuth handshake. Rainver owns profile, Run→account binding, routing, and audit. MIT references: CC Switch, clauth, codex-auth | P0 | A host needs more than one login per runtime. One ambient login is enough for current use; see the deferred register | Not started |
| HTML → article extraction | Structured reader pipeline in `sources/contentParsing.ts`: chrome pruning, then a ProseMirror document (`extraction_method="structured_html_v1"`, remote image references). `stripHtml` is only the plain-text fallback | `@mozilla/readability` plus a DOM parser and a sanitizer choose the article. Rainver still stores the reader document, highlights, Source, and AI analysis. Scheduling this accepts that the chosen article can differ; the reader schema stays | P1 | When a change to article selection is explicitly in scope | Not started |
| Custom Source isolation | Server-side child process plus API monkey-patch (`sources/customSources/customSourceRunner.ts`). The server fetches HTML and the handler has no network. The file states this is not OS isolation | The host bubblewrap namespace (`packages/host-daemon/src/strictNamespace.ts`) is a Run mount: cwd, home, and an explicit bind list. That contract does not match this server-side handler. A later isolation change needs its own mount and deployment contract; it is not a drop-in | P1 | A mount contract for the server-side handler is designed | Not started |
| Backup mechanics | `tar.gz` plus `pg_dump` custom format, count-based retention, and `restore.sh` (`backups/service.ts`; `architecture/OPERATIONS_AND_SAFETY.md`) | restic owns archive, snapshot, storage, and retention. Rainver keeps backup policy, manifest, the decision to restore, and audit | P1/P2 | An operator-contract migration is scheduled. The archive format is the engine; policy and restore stay here | Not started |
| Local retry/backoff | No pile of identical local backoff helpers. `sourceConnectionFetch.ts` leaves 429 to the coordinator. `runs/supervisor.ts` chooses same-route retry, fallback, human review, or budget. Handler and recipe loops retry a version-number conflict. Backup's loop is a file lock. `toolDownload.ts` retries a resumable download with a deadline and a checksum | `p-retry` only for a true local, non-durable call, with the same attempts, delay, and retry predicate. Durable and product retry stay with the job engine and the owning policy | P1/P2 | Opportunistic — when such a call is being edited | Not started |
| Job queue | Postgres queue: claim, heartbeat, reclaim, and attempts in `jobs/repository.ts`. Scheduler loops in `scheduler/registry.ts`. Domain code that mutates Run/Task still sits beside the queue | pg-boss for the queue engine after that domain code has moved out. Run/Task behaviour stays | P1/P2 | Before unattended execution scales up. Not a prerequisite for current Project testing; swapping it immediately before acceptance testing would mix product failures with migration failures | Not started |
| Non-interactive subprocess | `spawn` across server and host-daemon. Many sites are long-lived or interactive (login, PTY, agent execution, usage probe, custom-source runner). Env filtering is per spawn kind (`filterAmbientEnv` and the related helpers) | `execa` for a short non-interactive command, with env, stdio, and failure behaviour set explicitly. PTY/TUI stays `node-pty`. Not a sweep | P1/P2 | Opportunistic — when such a command is being edited | Not started |
| Throttle | No second copy of a generic throttle. Existing limits are separate rules: arXiv spacing, host pairing, source quota, login rate | `p-throttle` only if a real duplicate appears | P2 | A duplicate generic throttle shows up | Not started |
| REST contract / typed client | Protocol DTOs are already zod. System-action schemas can emit JSON Schema. HTTP route validation is still hand-written, and there is no generated web client. Client duplication was not measured | Generate a typed client from the existing contracts for web and any future CLI/SDK. Generating schemas must not tighten or loosen route validation | P2 | A measured client/server drift, and a generation path that preserves current validation | Not started |
| Spaced repetition | `learning/service.ts`: a correct review schedules +1 day; the mastery streak schedules +7 days | `ts-fsrs` owns the interval. Learning objects, Project binding, and mastery state stay in Rainver. Due dates will change when this lands | P2 | Learning has real usage | Not started |
| Beancount text compat | The ledger is DB-native. Beancount text is already import/export only, parsed by `plugins/official/finance_ledger/server/src/beancount/importer.ts` | A mature parser (`tree-sitter-beancount` or equivalent) replaces that importer when its fidelity is short. The ledger model stays | P2 | Import/export fidelity demands it | Not started |
| Operational telemetry | No dedicated operational telemetry | OpenTelemetry for process and request metrics only. It never replaces the Run/Event/Usage ledger | P2 | Multi-instance or control-center operations need it | Not started |
| Source crawling engine | Scheduled fetch, retry, and the recipe interpreter. No Playwright or crawler engine. Custom sources refuse browser automation | Crawlee when a source needs browser rendering or a large crawl. SourceRecipe, consent, provenance, and policy stay in Rainver | Conditional | A source genuinely requires browser rendering or a large-scale crawl | Not started |
| Declarative authorization | Hard invariants, Proposal, and policy code | Cedar as a POC beside those invariants, not in place of them | Conditional | Declarative rule volume actually grows | Not started |
| Durable workflow engine | Run/Job/Workflow through `automations/workflowExecutionService.ts` | Restate for the engine only if timer, signal, human-pause, or saga complexity outgrows this spine. Run semantics stay | Conditional | That complexity shows up | Not started |
| External agent interop | None | A2A or the official MCP SDK | Deferred | External interop demand exists | Not started |
| Frontend event wire | Persisted Run events | AG-UI as a POC only. It never replaces persisted events | Deferred | — | Not started |
| Live plugin composition | ADR 0006 PluginHost | Cordis-style runtime composition | Deferred | No trigger observed | Not started |
| LLM protocol translation | Chat invocation is `@earendil-works/pi-ai`. The provider proxy (`providers/proxy/server.ts`) is an Anthropic/OpenAI pass-through | Portkey Gateway or embedded `@musistudio/llms` only downstream of that proxy, after streaming and tool-call fidelity is checked. Not while every required provider speaks one of those two protocols | Conditional | A required provider lacks an Anthropic/OpenAI-compatible endpoint | Not started |

## Reference implementations (not dependencies)

Complete products reviewed and rejected as substrates. No full agent platform
becomes an internal base; only protocols, SDKs, and thin daemons enter the
dependency tree.

- **IM.codes** (`github.com/im4codes/imcodes`, MIT; reviewed 2026-08-24).
  Messaging/control layer for terminal coding agents. Same relay topology as
  Control Plane ← `rainver-host`. Worth borrowing when the need arrives, not now:
  - **Agent-to-agent send semantics** — target resolution, reply, and broadcast
    with circuit breakers. Reference for Room `@agent` routing if
    agent-initiated cross-agent messaging is added.
  - **Localhost preview tunnel** — the daemon proxies a local dev server
    through the existing WebSocket. No trigger yet.

## Do not replace

- **Retrieval orchestration** — ACL, visibility, provenance, and evidence.
  Postgres FTS and pgvector sit underneath (`retrieval/`).
- **Runtime/model routing** — capability, host, sandbox, trust, credential,
  cost, and verification. No generic router fits.
- **Verification authority** — external lint and test are callable. What counts
  as passing belongs to Rainver, including `verification_engine.v1`.
- **Finance accounting core** — DB-native ledger and its exact decimal type.
  Beancount is a design source and a compat format only.
- **Action/Tool authority** — `SystemActionGateway` owns semantics, grants,
  Policy, Proposal, and Audit. Third parties supply transport or runtime only.

## Ordering

1. **Credential / multi-account** is a product capability, not a cleanup. It
   waits until a host actually needs more than one login per runtime.
2. **HTML extraction and Custom Source isolation** are engine swaps with a
   precondition: article selection is allowed to change, and the handler has a
   mount contract. Neither is a drop-in.
3. **Project testing stays on the current job queue.** pg-boss comes after the
   queue/domain split, and before unattended execution scales up.
4. **restic, Crawlee, and the other P2 / conditional rows** follow their triggers.
   `p-retry` and `execa` are adopted at the call site that is already being
   edited, not as a repository sweep.
