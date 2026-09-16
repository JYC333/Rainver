# Module: Git Diff Review

## Status
**READS ONLY** — Files & Code under `projectFolders` serves git status and
git diff. There is no DiffReview record, annotation, or approve-to-commit
workflow.

## Current fact
- Routes live on `projectFolders` (tree, file, git status, git diff),
  including remote Locations via `hosts` / `@rainver/folder-read`.
- Code-patch apply and rollback go through accepted `code_patch` proposals
  and `code_patch_snapshots`, not a git-commit review page.
- Conversation turns add a read-only Changes card that queries the exact
  `remote_diff` Artifact for the completed Host Run and links to Files & Code
  for the current Project state. Managed and registered-Location Runs use the
  same per-Run lookup; the card never mutates a workspace or approves a diff.

Design notes: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §4.

## Related Modules
- [project-files.md](project-files.md)
- [proposals.md](proposals.md)
