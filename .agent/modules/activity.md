# Module: Activity

## Status
**IMPLEMENTED** — see `server/src/modules/activity/` and `modules/activity-inbox.md` for full detail.

Raw ingest, review/archive, single-record consolidation and summary requests use strict keyed operation contracts through their retained URLs and typed clients. Current person, Project/Folder and referenced content authority gates replay. Consolidation keeps the canonical reviewable Memory proposal writer; it never activates Memory. Summary requests return a queued single-attempt `activity_summary` Job, reusing `prepareSummary` / `createSummaryRun`; its current input hash/Source policy/claim, Artifact/proposals, mandatory audit and Job settlement share one transaction. Generic Job views withhold summary payload/results/errors/events.


## Daily capture reports

`dailyReports/` owns the per-person settings, complete local-day selection and
report generation. `POST /api/v1/daily-capture-report/run` is the strict keyed
`daily_capture.run` command; it returns a 202 intent (`job_id`, `run_id`,
`user_id`, current `status`); completed intents also return their original
business result. Active intent flags/snapshot changes refuse with 409. The typed settings page
links to that Run; report history remains the existing authorized GET.

The request and scheduler reuse the same queued ProviderTask Run and one-attempt
`daily_capture_report` Job. The frozen capture/settings versions and complete
Source provenance are discovered before the canonical global release locks;
current account/membership, Folder/Project/content rights, Source consent and
derived-write targets are rechecked before attempt/Delivery, each provider send
and settlement. Provider egress uses the actual model destination and current
Space/Source policy. No transaction spans external I/O. Unknown starts cannot
be blindly retried, and unversioned old Job payloads have no fallback.

Report Artifacts, knowledge proposals and user Memory proposals are private to
the requesting person; a private journal never silently widens to the Space.
The live output audience is that active owner. Memory remains a reviewable
proposal through the existing canonical writer, never active Memory. Result,
Run terminal, mandatory audit, schedule completion and exact claim/attempt Job
settlement commit together. Empty days cancel their queued Run without provider
spend; canonical Job cancellation/reclaim also ends its Run. Generic Job views
withhold report payload, results, errors and event details. Real-PG evidence is
in `dailyReportsDb.test.ts`; route inventory alone is not effect acceptance.

Worker gates retain Source/current-authority locks before Job claim → Run,
matching canonical Job cancellation; failure cleanup also takes Job before Run.
See [Database and Transactions](../architecture/DATABASE_AND_TRANSACTIONS.md)
for terminal-owner admission and nonwaiting reclaim boundaries.

## Purpose
Raw input boundary for raw inputs. Nothing bypasses this layer into active memory.

## Owns
- `ActivityRecord` model
- `PgActivityRepository` (`repository.ts`), consolidation (`consolidationRepository.ts`, `consolidationJob.ts`), and notification pointer rows (`notificationPointers.ts`)
- `/api/v1/activity` routes
- Activity → proposal pipeline

## Key Model

