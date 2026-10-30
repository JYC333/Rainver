# Reading method workspace

## Ownership and entry

`prompts/reading/` is a narrow adapter over prompts/evolution, canonical Run/Job
execution and Source authorization. It adds no table, dependency, model loop or
parallel evaluation store. The baseline is `catalog/prompts/reading_project_investigation.yaml`.
MVP production resolution uses Project → Space → system; Agent/user pins do not
participate in this investigation method. Deployment targets are limited to
Project/Space, matching the comparison scope. Only the existing system-asset maintainers (Space owner/admin) can edit, trial,
propose or roll back; a result link grants no authority. Ordinary readers do not
acquire maintenance rights. A Project-scoped version also needs its canonical writer.

Reading cards, digest items and Source Reader expose **Improve this result** after
a server permission check. `/prompts?reading_method=1&item_id=…&project_id=…`
is the simple method workspace. `/prompts?advanced=1`, existing asset/tab deep links,
and the advanced disclosure preserve the original prompt/evolution capabilities.
Reader/list return links preserve the exact safe date, list and reader-origin context; they are navigation, not authority. The workspace shows the actual production resolution, not the latest draft. A
Reader-origin artifact id is checked against the Reader's canonical shown version
without recording an open. Provenance is matched to the stored Run contract; old
results without it remain unknown.

## Writes, comparison and privacy

Explicit initialization syncs this catalog key using existing builtin sync authority.
GETs do not sync, queue or mutate read state. A draft clones the effective version,
records the reason and a bounded text strategy as a new scoped version; saving it
has no production effect. Candidate methods cannot grant tools, change Source
consent/storage, or widen the caller's execution contract.

Samples use existing `evaluation_cases`: a bounded homepage plus one/two primary
docs/examples (no fetching by the sample editor). The shared protocol fixture is
server-owned fictional input and labelled as such. Custom samples must be exact
excerpts and supporting URLs from the actual retained Reader version, under full
Source storage consent and full artifact access for the complete audience. Arbitrary
pasted Source text is refused. The immutable case stores an artifact hash/authority
proof; dispatch, reads and Delivery recheck it, and Delivery locks that artifact
and case through commit. Samples are bound to the
material authority and Project-context hash, private to their creator, and excluded
from generic case lists/executors. They are not private Memory or arbitrary auto-retrieval.

A comparison creates one existing `evolvable_asset_evaluation_runs` record with
`reading_method_pair.v1` and two private canonical Runs/jobs. The suite reference
freezes baseline/candidate hashes, case hash, material authority, context hash,
profile fingerprint, input key and both Run ids. Both receive the same supplied
pages/context/profile; automatic retrieval is off and nothing is pinned. Their Work Context binds the
canonical Project (when present) for policy/instruction authorization, while the
Run/output stays private; the Project instruction version joins the context hash. No Source
write tool is granted. The ordinary runtime/profile and credential gates still
apply; this is not a promise of OS sandboxing on paired native hosts, nor a new
credential pre-authorization. No application model/provider is called by IDE tests.

The limits are one in-flight pair and three pairs per person per Space per day, with one
attempt and at most 180 seconds per Run (tighter canonical budgets still apply).
A retry explicitly names its failed/cancelled predecessor and counts as another
pair; duplicate starts use the frozen request key. Canonical cancel/finalization
settles the pair; no new recovery poller is added. The creator may stop the exact owned
trial Runs after input/maintenance revocation; that does not restore private output access. Permission failures are withheld,
not readable through the generic Run/evaluation views. Runtime/SQL failures are
not swallowed as successful evaluations. Per-Run elapsed time and ledger cost are
shown; missing cost stays unknown. There is no token or money hard cap.

