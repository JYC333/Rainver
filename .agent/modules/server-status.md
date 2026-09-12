# Module: Server Status

## Status
**API ONLY** — `GET /api/v1/status` reports database, scheduler, per-task
liveness, jobs worker, and queue depth. There is no `RuntimeStatusBar` in
the shell and no provider/adapter/capability/sandbox probes.

## Purpose
Operational health of the components the server can observe from its own
process. This is not an external monitoring dashboard.

## Owns
- `GET /api/v1/status`
- The checks listed below

Unimplemented chrome: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §8.

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

## Degraded vs Error

- **Degraded**: a non-critical observed component is unhealthy (scheduler
  task `failing`, jobs worker absent with an empty queue).
- **Error**: a critical observed component is down (database unreachable,
  jobs pending with no worker, a scheduler task `stalled`).

The API does not probe LLM keys, adapters, or Docker. Those absences are
omitted, not reported as `ok` or `error`.

## Invariants
- Status endpoint must respond even when DB is unreachable (check DB as a component, don't depend on it to respond)
- Status must never expose secrets (API keys must not appear in response)
- `overall` is the worst component status — if any component is `error`, overall is `error`
- A component the server has no evidence about is omitted, never reported `ok`
- Absence of a background component is a condition of its own: no jobs worker
  is `degraded` when nothing is queued and `error` when work is waiting

## Related Files
- `server/src/modules/system/routes.ts` — `/health`, `/api/v1/status`, features
- `server/src/modules/system/statusService.ts` — component status computation
- `server/src/modules/scheduler/registry.ts` — per-task deadline and liveness
- `server/src/modules/scheduler/runtimeStatus.ts` — process-local handle the status route reads
- `server/src/config.ts` — settings and diagnostics

## Related Modules
- [product-shell.md](product-shell.md) — shell has no status bar today
