# Rainver Deployer

Privileged deployment supervisor. It runs two things in one process: a private Unix
socket for operator jobs, and the instance-update pull loop that claims work the
instance administrator created on the server (ADR 0020). The server never pushes into
this container and never talks to Docker itself.

## Why

The deployer sidecar has docker.sock, which is host-equivalent authority. Its Unix
socket stays private to the sidecar so app and agent runtimes cannot bypass product
approval boundaries. Its repository mount is `ops/` read-only, and the instance mode
root is mounted at its host path so that `docker compose` resolves env files and volume
sources to the same directory the host daemon sees.

## Start (as part of Docker Compose — recommended)

```bash
# Bring up the full stack (deployer starts automatically)
cd /path/to/rainver
ops/scripts/start.sh
```

The deployer container has Docker socket access. Its socket is
`/tmp/rainver-deployer.sock` inside that container and is not shared with the server.

## Allowed Job Types

Socket (operator-triggered, no request arguments):

| Job Type              | Script                         | Effect                              |
|-----------------------|--------------------------------|-------------------------------------|
| `rebuild_rainver` | `scripts/rebuild.sh`           | docker compose pull (prod) + up -d  |
| `restart_rainver` | `scripts/restart.sh`           | docker compose restart              |
| `health_check`        | `scripts/health_check.sh`      | server /health, checked in-container |

Pull loop (created by the instance administrator on the server, never reachable
from the socket):

| Job Type       | Effect                                                                  |
|----------------|-------------------------------------------------------------------------|
| `update`       | pull → drain Runs → dump+migrate → recreate server/frontend/sandbox-runner → health |
| `check_update` | read the digest the configured tag points at, from the manifest bytes the registry serves |

## Pull Loop

Every thirty seconds `poll.py` reports what it sees through docker.sock — the image
reference, registry digest and `org.opencontainers.image.revision` of each compose
service, found by compose labels rather than container names — and receives any
pending job in the same response. It runs `scripts/update.sh <stage>` for each stage
but `drain`, which is an HTTP poll of the server's internal drain endpoint, and posts
one event per stage. Reporting retries across the server restart that `recreate`
causes, so a stage that ran is never missing from the job's audit.

The loop is configured by the generated `.deployer.env` (`DEPLOYER_SERVER_URL`,
`SERVER_INTERNAL_TOKEN`). Without both, it does not start and this container is
exactly the operator-only deployer it was before.

Each heartbeat names the deployer sending it — the container's own name, stable
across a restart of this process inside it. The server records it on the job it
hands out, and only a beat from that same deployer releases a job left `running`
by a process that died. Running a second deployer (this container plus the
host-run process below) is therefore safe from the server's side, though they
would still compete for the same queued job. An `update` refuses outside prod:
dev and test build their images from a checkout this container does not mount.

The deployer never recreates itself, never writes `.env`, and never changes the
image tag: channel selection and rollback stay host operations.

## Wire Protocol

Newline-delimited JSON over Unix socket. One request → one response.

**Request:**
```json
{"job_id": "01J...", "proposal_id": "...", "space_id": "personal",
 "requested_by_user_id": "default_user", "job_type": "rebuild_rainver", "target": "local"}
```

**Response:**
```json
{"job_id": "01J...", "status": "succeeded", "exit_code": 0,
 "stdout": "...", "stderr": "", "started_at": "...", "completed_at": "..."}
```

## Alternative: run directly on host (without Compose)

Useful for development or environments where Docker Compose is not running the deployer.

```bash
# Install Python deps (none beyond stdlib)
# Create socket directory
sudo mkdir -p /var/run/rainver

# The jobs need the checkout, the mode root, and the host path of that mode root.
# On the host the last two are the same directory.
REPO_ROOT=/path/to/rainver \
RAINVER_ENV=dev \
RAINVER_HOME=$HOME/.rainver-data/dev \
RAINVER_HOST_MODE_ROOT=$HOME/.rainver-data/dev \
    python deployer/deployer.py

# Or with a custom socket path: add DEPLOYER_SOCKET=/tmp/deployer.sock
```

The process must have Docker CLI access (`docker` on PATH, user in `docker` group or root).

## Security

- Socket is owner read/write, group read/write (`0660`). Restrict the group.
- The container mounts `ops/` read-only and never the checkout; dev and test image
  builds are a host operation (`ops/scripts/start.sh --build`).
- `RAINVER_ENV_FILE_READONLY=1` makes the shared ops library refuse to edit the
  instance `.env` from this container.
- Only allowlisted job types are executed — no arbitrary shell commands.
- Core jobs accept no request arguments or environment overrides.
- The two entries are separate: the socket allowlist is exactly three job types and
  the pull loop's is exactly two, and neither takes caller arguments. The server
  never gains socket or Docker access
  (`.agent/decisions/0020-instance-update-through-deployer-pull.md`).
- The deployer opens no database connection and holds no application credentials.
  The `migrate` stage is still a database operation — a full `pg_dump` and the
  migrations, both run through Compose in other containers — and Compose reads
  `POSTGRES_PASSWORD` from the instance `.env` to do it. docker.sock already
  implies that authority; the boundary is who may create the job.
- An update never recreates this container and never touches the `ops/` checkout
  it runs from. A release that changes the compose files, the ops scripts or the
  server↔deployer contract needs `git pull && ops/scripts/start.sh --prod` on the
  host; the server reports the skew as `deployer_behind`, comparing the
  `com.rainver.deployment-surface` label CI stamps on every image rather than the
  commit — the deployer is a commit behind after every update by design.
- If the pull loop ever ends, this process exits so `restart: unless-stopped`
  restarts the container. That policy is the only thing that can restart it.
