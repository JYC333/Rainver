# Module: Sandbox

## Run Exchange

File-capable CLI Runs receive a Run-owned Exchange under
`SANDBOX_ROOT/exchange/<space_id>/<run_id>/`, separate from both the physical
Project Folder and its Git worktree:

```text
exchange/
  input/run_input.json
  output/
```

The server writes `run_input.v1`, makes the input directory read-only, and
checks its digest after adapter execution. Docker execution mounts input
read-only and output read-write; local execution receives only the two
allowlisted Exchange path environment variables. Declared output paths are
contained, regular-file-only, size-bounded, and JSON-Schema-validated when
declared. Symlinks are not followed. Undeclared bounded regular files are
candidate Artifacts and cannot satisfy required output declarations.

Materialization copies accepted files to Artifact storage before the raw
Exchange is removed on every terminal/error path. Because Exchange is outside
the worktree, it cannot appear in Project Folder tree, search, Git status, or
patch collection.

## Purpose
Provide risk-proportionate isolation for agent runs. Two distinct concerns:

- **Project Folder isolation** — mutation uses a worktree; read-only work uses
  the real Folder through an OS-enforced mount view
- **Process isolation** — the CLI process itself is contained (filesystem, network, resources)

## Sandbox Levels

| Sandbox Level     | Scope        | CLI runs in                       | Folder isolation | Process isolation | New container? |
|-------------------|--------------|-----------------------------------|---------------------|-------------------|----------------|
| `none`            | —            | nowhere (no adapter exec)         | —                   | —                 | No             |
| `dry_run`         | —            | nowhere (no adapter exec)         | —                   | —                 | No             |
| `ephemeral`       | run          | server throwaway dir (no git)         | ✓ system scratch    | ✗                 | No             |
| `read_only`       | project      | bubblewrap read-only mount view   | ✓ write barrier     | mount namespace   | No             |
| `worktree`        | repo         | server process             | ✓ git worktree      | ✗                 | **No**         |
| `one_shot_docker` | worktree/plain dir | Docker sandbox executor       | ✓                  | ✓                | Yes            |

**File-access adapter rule (`claude_code` / `codex_cli`):** the working-directory
scope is resolved from Project Folder binding + risk (working-dir scope ladder, slice-1):

- **No Project Folder bound + low/medium risk → `ephemeral`** (run-scope): a
  system-provisioned throwaway working dir (no git, no persistent Folder),
  for chat / one-shot / non-coding CLI tasks. Provisioned and torn down by the
  server directly under `$SANDBOX_ROOT/ephemeral/`. **VERIFIED**
  by a real `claude_code` run 2026-06-14.
- **Project Folder bound + low/medium risk → `read_only`** (project-scope):
  zero-copy access to the registered Folder through a rootless bubblewrap
  mount namespace. The real Folder and its existing vendor files are not
  changed.
- **Project Folder bound + high risk → `worktree`** (repo-scope):
  the coding/mutating path with diff → `code_patch` proposal.
- **`high`/`critical` are never downgraded (B13):** high→worktree (needs a
  Project Folder), critical→one_shot_docker. If Docker is unavailable, the run
  fails closed; it never falls back to a server subprocess.

A file-access adapter that resolves to a non-isolating level (`none`/`dry_run`)
fails before the `adapter_started` RunStep with
`error_code=file_access_adapter_requires_worktree_policy`. Resolution lives in
`server/src/modules/runs/orchestrationService.ts` and runtime policy helpers (`resolve_sandbox_level` /
`file_access_sandbox_error`), shared by execution and preflight.

