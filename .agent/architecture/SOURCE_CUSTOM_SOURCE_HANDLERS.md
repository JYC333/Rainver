# Sources Custom Source Handlers

Status: backend create-flow, proposal integration, scan jobs, and the Level 2
Source Recipe path are implemented. The schema, read models, declarative interpreter, explicit pipeline
version creation, fixture tests, inside-envelope activation, handler-run history,
manual/scheduled scan queueing, trusted endpoint fetch path, Custom Source
proposal payloads/appliers, Source Recipe plan/create/dry-run/activate
services, Source Recipe proposal applier, recipe scan worker,
`source_runs` read model, and declarative-pipeline bridge exist as backend
APIs/services. The web `/sources` area is `SourceChannelsPage` plus
`/sources/:sourceId` (`SourceChannelDetailPage`); no page calls the Custom
Source draft/handler or Source Recipe plan/create/dry-run/activate APIs. The
web surfaces for this feature are `CustomSourceSpacePolicyPanel` (Space
Settings) and `SourceExecutionSettingsPanel` (Instance Settings).
Repair/rollback and credentialed source support are implemented backend-side
(see "Repair" and "Credentialed Sources" below). Browser/Python handlers are
not implemented. Goal repair is represented by lightweight source status, with no
code-approval UI. `/sources/access` now submits credentials through the existing
encrypted Source credential endpoint; creation and editing use the shared goal
conversation, not a direct Custom Source form.

`typescript_node` remains in persisted language enums so historical records can
be read; its generator, source-artifact writer and execution implementation have
been removed. Advanced handler creation requires an explicit declarative
pipeline. New Goal-generated code uses exact-SHA isolated Host execution under
ADR 0026. Declarative handler versions can be explicitly bridged into Level 2
`source_recipe_versions` without activating the resulting recipe.

## Level 3 generated handlers

The old Level 3 code-template path is removed. There is no compatibility runner
or generator. Retained handler versions, artifacts and run history remain
readable. A legacy version cannot be fixture-tested or scanned, and repair
refuses it before generating a replacement. Existing approvals or activation
history do not restore execution. New generated Goal implementations use the
separate isolated Host contract, not these retained handler versions.


