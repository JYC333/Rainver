# Sandbox Policy

## Purpose

Sandboxes provide isolated short-lived environments where agents can make changes
without modifying real workspaces directly.

## Current paths

A CLI Run's working directory belongs to the host daemon. The daemon writes
that directory for the run and removes it with the run. Do not provision
`server/src/modules/runs/ephemeralSandbox.ts` for a daemon Run. There is no
time-based retention period and no setting for one.

A server-side project-folder sandbox (`server/src/modules/projectFolders/sandbox.ts`)
is a detached git clone under `$RAINVER_HOME/sandboxes/` (`SANDBOX_ROOT`). It
keeps the Git object database inside the selected sandbox. Do not mount the
source repository's absolute `.git/worktrees/*` path into the runtime
namespace. That sandbox is not the vendor CLI working directory.

Task worktrees are `git worktree add` in `packages/host-daemon/src/taskWorktree.ts`.
`worktree` and `one_shot_docker` are not daemon workspace kinds. Only
`read_only` narrows a daemon Run's workspace access.

## Path policy

Sandbox paths for the server-side clone live under `$RAINVER_HOME/sandboxes/`,
outside the source repo. Do not write outside the assigned sandbox directory.

Do not keep the full workspace copy after that sandbox is cleaned.
