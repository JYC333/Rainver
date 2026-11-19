# Module: Files & Code (Project Folders)

## Status
Implemented. Files & Code is a Project-local Area, not a global operator console.

The editor, recovery drafts, and message-owned lazy input
resources are recorded in [ADR 0021](../decisions/0021-files-code-codemirror-drafts-and-input-resources.md).
This module guide describes the current behavior.

The read-only `CodeMirrorMerge` comparison also supports a unified view for
conversation step diffs. It reuses the installed CodeMirror merge extension
with merge controls disabled; it grants no file-write or draft authority.

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
GET        /api/v1/projects/{projectId}/folders/{folderId}/file/drafts/{draftId}
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
  `writeFolderFile`/`restoreFolderFile` (`packages/folder-read/src/write.ts`)
  check names once and then do every mutation through a pinned parent
  directory, so an Agent swapping a checked directory for a link cannot
  redirect a person's save: on Linux each component is opened (or created
  with `mkdir`) relative to the previous `/proc/self/fd` handle with
  `O_NOFOLLOW`, and the preimage read, exclusive temporary write, recheck,
  rename and removal are relative to the final handle. A link anywhere below
  the root refuses the save, as it already refuses the read. Because a pinned
  handle follows a directory renamed out of the root, every handle in the
  chain stays open and is proved (device/inode against the named entry of the
  one above, and the root against its canonical path) to still hang from the
  root just before and just after the rename or removal; Node has no
  `renameat`, so the window between the two is narrowed, not closed. During
  a save the preimage stays linked under a second private name (a hard link
  to the same inode; a filesystem without hard links refuses the save). A
  move caught by the second proof is undone in the moved directory touching
  only this save's own file, identified by inode after it is moved aside,
  and the preimage goes back with a no-clobber `link`, so its inode and mode
  (for example `0600`) are kept; a removal likewise moves the checked file
  aside and deletes it only once its directory is proved still in the root,
  otherwise linking it back. When another writer replaced or recreated the
  name meanwhile, their file is left alone, the preimage (or removed file)
  is kept under its `.rainver-preimage-`/`.rainver-remove-` name, and the
  save fails with `write_failed` naming it and its directory; a full undo is
  reported as `path_forbidden`. Neither is ever reported as a success, and an
  undo failure is never swallowed. A process killed mid-save can leave such a
  link in the Folder. Folder writes are
  Linux-only: macOS can refuse links in one `open` but Node has no
  directory-relative rename/unlink there, so a pathname rename or removal
  could follow a link swapped in after the check (a restore could delete a
  same-named file outside the Folder). macOS and other platforms therefore
  refuse Save to Folder and restore with an explicit reason; Folder reads on
  macOS are unaffected. Cross-process saves of one file serialize on a
  lock in a per-user `0700` directory under the temp dir and wait at most 30
  seconds. The lock directory always holds exactly one holder entry named by
  a unique token (pid, Linux process start time, random id): it is taken by
  renaming an already-filled candidate onto the lock name, and both release
  and takeover are "unlink this exact token, then `rmdir`", so only one
  process can take over a dead holder and none can remove a lock a live
  holder has since taken. A holder is dead only when its pid is gone or now
  belongs to a process with a different start time; a live holder is never
  taken over by age.
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
- A conversation turn's collapsed Changes summary resolves the exact
  `remote_diff` Artifact attached to each completed Host Run, including
  managed-workspace Runs. It is a read-only link to the Run's captured output; `Files & Code` remains the
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

### Operation-core metadata controls

Folder metadata update, archive, Location activation and execution-config create/
update now share the OperationExecutor with their retained REST adapters. Each
command requires an explicit caller key and returns a strict metadata receipt;
browser helpers read current Folder/Location state in the receipt's Space. Replay
rechecks current Project writer authority and remote Location ownership without
repeating primary selection, activation or configuration writes. Archive and
metadata cleanup remain allowed on archived Projects; activation and configuration
creation/update require an active Project. These commands never touch disk or
contact an execution Host inside the core transaction.

Private draft upsert and explicit rebase share `project.folder.draft.upsert`;
exact-version discard and unregister are separate commands. All four retained
URLs require caller event keys and return metadata-only receipts. Draft receipts
pin the Location and version: a replay cannot write into a newly active Location
or silently acknowledge a later tab's content. The private exact-draft GET checks
the current Project writer and row owner, including for conflict recovery. Conflict
metadata contains only draft IDs/versions, never private text; quota refusal uses
canonical 422 with `draft_quota_exceeded` and numeric quota metadata. Missing-draft
conflicts keep local edits and wait for another user edit, without retrying a write.

Unregister retains explicit active-draft confirmation and history/FK refusal.
Registration, Location and confirmed draft deletion plus required remote cleanup
Jobs commit together. The existing Job worker sends only frozen Host/Location IDs
through `workspace_forget`; it never deletes files. An offline Host defers cleanup
without consuming an attempt. Replay after deletion neither repeats cleanup Jobs
nor affects another registration.

Creation, scanning, Save to Folder and revision restore-as-draft now use four
purpose-specific core commands and their retained REST adapters. Their 202
receipt identifies a private `project_folder_io_intents` row and one required
`project_folder_io` Job; its public payload contains only `intent_id`. The private
owner-only `GET /api/v1/projects/{projectId}/folder-io/{intentId}` returns typed
status/result metadata after current Project/Folder/Host authority checks. The
browser polls that receipt without resubmitting, then reads current Folder/file/
draft content in the receipt Space and pinned Location. A later draft stays open
after saving an older accepted version. No Agent surface, grant or production
approval mapping is added by these Folder controls.

The existing JobWorker owns external IO. Short authority/audit transactions
surround private preparation and final canonical DB writers; external Host/Git/
filesystem effects never run inside a core transaction. The worker shares the
code-patch Folder session gate. It persists frozen source bytes, preimage and
desired hash before writing. Lost acknowledgements resume only from an exact
hash/receipt; an independent edit, changed root or unknown import outcome leaves
`needs_attention` and fences fresh keys for that scope. Known final refusals may
compensate only the recognized written hash and original target identity. An
offline Host defers through the existing queue without consuming an attempt.

