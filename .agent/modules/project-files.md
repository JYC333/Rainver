# Module: Files & Code (Project Folders)

## Status
Implemented. Files & Code is a Project-local Area, not a global operator console.

The editor, recovery drafts, and message-owned lazy input
resources are recorded in [ADR 0021](../decisions/0021-files-code-codemirror-drafts-and-input-resources.md).
This module guide describes the current behavior.

## Purpose
Project-local interface for browsing and editing a Project Folder's files with CodeMirror 6,
recovering unsaved human drafts, reviewing git status/diffs, and restoring history into a draft.
All file access goes through server-side repositories — the frontend never accesses the host
filesystem directly.

## Owns
- Project Folder file tree browser UI (`/projects/{projectId}/files`)
- Git status and diff viewer UI. A status whose file list was cut
  (`GitStatus.truncated`, from the bounded `git status` read in
  `@rainver/folder-read`) is shown as the first files of an incomplete list,
  never as a clean or complete working tree.
- Project Folder settings UI (`/projects/{projectId}/folders/{folderId}`), including
  per-Folder snapshot retention overrides
- Files & Code backend read APIs (tree, file content, git status, git diff)
- Files & Code draft/save/revision APIs (the only human write path is Save to Folder)
- File tabs with individual close controls, CodeMirror editor lifecycle, draft autosave controller, and contextual history/restore UI
- Project Folder CRUD (create via managed dir / clone / connect existing, update, archive,
  unregister, scan)

## Does Not Own
- Run sandbox provisioning. Run preparation calls `projectFolders/sandbox.ts`; it is not a Files & Code write.
- Proposal storage (proposals module)
- Memory display (memory module)
- Agent run dispatch (agents module)
- Interactive agent-session execution over a Folder

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
GET        /api/v1/projects/{projectId}/folders/{folderId}/locations
POST       /api/v1/projects/{projectId}/folders/{folderId}/locations/{locationId}/activate
POST       /api/v1/projects/{projectId}/folders/{folderId}/unregister
POST       /api/v1/projects/{projectId}/folders/scan
GET        /api/v1/projects/{projectId}/folders/{folderId}/tree?path=...&offset=...
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
- The Files & Code browser loads only the root's direct entries initially;
  child directories start collapsed and load on expansion. Each directory is
  independently paged at 500 entries, with an explicit Load more control when
  `next_offset` is present. A nested subtree never spends its parent's listing
  budget. Loaded children are reused until the tree is refreshed; failures can
  be retried. Browse refreshes and Folder switches discard the loaded tree.
- Tree visibility uses exclusions, not a dotfile allowlist: ordinary dotfiles
  and directories such as `.agent` are visible. Dependency/build/Git internals
  in `IGNORE_DIRS`, symbolic links, and PathPolicy-forbidden paths are omitted.
  Directory enumeration holds a safely opened directory handle throughout the
  read. PathPolicy and Project/Host authorization still apply to each expansion.
  The host `tree` request with `path` (including `.`) and optional `tree_offset`
  returns one directory page. Internal conversation file search omits `path`
  and continues to use the bounded recursive tree (500 entries, five levels).
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
- Agent code changes use the `code_patch` proposal flow. A person using
  Files & Code edits a bounded text file in a recovery draft; Save to Folder
  stores the preimage in `project_file_revisions` and then removes only the exact
  saved draft version. There is no direct browser-content write or user-facing
  rollback route. History offers Restore as draft, which never mutates the
  Project Folder; it answers the draft store's refusals as Save does (409
  `draft_version_conflict`, 413 `draft_quota_exceeded`), will not take the
  person's one new-file draft slot while an unsaved new file holds it, and
  refuses a revision larger than a draft may be. Revision rows stay readable,
  including their stored status values.
- A file read (`readFolderFile` in `@rainver/folder-read`, used by the server
  for a local Location and by the daemon for a remote one) validates the path
  lexically with `PathPolicy` once and then never uses the name again: the
  file is opened through `openFileBeneathRoot` (`safeOpen.ts`), which makes
  the kernel resolve every component below the trusted, canonicalised root
  without following links — on Linux by opening each directory
  `O_NOFOLLOW` relative to its parent's `/proc/self/fd` handle, on macOS with
  a single `O_NOFOLLOW_ANY` open — and the type check, the size check and
  the bytes all come from that one handle. Any symbolic link below the root,
  final or ancestor, inside or outside, is refused (`path_forbidden`); FIFOs,
  devices and other non-regular files are refused without blocking; at most
  `MAX_FILE_BYTES + 1` bytes are read so a file that grows under the read is
  still `too_large`. Each mechanism is proved once per process with a
  linked fixture before first use; a platform where the proof does not hold
  (Windows, or a kernel that ignores the flag) answers every file read with
  `unsupported_platform` (503) rather than falling back to a path-based read.
  Windows hosts therefore cannot serve Files & Code reads until a race-free
  open exists for them. The tree walk `lstat`s each entry so a link that
  appeared after `readdir` is left out rather than described.
