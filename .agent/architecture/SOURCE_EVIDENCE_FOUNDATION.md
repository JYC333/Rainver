# Sources And Evidence Foundation

The Sources layer is the canonical boundary for raw external and internal inputs.
It is intentionally separate from Memory, Knowledge, policy, tasks, files, and
capabilities.

There is no Area concept in this foundation.

## Model

- `SourceProvider` names an external source (for example `arxiv` or a generic
  RSS provider). `SourceConnector` is a system-published transport/parser
  implementation (for example `arxiv_api` or `rss`).
- `SourceProviderConnector` maps those independent models many-to-many; active
  mapping priority selects the default implementation.
- `SourceConnection` is the space-scoped governance boundary. It owns
  credential reference, consent, policy, trust, transport config, and handler
  provenance. It does not own a search query or schedule.
- `Source` is the user-facing external origin. `Monitor` is the user-facing
  saved search/feed/page rule attached to that origin. A Monitor owns the
  provider query, endpoint, normalized fingerprint, frequency, and schedule;
  query and schedule therefore do not change the identity of the Source.
  Internally, each Monitor is represented by a `SourceChannel`. One
  connection can back many independent channels, while the normal Sources UI
  groups them under one Source and exposes the child records as Monitors.
- Channel cursor, watermark, ETag, Last-Modified, and scan statistics live in
  `scheduler_tasks.metadata_json`, not in the connection.
- `SourceChannelItemLink` records every channel that matched a deduplicated
  `SourceItem`; the item and snapshot retain connection provenance.
- `SourceItem` is raw candidate material. Every item belongs to exactly one
  `Space`. It does not require a Project Folder or project, and general space source capture
  is valid. Manually saved URL items may attach to or change a
  `SourceConnection`; scanned items keep their original connection as source
  provenance.
- `SourceSnapshot` records immutable captures of raw/extracted/summary material
  stored in `Artifact`. Its `connection_id` is source provenance for that
  capture. Because `SourceItem` is deduped by canonical/source URI and has one
  primary `connection_id`, same-item snapshots from additional source
  connections are also used by project source filters and evidence auto-linking.
- `ExtractionJob` audits scans, manual URL source capture, extraction, snapshots, and
  internal normalization jobs.
- Structured reader documents are extracted artifacts owned by Sources. New
  full-text extraction writes `artifact_type="source_reader_document"` with
  `canonical_format="reader_document_json"` and `mime_type="application/json"`.
  The JSON contains `plain_text` plus read-only Tiptap `content_json`.
  HTML uses `extraction_method="structured_html_v1"`; PDF uses
  `extraction_method="pdf_text_v1"` and is derived from a file-backed raw PDF
  `source_raw_snapshot` artifact.
- `ExtractedEvidence` is the citable context unit derived from source material, activity,
  artifacts, run events, files, logs, or documents.
- Sources reader annotations and comments are Sources-owned records over reader
  documents. They may create candidate evidence or Memory/Knowledge proposals,
  but they do not directly write durable Memory or Knowledge.
- `EvidenceLink` links one evidence item to multiple targets such as space,
  Project Folder, project, user, agent, run, proposal, artifact, memory, knowledge,
  or task. Service-layer validation requires each non-space target to exist in
  the same space. `target_type="space"` may omit `target_id`; it is normalized
  to the current `space_id`.
- `ProjectSourceBinding` binds a Monitor (internal Source Channel) to a project without
  duplicating raw source data or credentials. `project_id` is required,
  creation requires project writer authority, and `binding_key` distinguishes
  multiple filtered bindings over the same project/channel.
- `ProjectSourceItemLink` materializes which source items entered a project
  collection through a project source binding.
- `SourcePostProcessingRule` is Sources-owned source-level AI post-processing.
  Rules choose a reusable agent, trigger/window strategy, optional project, and
  actions such as digest, relevance screening, evidence extraction, proposals,
  and item marking. Runs are auditable through `SourcePostProcessingRun`.
  Screening rules can optionally run a candidate prefilter before the LLM sees
  the batch, using current-batch title/excerpt/source metadata to reduce the
  prompt set while persisting low-confidence `maybe` review decisions for
  filtered-out items instead of auto-ignoring them.
- Source post-processing supports an optional deep-analysis follow-up. The first
  screening pass decides from supplied title/excerpt/metadata and any configured
  retrieval context. If configured, relevant candidate items above the rule's
  confidence threshold can queue full-text extraction and then enqueue a
  second-stage `screen_extract_digest` pass over those candidates only. This is
  reusable by any source provider; arXiv uses it only when its Channel
  post-processing profile explicitly enables it.
