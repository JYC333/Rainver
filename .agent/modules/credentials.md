# Module: CLI Credentials

## Design Statement

CLI login state belongs to Rainver, not to individual sandboxes.

Sandboxes receive short-lived, minimal, audited access to one approved CLI credential profile.

Managed Claude Pro/Max and OpenAI Codex subscriptions are a separate
in-process channel. The Providers page lets the configured instance admin run
pi-ai OAuth, stores the returned access/refresh state as an encrypted DB
credential, and exposes only connection/quota metadata. These credentials are
owner-only, never pooled, never copied into CLI profiles, and refreshed under a
database row lock.

Managed subscription endpoints are:

- `GET /api/v1/providers/subscriptions/login/stream?type=anthropic|openai_codex`
- `POST /api/v1/providers/subscriptions/login/input?type=…`
- `POST /api/v1/providers/{provider_id}/subscription/quota`
- `DELETE /api/v1/providers/{provider_id}/subscription`

## Problem

The backend runs inside Docker. CLI tools (Claude Code, Codex, OpenCode) need their login
state at runtime. Without credential management:
- The user must log in manually inside every sandbox → unacceptable.
- The full backend HOME is mounted into every sandbox → security risk.
- CLI login state is untracked and unaudited.

## Solution: CredentialBroker

The `CredentialBroker` (`server/src/modules/providers/cliCredentialBroker.ts`) manages:
- **User-owned profiles** — `cli_credential_profiles` rows are owned by a user and point at managed filesystem login-state directories.
- **Space grants** — `cli_credential_space_grants` makes a profile usable in a space; active-space grants carry `is_default` and `network_profile_id`.
- **Grants** — before each run, the broker resolves an enabled active-space grant and issues a `CredentialGrant` scoped to one profile.
- **Cleanup** — removes per-run temp HOME dirs after the run completes.
- **Audit** — every grant, denied grant, or no-profile failure is recorded in `cli_credential_events`.

## Storage Layout

```
instance/
└── secrets/
    └── cli-credentials/
        └── users/
            └── <owner_user_id>/
                └── <runtime>/
                    └── <profile_uuid>/
```

This directory is private, not committed, and mounted via Docker Compose at `/app/instance`.
Profiles use the per-user `users/<owner_user_id>/<runtime>/<profile_uuid>/`
layout. Runtime/name filesystem profiles are not imported.

## Config File

CLI profile metadata lives in the database:

| Table | Purpose |
|---|---|
| `cli_credential_profiles` | UUID profile, `owner_user_id`, runtime, display name, managed `source_path`, `target_path`, readonly flag, notes |
| `cli_credential_space_grants` | profile-to-space grant, owner, grantor, enabled/default flags, grant-level `network_profile_id` |

CLI runtimes do not fall back to the backend container's default HOME credentials.
Manual and automation runs both require an explicit resolved profile.

`network_profile_id` is grant-level metadata. It is used only when a CLI run
does not bind to a ModelProvider. Provider-bound CLI runs use the selected
provider grant's NetworkProfile because the server-side provider proxy owns
upstream provider traffic.

## Execution Modes

### Worktree Runtime

For high-risk file-access runs, the CLI runs as a subprocess inside a detached
git worktree. The broker:

1. Creates `instance/cache/runtime-homes/<run_id>/`
2. Copies only the runtime's declared credential files into their expected
   path, rejecting symlinked source files and target path components
3. Sets `HOME=<run_id>/` in the subprocess environment

The CLI finds its login state at the expected path without seeing the full container HOME.
If the profile has a `network_profile_id` and the run has no provider binding,
the server injects only `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
`NO_PROXY` env values derived from that NetworkProfile into the CLI subprocess.
Provider API keys still never enter the subprocess env.

```
/app/instance/cache/runtime-homes/<run_id>/
└── .claude/
    └── .credentials.json
