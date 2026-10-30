# Artifacts

Artifacts are durable managed records for run output, operational intermediates,
and system archives. They are an audit/export boundary, not the primary reading
model for domain reports. User-facing structured documents such as Project
Research Reports are materialized into their owning domain and opened with the
shared Reader.

`surface_role` makes the product boundary explicit: `user_output`,
`operational`, or `system_archive`. Ordinary `GET /api/v1/artifacts` lists omit
`system_archive`; audit callers may request `include_system_archives=true`, and
known IDs remain readable/exportable under normal access policy.

An `Artifact` records its production context with `artifacts.run_id` when it was
produced by a run. Task attachment is a separate product relationship:
`task_artifacts` links a task to selected artifacts as output, evidence, or other
task-level material. `task_artifacts.run_id` is the task attachment's run context
when the attachment is tied to a task run; `artifacts.run_id` remains the
artifact's producing run. They usually match for run-produced task output, but
manual or reused attachments can keep the task attachment run null while the
artifact's production context remains unchanged.

## Product API

- The server owns the client-facing artifact read/export
  routes:
  - `GET /api/v1/artifacts`
  - `GET /api/v1/artifacts/{artifact_id}`
  - `GET /api/v1/artifacts/{artifact_id}/export`
- Artifact reads are scoped by space identity and artifact visibility.
  `access_level=summary` returns metadata without inline content; export
  requires effective `full` and 404s otherwise.
- Project-Folder-scoped `space_shared` artifacts store `artifacts.project_folder_id`.
  List accepts an optional `project_folder_id` query and, when present, filters
  on that column. Detail and export authorize from the artifact row through the
  content-read predicate and the room-run read check. A folder id supplied by
  the caller is not required and is not compared to the row. The content-read
  predicate still applies the artifact's own folder: personal-space Project
  Folders are readable inside the personal space; shared-space Project Folders
  are readable through linked Projects where the user is the project owner or
  an active project member. Project Folders with no readable linked Project
  fail closed for non-owner reads.
- Export returns inline artifact content when present, or a file download from
  managed artifact storage when `storage_path` is present.
- Artifact Detail exposes identity, scope, permissions, producing Run, storage
  provenance, and export. It does not act as a domain report renderer.
- Browser export keeps the response status for access-refusal handling and
  checks the requesting session before accepting the response and again before
  saving the file. Logout or cancellation prevents a late response from
  triggering a download.
- List and detail Export controls follow `exportable`. An export refusal
  clears stale data and rereads the current metadata: summary-only content can
  remain visible with Export disabled, while a revoked object shows the
  not-found/not-accessible state. A transient detail read failure has its own
  error state rather than claiming that the object is missing.

## Sources

- Content-backed artifacts come from `output_json.artifacts`.
- File-backed artifacts come from `produced_artifact_paths`.
- Plain run `output_text` is display/conversation output and does not create an
  Artifact by itself.
- Sources raw snapshots and reader documents are server-produced artifacts.
  `source_reader_document` artifacts use
  `canonical_format="reader_document_json"` and store structured Reader JSON
  with remote image references, not downloaded image binaries.
  Both stay behind their Source item: get, list and export admit a viewer
  only while the Reader would open that item (`sourceDerivedArtifactReadableClause`
  in `sources/sourceItemAccess.ts`), not by the visibility copied onto the
  artifact at capture.
  Inline content and export also require full access to the current origin
  item or snapshot; a snapshot path checks the snapshot's own visibility and
  level as well as its item's. Summary-only origins leave artifact metadata
  readable but withhold the body. Reader document loading applies these same
  origin gates plus the artifact's own full-content and Room gates, so opening
  a document cannot bypass an export refusal.

## Storage Rules

- File artifacts are copied or registered into managed artifact storage.
- The database stores a durable relative storage reference, not a sandbox absolute path.
- Sandbox paths are temporary execution details.
- Artifact records must remain scoped to the owning run and space.
- The server resolves file-backed exports under
  `ARTIFACT_STORAGE_ROOT` (default:
  `$RAINVER_HOME/storage/artifacts`).

## Path Safety

- Unsafe paths are rejected.
- Rejected artifact paths are recorded as `materialization_errors`.
- Path traversal, absolute path input, missing files, and paths outside the allowed runtime output root must not create artifact records.
- Export rejects absolute paths, NUL bytes, path traversal out of managed
  artifact storage, sandbox-root reads, missing paths, and non-regular files.
