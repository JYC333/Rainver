# Module: Server Status

## Status
**PARTIAL** — `GET /api/v1/status` is implemented for the components the server
observes from inside its own process (database, scheduler, per-task liveness,
jobs worker, queue depth). Provider/adapter/capability/sandbox components and
the `RuntimeStatusBar` UI are not built.

## Purpose
Surface the operational health of the agent-space runtime to the user. Users must be able to see at a glance whether the backend, adapters, capabilities, and external integrations are reachable and functioning. This is not monitoring — it is a user-facing status display integrated into the product shell.

## Owns
- Runtime status API endpoint (`GET /api/v1/status`)
- Per-component health checks (db, adapters, capabilities, LLM provider)
- `RuntimeStatusBar` UI component (always visible in shell)
- Status detail modal (expandable from status bar)

## Does Not Own
- Alerting or paging (not in scope)
- External monitoring dashboards (e.g., Grafana)
- Log storage (instance/logs/)

## Status Components

Implemented:

| Component | Check | ok | degraded | error |
|---|---|---|---|---|
| `database` | `SELECT 1` | reachable | — | unreachable |
| `scheduler` | worst per-task health | all tasks healthy | some task `failing` | some task `stalled`, or background services not running |
| `jobs_worker` | live worker id in this process | running | not running, nothing queued | not running while jobs are pending |
| `jobs_queue` | instance-wide pending/running counts | counted | depth unreadable | pending work with no worker |

Not implemented — deliberately absent rather than reported healthy on no
evidence: LLM Provider reachability, per-adapter runtime tools
(`claude_code` / `codex_cli`), capability load results, sandbox runner.

## Scheduled-task liveness

`scheduler_tasks[]` reports each task's `health`, `state`, `last_started_at`,
`last_success_at`, `last_failure_at`, `last_error`, `consecutive_failures`,
`timeouts_total`, and `seconds_since_completion`.

`health` is:

- `ok` — completed successfully and is not overdue;
- `pending` — registered, has not completed a first pass yet;
- `failing` — the last pass raised, and the loop is still turning;
- `stalled` — no pass has *completed* for
  `max(interval × 3, timeout + interval)`.

The distinction matters: `failing` is loud (it raises, alerts, and is visible),
`stalled` is the silent failure this surface exists for — a task whose `run()`
never settles stops forever while the process stays healthy.

Each task has a reporting deadline (`DEFAULT_TASK_TIMEOUT_SECONDS`, 600s, or
its own `timeoutSeconds`). Exceeding it records a timeout, emits the same
`scheduler_task_failed` operational alert as a thrown error, and blocks further
passes of that task until the outstanding one settles so hung passes cannot
pile up. A timed-out pass is **not** cancelled — a bare promise has no
cancellation — so the deadline reports, it does not abort.

## API Endpoint

```
GET /api/v1/status          # requires an authenticated space owner/admin

Response:
{
  "overall": "ok" | "degraded" | "error",
  "components": [ { "name", "status", "detail" }, ... ],
  "scheduler_tasks": [ { "name", "health", "last_success_at", ... }, ... ],
  "version": "...",
  "checked_at": "ISO datetime"
}
```

Returns 503 when `overall` is `error`.

**Authorization.** Task names, last-error text, worker id, and instance-wide
queue depth are operator data, so the route requires an active `owner`/`admin`
membership — the same audience as instance operational alerts.

Database reachability is checked *before* authorization, so the endpoint still
answers when PostgreSQL is down (the invariant below) without handing internals
to a caller who could not be authorized: that path returns 503 with only the
`database` component and an empty `scheduler_tasks`.

`/health` and `/api/v1/server/health` are unchanged and stay a plain container
probe: 200 with `{"status":"ok","service":"server","checks":{"database":"ok"}}`
after a successful `SELECT 1`, 503 otherwise. They intentionally stay 200 while
a scheduled task is stalled — that is why `/api/v1/status` exists.

## UI: RuntimeStatusBar

- Persistent bottom or top bar (see frontend-layout.md — bottom panel)
- Shows: overall dot (green/yellow/red) + short text ("Connected" / "Degraded" / "Error")
- Click → opens status detail modal
- Auto-refreshes every 30 seconds (or on WebSocket event in future)

## UI: Status Detail Modal

- Table of all components with status + detail string
- "Last checked" timestamp
- "Refresh" button (triggers manual re-check)
- Link to logs (if accessible)

## Degraded vs Error

- **Degraded**: system can still function but with reduced capability (e.g., no Docker → Local executor only; Codex adapter missing → Claude only)
- **Error**: a critical component is down (db unreachable, no LLM key) and agent runs will fail

## Invariants
- Status endpoint must respond even when DB is unreachable (check DB as a component, don't depend on it to respond)
- Status must never expose secrets (API keys must not appear in response)
- `overall` is the worst component status — if any component is `error`, overall is `error`
- A component the server has no evidence about is omitted, never reported `ok`
- Absence of a background component is a condition of its own: no jobs worker
  is `degraded` when nothing is queued and `error` when work is waiting
- RuntimeStatusBar is always visible; cannot be hidden by user (collapses to dot icon on mobile)

## Related Files
- `server/src/modules/system/routes.ts` — `/health`, `/api/v1/status`, features
- `server/src/modules/system/statusService.ts` — component status computation
- `server/src/modules/scheduler/registry.ts` — per-task deadline and liveness
- `server/src/modules/scheduler/runtimeStatus.ts` — process-local handle the status route reads
- `server/src/config.ts` — settings and diagnostics
- `apps/web/src/components/` — TODO: RuntimeStatusBar, StatusDetailModal

## Related Modules
- [product-shell.md](product-shell.md) — RuntimeStatusBar lives in the shell
- [frontend-layout.md](frontend-layout.md) — bottom panel / status area