- `SourcePostProcessingItemDecision` is the review/query read model for
  screening decisions. It records rule/run/item relevance, confidence, reason,
  matched context refs, applied item status, and review status. It is not
  canonical Knowledge.

Projects do not own raw source material. Project relevance is expressed primarily with
`EvidenceLink(target_type="project")`.
When an existing source binding is asked to include history, Sources backfills
missing project `EvidenceLink` rows for already-extracted evidence; the raw
`SourceItem`, `SourceSnapshot`, and `ExtractedEvidence` rows remain single
space-scoped records.

Source post-processing may read project public summaries and retrieval context
to screen source items. Without a project, screening rules require an explicit
source-level relevance profile; generic digest rules may remain space-level.
Rules that request project retrieval context must be bound to a project.
Before model execution, the service also checks the selected agent/provider
destination against the source connection's consent and source egress policy.
Successful runs can write artifacts, candidate evidence, context-candidate
evidence links, review proposals, item status updates, and persisted decisions.
They do not directly write canonical Knowledge or Memory.

Full-text reading is candidate-scoped, not the default source path. Raw snapshots
and full reader text are not embedded by default; rules may request extracted
text for relevant candidates, and missing extraction is represented as an
extraction job plus one or more follow-up post-processing events rather than
broad source reprocessing. The pending extraction job keeps an array of
post-processing follow-ups so multiple rules can wait on the same item without
overwriting each other.

## Source References

`source_uri` is only for external `http`/`https` URLs and is validated through
the source URL validator. Internal sources use `source_object_type` and
`source_object_id`.

Valid internal source references include:

- `ActivityRecord` via `source_object_type="activity_record"`.
- `Artifact` via `source_object_type="artifact"`.
- `RunEvent` via `source_object_type="run_event"`.

Internal normalization for these sources is item/evidence-idempotent. Repeating
normalization of the same `ActivityRecord`, `Artifact`, or `RunEvent` reuses
the same `SourceItem` and the same active/candidate `ExtractedEvidence`.
Repeated manual normalization may create an additional skipped
`ExtractionJob` for traceability. This is acceptable because it does not
duplicate active/candidate evidence and does not mutate durable Memory,
Knowledge, policy, tasks, files, or capabilities.

Internal display references belong in metadata such as
`metadata_json.internal_ref`, not in fake `run://`, `artifact://`,
`activity://`, or `file://` URIs.

## Reader extraction

Reader extraction preserves article structure for human reading while keeping a
plain-text contract for anchors and hashes:

- HTML extraction prefers readable page bodies (`article`, `main`, role `main`,
  then `body`) and drops scripts, styles, frames, and other non-reader content.
- Headings, paragraphs, lists, blockquotes, code blocks, horizontal rules,
  links, and images are normalized into Tiptap JSON.
- Image handling is remote-reference only. Sources stores resolved `http`/`https`
  image URLs in JSON; it does not download, cache, or store image binaries in
  this path.
- `plain_text` is stored alongside `content_json` so reader annotations can
  continue to use stable UTF-16 text ranges and server-side verification.
- Re-extracting an already extracted item is allowed. It queues another
  `extract_text` job, creates a fresh extracted snapshot/artifact, and updates
  the item pointer. Existing annotations remain as records; anchors may become
  `unverified` if the source content changed.

## Boundaries

Sources and evidence may create candidate records, artifacts, snapshots, jobs,
and links. They must not directly create active Memory, Knowledge, policy,
tasks, files, or capabilities. Durable changes still go through proposals and
their existing apply gates.

Run context selection reads only explicitly linked active evidence through the
evidence selector. Runs do not read directly from the whole source pool. Selector
inputs are relevance/context candidate links only: `context_candidate`,
`supports`, and `mentions`. Selected evidence references are frozen in
`ContextSnapshot.included_evidence_refs_json` and in `source_refs_json`.

When selected evidence is used in a run context, the original relevance link
(`context_candidate`, `supports`, or `mentions`) remains unchanged, and an
additional active `EvidenceLink` is recorded:

- `target_type="run"`
- `target_id=<run_id>`
- `link_type="used_in_context"`
- `created_by_run_id=<run_id>`

This makes context use auditable without broadening the evidence selector.
`used_in_context` is audit-only. It must not cause evidence to be selected into
future contexts merely because it was used before.

## Provenance

`EvidenceLink` is the relevance/context eligibility link between evidence and
targets. It controls whether evidence may be selected for a run context.
Accepted provenance belongs in `ProvenanceLink`.