Cancelled/exhausted Jobs release an unused request lazily under the next owning
admission only when no write/directory effect was started. Unknown outcomes keep
the recovery fence even after cancellation or revoked authority. Successful and
safely failed transactions clear copied draft/revision/preimage bodies, retaining
only identity/hash/result metadata so these copies cannot bypass source TTLs.
Pending recovery and `needs_attention` retain isolated private materials needed
to establish an exact outcome or explicitly repair it; they are never included
in readable Job payloads, events, contexts or status responses. Automatic replay
does not overwrite independent edits. Migration0016 is generated from Drizzle;
only isolated shared PostgreSQL test databases have applied it in this work.

## Opening a file from a reply

`/projects/{projectId}/files?folder={folderId}&path={relativePath}&line={line}`
opens that file through the ordinary selection path, including draft flushing,
stale-read fencing and error handling. A supplied Folder is also selected when
Files & Code was already mounted. The optional line focuses the editor without
changing its text. Conversation links are resolved through the producing
Run's file-preview API before navigation; the server never uses a model's
absolute path to read outside the authorized registered workspace. Raster
image links open the conversation preview dialog instead of the text editor.

## Isolated Run output

Files & Code continues to browse the registered source Location. New isolated
Conversation output links use `runs/filePreview.ts` and the owning Host's immutable
Git blob reader, scoped to the visible Run and its saved workspace binding.
They do not redirect to the source editor. A pending checkpoint is reported;
missing/unauthorized private output never falls back to the source. Source
preview and legacy contracts keep their established Files & Code behavior.

The existing Run workspace reader also exposes retained unresolved generations
from the same Project conversation, including when its latest Run failed before
receiving a workspace binding. Origin content visibility, remote Host ownership
and current mutation authority still apply. A fresh continuation does not copy or
publish the previous unverified changes; those remain separately recoverable.

For failed integrations in the current writable conversation workspace, launch
instructions include authorized retry IDs and revisions from this same reader.
A later Run can request the existing integration retry without rebinding to the
old change set. Different workspaces/generations and read-only bindings gain no
such authority. Publication still verifies the frozen base-to-source delta and
the contributing context provenance; the original folder's private snapshot is
not part of the delta.

On legacy Hosts/records, an authorized Agent can supply `repair_instruction`
on that same retry to start a repair Run with native file editing in the isolated conflict candidate. It
does not redirect Files & Code or the current conversation's working directory.
The worker uses the requesting Run's runtime and captures only the frozen
conflict paths. Original source files and private baseline stay unchanged;
verification and publication remain system-owned. Human `resolution` is a
separate input and cannot be fabricated by an Agent.


Relative isolated output links resolve only against the canonical launch
receipt's actual primary workspace identity/generation and cwd. A managed primary
with Git attachments does not treat its first attachment as the primary. An
authorized absolute attachment link still uses its immutable checkpoint reader.

### Durable Proposal file decisions (P5-4)

Standalone `code_patch` accept and explicit rollback now record a frozen private
`code_patch_decisions` intent and required `code_patch_decision` Job. HTTP returns
202 with `code_patch_pending` (accept) or a phase/status receipt (rollback), not
an applied-file result. The Proposal stays pending/accepted respectively until
actual effects and the final canonical DB transaction complete. Proposal GET
exposes only the requesting user's sanitized receipt after the existing content/
Room gate; it never exposes persisted preimages, root paths or raw exceptions.
The Review detail page refreshes that receipt and links to the existing Job Queue.
Room cards do not continue the conversation on enqueue.

The worker reuses Evolution's `codePatchEffects` boundary and the same per-Folder
session gate. Short key-first prepared owners surround admission and final commit;
no filesystem operation runs inside those transactions. Preimages are durable
before writing; exact-content resume handles a lost receipt. The canonical
code-patch applier is now receipt-only and remains the single activity/snapshot/
payload/result writer. Explicit rollback restores original binary bytes or removes
originally absent files, uses current authority and snapshot identity, and retains
already-successful operation history instead of redirecting/copying it.

Failure compensates only recognized content. An unrelated edit is preserved and
leaves `compensation_failed`; there is no claim of atomic filesystem visibility.
A stopped Job gets one required cleanup handoff; failed cleanup stays explicit.
The existing bounded Job retry or explicit exhausted-Job resubmission reuses the
same frozen intent, not another human approval. Foreign/unsupported Host targets
retain the resolver's existing refusal. No new Agent action or production approval
mapping is enabled. Migration0014 is generated from Drizzle, additive, and has
only been exercised against isolated shared PostgreSQL fixtures in this batch.

Review closure at basis7594f2ec: only explicit policy-refusal and frozen/snapshot
refusal sites produce `CodePatchDecisionRefusal`; arbitrary403/409, database and
lease errors are not classified by HTTP status. A definitive refusal persists a
terminal marker before compensation. Job completion then means the handler
settled a `status:failed` decision, never applied success. Repeated delivery reads
that failed result without repeating effects; explicit authorized resubmission
can reset the original failed intent with a new Job and fresh authority checks.
If cleanup is unfinished, delivery can only compensate. A busy Folder gate keeps
`compensating` and uses JobDeferredError without consuming an attempt; it is not
operator repair or exhaustion. Unknown independent edits still remain untouched.

Admission audits retain Proposal/phase correlation. Worker preparation and final
commit carry the real `decision_id` with `worker_prepare`/`worker_commit`; these
are independent live authority checks, not duplicated approvals. Both final
proposal.apply and write_patch audits join the DB transaction, including unlinked
standalone decisions. Recovery uses the original audit id after rollback/release.
Active-fingerprint admission precedes failed-intent reset/enqueue; same-intent
replay is allowed and another active intent gives409 before any domain/Job write.


### Agent verification and conflict repair

