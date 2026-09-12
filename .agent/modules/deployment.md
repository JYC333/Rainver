# Module: Deployment

## Purpose

Define the privileged operator deployment boundary without giving the app or an agent
runtime access to Docker or deployment execution.

## Current Architecture

```text
Host operator                          Instance administrator
  → allowlisted script, or               → POST /api/v1/deployments/jobs
    operator-controlled client             (deployment_jobs row = the approval)
  → private Unix socket                  → deployer poll loop (deployer/poll.py)
    (/tmp/rainver-deployer.sock)           heartbeat every 30s over the
  → privileged deployer process            internal-token channel, claims the job
    (deployer/deployer.py)               → deployer/scripts/update.sh <stage>
  → allowlisted deploy script            → docker compose pull / up -d
    (rebuild | restart | health_check)     server frontend sandbox-runner
  → docker compose pull / restart        → stage events posted back to the server
```

Both entries live in the same process and share nothing else: the socket allowlist
is exactly three job types, the pull loop's is exactly two, and neither takes caller
arguments.

Production compose files reference the images CI publishes to GHCR
(`ghcr.io/jyc333/rainver-<name>:${RAINVER_IMAGE_TAG:-stable}`; see the
`publish-images` job in `.github/workflows/ci.yml`). A prod machine pulls; it
never builds. dev and test still build from the checkout.

The bundled deployer is a separate privileged sidecar with docker.sock, `ops/` mounted
read-only, and the instance mode root mounted at its host path. docker.sock alone is
host-equivalent authority, so its socket is private to that container. It reads
`.deployer.env` (internal token plus the in-network server URL) and runs with
`RAINVER_ENV_FILE_READONLY=1`, which makes the shared ops library refuse to write the
instance `.env` (B43).

The instance-update product trigger is implemented (see *Instance Update*
below): the server holds the jobs, the sidecar's pull loop claims and runs them
beside the socket server, and the instance administrator presses the button in
Instance Settings. Its two entries stay separate — the socket allowlist is
still exactly three argument-less operator jobs, and the pull loop's two job types
never reach it.

## Allowed Job Types

| Job Type | Script | Effect |
|---|---|---|
| `rebuild_rainver` | `deployer/scripts/rebuild.sh` | pull (prod) and recreate server/frontend |
| `restart_rainver` | `deployer/scripts/restart.sh` | restart server/frontend |
| `health_check` | `deployer/scripts/health_check.sh` | check server `/health` |

Building dev and test images is a host operation (`ops/scripts/start.sh --build`): the
sidecar no longer mounts the checkout, so `rebuild_rainver` refuses with that instruction
outside prod rather than handing Compose an empty build context.

No other job type, arbitrary command, caller-selected script, code-patch action,
or capability action is accepted. The three jobs accept no request
arguments, so callers cannot override `PATH`, repository/instance roots, compose mode, or
service names through the socket protocol.

## Active Trigger Inventory

- An operator may execute the allowlisted scripts directly.
- An operator with control of the deployer container may submit an allowlisted job to its
  private Unix socket.
- The instance administrator creates a deployment job through the admin routes below.
- No production server code instantiates or calls `DeployerSocketClient`.
- Evolution, code-patch, capability, agent, automation, job, and scheduler paths have no
  route to deployer input.

## Instance Update

[ADR 0020](../decisions/0020-instance-update-through-deployer-pull.md) is the
decision. The real-machine acceptance is the one open item, recorded in
[`tasks/deferred-register.md`](../tasks/deferred-register.md).

**Data.** `deployment_jobs` (one row per request, with `active_lock` giving the
database the "at most one queued or running job" invariant), `deployment_job_events`
(append-only stage transitions with a bounded log tail), and `deployment_observations`
(one row: what the deployer last saw through docker.sock, plus its last remote
check and the version of the Docker daemon it talks to — `docker_version`, which
is the daemon's, not the deployer's own).

**Admin routes**, instance admin only, no caller arguments beyond the job type:

