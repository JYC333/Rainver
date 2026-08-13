# Module: Activity Inbox

## Status
**IMPLEMENTED** — model, service, and API routes live in `server/src/modules/activity/`.

## Purpose
Raw-input layer (L0). Everything entering the system lands as an `ActivityRecord` first — never directly as memory. External input must enter Activity before it can become memory.

## Owns
- `ActivityRecord` model
- `ActivityService` (CRUD, status transitions, source trust inference)
- Activity API routes
- Activity inbox UI (`ActivityInboxPage.tsx`)

## source_kind / source_trust Values

Canonical `source_kind` / `activity_type` values: `user_capture`,
`chat_message`, `external_chat`, `file_import`, `web_capture`, `run_event`,
`project_folder_event`, `system_event`, `external_source`, and `source`. Legacy input
aliases such as `user_input`, `manual`, `agent_run`, `task_log`,
`imported_chat`, `file_capture`, and `voice_capture` are normalized at ingest.

Default `source_trust` by kind:
- `user_capture`, `chat_message`, `external_chat`, `file_import` → `user_confirmed`
- `run_event`, `system_event`, `project_folder_event`, `source` → `internal_system`
- `web_capture`, `external_source` → `untrusted_external`
- Unknown/empty → `untrusted_external`

If `ActivityRecord.source_trust` is already set to a valid enum value, that value wins.

## Key Model

```
ActivityRecord:
  id, space_id, user_id, project_folder_id, agent_id
  source_kind, source_trust, activity_type, title, content
  source_run_id, source_task_id, source_session_id, source_url
  subject_user_id
  aggregate_key       # nullable idempotency key for pointer/aggregate rows
  status (raw|processed|proposals_generated|failed|archived)
  payload_json, occurred_at, created_at, updated_at
```

## API Routes

```
POST   /api/v1/activity                    — ingest
GET    /api/v1/activity                    — list (filter: source_type, status, project_folder)
GET    /api/v1/activity/{id}
PATCH  /api/v1/activity/{id}/review        — mark as reviewed (status-only; no proposals)
PATCH  /api/v1/activity/{id}/archive
POST   /api/v1/activity/{id}/consolidate   — run consolidation for this activity only (no body)
```

Batch / explicit ids: `POST /api/v1/memory/consolidation/run` with optional `activity_ids` and `batch_limit`.

## Flow

```
raw input → ActivityRecord (status=raw, source_trust assigned)
    → POST /activity/{id}/consolidate (or batch consolidation run)
        → Memory retrieval create-safety pre-dedupe
        → classifier → MemoryCandidateValidator → MemoryProposalProducer
        → reviewable Proposals created with provenance_entries
    → user approves proposals → ProposalApplyService writes MemoryEntry
    → ActivityRecord status updated
```

Daily Sources post-processing also emits pointer rows into Activity:

```
source_post_processing_run succeeded
    → upsert ActivityRecord(activity_type=source, aggregate_key=source:briefing:<source_connection_id>:<local_date>)
    → Inbox row opens /library/digests/:connectionId/:date
    → review/archive clears the notification without deleting Library content
```

These rows are notification pointers only. `payload_json` carries
`briefing_date`, `source_connection_id`, `post_processing_run_ids`,
`artifact_ids`, and `decision_counts`; `content` is a short preview, never the
full digest body. The per-source toggle is
`source_connections.config_json.daily_inbox_briefing`; when absent, emission is
enabled if the connection currently has at least one active post-processing
rule. Existing reviewed rows are re-surfaced to `raw` when a new run lands for
the same source local day.

Project source bindings emit the same shape, one row per Project per local day:

```
source item matches an active project_source_binding
    → upsert ActivityRecord(activity_type=project_source_collection,
                            aggregate_key=project_source_collection:<project_id>:<local_date>)
    → Inbox row opens /projects/:projectId/sources
```

The individual `source_items` never enter the Inbox. Emission is gated per
binding by `project_source_bindings.collection_notifications_enabled` (default
true).