The contract validator also accepts an internal `metadataOnlyOrigins` input for
trusted built-in search connector results used by Source Goals. Its caller must
derive these from the system parser, never from Agent output or request JSON. It
permits only metadata item links with no snapshots or evidence and does not
change the approved network envelope. Ordinary recipe/declarative-handler callers
omit it and retain strict provenance validation. See
[Source Goals](SOURCE_GOALS.md#built-in-search-preview-and-visible-failure-feedback).

## Boundary

Custom Source belongs to Sources. It extends `SourceConnection` with
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

The shared input/output schemas describe retained history and the structured
results produced by declarative pipelines and Source Recipes. They do not
provide an executable-file contract for new handler code. New Goal code uses
the separate ADR 0026 Host contract.

The trusted interpreter receives structured input and may create bounded
snapshot files in its temporary `files/` directory. The server validates all
output before the materializer creates Sources rows and artifacts. Interpreter
steps cannot directly mutate Memory, Knowledge, Wiki, Tasks, Project state,
policy or credentials; those domains retain their own write authorities.

## Policy Envelope

Every handler version has a policy envelope. The envelope includes:

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

Legacy `typescript_node` execution is permanently refused. Python handlers are
not implemented. New Goal-generated code runs only through the isolated Host
contract in [ADR 0026](../decisions/0026-sources-isolated-request-execution.md).

### Execution policy

`sources/sourceExecutionPolicy.ts` owns `SourceExecutionSettings`,
`SourceExecutionResult`, `effectiveSourceExecutionLimits` and
`cleanupSourceExecutionFiles`, shared by the declarative interpreter and Source
Recipes. The old runner module and class are removed, without an alias.

`evaluateCustomSourceExecutionBlockReason` preserves instance/language and
browser/shell/dependency denial checks, then rejects every non-declarative
handler with `handler_language_removed`. The create-flow test and scan worker
check admission before resolving credentials or fetching the endpoint. The
shared `executeCustomSourceHandler` checks admission again and only dispatches
the reviewed declarative interpreter; it never loads source-code artifacts.
Activation, repair and rollback reject removed handler languages with 409;
existing approval or activation history cannot override execution admission.
The Goal executor uses its own isolated admission and may still use the
`typescript_node` language setting; that setting does not restore the removed
handler implementation.

Fixture/live tests and scheduled/manual scans of retained code versions record
a blocked outcome in `source_handler_runs`. Paired extraction jobs fail and the
scan worker advances the schedule to avoid tight retries. Legacy repair returns
409 before generation, fetching or mutation. Retained history remains readable;
no automatic migration or activation is performed. Declarative live requests
retain the origin/redirect boundary.

The contract validator (`customSourceContractValidator.ts`) rejects a
snapshot `file_path` that is a symlink (`lstat`, not `stat`) and separately
verifies via `realpath` that the fully resolved path — including any
symlinked intermediate directory under `files/` — stays inside the
sandbox `files/` root, before the materializer ever reads or copies it.

### Create flow

`server/src/modules/sources/customSources/customSourceCreateFlowService.ts` implements the
backend draft -> generate-handler -> test-handler -> activate flow. Handler
creation validates an explicitly supplied pipeline; missing or unsupported
`generation_mode` returns 422. Fixture testing uses the same interpreter/validator path as scans and records `source_handler_runs`
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

Manual `POST /api/v1/sources/channels/:channelId/scan` also creates the
paired handler run for `generated_custom` connections rather than routing them
through the built-in extraction worker.

## Declarative Pipeline Model

`language: "declarative_pipeline_v1"` is the supported handler execution model.
The step catalog supports list/single-page extraction, pagination, linked pages
and assets. New recipe-like sources are represented by
Level 2 `source_recipe_versions`. Any `declarative_pipeline_v1` handler
versions created through advanced/admin paths remain readable Custom Source
rows. The explicit bridge (`SourceRecipePipelineBridgeService`,
`POST /api/v1/sources/custom-sources/:connectionId/bridge-pipeline`) validates
`manifest_json.pipeline`, wraps it as `source.recipe.v1`, creates a new paused
recipe source, and writes a draft `source_recipe_versions` row. It does not
mutate that custom-source connection or auto-activate the recipe; the
normal recipe dry-run/activate path still applies.

A `declarative_pipeline_v1` handler version has no generated/untrusted code at all — its
`manifest_json.pipeline` is a JSON step list interpreted in-process by a
fixed, reviewed step catalog (`server/src/modules/sources/customSources/customSourcePipelineInterpreter.ts`).
There is nothing to sandbox; every live network request still goes through
the same origin-allowlist + redirect-revalidation guard
(`fetchAllowedOriginResponse` in `customSourceEndpointFetch.ts`). `browser_automation_enabled`,
`shell_enabled`, and `dependency_installation_enabled` are structurally
impossible for this model (a step interpreter has no shell or dynamic-code
surface), not merely disabled by policy.

Step catalog (`packages/protocol/src/sourceCustomSourceHandlers.ts`,
`CustomSourcePipelineStepSchema`):

- `fetch_page` — fetch one URL into a named `html` variable. `url:
  "$source.endpoint_url"` is a sentinel meaning "use the already-fetched /
  fixture-overridable primary endpoint HTML" (`handlerInput.source.config.fetched_html`) rather than a
  live fetch; any other literal URL is a live fetch subject to the policy
  envelope's `allowed_network_origins`.
- `extract_list` — split an `html` variable into repeated items by one CSS
  class name into a named `items` variable, using the trusted
  `customSourceHtmlExtract.ts` implementation.
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
combined; each individual fetch is capped at `max_download_bytes`. There is
no separate cumulative-bytes-across-fetches limit. The worst case is
`max_files * max_download_bytes`. Exceeding
`max_output_bytes` on the final serialized output produces
`output_too_large: true` with `raw_output_json: null` in the shared result contract.

`mode: "test"` (fixture testing) is deliberately not fully live: only a
`fetch_page` step targeting the primary-endpoint sentinel ever resolves to
real content (the pre-fetched/fixture HTML). `follow_link`, `download_asset`,
`paginate`, and any `fetch_page` with a literal URL are no-ops that record a
diagnostic warning instead of performing a live fetch — a fixture test must
stay offline and side-effect free after primary input preparation. This means a fixture test cannot exercise what a multi-fetch
pipeline actually does beyond page 1; only a live scan run does.

Generation: `POST /api/v1/sources/custom-sources/:connectionId/generate-handler`
requires explicit `generation_mode: "pipeline"`; omission, `code_template` and
other values return 422. A `pipeline` body field is validated against
`CustomSourcePipelineDefinitionSchema`; there is no template/LLM step here —
the caller supplies the full pipeline definition. `entrypoint` is set to the
constant `"pipeline"` (the column is `NOT NULL` but there is no source file to
point at) and `handler_artifact_id` is `null`.

Execution dispatch: `customSourceHandlerExecution.ts`'s
`executeCustomSourceHandler` is shared by `testHandler` and the scan worker's
`runOne`. After admission, it parses `manifest_json.pipeline` and runs
`runCustomSourcePipeline`. The `SourceExecutionResult` shape feeds the shared
contract validator and materializer. There is no code-artifact execution branch.

Schema: `source_handler_versions.language`'s `CHECK` constraint in
`server/migrations/0000_baseline.sql` allows both `typescript_node` and
`declarative_pipeline_v1`. Instance Settings' `allowed_languages`
(`SERVER_CUSTOM_SOURCE_ALLOWED_LANGUAGES`) defaults to both values.

## Level 2 Source Recipes

Status: `server/src/modules/sources/sourceRecipes/`,
`server/src/modules/sources/sourceRecipeRoutes.ts`, and the pipeline
bridge. Backend only; no web page calls these APIs.

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
  Activation re-checks under the connection lock that the active version is
  still the one the envelope was compared with and that the version is still
  activatable with a passing dry-run, and otherwise answers 409.
- `recipeScanWorker` handles manual/scheduled scans for active recipe sources
  and materializes validated output through the shared Sources
  materializer. Its scheduler first reclaims a recipe scan job left `running`
  for over ten minutes, so a crashed process cannot block a channel forever.
- `listSourceRuns` projects product run history from extraction jobs, handler
  runs, and recipe dry-run results so the UI does not expose raw worker tables
  by default.
- `SourceRecipePipelineBridgeService` explicitly bridges existing
  `declarative_pipeline_v1` handler versions into draft recipe sources.

The Source Recipe plan, create, dry-run, and activate flow is API-only; the
web client declares these calls. No frontend page wires them.

## Repair

Status: implemented (`server/src/modules/sources/customSources/customSourceRepairService.ts`,
`POST /api/v1/sources/custom-sources/:connectionId/repair` and `.../rollback`).
Repair supports only `declarative_pipeline_v1`. It calls
`CustomSourceCreateFlowService.generateHandler`/`testHandler` with explicit
pipeline mode. A retained code handler returns 409 before generation or state
changes; repair does not migrate legacy code.

Repair creates a new handler version. It does not mutate the active version in
place, and it never touches a connection that has no active handler version
(422/409 — repair recovers a *running* source, it does not create one).

Regeneration input is the active version's own `manifest_json` (its
`pipeline` definition) merged with any explicit
overrides in the repair request body (`pipeline`,
`capture_policy`, `retention_policy`, `fixture_html`) — a repair call with no
overrides at all still re-fetches/re-tests live content, which is a
meaningful repair attempt on its own for drift that is about site content
rather than handler configuration.

