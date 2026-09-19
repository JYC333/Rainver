# ADR 0021: Files & Code Editor, Recovery Drafts, and Lazy Input Resources

Date: 2026-09-17

## Status

Implemented 2026-09-17 through the phased delivery recorded in Git history;
the temporary implementation plan was retired after the final integration
gate. This ADR records the shipped authority split and user-visible semantics.

## Context

Files & Code currently renders complete files through a hand-written
`<pre>`/`<textarea>` surface. Its direct save path is safe and bounded, but a
browser failure can lose edits that have not yet reached the Project Folder.
The Project Folder is a Host-backed canonical file, while Notes and other
database-owned content have different authorities and must not be made to look
like files. The Project Agent also needs the exact current file state, including
an unsaved draft, without placing the whole body in every initial model prompt.

Three tempting shortcuts would violate those boundaries:

- make TipTap own source text merely to keep one editor engine;
- treat a recovery draft as another saved-file authority or as a global draft
  product;
- expose a database URL, Host temp file, or prompt-embedded body as the Agent's
  generic reader.

## Decision

### 1. CodeMirror owns complete text files

Use CodeMirror 6's official modular packages through a small local React
adapter for complete text files in Files & Code. TipTap remains the rich
document editor, Shiki remains the renderer for static snippets, and the Git
diff surface remains separate. A writable supported text file opens directly in
an editable CodeMirror instance; there is no View/Edit/Done/Cancel mode.

The first release provides syntax highlighting, line numbers, search/replace,
indentation, bracket matching, folding, undo/redo, save shortcut, theme
integration, selection reporting, and encoding/line-ending status. It does not
become a browser IDE: no LSP, completion, diagnostics, formatting, terminal,
tabs, collaboration, or Agent-authored live-draft edits.

### 2. The Project Folder remains canonical; drafts are recovery state

The server stores at most one current recovery row per owner and Workspace
Location/path (and one new-file row per owner/Location) in PostgreSQL. Opening a
file creates nothing; the first document change creates the row. Autosave is
the implicit persistence path. The draft is private to its owner, recoverable
across browsers/devices, quota/TTL bounded, and visible only contextually in
Files & Code. It is not a generic Notes draft, a tree item, a search result, an
Activity/Memory/Artifact, or a second canonical file.

Save to Folder is the only human action that mutates the Host-backed file. It
flushes the editor, revalidates the exact draft version and Host SHA, performs
the existing atomic write and revision capture, then conditionally deletes the
version saved. History offers Restore as draft; it never writes the Host file.

Draft conflicts are explicit. Multiple tabs use optimistic versions. A Host
SHA change opens a two-way comparison and requires an explicit rebase; there is
no automatic three-way merge and no retained base body. Host offline editing
continues against the acknowledged DB draft but never performs an automatic
Host write.

### 3. Text admission is byte-honest

Normal editing admits strictly valid UTF-8, preserves a UTF-8 BOM and uniform
LF/CRLF choice, and warns before normalizing mixed endings. BOM-marked UTF-16
LE/BE is recognized deterministically and can be explicitly converted to UTF-8
for editing. Invalid UTF-8, binary/unknown encodings, and legacy encodings that
cannot be identified remain read-only; replacement characters and encoding
guessing are not used.

### 4. Sent file state is an immutable message resource

The current-file sidecar appears only in Files & Code. It defaults the selected
clean saved state or acknowledged draft state into the next message, can be
removed for that send, and captures cursor/selection coordinates as metadata.
Sending a draft flushes it first; a stale/conflicted/failed flush blocks the
attachment rather than silently sending an older version.

The message transaction freezes the exact bounded body in a message-owned
immutable resource. A small resource row holds source/path/version/selection
metadata and points at a content-addressed blob. Blobs deduplicate only within
the server-derived user or Project scope inside one Space; they never deduplicate
across Spaces. Later editing, saving, discarding, deleting, or changing the
Host file cannot change a sent resource. Retry and branch execution read the
same snapshot. Resource lifetime follows message/session access and retention,
not a live Folder registration; unregistering a Folder never deletes or is
blocked by an immutable message resource.

The existing conversation file-reference contract remains readable during
rollout. Legacy snapshots are not silently rewritten or dropped by this ADR.

### 5. Agents read resources lazily through the existing governed tool path

The initial prompt contains only a compact resource descriptor: id,
path/name, source state, hash, size, capture time, and selection. It contains no
body and exposes no generic database URL. Managed and CLI Agents use the
existing Run-scoped System Action Gateway/Dispatcher, bearer token, REST tool
surface, and generic `$RAINVER_CLI` for two read-only actions:

- `input_resource.read(resource_id, start_line, line_count)`;
- `input_resource.search(resource_id, query, max_results)`.

The immutable resource is the authoritative input state for that turn, even
when a file with the same `relative_path` is visible in the Run workspace. In
particular, `source_state=draft` means that the resource contains the user's
newer acknowledged unsaved content: before reading or modifying that path, the
Agent must read the complete resource and use it as its baseline rather than
starting from the older same-path workspace file. This changes the Agent's
input baseline, not draft ownership: the resource actions remain read-only and
do not silently save, replace, or delete the live recovery draft.

Reads are line-oriented and bounded; search is bounded literal matching in the
first release. The executor binds the resource to the originating user message,
Run, Space, session, and current conversation access. A guessed or foreign id
is indistinguishable from a missing id. Tool summaries and audit records carry
ids, ranges, counts, byte sizes, and hashes, never body text. A runtime that
cannot expose the existing Run tool surface rejects attachment admission; it
does not fall back to prompt embedding, a Host temp file, MCP, or a second
dispatcher.

### 6. Migration and lifecycle boundary

All schema and migration-file work for this decision is authored in the one
expand-compatible next numbered migration from the approved implementation
plan. The migration adds live draft and immutable resource storage, extends
message input parts, and makes legacy Folder/Location provenance deletion-
tolerant so Folder unregister can remove live registrations while preserving
historical message content. Once applied, the checksummed migration is never
edited; later contraction or backfill is a separate future decision.

## Consequences

- Human editing is continuous and recovery-safe without making the browser
  local-first or changing the Project Folder's file authority.
- Messages become reproducible snapshots while model context stays lazy and
  bounded; an Agent pays for content only when it explicitly reads/searches.
- PostgreSQL holds bounded text bodies, consistent with the existing bounded
  conversation snapshots; larger files remain editable but are not attachable
  under the current 512 KiB per-file conversation budget.
- Folder unregister no longer treats historical message provenance as a live
  registration dependency.
- The implementation spans protocol, schema, Project Folders, sessions, Runs,
  the shared composer, and Files & Code. The phase gates keep persistence and
  authorization complete before exposing the sidecar affordance.

## Non-goals

Agent-authored edits, three-way merge, draft revision history, IndexedDB
offline-first sync, encoding guessing, LSP/IDE features, Git diff conversion to
CodeMirror MergeView, and migration of Notes/Library/Sources/Artifacts to the
generic provider are outside this decision.

## Revision history

- 2026-09-17 — accepted after grilling and repository review; the implementation
  plan fixes the phase order and migration boundary.
