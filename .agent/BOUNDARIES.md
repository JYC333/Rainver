# Architecture Boundaries

Load this file for any task that changes structure, models, APIs, or agent behaviour.

---

## Data Boundaries

**B1** — `core/` must remain open-source-ready. It must not contain private instance data, real user memory, secrets, or deployment-specific config.

**B2** — `instance/` contains all deployment-specific state: database, logs, config, secrets, storage, cache. It is never committed to source control.

**B3** — One deployment instance can host many spaces. Do not create one instance per user or one instance per space.

**B4** — Space is the product-level isolation boundary. Data in space A must never be accessible to code running in the context of space B.

**B5** — `space_id` is required on every core data entity. The ContextBuilder enforces this boundary; it refuses to build context without an explicit `space_id`.

---

## User / Agent Boundaries

**B6** — User and Agent are separate models. A user is a person; an agent is an AI runtime. One user can own multiple agents.

**B7** — Users and agents have independent identity, permissions, and memory policies. Do not merge them into a single model.

**B8** — Agents can be user-owned, space-owned, project-owned, or system-owned. Project Folder selection is an execution input, not an Agent ownership class. Ownership affects visibility and permission inheritance.

**B8A** — Room speaking and execution identity is resolved per message. A
Room's creator and a task group's `manager_user_id` are lifecycle provenance,
not authority to substitute one human's retrieval visibility or CLI
subscription for another's. Each Room message creates its own collaboration
task and its Runs carry that message sender as `instructed_by_user_id`.
Room creation requires Project writer authority, every human roster member
must currently be able to read that Project, and revoking Project access also
revokes Room and Room-task reads. Room Run artifacts and proposals cannot widen
past the Run's `selected_users` boundary: they inherit the active Run grants
and remain subject to the Project ACL on every read.

---

## Memory Boundaries

**B9** — Memory is scoped long-term context, not raw business data. Raw input must enter `activity_records` first.

**B10** — Agents do not directly write active memory. All memory updates must go through the proposal → user approval → activation flow.

**B11** — Every memory read must be logged in `MemoryReadTrace` (table `memory_access_logs`). These traces can feed evolution signals and memory-health experiences, but they do not bypass Memory read/write governance.

**B12** — External chat capture (e.g. conversation imports) must create activity records first, not active memory.

## Relationship / Provenance Boundaries

**B12A** — Route durable links by meaning and endpoint shape:

| Link meaning | Canonical writer/table |
|---|---|
| Both endpoints are `space_objects` and the edge is part of the durable graph | Proposal-gated `object_relations` |
| Curated KnowledgeItem/Claim citation or supporting evidence | `knowledge_item_sources` / `claim_sources`; citation lineage is not a canonical semantic graph edge |
| Accepted asymmetric lineage with a non-object endpoint | `provenance_links`, or the owning domain's dedicated `*_sources` table |
| MemoryEntry-to-MemoryEntry semantic relationship | `memory_relations`; its relation vocabulary is frozen and must not expand into general provenance |
| Candidate/context Evidence association | `evidence_links`; it is not accepted provenance or the canonical object graph |
| Working-note navigation | `note_links`; it is a UI link, not canonical graph authority |
| Relation-card source citation | `relation_source_links`, with exactly one activity, SourceItem, Evidence, or external target |

Do not dual-write the same semantic edge to multiple tables. Do not add another
generic relationship/provenance link table; extend the canonical table or add
a narrowly owned domain join table only when its lifecycle is genuinely
different.

**B12B** — Polymorphic link rows are not proof that an endpoint still exists.
Every writer validates endpoint space/access through the owning module, and
every reader must tolerate deleted or inaccessible endpoints without treating
the link as canonical object existence.

**B12C** — New Project-domain aggregates (Inquiry Thread, Experiment,
Decision Case, and their state/relation tables) are never `space_objects`
rows and never write `object_relations`. They use their own explicit,
narrowly-owned FK link tables (e.g. `inquiry_thread_relations`,
`inquiry_thread_note_links`, `experiment_thread_links`,
`decision_thread_links`). Cross-domain navigation/discovery association that
is not a business relationship is served by `retrieval_edges` (rebuildable,
non-authoritative), not by a new generic association table. See
[ADR 0011](decisions/0011-domain-owned-inquiry-model.md).

---

## Execution Boundaries