Trial dispatch and accepted Delivery check the complete current Project audience,
Source consent and the actual bound Run destination. Production collection retains requester access and its canonical output Project boundary. Final Source writes use the
same locks and revalidation. Comparison reads, judgment and promotion revalidate
material/context/case hashes. Revocation hides outputs, case label and judgment,
including generic Run access; generic evaluation lists do not expose private pairs.
Candidate versions become immutable at trial; a revision creates a new child, and
an old comparison cannot promote a different candidate/hash. A changed effective
production baseline also makes the old comparison historical. Reserved reading-case
authority proofs can only be written by the bounded endpoint, not generic case APIs.

`passed` on the pair means both canonical executions completed, with metrics
`structure_only`; it is not semantic quality. Better/similar/worse/unknown with a
reason is separate human input. Activation requires a current completed authorized
comparison and a positive human judgment, then creates an existing promotion
proposal. Creating it is not activation. Approval revalidates the comparison and
uses the canonical applier/deployment writer. The workspace refreshes the resolver
following a human decision. Rollback uses prompt deployment history; a first scoped
reading deployment can return to its exact evaluated inherited baseline. Queued
Runs retain their admitted version while new Runs select the new effective one.

## Verification boundary

The person retired the MVP implementation plan on 2026-10-30 after local
implementation, independent reviews and full-suite validation, accepting that
real-model quality, actual charges and live remote-Host acceptance remain
unverified. These are no longer retirement gates for this MVP; retirement does
not mark them passed or authorize a real run. The delivered plan and validation
record remain in commit `f58d9632`; subsequent issues are handled as discovered.

Real PG and synthetic Host-worker tests validate preparation, real paired Runs,
Delivery, settlement, proposal application in an isolated test DB, readback,
rollback, frozen versions and content-write isolation. Chromium synthetic APIs
cover Chinese/English 390/1280 journeys. They do not demonstrate semantic model
quality, real provider charges, or a real remote Host. Such execution needs separate
explicit authorization/configuration. Existing shared-briefing live acceptance
remains independent. This MVP improves Source reading strategy; it does not widen
closed briefing inputs or claim a full daily-synthesis quality upgrade.


## Review fixes: history, navigation and collection

History visibility is a permission decision, not a re-execution freshness check.
A routine brief/context/material revision keeps authorized historical outputs,
case labels and human judgments visible, marks the comparison/sample historical,
and forbids new execution/judgment/promotion against that stale input. Source,
Project, retained-artifact or egress withdrawal still hides the whole derived
comparison and generic Run output. Dispatch/settlement retain strict frozen hashes.

The entry probe is scope-only (Space role/asset maintenance/Project writer), never
an item/body/audience read. Mounted entries share one probe per authenticated
Space/user/Project/session epoch, release it on last unmount, and clear it on
logout/401; no persistent/global cross-user permission cache. Workspace and writes
still perform material/full-audience authorization. A navigation affordance is
not an access grant.

Production Source collection keeps requester consent and per-reader projection;
it does not impose the briefing/trial full-audience gate. Newly added Project
brief/constraints/instructions are used only when the material's canonical
Project matches that context. Source materializers bind items/snapshots to their
connection's Project and canonical Reader denies non-Project readers even when
visibility is space_shared. A broader/different Source uses ordinary reading,
Space/system method and null Project Run/WorkContext (no implicit Project
instruction injection). The prompt explicitly identifies the context omission.
Final dispatch/writer rechecks exact output Project binding. No Source grants or
storage scope are widened. Trial comparisons remain full-audience controlled.

“Similar” may intentionally support a user's activation request; it is not a
claim of improved model quality. Canonical output truncation is labelled.

Neutral collection still freezes its originating goal Project as an authorization dependency; losing membership hides the private Run even though that Project is intentionally absent from the executable WorkContext.

## Reading-method UI presentation

Reading/Digest cards keep Open Reader first; the method affordance is a shared
small ghost Button/SpaceLink with a short translated label and a fuller accessible
name. Reader places it with the header controls. Scope permission probes, return
origin/date and all request/session guards are unchanged by the styling.

