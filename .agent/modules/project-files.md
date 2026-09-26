# Module: Files & Code (Project Folders)

## Status
Implemented. Files & Code is a Project-local Area, not a global operator console.

The shipped full-file editor, recovery drafts, and message-owned lazy input
resources are recorded in [ADR 0021](../decisions/0021-files-code-codemirror-drafts-and-input-resources.md).
This module guide describes the post-integration behavior.

## Purpose
Project-local interface for browsing and editing a Project Folder's files with CodeMirror 6,
recovering unsaved human drafts, reviewing git status/diffs, and restoring history into a draft.
All file access goes through server-side repositories — the frontend never accesses the host
filesystem directly.

## Owns
- Project Folder file tree browser UI (`/projects/{projectId}/files`)
- Git status and diff viewer UI
- Project Folder settings UI (`/projects/{projectId}/folders/{folderId}`), including
  per-Folder snapshot retention overrides
- Files & Code backend read APIs (tree, file content, git status, git diff)
- Files & Code draft/save/revision APIs (the only human write path is Save to Folder)
- CodeMirror editor lifecycle, draft autosave controller, and contextual history/restore UI
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
GET        /api/v1/projects/{projectId}/folders/{folderId}/file?path=...&convert=utf8 (explicit UTF-16 preview)
GET/PUT    /api/v1/projects/{projectId}/folders/{folderId}/file/draft?path=...
POST       /api/v1/projects/{projectId}/folders/{folderId}/file/draft/rebase
POST       /api/v1/projects/{projectId}/folders/{folderId}/file/draft/discard
POST       /api/v1/projects/{projectId}/folders/{folderId}/file/draft/save
GET        /api/v1/projects/{projectId}/folders/{folderId}/drafts/quota
GET        /api/v1/projects/{projectId}/folders/{folderId}/file/revisions?path=...
POST       /api/v1/projects/{projectId}/folders/{folderId}/file/revisions/restore-as-draft
GET        /api/v1/projects/{projectId}/folders/{folderId}/file/revisions/{revisionId}/preview
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
  Files & Code edits a bounded text file in a recovery draft; Save to Folder
  stores the preimage in `project_file_revisions` and then removes only the exact
  saved draft version. There is no direct browser-content write or user-facing
  rollback route. History offers Restore as draft, which never mutates the
  Project Folder; revision rows and historical status values remain readable for
  compatibility.
- Save to Folder requires the exact draft version and Host existence/hash observed
  by the editor, is atomic, rejects traversal/symlink escapes and secret-like
  paths, and is capped at 1 MiB, matching the File-page read limit.
- Drafts are private recovery rows owned by the authenticated Project writer:
  opening a file creates none, the first changed document upserts one bounded
  row, and a successful Save to Folder deletes only the exact saved version.
  Draft reads/upserts/discards use optimistic versions, a 1 MiB item cap, a
  50 MiB per-space/user aggregate cap, and rolling expiry; they are not a
  global draft list. Unregister reports active-draft counts before requiring
  explicit confirmation and removes confirmed rows in the same transaction.
- A writable file is always an editable CodeMirror 6 view. The first document
  change starts the serial 1.5-second idle / 10-second maximum-age draft queue;
  blur, file switch, Folder switch, and Cmd/Ctrl+S flush the same queue. A
  saved draft is safe to leave in the browser; only unacknowledged in-memory
  changes trigger the navigation warning.
- File admission is strict and byte-honest. UTF-8 (including BOM and LF/CRLF
  metadata) is writable; mixed endings are reported; UTF-16 BOM files are
  read-only until the explicit `convert=utf8` preview action; malformed or
  binary/unknown bytes, including NUL-containing UTF-8, return an empty
  read-only body rather than replacement characters or guessed encoding.
- Files & Code tree/file/status/diff reads enforce `project_folder.read` before data is returned.
- The active remote Location is authorized on the server (including an audit
  record with `host_id`) and served live over the `folder_read` channel by the
  owning daemon; the daemon applies the shared `@rainver/folder-read`
  containment, forbidden-path, and size limits.
- Remote File-page writes use the same authenticated Host connection through a
  bounded `folder_write` / `folder_write_result` exchange. The server sends only
  the Location id and relative path; the daemon resolves the registered root,
  applies the shared write policy, and returns the resulting SHA-256. UTF-16
  replacement is accepted only for the explicit conversion flow, and failed
  saves restore the preimage in its original encoding.
- Conversation current-file references reuse the same Project Folder
  authorization and `getFile` path/secret policy. The Files sidecar sends only
  saved/draft state metadata (including the exact draft version or body hash,
  location, and selection); it never sends the body. A saved attachment is
  described by its decoded UTF-8 body rather than the bytes on disk, so a
  BOM-marked file attaches unchanged; a converted UTF-16 preview has no saved
  body on the Host and is attachable only as an acknowledged draft. The message
  transaction freezes the bounded UTF-8 bytes into an immutable, message-owned
  resource.
  Normal and retry Runs receive only its descriptor and read it lazily through
  the governed `input_resource.read/search` actions; no Host temporary file,
  generic database URL, or prompt-embedded body is used. Legacy
  `conversation_file_snapshots` remain readable and are hydrated only by their
  compatibility paths. The shared composer still searches authorized Folder
  trees through `GET /api/v1/sessions/{sessionId}/input-files` for explicit
  path references; that search is not a second resource index.
- An attached immutable resource is the authoritative input state for its Run.
  For `source_state=draft`, the runtime instruction requires the Agent to read
  the complete resource before reading or changing the same relative path and
  to use that acknowledged draft, not the older workspace file, as its
  baseline. This does not promote the draft to the Folder or grant the Agent a
  live-draft write path; external Folder changes continue to trigger the normal
  draft conflict protection.
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