**B13** — `_SANDBOXED_ADAPTERS` (claude_code, codex_cli, and future coding runtimes) are always sandboxed. Low/medium-risk Project Folder reads use the rootless bubblewrap `read_only` mount boundary; high-risk file-access CLI runs use a git worktree + local executor; critical local-CLI runs use the one-shot Docker executor. Namespace/Docker failures are fail-closed rather than silently downgraded. An agent can escalate `risk_level` but cannot remove an adapter from `_SANDBOXED_ADAPTERS`.

**B14** — Vendor context files (CLAUDE.md, AGENTS.md, Cursor rules) are generated artefacts written by ContextCompiler to a server-owned sandbox/staging directory. They are not the source of truth and are never written directly to the real Project Folder.

**B15** — Formal agent runs (automated, tracked, sandbox-enforced) must go through agent-space managed mode. IDE plugin usage is assist/manual mode — it is not tracked the same way.

**B16** — Windows desktop is not a full runtime. The agent loop runs in Linux/WSL/server. A desktop app, if built later, is only a launcher/control panel. See [0005](decisions/0005-desktop-runtime.md).

---

## Project Folder Boundaries

**B17** — Project Folder file access must go through `PgProjectFolderRepository` / `PgRunSandboxManager` and `PathPolicy`. Adapters must not access arbitrary host paths.

**B18** — Sandboxes are short-lived execution areas. Long-term records are: artifacts, diffs, logs, and approved proposals. Sandbox directories may be cleaned up after artifact collection.

**B19** — Agents do not directly modify a real Project Folder. Read-only work uses an OS-enforced `read_only` namespace; mutation uses `Project Folder → git worktree/sandbox → agent execution → validation → diff/artifacts → approval → apply patch`.

**B19A** — Files & Code reads are policy-gated. `project_folder.read` is enforced for tree, file, git status, and git diff. Protected-Folder, external-root, restricted/protected, full-diff, and secret-like reads force durable audit records.

---

## Capability Boundaries

**B20** — Capability changes require the full lifecycle: draft → proposed → testing → approval → enabled. Self-evolution (an agent modifying its own capabilities) must go through this flow via capability proposals.

**B21** — Capabilities are code-defined (manifest + code + prompts + tests), not only prompt-defined. A capability without tests or a manifest is incomplete.

**B21A** — Open Skill imports are untrusted source material. Import may fetch and
normalize package metadata, `SKILL.md`, and bounded same-repository package
file inventory, but it must not execute scripts, install dependencies, load
server/plugin code, write active memory, or auto-enable a capability. Vendor
runtime declarations such as `allowed-tools` are permission requests only.

**B21B** — Runtime skill files for Claude Code, Codex, `model_api`, and future
runtimes are generated adapter artifacts. Agent-space CapabilityDefinition and
profile records remain the source of truth.

---

## Frontend / UI Boundaries

**B23** — The frontend is not an admin-only console. It is the primary user-facing product surface including personal use (capture, review, knowledge reading, assistant chat). Design for non-technical users.

**B24** — Raw capture inputs (quick thoughts, inbox drops, file imports, chat captures) must enter via `ActivityRecord` first. Editor-owned user documents such as Notes and diary entries are durable product documents, not raw input records, and may write their owning domain tables directly. Any extraction from those documents into Memory, KnowledgeItem, ContextBuilder, or FlashCard must still go through the proposal/sources flow. KnowledgeItem rows must not automatically enter Memory or ContextBuilder.

**B24A** — The Activity Inbox holds pointers, never content. Any module that wants user attention delivers a clearable notification row into `ActivityRecord`; the content itself lives in that module's own reading surface (e.g. Sources-derived digests read in Library, not in Inbox). Inbox rows disappear when handled; the underlying content stays where it lives and remains revisitable from its owning surface.

**B25** — Files & Code (file browser, diff viewer) is for Project Folder operators. It must not be shown as the primary entry point for personal-use features (capture, review, chat).

**B26** — Git diff review is approval-oriented, not merge-tool-oriented. The UI must show attribution (which agent run produced the diff) and make accept/reject the primary actions. Inline editing in the diff view is not supported in v1.

**B27** — Server status (RuntimeStatusBar) must always be visible in the shell. It must not be hidden behind a settings page. Degraded/error states must be immediately apparent to the user.

---

## Mobile Boundaries

**B28** — Mobile is a thin client. Agent execution always runs server-side. The mobile client must never attempt to run agent code locally.

**B29** — Quick capture on mobile must work offline. The client must queue the ActivityRecord in IndexedDB and sync when the connection is restored.

**B30** — Card review on mobile must pre-fetch the next N due cards so review can continue without a live connection.

---

## Sync Boundaries

**B31** — All model primary keys must be UUIDs (or equivalent globally-unique strings). Auto-increment integer PKs are not allowed — they break sync across devices.