The workspace uses shared Tabs/Select/Card/Input/Textarea/Button and semantic theme
colours, with bundled Chinese/English `readingMethod` copy. Selects are outside
HTML labels (their accessible names are explicit), so choosing a dropdown option
cannot reactivate its trigger via label activation. Reading touch rules apply on
coarse pointers/narrow screens; desktop retains shared compact density. Visual
acceptance includes the parent Reading/Digest card, not just the destination.

## Description-driven revisions

The default current-method view accepts **a description of what went wrong and
what should change**, plus an explicitly selected owned Agent/Profile. The
`POST /prompts/reading-method/generations` contract accepts only
`source_kind: description`; log ids, raw logs, attachments and arbitrary context
fields are refused. No logs, original Run replies, article bodies, Project brief,
Memory, retrieval or implicit Project instructions are loaded into this prompt.
A future log input must declare its own authorized evidence-provider contract;
there is no inactive log tab or placeholder provider.

A generation is one private canonical Run + ordinary `agent_run` Job, not an
Evolution dry-run planner or a second scheduler/evaluation store. Its immutable
workflow input freezes the effective parent id/hash, bounded description, item
and scope authorization, execution fingerprint/session selections and prompt
hash. Work Context has null Project, retrieval disabled and no pins; the item and
Project remain authorization dependencies, not model context. Existing runtime,
credential and actual-destination Source egress gates remain authoritative. This
is no additional credential approval or OS isolation claim.

The server permits one in-flight generation and three explicit generations per
person per Space per rolling day, one attempt and 180 seconds per Run, subject
to tighter canonical limits. Same frozen requests reuse their Run. Retry names a
failed/cancelled predecessor, consumes the same bounded allowance and never
creates a background loop. The UI restores the owned in-flight record on refresh,
shows progress, preserves descriptions on ordinary failure, and can stop the
owned work after input withdrawal. Session/scope/unmount guards reject late UI
responses; no description is put in browser storage.

Accepted Delivery locks and rechecks the complete Source/Project authority and
actual execution destination. Terminal reconciliation shares the canonical asset
lock, Source/Project locks and current Run lock. It uses the current terminal
attempt, validates `reading_method_revision.v1` (`method` 40–12000 characters,
explanation ≤1600 and 1–8 bounded changes), verifies the effective parent still
matches and creates exactly one **scoped draft** with generation-Run provenance.
Invalid, cancelled, stale or withdrawn output creates no candidate. SQL/runtime
failures remain owed to canonical settlement rather than becoming success. A
completed Run is not by itself a generated/valid candidate; the public generation
view reports the actual draft result. Model explanations are not quality checks.

Private generated candidates and manual descendants retain generation authority
through generic version/render, staging resolution, later comparison Delivery and
Run reads. The description and model explanation stay only on the private Run,
never in the shared version body. Accepted promotion publishes the strategy text
to its explicitly approved scope; it does not publish the private generation
feedback/explanation. A new revision of that published method starts from its
strategy, without inheriting private input from the earlier generation. Withdrawal hides the entire
feedback/method/explanation, while routine authorized history changes are marked
historical. Generated content cannot be edited in place: **Advanced: edit
manually** saves an immutable child (of the selected candidate or effective
method), preserving provenance and invalidating comparisons for the old version.
The original manual API remains available. Generation never starts a two-Run
comparison or creates/decides a proposal; the person explicitly continues through
comparison, human judgment, proposal and effective-version readback. No Reader,
Digest, annotation, reading state, Following cursor, notification, Task or Memory
is changed by generation.

A generation Run that ends `degraded` (for example because extra artifacts or
proposals were refused) saves no draft, even with otherwise valid strategy JSON.
It remains an unsuccessful terminal result: the person may explicitly retry it
with `retry_of`, subject to the same ownership, input, permission and daily limits.
Duplicate retries reuse one Run; a successful retry becomes the latest result for
the unchanged description. It is never reclassified as a quality pass.