Source recommendation rows are also pointers only: they open
`/sources?view=pending&connection_id=...`. Reviewing or archiving the pointer
does not change `source_connection_user_subscriptions`; Follow, Dismiss, Mute,
and Unsubscribe are handled by Sources.

## What enters the Inbox row by row

The Inbox is the queue of things **a person has to decide about one at a time**.
That, not "is it raw material", is the admission test — Project source items and
a hand-typed capture are equally raw, and they belong in different places.

| Input | Volume | Who decides its fate | Inbox form |
|---|---|---|---|
| User capture (any of the four capture destinations that stay `raw`) | one per act | the user, per record | one row each |
| Source items matched to a Project | up to hundreds a day | nobody, per item; they live in the Project's Sources surface and its corpus | one aggregate pointer per Project per day, toggleable |
| Daily digests, source recommendations | one per source per day | the user, per notification | one aggregate pointer |

Both directions of getting this wrong are silent failures. Admitting source
items row by row buries the user's own captures under machine volume and the
queue stops being reviewable at all. Aggregating user captures into "3 things
captured today" deletes the per-record decision the queue exists to collect.

Project-owned raw material stays in **the Space's one queue** — but that queue
has two mountings, because checking on a capture is something done from inside
the Project and bouncing out to the Space Inbox to do it cost the reader their
place every time:

| Surface | Scope |
|---|---|
| `/activity` (Activity Inbox) | the whole Space; a Project filter the reader can set and clear |
| `/projects/:projectId/raw` (Raw material) | pinned to that Project |

One queue, one implementation: both render `ActivityQueue`, which owns the
filters, the records and the review/archive actions. A second implementation
would be free to drift on what "reviewed" does, which is the entire content of
the pipeline — so a Project surface that needs different framing adds a header,
not a queue. The pinned mounting takes its Project from the route and ignores
`?project_id=`, so the address bar cannot retarget a Project's page at another
Project's material.

Space-wide rows carry a Project tag so a capture made inside a Project is not
read as having been filed somewhere the user did not choose; the pinned
mounting drops it, since every row would repeat it.

## Invariants
- `ActivityRecord` is L0 raw event layer; it is not active Memory
- ActivityRecords become memory only through the Proposal → ProposalApplyService path
- `agent_inferred` activities cannot produce active semantic memory or policy without explicit user accept
- Activity-derived proposals carry Activity provenance in `provenance_entries`
  and may include `source_activity_id` as a pending-proposal compatibility
  shortcut
- Consolidation is idempotent: visible Memory duplicate checks run before proposal
  creation, and duplicate proposals are blocked by `proposal_dedupe_key`
- The Inbox holds pointers, never content (BOUNDARIES B24A). A module that
  wants user attention delivers a clearable notification row here; the
  content itself lives in that module's own reading surface (e.g. the
  Library reading surface at `/library` for Sources-derived digests and items).
  Do not grow Inbox detail rendering into a general-purpose reading UI.
  Pointer rows use `aggregate_key IS NOT NULL` and are excluded from
  Activity-to-Memory consolidation.
- Machine-volume input enters only as an aggregate pointer; only records
  requiring a per-record human decision enter row by row. There is exactly one
  raw-review queue per Space and one component implementing it
  (`ActivityQueue`) — a Project surface mounts that queue pinned to its
  `project_id`, it does not get a queue or an implementation of its own.

## Related Files
- `server/migrations/`
- `server/src/modules/activity/`
- `server/src/modules/memory/`
- `apps/web/src/modules/activity/ActivityQueue.tsx` (the queue itself)
- `apps/web/src/modules/activity/ActivityInboxPage.tsx` (Space-wide mounting)
- `apps/web/src/modules/projects/ProjectRawMaterialPage.tsx` (pinned mounting)

## Related Decisions
- [0003-memory-proposal-flow.md](../decisions/0003-memory-proposal-flow.md)