**`read_only` (low/medium risk):**
`PgRunSandboxManager` validates the Folder root without requiring Git and
creates only
`$SANDBOX_ROOT/read-only-context/<space>/<run>`. `ContextCompiler` writes
generated vendor files there. `ReadOnlyCliCommandExecutor` starts bubblewrap,
starts from an empty filesystem view with only system runtime trees and exact
DNS/NSS/linker/CA configuration paths allowlisted (never the whole `/etc`),
reconstructs the selected Folder's top-level entries as recursive read-only
binds, overlays the staged generated entries, and remounts the view root
read-only. Other spaces, Project Folders, host paths, instance state, and
ambient server HOME are absent rather than merely mounted read-only.
The brokered CLI HOME and Run Exchange output are the only persistent writable
mounts; `/tmp` is private tmpfs and network remains shared for subscription
access. Codex's own `sandbox=read-only` is an additional check, not the
boundary. Missing bubblewrap or a blocked user namespace produces
`read_only_sandbox_unavailable`; execution never falls back. Official Compose
keeps the server unprivileged and grants no capabilities, but relaxes Docker's
built-in seccomp profile because it blocks rootless namespace creation.

**`worktree` (high risk):**
The CLI runs as a subprocess of the server process with
`cwd=sandboxes/{run_id}/`.
No new container is spawned. Docker images are no longer the runtime tool
source; vendor CLIs are installed as instance runtime tools under
`$AGENT_SPACE_HOME/runtime-tools` and resolved by `RuntimeToolRegistry`.
Provides Project Folder isolation only — the process has the same access as the
server container.
Appropriate for trusted personal/family use where you control the deployment.

**`one_shot_docker` (critical):**
The server prepares the same run-scoped worktree/plain directory used for the
run, then `DockerCliCommandExecutor` mounts it at `/workspace`. The executor
mounts the instance runtime-tools tree read-only and at most one credential
profile read-only. It uses `--network none`, a read-only root, dropped
capabilities, `no-new-privileges`, PID/CPU/memory limits, and bounded tmpfs.
Provider-proxy and network-profile execution is rejected until an explicit
egress-enabled Docker policy is reviewed.

## Owns
- `SandboxManager` — creates sandbox environments per run
- `SandboxContext` — per-run state (level, path, is_git_worktree, execution_mode)
- `ReadOnlyCliCommandExecutor` — rootless mount-namespace Project Folder view
- `DockerExecutor` — runs commands inside one-shot Docker containers
- Host path translation (`_resolve_host_path()` via /proc/self/mountinfo)
- Docker concurrency limiter (`get_docker_semaphore()`)
- `PathPolicy` — validates Project Folder file access paths

## Worktree Flow (high risk)

```
real Project Folder (git repo)
    ↓  git worktree add --detach sandboxes/{run_id}
sandboxes/{run_id}/          ← agent's CWD, has full git history
    ↓  ContextCompiler writes CLAUDE.md / AGENTS.md here
server CLI executor: subprocess(["/aspace/runtime-tools/claude_code/active/.../claude", "--print", ...], cwd=sandboxes/{run_id})
    ↓  CLI runs as subprocess inside the backend process (no new container)
diff / artifacts created in sandboxes/{run_id}/
    ↓  SandboxContext.cleanup() → git worktree remove --force
```

The Project Folder root must be a git repository; validation fails before sandbox creation if it is not.

## Docker Sandbox Flow

```
sandboxes/{run_id}/          ← writable sandbox dir
    ↓  ContextCompiler writes CLAUDE.md / AGENTS.md here
DockerExecutor: docker run --rm
    -v {host_sandbox_dir}:/workspace      (rw)
    -v {host_runtime_tools}:/runtime-tools (ro)
    -v {host_credential_profile}:/home/sandbox/.runtime-profile (ro, optional)
    --memory=1g --cpus=1 --pids-limit=256
    --read-only --cap-drop=ALL --security-opt=no-new-privileges
    --network=none --tmpfs=/tmp:rw,noexec,nosuid,size=128m
    agent-space-sandbox  claude --print "..."
    ↓  CLI runs inside a new container, isolated from the backend
diff / artifacts in /workspace → visible on host via volume mount
```

## Sandbox Image

Planned one-shot Docker runs use a separately built image:
```bash
docker build --network=host -t agent-space-sandbox sandbox/
```

