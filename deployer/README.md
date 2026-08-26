# Rainver Deployer

Privileged deployment supervisor. It runs separately from the main app and is operated
manually; the current product API does not submit deployment jobs.

## Why

The deployer sidecar has docker.sock plus a read-write repository mount, which is
host-equivalent authority. Its Unix socket stays private to the sidecar so app and agent
runtimes cannot bypass product approval boundaries.

## Start (as part of Docker Compose — recommended)

```bash
# Bring up the full stack (deployer starts automatically)
cd /path/to/rainver
ops/scripts/start.sh
```

The deployer container has Docker socket access. Its socket is
`/tmp/rainver-deployer.sock` inside that container and is not shared with the server.

## Allowed Job Types

| Job Type              | Script                         | Effect                              |
|-----------------------|--------------------------------|-------------------------------------|
| `rebuild_rainver` | `scripts/rebuild.sh`           | docker compose build + up -d        |
| `restart_rainver` | `scripts/restart.sh`           | docker compose restart              |
| `health_check`        | `scripts/health_check.sh`      | curl /health                        |

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

# Run with defaults
REPO_ROOT=/path/to/rainver python deployer/deployer.py

# Or with a custom socket path
DEPLOYER_SOCKET=/tmp/deployer.sock \
REPO_ROOT=/path/to/rainver \
    python deployer/deployer.py
```

The process must have Docker CLI access (`docker` on PATH, user in `docker` group or root).

## Security

- Socket is owner read/write, group read/write (`0660`). Restrict the group.
- Only allowlisted job types are executed — no arbitrary shell commands.
- Core jobs accept no request arguments or environment overrides.
- Current jobs are operator-triggered; there is no product submission path.
- A future product path must verify human approval and persist audit state before calling.
- The deployer never reads or writes the database directly.
