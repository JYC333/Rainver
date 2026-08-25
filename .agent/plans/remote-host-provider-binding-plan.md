# Remote Host Provider Binding

Date: 2026-08-24
Status: approved; in implementation. Extends the server-host provider-binding
machinery to remote-host runs so the control plane can decide, per host and
per adapter, which model backend an agent CLI actually runs against
(e.g. MiniMax via its Anthropic-compatible endpoint) — with a per-dispatch
override. Decisions below were settled in the 2026-08-24 design discussion;
the gap analysis was verified against the code the same day.

## Goal

A user can, from the web UI, bind "claude_code on host X runs behind
ModelProvider Y" (or pick a provider on a single dispatch), and the remote
run then executes against that provider through the server's provider proxy —
real API keys never leave the server process, exactly as on the server host.
A run with no binding behaves exactly as today (the machine's own ambient
login state).

## Current state (verified 2026-08-24)

The server-host half already exists end to end; none of it reaches the
remote path.

Exists:

- `model_providers` (Claude/OpenAI-compatible base URLs, default/available
  models, AES-GCM credential pool, space grants) — the API backend registry.
- Provider proxy leases (`server/src/modules/providers/proxy/lease.ts`,
  `proxy/server.ts`): short-lived lease token in the subprocess, real key
  resolved in-process and injected upstream, `anthropic` + `openai` ingress
  routes, usage attribution.
- Per-adapter materializers
  (`server/src/modules/runs/runtimeProviderBinding.ts`): claude via env,
  codex via run-scoped `CODEX_HOME/config.toml`, opencode via config file;
  env whitelist in `runs/cliSubprocessEnv.ts`.

Missing (all on the remote path):

- ADR 0016 D1 exempts remote runs from provider and credential resolution
  entirely: `runs/remoteHostCliAdapter.ts` passes `env: {}` to the executor
  interface, but `RemoteWsCliCommandExecutor` drops it — the wire `LaunchFrame`
  has **no env member at all**, so D4 must extend the frame schema rather than
  populate an existing field — and the daemon spawns with the full ambient
  `process.env` (`packages/host-daemon/src/execution.ts`). "What is behind
  the agent" on a remote host is whatever that machine happens to be logged
  in as — invisible to and unmanageable by the server.
- The proxy is unreachable from a remote host: ephemeral port
  (`listen(server, host, 0)`), plain HTTP, base URL built from the
  compose-internal `sandboxRunnerServerHost`.
- No binding model or dispatch field: `POST /api/v1/tasks/:taskId/runs`
  carries no provider/model selection at all.
- Profile isolation for a bound run is server-host-only for **all three**
  runtimes, not just the two with config files:
  `writeCodexProviderConfig` / `writeOpenCodeProviderConfig` write the
  **server's** filesystem, and claude_code has no binding-supplied profile at
  all — it relies on the credential broker's HOME, which does not exist
  remotely. So each runtime needs a profile directory on the executing host
  that nothing constructs today.

## Decisions

- **D1 — amend ADR 0016 in place** (per the standing amend-in-place rule):
  a remote run MAY carry an explicit ModelProvider binding, and when it does
  the server-managed injection below applies. Subscription login state
  remains host-owned ambient; managing remote login accounts is explicitly
  out of scope (deferred register).
- **D2 — direct transport, no tunnel, no TLS in this plan.** The proxy
  moves to a fixed, configurable port published by compose, with a
  deployment-configured external base URL handed to remote runs. Plaintext
  on the trusted LAN is accepted — the same assumption the daemon WS already
  makes today. The WS-tunnel alternative is rejected while a port can be
  exposed (streaming/backpressure over WS frames is real work for no
  benefit); TLS + prod ingress are deployment gates tracked in the deferred
  register, not feature work here.
- **D3 — binding model reuses `model_providers`, no new profile concept.**
  One new table maps `(host_id, adapter_type)` → default
  `model_provider_id`; the dispatch request gains optional
  `model_provider_id` / `model` overrides. Precedence: dispatch override >
  host×adapter default > none (ambient login). Validation at dispatch:
  enabled active-space grant + the base URL required by the adapter's
  protocol. The resolved provider is stamped on `runs.model_provider_id` as
  on the server host.
