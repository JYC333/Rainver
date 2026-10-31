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

Reading settings expose the primary **Reading method** entry for the current
Space or Project. Source Reader retains a secondary contextual **Improve result**
shortcut; reading and digest cards open Reader only through their title.
Method viewing, manual child drafts and description-driven generation can run
without a selected article. Their authority is the canonical method-maintenance
and Space/Project write scope, not an invented Source item. An explicit server-owned
`scope_only` marker with null item identifies new scope-only generation contracts;
missing legacy material references are refused. Existing result-linked generations
retain all original Source authorization and withdrawal dependencies.

`/prompts?reading_method=1&item_id=…&project_id=…`
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
execution fingerprint, input key and both Run ids. Both receive the same supplied
pages/context and frozen execution selection; automatic retrieval is off and nothing
is pinned. Legacy Agent pairs have a closed Work Context that binds the
canonical Project (when present) for policy/instruction authorization, while the
Run/output stays private; the Project instruction version joins the context hash.
Default API pairs use only their explicit frozen input, without an Agent persona
or implicit retrieval. No Source
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

The primary shared-method link lives inside Reading settings, including daily
recommendation preferences and Project source settings. Cards have no duplicate
Open Reader or method controls. Reader retains its compact contextual shortcut.
The method workspace shows the effective scope/version without an article and
allows default API or explicit CLI description revisions and manual immutable
child drafts. Private generations remain tied to their instructor and current
maintenance/Provider/Project permissions; method generation loads no article body
or implicit Project context.

Only comparison asks for a readable material example. The chooser uses the
canonical authorized Reading projection, supports title search/paging and never
chooses an item silently. Selecting it preserves the scoped candidate and return
context and enters the existing Source-authorized sample/trial flow; another
Project's material is not an implicit scope switch. Generation requires no sample,
while trial execution still requires the full current material/audience/egress
checks. Existing item-linked histories remain item-authorized. A scope-only view
never invents result provenance or lists unrelated ordinary Runs as generations.

The workspace uses shared Tabs/Select/Card/Input/Textarea/Button and semantic theme
colours, with bundled Chinese/English `readingMethod` copy. Selects are outside
HTML labels (their accessible names are explicit), so choosing a dropdown option
cannot reactivate its trigger via label activation. Reading touch rules apply on
coarse pointers/narrow screens; desktop retains shared compact density. Visual
acceptance includes the parent Reading/Digest card, not just the destination.

## Description-driven revisions

The current-method tab first shows the complete effective method and its resolved
scope/version in a default-visible read-only Card. It stays the production baseline
when a generated candidate is selected. Below it, the primary form accepts
**a description of what went wrong and
what should change**, using the authorized Space default chat API. No Agent/Profile is required. The
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
historical. API generation history checks current Provider existence, enabled Space
grant and credential eligibility, plus Source consent for that Provider with the
frozen model. Ordinary Provider configuration drift keeps historical output and
private candidate readers visible but marks generation stale. Admission, dispatch,
Delivery and settlement still require the exact frozen configuration fingerprint;
a drifted queued Run cannot execute or create a draft. Actual Provider/credential
or Source permission withdrawal hides the whole derived result. Generated content cannot be edited in place: **Advanced → Edit
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


The workspace ends with one **Advanced** disclosure, after all tab content and
ordinary delivery guidance. It combines manual editing, recorded result-version /
originating Run links (only when present), and the original advanced prompt
management link. Opening information does not enter editing or disable generation.
Only an explicit edit action clones the selected candidate or effective method;
comparison's revision action opens and focuses this final editor. Save creates an
immutable child and returns to comparison; Cancel clears local edits. The editor
retains maintenance, active-generation/comparison, pending-proposal and session
protections. Read-only viewers can see the effective method and recorded provenance
without gaining manual write controls.

## Versioned revision instruction

Description generation resolves the approved `prompt.revision.method` asset
separately from the target investigation method. Explicit Reading catalog
initialization syncs both built-in baselines; GET performs no synchronization.
If an older installation has only the investigation asset, the workspace offers
initialization instead of silently using a hardcoded revision prompt.

New generation contracts freeze the revision asset id/hash/provenance and rendered
text as `revision_method`; the target parent retains its separate id/hash. A
later deployment does not replace the immutable admitted revision instruction.
Its version must still exist with the same content at dispatch/settlement. Legacy
Agent generation contracts without this field retain their original behavior;
no historical revision provenance is inferred. The default bounded ProviderTask execution and the two-target self-revision workspace are described below.


## Default API execution and the revision method target

