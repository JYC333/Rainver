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

Design notes: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §4.

## Related Modules
- [project-files.md](project-files.md)
- [proposals.md](proposals.md)
