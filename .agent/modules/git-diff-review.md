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
- Conversation turns add one read-only, default-collapsed Changes summary per
  request group that queries the exact `remote_diff` Artifact for each completed
  Host Run and links to Files & Code for the current Project state. Managed and
  registered-Location Runs use the same per-Run lookup; the summary never
  mutates a workspace or approves a diff.

## Related Modules
- [project-files.md](project-files.md)
- [proposals.md](proposals.md)
