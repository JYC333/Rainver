# Artifacts

Date: 2026-06-16

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
- Project-Folder-scoped `space_shared` artifacts require `artifacts.project_folder_id`. Non-owner
  list/read/export access must provide matching Project Folder context and pass the
  Project-inherited Project Folder ACL: personal-space Project Folders are readable inside
  the personal space; shared-space Project Folders are readable through linked
  Projects where the user is the project owner or an active project member.
  Project Folders with no readable linked Project fail closed for non-owner reads.
- Export returns inline artifact content when present, or a file download from
  managed artifact storage when `storage_path` is present.
- Artifact Detail exposes identity, scope, permissions, producing Run, storage
  provenance, and export. It does not act as a domain report renderer.

## Sources

- Content-backed artifacts come from `output_json.artifacts`.
- File-backed artifacts come from `produced_artifact_paths`.
- Plain run `output_text` is display/conversation output and does not create an
  Artifact by itself.
- Sources raw snapshots and reader documents are server-produced artifacts.
  `source_reader_document` artifacts use
  `canonical_format="reader_document_json"` and store structured Reader JSON
  with remote image references, not downloaded image binaries.

## Storage Rules

- File artifacts are copied or registered into managed artifact storage.
- The database stores a durable relative storage reference, not a sandbox absolute path.
- Sandbox paths are temporary execution details.
- Artifact records must remain scoped to the owning run and space.
- The server resolves file-backed exports under
  `ARTIFACT_STORAGE_ROOT` (default:
  `$AGENT_SPACE_HOME/storage/artifacts`).

## Path Safety

- Unsafe paths are rejected.
- Rejected artifact paths are recorded as `materialization_errors`.
- Path traversal, absolute path input, missing files, and paths outside the allowed runtime output root must not create artifact records.
- Export rejects absolute paths, NUL bytes, path traversal out of managed
  artifact storage, sandbox-root reads, missing paths, and non-regular files.
