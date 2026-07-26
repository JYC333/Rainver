# Memory, Activity, and Provenance

## Activity-First Raw Input

Raw input must enter Activity before reaching Memory or Proposal.

| Capture kind | Entry point | Record type |
|---|---|---|
| Non-chat: thought, snippet, note, link, paste | `POST /api/v1/activity` | `ActivityRecord` |
| Chat / Ask Agent / conversation | `POST /api/v1/sessions` + messages | `Session` + `Message` |
| Run output | `ActivityRecord` with `activity_type=run_event` | `ActivityRecord` |
| Project Folder event | `ActivityRecord` with `activity_type=project_folder_event` | `ActivityRecord` |

Sessions must not be used as generic raw-capture storage for non-chat content.

## Activity → Proposal → Memory Flow

```
ActivityRecord (raw capture)
  ↓ ActivityConsolidationService
  ↓ visible Memory create-safety pre-dedupe
  ↓ MemoryCandidateClassifier → MemoryProposalProducer
Proposal (pending; payload_json.provenance_entries contains activity entry)
  ↓ SourceMonitoringService gate
  ↓ PgProposalApplyService.accept
  ↓ MemoryProposalApplier.apply_create / apply_update
MemoryEntry (active)
  + ProvenanceLink rows (source_type=activity, source_type=proposal)
```

Memory writes are **proposal-first**. The public memory write API returns `ProposalOut` (HTTP 202). `ProposalApplyService.apply` is the only path that creates active `MemoryEntry` from a proposal.

## Source and Provenance Field Mapping

### ActivityRecord — Raw Capture Layer

| Field | Responsibility |
|---|---|
| `activity_type` / `source_kind` | Source identity: what kind of raw input. Values: `user_capture`, `chat_message`, `run_event`, `project_folder_event`, `external_source`, etc. |
| `source_url` | Source identity: origin URL for web captures. Not trusted evidence by itself. |
| `content` | Raw input payload. Not Memory. |
| `source_trust` | Trust state resolved from `activity_type` if not explicitly set. |
| `source_integrity_json` | Evidence payload: optional integrity/checksum metadata. |
| `payload_json` / `metadata_json` | Source metadata: structured capture metadata. |

### ContextSource

The `context_sources` table was removed from the schema. It is not present in the current
migration and `server/test/baselineSchema.test.ts` asserts it does not exist. Provenance uses
`ActivityRecord` + `ProvenanceLink` instead. A future first-class Source model would be
a new table, not a revival of this removed table.

### ProvenanceLink — Provenance Chain

| Field | Responsibility |
|---|---|
| `source_type` | Kind of producing object: `activity`, `proposal`, `memory`, `artifact`, `run_step`, `run_event`, `external_source`, `user_confirmation`, `source_item`, `source_snapshot`, `extracted_evidence`. |
| `source_id` | ID of the producing object. |
| `source_trust` | Trust level of this provenance link. |
| `evidence_json` | Structured evidence at this link in the chain. |
| `target_type` / `target_id` | What this link is attached to (memory, policy, etc.). |

`ProvenanceLink` is for the durable accepted-object audit chain. It records the
source of truth behind an accepted memory, policy, or other durable object,
especially after a proposal is applied.

`EvidenceLink` is separate: it links candidate `ExtractedEvidence` to a space,
Project Folder, project, run, or other target for relevance, context selection, and
provenance eligibility. It does not by itself mean that evidence has been
accepted into Memory or Knowledge.

### Proposal Provenance Fields

| Field | Responsibility |
|---|---|
| `provenance_entries` | List of `{source_type, source_id, source_trust, evidence_json}`. Canonical format. |
| `source_monitoring_result` | Snapshot of SourceMonitoring gate at proposal creation or acceptance. |
| `consolidation_run_id` | Which consolidation run produced this proposal. |
| `activity_batch_hash` | Hash of contributing activity IDs. |
| `source_run_id` (stored payload, normalized on read) | Denormalized run reference; normalized into `provenance_entries` at build time. |
| `source_activity_id` (stored payload, normalized on read) | Compatibility shortcut on pending proposals; normalized into `provenance_entries` via `provenance_entries_from_payload`. Active Memory provenance is not stored on `memory_entries.source_activity_id`. |

### MemoryEntry — Approved Knowledge Layer

| Field | Responsibility |
|---|---|
| `source_trust` | Dominant trust level from accepted provenance_entries. |
| `created_from_proposal_id` | Links MemoryEntry back to accepted Proposal. |
| `last_verified_at` | Last time this memory claim was explicitly verified. |

Activity, Artifact, Run, and evidence provenance for accepted Memory is stored
in `provenance_links` attached to the MemoryEntry, not duplicated onto
`memory_entries`.

## Trust Vocabulary

Canonical values for `source_trust` across ActivityRecord, ProvenanceLink, and provenance_entries:

| Value | Meaning | Allowed for semantic Memory? |
|---|---|---|
| `user_confirmed` | Direct human input or explicit human approval | Yes |
| `internal_system` | Internal system-generated, auditable | Yes |
| `trusted_external` | External source explicitly marked trusted | Yes |
| `untrusted_external` | External source, not explicitly trusted | Only under `explicit_user_accept` |
| `agent_inferred` | Agent-inferred, no human confirmation | No |