**B32** — Sync must never overwrite user data without explicit conflict resolution. Sync conflicts surface in the UI; the user decides. Memory changes through sync still require the proposal → approval flow.

---

## Resilience Boundaries

**B-R1** — `Run.status` includes `degraded` in addition to `queued|running|succeeded|failed|cancelled|waiting_for_review`. A run is `degraded` when it completes but with partial or compromised quality — the output is accessible but flagged for user review.

**B-R2** — `Run.mode` includes `live` (real execution, persists changes) and `dry_run` (preview, no persistent changes, artifacts not saved).

**B-R3** — Artifact export is explicit: every artifact has `path` and/or `content`; `GET /api/v1/artifacts/{id}/export` returns a file download. Artifact paths point to persistent storage (`~/.aspace/artifacts/`), not sandbox working directories.

**B-R4** — `Proposal` has explicit temporal fields: `created_at`, `decided_at`, `deadline` (soft, optional), and computed `expired` (true when deadline passed and status is still `pending`). `urgency` field (`low|normal|high|critical`) affects sort order.

**B-R5** — All temporal fields are explicit on Run: `created_at`, `started_at`, `completed_at`, `scheduled_at`. No derived timestamps.

---

## Module / Plugin Boundaries

**B33** — Server modules should prefer shared gateway/db/protocol helpers over direct cross-module coupling. Cross-domain imports are allowed only when they express an explicit product boundary recorded in the relevant architecture doc or ADR, and they must not bypass the owning module's public route/service boundary.

**B34** — Every server module's HTTP routes must live in `server/src/modules/<module>/routes.ts` and be mounted through `server/src/gateway/routeRegistry.ts`. Official plugin package routes live under `plugins/official/<plugin_id>/server/src/`, are compiled into `server/dist/official-plugins/<plugin_id>/`, and are mounted only through `PluginHost` after core `SERVER_MODULES` and before the catch-all. Routes must not be registered directly in `server.ts`, `index.ts`, or ad hoc shared API files.

**B35** — The server route registry (`server/src/gateway/routeRegistry.ts`), official plugin descriptor registry (`server/src/modules/plugins/registry.ts`), official plugin package loader (`server/src/modules/plugins/builtInPlugins.ts` and `server/src/modules/plugins/packageLoader.ts`), and frontend module registry (`apps/web/src/modules/registry.ts`) are the single sources of truth for which core and official optional features are active. Official plugin frontend page source lives with the plugin package under `plugins/official/<plugin_id>/web/src/`; it must not import `apps/web/src` directly. The frontend registry statically imports an app-owned adapter under `apps/web/src/plugins/<plugin_id>/` that injects host APIs into the plugin page until remote frontend bundles exist. Do not hardcode route lists or nav items elsewhere.

**B36** — Frontend module pages must use `React.lazy()` entry points. A module must not be eagerly imported in `apps/web/src/App.tsx` or `apps/web/src/core/Shell.tsx`. This preserves Vite's ability to produce separate chunks per module for build-time exclusion.

**B37** — `planned: true` modules must have a working stub page (not a blank component, not a 404). The stub must name the feature, state that it is planned, and reference the relevant `.agent/modules/` doc.

**B51** — Official optional modules are gated at the route-handler/contribution level via the plugin guard (`requireOfficialPluginEnabled()` or `ctx.http.pluginGuard()`), not by conditionally registering core server modules. Backend routes for bundled official plugins are mounted by `PluginHost`; behavior is gated by DB-backed plugin enablement state. Plugin job handlers and proposal appliers must fail closed when disabled, and scheduled tasks must fan out only to enabled scopes. Frontend entries with `source: 'official_plugin'` must overlay their `enabled`/`visible` state from `GET /api/v1/plugins/effective`, not from static values.

**B52** — Capability (`catalog/capabilities/`) and Official Optional Module (`/api/v1/plugins`) are distinct concepts and must not be conflated in code, comments, or API design. Capabilities are agent AI skill descriptors; Official Optional Modules are product feature packages. A module may use a capability internally, but they are not the same type.

**B52A** — Open Skill, Capability, Capability Pack, Workflow Template, Runtime
Skill, and Product Plugin are distinct concepts. External Open Skill packages
can be normalized into capability candidates; Capability Packs group
capabilities and workflow templates; Runtime Skills are generated runtime
bindings; Product Plugins are optional product feature packages.

