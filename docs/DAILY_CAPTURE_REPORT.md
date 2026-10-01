# Daily Capture Report

## Overview

Daily Capture Report is a built-in optional feature (not a plugin or capability). It is
controlled by per-user/per-space settings stored under the scoped settings key
`daily_capture_report.settings`; scheduler state is stored separately in
the scheduler-owned `scheduler_tasks` table.

When enabled, the scheduler enqueues a `daily_capture_report` job each day at the
configured local time. A manual run can always be triggered via
`POST /api/v1/daily-capture-report/run` regardless of whether scheduled execution is enabled.

## Data flow

```
user_capture ActivityRecords (local day)
    │
    ▼
DailyCaptureReportService.generate_for_date()
    │
    ├─ Creates Run (run_type=reflection, trigger_origin=automation|manual)
    │
    ├─ Calls LLM provider → validated StructuredDailyReport JSON
    │
    ├─ Creates Artifact (artifact_type=daily_capture_report) ← ALWAYS FIRST
    │
    ├─ Optional: pending knowledge_create proposals (experience, item_type=experience)
    │           ← requires create_experience_proposals=true + confidence threshold
    │
    └─ Optional: pending memory_create proposals
                ← requires create_memory_proposals=true + confidence threshold (default off)
```

## Key invariants

- **Report always writes Artifact first.** The Artifact is created before any proposals.
- **No direct Memory or Knowledge writes.** All durable writes require the user to review
  and accept proposals via the standard Proposal workflow.
- **Experience proposals are optional and review-gated.** Default: enabled.
- **Memory proposals are optional and review-gated.** Default: enabled.
- **Provenance trust is not upgraded by the report run or artifact.** Memory proposals carry
  `source_trust=user_confirmed` from the original `user_capture` Activity rows.
  The report run and artifact are stored as `source_refs_metadata`, not as trust-bearing
  provenance entries.
- **Idempotency.** For a given space/user/date, a second run without `force=True` returns the
  existing artifact and does not create duplicate artifacts or proposals.
- **Scheduler jobs are idempotent.** Each scheduler task's `next_run_at` is committed immediately
  after a successful enqueue, not after all settings. A duplicate scan skips already-advanced
  slots; a failed enqueue leaves `next_run_at` unchanged so the slot is retried next scan.
  Only the scheduler's slot advance and a schedule settings change move `next_run_at`; a
  finished report, manual or scheduled, records `last_run_at` and the report date only.
- **No removed `/activity/{id}/process` endpoint.** That route was removed. Use `/review` for
  status-only transitions and `/consolidate` for proposal generation.

## Settings (`DailyCaptureReportSetting`)

| Field | Default | Notes |
|---|---|---|
| `enabled` | `false` | Controls scheduled execution. Manual runs are always allowed. |
| `local_time` | `09:00` | HH:MM in the user's timezone |
| `timezone` | `UTC` | IANA timezone name. Invalid values are rejected at the API layer and skipped by the scheduler. |
| `include_source_types` | `["user_capture"]` | Activity source types to include |
| `create_experience_proposals` | `true` | Whether to create experience knowledge proposals |
| `create_memory_proposals` | `true` | Whether to create memory proposals |
| `experience_confidence_threshold` | `0.6` | Min LLM confidence to include experience candidate |
| `memory_confidence_threshold` | `0.7` | Min LLM confidence to include memory candidate |
| `max_experience_proposals_per_day` | `5` | Cap on experience proposals per run |
| `max_memory_proposals_per_day` | `3` | Cap on memory proposals per run |
| `last_report_date` | computed | Last successfully persisted report date; stored in `scheduler_tasks.state_json`. |
| `next_run_at` | computed | Next scheduled UTC time; stored in `scheduler_tasks.next_run_at` and shown in the Settings UI. |

## API

- `GET /api/v1/daily-capture-report/settings` — get or create settings for current user/space
- `PUT /api/v1/daily-capture-report/settings` — update settings
- `POST /api/v1/daily-capture-report/run` — trigger manual run
- `GET /api/v1/daily-capture-report/reports` — list recent report artifacts

## Artifact structure

`artifact_type = "daily_capture_report"`

`metadata_json` includes:
- `report_type`: `"daily_capture_report"`
- `report_date`: `"YYYY-MM-DD"` (local date in the user's timezone)
- `timezone`
- `source_activity_ids`: list of ActivityRecord IDs used
- `capture_count`
- `structured_report`: full validated LLM JSON
- `provider_type`, `model`, `service_version`, `setting_id`

## Job handler

Job type: `daily_capture_report`

Payload:
```json
{
  "space_id": "...",
  "user_id": "...",
  "setting_id": "...",
  "local_date": "YYYY-MM-DD",
  "timezone": "...",
  "trigger_origin": "automation",
  "force": false
}
```

## Scheduler configuration

The background scheduler is controlled by two config settings (env vars):

| Setting | Default | Notes |
|---|---|---|
| `DAILY_REPORT_SCHEDULER_ENABLED` | `true` | Set to `false` to disable the scheduler entirely (e.g., when an external cron drives reports). |
| `DAILY_REPORT_SCHEDULER_INTERVAL_SECONDS` | `60` | Seconds between scans. Minimum 30; values below 30 are rejected at startup. |

The scheduler scans immediately on startup, then sleeps between subsequent scans.

### DST / timezone semantics

- The scheduled time is local-calendar based: the report runs at `local_time` in the
  user's `timezone` each day.
- `next_run_at` is stored in UTC, derived from the prior scheduled local slot plus one
  calendar day (same hour/minute in local time).
- On DST spring-forward nights, a nonexistent local time is adjusted forward by Python's
  `zoneinfo` — the report may run ~1 hour earlier (UTC) on that night.
- On DST fall-back nights, `zoneinfo` uses `fold=0` (the first occurrence of the
  ambiguous hour) — the report may run ~1 hour later (UTC) on that night.
- Jobs are never skipped on DST transition days.

## Module location

`server/src/modules/dailyReports/`

- `repository.ts` — scoped user settings plus scheduler task state access
- `service.ts` — report generation service
- `routes.ts` — HTTP routes
- `index.ts` — module registration
- `server/src/modules/jobs/` — durable job handler/worker registry
- `server/src/modules/scheduler/` — scheduler task state store and periodic tick registry
