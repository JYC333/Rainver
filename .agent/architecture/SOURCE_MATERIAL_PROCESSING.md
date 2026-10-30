# Source material processing

Sources owns material acquisition and retained reading documents. Search queries
and saved links enter the same `source.material.submit` contract, Run-scoped
submission validator, policy gate and reading document writer. Reader displays
material; it does not execute a webpage worker in the browser.

## Authority and execution

A query keeps its existing goal/version/collection lease, exact preview and
scheduler ownership. A saved link is processed in place: its operation is an
`extraction_jobs` row marked `material_processing`, and execution is an ordinary
canonical `agent_run` job. The extraction worker never claims these coordinated
rows. This adds no scheduler, model loop, CLI adapter or credential channel.

`materialProcessing/dispatch.ts` guards both shapes before actual dispatch and
submission. The public payload has one `processing_id`; Space, user, item or
immutable goal/version, Agent/Profile and configuration come from the persisted
Run. The grant contains only `source.material.submit`. It does not include
`authorization.request` or broad Source writes. The gateway retains its registered
approval configuration and binds policy checks to the actual goal or item.
Invalid submissions follow the same gateway policy/audit path and have at most
three corrections in the same Run. URL, observation time, size, retention and
credential-text checks precede persistence. Actual permissions failures never
become a correctable formatting error.

Existing goal selections remain pinned, including advertised model/mode values.
The item preparation API can bind explicit selections for callers, but Reader exposes no per-article Agent settings. An active operation
refuses a changed selection. Unbound items select an eligible owned Agent's
existing default Profile. Configured OpenCode profiles use the ordinary adapter;
no managed Room assistant is borrowed for a headless Run. If no executable owned
selection exists, the caller must configure/select one rather than changing
Agent, provider, model or account silently.

The Agent chooses how to inspect articles, repositories and other resources,
within existing runtime permissions and a ten-minute requested execution budget
(subject to tighter owner-set canonical budgets). It
submits retrieved source text or clearly attributed synthesis with supporting
URLs. Read failure and link-only results are not fabricated into a body. An actual
empty search remains distinct from an unavailable tool or failed read. Native
request counts and cost can be unknown.

## Storage and recovery

Run settlement is a projection boundary: material processing uses
`reconcileTerminal`, and native-search reconciliation is restricted to the
named terminal Run. These callbacks never cancel active Runs while holding
finalization ownership. Deadline checks and stop commands stay in the ordinary
read/tick recovery path; both paths reuse the same idempotent result acceptance.