| Route | Effect |
|---|---|
| `GET /api/v1/deployments/status` | observations, the non-terminal job, the last terminal job, and four derived answers: `update_available`, `updates_supported`, `deployer_online`, `deployer_behind` |
| `POST /api/v1/deployments/jobs` | create `update` or `check_update`; 409 when one is already queued or running; 422 for an `update` outside production; 503 for an `update` with no deployer reporting |
| `GET /api/v1/deployments/jobs` | recent jobs |
| `GET /api/v1/deployments/jobs/:id` | job plus its events |
| `POST /api/v1/deployments/jobs/:id/cancel` | only from `queued` |

Creating the row *is* the ADR 0017 §1 human approval. No Proposal, no Agent,
automation, job, or scheduler path can create one.

**Internal routes**, internal token only: `POST /internal/deployment/heartbeat`
records the observation and hands back the queued job (claiming it exactly once),
`POST /internal/deployment/jobs/:id/events` appends one stage transition, and
`GET /internal/deployment/drain` reports how many Runs are running. The deployer
cannot create a job through any of them.

Two fields on that channel carry identity rather than content. A heartbeat names
the deployer sending it (`deployer_id`, the container's own name, stable across a
restart of the process inside it), which is recorded as `claimed_by` when a job is
claimed. A stage report names itself (`event_id`, kept across the deployer's
retries), and `(job_id, event_id)` is unique: a report whose response was lost is
retried, and without it the append-only audit would grow a duplicate — or refuse a
retried terminal report because its own first attempt had already ended the job.

**Stages** reported by the deployer, in order: `pull`, `drain`, `migrate`,
`recreate`, `health` — plus `remote_check` for a `check_update` job. Each one but
`drain` is `deployer/scripts/update.sh <stage>`; `drain` is an HTTP poll of
`GET /internal/deployment/drain`, which is the pull loop's own connection and token
rather than a shell command. `recreate` restarts the server, so posting an event
retries across the gap: a stage that ran is never missing from the job's audit
because its own control plane was restarting. `migrate` records the dump path and
`health` its result on the job, so recovery does not depend on reading a log tail.

An `update` is refused outside production at creation, not queued and failed: dev and
test build their images from a checkout the sidecar does not mount, and a queued job
would pause every unattended Run until it failed. `update.sh` refuses the same way if
it is ever reached. `check_update` is allowed everywhere — reading which build is
running is useful on any instance. ADR 0020 §5
names backup and migrate separately; `migrate.sh` performs both in one invocation
that refuses to migrate on a failed dump, so it is reported as one `migrate` stage
whose log tail carries the dump path. A `failed` stage ends the job at that stage;
nothing rolls back automatically.

**What an update does not carry.** It moves the four services' images and
nothing else. The compose files, `ops/scripts` and `migrate.sh` the stages run
are the *host checkout's*, mounted read-only, and the deployer's own image is
never recreated (ADR 0020 §6). A release that changes any of them needs a host
step — `git pull && ops/scripts/start.sh --prod` — and the update button cannot
perform it. `deployer_behind` makes the skew visible instead of silent, and it compares
content rather than commits: every image CI publishes carries
`com.rainver.deployment-surface`, a content digest of `deployer/` and `ops/`,
and the deployer reports it beside `org.opencontainers.image.revision` for each
service. The commit would be the wrong comparison — an update cannot recreate
the deployer, so its commit differs from the server's after *every* update
whether or not anything about it changed, and an alarm that is always on is no
alarm. The surface differs only when that part of a release actually moved, and
the panel turns it into the host command. Null when either image carries no
label, which is every locally built instance. The `ops/` checkout itself
carries no version the instance can read, so the deployer's image is the proxy
for it — they move together in the one command that moves either.

The same asymmetry bounds the internal contract: `/internal/deployment/*` is
parsed by strict schemas on both sides, and the deployer is the peer an update
cannot upgrade. A change to that wire contract is therefore a change that
requires the host step, not one an instance can adopt by pressing Update.