While a repair attempt is in flight, `source_connections.repair_status` is
`repair_pending`; any failure past that point (generation, the fixture test
itself throwing rather than just failing, envelope evaluation, activation, or
proposal creation) reverts it to `repair_required` rather than leaving it
stuck `repair_pending` forever, and so does rejecting the repair's proposal.
A repair call rejects outright (409) if the connection is already
`repair_pending`, so two repair attempts cannot race on
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
  `custom_source_repair_activation` (see "Proposal payloads" below);
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
new declarative version's policy envelope as `credential_ref`. `credential_ref` is safe to expose in `input.json.policy.credential_ref`
(the handler-visible contract) because it is only an opaque identifier — the
handler itself never resolves it and never sees the secret.

Only the trusted fetch layer ever resolves the actual secret:
`CustomSourceCredentialService.resolveCredentialHeader` decrypts it once per
run/test and returns `{ header_name, header_value }`, which
`fetchAllowedOriginResponse` (`customSourceEndpointFetch.ts`) injects as a
request header on the trusted primary pre-fetch and every fetch the `declarative_pipeline_v1`
interpreter's steps make (`fetch_page`, `follow_link`, `download_asset`,
`paginate`'s next-page fetch). The credential is still subject to the same
`allowed_network_origins` allowlist as every other fetch — it is never sent
to an origin the policy envelope does not approve.

Activation gating reuses `evaluateCustomSourceActivation` unchanged: a first
activation with a `credential_ref` set is treated as within-envelope only
when Space policy's `credentialed_sources_allowed` is `true`; otherwise (or
when an already-active connection's credential changes) it creates a
`custom_source_credentialed_source` proposal, exactly as already described
above. A repair keeps whatever
`credential_ref` the active version already had unless the repair request
changes the connection's credential, at which point the same
`evaluateCustomSourceActivation` delta logic decides proposal-vs-auto-apply.

Credential rotation/deletion and a UI for creating or selecting a Custom
Source credential are not implemented (API/service layer only).

## Schema in the baseline

The declarative pipeline and Source Recipe schema live in
`server/migrations/0000_baseline.sql`. Later schema changes are new numbered
files after that baseline. There is no `0001`. Do not recreate one.

`source_connections` has these implementation columns:

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