Hosts advertising `native_workspace_integration=true` use one native
Agent session and the conversation's existing worktree throughout a task.
`workspaceRunReply.ts` invokes that adapter once, reads final facts and releases
its answer; it never relaunches a repair/configuration/summary phase. Only work
still open on exit (a pending request or a prepared/conflicted/moved batch with
no publish result) fails the Run; merged, `no_changes`, a private checkpoint and
a reported failure are facts the Agent already read, so its answer stands.

`workspace.change.complete` is the unified Operation Core command:

- `prepare` applies only the batch delta onto the current target in that same
  private worktree, preserving a Host preimage and ignored dependencies.
- The Agent repairs conflicts and related code with its ordinary tools. Native
  checks run in that same environment. A native Git commit or `checkpoint`
  supplies the saved version to check, including on a strict Host. Checkpoint
  alone saves privately without publication intent or a merge record. Native
  commits keep their identities/history after Run settlement.
- `publish` supplies `verification={commit,checks:[{command,summary}],note}`.
  These are Agent-reported checks, explicitly labeled `agent_attested.v1`.
  Empty checks require an honest note; no Folder command configuration is needed.
- `workspace.change.get` returns current revision/progress. It and each visible
  `workspace.change.list` item also return per-action `actions` with availability,
  blocker, safe recovery guidance and input requirements for completion actions,
  retry and abandon. These are advisory server-admission checks, not grants or
  Host/Git proofs: execution rechecks authority, state, exact revision and all
  remaining inputs. The projection calls the existing workspace authorizer with
  each action's original mode; list/get visibility never widens old-workspace
  completion or retry authority. A shared delegated writer sees checkpoint
  available while prepare/publish/reconcile/retry/abandon require its coordinator.
  Ungranted operations are omitted. `can_retry`/`closable` remain compatibility hints.
  Visible native-state refusals give a safe reason and a current-state read;
  hidden objects keep uniform 404 without revealing their existence. Only merged/no_changes
  completes publication. A moving target returns to this same Agent. Publication
  verifies tree equality, Git integrity, current authority and the short target
  lease/CAS; it cannot silently include files changed after the checks.

Core admission persists intent and a Job in one transaction; its afterCommit
hook only kicks that same recoverable work outside the transaction. Replay uses
one request identity, and a cancelled Run cannot publish. A lost publish receipt
can prove an already-applied result even after the original process exits.
No Agent task is started for recovery. Original-checkout edits on published files
are carried onto the result when they merge cleanly (preimage retained) and block
only when they do not; unrelated staged/unstaged edits,
private-baseline exclusion and content provenance remain protected.

Conversation source worktrees and their ignored dependencies persist while a
Run uses them. The existing cleanup Job owns reclamation, with active
Run/command/checkpoint guards and expected-tip fencing. A source whose batches
all closed as integrated/no changes is reclaimed (tree, Git registration, managed
branch, owned refs, receipts) immediately after the last using Run exits; the same
conversation later rebuilds the same workspace identity from the target. Unmerged,
blocked, kept-without-merging and private-baseline work keeps its branch with no
automatic expiry unless the person explicitly requests reviewed discard. A past Run's file preview reads its exact version through an
owned run-history ref for the configured history period after a reclaim, then
shows an explicit expired state, only when that exact version is gone after the
period and Git cleanly reports it missing; a missing file, refused read, a
Host that cannot read its object store (permissions, corruption: 503) or an
offline Host is never shown as expired. See *Source retention and reclamation* in
[Hosts](hosts.md).

Adoption evidence binds the saved generation/base/source to an exact historical
publication or parent checkpoint. Later target edits do not revoke an adoption
still in target history; a rewrite that removes its proof keeps the source.
Manual Git merges follow the same proof. A parent checkpoint may adopt a child
before publication, but is never displayed as root publication: reclaim-6 Hosts
pin it under the existing parent recovery ref before releasing the child branch.
That ref remains until its contents are proved in the target. Older Hosts defer.

Directory idle clocks use Run end and observed content changes, not status-only
updates. Safe idle edits are saved as unpublished work before the new 24-hour
clock starts; staged/unique ignored/nested contents outside the snapshot
contract remain intact. Branch/ref release has independent proofs and runs immediately after the last using Run exits.
Historical equal-tip groups are audit information, never deletion permission.

Workspace batch rows show, once per workspace generation, its retention state,
reason and time (grace end, hold end or reclaim time) and for current Project
writers **Reclaim now**, **Keep 7 more days**, **Stop keeping** and **Retry
cleanup**. These call `workspace.retention.update`; unmerged work offers no
reclaim control. Retained and unowned recovery-ref counts, base commits and
refs are in the row's collapsed technical details.

### Agent workspace overview

Files & Code has a secondary **Agent workspaces** entry under the Folder's
Files/Changes tabs (and in the no-Folder empty state). It opens
`/projects/:projectId/files/workspaces`, served by
`GET /api/v1/projects/:projectId/agent-workspaces?view=current|history&cursor&limit`
(`workspaceOverview.ts`). One row per workspace generation shows the
conversation or Task title, Agent, Folder, server-derived work state
(`attention`, `missing`, `running`, `integrating`, `saved`, `unsaved`, `merged`,
`adopted`, `in_target`, `adoption_unverified`, `no_changes`, `kept`,
`missing_closed`, `idle`), retention and activity time. The state is decided
from live facts first (a blocked batch, a Run working now, a merging batch),
then an unacknowledged missing branch, then saved/unsaved work, then a closed
missing record and settled outcomes: a recorded missing reading never outranks
a later Run or batch, and is not applied at all to open work saved after its
assessment (`currentRetention`; a launch report also replaces the stale
inventory, hosts.md "Missing branches"). Conversation summaries and batch rows
follow the same order and do not repeat a missing reading beside a merging
batch or working Run. *Active & pending*
(default) holds running, unfinished, saved-with-a-real-difference, held,
reclaiming, proof-refused/quarantined/safety-retained and
attention rows; *History* holds merged, adopted, already-in-target, unchanged,
reclaimed, kept-without-merging, removed-branch (including unacknowledged) and branch-kept-only-for-a-
private-baseline or delegated-child rows. An open batch whose saved source
equals its base is "No saved difference", never "Saved privately", so it cannot
contradict a reclaimed "content is in the target". Delegated workspaces carry
`parent_workspace_id` and are grouped under their main workspace when both are
loaded; otherwise they stay visible on their own, so paging or a parent in the
other view never hides unfinished delegated work.