**Drain.** While an `update` job is queued or running, three shared admission points
consult one predicate (`instanceUpdatePending`):

- `scanAutomationsAndFire` skips the tick, so a due automation stays due — no
  schedule advances, no operational alert, no Run.
- The `agent_run` job handler defers a queued Run whose *effective* trigger origin
  is `automation`, `autonomous`, `job`, or `system`. Effective, because a delegated
  child carries `delegation` and inherits the question from its root
  (`effectiveRunTrigger`) — reading the raw column would make one hop of
  `agent.delegate` a way past the drain. The parent is parked in
  `waiting_for_dependency` while its child runs, so it is not counted by the drain
  and deferring the child does not stall it.
- The job families that start an unattended Run themselves instead of enqueueing
  `agent_run` (`UNATTENDED_RUN_JOB_TYPES`: daily capture report, source
  post-processing, source annotation) are deferred by job type, wrapped once where
  the handler registry is built.

Together these stop every unattended Run that would occupy the instance for any
length of time. They are not a claim that no row appears in `runs`: a workflow
action node still records its own already-terminal Run, and a research pipeline job
still creates queued Runs whose dispatch then defers. Neither keeps the drain from
converging, and the drain proceeds on its timeout with a known count either way.

A deferral returns the attempt to the job (`deferJob` decrements it), so no Run
fails for this. Conversation Runs are unaffected, and so is a `delegation`-origin
child: deferring one would strand the parent Run that is already running and
already counted by the drain.

