# Conversation Development

This guide covers using a Rainver conversation to inspect and develop code
through a connected execution Host. It applies to direct Agent conversations
and Project Rooms. The File page is also a direct user editing surface for
bounded text files; Agent workspace changes continue to use the Agent/Host
execution path.

## Before you start

Use an Agent with a usable runtime profile and an online execution Host. For a
Project conversation, open execution preflight and choose a Primary Workspace;
attach additional Project Folders when the Agent needs to read or edit them. A
Folder attachment is writable by default and can be changed to Read only in
the execution context controls. The
preflight shows the selected Host, CLI installation, workspace, and current Git
state.

When the first Host-backed turn is sent, Rainver initializes and pins the
Conversation's Agent/runtime/workspace context. Later profile or Host changes
do not silently move the conversation to another runtime or workspace.

Changing the Folder selector in Files & Code changes the file view only. An
already-open conversation stays pinned to its original Folder context; Files &
Code shows a small reminder after the switch. Start a new conversation or
explicitly attach the new Folder when the conversation should work there.

## Images

Paste an image into the composer, drop it onto the composer, or use the image
picker. Upload begins immediately, and an image can be removed before sending.
Only PNG, JPEG, and WebP are accepted.

Limits are four images per message, 10 MiB per image, and 20 MiB total. An
image-only message is valid. Rainver checks the selected runtime and model
capabilities before accepting the message; for a Host-owned ACP CLI, the
runtime's initialize capability is authoritative because the model is selected
inside that CLI session. An unsupported or unknown target blocks the send and
does not convert the image into a filename. In a Room, one incompatible
recipient blocks the complete send and is named in the error.

The browser stores only a server-issued media reference in a draft. Image
bytes are not placed in `sessionStorage` and are never sent as JSON base64.
Uploaded images are intentionally sent to a compatible runtime as multimodal
image input; a workspace-path reference is the separate `@` file flow.

## Referencing files with `@`

In a Project conversation, type `@` and choose the Files view in the menu. The
results are limited to the Primary Workspace and active attached Project
Folders already authorized for this conversation. Each result shows its source
and relative path.

Selecting a result creates a structured file reference. On send, the server
checks authorization again and stores a bounded snapshot of the exact bytes:

- at most eight file references per message;
- at most 512 KiB per text snapshot;
- at most 2 MiB of file snapshots per message.

Traversal, symlink escapes, secret-like files, revoked Folder access, missing
files, binary files that cannot be snapshotted, and oversized files are
rejected before the message is accepted. The reference contains a relative
path and server-owned Folder/Location identifiers; the browser never submits
an absolute Host path.

Managed file references render as path chips inside the message input. The
selected Folder is the default Primary for a new Sidecar conversation when it
has an executable Workspace Location; this is only an initial suggestion and
does not retarget an initialized conversation. Image
uploads remain in the separate image preview area because they are multimodal
inputs rather than workspace file references.

The Host runtime receives the authorized resource form supported by the
selected CLI. A normal Run receives a server-issued ResourceLink plus the
Folder-relative path, so the Agent can read the authorized current workspace
file itself; the file body is not appended to the user message. A manual retry
hydrates the persisted immutable snapshot instead, preserving the original
input for retry semantics. Files & Code
also lets a Project writer create or edit a bounded text file directly. Direct
File-page saves do not create proposals; the previous content is retained for
the page's Rollback action and rollback stops if the file changed afterward.
When a Conversation run changes an authorized Project Folder, a mounted Files &
Code page refreshes that Folder's tree and Git status when the turn settles;
content currently being edited is not replaced.

Remote Folder edits go through the owning online Host. The server sends a
Location id and relative path over the bounded `folder_write` channel; the Host
resolves its own registered directory. Traversal, symlink escapes, secret-like
paths, and files over 1 MiB are rejected.

## Task records

When a conversation records work as a Task, `required_outputs` is reserved for
concrete file Artifacts that must be collected as deliverables. A reply, a
check result, or an edit to an existing workspace file is recorded with the
Task's completion description and report; it is not a required Artifact. If a
Task says a required output is missing, that Task was created with a file-output
contract and must either receive the declared deliverable through the supported
output path or be sent for a person's review.

## Git context and workspace changes

Before initialization, preflight shows the workspace branch, commit, dirty
state, and execution readiness when those values are available. The same
context is recorded in each Host Run at dispatch time.

After initialization, the Conversation keeps a Git admission baseline. A
change to the branch, commit, workspace identity, or execution readiness blocks
the next direct or Room send. Use **Refresh Git context** after reviewing the
change. Refreshing updates the baseline only; it does not switch branches,
commit, push, or deploy.

Managed workspaces do not have a registered Workspace Location, so branch and
commit may be unavailable. The managed workspace identity and readiness still
remain pinned to the Conversation.

## Reviewing changes

After a terminal Host Run, the conversation turn shows a read-only Changes card.
It looks up the exact `remote_diff` Artifact captured for that Run, including
Runs in managed workspaces. If no files changed, the card says so. If the
Artifact is still uploading, the card retries for a short bounded period and
offers a refresh.

Use the link to Files & Code to inspect the Project's current tree, status, or
diff. That view is separate from the Run's immutable diff and is not a commit
or approval surface.

A Folder created with Files & Code's managed-directory flow is initialized as
an empty Git repository, so files created or edited by a Conversation appear in
the Folder's Changes view. Cloned repositories keep their clone history;
connected existing directories and paired-host directories keep their existing
Git state rather than being initialized implicitly.

In Files & Code, selecting a file reads its content and revision history in
parallel. The file appears as soon as its content is ready; history loads in
the background, and switching between already-open files keeps the current view
stable with only a small progress indicator during the read. Returning to a file
already opened in the current Folder shows its cached content immediately while
the server revalidates it; a Folder content-change notification invalidates that
cache.

## Stopping a turn

Select **Stop** on an active turn. The UI first shows a stopping state and then
uses the server's terminal Run state as the authority. A cancelled turn keeps
the partial output that arrived before cancellation and is rendered as
cancelled after the Run settles.

## Draft recovery

Conversation drafts are scoped to their destination and browser tab. A reload
can restore text, uploaded media references, and structured file references.
Drafts are versioned and expire after seven days. They contain no image bytes,
file snapshots, credentials, or absolute Host paths.

Invalid, expired, or no-longer-authorized references are discarded on restore.
A successful send clears the draft; storage failures are non-fatal and must not
prevent sending.

## Retrying a failed turn

Use **Retry turn** on a failed conversation turn. Retry is manual and
idempotent, so repeating the same action does not create duplicate retry Runs.
Rainver reuses the original persisted user message, image/file inputs, Agent
recipients, and pinned execution context. It creates a new linked Run instead of
inserting another user message.

If the original Host, runtime, credential, input capability, or execution
context is no longer usable, retry fails with an actionable preflight error;
Rainver does not silently select a different route.

## Deliberate boundaries

Conversation development does not provide audio/video uploads, arbitrary Host
path browsing, browser-side file writes, an editor or terminal, branch
creation/switching, commits, pushes, deployments, or automatic retry policy.

For the current implementation and API ownership, see
[Conversation architecture](../.agent/architecture/CONVERSATION.md),
[Agent module](../.agent/modules/agents.md),
[Room module](../.agent/modules/rooms.md),
[Files & Code module](../.agent/modules/project-files.md), and
[Host module](../.agent/modules/hosts.md).