`SourceMaterialReadingContentSchema` is a typed inline field on the existing
Source item output. Bodies are not hidden in `metadata_json`, converted through
an empty HTML parser, or written to a temporary handler file. The canonical
Source materializer and ordinary HTML/PDF extraction use
`materialProcessing/documents.ts` for Reader artifacts. `content.format`
(`source_text`/`agent_summary`) is provenance only; `content.syntax`
(`plain`/`markdown`) declares markup. A new submission must declare it: the
intake (`submission.ts`) refuses content without `syntax` with a field error
the Agent corrects in the same Run (at most three submissions in total,
corrections included), and both
Run prompts and the Work Skill name the field. The schema keeps it optional so
stored submissions written before stay readable. Declared Markdown is
converted by the shared `@rainver/reader-document` markdown-it converter (raw
HTML stays text, code is kept verbatim, images become block nodes); `plain`
text, and text of earlier submissions without the field, stays literal
paragraphs. Syntax is never inferred from the text. The declared syntax is
recorded as `reading_content_syntax` (item and artifact metadata). For Agent text (an `agent_provided_v1` artifact) the Reader payload carries
`agent_text_syntax` of the version shown, from that version's own artifact
metadata: `undeclared` (earlier submissions), `plain` or `markdown`. Undeclared
and plain text stays literal; nothing converts it by itself. A writer of that
material (the authority of reading it again, under the Source's storage
policy) may explicitly ask for the version shown to be read as Markdown
(`POST /api/v1/sources/items/:itemId/reading-syntax` with the payload's
`artifact_id` and `source_snapshot_id`; `materialProcessing/syntax.ts`). Under
the item's row lock the shown version is resolved again by the Reader's own
rule (`PgReaderRepository.shownSourceItemVersion`: current extracted artifact,
else the latest readable extracted snapshot, same gates); if it is not the one
named the request fails with 409 `reading_version_changed` and nothing changes.
A `markdown` version is not converted again. The version's stored text is
exactly what the Agent submitted; it is converted with that version's own
kind, format and sources and saved through the canonical writer as a new
version (expected-hash guarded; the shown version and snapshot are kept;
annotations are relocated or listed as not located; read state follows the
writer's revision guards). One material per explicit, confirmed request;
nothing is backfilled. The Reader then reloads the document as a request owned by the
page (page and item mounted, latest request, same session): a reply after the
page left, after A→B→A or after logout changes nothing and is not reported; a
refusal (401/403/404) removes the text, its unsent comments and its
annotations exactly as on first load; an ordinary failure keeps the text shown
and says the new version was saved but not reloaded. "Shown as Markdown" is
said only when that owned reload put the new version on screen. Agent documents keep
`image_policy: none`, which the Reader honours by not loading their remote
images inline. Fetched text is read by its declared media type: HTML through the
structural extractor, `text/markdown` (or a `.md`/`.markdown` URL with no or
an `application/octet-stream` media type — `fetchSource` treats those as text
too) through the same converter, `text/plain`/JSON as plain paragraphs; an
explicit media type always wins over the extension, and an explicitly HTML
candidate (the arXiv HTML rendition) is HTML. Reading an item that already has
text again (Reader's Read again) first explains the impact — a new version is
saved and the current one kept, annotations and comments stay and those that
cannot be placed with certainty become unlocated, nothing else is
reprocessed — and starts only on explicit confirmation, through the same
operation and Run as before. Artifacts and extracted
snapshots inherit the item's current access context. Deterministic extraction
keeps its provenance; Agent content stays unverified and records kind, format,
method and source URLs in a whitelisted Reader DTO.

Saved-item processing commits artifact, snapshot, item revision and final operation
status in one transaction. Item/Source/Agent/Profile authority is rechecked before
write; a concurrent body, membership or policy change refuses stale results.
First fill uses existing body-revision/read-state guards. Explicit re-reading
creates the existing kind of new body revision, not a duplicate material or a
silent annotation reset. Collection deduplication may fill a missing body, but
does not replace an already saved body during ordinary repeated collection.

The existing terminal Run reconciler saves completed work even after Reader is
closed. Opening Reader also reconciles/reports the latest owned operation. Queue
waiting does not consume execution time; an overdue dispatched operation is
cancelled through canonical Run orchestration. Cancellation or real action
refusal prevents a stored submission from being applied. Only field corrections
(and harmless repeated/limited submissions after a valid one) may recover a
`degraded` Run. Private submission/recovery bodies are removed at terminal
settlement. Existing source sample maintenance reapplies retention to goal data.

## Source permission and UI

Metadata-only policy is enforced before starting a reading Run. The UI can
request a single Source-wide `source_material_retention` proposal; only the
current Source owner with current Project write access can accept it through the
canonical proposal applier. A policy hash prevents accepting a stale decision.
It changes only reference capture to text capture and retention to full text;
it adds no archive, reader, credential, external-model egress or network grant.
No legacy default is inferred as human consent, and no bulk live-data migration
runs. Changed Source authority makes old exact-preview proofs stale before a
new automatic model Run is admitted.

Single-item instructions bound reading to the main resource and up to two relevant
documentation pages, require per-fetch timeouts and stopping after repeated
failures, prohibit dependency installation, and reserve time for submission. These
are Agent instructions, not a guarantee that every external page is readable; the
canonical admitted Run deadline remains enforced. Submission and recovery read
that same contract with the shared Run time-limit resolver; no separate
three-minute expiry exists. Independent items use separate Run/jobs in the
existing concurrent worker pool; per-item serialization only prevents duplicate
preparation of that same item. Host/account concurrency and quota still apply.

Reader and direct URL saving use `MaterialProcessingPanel`: one start/retry,
canonical queued/working/waiting/final status, cancel and actual Run link.
Reloading resumes observation; opening does not itself start a model Run.
Read-only viewers cannot prepare/replace content. The old list-card and URL-dialog
webpage runners are removed. Ordinary extraction endpoints remain tools for
existing API Sources and ingestion, not compatibility shells for the deleted
search-specific action. `source.goal.submit_search_results` is not registered.

Reuse / Dependency Check: canonical Run/job admission, Source extraction records,
Source consent and egress, proposal applier, Source materializer, existing Reader
JSON and read-version guards are reused. Existing HTML/PDF extractors remain
valid deterministic executors. No new dependency, table or instance migration.
