# Sources Custom Source Handlers

Status: implemented through Phase 8 backend create-flow/proposal integration,
frontend create/detail/settings surfaces, first scan-job integration, and
Level 2 Source Recipe Phase 8 source-detail/compatibility/test flow
(2026-07-01). The schema, read models, runner, deterministic handler
generation, fixture tests, inside-envelope activation, handler-run history,
manual/scheduled scan queueing, trusted endpoint fetch path, Custom Source
proposal payloads/appliers, Source Recipe plan/create/dry-run/activate
services, Source Recipe proposal applier, recipe scan worker,
`source_runs` read model, and declarative-pipeline bridge exist. Sources
exposes Custom Source draft creation, a recipe-first `/sources` Create Source
card, and `/sources/connections/:connectionId` Source Detail product tabs
(Overview, Plan, Preview, Items, Evidence, Runs) with handler internals under
Advanced.
Repair/rollback and credentialed source support are implemented backend-side
(see "Repair" and "Credentialed Sources" below). Browser/Python handlers are
not implemented. Source Detail has no Repair tab and no credential-management
UI — those routes exist as API/service only
([unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §11).

`typescript_node` remains the generated-code Level 3 fallback. Existing
`declarative_pipeline_v1` handler versions remain readable/executable for
compatibility and can be explicitly bridged into Level 2
`source_recipe_versions`. See "Declarative pipeline model" below for the
Level 1/2/3 split: new configurable source creation now goes through
Level 2 Source Recipes first, while generated/template handler expansion stays
frozen as the Level 3 advanced fallback.

## Level 3 Freeze (2026-07-01)

Generated/template handler work (`typescript_node`) is **frozen** as the
Level 3 advanced fallback:

- No new handler languages (no Python, no browser automation, no shell
  execution, no dependency installation, no free-form generated code).
- Backend bug fixes and safety fixes remain allowed; existing Level 3 tests
  stay.
- Handler generation is not the main Custom Source customization path.
  User-facing creation copy presents it as advanced; the Level 2 recipe path
  (conversation-first Source creation) is the main path.
- Broader generated-code execution is not supported.

Unimplemented runner expansions:
[unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §11.

## Boundary

Custom Source belongs to Sources. It extends `SourceConnection` with generated,
source-specific handler versions and handler runs. It does not create a general
plugin marketplace, a capability marketplace, a runtime adapter catalog, or a
Knowledge source creation flow.

The feature uses the Sources/Evidence stack:

- `SourceConnection` for configured source ownership, consent, policy, and
  active handler reference.
- `ExtractionJob` for queued/audited work.
- `SourceItem` for raw candidate material.
- `SourceSnapshot` for immutable captures backed by artifacts.
- `ExtractedEvidence` for candidate citable evidence.
- `EvidenceLink` for relevance/context eligibility.
- `ProjectSourceBinding` and `ProjectSourceItemLink` for project routing and
  collection materialization.

Knowledge `Source` remains curated wiki evidence. A Custom Source handler must
not create Knowledge `Source` rows directly. Promotion from Sources evidence to
curated wiki evidence remains explicit and proposal-gated.

Projects do not own raw source material. Project relevance is represented through
bindings and evidence links. Project pages may consume and link to Sources, but
must not introduce a second source creation path.

## Handler Contract

A handler is untrusted source-specific code generated for one source
connection. The server owns the contract.

The handler may read:

- `input.json`
- read-only fixture files supplied for test runs

The handler may write:

- `output.json`
- files under the sandbox `files/` directory
- stdout/stderr, captured by the runner and redacted before persistence

The handler must not directly write:

- database rows;
- Memory;
- Knowledge;
- Wiki;
- Tasks;
- Project state;
- policy;
- credentials;
- source repository files;
- files outside `output.json` and sandbox `files/`.

All handler output is untrusted until the server validates it. Only the server
materializer may turn validated output into Sources rows and artifacts.

## Policy Envelope

Every generated handler version has a policy envelope. The envelope includes:

- allowed network origins;
- capture and retention bounds;
- credential requirement and scope;
- handler language;
- browser automation flag;
- shell flag;
- dependency installation flag;
- timeout, download, output, file, item, evidence, and log limits;
- log retention and redaction policy.

Activation rules:

- If a new handler version stays inside the approved envelope and Space policy
  allows automatic activation, it may be activated without proposal.
- If the new version broadens permissions or requires sensitive capability,
  activation creates a `custom_source_*` proposal, marks the tested version
  `pending_approval`, and binds `source_handler_versions.proposal_id` to that
  proposal. Accepting the proposal applies through the Custom Source applier.
- Credentialed sources: a source references a pre-created Custom Source
  credential by `credential_id`, never a raw secret. First activation
  auto-activates only when Space policy explicitly allows credentialed
  sources; otherwise (or on a credential change for an already-active
  connection) activation creates a `custom_source_credentialed_source`
  proposal. See "Credentialed Sources" below.
- Browser automation, shell execution, and dynamic dependency installation are
  disabled by default.
- Instance hard limits override Space policy.

## Settings Ownership

Space Settings owns product policy:

- creator roles;
- default Custom Source policy;
- allowed domains;
- per-space download cap;
- capture defaults;
- credentialed source policy;
- same-envelope repair auto-apply policy.

Instance Settings owns runner and sandbox safety:

- runner availability;
- allowed handler languages;
- network hard denies;
- time, output, file, and log limits;
- browser automation availability;
- shell availability;
- dependency installation availability.

The implemented settings API keeps that ownership split explicit:

- `GET /api/v1/sources/custom-source-settings/space` returns only the space
  product policy.
- `PUT /api/v1/sources/custom-source-settings/space` updates only the space
  product policy. It requires an active owner/admin membership and records the
  `source.custom.settings_update` policy action with resource type
  `custom_source_settings`.
- `GET /api/v1/sources/custom-source-settings/instance` returns only the
  instance runner/sandbox read model and requires instance-admin authority.
- `PUT /api/v1/sources/custom-source-settings/instance` lets an instance admin
  update runner availability. Absent a row, runner availability defaults to on.
- Instance hard sandbox limits remain server safety config and read-only in the
  web app; Space Settings never exposes those hard-limit controls. The download
  byte cap is the exception because it is a space boundary and is stored in the
  space policy as `download_bytes_max`.

## Runner Expectations

The first implementation should prefer TypeScript/Node handlers. Python may be
evaluated later, but it increases dependency and environment risk.

The runner must execute generated code in a separate process with a temporary
sandbox, minimal environment, controlled network, no repository write access, no
ambient credentials, and strict resource limits. Existing worktree sandboxing is
not enough for generated Custom Source code, and `one_shot_docker` must not be
treated as active isolation until it is implemented.

If runner support is disabled or unavailable, Custom Source execution fails
closed.

### Phase 4 implementation status

`server/src/modules/sources/customSources/customSourceRunner.ts` implements: separate
OS-process execution (`node:child_process.spawn`, `shell: false`), a
per-run temp sandbox directory with an `input.json` and a `files/`
directory, a minimal explicit environment (no `process.env` inheritance),
effective resource limits computed as `min(policy envelope, instance hard
limit)` (instance always wins), a wall-clock timeout enforced with
`SIGKILL`, a captured-log byte cap (UTF-8-safe — an incomplete trailing
multi-byte sequence at the cut point is trimmed rather than decoded into a
replacement character that could exceed the cap), secret-pattern log
redaction, filesystem path guards on common `fs`/`fs/promises` read and
write APIs, and an output.json size/path check (`lstat`/`realpath` before
`readFile`, never loading an oversized or symlinked file into memory)
before the contract validator ever sees it. Fail-closed checks run before
any process is spawned: instance
runner disabled, handler language not in the instance allowlist, or the
policy envelope requesting browser automation, shell, or dependency
installation (unconditionally refused, regardless of instance availability
flags).

Before loading the untrusted handler module, a generated per-run bootstrap
script monkey-patches `node:net`/`node:tls`/`node:http`/`node:https`/
`node:dgram`, `fetch`, `child_process`, `worker_threads.Worker`, and
common `fs`/`fs.promises` entrypoints to throw unless the operation stays
inside the declared handler contract (`input.json`, `output.json`, the
handler entrypoint, and sandbox `files/`). **This is defense-in-depth, not
OS-level network, process, or filesystem isolation** — a native addon, a
raw syscall, process internals, or an unpatched file API could still reach
outside the sandbox at the OS permission level. The same runner is used by
fixture tests and live scan jobs and does not grant network access to the
handler process. Trusted server code fetches `source_connections.endpoint_url`,
enforces the handler policy envelope's allowed origins before each
request/redirect, and passes the fetched HTML through
`input.json.source.config.fetched_html`. Do not describe this runner as
OS-sandboxed until a real process/network/filesystem isolation layer exists —
this mirrors the same honesty requirement already applied to `one_shot_docker`
(B13).

The contract validator (`customSourceContractValidator.ts`) rejects a
snapshot `file_path` that is a symlink (`lstat`, not `stat`) and separately
verifies via `realpath` that the fully resolved path — including any
symlinked intermediate directory under `files/` — stays inside the
sandbox `files/` root, before the materializer ever reads or copies it.

### Phase 5 implementation status

`server/src/modules/sources/customSources/customSourceCreateFlowService.ts` implements the
backend draft -> generate-handler -> test-handler -> activate flow. Handler
generation is deterministic/template-based, not LLM-driven. Fixture testing
uses the same runner/validator path as scans and records `source_handler_runs`
outcomes.

Inside-envelope activation sets the handler version `active`, supersedes the
previous active version, updates `source_connections.active_handler_version_id`,
and activates the connection. Policy-delta activation creates a pending
`custom_source_policy_delta` or `custom_source_credentialed_source` proposal,
includes the envelope deltas in the proposal payload, and keeps the tested
version in `pending_approval` until the proposal is accepted or rejected.
Accepting activates the version; rejecting releases it back to `draft`.

`customSourceScanSchedule.ts` enqueues generated Custom Source connections into
paired `extraction_jobs` and `source_handler_runs` rows, excludes built-in
connections, deduplicates queued/running handler runs, and reclaims stale
`running` runs so a crashed process cannot block a connection forever.

`customSourceScanWorker.ts` conditionally claims queued runs, marks paired
extraction jobs running/terminal, records blocked/timeout/nonzero-exit/fetch
failures, advances the `source_connection_scan` scheduler task even on failure
to avoid tight retry loops, and materializes validated output through
`CustomSourceMaterializationService`.

Manual `POST /api/v1/sources/connections/:connectionId/scan` also creates the
paired handler run for `generated_custom` connections rather than routing them
through the built-in extraction worker.

## Declarative Pipeline Model

A compatibility handler execution model, `language: "declarative_pipeline_v1"`,
can still exist beside `typescript_node` rows for advanced/history cases. It was added because the
`typescript_node` template generator's real customization surface is a single
CSS class name (list vs. single-page mode); it cannot paginate, follow a list
item's own link, download a non-HTML asset, or capture per-item snapshots in
list mode. New recipe-like sources are represented by
Level 2 `source_recipe_versions`. Any `declarative_pipeline_v1` handler
versions created through advanced/admin paths remain readable Custom Source
rows. The explicit bridge (`SourceRecipePipelineBridgeService`,
`POST /api/v1/sources/custom-sources/:connectionId/bridge-pipeline`) validates
`manifest_json.pipeline`, wraps it as `source.recipe.v1`, creates a new paused
recipe source, and writes a draft `source_recipe_versions` row. It does not
mutate the old generated-custom connection or auto-activate the recipe; the
normal recipe dry-run/activate path still applies.

Unlike `typescript_node` (generated code executed in a sandboxed child
process because the code cannot be fully trusted), a `declarative_pipeline_v1`
handler version has no generated/untrusted code at all — its
`manifest_json.pipeline` is a JSON step list interpreted in-process by a
fixed, reviewed step catalog (`server/src/modules/sources/customSources/customSourcePipelineInterpreter.ts`).
There is nothing to sandbox; every live network request still goes through
the same origin-allowlist + redirect-revalidation guard
(`fetchAllowedOriginResponse` in `customSourceEndpointFetch.ts`) the
`typescript_node` mode's trusted pre-fetch already used. `browser_automation_enabled`,
`shell_enabled`, and `dependency_installation_enabled` are structurally
impossible for this model (a step interpreter has no shell or dynamic-code
surface), not merely disabled by policy.

Step catalog (`packages/protocol/src/sourceCustomSourceHandlers.ts`,
`CustomSourcePipelineStepSchema`):

- `fetch_page` — fetch one URL into a named `html` variable. `url:
  "$source.endpoint_url"` is a sentinel meaning "use the already-fetched /
  fixture-overridable primary endpoint HTML" (`handlerInput.source.config.fetched_html`,
  the same value the `typescript_node` handler already reads) rather than a
  live fetch; any other literal URL is a live fetch subject to the policy
  envelope's `allowed_network_origins`.
- `extract_list` — split an `html` variable into repeated items by one CSS
  class name, into a named `items` variable (same heuristic as the
  `typescript_node` template's `splitBlocksByClass`, ported to real
  TypeScript in `customSourceHtmlExtract.ts` since there is no child process
  to serialize the logic into).
- `extract_single` — one item from a whole `html` variable.
- `follow_link` — for up to `max_follow` items in an `items` variable, fetch
  each item's own `source_uri`, overwrite its `title`/`excerpt` from the
  detail page, and store a `raw_html` snapshot (bounded by the version's
  `max_files` limit).
- `download_asset` — for each item in an `items` variable, fetch its
  `source_uri` and store the response bytes as a `download` snapshot,
  subject to an optional `mime_allowlist` and the `max_download_bytes` limit
  (rejected outright rather than truncated, since truncating binary content
  corrupts it).
- `paginate` — re-run a nested `steps` list (typically `fetch_page` +
  `extract_list`) against successive pages, merging each page's
  `page_items_var`-bound `items` into `bind`, up to `max_pages` and the
  version's `max_items` limit. `next_page.mode` is `query_param` (increments
  a numeric query parameter) or `link_rel_next` (follows a `rel="next"`
  anchor/link tag in the current page). Must not nest another `paginate` —
  rejected by `CustomSourcePipelineDefinitionSchema` at generation time, not
  merely documented.