```
ActivityRecord:
  id, space_id, user_id, project_folder_id, agent_id
  activity_type, source_kind, source_trust
  title, content
  source_run_id, source_task_id, session_id (API: source_session_id), source_url
  visibility, access_level, owner_user_id
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
  and set `source_activity_id` on the pending payload. Readers fold that id
  into the provenance list. Accepted Memory provenance is written to
  `provenance_links`. Do not treat `source_activity_id` as the accepted
  provenance record.
- Activity-derived proposals inherit the source Activity's visibility because
  the proposed content is the Activity's own text.
- `access_level=summary` withholds `content` and `metadata_json` from
  non-owners on list/detail. Consolidation requires effective `full` and is
  the record owner's alone (`owner_user_id`, else `user_id`): a reader of a
  shared capture, a Space owner/admin included, is refused with 403 rather
  than turning someone else's record into their own Memory.
- The Inbox holds pointers, never content (BOUNDARIES B24A) — see
  `modules/activity-inbox.md` for the full rule
- Pointer/aggregate Activity rows set `aggregate_key` and are not eligible for
  Activity-to-Memory consolidation
- What a record becomes is decided by where it is
  (`activity/activityMemoryProposal.ts`, shared by the capture endpoint and
  the batch run): a personal record becomes the owner's private Memory; a
  Project's record becomes Project Memory, proposed with `space_shared`
  visibility under that Project so its reviewers can decide it. There is no
  private Memory under a Project. A Project record becomes Project Memory only
  when every Project reader can already read it: otherwise the capture
  endpoint answers `409 activity_share_required`, and the batch run leaves the
  record `raw` and lists it under `activities_awaiting_share` — the owner
  shares it with the Project first. The Memory applier asks the same question
  again when the proposal is accepted

## Related Files
- `server/src/modules/activity/`
- `server/migrations/`

## Related Decisions
- [0003-memory-proposal-flow.md](../decisions/0003-memory-proposal-flow.md)


Daily report retries distinguish effect stages. A failed/cancelled Job before
any dispatch can create a fresh Run with current settings, inputs and flags.
Once dispatch has started, only the owned failure transaction can mark
`daily_report_retry_safe`, and only if neither send-admitted nor effect-started
was recorded. Historical/unknown starts and admitted sends refuse new-key resend;
no status filter alone permits repeated provider I/O. Completed results remain
subject to current Source authority. Active Jobs reuse their identity and expose
queued/running state; the settings page describes completed/running reuse.

The scheduler rolls back business-refused admission to its local savepoint,
requires the policy audit, and atomically advances the slot with a content-free
`last_slot_outcome` (HTTP status only). SQL/audit/infrastructure failures roll
back the whole slot for retry. Consent/retention refusal and an already-admitted
manual day's changed snapshot no longer strand all following local days.


### File and voice upload

`POST /api/v1/activity/upload` is the formal multipart adapter for strict keyed
`activity.upload`, also available through the generic command entry. It is a
business command, not a transport exemption. Fields are kind, filename/media
type, bytes, title/note and optional Project/Folder; storage paths and actor/
worker identity cannot be supplied. Files remain bounded to25 MiB, title/note
to32768 characters. Unknown/duplicate multipart fields refuse.

Admission atomically records mandatory policy audit, operation receipt and a
single-attempt `activity_upload` Job with a reserved Activity id. It returns202
`{job_id,activity_id,status:'queued'}`; the typed capture consumer describes it
as queued, never saved. Personal/Project placement and replay use the same
current authority closure as raw Activity creation. Generic Job reads/events
withhold upload inputs, results, errors and diagnostics.

The Activity owner stores exact private transport bytes in the newly admitted
Job payload; generic evidence sanitization would truncate/corrupt those bytes.
No generic sanitizer is disabled. The worker trusts only stored input/hash,
current account/Project/Folder authority and the exact current Job claim.
It performs an exclusive file write outside transactions after claim admission;
Activity creation, mandatory settlement audit, byte-payload removal and Job
completion commit together. Memory still requires the existing reviewable
proposal/provenance owner.

Reclaimed, cancelled or unknown-start jobs cannot repeat the file write.
Initial admission, directory preparation and settlement failures enter the same
cleanup. Under the actual Job row lock it checks the reserved Activity's
committed existence and the current claim/attempt. Input removal is independent
of file deletion: committed Activity, known terminal status, or this exact
owner's non-repeatable attempt permits removing only `input`; another active
owner and unknown states retain necessary transport. Metadata, size, hash and
Activity id remain for current-authority replay. Storage is removed only for
this invocation's successful write and proven absence of its Activity.

Canonical Jobs completion, queued/running cancellation, exhausted failure and
terminal reclaim remove upload `input` in their existing status/claim-guarded
write, including paths that never invoke the handler. Retryable attempts retain
input. No cleanup moves file I/O into a transaction or changes Job → Run or
current-authority lock ordering. If the database cannot be reached, or a process
crashes before reaching a trustworthy terminal/cleanup decision, private input
or an unreachable file may remain until an existing owner can settle it; no
storage scavenger or automatic resend is introduced. No Source, P4 or schema authority is widened.