Trust is resolved from `ActivityRecord.activity_type` by the activity repository
and consolidation repository (`server/src/modules/activity/`) if
`source_trust` is not explicitly set. Unrecognized `activity_type` values
default to `untrusted_external`.

## Activity Pointer Rows

Some Activity rows are attention pointers, not raw memory candidates. Daily
Sources briefings set `activity_records.aggregate_key` to
`source:briefing:<source_connection_id>:<local_date>` and carry only a short
preview plus ids/counts in `payload_json`. The full content remains in the
Library/Sources read model. Activity consolidation paths must exclude rows where
`aggregate_key IS NOT NULL`.

Sources/Evidence provenance trust is a separate, smaller vocabulary:
`trusted`, `normal`, and `untrusted`. Source connection trust maps explicitly to
that vocabulary. Activity `source_trust` maps explicitly before becoming
evidence trust. Runtime/run/artifact trust values (`high`, `medium`, `low`,
`unknown`) describe execution/runtime confidence and are stored as metadata
when useful; they are not silently reused as evidence trust.

## SourceMonitoring Trust Gate

`SourceMonitoringService` (`server/src/modules/memory/sourceMonitoring.ts`) is the deterministic trust gate before any durable memory or policy apply.

Hard rules:
- `agent_inferred` alone → **reject** (cannot back active semantic memory or policy).
- `untrusted_external` alone → **require_review** (proceeds only under `explicit_user_accept` with result recorded).
- No provenance entries → **reject**.
- `user_confirmed`, `internal_system`, or `trusted_external` → **allow**.

The gate runs inside proposal apply before any durable write. `accept_context="explicit_user_accept"` is set by `PgProposalApplyService.accept` (the human approval API). No HTTP input can override `accept_context`.

Activity-first capture with `source_type=user_capture` resolves to `user_confirmed`, which satisfies the gate for semantic memory proposals.

## Memory Write Boundary

Active `MemoryEntry` creation requires the `_INTERNAL_WRITE_AUTHORITY` sentinel (held only by `MemoryInternalWriter._persist()`). The only allowed write paths are the proposal-approval path (`ProposalApplyService` → `MemoryInternalWriter.create_from_approved_proposal()`) and the bootstrap seed path (`MemoryInternalWriter.create_system_seed_memory()`). There is no policy-based write gate on this boundary — it is structural.

Approved proposal apply uses proposal-validated writer methods. Ordinary callers cannot pass a generic bypass reason string.

## Sources/Evidence — Candidate-Only Rule

Sources and extracted evidence content is **candidate-only**. It may be cited in a runtime context snapshot, but it must not become active Memory without a proposal/review cycle.

Current enforcement:
- External and internal source material enters `SourceItem`, `SourceSnapshot`, `ExtractionJob`, and `ExtractedEvidence` rows.
- `EvidenceLink` controls which candidate/active evidence can be selected into a `ContextSnapshot`;
  Sources-created evidence remains candidate-only, but active relevance links can make it citable in runtime context.
  Selector input link types are limited to `context_candidate`, `supports`,
  `contradicts`, `derived_from`, and `mentions`. Accepted source lineage belongs
  in `provenance_links`, not `evidence_links`.
- `used_in_context` links are audit-only records of prior context use. They are
  not selector inputs.
- Internal run/activity/artifact records are valid source references via
  `source_object_type`/`source_object_id`, not fake internal URLs.
- `source_uri` remains external HTTP/HTTPS only.
- `ActivityConsolidationService` runs visible Memory create-safety before
  `MemoryProposalProducer`; duplicate visible Memory marks the Activity
  `processed` and does not create another proposal.
- `ActivityConsolidationService` → `MemoryProposalProducer` is the only pipeline that creates Proposal rows from Activity. Proposals remain `pending` until explicitly accepted.
- `ProposalApplyService.apply` is the only path that creates active `MemoryEntry` from a proposal.
- No code path creates active Memory from source/evidence payload without proposal.

Future automated source work must enter the Sources/Activity → proposal path before Memory.

## Provenance Questions Answerable from Durable Records

| Question | Answer source |
|---|---|
| Which Activity generated this proposal? | `Proposal.payload_json["provenance_entries"]` with `source_type="activity"` |
| What source kind / URL was involved? | Pending: `Proposal.payload_json["provenance_entries"]` or compatibility `source_activity_id`; accepted: `provenance_links` source row → `ActivityRecord.activity_type`, `ActivityRecord.source_url` |
| What trust state was known? | `Proposal.payload_json["provenance_entries"][*].source_trust`, `source_monitoring_result` |
| Was SourceMonitoring run? | `Proposal.payload_json["source_monitoring_result"]` |
| Which Proposal approved it? | `MemoryEntry.created_from_proposal_id` |
| Which MemoryEntry was created? | `Proposal.resulting_memory_id` (set at accept time) |
| What ProvenanceLinks survive after apply? | `ProvenanceLink` rows with `target_type="memory"`, `target_id=memory.id` |