Resource bounds: wall-clock `timeout_ms` is checked before every step and
enforced per-request via `AbortSignal.timeout`; `max_files` bounds the total
number of stored snapshots across `follow_link` and `download_asset`
combined; each individual fetch is capped at `max_download_bytes` (no
separate cumulative-bytes-across-fetches limit exists yet — the practical
worst case is bounded by `max_files * max_download_bytes`). Exceeding
`max_output_bytes` on the final serialized output produces
`output_too_large: true` with `raw_output_json: null`, exactly like the
`typescript_node` runner.

`mode: "test"` (fixture testing) is deliberately not fully live: only a
`fetch_page` step targeting the primary-endpoint sentinel ever resolves to
real content (the pre-fetched/fixture HTML). `follow_link`, `download_asset`,
`paginate`, and any `fetch_page` with a literal URL are no-ops that record a
diagnostic warning instead of performing a live fetch — a fixture test must
stay offline and side-effect free, matching the expectation the
`typescript_node` mode's fully network-blocked handler process already
satisfies. This means a fixture test cannot exercise what a multi-fetch
pipeline actually does beyond page 1; only a live scan run does.

Generation: `POST /api/v1/sources/custom-sources/:connectionId/generate-handler`
accepts `generation_mode: "code_template" | "pipeline"` (default
`"code_template"`, preserving existing behavior). `generation_mode: "pipeline"`
requires a `pipeline` body field validated against
`CustomSourcePipelineDefinitionSchema`; there is no template/LLM step here —
the caller supplies the full pipeline definition. `entrypoint` is set to the
constant `"pipeline"` (the column is `NOT NULL` but there is no source file to
point at) and `handler_artifact_id` is `null`.

