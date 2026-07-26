# Module: Context Compiler

## Purpose
Translate a ContextPackage into a CLI-specific instruction file written to the sandbox. Security scanning, token budgeting, trust labels, and routing-manifest-driven `.agent/` doc loading happen here.

## Owns
- `ContextCompiler` class, `TargetFormat` enum, `CompiledContext` dataclass
- Security scanning of all content before inclusion (via `server/src/modules/context/compiler.ts`)
- Token/character budget enforcement (128k chars default, priority-ordered truncation)
- Trust label annotation per section (`[system]`, `[user]`, `[project_folder]`, etc.)
- DB-authoritative Context Profiles (`context_profiles`) for Space/Project/Project-Folder/Agent/User context packs and routing manifests
- Progressive `.agent/` doc loading (default docs plus routing-manifest matches from touched TS/web/protocol paths)
- Vendor file header marking files as generated, not source of truth
- Agent Persona Prompt (`SOUL.md`) generation from agent-scoped identity memories
- Sandbox hook scripts (PostToolUse docs-sync reminders)
- Explicit artifact-backed context attachments selected by
  `context_artifact_ids`; the compiler consumes resolved attachments and does
  not run retrieval itself.

## Target → File Mapping

| Target | File(s) written |
|---|---|
| `claude` | `CLAUDE.md` + Agent Persona Prompt sidecar (`SOUL.md`, if agent identity present) |
| `codex` | `AGENTS.md` |
| `cursor` | `.cursorrules` |
| `generic` | `CONTEXT.md` |
| `soul` | Agent Persona Prompt (`SOUL.md`) |
| `prompt` | `prompt.md` |

## Section Priority (lower = kept first when budget exceeded)

| Priority | Section | Source |
|---|---|---|
| 0 | Task | task_goal, always present |
| 1 | System Policy | system-scoped memories |
| 2 | User Context | user-scoped memories |
| 3 | Project Docs | `.agent/` root docs |
| 4 | Project Context | project_folder + capability memories |
| 5 | Agent Context | agent-scoped memories |
| 6 | Module Docs | `.agent/modules/*.md`, task-relevant only |
| 7 | Attached Context | resolved ContextAttachments |
| 8 | Recent Activity | episodic memories |
| 9 | Session History | session summaries |
| 10–14 | Tools, Sandbox, Validation, Constraints, Output | compile() args |

## Integration

```
ContextBuilder.build(attachments=[...], project_folder_path=...) → ContextPackage
     ↓
ContextCompiler.compile(context, target, task_goal, sandbox_dir,
                         project_folder_path, touched_files, routing_manifest)
     ↓
{sandbox_dir}/CLAUDE.md  (or AGENTS.md etc.)
{sandbox_dir}/SOUL.md    (Agent Persona Prompt sidecar, if agent identity present)
{sandbox_dir}/.claude/settings.json + hooks/check-docs-sync.sh
```

## Context Profiles And Routing Manifest

`context_profiles` is the authority for editable context configuration.
Profiles are scoped by `space`, `project`, `project_folder`, `agent`, or `user`, with
JSON object fields:

- `context_pack_json` — startup/context-pack metadata such as title, notes,
  observation policy, and whether the skill index should be exposed.
- `routing_manifest_json` — explicit routing rules from repo paths to `.agent`
  docs and optional bundle ids.

`ContextPrepareService` loads Space, Project, Project Folder, Agent, and User
profiles for the run, merges them with `DEFAULT_CONTEXT_ROUTING_MANIFEST`, and
passes the effective manifest into `ContextCompiler`. The compiler no longer
routes by legacy Python basenames such as `models.py`, `schemas.py`, or
`context_builder.py`; it matches explicit path globs such as
`server/src/modules/context/**`, `server/src/gateway/routeRegistry.ts`,
`packages/protocol/src/**`, and `apps/web/src/modules/**`.