```

Lightweight CLI conversation instead uses
`cache/conversation-runtime-homes/<state-key>/`. That HOME persists across
turn processes so the vendor can resume its opaque session id, but remains
private to one user × session backend binding. Each turn refreshes only the
declared credential file and preserves vendor session state. Backend/context
invalidation rotates the unguessable state key and removes the retired HOME;
a 30-day hourly retention sweep removes any orphan left by interruption or
session deletion after excluding keys referenced by a binding or nonterminal
Run. Conversation state is excluded from backup and is never a
credential-profile authority.

If no explicit or active-space default profile grant is resolved, runtime
execution fails before the runtime adapter is invoked with
`runtime_credential_profile_required`.

Critical-risk local-CLI runs use the one-shot Docker executor. The selected
credential profile is mounted at most once and read-only; no host HOME is
passed into the container. Runs fail closed when Docker or the configured image
is unavailable, and networked provider-proxy credentials are rejected by the
MVP deny-by-default network policy.

## Initializing a Profile

```bash
# Step 1: the configured INSTANCE_ADMIN_EMAIL user installs the runtime tool
# through the server installer.
curl -X POST localhost:3000/api/v1/runtime-tools/claude_code/install \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"version":"latest"}'

# Step 2: a space owner/admin enables/selects the runtime version for the space
# through /api/v1/runtime-tools/space-policy or the Runtime page.

# Step 3: run the managed login stream from the frontend or API.
# The server launches the active runtime-tool binary and syncs the
# resulting login state into the selected user-owned profile directory:
#   $RAINVER_HOME/secrets/cli-credentials/users/<owner_user_id>/claude_code/<profile_uuid>/

# Step 4: verify the broker sees it through the default server entrypoint
curl localhost:3000/api/v1/credentials/cli/profiles?runtime=claude_code
```

## Runtime Adapter Credential Spec

Each RuntimeAdapterSpec declares credential behavior in its `credentials`
section. Local CLI runtime adapters use explicit CLI credential profiles;
execution and preflight both require the selected profile source path to exist.

## Audit Events

Every credential usage writes a `CliCredentialEvent` record:

| Action | When |
|---|---|
| `credential.grant` | A profile was found and a grant was issued |
| `credential.grant_denied` | No profile was configured; runtime fails with `runtime_credential_profile_required` |
| `credential.grant_failed` | Grant failed after profile resolution, such as missing source path |

No-profile failures use `credential_source="none"` and
`fallback_reason="no_profile_configured"`. New successful
`container_default` fallback events must not be emitted.

## What Sandboxes Must NOT See

- `/app/instance/db` — database
- `/app/instance/secrets` (except the one granted profile dir)
- Other users' credential profiles
- The backend source root
- SSH keys, AWS credentials, Docker socket (unless explicitly granted)
- The full backend container HOME

## API

```
GET    /api/v1/credentials/cli/profiles                 — list profiles owned by current user
GET    /api/v1/credentials/cli/available?runtime=...    — list active-space granted profiles, no source_path
POST   /api/v1/credentials/cli/profiles                 — create an owned profile and grant it to the active space
PUT    /api/v1/credentials/cli/profiles/{profile_id}/grants — grant owned profile to a space
DELETE /api/v1/credentials/cli/profiles/{profile_id}/grants/{space_id} — disable a grant
GET    /api/v1/credentials/cli/profiles/{profile_id}    — read an owned profile by UUID
POST   /api/v1/credentials/cli/profiles/{profile_id}/detect — check if source_path exists
PATCH  /api/v1/credentials/cli/profiles/{profile_id}    — update active-space grant metadata
```

## Related Files

- `server/src/modules/providers/` — credential broker/store and provider routes
- `server/src/modules/runtimeTools/` — controlled CLI tool installer and active binary registry
- `server/src/modules/runs/vendorCliAdapter.ts` — server CLI adapter profile grant behavior
- `server/src/modules/runtimeAdapters/` — CredentialSpec/runtime spec semantics
- `server/src/modules/runs/vendorCliAdapter.ts` — GenericCliRuntimeAdapter profile grant behavior
- `server/src/modules/runs/` — runtime execution integration and credential mount
- `server/migrations/` — CliCredentialEvent, profile, and grant tables
- `instance/secrets/cli-credentials/` — credential directories (gitignored)