Execution dispatch: `customSourceHandlerExecution.ts`'s
`executeCustomSourceHandler` is the single branch point shared by
`testHandler` and the scan worker's `runOne` — `typescript_node` resolves the
stored source artifact and runs `CustomSourceRunner`; `declarative_pipeline_v1`
parses `manifest_json.pipeline` and runs `runCustomSourcePipeline`. Both
return the same `CustomSourceRunnerResult` shape, so the Phase 3 contract
validator and materializer are unchanged and shared by both models.

Schema: `source_handler_versions.language`'s `CHECK` constraint in
`server/migrations/0000_baseline.sql` allows both `typescript_node` and
`declarative_pipeline_v1`. Instance Settings' `allowed_languages`
(`SERVER_CUSTOM_SOURCE_ALLOWED_LANGUAGES`) defaults to both values.

## Level 2 Source Recipes

Status: implemented through Phase 8 (`server/src/modules/sources/sourceRecipes/`,
`server/src/modules/sources/sourceRecipeRoutes.ts`, the `/sources` Create Source
card, Source Detail normal/Advanced split, and compatibility bridge).

Source Recipes are the normal configurable source path. They do not execute
generated code. A recipe version stores structured JSON over a fixed primitive
catalog, a shared source policy envelope, dry-run/test output, proposal
binding, and lifecycle status in `source_recipe_versions`. Recipe sources use
`source_connections.handler_kind = 'recipe'` and
`source_connections.active_recipe_version_id`.