- Server `code_patch` apply, snapshot restore and failure rollback open each
  directory component the same way and operate relative to its
  Linux `/proc/self/fd` handle. Replacing a parent path with a link cannot
  redirect the file operation. All symlink components are refused (422);
  non-Linux server patching fails closed (503). Existing executable modes are
  preserved. These operations do not turn the external filesystem into a
  database transaction or prevent another writer from changing file content.
  [fs-native-extensions](https://github.com/holepunchto/fs-native-extensions)
  offers advisory locks but no directory-relative open API, so no native
  dependency is added for either purpose-specific open.
- A clone (`repo_url` on Folder creation) accepts only an `https://` URL and
  runs `git clone` through a per-clone loopback CONNECT proxy
  (`startGuardedConnectProxy` in `@rainver/outbound-guard`) that resolves
  every host git asks for — the first and each redirect — through the
  instance's outbound guard and dials only the pinned address, so a name that
  resolves or redirects into the instance's own network is refused at that
  hop. `ssh://`, `git://`, `http://`, scp-like and local sources are refused
  with a message pointing at the two supported ways to bring in a private
  repository: connect an existing directory, or register it through a paired
  host. Credentials pasted into the URL are redacted from the failure text.
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
- Existing files show their path as selectable read-only text, with the full
  path available on hover; only new files offer a path input. The path display
  is not a rename control.
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
  generic database URL, or prompt-embedded body is used.
  A `file_reference` part freezes its text in `conversation_file_snapshots`.
  Do not treat that table as unused. The shared composer searches authorized Folder
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
- Files and Notes share the `DocumentTab` silhouette and existing tab-strip
  styling. File tabs size to the complete filename without ellipsis, with room
  for italic overhang; the strip scrolls horizontally when needed. Notes keep
  their existing bounded tab widths. The silhouette keeps fixed-width curved ends and stretches only its straight
  middle, so long filenames and close controls remain inside the outline.
  Each segment has an independently positioned SVG viewport matching the tab's
  height; the middle ends at the cap boundary so its fill cannot cover the curve.
  The file toolbar uses the shared control sizes; size, encoding and
  line-ending details live in a bottom status bar. CodeMirror uses application
  color tokens and a color-mode compartment from the global Theme Context,
  including conflict comparisons. Theme changes preserve edits, selection and
  undo history; the code surface retains its monospace font and line numbers.
- A single click opens a file in one reusable preview tab (italic title); clicking
  another unopened file replaces that preview. Double-clicking a file or its
  tab fixes it in place. Middle-click and the file-only context menu's Open in
  new tab action open a fixed internal tab. Already-open files are selected
  without duplication. Editing a preview automatically fixes it in place.
  Folder and other browser context menus remain unchanged. Closing an
  inactive tab leaves the editor alone; closing the active tab selects a
  neighboring file, or an empty editor after the last tab. Switching and closing
  flush recovery drafts first and refuse to leave unacknowledged changes on a
  failed flush. Folder switches clear the open tabs. The current-file reference
  appears immediately above the sidecar message input, beside its attachments,
  rather than above the transcript.
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
- Secret-like diff values are redacted. Diffs touching secret-like paths are denied;
  a whole-Folder diff is denied when any file it shows would be refused by PathPolicy
  as a single-file read.
- A file revision preview returns the file's former body, so it is a `file` read of
  the Location the revision came from: `project_folder.read` policy and audit, and
  for a paired Host only that Host's owner.
- `resource_space_id` for policy enforcement comes from the actual Project Folder row,
  not caller-supplied input.
- Archiving a Folder disables new Folder-backed execution but never touches disk.
  Unregistering removes only the registration row; it also never touches disk.
  A Folder that Runs, Activity, Proposals, Rooms or other records still reference
  keeps its row: unregister answers 409 `project_folder_in_use`, and archiving is
  the way to retire it.

## Related Files
- `server/src/db/schema/projectFolders.ts` — Project Folder + execution-config schema; access derives from Space/Project authority
- `packages/protocol/src/` — Project Folder DTOs when shared
- `server/src/modules/projectFolders/` — routes, `PgProjectFolderRepository`,
  `PgRunSandboxManager`, direct file revision store, code-patch collector/applier
- `packages/folder-read/` — shared tree/file/Git reads and PathPolicy used by
  both the server-host path and the paired host daemon
- `server/src/modules/projectFolderExecutionConfigs/` — execution-config routes
- `apps/web/src/modules/project_files/` — Files & Code and Folder settings pages

## Opening a file from a reply

`/projects/{projectId}/files?folder={folderId}&path={relativePath}&line={line}`
opens that file through the ordinary selection path, including draft flushing,
stale-read fencing and error handling. A supplied Folder is also selected when
Files & Code was already mounted. The optional line focuses the editor without
changing its text. Conversation links are resolved through the producing
Run's file-preview API before navigation; the server never uses a model's
absolute path to read outside the authorized registered workspace. Raster
image links open the conversation preview dialog instead of the text editor.