**B53** — Plugin settings and enablement state must be scoped exactly as declared in the descriptor's `scope` field: `space` uses `(plugin_id, space_id)` and requires space owner/admin for writes; `user` uses `(plugin_id, user_id)` and follows the user across spaces. Space-scoped plugin state for space A must never be readable or writable in the context of space B, and user-scoped plugin state must never be readable or writable by another user. The plugin guard must check both plugin existence and descriptor scope.

---

## Runtime Adapter Boundaries

**B38** — The agent-space core is runtime-agnostic. OpenCode, Claude Code, Codex, Cursor, and any other vendor CLI are optional runtime adapters, not the foundation. Core features (memory, knowledge, flashcards, activity capture, proposals, assistant chat) must work without any coding-agent runtime installed.

**B39** — No vendor CLI or external runtime is the source of truth for memory, policy, permissions, or audit records. These always live in the agent-space database regardless of which runtime adapter is active.

**B40** — An enterprise or commercial deployment must be able to disable any runtime adapter (for example `claude_code`) without breaking the rest of the system. Adapter availability is checked at run time via runtime-generic status/detection; unavailability must be surfaced as a clear error, not a silent fallback to unsandboxed execution.

---

## CLI Credential Boundaries

**B45** — CLI credential profiles are owned by agent-space. Sandboxes never receive the full server container HOME or the full `instance/secrets/` directory.

**B46** — Every CLI credential grant or denial is audited in `cli_credential_events`. Manual and automation CLI runs require an explicit CredentialBroker profile. Runs with no profile configured fail before adapter invocation and record `credential_source="none"` with `fallback_reason="no_profile_configured"`.

**B47** — One-shot Docker sandboxes receive at most one credential profile dir, mounted read-only. The container has no ambient host HOME and the MVP rejects provider-proxy/network-profile grants because its network namespace is `none`.

**B48** — Credential profiles are never written back from the sandbox automatically. If a CLI updates its login state during a run, only the profile's source directory is affected (via symlink for worktree, via writable volume for Docker). No automatic propagation to other profiles.

**B49** — The CredentialBroker never exposes raw secret values through the API. The credentials API returns path metadata only (source_path, exists, non_empty).

## API Entrypoint Boundaries

**B50** — `server/` is the TypeScript backend source root. The Compose/API
entrypoint service name remains `server` for web, dev, test, and prod.
The permanent gateway module owns routing and request context; unknown
`/api/v1/*` routes fail closed with the local 404 catch-all. Schema authoring
goes through Drizzle definitions under `server/src/db/schema/`; generated SQL
artifacts live under `server/migrations/` and are applied only through the
explicit server migration runner. Do not hand-edit migration SQL for schema
changes. The server service process does not auto-migrate on startup.
DB-persisted API-key storage remains disabled/deferred until the canonical
schema adds that table.

---

## Deployment Boundaries

**B41** — The main app container does not directly restart or rebuild itself. The current product deployment routes are fail-closed (`POST /api/v1/deployments/jobs` returns 501), and no production server service submits deployer jobs. The only current deployment triggers are explicit operator execution of the allowlisted scripts or an operator-controlled client inside the privileged deployer container.

**B42** — The deployer Unix socket is never exposed on TCP and remains private to the privileged deployer container. It must not be placed in `AGENT_SPACE_HOME`, mounted into the server container, or made reachable from an agent runtime or sandbox. Filesystem permissions are defense in depth, not an approval mechanism.

**B43** — The deployer accepts exactly `rebuild_agent_space`, `restart_agent_space`, and `health_check`; these jobs accept no request arguments. It never accepts arbitrary commands, request-to-environment overrides, self-evolution jobs, code-patch jobs, capability jobs, or caller-selected script paths. The deployer protocol does not validate proposal state. A future product deployment trigger must therefore verify a human-approved proposal in the server authority before submitting one of these jobs and must add durable audit coverage in the same change.

**B44** — The deployer container's Docker socket plus read-write repository mount is host-equivalent authority. Nothing on the evolution, `code_patch`, capability, agent-runtime, automation, job, or scheduler path may reach deployer input or invoke its scripts. The CLI sandbox executor is a separate run path with a fixed image, fixed resource policy, deny-by-default network, and allowlisted mounts; it is never routed through the deployer protocol.

**B44A** — An agent-space instance must never be directly exposed to the public internet. The current frontend has no production TLS termination, rate limiting, or general CSRF-token hardening. Any move toward internet exposure must first implement and review those controls and update the security boundary documentation.

---

## Open-Source Boundary

**B22** — The project is open source. Do not put private data, real user memory, or non-shareable credentials into `core/`; see B1/B2.