- **D4 — materialization moves host-side, for every runtime.** The launch
  frame gains a materialization instruction (protocol route, lease URL, lease
  token, model, provider name, available models) plus env entries, and the
  daemon writes what the binding needs on its own disk and removes it
  afterward. **All three runtimes need a host-side directory, including
  claude_code** — its server-host binding is env-only
  (`buildClaudeProviderBinding`) because the credential broker separately
  supplies the `HOME` (run-scoped for a one-shot run, conversation-scoped and
  persistent for a CLI conversation), and no broker exists remotely, so env
  entries alone would leave the machine's `~/.claude` and its settings file
  (which can itself export environment) in play. So: claude_code gets a
  control-plane provided profile directory (`HOME` / `CLAUDE_CONFIG_DIR`)
  carrying only binding material; Codex gets its run-scoped `CODEX_HOME`,
  which redirects both its config and its `auth.json` lookup so ambient `HOME`
  needs no redirect — a deliberate asymmetry, not an omission; OpenCode gets
  its config *plus* an isolated `HOME`, because its config goes to the sandbox
  cwd and the server-host path refuses to run without a separate isolated HOME. The existing server-side config-writing
  logic is extracted and shared with the daemon, not duplicated. Nothing about
  this copies vendor login state to the host — see B67 and ADR 0016's
  2026-08-24 amendment for that boundary.
- **D5 — mutual-exclusion invariant (B67).** For a bound remote run, backend
  selection comes only from what the control plane injects. Stated positively
  on purpose: a forbidden-prefix list is not the rule, because the machine
  selects a backend through more than vendor key variables. The daemon must
  therefore, when a binding is present, let injected values win over ambient
  and exclude the machine's own backend selection on both halves — environment
  (`ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` and cloud
  credential/region companions, and `HTTP_PROXY`-family egress variables that
  decide where the lease token actually travels) **and** ambient profile state
  (`HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`, including a
  runtime settings file that can itself export environment). **No binding
  satisfies this remotely by itself** — not the config-file ones (Codex,
  OpenCode) and not claude_code's env-only one, since on the server host each
  relies on the credential broker for profile isolation and no broker exists
  remotely; every bound run must also be pointed at a control-plane-provided
  profile directory (D4). A binding-less run keeps today's behavior
  bit-for-bit.
- **D6 — lease hardening, proportionate.** The lease records its target
  `host_id` (audit + revocation when a host is revoked); terminal-status
  lease revocation must demonstrably fire on the remote path
  (`cleanupRuntimeProviderBinding`). TTL semantics unchanged. Source-IP
  pinning is optional hardening, not a gate.

## Phases

**P0 — decision record.** Amend ADR 0016 D1 as above. No code.

**P1 — binding model + dispatch contract.**

- Drizzle schema + migration for the host×adapter default binding table.
- Dispatch routes accept and validate the override fields; resolution
  precedence implemented and stamped on the Run.
- Command Center: per host × adapter backend selector (providers with an
  active-space grant + "host login state" as the none option).
- Real-DB tests per TESTING_STRATEGY (binding resolution, validation
  failures, precedence).

**P2 — execution path.**

- Proxy fixed port + compose publish + configurable external base URL;
  server-host/sandbox callers keep the internal URL.
- Launch frame extension — the wire `LaunchFrame` has no env member today, so
  this adds env entries *and* the materialization instruction; daemon-side
  materialization for all three runtimes (claude_code included), cleanup, and
  the D5 merge rules.
- Lease `host_id` + remote-path revocation coverage.
- End-to-end verification on a real paired host: claude_code and one
  config-file runtime (codex or opencode) each complete a dispatched run
  against a bound provider with no machine-local login involved; a
  binding-less dispatch on the same host still runs on ambient login; usage
  attribution rows appear for the bound runs.
  **Verify first, it gates the design:** whether Claude Code actually starts
  from an empty config directory given only `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN`. Nothing in this repo answers it — `CLAUDE_CONFIG_DIR`
  appears in no code path and is absent from `cliSubprocessEnv.ts`'s
  `RUNTIME_ENV_KEYS`, and the server host has never run a login-less bound
  claude_code (`vendorCliAdapter.ts` fails any un-granted CLI run, so a bound
  claude run always has credentials materialized into HOME). If it needs login
  state present, D4's claude_code branch needs redesign, not adjustment.
- `hosts.md` / `CREDENTIAL_STORAGE.md` current-state updates land in the
  same change.

## Definition of done

1. From the web UI, a host×adapter default provider can be set and a single
   dispatch can override it; the effective choice is visible on the Run.
2. A remote run bound to a provider executes through the server proxy; the
   real key never appears in any launch frame, daemon log, or host disk.
3. D5 holds under test on **both** halves: a bound run's env contains no
   ambient backend vars, **and** its profile state points at the
   control-plane-provided directory rather than the machine's own (assert on
   `HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`, per
   runtime). An unbound run's env and profile state are unchanged from today.
4. Lease is revoked at run terminal state on the remote path, verified by
   test.
5. Architecture docs reflect the shipped state.

## Out of scope

- Remote subscription multi-account, login-state inventory, remote
  device-flow login — deferred register (multi-host section).
- TLS entry and prod `/internal` ingress — deferred register.
- Provider-proxy WS tunnel — deferred register.
- Protocol translation for providers without Anthropic/OpenAI-compatible
  endpoints — conditional row in `platform-reuse-cleanup.md` (Portkey
  Gateway sidecar / `@musistudio/llms`).