Knowledge `sources` does not carry a Project-owned source schema.

## Proposal payloads

Implemented by
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

## Operations

Rate limiting, artifact retention, and an observability read model. No
Instance Settings UI change or alerting integration. The hard limits are
read-only via the existing
`GET /api/v1/sources/custom-source-settings/instance` response.

**Diagnosing a broken or blocked Custom Source** — one call answers it:
`GET /api/v1/sources/connections/:connectionId/custom-source`
(`PgCustomSourceHandlerRepository.getHandlerSummary`) returns, alongside the
active handler version and latest run:

- `repair_status` — `ok`, `repair_required` (3+ consecutive non-succeeded
  runs, or a failed or rejected repair attempt — see "Repair" above), `repair_pending`
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
except each connection's single most-recently-superseded version. Retaining
an artifact preserves history; it does not make an old code version eligible
for rollback or execution. Only the artifact (file + `artifacts` row) and
`handler_artifact_id` are cleared; the `source_handler_versions` row itself
is kept for audit/history. `declarative_pipeline_v1` versions have no
artifact to prune (their pipeline definition lives in `manifest_json`).

**Fail-closed behavior** (covered by execution-policy and service tests, listed here for
an operator's reference): runner disabled
(`runner_disabled`), handler language not in the instance allowlist
(`language_not_allowed`), and browser automation/shell/dependency
installation requests (unconditionally refused regardless of instance
availability flags), and legacy code execution (`handler_language_removed`) all
record a `blocked` handler run with the reason as
`failure_class`, visible through `handler-runs` and
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

## Isolated execution foundation

[ADR 0026](../decisions/0026-sources-isolated-request-execution.md) describes the
current foundation. Hosts opt in and offer `isolated-v1`; server dispatch generates
execution identities and refuses unoffered Hosts. Trusted mode never weakens it.
Bubblewrap mounts only the real Node executable, libraries and readonly code;
no handler node_modules, credentials, shell or writable host directory is exposed.
Resources use verified user-systemd cgroups or an administrator-delegated direct
cgroup v2 subtree. Missing capabilities refuse execution; standard-container
acceptance still needs that delegation and has not been performed.

The trusted daemon's pinned BasicCrawler/Cheerio adapter is serial, with a private
queue, scope/code-bound atomic checkpoint and recoverable owner leases. It invokes
isolated handlers for bounded `{items,next_urls}`. The framework concurrency-four
benchmark is not this adapter's throughput. Business cursors and materialization
remain server-owned. Sources broker scopes credentials by exact route on every
hop, requires HTTPS for credentials, combines registry/request cancellation,
preserves binary bytes, and exposes only bounded incremental metadata. Account
and endpoint admission/cooldown are durable and atomic (429 and eligible 503 only,
1s..24h). Current create/scan/repair flows have not enabled free generation; old
Level 3 remains frozen. This foundation itself adds no goal model or scheduler.
Stage-two orchestration now consumes it through the existing scheduler/jobs; see
[Source Goals](SOURCE_GOALS.md), including the implemented goal conversation
and explicit compatibility mapping described below.

Host capability offers describe executability, not authorization. Host owner and
Source/Space/Project permission checks remain server-owned; phase two cannot use
self-reported capability as authority. The adapter uses one retry only for
transient network/5xx errors, truncates HTML discoveries to 100 HTTP(S) links with
explicit `link_coverage`/aggregate `coverage`, and never expands broker scope or
request caps. Public input remains 1MiB UTF8; an independent readonly daemon-only
collection envelope is bounded at 16MiB with response bodies <=8MiB decoded.
Atomic complete owner-file publication excludes collection workers; empty legacy
lease directories are not claims. Direct isolation also requires `prlimit`
CORE=0/FSIZE=output_bytes, without weakening namespace or cgroup controls.


## Goal UI compatibility

Source list/detail authoring now opens the goal conversation. Existing handler
and recipe registry/read APIs remain, and metadata-only legacy goal mapping
does not execute or rewrite versions. Credentials use the existing encrypted
Source endpoint through the dedicated `/sources/access` page, never messages
or generated code. New generated goal implementations retain exact-SHA isolated
execution; unavailable isolation refuses rather than using the legacy runner.

Retained `typescript_node` versions are refused at shared handler admission
and dispatch boundaries. Scheduled/manual jobs and fixture/live tests cannot
execute them; generation and repair cannot create replacement code versions. Existing registry/history and
metadata-only mapping remain available; executing migrated code requires the
new Goal's own exact-preview authorization and isolated Host path. Standard
container acceptance remains subject to the separate
[deployment enablement gate](../tasks/deferred-register.md#sources--deployment-enablement).
