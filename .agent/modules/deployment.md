# Module: Deployment

## Purpose

Define the privileged operator deployment boundary without giving the app or an agent
runtime access to Docker or deployment execution.

## Current Architecture

```text
Host operator
  → allowlisted script, or operator-controlled client inside deployer container
  → private Unix socket (/tmp/rainver-deployer.sock)
  → privileged deployer process (deployer/deployer.py)
  → allowlisted deploy script (deployer/scripts/)
  → docker compose build/restart server frontend
  → health check
```

The bundled deployer is a separate privileged sidecar with docker.sock and the repository
mounted read-write. Those mounts give it host-equivalent authority, so its socket is private
to that container. The server deployment routes are authenticated but fail closed with 501;
deployment job persistence and proposal-gated submission are not implemented.

## Allowed Job Types

| Job Type | Script | Effect |
|---|---|---|
| `rebuild_rainver` | `deployer/scripts/rebuild.sh` | build and recreate server/frontend |
| `restart_rainver` | `deployer/scripts/restart.sh` | restart server/frontend |
| `health_check` | `deployer/scripts/health_check.sh` | check server `/health` |

No other job type, arbitrary command, caller-selected script, code-patch action,
or capability action is accepted. The three jobs accept no request
arguments, so callers cannot override `PATH`, repository/instance roots, compose mode, or
service names through the socket protocol.

## Active Trigger Inventory

- An operator may execute the allowlisted scripts directly.
- An operator with control of the deployer container may submit an allowlisted job to its
  private Unix socket.
- Authenticated `GET /api/v1/deployments/jobs` returns an empty list.
- Authenticated `POST /api/v1/deployments/jobs` and job-detail routes return 501.
- No production server code instantiates or calls `DeployerSocketClient`.
- Evolution, code-patch, capability, agent, automation, job, and scheduler paths have no
  route to deployer input.

## Future Product Trigger

A product/API deployment trigger remains deferred. It must authenticate an authorized
operator, verify a human-approved proposal in the database, persist a durable audit/job
record, and only then submit one of the three core allowlisted jobs. The deployer protocol
does not and cannot verify database proposal state by itself.

## Security

- The deployer socket is private to the privileged sidecar and is never exposed on TCP.
- Filesystem permissions are defense in depth, not proof of human approval.
- The deployer never reads or writes the application database or user memory.
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

## Related Files

- `deployer/deployer.py` — privileged sidecar process
- `deployer/protocol.py` — exact job allowlist
- `deployer/scripts/` — operator/deployer scripts
- `server/src/modules/deployment/` — fail-closed routes and dormant socket-client type
- `ops/compose/docker-compose.<mode>.yml` — privileged mounts and private socket setting

## Related Boundaries

- B41, B42, B43, B44, B44A in `BOUNDARIES.md`
