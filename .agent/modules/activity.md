# Module: Activity

## Status
**IMPLEMENTED** — see `server/src/modules/activity/` and `modules/activity-inbox.md` for full detail.

## Purpose
Raw input boundary for raw inputs. Nothing bypasses this layer into active memory.

## Owns
- `ActivityRecord` model
- `ActivityService`
- `/api/v1/activity` routes
- Activity → proposal pipeline

## Key Model

```
ActivityRecord:
  id, space_id, user_id, project_folder_id, agent_id
  source_kind/source_type, source_trust
  title, content
  source_run_id, source_task_id, source_session_id, source_url
  subject_user_id, project_id
  aggregate_key
  status (raw|processed|proposals_generated|failed|archived)
  payload_json, source_integrity_json, entity_refs_json
  occurred_at, processed_at, discarded_at, created_at, updated_at
```

`status` is the single Activity lifecycle. Consolidation uses the same field:
`raw` rows are eligible, duplicate/empty rows become `processed`, successful
proposal generation becomes `proposals_generated`, and worker errors become
`failed`.

## Invariants
- Raw input always creates an ActivityRecord first
- ActivityRecords go through the proposal workflow before becoming memory
- Activity-derived proposals carry Activity provenance in `provenance_entries`
  and may include `source_activity_id` as a pending-proposal compatibility
  shortcut; accepted Memory provenance is written to `provenance_links`
- Activity-derived proposals inherit the source Activity's visibility because
  the proposed content is the Activity's own text.
- The Inbox holds pointers, never content (BOUNDARIES B24A) — see
  `modules/activity-inbox.md` for the full rule
- Pointer/aggregate Activity rows set `aggregate_key` and are not eligible for
  Activity-to-Memory consolidation

## Related Files
- `server/src/modules/activity/`
- `server/migrations/`

## Related Decisions
- [0003-memory-proposal-flow.md](../decisions/0003-memory-proposal-flow.md)
