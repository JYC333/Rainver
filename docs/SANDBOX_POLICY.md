# Sandbox Policy

## Purpose

Sandboxes provide isolated short-lived environments where agents can make changes
without modifying real workspaces directly.

## Default flow

```
registered workspace
→ create sandbox (git worktree or copy)
→ agent modifies sandbox
→ run validation
→ export diff / log / artifacts
→ user approves
→ apply patch to real workspace
→ clean sandbox
```

## Path policy

Sandbox paths live under `$RAINVER_HOME/sandboxes/` (`SANDBOX_ROOT`, default
`resolve(RAINVER_HOME, "sandboxes")`), outside the source repo. Agents must not
write outside their assigned sandbox directory.

## Retention

A Run's ephemeral sandbox directory is removed on every terminal path
(success, failure, cancel; `runs/ephemeralSandbox.ts`). There is no time-based
sandbox retention period and no setting for one; adapter output is materialized
to artifacts before teardown.

Do not keep the full workspace copy after a sandbox is cleaned.

## Strategy

Prefer `git worktree` over full copies to avoid duplicating large repos.
Exclude `node_modules/`, build artifacts, and compiled binaries from copies.
Use shared dependency caches where possible.