Implemented flow:

- `planSource` performs deterministic source planning for RSS, Atom, web-list,
  and web-page inputs and returns a fixed recipe shape with sample preview.
- `createSource` creates a paused `recipe` source connection plus a draft
  recipe version.
- `dryRunSourceRecipe` runs the recipe in bounded preview mode and records
  sample output and step traces without materializing Sources rows.
- `activateRecipe` activates a dry-run-tested version directly when the policy
  envelope stays inside bounds; envelope broadening creates a
  `source_recipe_activation` proposal and binds the version until review.
- `recipeScanWorker` handles manual/scheduled scans for active recipe sources
  and materializes validated output through the shared Sources
  materializer.
- `listSourceRuns` projects product run history from extraction jobs, handler
  runs, and recipe dry-run results so the UI does not expose raw worker tables
  by default.
- `SourceRecipePipelineBridgeService` explicitly bridges existing
  `declarative_pipeline_v1` handler versions into draft recipe sources.

The frontend `/sources` Create Source card wires plan, create, dry-run, and
activate into one flow with URL/name/frequency/capture inputs, plan/sample
preview, and activation/proposal feedback. Source Detail now exposes Overview,
Plan, Preview, Items, Evidence, Runs, and Advanced; raw handler versions/runs,
policy envelopes, recipe JSON, and extraction jobs are kept in Advanced.