The page's default list is server-aggregated: `GET
/api/v1/projects/:projectId/agent-workspace-groups?view=current|history`
(`workspaceOverviewGroups.ts`) returns one entry per conversation × repository
(`group_key` `c:<conversation>:<location>`, or `w:<workspace>` without one)
with the most urgent member state, the current workspace (the conversation
workspace with the highest generation, never chosen by activity), the latest result
(newest visible batch with an outcome or saved difference), issues
(`attention`, `missing`, `cleanup_blocked`, `unconfirmed`, `host_offline`) and
up to 20 unconfirmed saved batches (`saved_not_merged`, `kept_without_merging`,
`adoption_unverified`). A batch is folded away (`proven_duplicates`) only when
its exact source commit equals one with target proof: published from a root
workspace, or closed with a target adoption proof (`target_paths_match` on a root workspace, or
`published_parent_paths` whose adopting parent was published from a root).
Adoption into a parent batch is not target proof, so the parent's unpublished
work at that commit stays listed; batches saved at the
same commit are listed once (`same_commit_count`). Running/merging workspaces'
open batches are their current state, not unconfirmed. A group is *current*
when any visible member is; grouping, counting and paging use only the visible
rows above, and the cursor names only a group the reader was shown. Each entry
folds its execution history: `agent-workspaces?view=all&group=<key>` pages every
visible generation of that group (delegations, older generations, reclaims),
rendered with the per-workspace rows and batch details below. Files:
`AgentWorkspaceGroupCard.tsx` (entry and history), `AgentWorkspaceRow.tsx`
(generation row and batches). A `missing` row offers
**Close missing records** (confirmed; `acknowledge_missing`).
Visibility is applied before anything is aggregated or paged: every batch and
every bound Run must pass an owned or server Host, a readable conversation (the
shared session gate) and a visible, unwithheld (`full`) Run body. A batch also
requires every *contributing* Run to pass that gate
(`workspaceContributors.ts`): each Run bound to it (later turns and serial
delegated children checkpoint into the same batch), each Run recorded in
`verification_json.contributor_run_ids` (checkpoint and native
prepare/checkpoint record the producing Run), and recursively the origin, bound and recorded Runs of
every adopted child batch (legacy uncertain adoption stays conservative). The same predicate gates
`workspace.change.*` authorization (`authorizedWorkspaceChange`: get, list
closure, publication, retention, verification), so one unreadable contributor
hides the batch everywhere. Background publication rechecks the same gate,
and taint assessment uses that same recursive contributor set. The SQL form
of that Run gate is `runBodyReadableSql` (`runs/runBodyReadSql.ts`). It is
deliberately narrower than `getVisibleRun`, never wider: it applies the same
content, Room and access-level (including oversight) layers and requires a
`full` level, but it also requires the Run's conversation to be readable and
excludes domain-gated Reading Runs fail-closed instead of evaluating their
domain gate. `agentWorkspacesDb.test.ts` checks that the two agree for owned,
shared, summary-only, private, granted and content-oversight Runs, and that the
SQL gate only narrows for archived conversations and Reading Runs. A row's state, batch count, activity time and
shown Run are computed from visible batches and Runs only, and a workspace with
no visible batch is absent. Paging is an opaque keyset cursor over visible rows,
so a page is full whenever more exist and the cursor only names a row the
reader was shown. The list requires Project read; Task titles use the Task
content gate. Details (`.../agent-workspaces/:workspaceId?cursor&limit`) page
the same batches through the shared batch reader and reuse the existing safe
commands and retention controls; rows link to the original conversation, Task
and Run. An empty page with a cursor offers *Load more* rather than an empty
state.

The shared batch reader (`readVisibleWorkspaceChanges` in
`workspaceReadModel.ts`) applies the same Host and Run-body gate inside its
query and returns `{entries,next_cursor}` with a keyset cursor (limit 1–100), so
hidden rows never use up a page. Conversation pending work
(`GET /api/v1/sessions/:sessionId/workspace-changes?cursor&limit`), the
workspace detail, the Project attention list and both integration- and
closure-recovery hints all read through it. Recovery hints put their candidate
scope in that query and page through the visible rows until they have at most
five (integration hints newest first), so hidden batches never use up the cap,
and a Run's bound batches are read completely.
Private worktrees are not registered as Project Folders or browsed here; a
reclaimed workspace says its result is in the Project Folder. Denied, failed,
empty and offline-Host states are shown distinctly.

On native Hosts, the Run and conversation card offer the existing **Let Agent
verify and integrate** action for an open/blocked batch. It sends an explicit
ordinary message to the visible original Agent/conversation. It opens no command
configuration, ID entry or nested execution surface. Historical controls remain
available for legacy Hosts/records; native retries use the active session.

Reuse / Dependency Check: follow Orca's ordinary-Git worktree model and Vibe
Kanban's Agent follow-up conflict repair; reuse native ACP, Operation Core,
conversation ingress, Jobs, `mergeTrees`, shared target publication and cleanup.
No dependency, Agent scheduler or replacement Git implementation is added.
References: https://www.onorca.dev/docs/model/worktrees and
https://www.vibekanban.com/docs/core-features/resolving-rebase-conflicts.

### Workspace publication recovery

`workspace.change.complete` accepts an optional full `commit` ID to publish an
existing independent commit. The current authorized batch must have no other
workspace changes; a settled `no_changes` batch without an integration may be
explicitly submitted this way too. Existing exact Run binding, Project writer,
Host ownership, origin, grant and revision checks remain in force. Admission is
only an intent: it never writes a ref or declares the commit integrated.

Legacy completion waits for successful settled Runs and saved checkpoints;
native prepare validates the independent commit in the active session. A retried
historical batch of the same workspace uses the same path with its recorded
base: the worktree must hold no unsubmitted changes of the bound batch
(`workspace_commit_requires_empty_change`), and a delta the target already
contains closes as `no_changes`. A publication closes other blocked batches whose
recorded delta it carried. Legacy completion
then asks the owning Host to read the exact commit, its single parent and changed
paths. The parent must belong to target history; protected paths and oversized
path scopes refuse intake. It freezes only that parent-to-commit delta, retaining
all contributing Run/context provenance. The existing integration Job constructs
and verifies the candidate, seals it, publishes by CAS and owns cleanup. Host
reads happen outside the core transaction; the freeze is a short fenced write.
No private branch history, unrelated workspace edits or caller-selected paths
are imported. An offline Host defers, and a rejected intake preserves the batch.

People use the existing **Finish changes** control or ask the Agent to publish
the work it prepared. The Agent resolves commit identities itself; there is no
manual Git ID form. Both Run and conversation controls expose **Check whether already integrated**
on failed integrations. It calls `workspace.integration.retry` with
`reconcile_only: true`, which cannot carry repair instructions or a publication change. Host preparation
checks whether the complete frozen patch can be reversed against a private index
of the committed target, without touching the user's index or working files.
A bounded, complete Git proof closes the old record as `no_changes` and records
the observed target commit. Missing proof keeps an actionable blocked record;
this check never publishes, runs verification or starts another repair.
Ordinary retries share the same adoption proof before rebuilding conflicts.

A successful saved standalone batch with no file differences closes automatically
as `no_changes`, with durable cleanup. Waiting/failed/pending work, submitted
commit intents and delegated families are excluded. The conversation's turn
summary omits `no_changes` rows; Run details and the Agent workspace overview
retain history. Independent commits are resolved and submitted by
the Agent through the same completion operation. Cleanup failures remain visible. Older real failures never become
success merely because another batch or a local IDE test succeeded.

A later writable Run in the same conversation workspace can also use the existing
`workspace.change.abandon` command after an explicit request to close obsolete,
already adopted or superseded work. It checks origin visibility and current
Project/Host authority, preserves the saved source and records the reason, and
cannot claim a merge succeeded. A later generation may withdraw retained work for the same conversation,
Project and registered Location. A manually instructed conversation writer may
also inspect and close the same person's other conversation/delegation workspaces
in its Project (`workspaceProjectCleanup.ts`). Both origin and all contributors
must remain fully readable, Project write access and remote Host ownership must
still hold. Project list, get and abandon share this authorizer; the list exposes
the readable conversation/summary and reports exact-review requirements.
Cross-conversation closure always requires exact-source review and the person's
applicable instruction on the requesting conversation's canonical message branch,
including empty batches. Earlier authorization can continue on that branch; no
repeat confirmation or caller-entered ids are needed. Automatic/delegated and
read-only/unbound callers do not gain this reach. Completion, publication,
integration retry, verification repair and runtime placement retain their original
scope; get reports `can_retry:false` for cleanup-only access. Existing source
review, revision CAS, dependency/checkpoint checks and Host cleanup/retention Jobs
still perform every mutation. This covers intentional later retirement of a file that makes exact
patch-presence proof impossible. Raw closure reasons and submission actor details
stay out of shared workspace progress; durable command history retains them.

Reuse / Dependency Check: this extends the existing workspace authorizer,
canonical message provenance and Operation Core abandon/cleanup path. It adds
no schema, queue, approval mechanism or external dependency; authorization is
domain policy, while Git effects and durable Jobs remain in their current owners.

A terminal batch whose checkpoint recovery was exhausted can be explicitly kept
without merging even when its checkpoint is still pending. Its checkpoint status
is not relabelled successful, its unknown files stay intact, and no source cleanup
is requested. Once its last unfinished batch is withdrawn, that old logical owner
retires. Active Runs on the batch still block withdrawal. This retention does not
block a newer generation or claim that any unverified work was integrated.

Host preparation pins each exact frozen source under
`refs/rainver/sources/<commit>` before squashing a disposable candidate. This also
retains independently created commits that never had a branch. Physical worktree
cleanup can remove candidate trees, registrations and temporary refs while these
content-addressed result refs preserve committed work and its original identity.
They are retained evidence, not an unowned worktree or a copied private history.
A native request's explicit commit (an Agent-submitted one, or a historical
batch's recorded source) is pinned the same way, and proven present, before
`native_prepare` uses it; registering it is gated by the shared-source deletion
fence like every other dependent (Hosts guide, *Ref operations*).

Launch hints include authorized retained-batch identities and revisions, including
exhausted earlier generations in the same conversation/Location. They omit old
instructions and summaries, and never require a person to copy an internal ID.
These advisory reads fail without blocking a normal turn. They grant withdrawal
of retained work only; completion/retry keep their stricter publication binding.

Research snapshot provenance projections propagate explicit no-oversight reads to
both the Workflow and its primary Inquiry Thread. Publication does not inherit an
administrator's oversight-only access through a nested provenance predicate.

### Reviewed conversational withdrawal

`workspace.change.abandon` accepts optional `review` with the exact saved
`source_commit`, `user_request_quote` and concrete `findings`. For open batches with saved differences
an Agent must supply it. Existing withdrawal of failed/blocked work stays compatible. The quote must occur in
the canonical current user message of its manual Run (the server-owned
`chat_turn.v1.user_message_id` pointer), or in the same person's earlier user
message on the current visible conversation branch. The current message must
first pass the existing Runtime Context reader; historical sources also pass
that reader with their original Run binding. Space, session, author,
direct-chat Run/retry binding and live Room membership remain checked. Earlier
sources must precede the current message on its visible path and must not be
retry-superseded. Other branches, other authors, future messages and unlinked
history do not qualify. Turn session/person/Agent/Project identities must match the Run;
assistant/system messages, handoffs and delegated/unattended turns are refused.
Malformed structured input never falls back to matching assembled context. Legacy
non-chat Runs still use their server-owned prompt/instruction. The audit stores
the original message or Run-request reference alongside the review. The Agent is responsible for interpreting an explicit request
to close this exact work, including any later change or revocation; substring
matching establishes provenance, not semantic approval. An applicable earlier
request need not be repeated, and the server resolves its message id. This
continuity is limited to reviewed closure; squash publication still requires
the current direct request.
Unattended turns cannot use this route. Existing Project/Host/Run-body and
conversation/delegation-tree authority still applies. List reports `review_required`
until the caller supplies a review; get supplies the saved source identity.
Revision and source are rechecked under the workspace/batch locks. Active Runs,
unfinished integrations and pending checkpoints cannot be bypassed by review.

This withdraws an obsolete record as `abandoned`, retaining the source and review
in the audit evidence. It is not adoption proof, does not mark the batch merged,
and does not authorize deletion of unproven unique branches or files. Existing
retention/cleanup checks keep those sources; exact adoption continues through the
Host-backed reconciliation path. No schema migration or separate shell API is used.

When the last unfinished batch of a recorded missing source is reviewed and
withdrawn, the existing missing acknowledgement is recorded too. It leaves the
unfinished list as missing history; it never becomes a successful integration.

### Event-driven workspace overview

The Agent workspace overview subscribes to the Project's shared content-free
`/api/v1/projects/:projectId/updates/stream` SSE connection. Agent and background
workspace writes invalidate the list and any expanded detail; fresh cursors are
followed for the number of pages the person loaded. Quiet reads retain the visible
frame, open details and pagination. Late responses from another view/Project are
ignored; a refusal clears cached rows. Hidden tabs disconnect; reconnect/focus
revalidates once. There is no interval polling on this surface.

Acknowledged removed branches are labelled closed history, including their
retention explanation. They are audit records, not remaining branch files to
remove. Removed-branch records remain accessible in History with their unresolved contents
and existing recovery controls; moving a row does not close its batches, prove
adoption or delete any source. Active Runs, integrating or blocked batches and
cleanup failures still stay in Active & pending. Open work saved after the missing
assessment is current again; no visibility or retention permission is relaxed.

The current/history projection also lets terminal visible batch facts supersede
an older unpublished/blocked/unmerged retention explanation. It does not wait
for a deferred cleanup assessment to move a closed row into history. Any visible
unfinished batch or active Run still keeps the workspace current.


### Explicit discard and physical reclamation

`workspace.change.abandon` with `reclaim: true` and an exact `review` requests
physical reclamation of an obsolete saved generation (including a previously
abandoned batch or a closed `no_changes` review). Closed unchanged reviews require
the same explicit reclamation and exact-source review; ordinary closure cannot
reopen them. List/get report this review requirement instead of an unrecoverable
closed-state blocker. Integrated publication receipts remain unchanged when
their source is reclaimed. A normal close still retains source. The existing authorizer
covers the conversation/delegation tree; Agent requests must quote an applicable
canonical direct human request on this conversation branch, and this mode requires an explicit request to
discard the saved source and reclaim branch/files, not merely close its record.
The batch revision, saved source, current generation and workspace head must
match; every binding must be saved before physical cleanup, no other batch or integration may be active,
and an unconfirmed earlier cleanup cannot be replaced. The workspace retires so
a new turn allocates a new generation rather than inheriting the discard grant.

A cancelled/failed binding with no recorded launch (`start_commit` absent,
sequence zero) can recover its pending checkpoint automatically in the existing
checkpoint Job or the existing cleanup Job after reviewed reclamation. The exact prior Host launch must
confirm exit and no execution lock may remain. Host `inspect` with the saved
expected tip returns `unchanged_commit` only under the workspace lease, with no
launch/Run receipt or unsettled writer, a recognised clean worktree and the same
branch/HEAD. Only that positive proof records an unchanged checkpoint and its
recovery evidence; missing receipts alone do not. Dirty, moved, busy or unknown
work stays pending, including when recovery was previously exhausted. This
also lets an authorized retry finish old records without a separate repair Run.
The Operation Core command freezes only the authorized intent and source; it
never calls the Host while holding its database transaction. Eligible terminal
sequence-zero bindings may remain pending on that receipt. Cleanup performs the
positive proof and saves them before any physical removal; unknown, dirty or
active work stays retained and the receipt never claims it was deleted.
That proof can also cover a branch-only remainder of earlier worktree cleanup:
the exact saved branch must remain unchanged, with no checkout elsewhere,
unregistered directory, unsettled Run/merge record or whole-tree quarantine.
The existing cleanup Job can then save the terminal zero-launch binding and
continue its already-authorized reclamation without a new repair Run.

Checkpoint retry state is binding-local (`checkpoint_recovery_json` on
`execution_workspace_runs`) and belongs to its current launch sequence. The
workspace read model derives `integration_detail.checkpoint_recovery` from
pending bindings; old change-set JSON is historical evidence only. New launches
clear their own pending result/recovery, never a sibling's state, and old launch
reports cannot reopen saved work. Runtime exit, Job recovery and periodic
reconciliation share `hosts/workspaceCheckpoints.ts`. A current checkpoint must
be saved before dependent children are admitted; an obsolete Job is reported as
superseded, while a real failure remains retryable or explicitly exhausted.

Checkpoint recovery policy and scheduling are centralized in
`workspaceCheckpointRecovery.ts`, shared by new-turn admission and periodic
reconciliation. Environmental preconditions (offline/busy Host, capability
upgrade, unavailable launch identity) enter `waiting` and defer the existing Job
without spending its operation-failure retry budget. Legacy exhausted environment
waits resume automatically; a new turn also reoffers an exhausted operational
checkpoint under a fresh recovery identity. Old Jobs remain superseded. Safety
blocks are never reset by this path. Admission commits the checkpoint Job before
deferring the new turn (`workspace_checkpoint_recovering`), rather than failing
that turn or allocating a replacement worktree with unverified content.

Recovery examines every persisted dispatch attempt, not only the latest retry:
a retry without a launch nonce cannot erase an earlier orphaned execution. It
confirms each dispatched process exited and recovers the Host's original launch
receipt before checkpointing any dirty files. A changed launch sequence supersedes
the old Job and is saved by its correctly fenced continuation.

Recovery observes state, performs Host I/O without a database row lock, then
commits under owner revision/generation/epoch, binding request, change revision,
latest attempt and live-writer checks. A clean unchanged saved tree can settle a
terminal unlaunched binding against that version. An entirely absent Host owner
can settle a never-materialized empty batch as `no_changes`. Both retain the
truthful null `start_commit`, recording a settled outcome of `unchanged` or
`not_started`. Only complete Host absence with no persisted dispatch can establish
`not_started`, which invents no commit; missing receipts alone prove neither outcome.

Closure/refusal responses retain HTTP 409 with a specific message and
`error.metadata.code`: revision/source moved, request not found, Run active,
checkpoint pending, Host upgrade required, safety block, cleanup pending or
active dependencies. The Agent can distinguish a reread/retry from work that
must first settle, without asking the person to enter commands or repeat ids.

The existing cleanup Job, dependency checks, Host lease, dirty-tree refusal,
expected-tip CAS, quarantine and materialization fences perform deletion. Host
reclaim level 5 is required; older Hosts refuse admission and resumed jobs defer.
A moved tip requires another review, never an automatic transfer of permission.
The outcome stays `abandoned`, with retention reason `discarded`, never merged or
adopted. The UI reports deliberate discard without claiming content is in target.
Recoverable checkpoints/base remain in existing run-history refs for the
configured period (default 30 days), with durable expiry Jobs; managed branches
and worktree files do not remain for that period. Other live dependencies still
protect their shared source refs.

The same cleanup Job finishes later recovery-ref pages using the completed
release's exact history keepers on reclaim-7 Hosts. Earlier rewritten snapshots
need not appear in the final tip's ancestry: their exact generation-owned backup
must still exist durably, with no later launch or remaining source resources.
The redundant recovery names are then released; historical file previews keep
their existing retention and expiry. Old proof-waiting pages resume once after
the Host upgrade. Missing backup evidence keeps the page pending rather than
inventing completion. This reuses the existing release journal, leases, Git CAS,
history retention and Jobs; it adds no schema, dependency or cleanup runner.

Optional Host cleanup capabilities do not gate supported isolated execution.
Unknown extensions are omitted individually at heartbeat ingestion. Missing
execution capability pauses background reconciliation; a successful fenced Host
inspection clears the old diagnostic and recalculates pending history. Actual
cleanup blocks remain, without preventing supported new turns from continuing.

Current/history SQL excludes acknowledged old missing assessments from its
missing-branch filter, matching the saved-work state projection; later open saved
work remains current while a closed missing record alone remains history.


Native delegated publication records exact child adoption in the same database
transaction as its merged outcome (`hosts/workspaceNativeAdoption.ts`). The
receipt carries the base/source/generation, integration attempt, target and
parent-owned landing checkpoint. Historical backfill uses that same writer;
external manual Git keeps the existing strict content proof. An empty delegated
review can release its redundant resource only when its inherited baseline is
preserved in a proven parent checkpoint and the Host durably pins that version.
Publication outcome and physical reclamation remain separate current facts;
this receipt alone does not mean cleanup finished.

### Landing versus release progress

The shared workspace list consumes the typed `lifecycle` returned by the Run
and conversation readers. It keeps published temporary work pending through
`awaiting_release`/`cleanup`, displays cleanup recovery separately from merge
failure, and polls until the lifecycle settles. Legacy batches without this
record retain their publication and cleanup displays. No new publication or
cleanup write is made by rendering or polling.


Failed/cancelled temporary sources on preserve-source Hosts expose their exact
`retention.preserved_commit` and `retention.recovery_ref`; the batch remains saved
and unmerged. Reusing its bounded slot does not adopt its old result. Recovery
metadata stays on that old batch even while a new batch uses the directory.
Legacy lifecycle backfill requires matching settled integration/batch facts;
a `reclaimed` label alone cannot complete a temporary lifecycle without actual
Host inventory proving branch, worktree and registration absence.


The optional lifecycle `slot_use_id` distinguishes successive uses of one stable
workspace branch, including equal source commits. New source cleanup is linked
to its exact integration before enqueueing; a late prior-use response cannot
finish or overwrite the new use. Controlled and native no-change landings share
the exact parent-receipt writer. Recovery records remain history until an
explicit new submission reactivates their batch; submission clears the historical
`slot_recovery` marker while retaining its recovery evidence. See the Host guide's
reused-slot fences and focused real-PG/Host-Git acceptance.


Temporary workspace admission counts the primary coordinator inside the declared
collaboration total. Release waits use persistent current-use timing rather than
Run age; explicit holds remain temporary and releasing one wakes the pending Job.
Before reuse, the old lifecycle settles against its confirmed physical inventory
and cleanup evidence under lock. Permanent terminal checkpoint failures surface
as `workspace_checkpoint_blocked` in the existing cleanup errors/attention;
normal pending or live work does not. See ADR 0029 and the Hosts guide for the
clock, proof and epoch boundaries.

Slot waits now precede the running transition in the real `agent_run` worker.
Clearing or shortening a hold wakes only the exact current workspace/use Jobs,
including claimed work; the old future wait deadline is reset. A remaining
shortened hold is re-evaluated at once. Capacity retries re-read active Room
membership every 30 seconds, preserve the fixed collaboration limit, and keep a
minimum slot for ordinary noncollaborative work. Another Task's blocked resource
at the existing bound returns a specific resource refusal; its existing recovery
controls must resolve it before retry, without discarding or adopting its work.
Checkpoint attention preserves unrelated inspection errors and their first time.
See the Hosts guide's queued admission and wake recovery contract.

Reviewed reclamation also accepts `integrated` sources. Publication facts remain
`integrated`/`merged` or `no_changes`; only unpublished withdrawal becomes
`abandoned`/`superseded`. The exact source review, applicable current/earlier
branch instruction, revision and workspace/dependency checks still apply.
`workspacePublicationState.ts` defines terminal publication and the conservative
legacy no-change settlement used by execution and read-only applicability/list.
A residual `verifying` merge qualifies only with matching completed native
no-change receipts, generation/source, no outstanding integration Job and no
native request lock. Pending publication and genuinely active integration stay
blocked. Reclamation records the existing integration's cleanup responsibility;
it never submits another merge. Unfinished lists include incomplete landing
lifecycles and an exact outstanding discard intent. Operation idempotency keys
replay one admission; a different stale request must reread the revision.

List/get and admission share a batched read-only discard assessment. It reports
an already reclaimed generation, missing/moved source or generation, safety block,
Host reclaim level below 5, unreplaceable cleanup and missing publication landing
as distinct blockers. A fresh request for a reclaimed generation is refused as
`workspace_discard_already_reclaimed`; it cannot rearm cleanup, regress retention,
rewrite completion time or create another cleanup operation. Terminal merge
statuses permit reclamation only when the batch itself is closed.

The shared dependency predicate includes every live binding and Review, owed
checkpoint, active sibling batch/merge, unreleased or live empty child, pending
native receipt, integration Job and native advisory lock. Admission may defer
only terminal unlaunched checkpoint proof; cleanup requires saved bindings.
After Host inspection, cleanup rechecks the dependencies, head and safety state
under the workspace row lock before raising its release epoch. Host leases and
Git CAS still prove physical deletion. Publication and dependency reads are
batched once per list page and reused by each item's action projection.

Legacy no-change settlement records the matching native receipt request in
`cleanup_settlement`; it preserves the original completion time. A publication
without either `merged_commit` or `onto_commit` has blocked lifecycle ownership
with a null landing, never a fabricated landing or completed lifecycle. Explicit
reclamation waits for that evidence to be repaired.

### Recovery of retained lifecycle obligations

`workspace.change.get` includes path-free `diagnostics` for unfinished cleanup
resources and checkpoint bindings, including their current reason, retry time,
attempt count and recovery guidance. A null saved source is
`workspace_discard_source_unconfirmed`, distinct from a moved generation/head.
Neither a missing saved head nor a terminal Run establishes empty content.

`workspace.retention.update` with `action: recover`, `change_set_id` and the
current `expected_revision` reoffers existing cleanup or terminal unlaunched
checkpoint obligations. It is visible to Agents through the normal registry,
scenario allowance, grant, policy and Operation Core audit path. Agents may
use person-initiated `recover` and `retry`; unattended origins are refused by the
existing Project-write policy gate. Hold, release, acknowledge-missing and reclaim-now remain person-only. The shared authorizer permits the same manually
instructed Project writer's cross-conversation cleanup scope, not another
person's work or cross-conversation publication/integration retry. Active writers,
safety-blocked checkpoints and changed generations/revisions refuse recovery.
No discard intent, publication job, new Run or source deletion grant is created.
Permanent cleanup refusals retain their specific Host reason and require their own
remedy. `diagnostics.recovery_mode` distinguishes `recover` from `retry`.
A manually instructed Agent may retry an existing blocked cleanup in the current
generation with the current batch revision. It reoffers only that generation's
resources; a sent request keeps its full frozen payload and operation identity.
It neither clears inspection/checkpoint evidence nor grants publication, discard
or release of a different source. Host safety and dependency checks run again.
Diagnostics use a nullable recovery action: old-generation, launched and blocked
obligations do not advertise generic recover. Current safety blocks remain conservative;
unrelated old cleanup keys do not block independently recoverable current debt.
List projections reuse recovery admission per workspace within the read and never
lock writer authority in a read-only transaction; execution rechecks current revision
and authority under locks.

Recovery schedules the canonical checkpoint Job even for a retired owner, but
only a terminal sequence-zero binding may settle there. The Host must confirm
exit of every dispatched attempt and prove an unchanged saved workspace head,
or complete absence for a never-dispatched batch with no baseline or source. A null source can adopt only the batch's non-null base, with matching batch/workspace
generation and head equal to that base. Existing sources require the same generation
and matching head. After Host I/O, the locked transaction rechecks batch generation,
base, source and revision, workspace generation/epoch/head, binding, attempt and nonce
before saving either binding or source. A null-base never-dispatched batch may settle
only on complete absence; it does not adopt a historical workspace head.
Explicit exhausted-checkpoint retries target only the authorized change set;
background reconciliation retains its existing workspace-wide semantics.
Dirty or unknown files retain the debt; abandoned and published receipts remain
unchanged. Re-read after recovery before considering any reviewed discard.

### Selected-batch checkpoint recovery diagnostics

`workspace.change.get` projects checkpoint recovery actions for the selected
change set only. Other batch obligations remain visible without an action and
instruct the caller to obtain recovery authority for that batch. Diagnostics do
not expose additional batch, Run or owner identifiers. Explicit recovery never
reactivates another batch's exhausted checkpoint. Current-generation launched
pending checkpoints retain the conservative `checkpoint_pending` gate in both
advisory applicability and locked execution; their standard checkpoint worker
must settle them. Older generations do not impose that gate on current debt.
Existing frozen cleanup requests remain workspace-scoped and replay unchanged.


### Closed cleanup history and missing-child dependencies

Reconciliation may inspect a retired owner even when an old checkpoint is blocked.
Only a fenced Host receipt confirming no branch, worktree, registration, Run/merge
record, active lease or whole-tree quarantine can close cleanup attention for an
unsaved source whose batches are all already abandoned and have no saved source.
The receipt is scoped to generation and materialization epoch. No binding becomes
`saved`, no merge is claimed and no cleanup/deletion request is issued. Original
checkpoint failures remain readable as history with non-actionable diagnostics;
new work, a new epoch or reappearing resources invalidates this disposition.

Parent retention and reviewed-discard admission share the missing-child rule:
`missing/missing_acknowledged` with its recorded acknowledgement, confirmed source
absence and completed cleanup no longer pins the parent merely because an old head
is recorded. Unacknowledged absence, quarantine, incomplete cleanup, open child
batches and live Runs continue to block. This never supplies adoption proof.
