# Module: Sandbox

## Purpose

Provide Project/worktree isolation and process isolation for every file-capable
managed CLI Run. The application server prepares scope-owned files but never
spawns a vendor CLI. It sends a typed launch request to the dedicated
`sandbox-runner` service over its internal TCP port.

## Scoped Runner contract

The Runner accepts only:

- a registered runtime adapter and selected runtime-tool id;
- the work-scope/run identity and read-only or read-write mode;
- an explicit `none`, `provider`, `tools`, or `provider_and_tools` egress profile;
- managed mount ids rooted in `workspaces`, `sandboxes`, `runtime-tools`,
  run homes, continuity-session homes, or interactive-login homes;
- typed provider, proxy, tool, locale, and Exchange channels;
- argument-vector values, stdin mode, and bounded timeouts.

It does not accept an executable command, shell string, image, host path, or
arbitrary environment map. The Runner resolves every id below its configured
root with real-path containment, derives the executable from the selected
version tree, and rejects duplicate or invalid mount targets.

Each invocation gets a new rootless bubblewrap mount/PID namespace with an
empty root, private `/tmp`, minimal runtime/CA/DNS files, and only these mount
targets:

| Target | Source authority | Access |
|---|---|---|
| `/workspace` | selected Project Folder or run/work-scope sandbox | mode-bound |
| `/delivery` | generated Invocation Delivery staging | read-only |
| `/runtime-tool` | one selected installed runtime-tool version | read-only |
| `/home/sandbox` | one run, continuity-session, or interactive-login home (separate authority roots) | read-write |
| `/run-exchange/input` | Run Exchange input | read-only |
| `/run-exchange/output` | Run Exchange output | read-write |

`/rainver`, sibling Projects, the Rainver source tree and development
guides, server source/dist and HOME, instance secrets, database and log paths,
the Docker socket, and other session/profile stores are not mounted. `none`
egress also receives a new network namespace. The Runner service itself is
attached only to an internal control network shared with the server, not the
database/default network or external Internet. Other egress modes must match
the typed proxy/provider/tool channels in the request. Network reachability is
limited to the server on that internal network; the provider lease and
run-scoped tool token authorize only their corresponding server endpoints. The
CLI cannot route directly to an upstream provider, the database, or another
Compose service.

Runner connection, request validation, executable resolution, mount
containment, namespace construction, or namespace startup failure returns a
sandbox-layer failure. There is no server-subprocess, Docker CLI, or relaxed
namespace fallback.

## Sandbox levels

| Level | Working scope | Runner filesystem mode |
|---|---|---|
| `none` / `dry_run` | no file-capable adapter execution | none |
| `ephemeral` | run-owned throwaway directory | read-write |
| `read_only` | selected Project Folder plus Delivery overlay | read-only |
| `worktree` | detached standalone run/work-scope Git checkout | read-write |
| `one_shot_docker` | critical run/work-scope directory | read-write, normally `none` egress |

The historical level name `one_shot_docker` remains a routing/risk value; it
does not cause the server to invoke Docker. All executable levels use the same
dedicated Runner and per-invocation namespace standard. A lower scope cannot
downgrade a higher required level.

## Run Exchange

File-capable Runs receive a Run-owned Exchange at
`SANDBOX_ROOT/exchange/<space_id>/<run_id>/`, outside both the physical Project
Folder and worktree. The server writes `run_input.v1`; the Runner mounts input
read-only and output read-write. The server validates the input digest and
materializes schema-valid, contained regular output files before cleanup.
Symlinks are never followed.

## Continuity and cancellation

The optional runtime HOME is the only vendor-session state mounted into a
continuing CLI scope. It is selected by a durable CLI binding and is never a
shared server HOME or another binding's profile. The server process registry
stores Runner cancellation callbacks rather than PIDs; terminate/force
terminate frames act on the Runner-owned process group.

## Verification invariants

- managed vendor CLI spawning exists only in `sandbox/runner.mjs`;
- the Codex live quota RPC uses the Runner, while Claude live quota uses its
  server-owned OAuth API and has no application-server PTY fallback;
- interactive login uses the Runner's typed PTY mode, a login-owned workspace
  and HOME, and a short-lived subscription-egress lease;
- `server/src/modules/runs/localCliExecution.ts` contains contracts and remote
  cancellation state only;
- read-only, worktree, ephemeral, and critical paths instantiate
  `SandboxRunnerCliCommandExecutor` unless a focused test injects a fake port;
- runtime boundary probes must read selected workspace + Delivery content and
  prove all forbidden roots are absent;
- Compose mounts only the six narrow Runner authority roots and never mounts the
  source repository, whole `/rainver`, secrets tree, database, logs, or Docker
  socket into the Runner service.

## Related files

- `sandbox/runner.mjs`, `sandbox/Dockerfile`
- `server/src/modules/sandboxRunner/`
- `server/src/modules/runs/vendorCliAdapter.ts`
- `server/src/modules/runs/localCliExecution.ts`
- `server/src/modules/projectFolders/sandbox.ts`
- `server/src/modules/runs/runExchange.ts`
- `ops/compose/docker-compose.{dev,test,prod}.yml`