- Remote quota probing, funding-aware routing — existing deferred entries.

## Coordination

`platform-reuse-cleanup.md` P0 ("Credential / CLI multi-account") redesigns
the server-side login/credential backend abstraction. This plan touches only
the API-provider side of run binding; the new binding table is
provider-only. Do not extend it to login profiles — that shape belongs to
the reuse item's `CredentialBackend` / Run→Account design.

## Execution ledger

Run base: `45e38bbf`, branch `re`. Phase-gated implementation, 2026-08-24.

### P0 — decision record

- State: completed. 9 reviewers spent (3 by budget, the rest user-authorized
  under a standing instruction to repair until clean). The ninth closure
  reported no blocker and no major and declared the phase safe to commit; its
  four minors were repaired in the same batch, all of them documentation
  accuracy with no decision content.
- Base: `45e38bbf`
- Delivered: ADR 0016 §4 amended in place (explicit ModelProvider binding may
  extend to a remote host; login-state brokering explicitly stays out) with its
  amended-documents ledger extended; `BOUNDARIES.md` B62 qualified and **B67**
  added (a bound Run's backend selection comes only from control-plane
  injection, covering env and ambient profile state); ADR 0008 "local
  provider-proxy URL" → "provider-proxy URL" plus a 2026-08-24 amendment
  recording why locality was never the load-bearing property and what a lease
  token actually authorizes; ADR 0007 and `LOCAL_FIRST_COMPATIBILITY.md` §7
  corrected for the same claim.
- Excluded: no code, no schema, no route change.
- Reviews: `P0-DISCOVERY` (general-purpose) — 6 findings (3 major, 3 minor),
  all verified against code, all repaired, none rejected. Coverage complete.
  - REV-P0-001 (major) ADR 0008 amendment understated lease scope — model,
    path, request count and spend are unpinned; TTL up to ~65 min. Repaired
    with the accurate derivation.
  - REV-P0-002 (major) `LOCAL_FIRST_COMPATIBILITY.md` §7 still asserted the
    amended claim under an ADR-0016 marker. Amended in place.
  - REV-P0-003 (major) B67's prefix list missed alternate-backend selectors,
    proxy egress variables, and the ambient config/auth half. B67 and D5
    restated positively.
  - REV-P0-004 (minor) ADR 0016's amended-documents ledger not extended.
  - REV-P0-005 (minor) ADR 0007 carried the retired "local" wording.
  - REV-P0-006 (minor) two present-tense claims described unbuilt behavior.
