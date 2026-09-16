# Module: Files & Code (Project Folders)

## Status
Implemented. Files & Code is a Project-local Area, not a global operator console.

## Purpose
Project-local interface for browsing and directly editing a Project Folder's files, reviewing git
status/diffs, and rolling back a user's recent edit. All file access goes through server-side
repositories — the frontend never accesses the host filesystem directly.

## Owns
- Project Folder file tree browser UI (`/projects/{projectId}/files`)
- Git status and diff viewer UI
- Project Folder settings UI (`/projects/{projectId}/folders/{folderId}`), including
  per-Folder snapshot retention overrides
- Files & Code backend read APIs (tree, file content, git status, git diff)
- Files & Code direct user write/revision APIs (create, edit, revision list, rollback)
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
POST       /api/v1/projects/{projectId}/folders/{folderId}/file
GET        /api/v1/projects/{projectId}/folders/{folderId}/file/revisions?path=...
POST       /api/v1/projects/{projectId}/folders/{folderId}/file/rollback
GET        /api/v1/projects/{projectId}/folders/{folderId}/git/status
GET        /api/v1/projects/{projectId}/folders/{folderId}/git/diff?path=...
GET/POST/PATCH /api/v1/projects/{projectId}/folders/{folderId}/execution-config
```

## Invariants
- One Project owns zero or more Project Folders; one Folder belongs to exactly one Project
  (`project_folders.project_id` is a direct, non-null, single-owner FK — no link table, no
  Folder role vocabulary).
- A newly created managed Project Folder is initialized as an empty Git repository before
  it is registered, so later file creates/edits appear in Files & Code's Git status. Clone
  already provides a repository; Connect existing and paired-host registration preserve the
  directory's existing Git state and do not initialize it implicitly.
- A registered Project Folder is a shared workspace with no personal area and
  follows Project authority. A Conversation's Primary and explicitly attached
  Workspace Locations are mounted with their persisted read/write grant on the
  selected Host; personal material belongs in database-backed personal
  content. There are no file-level ACLs because the external filesystem remains
  mutable outside the application. File-page writes are limited to Project writers and
  the active Location; a remote Location additionally requires its owning user
  and an online paired Host.
- Frontend must not access arbitrary server paths — all file access via
  `PgProjectFolderRepository` / `PgRunSandboxManager`.
- Agent code changes still use the `code_patch` proposal flow. A person using
  Files & Code may create or edit a bounded text file directly; each successful
  write stores the preimage in `project_file_revisions` for a bounded, optimistic
  rollback. Direct writes do not create a proposal or enter proposal review.
- Direct writes require the exact file existence/hash observed by the editor,
  are atomic, reject traversal/symlink escapes and secret-like paths, and are
  capped at 1 MiB, matching the File-page read limit. Rollback stops with a stale-file conflict if the file changed
  after the saved revision.
- Files & Code tree/file/status/diff reads enforce `project_folder.read` before data is returned.
- The active remote Location is authorized on the server (including an audit
  record with `host_id`) and served live over the `folder_read` channel by the
  owning daemon; the daemon applies the shared `@rainver/folder-read`
  containment, forbidden-path, and size limits.
- Remote File-page writes use the same authenticated Host connection through a
  bounded `folder_write` / `folder_write_result` exchange. The server sends only
  the Location id and relative path; the daemon resolves the registered root,
  applies the shared write policy, and returns the resulting SHA-256.
- Conversation file references reuse the same Project Folder authorization and
  `getFile` path/secret policy. A send stores a bounded UTF-8 snapshot plus
  Folder/Location ids and a digest; a normal Run sends only a server-issued
  ResourceLink and the Folder-relative path, while a manual retry hydrates the
  immutable snapshot. The Host resolves the server-issued relative reference
  against the launch's explicit Location access set. Once a
  Conversation execution context is initialized, its shared composer searches
  through `GET /api/v1/sessions/{sessionId}/input-files`, which searches only
  the bounded trees of that session's Primary and active attached Folders. A
  pre-initialization draft may use the same bounded tree reads to show the
  context picker, but neither path provides a separate file index or an
  arbitrary-path browser search. File reads expose the digest of the exact
  returned bytes so the browser can pin a send reference without sending file
  content back as a request field.
- A conversation's Changes card resolves the exact `remote_diff` Artifact
  attached to the completed Host Run, including managed-workspace Runs. It is
  a read-only link to the Run's captured output; `Files & Code` remains the
  Project's current tree/status/diff view and is not an approval or commit
  surface.
- When a Conversation turn stream settles, the shared browser surface notifies
  Files & Code about its authorized Project Folders. A mounted Files page
  refreshes the matching tree and Git status immediately; it does not replace a
  file editor's in-progress content.
- Selecting a file starts its content and revision-history reads together. The
  content viewer renders as soon as the file bytes arrive; revision history is
  supplementary and never adds a second blocking loading round trip. While a
  subsequent file is loading, the current view remains visible with a subtle
  progress indicator, and stale file responses cannot replace the latest selection.
  Content already opened in the current Folder view is shown immediately on a
  later return while the server revalidates it in the background; Folder content
  change notifications clear that in-memory cache.
- Folder listing is Project-scoped and does not create one policy record per row.
- Changing the Folder selector changes only the Files & Code view. An already-open
  conversation remains pinned to its original Folder/execution context; the page
  shows a dismissible status hint after a manual switch, and the user must start
  a new conversation or explicitly Attach the new Folder to use it there.
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
  `PgRunSandboxManager`, direct file revision store, code-patch collector/applier
- `packages/folder-read/` — shared tree/file/Git reads and PathPolicy used by
  both the server-host path and the paired host daemon
- `server/src/modules/projectFolderExecutionConfigs/` — execution-config routes
- `apps/web/src/modules/project_files/` — Files & Code and Folder settings pages