The current-method → description → final Advanced layout applies to two targets
only: `reading.project_investigation` and `prompt.revision.method`. The latter is
the complete built-in rewriting strategy, not an Agent persona. Explicit catalog
initialization syncs both; GET never syncs. New generation contracts record both
its approved immutable id/hash/text/provenance and the distinct target parent
id/hash. A later revision-method deployment does not alter admitted text; target
baseline changes still make an execution stale. Legacy Agent generations without
revision provenance keep their actual historical contract, not an inferred version.

The main path resolves the enabled `prompt_revision` task-policy primary, otherwise
the enabled granted Space default chat Provider and explicit/default text model.
Embedding/rerank choices, unavailable credentials and disabled/ungranted Providers
are refused. No automatic provider/CLI/account fallback is allowed. Advanced can
explicitly choose an authorized Provider and its listed model. The default native
OpenCode runtime is not this API. Advanced also offers an explicit CLI executor choice, loaded on demand from the current user's usable Host-bound runtime profiles. No Agent/Profile is created or modified. The UI identifies runtime, Host and profile; the canonical Agent remains an execution association, not the rewrite persona. Both targets support CLI generation and controlled comparisons. Missing API configuration does not disable a selected usable CLI; no fallback is automatic.

New executions are private canonical `provider_task` Runs with no Agent,
AgentVersion, Profile, Host or workspace. The ordinary `provider_task_run` worker
rebuilds only the frozen request and uses boundedProviderTaskRun, canonical
credential spend, usage and ProviderTask controls/Delivery/snapshot. Its domain
`authorizeAttempt` callback runs in that Delivery transaction, fences the actual
Provider/grant and the complete Source/Project/item authority, and rechecks the
physical provider/model before commit. Source egress uses that concrete API
endpoint/model classification. The provider HTTP path has a shared 180-second
abort deadline across attempts; canonical key-pool policy is otherwise unchanged.
There is no token or money hard cap. Cancellation prevents candidate publication;
a request already sent can still finish and incur cost. Late completion cannot
replace cancelled state or create a candidate.

Success and draft/paired-evaluation projection share a transaction, using the
canonical terminal writer and then rereading its full Run contract. The terminal
reconciler also receives a normal durable job nudge; existing recovery replays
registered idempotent projections after failure/restart. One inflight generation
and three per rolling day, and a separate one-inflight/three-pair allowance, are
serialized per Space/person across both targets. Explicit unsuccessful-terminal
retries create a new bounded Run; duplicate retries reuse it. Schema failure
(including extra side-effect fields) saves no candidate and creates no Source,
Reader, Digest, Task, Memory or proposal changes.

Advanced links to the real system revision-method workspace, preserving item,
Project and return context. It shows the actual effective revision body/version;
its candidate is generated by the current approved revision strategy without
recursive automation. Its fixed controlled sample contains an original prompt,
feedback and preserved language/evidence/no-browsing requirements, not a Reading
homepage investigation. Baseline/candidate perform two canonical API Runs; JSON
validation/execution success is structure-only. Human judgment, promotion proposal,
applier readback and exact-scope rollback use the same existing evaluation and
prompt deployment authorities, bound to that target's asset and hashes. A user
still decides a real proposal; IDE fixtures do not approve product proposals.

Private generation origins guard generic Run/version/render/staging and later
cross-Source comparisons. Revocation hides affected derived text, labels and
judgments; approved publication shares only the explicitly approved strategy,
not private feedback or explanation. No Reader body, original Run replies, logs,
Memory or implicit retrieval/Agent persona enters default generation. Logs remain
unsupported strict input; no log tab/provider was added. API setup failure leaves
the current method readable and advanced manual editing available.

## Optional CLI method execution

Advanced has mutually exclusive default API / other API / CLI execution. The scope-only
`GET /prompts/reading-method/cli-options` requires the existing maintenance authority,
returns only usable owned Host-bound configurations, reads no article and writes nothing.
The server rechecks owned Agent/Profile, Host usability, session selections and actual
Source destination at admission, dispatch and Delivery; inventory is not authorization.

New CLI method generation/comparison uses the same approved revision asset/target parent,
canonical agent_run/ACP/jobs and bounded private output. Its server-owned workflow marker
closes the instruction surface in Runtime Context acquisition: the explicit method request
and platform execution rules remain; Agent persona, bound Skills, implicit Project and
personal Memory are not appended. Existing unmarked historical Runs retain their admitted
contract. This is a narrow method-executor context rule, not a general runtime bypass or
OS sandbox claim. Source/Project and original candidate dependencies still gate private
reads and finalization. Meta CLI pairs require the fixed prompt-and-feedback sample,
validate the declared JSON and expose readable revised prompt/changes, with structural
completion distinct from the human judgment. Other consumers retain their original context.
