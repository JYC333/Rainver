# Module: Files & Code (Project Folders)

## Status
Implemented. Files & Code is a Project-local Area, not a global operator console.

## Purpose
Project-local interface for browsing a Project Folder's files, reviewing git status/diffs, and
approving proposals over its changes. All file access goes through server-side repositories —
the frontend never accesses the host filesystem directly.

## Owns
- Project Folder file tree browser UI (`/projects/{projectId}/files`)
- Git status and diff viewer UI
- Project Folder settings UI (`/projects/{projectId}/folders/{folderId}`), including
  per-Folder snapshot retention overrides
- Files & Code backend read APIs (tree, file content, git status, git diff)
- Project Folder CRUD (create via managed dir / clone / connect existing, update, archive,
  unregister, scan)

## Does Not Own
- Sandbox creation (sandbox module)
- Proposal storage (proposals module)
- Memory display (memory module)
- Agent run dispatch (agents module)
- Interactive agent-session execution over a Folder — never implemented, not planned

## UI Routes

```
/projects/{projectId}/files                — file tree + git status/diff (Folder picker)
/projects/{projectId}/folders/{folderId}    — Folder info + snapshot settings
```

## Backend API

```
GET/POST   /api/v1/projects/{projectId}/folders
GET/PATCH  /api/v1/projects/{projectId}/folders/{folderId}
DELETE     /api/v1/projects/{projectId}/folders/{folderId}
POST       /api/v1/projects/{projectId}/folders/{folderId}/unregister
POST       /api/v1/projects/{projectId}/folders/scan
GET        /api/v1/projects/{projectId}/folders/{folderId}/tree?path=...
GET        /api/v1/projects/{projectId}/folders/{folderId}/file?path=...
GET        /api/v1/projects/{projectId}/folders/{folderId}/git/status
GET        /api/v1/projects/{projectId}/folders/{folderId}/git/diff?path=...
GET/POST/PATCH /api/v1/projects/{projectId}/folders/{folderId}/execution-config
```

## Invariants
- One Project owns zero or more Project Folders; one Folder belongs to exactly one Project
  (`project_folders.project_id` is a direct, non-null, single-owner FK — no link table, no
  Folder role vocabulary).
- A registered Project Folder is a shared workspace with no personal area. The
  whole Folder follows Project authority and is mounted read-only into CLI
  sandboxes; personal material belongs in database-backed personal content.
  There are no file-level ACLs because the external filesystem remains mutable
  outside the application.
- Frontend must not access arbitrary server paths — all file access via
  `PgProjectFolderRepository` / `PgRunSandboxManager`.
- File browsing is always read-only for the UI; writes go through the agent + proposal flow
  (`code_patch` proposals).
- Files & Code tree/file/status/diff reads enforce `project_folder.read` before data is returned.
- The active remote Location is authorized on the server (including an audit
  record with `host_id`) and served live over the `folder_read` channel by the
  owning daemon; the daemon applies the shared `@rainver/folder-read`
  containment, forbidden-path, and size limits.
- Folder listing is Project-scoped and does not create one policy record per row.
- PathPolicy validates all requested paths and blocks traversal plus secret-like paths such
  as `.env*` except committed env templates (`.env.*.example`, `.env.sample`, `.env.template`), private keys,
  `.ssh`, `.aws`, and secrets directories.
- Git operations must be scoped to the Folder root; no `..` traversal allowed.
- Full git diff output is bounded. Full diff, protected-Folder, external-root,
  protected/restricted, and secret-like read attempts force policy audit records.
- Secret-like diff values are redacted. Diffs touching secret-like paths are denied.
- `resource_space_id` for policy enforcement comes from the actual Project Folder row,
  not caller-supplied input.
- Archiving a Folder disables new Folder-backed execution but never touches disk.
  Unregistering removes only the registration row; it also never touches disk.

## Related Files
- `server/src/db/schema/projectFolders.ts` — Project Folder + execution-config schema; access derives from Space/Project authority
- `packages/protocol/src/` — Project Folder DTOs when shared
- `server/src/modules/projectFolders/` — routes, `PgProjectFolderRepository`,
  `PgRunSandboxManager`, code-patch collector/applier
- `packages/folder-read/` — shared tree/file/Git reads and PathPolicy used by
  both the server-host path and the paired host daemon
- `server/src/modules/projectFolderExecutionConfigs/` — execution-config routes
- `apps/web/src/modules/project_files/` — Files & Code and Folder settings pages