## Repair

Status: implemented (`server/src/modules/sources/customSources/customSourceRepairService.ts`,
`POST /api/v1/sources/custom-sources/:connectionId/repair` and `.../rollback`).
Works identically for both handler execution models — repair calls
`CustomSourceCreateFlowService.generateHandler`/`testHandler` internally, so
it produces a `typescript_node` or `declarative_pipeline_v1` version
depending on what the active version already is.

Repair creates a new handler version. It does not mutate the active version in
place, and it never touches a connection that has no active handler version
(422/409 — repair recovers a *running* source, it does not create one).

Regeneration input is the active version's own `manifest_json` (its
`list_selector`, or its `pipeline` definition) merged with any explicit
overrides in the repair request body (`list_selector`, `pipeline`,
`capture_policy`, `retention_policy`, `fixture_html`) — a repair call with no
overrides at all still re-fetches/re-tests live content, which is a
meaningful repair attempt on its own for drift that is about site content
rather than handler configuration.

While a repair attempt is in flight, `source_connections.repair_status` is
`repair_pending`; any failure past that point (generation, the fixture test
itself throwing rather than just failing, envelope evaluation, activation, or
proposal creation) reverts it to `repair_required` rather than leaving it
stuck `repair_pending` forever. A repair call rejects outright (409) if the
connection is already `repair_pending`, so two repair attempts cannot race on
the same connection through the API (this is an application-level guard, not
a row lock — a true concurrent double-call at the database level is not
separately interlocked).

Repair auto-activates only when:

- the fixture test on the regenerated version succeeds;
- `evaluateCustomSourceActivation` reports no envelope delta versus the
  active version (`withinEnvelope: true`);
- Space policy's `same_envelope_repair_auto_apply` is `true`.

Otherwise a proposal is created before activation:

- envelope unchanged but Space policy requires review →
  `custom_source_repair_activation` (see "Phase 6 Proposal Payloads" above);
- envelope broadened (new/changed network origins, credential request,
  browader capture/retention, larger limits, language change, disabled log
  redaction) → the same `custom_source_policy_delta`/
  `custom_source_credentialed_source` routing a fresh activation uses.