Routing manifests may only reference `.agent/*.md|yaml|yml` paths. Absolute
paths, `..`, and non-`.agent` docs are ignored/rejected by the manifest
normalizer. The generated `AGENTS.md`, `CLAUDE.md`, generated runtime skill
files, and hook files remain adapter outputs written into the sandbox only. They
are not an import path back into Memory, Knowledge, Capability, or the real
Project Folder.

## Explicit artifact attachments

`POST /api/v1/context/build` and managed run creation accept
`context_artifact_ids` (max 8). `PgRunContextRepository.selectArtifactAttachments`
resolves the selected artifacts for the current Space/User and only allows
bounded evidence packs from these artifact types:

- `retrieval_brief`
- `retrieval_eval_report`
- `retrieval_explain_report`
- `retrieval_maintenance_report`
- `memory_maintenance_report`

The repository verifies artifact visibility and project access, renders a
bounded summary, preserves a domain label, and marks the pack as
`content_mode = "bounded_summary"` with
`raw_artifact_content_included = false`. Missing, hidden, unsupported, or
project-inaccessible artifacts become blocked attachment entries with rejection
reasons. Approved and blocked entries are recorded in `ContextPackage.attachments`
and `ContextSnapshot.source_refs_json` / `retrieval_trace_json`; approved
artifact evidence-pack refs are also included in
`ContextSnapshot.included_evidence_refs_json` so audit consumers that track
"what entered context" do not miss explicit artifact packs.

`ContextPrepareService` appends approved attachments to the dynamic tail used by
managed runs. The stable prefix/digest layer does not consume attachments, and
retrieval results are never silently injected without explicit artifact ids.
Run creation performs an early visibility/type/project check for selected
artifact ids, but prepare-time revalidation remains authoritative because
artifact visibility can change while a run is queued. `/context/build` validates
the response with `ContextPackageSchema` before returning it.
Past snapshots are immutable audit records; future-run removal is represented by
not selecting the artifact id for the next context build.

Attachment content is intentionally a summary surface. `retrieval_explain_report`
attachments render selected aggregate fields such as diagnostic codes, target
type/status/returned state, score/rank, matched fields, and short reasons; they
do not stringify the stored target/match JSON. `retrieval_brief` attachments can
include the saved brief query/answer because selection is explicit and
owner/user-visible, so callers should treat attached brief metadata as
model-visible context.

## ContextDigest cache layer

`ContextPrepareService` tries to load active `ContextDigest` rows before rendering the stable prefix.

- A digest is only injected as a `[digest:<type>:v<N>]` block in `stable_prefix` (replacing direct policy/memory rendering for that section) when it is **usable**: for project_folder/agent memory digests, the run agent's `readable_scopes` includes that scope **and** it is `active` **and** every claimed `source_memory_ids_json` entry still passes live revalidation for its scope (same space + scope, active, undeleted, shared, non-`highly_restricted`).
- A digest is **dropped** (and its scope falls back to direct `MemoryRetriever` / direct active policies) when it is missing, out-of-scope for the agent's `readable_scopes`, `dirty`, or — for memory digests — has any stale/ineligible claimed source. The cached summary is a blended, non-redactable artifact, so a single stale source drops the whole digest. This is the read-side fail-safe: it prevents a pending change, a stale/tampered row, or a `readable_scopes` bypass (the digest is a derived view of the same memory the retriever gates) from leaking content into the prompt.
- Project_folder/agent digests cover only cache-safe shared memory. Per-user gated memory that is visible for the current run is still rendered directly and is not folded into the shared digest.
- `ContextSnapshot.source_refs_json` includes `context_digest` entries (recording `source_memory_ids`, `source_policy_ids`, `source_relation_ids`) **only for usable digests** — a dropped digest contributes no trace, so refs never record unvalidated or leaked source ids. Digest does not replace source traceability.
- `ContextSnapshot.retrieval_trace_json` records `digest_used`, `digest_types`, `digest_versions`, `digest_dropped` (`[{digest_type, reason}]` with reason `dirty`|`stale_source_memory`|`scope_not_readable`), `digest_missing_types`, and `fallback_to_memory_retriever`.
- Digest source memory injection writes memory access logs only for the revalidated source ids of usable digests that were not already logged by the per-run retriever.
- Execution is never blocked by a missing, dirty, or dropped digest — it falls back to direct rendering.