**Surface.** `apps/web/src/modules/instance_settings/UpdatePanel.tsx` is the only
administrator-facing entry: the running build (the digest the server compares, with
the image's commit beside it), the latest digest on the configured channel and when
it was read, the two
buttons, the stage list of the job in flight or the last one, and on failure the
stage that failed with its output and the pre-migration dump path. Before the
buttons it states what would otherwise be found out by pressing one: that this
instance does not run updates, that no deployer is reporting, and that the
deployer is on a different build and the host step is due. A job the server
ended for a lost deployer is described as interrupted rather than as a stage
that failed. Cancel appears
only while a job is still queued, because a queued update pauses unattended work
and nothing else can release it before the thirty-minute sweep. The panel follows
an active job every few seconds and keeps reading briefly after it ends, since
what the instance runs is rewritten by the deployer's next heartbeat rather than
by the job. It offers no channel switch and no rollback — both are host
operations (ADR 0020 §3).

**Liveness.** The pull loop is supervised rather than fired and forgotten: if it
ever ends, `deployer.py` exits so the container's restart policy
(`restart: unless-stopped`) brings both entries back. That policy is the only
thing that can restart this container — nothing in the product may stop or
recreate it, and a loop that died inside a container that stayed up would leave
an instance that looks healthy and never beats again.

A job is only created when something is there to claim it: an
`update` is refused with 503 when the last heartbeat is older than three minutes
(six missed beats), because a queued update defers every unattended Run from the
moment it exists and only the half-hour sweep would release them. `check_update`
costs the instance nothing and may wait for a deployer that is restarting. A
heartbeat from the deployer that *holds* a running job fails that
job immediately: the loop cannot beat and execute at the same time, so the beat
proves that job's executor died and came back. A beat from a different deployer —
a container being replaced, or the host-run process the deployer README documents —
proves nothing about it and leaves it to the sweep, because failing it would mark a
job finished while another process's Compose commands were still changing the
instance. The
`deployment_lost_deployer_sweep` scheduler task is the backstop for a deployer that
does not come back — an hour without progress is `deployer_lost`, thirty minutes
queued and unclaimed is `deployer_unavailable`. Neither names a stage that
finished: the failing stage of a job the *server* ended is read off the event
stream, and only a last event that is still `started` names one. Taking
`current_stage` would mark a stage the audit shows succeeding as the one that
failed. The first threshold exceeds the
deployer's own per-stage budget of thirty minutes, so a slow pull is not swept while
it is still working. Both bounds matter: a non-terminal job defers every unattended
Run, so without them a stopped deployer would pause scheduled work indefinitely and
block every later update.

## Security

- Dev Compose forwards `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` from the instance
  `$RAINVER_ROOT/dev/.env` to Vite. Set one exact private-proxy hostname (no
  scheme or port) when accessing dev through Tailscale Serve, then recreate the
  frontend container. Vite 6 accepts one additional host through this variable;
  leave it unset for the default host checks. Machine-specific domains stay out
  of the source configuration.
- The deployer socket is private to the privileged sidecar and is never exposed on TCP.
- The sidecar's repository mount is `ops/` read-only; it holds no writable checkout.
  Compose volume sources are resolved by the host daemon, so the mode root is mounted at
  its host path and `RAINVER_HOST_MODE_ROOT` carries that path to
  `ops/scripts/lib/local-compose.sh`.
- Filesystem permissions are defense in depth, not proof of human approval.
- The deployer holds no database connection of its own and no application
  credentials, but the `migrate` stage is a database operation: `migrate.sh`
  takes a full `pg_dump` through `compose exec postgres` and then applies
  migrations in a one-shot `server` container. Compose also interpolates
  `POSTGRES_PASSWORD` from the instance `.env` for it. Nothing reads user data
  into this container — the dump is written to the mode root the instance
  already owns — and no product path can reach any of it, but "the deployer
  never touches the database" is not the boundary. docker.sock already implies
  this authority; the boundary that matters is who may create the job.
- Production Compose publishes the Nginx frontend on `127.0.0.1:28400` and the
  provider proxy on `127.0.0.1:28421` by default. Operators may override the
  bind addresses and ports through `RAINVER_WEB_*` and `PROVIDER_PROXY_*` in
  the production environment file; widening a bind is an explicit exposure.
- Nginx accepts any Host name (`server_name _`); `FRONTEND_URL` controls auth
  redirects, not a Host allowlist. Domain deployments therefore enforce the
  public hostname and TLS at their reverse-proxy edge.
- The dev, test, and production env templates contain deployment inputs only. Backup
  capability/root/database access stay in env; backup schedule/retention and
  content-access-log retention are instance-scoped product settings managed by
  an instance admin in the UI.
- The instance must not be exposed directly to the public internet; TLS termination, rate
  limiting, and general CSRF-token hardening are prerequisites for reconsidering that rule.

## Verification Not Covered By CI

Compose resolves volume sources on the host daemon and reads env files, build contexts
and `--env-file` on the client. No CI test can prove both sides agree, because the suite
has no Docker daemon and faking one would only assert the fake. The check is a
real-machine step on an instance:

```bash
# On the host, from the checkout, against a running instance:
RAINVER_MODE_ROOT="$RAINVER_ROOT/prod" \
docker compose --env-file "$RAINVER_ROOT/prod/.env" -p rainver-prod \
  -f ops/compose/docker-compose.prod.yml exec deployer \
  /repo/ops/scripts/db/migrate.sh --mode prod
```

It passes when the pre-migration dump appears under the host mode root's `db/dumps/`
and the one-shot server container starts with the instance's own `.server.env` — that is,
when the container resolved the same directories the host daemon did.

## Related Files

- `deployer/deployer.py` — privileged sidecar process (socket server + pull loop)
- `deployer/poll.py` — the instance-update pull loop, observation, and stage reporting
- `deployer/protocol.py` — the socket allowlist and, separately, the pull job types
- `deployer/scripts/` — operator/deployer scripts
- `server/src/modules/deployment/` — job authority, admin and internal routes, dormant socket-client type
- `server/src/db/schema/deployment.ts` — the three tables
- `ops/compose/docker-compose.<mode>.yml` — privileged mounts and private socket setting
- `ops/scripts/lib/local-compose.sh` — host-path resolution and the `.env` write guard

## Related Boundaries

- B41, B42, B43, B44, B44A in `BOUNDARIES.md`