The sandbox image does not bake in vendor CLIs. Docker execution mounts and
resolves the same instance runtime-tool installation explicitly. The image
reference is configurable through `SERVER_CLI_SANDBOX_IMAGE` and is never
pulled at run time (`--pull=never`).

## Concurrency Control

`threading.BoundedSemaphore(MAX_CONCURRENT_DOCKER_RUNS)` — intended to limit
simultaneous one-shot Docker containers when that path is enabled. Worktree runs are
not counted; they run as backend subprocesses.
Default: 3. Configurable via `MAX_CONCURRENT_DOCKER_RUNS` env var.

## Docker-in-Docker Path Translation

When spawning future one-shot Docker containers, volume paths must be HOST paths (Docker daemon interprets
them relative to the host). `_resolve_host_path()` reads `/proc/self/mountinfo` to translate.

## Context File Injection

Adapters check `self.sandbox_dir is not None`:
- Set → `ContextCompiler.compile()` writes CLAUDE.md / AGENTS.md into sandbox dir; prompt is task goal only.
- None → context JSON is handled in-process by native/API runtimes that do not need a vendor context file.

For `read_only`, `sandbox_dir` is the separate read-only-context staging
directory while the compiler's `workspacePath` remains the real Folder for
context discovery. Staged top-level entries are visible only inside the
namespace and never appear in the physical Folder.

## Cleanup

- Docker container: removed immediately after run (`--rm --init`)
- Sandbox dir: `SandboxContext.cleanup()` → `git worktree remove --force` or `shutil.rmtree`
- Collect artifacts before cleanup

## Invariants
- `claude_code`, `codex_cli`, and `opencode` always run sandboxed (B13); they
  never run at `none`/`dry_run`. A no-Folder CLI run resolves to `ephemeral`;
  a low/medium Folder-bound run resolves to `read_only`; high resolves to
  `worktree`
- `ephemeral` (run-scope) is a system-provisioned throwaway working dir (no git, no persistent Folder), provisioned + torn down by the server under `$SANDBOX_ROOT/ephemeral/<space>/<run>`. No real Project Folder is touched
- `read_only` (project-scope) never writes, chmods, copies, or requires Git from
  the real Folder; only server-owned context staging is cleaned up
- `worktree` (repo-scope): `risk_level=high` → the agent receives a detached git worktree, never the real Project Folder directory
- Project Folder roots outside the configured `WORKSPACE_ROOT` require `ProjectFolder.allow_external_root=true`; validation fails before sandbox creation otherwise
- High risk remains a server subprocess inside a worktree; critical local-CLI
  runs always use the Docker executor and are fail-closed if it cannot start
- CLAUDE.md / AGENTS.md are written to a worktree, ephemeral dir, or
  read-only-context staging dir, never to the real Project Folder
- File changes from a `worktree` run become a `code_patch` proposal; real Project Folder mutation happens only after the proposal is accepted. (Ephemeral runs have no Folder to diff; their output is materialized to artifacts.)

## Related Files
- `server/src/modules/runs/ephemeralSandbox.ts` — run-scope ephemeral sandbox
- `server/src/modules/projectFolders/` — worktree and Project Folder path preparation
- `server/src/modules/projectFolders/pathPolicy.ts` — path and root validation
- `server/src/modules/runs/orchestrationService.ts` — runtime policy enforcement before execution
- `server/src/modules/runtimeTools/` — controlled CLI tool install, active version, executable resolution
- `server/src/modules/runs/vendorCliAdapter.ts` — server generic local CLI runtime path
- `sandbox/Dockerfile` — base sandbox image for critical-risk one_shot_docker runs
- `server/src/modules/runs/localCliExecution.ts` — local and Docker CLI executors
- `server/src/modules/providers/cli/hostPath.ts` — host path translation for daemon mounts

## Related Decisions
- [0005-desktop-runtime.md](../decisions/0005-desktop-runtime.md)
