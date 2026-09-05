# Rainver

A space-based, multi-user, agent-first system for personal, family, and small team use.
The runtime target is **Linux / WSL / server + a browser UI**. By default agent runs are
isolated with **git worktrees** (plus `PathPolicy`) so file access is confined to the run's
workspace. Stronger one-shot Docker isolation is not wired into the current product path;
high/critical-risk execution that requires it fails closed instead of silently downgrading.
PostgreSQL is the only supported server database.

## Concept

```
One deployment instance
  ├── Personal Space
  ├── Family Space
  └── Team Space
```

Each space has its own users, workspaces, memories, permissions, agents, and tool access.

## Repository Layout

```
rainver/
├── README.md
├── CLAUDE.md
├── .gitignore
├── ops/              # Compose files, env templates, and utility scripts
│   ├── compose/      # docker-compose files for dev/test/prod
│   ├── env/          # tracked .env templates; local .env is ignored
│   └── scripts/      # start.sh, db/, system/
├── docs/             # Architecture and design documentation
│
├── server/           # TypeScript API backend and migration owner
├── packages/         # Shared packages
│   └── protocol/     # Wire contract types — single public entry point
├── catalog/          # Built-in system definitions
│   ├── agent_templates/
│   └── capabilities/
├── plugins/official/ # Official optional plugins (installed via PluginHost)
│   ├── diary/
│   └── finance_ledger/
├── apps/web/         # React/Vite web frontend (PWA)
├── deployer/         # Host-side deployer (holds the Docker socket; spawns sandbox containers)
└── sandbox/          # Dockerfile for the agent execution sandbox image
```

Runtime data (DB, config, secrets, logs, workspaces, sandboxes) never lives in the repo.
It lives under a host-side parent `RAINVER_ROOT` (default `~/.rainver-data`), one mode root per
environment: `$RAINVER_ROOT/dev`, `$RAINVER_ROOT/test`, `$RAINVER_ROOT/prod`. Each mode root
is bind-mounted into the containers as `RAINVER_HOME=/rainver`.
Local DB/system scripts use the same compose/env path as `ops/scripts/start.sh`: mode validation,
`$RAINVER_ROOT/<mode>`, `$RAINVER_ROOT/<mode>/.env`, `RAINVER_MODE_ROOT`, compose project,
and `docker compose --env-file ...` are centralized in `ops/scripts/lib/local-compose.sh`.
The local PostgreSQL containers use stable names: `rainver-dev-postgres`,
`rainver-test-postgres`, and `rainver-prod-postgres`.

## Quick Start

```bash
# 1. Start everything (creates ~/.rainver-data/dev/ and .env from template on first run)
./ops/scripts/start.sh

# 2. Add a model provider in the app
#    Open the web app → Providers and paste your API key (stored encrypted; never in .env).
#    ~/.rainver-data/dev/.env holds infra-only settings (e.g. POSTGRES_PASSWORD for --prod).
```

`start.sh` builds the sandbox image on first run, then starts frontend + server + deployer via Docker Compose. Data lives under **`~/.rainver-data/<mode>/`** (default mode `dev`). Browser API traffic reaches the TypeScript server through the frontend proxy.

```
Web UI:           http://localhost:3000   # Docker maps container 5173 → host 3000 (dev compose)
API:              http://localhost:3000/api/v1   # server entrypoint
```

### Options

```bash
./ops/scripts/start.sh           # Docker Compose — dev (default)
./ops/scripts/start.sh --test    # separate ports + ~/.rainver-data/test
./ops/scripts/start.sh --prod    # http://localhost:28400 by default
./ops/scripts/start.sh --build   # force image rebuild
```

Test mode exposes the same API through `http://localhost:3100/api/v1`. The test frontend talks to the server service inside the compose network.
Production binds the web UI to `127.0.0.1:28400` and the provider proxy to
`127.0.0.1:28421` by default, avoiding the development ports. Override
`RAINVER_WEB_BIND`, `RAINVER_WEB_PORT`, `PROVIDER_PROXY_BIND`, or
`PROVIDER_PROXY_PORT` in `$RAINVER_ROOT/prod/.env` when the deployment needs a
different host mapping. Keep loopback binding for local WSL use; use a TLS
reverse proxy and set `FRONTEND_URL` (plus `GOOGLE_REDIRECT_URI` when OAuth is
enabled) to the public origin for domain access.
Docker-native `ops/scripts/db/migrate.sh`, DB-only `ops/scripts/db/{dump,restore,reset-postgres}.sh`,
and offline `ops/scripts/system/{backup,restore,verify-restore}.sh` start PostgreSQL
when needed and stop it after completion only when that script had to start it;
they leave already-running app stacks alone.