### ContextDigest principles
- `ContextDigest` is a derived cache — not Memory, not Policy, not a source of truth.
- Digest does not create Proposal. Digest can be deleted and regenerated.
- Digest summarises active approved Memory/Policy only (no unapproved proposal content).
- Supported `digest_type` values: `policy_bundle`, `project_folder`, `agent`.
- Personal Radius / external sources are out of scope.

### Digest scoping, invalidation & lifecycle
- Digests are **peer-level**: each digest summarises exactly one scope and never folds another level in. `policy_bundle` holds all active space policies; `project_folder`/`agent` hold only that scope's own active memory. A policy is never embedded in project_folder/agent digests, and agent config (system prompt, model, policies) is never embedded in the agent digest — those reach a run directly at consumption time, where `loadDigestBundle` assembles `policy_bundle + project_folder + agent` for the run.
- Project_folder/agent digests are **shared-only**: `loadScopeMemories` filters
  `visibility = 'space_shared'` and applies project_folder scope separately. It
  excludes `highly_restricted`; private and selected-user memory never enters a
  cache-shared bundle.
- Invalidation is **content-driven**: only a change to a digest's own content marks it dirty. A memory change marks its own scope's project_folder/agent digest (via `affectedDigestTargets`); a policy change marks only `policy_bundle`. Triggers that do not alter a digest's content must not mark it dirty (a no-op refresh).
- Dirty-marking takes the **same** per-digest `pg_advisory_xact_lock` key as generation (`digestLockKey.*`), inside the proposal-apply transaction. This serializes mark-vs-refresh: otherwise a refresh that already read the old sources could observe the freshly-marked-dirty row, find its `source_hash` unchanged against the stale read, and flip it back to `active` — resurfacing a stale digest as injectable.
- `POST /api/v1/context/digests/refresh` has two modes: an **explicit** body `{scope_type, digest_type, scope_id?}` generates/bootstraps that one digest (creating the first version if none exists); an **empty** body runs `refreshAllDirty`, which only re-generates already-dirty digests and does not bootstrap. Use the explicit form to create a space's first digest. Missing digests are otherwise created lazily by the `context_digest_refresh` job enqueued on the first relevant change.
- Lifecycle: when a scope is archived (`DELETE /api/v1/projects/{projectId}/folders/{folderId}` soft-archives), the archive status update and the `disabled`-ing of its `active`/`dirty` digests run in **one transaction**, so a failure to disable rolls back the archive (never leaves an archived scope with a loadable digest). Generation locks the scope row `FOR UPDATE` and re-checks `status='active'` before insert, so it cannot race the archive into re-creating an `active` digest for an archived scope. Agents currently have no delete path. Disabling frees the `uq_context_digests_current_scope` slot.

## Invariants
- Vendor files are never written to the real Project Folder
- Markdown/vendor files are not authoritative memory or routing state; DB
  profiles and approved Memory/Knowledge/Capability rows are authoritative
- Changes agents make to generated files do not propagate to active memory
- Compiled content (prefix + tail) is stored in `ContextSnapshot` columns for audit
- Snapshot population failure blocks adapter execution
- Missing digest never blocks execution; populator falls back gracefully

## Related Files
- `server/src/modules/context/compiler.ts`
- `server/src/modules/context/prepareService.ts`
- `server/src/modules/context/profiles.ts` — `context_profiles` repository and HTTP shape helpers
- `server/src/modules/context/routingManifest.ts` — default TS/web routing, merge, and doc-path validation
- `server/src/modules/context/digestService.ts` — digest generation, dirty-marking, scope-disable
- `server/src/modules/memory/` — memory read auth and context logs
- `server/migrations/` — `ContextSnapshot`, `ContextDigest`, `context_profiles`
- `server/src/modules/runs/` — run context preparation integration
- `.agent/context-bundles.yaml`

## Related Decisions
- [0004-context-wrapper.md](../decisions/0004-context-wrapper.md)