`repair_status` also transitions automatically
(`customSourceScanWorker.ts`'s `updateRepairStatusAfterRun`): three
consecutive non-`succeeded` handler runs flip `ok` → `repair_required`; the
next `succeeded` run flips `repair_required` back to `ok`. `repair_pending`
and `disabled` are never touched automatically — those require the explicit
repair/proposal flow or admin action.

Rollback (`rollbackHandler`) does not regenerate anything — it activates an
already-`superseded` handler version in place of the current active one,
directly (no proposal), since it can only return to an already-approved
prior state, never broaden permissions. Without an explicit
`target_version_id`, it targets the most recently superseded version (the one
that was active immediately before the current one — only one version is
ever superseded per activation, so this is unambiguous). A version that was
never activated (`draft`/`test_failed`/`pending_approval`) cannot be a
rollback target.

## Credentialed Sources

Status: implemented
(`server/src/modules/sources/customSources/customSourceCredentialCrypto.ts`,
`customSourceCredentialService.ts`, `POST/GET /api/v1/sources/custom-source-credentials`).
See [Credential Storage](CREDENTIAL_STORAGE.md) for how this channel relates
to ModelProvider API keys and CLI login state.

A Custom Source credential is created once (`name`, `secret`, and optional
`header_name`/`header_value_prefix`, defaulting to `Authorization`/`Bearer `),
encrypted at rest in the generic `credentials` table
(`credential_type = 'custom_source_fetch_credential'`) with the same AES-256-GCM
master key `loadOrCreateModelProviderApiKeyMasterKey` already protects that
table with. Creating one requires space admin. No API response — create,
list, or any handler version DTO — ever returns the plaintext secret.

A draft Custom Source references a credential by `credential_id` (a plain
pointer, not the secret) via `POST /api/v1/sources/custom-sources/drafts`.
`generateHandler` carries the connection's `credential_id` through to the
new version's policy envelope as `credential_ref`, for both handler execution
models. `credential_ref` is safe to expose in `input.json.policy.credential_ref`
(the handler-visible contract) because it is only an opaque identifier — the
handler itself never resolves it and never sees the secret.

Only the trusted fetch layer ever resolves the actual secret:
`CustomSourceCredentialService.resolveCredentialHeader` decrypts it once per
run/test and returns `{ header_name, header_value }`, which
`fetchAllowedOriginResponse` (`customSourceEndpointFetch.ts`) injects as a
request header on every live fetch it makes — the `typescript_node` mode's
single trusted pre-fetch, and every fetch the `declarative_pipeline_v1`
interpreter's steps make (`fetch_page`, `follow_link`, `download_asset`,
`paginate`'s next-page fetch). The credential is still subject to the same
`allowed_network_origins` allowlist as every other fetch — it is never sent
to an origin the policy envelope does not approve.

Activation gating reuses `evaluateCustomSourceActivation` unchanged: a first
activation with a `credential_ref` set is treated as within-envelope only
when Space policy's `credentialed_sources_allowed` is `true`; otherwise (or
when an already-active connection's credential changes) it creates a
`custom_source_credentialed_source` proposal, exactly as already described
above. Repair (Phase 9) is unaffected — a repaired version keeps whatever
`credential_ref` the active version already had unless the repair request
changes the connection's credential, at which point the same
`evaluateCustomSourceActivation` delta logic decides proposal-vs-auto-apply.

Credential rotation/deletion and a UI for creating or selecting a Custom
Source credential are not implemented (API/service layer only).
See [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §11.

## Phase 1 Schema Design (implemented in Phase 2)

This section records the schema shape consolidated into
`server/migrations/0000_baseline.sql`. There was no historical data or
deployed system when these Sources changes landed, so the declarative pipeline
and Source Recipe schema are part of the frozen baseline rather
than kept as separate incremental migration files. Once a real deployment has
applied `0001`, later schema changes must be added as ordered incremental
migrations.

`source_connections` gains nullable/defaulted implementation columns:

- `handler_kind varchar` — `built_in` (default), `generated_custom`, or
  `recipe`.
- `active_handler_version_id` — FK to `source_handler_versions(id)`, nullable.
- `active_recipe_version_id` — FK to `source_recipe_versions(id)`, nullable
  for Level 2 recipe sources.
- `repair_status varchar` — `ok` (default), `repair_required`,
  `repair_pending`, `disabled`.
- `last_handler_run_id` — FK to `source_handler_runs(id)`, nullable.

New table `source_handler_versions`: `id`, `space_id` (FK `spaces`),
`source_connection_id` (FK `source_connections`, cascade delete),
`version_number`, `language` (`typescript_node` or
`declarative_pipeline_v1`), `entrypoint`,
`handler_artifact_id` (FK `artifacts`, nullable), `manifest_json`,
`input_schema_json`, `output_schema_json`, `policy_envelope_json`,
`requested_capabilities_json`, `checksum`, `status` (`draft`, `test_failed`,
`pending_approval`, `active`, `superseded`, `disabled`),
`created_by_user_id` (nullable), `created_by_run_id` (nullable),
`proposal_id` (nullable, FK `proposals`), `test_result_json`, `created_at`,
`activated_at`, `superseded_at`. Unique on `(source_connection_id,
version_number)`.

New table `source_handler_runs`: `id`, `space_id`, `source_connection_id`,
`handler_version_id` (FK `source_handler_versions`, cascade delete),
`extraction_job_id` (FK `extraction_jobs`, nullable), `status` (`queued`,
`running`, `succeeded`, `failed`, `validation_failed`, `blocked`),
`input_artifact_id`, `output_artifact_id`, `logs_artifact_id` (FK
`artifacts`, nullable), `failure_class`, `failure_detail_json`,
`validation_result_json`, `resource_usage_json`, `created_at`, `started_at`,
`completed_at`.

New table `source_recipe_versions`: `id`, `space_id`,
`source_connection_id` (FK `source_connections`, cascade delete),
`version_number`, `recipe_json`, `policy_envelope_json`,
`primitive_versions_json`, `status` (`draft`, `test_failed`,
`pending_approval`, `active`, `superseded`, `disabled`),
`created_by_user_id`, `proposal_id`, `test_result_json`, `created_at`,
`activated_at`, `superseded_at`. Unique on `(source_connection_id,
version_number)`.

New table `settings`: generic scoped settings storage for low-frequency
instance, space, user, and space-user settings. Custom Source uses typed
settings keys in that table rather than adding feature-specific singleton
tables:

- `scope_type='instance'`, `scope_id='instance'`,
  `settings_key='source.custom_source.runner'`: Custom Source runner
  availability. Absent a row, the read API returns `runner_enabled=true`.
- `scope_type='space'`, `scope_id=<space_id>`,
  `settings_key='source.custom_source.space_policy'`: Space Settings product
  policy fields (creator roles, default capture/retention policy, allowed
  domains, download byte cap, credentialed-source allowance,
  same-envelope repair auto-apply).

Absent a space policy row, the read API returns system defaults rather than
failing, mirroring how Space Settings panels read other not-yet-configured
policies. The update API normalizes allowed domains to hostnames, always keeps
`owner` and `admin` in creator roles, and rejects non-owner/admin updates.
Instance-level sandbox hard limits other than download are config-driven
(`server/src/config.ts`), not stored in the space policy settings payload,
matching other instance-only hard limits in this codebase. The effective runner
settings for a space combine the instance runner read model with
`source.custom_source.space_policy.download_bytes_max`; Save URL/PDF
extraction, Source Recipe fetches, and Custom Source fetches use that space
download cap.

Shared wire DTOs and the handler `input.json`/`output.json` contract live in
`packages/protocol/src/sourceCustomSourceHandlers.ts`
(`CustomSourceHandlerVersionDTOSchema`, `CustomSourceHandlerRunDTOSchema`,
`CustomSourcePolicyEnvelopeSchema`, `CustomSourceHandlerInputSchema`,
`CustomSourceHandlerOutputSchema`, `CustomSourceSettingsDTOSchema`).
Source Recipe wire DTOs live in
`packages/protocol/src/sourceRecipes.ts`.

No Project-owned source schema is added anywhere in this design, and no
fields are added to Knowledge `sources`.

## Phase 6 Proposal Payloads

Phase 6 ("Policy and proposals") is implemented by
`server/src/modules/sources/customSources/customSourceProposalApplier.ts`,
`server/src/modules/proposals/payloadSchemas.ts`, and
`CustomSourceCreateFlowService.activateHandler`.

`custom_source_policy_delta`: created when a generated/repaired
handler version's policy envelope broadens permissions versus the active
envelope. Payload: `source_connection_id`, `handler_version_id`,
`current_handler_version_id`, `current_policy_envelope_json`,
`proposed_policy_envelope_json`, `envelope_diff_json` (computed fields that
changed).

`custom_source_credentialed_source`: created when a handler version
requests a `credential_ref`. Payload: `source_connection_id`,
`handler_version_id`, `current_handler_version_id`,
`current_policy_envelope_json`, `proposed_policy_envelope_json`,
`credential_scope_json`, `requested_by_user_id`.

`custom_source_repair_activation`: created only when repair produces a new
handler version whose policy envelope is **unchanged** from the active
baseline but Space policy does not allow same-envelope auto-apply — the
applier (`validateRepairActivationPayload`) rejects
`envelope_unchanged !== true` outright ("use a policy-delta proposal"
instead). A repair whose envelope actually broadens permissions creates a
`custom_source_policy_delta`/`custom_source_credentialed_source` proposal
through the same routing (`customSourceProposalTypeForEnvelope`) a fresh
(non-repair) activation would use, not this type — see "Repair" below.
Payload: `source_connection_id`, `previous_handler_version_id`,
`new_handler_version_id`, `envelope_unchanged` (boolean, always `true`),
`fixture_comparison_json`.

Each applier atomically validates the proposal/version binding, verifies that
the active pointer and policy envelope have not changed since proposal
creation, requires a successful handler test result, sets the named handler
version's `status` to `active`, sets
`source_connections.active_handler_version_id`, supersedes the previous active
version, and clears
`repair_status` back to `ok` — mirroring the existing
`applyKnowledgeCreateProposal`-style applier pattern in
`server/src/modules/knowledge/proposalApplier.ts`.

`source_recipe_activation`: created when a dry-run-tested recipe version
broadens the source policy envelope compared with the approved baseline.
Payload: `source_connection_id`, `recipe_version_id`,
`current_recipe_version_id`, `current_policy_envelope_json`,
`proposed_policy_envelope_json`, `envelope_diff_json`, and
`requested_by_user_id`. The applier validates the proposal/version binding
fail-closed, verifies the active pointer and policy envelope have not changed
since proposal creation, requires a successful dry-run result, activates the
recipe version, supersedes the previous recipe version, and updates
`source_connections.active_recipe_version_id`.

Policy-envelope comparison treats network-origin expansion, credential scope
changes, new sensitive capabilities, broader capture or retention policy,
larger resource limits, handler-language changes, and disabled log redaction as
approval-required deltas. First activation compares capture/retention against
the Space defaults; later activations compare against the active approved
handler version.

## Operations (Phase 12)

Status: implemented — rate limiting, artifact retention, and an observability
read model. No Instance Settings UI change or alerting integration; the new
hard limits are read-only via the existing
`GET /api/v1/sources/custom-source-settings/instance` response.

**Diagnosing a broken or blocked Custom Source** — one call answers it:
`GET /api/v1/sources/connections/:connectionId/custom-source`
(`PgCustomSourceHandlerRepository.getHandlerSummary`) returns, alongside the
active handler version and latest run:

- `repair_status` — `ok`, `repair_required` (3+ consecutive non-succeeded
  runs, or a failed repair attempt — see "Repair" above), `repair_pending`
  (a repair or activation is awaiting either a live run or proposal review),
  or `disabled` (nothing sets this automatically).
- `recent_run_status_counts` — a breakdown of the last 20
  `source_handler_runs` by status (`succeeded`/`failed`/`validation_failed`/
  `blocked`), for spotting an intermittent-vs-total failure pattern without
  paging through `handler-runs`.
- `pending_proposals` — every still-pending `custom_source_*` proposal
  currently blocking activation, so "why is this stuck in
  `pending_approval`" never requires a separate `/proposals` lookup and an
  older pending proposal cannot be hidden by a newer one.

**Rate limiting**: `generateHandler` (and therefore `repairHandler`, which
calls it internally) rejects with 429 once a connection has produced
`SERVER_CUSTOM_SOURCE_GENERATE_RATE_LIMIT_PER_HOUR` (default 30) new handler
versions within the trailing hour. Scoped per connection, not per Space or
instance — one connection being hammered (or retried in a loop) cannot
exhaust another connection's budget. The count/check/version insert path is
serialized with a transaction-scoped PostgreSQL advisory lock per
`space_id + source_connection_id`, so concurrent generation attempts cannot
all pass the rate-limit check from the same stale count.

**Artifact retention**: a scheduled task (`custom_source_artifact_retention`,
gated by `SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_ENABLED`, default on, every
`SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_INTERVAL_SECONDS`, default hourly)
prunes stored `typescript_node` handler-code artifacts
(`pruneSupersededCustomSourceHandlerArtifacts`) for versions `superseded`
longer than `SERVER_CUSTOM_SOURCE_ARTIFACT_RETENTION_DAYS` (default 30) —
except each connection's single most-recently-superseded version, which
`rollbackHandler`'s no-argument default targets, so a plain rollback is never
broken by this job. Only the artifact (file + `artifacts` row) and
`handler_artifact_id` are cleared; the `source_handler_versions` row itself
is kept for audit/history. `declarative_pipeline_v1` versions have no
artifact to prune (their pipeline definition lives in `manifest_json`).

**Fail-closed behavior** (already covered by existing tests, listed here for
an operator's reference, not newly added by Phase 12): runner disabled
(`runner_disabled`), handler language not in the instance allowlist
(`language_not_allowed`), and browser automation/shell/dependency
installation requests (unconditionally refused regardless of instance
availability flags) all record a `blocked` handler run with the reason as
`failure_class`, visible through `handler-runs` and now through
`recent_run_status_counts`.

## Non-Goals

- General plugin marketplace.
- Adapter top-level navigation.
- Project-owned source creation.
- Direct Knowledge `Source` writes.
- Direct Memory, Wiki, Task, Project, policy, credential, or DB writes from
  handler code.
- Browser automation in the first default path.
- Shell execution in the first default path.
- Dynamic dependency installation in the first default path.