## Development

Install all JavaScript dependencies once from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

For server work:

```bash
cd server
pnpm run typecheck
pnpm test
```

Run explicit TS migrations through the ops wrapper:

```bash
./ops/scripts/db/migrate.sh --mode dev
```

### Runtime target

The runtime is **Linux / WSL / server + browser UI**. An `apps/web/src-tauri/` directory exists
but desktop support is **deferred and not part of the current product**. If it ships later it
will be a lightweight launcher (start/stop the server, open the browser) — not a reimplementation
of the backend.

## Sandbox Architecture

LLM agents can execute arbitrary shell commands. To protect the host:

- **Default — filesystem isolation**: git worktrees + `PathPolicy` confine file access to the
  run's workspace. This is the default execution isolation (`default_sandbox_level=worktree`).
- **High-risk — one-shot Docker**: runs that require `one_shot_docker` isolation are refused
  until that product path is implemented. The sandbox image assets exist, but the app must not
  present Docker isolation as active protection for high/critical-risk runs.

The **server does not mount the Docker socket** and does not spawn host containers directly.
The privileged **deployer** sidecar has `/var/run/docker.sock` plus a read-write repository
mount, but its Unix socket is private to that container. The server and agent runtimes cannot
reach it. One-shot Docker sandbox execution remains unimplemented and fail-closed.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full threat analysis.

## Authentication

Local development runs without authentication. Optional Google OAuth sign-in is supported when
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are configured in the mode `.env`.
Persisted API keys are feature-gated and not enabled in the current build.

## Key Concepts

| Term | Meaning |
|------|---------|
| Space | Personal / family / team container; every record is scoped by `space_id` |
| User | A person, may belong to multiple spaces |
| Workspace | A project, repo, or knowledge area within a space |
| Memory | Scoped long-term information; written only via proposal → approval workflow |
| Capability | Code-defined skill registered via `capability.yaml` manifest |
| Sandbox | Per-run isolation; git worktree by default; one-shot Docker-required paths fail closed until implemented |
| Adapter | Execution backend: `echo`, `model_api`, `claude_code`, `codex_cli`, `opencode` |

## Built-in Templates

No concrete agents are seeded. Built-in behavior comes from system **AgentTemplates**
(reusable factories, seeded once globally); a concrete Agent is created on demand via
copy-on-create, and runtime always loads config from its `AgentVersion` — never a template.

There is no `general_chat` template and no DirectChat — chat is the per-space **system-managed
default Assistant** (`agent_kind=system_assistant`), minted from the internal `personal_assistant`
seed spec. That seed spec is `visibility=system_internal`: hidden from the public Template Library
and not user-instantiable (at most one active Assistant per space). The reusable specialized
templates below are the public library:

| Template | Category | Purpose |
|----------|----------|---------|
| `activity_reflector` | reflection | Processes captures/activity into typed proposals + reflection summary; model selects output type |
| `memory_reflector` | memory | Memory update/merge/delete proposals only (no direct write) |
| `knowledge_curator` | knowledge | Proposes semantic KnowledgeItem types, relations, source links (proposal-only) |
| `research_reader` | research | Reads selected sources only (no web search/crawl); summaries, questions, knowledge proposals |
| `coding_reviewer` | workspace | Read-only review/report outputs; no file write, shell, or patch apply |

Memory reflection is also exposed as an internal service (`MemoryReflector` via the
`memory.reflect` capability, `POST /sessions/{id}/reflect`).

## Official Plugins

Beyond the core product, optional feature packages ship as **official plugins** — installed
and enabled per space through the `PluginHost` control plane, each bringing its own backend
module, frontend page, and migrations:

| Plugin | Purpose |
|--------|---------|
| `diary` | Personal journaling |
| `finance_ledger` | Personal finance / ledger tracking |

## Documentation

- Coding-agent instructions: [Codex](AGENTS.md) / [Claude Code](CLAUDE.md) — start here before implementation
- [Agent context and module map](.agent/INDEX.md)
- [Documentation Index](docs/README.md)
- [Architecture](.agent/ARCHITECTURE.md)
- [Backup and Restore](docs/BACKUP_AND_RESTORE.md)
- [Threat Model](docs/THREAT_MODEL.md)

## License

MIT — see [LICENSE](LICENSE).