- Reviews: `P0-CLOSURE-1` — REV-P0-001…006 confirmed closed; raised REV-P0-007
  (major) and REV-P0-008's precursor minor plus two nits. `P0-CLOSURE-2`
  (budget 3/3) — confirmed REV-P0-007 and the nits closed; raised REV-P0-008,
  009 (majors) and 010, 011 (minors). All verified against code and repaired.
  - REV-P0-007 (major, repair-induced) "loopback-reachable for a server-host
    run" was false: the proxy binds `0.0.0.0` and the URL handed to a run uses
    `SANDBOX_RUNNER_SERVER_HOST` (default `server`), so server-host lease
    traffic already crosses the deployment network in plaintext. Corrected in
    ADR 0007 and ADR 0008.
  - REV-P0-008 (major, repair-induced) the `CREDENTIAL_STORAGE.md` repair
    overshot the other way, claiming present-tense remote reachability that
    contradicts this plan's own gap analysis. Corrected to name D2 as the work
    that would create it.
  - REV-P0-009 (major, newly-exposed) `modules/runtime-adapters.md` claimed the
    proxy listens on a **loopback** port — false against
    `providers/proxy/server.ts`, and newly contradicted by the ADR 0008
    amendment. Corrected. (Its companion "not configurable" claim was
    **kept**, because it is true; this row originally called it false too and
    was itself corrected — see REV-P0-021. REV-P0-015 corrected the same
    falsehood in ADR 0016's ledger.)
  - REV-P0-010 (minor) the retired-wording sweep was incomplete (four further
    occurrences). Swept to zero and the ledger now records the verified set.
  - REV-P0-011 (minor) B67 claimed OpenCode leaves the ambient profile readable;
    on the server host such a run is refused without an isolated `HOME`.
- Reviews: `P0-CLOSURE-3` (user-authorized, 4th) — proxy-reachability set,
  ADR 0016's sweep ledger, and B67's environment half all confirmed accurate;
  1 major + 1 minor raised, both repair-induced, both verified and repaired.
  - REV-P0-012 (major, repair-induced) the REV-P0-011 repair asserted that only
    the OpenCode binding fails to travel. False: `writeCodexProviderConfig`
    also throws `codex_temp_home_required` without a broker HOME, and
    `materializeRunCodexHome` resolves under the broker's server-side
    `runtimeHomesRoot` — **both** config-file bindings are server-local, and a
    P2 implementer following the old wording would have forwarded a
    server-side `CODEX_HOME` path to a remote machine, landing the run on that
    machine's ambient profile. Restated to cover both.
  - REV-P0-013 (minor, repair-induced) a `0.0.0.0` bind does include loopback;
    the not-loopback property belongs to the URL handed to a run, not to the
    listener. Re-scoped in `modules/runtime-adapters.md`.
  - REV-P0-014 (major, repair-induced; found by the implementer while preparing
    the fifth review, not by a reviewer) the REV-P0-012 repair claimed both
    config-file bindings use the credential broker's temp HOME. OpenCode
    actually writes `opencode.json` into the sandbox working directory and
    fails with `opencode_sandbox_required`; only its `HOME` comes from the
    grant. Corrected before review.
- Reviews: `P0-CLOSURE-4` (user-authorized, 5th) — B67's rewritten bullet
  verified clause-by-clause as accurate, as were the proxy-listener sentence,
  the ADR 0008 lease-scope paragraph, the sweep ledger set, and all links.
  2 majors + 4 minors raised, all verified and repaired.
  - REV-P0-015 (major, repair-induced) ADR 0016's sweep ledger called
    `runtime-adapters.md`'s "non-configurable listener" claim false. It is
    **true** — `providers/proxy/server.ts` hard-codes `0.0.0.0` and port `0`
    and no `PROVIDER_PROXY`-style env or compose knob exists — and the repaired
    document itself keeps the claim, so the ledger contradicted both the code
    and its own repair, and would have sent a P2 implementer hunting for a
    configuration knob that does not exist. Only the loopback half was false.
  - REV-P0-016 (major, previously-missed) `LOCAL_FIRST_COMPATIBILITY.md` §7's
    new sentence asserted in the present tense that a bound remote Run *is*
    served by the proxy — the same defect class as REV-P0-008, one file over,
    in a document set whose rule is to describe current state. Qualified as P2
    work.
  - REV-P0-017 (minor) ADR 0016 §4's narrowing clause named only one of the two
    sentences it narrows; the enumeration listing "provider-proxy leases" is the
    one most directly reversed. Both now named.
  - REV-P0-018 (minor) B67 said "run-scoped temp HOME"; a CLI conversation gets
    a conversation-scoped persistent HOME (`prepareConversationHome`).
  - REV-P0-019 (minor) B67 covered only the two config-file runtimes; Claude
    Code — whose binding supplies no profile pointer at all — is now named.
  - REV-P0-020 (minor) "allowlist of forbidden variable names" was
    self-contradictory; now denylist.
- Reviews: `P0-CLOSURE-5` (user-authorized, 6th) — items 1, 3, 4's
  Codex/OpenCode halves, 5, the links, and the sweep re-verified clean.
  2 majors + 4 minors raised, all verified and repaired.
  - REV-P0-021 (major, repair-induced) the fifth batch corrected the "not
    configurable" falsehood in ADR 0016's ledger but left the identical claim
    standing in **this file's** REV-P0-009 row, so the plan contradicted
    itself on whether a proxy-port knob exists. Row corrected.
  - REV-P0-022 (major, repair-induced) the `LOCAL_FIRST_COMPATIBILITY.md`
    qualifier claimed "a remote Run carries no binding". False. Run creation
    does write NULL (`runs/repository.ts`, under a comment reserving the column
    to the router), but `PgRouteDecisionRepository.routeRun`
    (`routing/repository.ts`) then `UPDATE runs SET … model_provider_id` from
    the selected runtime-profile candidate at run start — before
    `resolveExecutionPort` resolves host kind — with no host-kind guard, and it
    persists a second copy as `route_decisions.selected_model_provider_id`.
    `orchestrationService.ts`'s credential-approval check is gated on
    `hostKind === "server"` explicitly "rather than relying only on
    `run.model_provider_id` staying unset". So a remote Run **can already
    record a provider it never used** — B67's own "recorded
    `model_provider_id` is a lie" failure exists on the remote path today.
    The reachable set is specific but not narrow: `routeRun` skips only
    `run_type` `system`/`validation`, so **any** routed, Folder-bound run whose
    Folder's active preferred Location is remote gets stamped and then executes
    remotely. The Task dispatch route is the one path that cannot reach it — it
    diverts a remote target into `prepareRemoteTaskRun`, whose runs are
    `run_type: "system"`. Everything else can: Automations (`agent`), Room root
    runs (`agent`), Plan and Workflow node children (`workflow`), evolution
    runs (`evolution`) — none validates host kind at creation. Note the
    Location rule is `preferred = true AND status = 'active'`, not "the only
    Location", so a Folder holding both a server and a remote Location is
    equally affected whenever the remote one is preferred.
    **Consequences for P1:** binding resolution must distinguish a provider
    that arrived through the new binding table from a routed runtime-profile
    value, must not treat non-null `model_provider_id` on a remote Run as
    evidence of a binding, and must decide what `route_decisions`'
    own copy means for a remote run.
  - REV-P0-023 (minor) B67 attributed the `codex_temp_home_required` throw to
    `materializeRunCodexHome`; it is in `writeCodexProviderConfig`.
  - REV-P0-024 (minor) B67 called Claude Code "the one with nothing to port"
    when it is the runtime needing the most remote profile work — its only
    isolation source is the credential grant, which does not exist remotely.
  - REV-P0-025 (minor) ADR 0016's "only the provider-proxy lease path extends"
    read as excluding D4's host-side provider-config materialization. Scoped
    to the brokered login-state HOME.
  - REV-P0-026 (minor) ledger hygiene: round attribution for REV-P0-010/011,
    a stale "the repair batch is unreviewed" line, and this round's own row.
- Reviews: `P0-CLOSURE-6` (7th) — B67's Codex and Claude Code sentences,
  including "nothing constructs today", the OpenCode half, the enforcement
  paragraph, the proxy claims, the sweep and all links re-verified clean.
  1 major + 4 minors raised, all verified and repaired.
  - REV-P0-027 (major, repair-induced) REV-P0-022's own row said
    `model_provider_id` is "stamped at creation"; creation writes NULL and
    reserves the column to the router. The stamp is `routeRun`'s UPDATE at run
    start, which also persists `route_decisions.selected_model_provider_id`.
    Row corrected, and the reachability path narrowed to Automation-created
    runs (dispatch diverts remote targets to `run_type: "system"`, which
    `routeRun` skips).
  - REV-P0-028 (minor) "the launch frame carries `env: {}`" — the wire
    `LaunchFrame` has no env member; `RemoteWsCliCommandExecutor` drops the
    adapter's `env` before serializing. Corrected here and in the plan's own
    gap analysis, which had propagated the same wording; D4 must extend the
    frame schema, not populate a field.
  - REV-P0-029 (minor) Standing Note arithmetic and its "two opposite pairs"
    claim were both wrong.
  - REV-P0-030 (minor) the REV-P0-009 row cross-referenced REV-P0-015; the
    finding that corrected *it* is REV-P0-021.
  - REV-P0-031 (minor) ADR 0016's carve-out permitted only a run-scoped
    *provider config* on the executing host, while B67 requires a profile
    directory even for Claude Code, whose binding produces no provider config.
    Rescoped to what the directory is for rather than whether one exists.
- Reviews: `P0-CLOSURE-7` (8th) — every clause of the rewritten REV-P0-022
  row's mechanism half, the launch-frame claims, the ADR 0016 carve-out's
  consistency with D4/D5/B67/the deferred register, the ledger's row-to-round
  arithmetic and cross-references, the sweep and links: all re-verified clean.
  2 majors + 2 minors raised, all verified and repaired.
  - REV-P0-032 (major, repair-induced) **D4 contradicted B67 and the ADR.**
    B67 (batch 6) and ADR 0016 (batch 7) were both widened to require a
    control-plane-provided profile directory for Claude Code, and the ADR
    names D4 as where that work lives — but D4 still read "either env entries
    (claude_code) or a materialization instruction", i.e. nothing host-side
    for claude_code. An implementer following D4 literally would ship exactly
    the failure B67 exists to prevent: ambient `~/.claude` and its
    env-exporting settings file surviving alongside the injected backend. D4
    and the P2 bullet now require a host-side directory for all three
    runtimes. This is the Standing Note's shape #2 — the twin left standing.
  - REV-P0-033 (major, repair-induced) REV-P0-022's reachability sentence
    named Automations as the reachable path. The real set is any routed,
    Folder-bound run whose Folder's **active preferred** Location is remote —
    Room root runs, Plan/Workflow node children and evolution runs included,
    since `routeRun` skips only `system`/`validation`. Also "only (therefore
    preferred) Location" was wrong: the rule is `preferred = true AND
    status = 'active'`, so a Folder with both a server and a remote Location
    is affected whenever the remote one is preferred. Sizing this as
    "Automations only, rare" would have let P1 defer provenance handling.
  - REV-P0-034 (minor) Standing Note count was eight; the roster gives nine
    (rounds 5 and 6 contributed two each), and its scope phrase excluded the
    run/route-model errors.
  - REV-P0-035 (minor) DoD #3 asserted only D5's env half, so REV-P0-032's
    defect would have shipped green. Now asserts profile state per runtime.
- Reviews: `P0-CLOSURE-8` (9th) — **no blocker, no major.** REV-P0-022's
  reachability paragraph verified clause-by-clause including each named
  `run_type` reaching the remote CLI branch unblocked; D5's per-runtime
  broker-reliance claim, DoD #3's assertability, the ledger's rows and
  cross-references, the sweep and links all clean. 4 minors, all repaired.
  - REV-P0-036 (minor, repair-induced) D4's new rationale said the broker
    supplies a "run-private" HOME — re-regressing REV-P0-018, which had
    already corrected B67's twin of that phrase to cover the persistent
    conversation HOME. Shape #2 again, one round later.
  - REV-P0-037 (minor) the Current-state gap list still named only the two
    config-file writers after D4 widened to three runtimes.
  - REV-P0-038 (minor) Standing Note arithmetic wrong a third time — it
    applied REV-P0-034's count without counting the round that raised it.
  - REV-P0-039 (minor) D4 gave Codex only `CODEX_HOME` while D5 excludes
    ambient `HOME` for every bound run; the asymmetry is correct
    (`CODEX_HOME` redirects config and `auth.json` both) but was unstated.
  - Also recorded from this round, not a finding: whether Claude Code runs
    from an empty config directory on binding env alone is **unverifiable from
    this repo** and is now a gating P2 experiment (see the E2E bullet).

**Standing note for P2.** Eleven factual errors were found in this phase's own
new prose across eight review rounds — at least one per round, two in each of
rounds five, six and eight — plus one caught by self-check between rounds. They
were
about the provider proxy, the CLI provider bindings, and the run/route data
model. Every one was a
normative sentence written from a partial reading of the mechanism; none was
caught by the docs test, because none is a structural defect. Two shapes recur.
One is asserting the *opposite* error while correcting the first (the proxy
called too-local, then too-reachable). The other is correcting a claim in one
place and leaving its twin standing elsewhere — the "non-configurable listener"
claim was fixed in ADR 0016's ledger while the identical sentence survived in
this plan's own, and each of the last three rounds found the previous round's
correction wrong. Two habits for P2: read the specific code path before writing
any sentence asserting how the proxy, a lease, or a binding behaves; and after
correcting such a sentence, grep for its twin before believing the area is
clean.

### P1 — binding model + dispatch contract

- State: completed
- Base: `0fb35c14`
- Delivered: `host_runtime_provider_bindings` table and migration `0003`;
  `host_thread_messages` gains the resolved binding snapshot; dispatch-time
  resolution and validation with three distinct request shapes (absent key /
  explicit null / model-only); binding carried onto the Run by the queue;
  three owner-gated binding endpoints; per host×adapter Command Center
  selector; `adapterProviderRequirement` extracted as the single source of
  truth for what a provider must expose to serve an adapter; 22 real-DB tests.
- Excluded: no execution-path change — a bound remote run still executes on
  ambient login. No per-dispatch override in the web UI yet (DoD 1's second
  half; the API accepts it).
- Reviews: `P1-DISCOVERY` — 5 majors + 9 minors, all verified and repaired
  except one accepted.
  - REV-P1-001 (major) the Run read model asserted `used_by_adapter: true` for
    a bound remote run that executes on ambient login — B67's "recorded
    provider is a lie" at the surface a person actually reads.
  - REV-P1-002 (major) the new write endpoints had no authorization coverage.
  - REV-P1-003 (major) the Space-grant test asserted a fake's own branch; it
    now runs the real providers read port and real grant rows.
  - REV-P1-004 (major) the provider FK's `ON DELETE CASCADE` rationale was
    false — product removal is a *soft* delete, so a stale binding survives
    and fails dispatch. Kept the FK, corrected the reasoning, named the cause
    in the error, and made the stale binding visible in the UI.
  - REV-P1-005 (major) "stamped on the Run" — the phase's own contract bullet
    — had no test.
  - Minors: article bug in an error message; `model_override_json` written
    without `source`; a model-only override silently discarded; a malformed
    provider id silently resolving to ambient login; a no-op re-select raising
    a 404 toast; `providersApi.list()` fetched once per host card; a comment
    claiming validation parity it did not have; `route_decisions`' own copy
    left undecided.
  - Accepted, not repaired: `assertProviderUsable` takes a second pool
    connection inside the dispatch transaction. Bounded — it only runs when a
    binding or override is present, and the pool's connect timeout turns
    starvation into an error rather than a hang.
- Reviews: `P1-CLOSURE-1` — 13 of 14 confirmed closed; 2 majors + 2 minors
  raised, all repaired.
  - REV-P1-015 (major, repair-induced) the read-model fix was keyed on
    `trust_mode`, which only the thread-dispatch path writes. An Automation,
    Room, Workflow or evolution run on a remote-preferred Folder has it null,
    is stamped by the router, executes remotely, and still read as
    adapter-used.
  - REV-P1-016 (major, repair-induced) `hosts.md` contradicted itself — the
    pre-repair sentence was left standing under the paragraph replacing it.
  - Minors: a false claim that the providers port cannot report credential
    presence; the server-host dispatch branch silently dropping an override.
- Reviews: `P1-CLOSURE-2` — 2 majors + 3 minors, all repaired.
  - REV-P1-017 (major, repair-induced) the previous repair fixed **one** of
    nine `runToOut` call sites and the new prose claimed the rest "cannot
    resolve a Location" — they can. Replaced with `resolveRunRemoteness`,
    which answers a whole page in one query and skips rows with nothing
    recorded to qualify; all nine call sites now pass the answer.
  - REV-P1-018 (minor, repair-induced) the server-host 422 covered
    `model_provider_id` and dropped `model`, the other half of the same pair.
  - REV-P1-019 (minor) the per-run remoteness query was an N+1 on list
    endpoints; the batch resolver removes it for the Agent-run and task-run
    lists. `GET /api/v1/runs` still resolves per run through
    `runToOutWithProvider` — batching that one is left undone.
  - REV-P1-020 (minor) this plan's own Status line still said "not started".
  - REV-P1-021 (minor) the new test hard-coded `executes_remotely` instead of
    threading the resolver's answer.

### P2 — execution path

- State: implemented and reviewed; **acceptance incomplete** — five items
  remain open (below). Four need a paired machine and a real provider account;
  one is UI work this phase did not do.
  Reviews: discovery (1 blocker, 2 more blockers/majors on config divergence,
  9 minors), then three closure rounds. Each round found the previous round's
  correction wrong; the two that mattered most are recorded above.
- Base: `6ab8d4cc`
- Delivered: `PROVIDER_PROXY_PORT` / `PROVIDER_PROXY_EXTERNAL_BASE_URL` with a
  second, remote-facing lease URL and a loopback-bound published port in prod
  Compose; a **runtime-agnostic** `provider_binding` on the launch frame
  (`{env, profile_env, files}`) whose contents the server generates with the
  same builders the server-host path uses, so the daemon writes bytes rather
  than knowing any runtime's config shape; daemon-side profile materialization,
  path-escape refusal, B67's ambient-environment **allowlist**, cleanup on exit
  and a sweep of profiles left by killed runs; server-side binding resolved
  from the message with a Host × adapter fallback for runs that never went
  through dispatch; the executed backend written back onto the Run so its
  recorded provider is what ran rather than what the router predicted; lease
  bound to the Host, revoked on every terminal path, and revoked with the Host.

**Verification lesson, recorded because it invalidated earlier evidence.** Every
phase of this plan reported "server tsc clean" from `tsc --noEmit -p
tsconfig.json`. That is the *build* project and it excludes `test/`. The
canonical command is `pnpm run typecheck` (`.agent/COMMANDS.md`), which uses
`tsconfig.typecheck.json` and does include tests — and it was failing: a
duplicate import this phase added, a `ServerConfig` fixture this phase's two new
fields broke, and three `unknown`-typed expressions that P1 committed. Passing
suites hid all of it, because vitest's esbuild transform does not typecheck.

**Integration gate.** Two integration reviews over the committed range, then
two verification rounds over their repairs. What they caught that no
single-phase review could: P2's Host-default fallback silently widened P1's
Space-scoped binding, turning remote runs in a Space without that grant from
"ran on ambient login" into hard failures; the execution preflight was deciding
egress and grant checks from the router's *prediction* rather than the backend
that would run; and the first correction of that predicate was applied in one
place and not the other, so a `model_api` run on a remote-preferred Folder had
its provider denied by the read model while using it.

The recurring failure was never the code — it was the **evidence**. Three
separate rounds accepted a repair as covered when reverting it left the suite
green. Every behavioral fix in the final two commits was mutation-checked
before being claimed, and that is the practice to carry forward: for a change
whose whole point is that something no longer happens, assert it by breaking it.

**Self-audit after the repair rounds (2026-08-25).** Asked whether the fixes
were patches or proper work, checked with grep rather than memory. The
architectural decisions held: the server-host config builders are genuinely
shared with the remote path (D4's requirement), `adapterProviderRequirement` is
the single source for what a provider must expose, binding resolution and
recording became one port rather than two switches, and the proxy address is
computed server-side so the UI cannot derive a second, disagreeing answer.

What the repair rounds *did* leave was duplication, all of it created by
correcting one call site at a time:

- **"is this run dispatched to a daemon" existed three times** — the dispatch
  itself, the execution preflight, and the read model. That is not incidental:
  two of them disagreeing is precisely the major the integration review found,
  and correcting one copy is what created it. Now one `dispatchesToHostDaemon`.
- **The lease URL's path shape existed four times** across three files, two of
  them added by this work. A wire format spread across four expressions is one
  edit from disagreeing. Now one `providerProxyLeaseUrl`.
- **`remoteProviderBinding.ts` had grown to 434 lines with four concerns**,
  the last of which (proxy address resolution) was added to an already-large
  file against this repo's own guidance. Split out.
- **`recordRemoteRunBackend` took an optional `spaceId` that could not filter**
  — added to satisfy a convention while doing nothing, since `id` is the
  primary key. Now required and real.

The pattern worth naming: **a fix applied at one call site is not a fix, it is
a new copy.** Every one of these started as a correct repair to a real defect.

**Standing note for the next phase.** The discovery review found a **blocker**
that every one of the 41 daemon tests missed: the daemon rebuilt the launch
frame field by field and dropped `provider_binding`, so the whole feature was
inert while the tests passed and the docs asserted it worked. The lesson is not
"write more tests" — it is that a wire contract needs a test at each **end** and
at the **mapping**, because a field that is silently dropped fails no assertion
anywhere else. Two of that review's other majors traced to the same root cause:
reimplementing the runtime config writers on the daemon rather than sharing the
server's, which D4 had already forbidden in writing.

The second closure round then found a **blocker of my own making** in the fix
for the first round's findings: `recordRemoteRunBackend` replaced
`model_override_json` wholesale, and that column is the run's control blob —
`execution_mode`, `chat_turn`, `conversation_runtime` — not a model record. A
Room turn on a remote-preferred Folder would have lost its reply silently, with
both recovery sweeps blind to it because they filter on the key that was
destroyed. The shape to carry forward: **a column named for one thing may carry
several**, and a write-back should merge unless it owns the whole document.

**Open acceptance, carried out of this phase.** Items 1-3 and 5 need a paired
machine and a real provider account, so none could be run here; item 4 is UI
work this phase did not do:

1. Whether Claude Code starts from an empty config directory given only
   `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`. Recorded as gating when D4
   was written and still unanswered — the daemon materializes exactly that
   shape, so if Claude Code needs login state present, D4's claude_code branch
   needs redesign, not adjustment.
2. The end-to-end run itself: claude_code and one config-file runtime each
   completing a dispatched run against a bound provider with no machine-local
   login involved, a binding-less dispatch on the same host still using
   ambient login, and usage attribution rows appearing for the bound runs.
3. Whether OpenCode's `OPENCODE_CONFIG` wins over a project-level
   `opencode.json` in the run's working directory. The server-host path merges
   the binding *into* that project file; the remote path cannot, because the
   daemon must never write to the user's checkout, so it points
   `OPENCODE_CONFIG` at the profile instead. If a workspace's own config layers
   over it, a bound OpenCode run falls back to ambient credentials — a B67 hole
   that only a real host can reveal.

4. **A per-dispatch backend override in the web UI.** The API accepts
   `model_provider_id` / `model` on both dispatch routes and the resolution
   honors all three request shapes, but the Command Center only sets the
   Host × adapter default. Until this lands, "pick a provider on a single
   dispatch" — the second half of DoD 1 — is reachable by API only. Recorded
   here so retiring this plan does not retire the remainder with it.

5. **Whether the remote ACP controller should carry the binding's model.**
   `createCliConversationController` receives `RunExecutionInput.model`, not
   the binding's resolved model; the binding reaches the runtime by its own
   channel instead (`ANTHROPIC_MODEL`, or the config file). Nothing threads a
   model into a remote run today, so the two cannot diverge yet — but if a
   caller ever does, ACP's `session/set_config_option` would name a model the
   bound provider may not serve, against an endpoint that looks correctly
   configured. Like the OpenCode precedence question, only a real host reveals
   which behavior is right.

**A gap this phase accepted, recorded rather than hidden.** A bound remote
run's model traffic is governed by the Space's `externalEgressEnabled` switch
(the `local_cli` egress branch) but **not** by per-provider egress policy:
`runtimeProviderEgressDestination` never runs for it, because the provider is
resolved after the execution-control snapshot is written. The snapshot
therefore records `destination_type: "local_cli"` for a run whose traffic went
to a named ModelProvider through the server proxy. The alternative was
recording the router's *prediction*, which is wrong in a worse way. Closing it
means either writing the snapshot after binding resolution or amending it
afterwards; neither is P2-sized.

**A stated limitation, not a defect.** A bound run's environment is an
allowlist, and its `HOME` is a control-plane profile. `SSH_AUTH_SOCK` is
admitted because it selects no backend, but `~/.gitconfig` and `~/.ssh` are
not visible, so an agent that commits or pushes inside the workspace can
succeed unbound and fail bound. Widening this means naming exactly which
machine state a bound run may see, which is a B67 decision rather than a
convenience.

## Retirement

Retire this file when both phases land and the architecture docs record the
shipped state; deferred rows stay in their registers.