`ProvenanceLink` is the durable accepted-object audit chain, especially after a
proposal is applied. It may point back to `activity`, `proposal`, `artifact`,
`run_step`, `run_event`, `source_item`, `source_snapshot`, or
`extracted_evidence`, but it is not the selector for candidate evidence.

## Trust

Sources/Evidence uses provenance trust: `trusted`, `normal`, and `untrusted`.
Action risk uses `risk_level` (`low`, `medium`, `high`, `critical` in policy
contexts). Runtime/run/artifact trust uses execution trust values such as
`high`, `medium`, `low`, and `unknown`. These vocabularies are mapped explicitly
when they cross a boundary; they are not interchangeable strings.

## API

The canonical API surface is `/api/v1/sources/*`. Sources is registered through
`server/src/modules/sources/`.

## Two evidence stacks — boundary and promotion

There are intentionally **two** evidence representations. They are kept separate
because their lifecycle, audience, and permissions differ. They must **not** be
merged into one generic "evidence" table.

| | Sources/Evidence stack | Wiki evidence stack |
|---|---|---|
| Tables | `SourceItem`, `SourceSnapshot`, `ExtractionJob`, `ExtractedEvidence`, `EvidenceLink` | `Source`, `KnowledgeItemSource` |
| Audience | agent-facing (context selection) | human-facing (curated wiki evidence) |
| State | **candidate** material | **curated/approved** evidence |
| Write path | source scan / extraction (candidate, no review) | `/api/v1/knowledge/sources` direct CRUD + knowledge proposal apply |
| Runtime use | `EvidenceLink` selects candidates into a `ContextSnapshot` | never selected into run context |
| Trust vocab | `trusted` / `normal` / `untrusted` | knowledge visibility/verification rules |

### Hard separation rules

- `ExtractedEvidence` / `EvidenceLink` rows never *become* `Source` /
  `KnowledgeItemSource` rows in place, and are never silently copied across.
- `Source` / `KnowledgeItemSource` are **curated wiki evidence** and must never
  be fed into the run-context evidence selector — that is the Sources
  `EvidenceLink` path only.
- Internal provenance pointers (activity/run/artifact behind a durable object)
  belong on `ProvenanceLink`, not on either evidence stack. See the knowledge
  provenance path (`source_refs` → `ProvenanceLink(target_type="knowledge")`).

### Promotion rule: source candidate → curated wiki evidence (SPEC — not yet implemented)

When a user (or an agent acting on a user's behalf) decides that a source
`ExtractedEvidence` candidate should become durable, curated wiki evidence, it is
**promoted** — it is not auto-converted.

1. **Trigger.** Promotion is an explicit user action over an `ExtractedEvidence`
   row whose `status="active"`. Being used in a run context
   (`EvidenceLink(link_type="used_in_context")`) does **not** trigger or imply
   promotion.
2. **Review-gated.** Promotion goes through a knowledge proposal (e.g. a
   `knowledge_source_promote` proposal type, or the existing knowledge source
   creation path), never a direct write. The proposal payload carries the source
   `extracted_evidence_id` plus the target `knowledge_item_id` (optional) and the
   intended `relation_type` for the resulting `KnowledgeItemSource`.
3. **Apply.** On acceptance, `ProposalApplyService` (knowledge branch):
   - creates one `Source` row, mapping evidence fields → source fields
     (`source_uri`→`uri`, `source_title`→`title`, `content_excerpt`→`summary`/`raw_text`,
     evidence kind → an allowed `Source.source_type` such as `webpage`/`article`/
     `manual_reference`);
   - optionally creates a `KnowledgeItemSource` link to the target KnowledgeItem
     when one was supplied;
   - records origin provenance from the new `Source` back to the originating
     candidate via `ProvenanceLink` (`source_type="extracted_evidence"`,
     `target_type="source"`) — never by overloading evidence-stack fields.
4. **Trust mapping.** Sources trust (`trusted`/`normal`/`untrusted`) does not
   silently become a knowledge trust value; the promotion records the originating
   trust in provenance, and the curated `Source` is then governed by knowledge
   rules.
5. **Idempotency.** Promoting the same `ExtractedEvidence` twice must not create
   duplicate `Source` rows — dedup on `content_hash` or on the recorded
   `extracted_evidence` provenance origin.
6. **Permissions / space boundary.** Promotion is same-space only; cross-space
   promotion is denied. Existing knowledge create / source CRUD policy gates
   apply. Agent/run provenance is not human-ownership authority for private or
   selected-user Knowledge.

This promotion path is the **only** sanctioned bridge between the two stacks.
Absent it, the stacks stay fully independent.
