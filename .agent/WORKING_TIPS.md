# Working Tips

Practical gotchas and non-obvious behaviours discovered during development.
These are facts the codebase doesn't make obvious at a glance.

---

## Project Folders

**Creating a managed Project Folder auto-creates a folder on disk — but only if the Docker volume is writable.**

`POST /api/v1/projects/{projectId}/folders` with neither `repo_url` nor
`root_path` (the "create managed Folder" flow) calls `mkdir()` under
`WORKSPACE_ROOT/<spaceId>/` via `createManagedDir()`. This only works if the
container can write to that mount. In the `ops/compose/docker-compose.<mode>.yml`
files this mount must not be `:ro` (read-only), which would silently
block mkdir. PathPolicy still enforces read-only access at the API layer
for the file browser — the `:ro` Docker flag was redundant.

`repo_url` clones into a managed directory; `root_path` (the "connect
existing" flow) must come from `scanCandidates()` — arbitrary host paths are
never accepted directly.

**Project Folder path resolution** (`projectFolderAbsoluteRoot()` in
`server/src/modules/projectFolders/repository.ts`):
```
folder.root_path is absolute → use as-is
folder.root_path is relative → WORKSPACE_ROOT / folder.root_path
folder.root_path is None     → WORKSPACE_ROOT / folder.id
```
For execution (worktree sandbox), `PgRunSandboxManager.validateFolderRoot()`
additionally enforces that the resolved root is under `WORKSPACE_ROOT` unless
`folder.allow_external_root=true`. Absolute paths outside the managed root
fail unless this flag is set.

---

## Frontend UI Components

**Always use `Select` from `components/ui/select.tsx` for dropdowns.**

Never use a bare `<select>` element — it won't pick up the design system
styling (border, bg-input, ring, dark mode). The custom `Select` takes
`options: { value, label }[]`, `value`, `onChange`, `size` (`sm` | `md`),
and an optional `dropUp` flag.

---

## PathPolicy

**PathPolicy rejects write access to `.py`, `.sh`, and similar source files.**

Agents may not write these directly; they must go through a `code_patch`
Proposal. Read access is allowed. The forbidden write suffixes are declared in
`FORBIDDEN_WRITE_SUFFIXES` in `packages/folder-read/src/pathPolicy.ts`.

---

## Files & Code — No Interactive Session Execution

**There is no interactive agent-session execution over a Project Folder.**

Files & Code routes live inside the registered `projectFolders` module and
are read-only: tree, file, git status, and git diff. The former Workspace
Console's runtime-status/session create/detail/run/stop surface was a
never-implemented stub and has been removed entirely — do not describe it as
a current or planned local CLI execution path.

**RuntimeAdapterSpec owns local CLI command semantics.**

Model flags, permission bypass flags, invocation templates, and output parser
selection are declared in `server/src/modules/runtimeAdapters/specs.ts`. CLI binary install
and status use the server-controlled `/api/v1/runtime-tools` API; the retired
`/api/v1/runtime-adapters` instance API must not be used.

Managed CLI execution belongs to the server `runs` path, which prepares
ephemeral/worktree sandboxes and records evidence, artifacts, and proposals.

---

## Modules

**Module route ownership is explicit in `routeRegistry.ts`.**

Backend routes live in `server/src/modules/<module>/routes.ts`. A module
is active only when its `ServerModule` is listed in
`server/src/gateway/routeRegistry.ts`; unknown `/api/v1/*` routes return
the local server 404 catch-all.

**Frontend module components must be lazy-imported in `registry.ts`.**

Use `lazy(() => import('./module_id/PageName'))`. Non-lazy imports break the
bundle split and slow initial load.
