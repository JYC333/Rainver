# Goal-driven Source collection

## Current implementation and ownership

`server/src/modules/sources/goals/` owns the goal aggregate, immutable plan
versions, bounded previews, source bindings, candidate validation and CAS
publication/rollback. `packages/protocol/src/sourceGoals.ts` owns public input
schemas and conversation/detail DTOs. Drizzle owns six `source_goal_*` tables;
migration `0005_project_reading_and_source_goals.sql` includes the goal Session association, compatibility identity,
creation idempotency and the legacy extraction-job scheduling guard.
The old Level 3 runner remains frozen and is never an execution fallback here.
The conversation UI and explicit compatibility mapping are implemented; no
running instance is migrated as part of a source change.

The HTTP entrypoint is `/api/v1/sources/goals`: POST creates a natural-language
goal with an existing owned Agent/Profile and optional Project, GET lists goals,
and GET `/:goalId` recovers versions, preview status, source progress, recent runs
and repair candidates. POST suffixes `explore`, `preview`, `follow`, `feedback`,
`save`, `resume`, `pause`, `delete`, `rollback` operate the domain. Preview
names an exact `version_id`. `follow` is the one continuous-following
confirmation (see [Continuous following](#continuous-following-confirmation-lifecycle-and-topic-membership));
it never requires a preview. `save` (`SourceGoalSaveSampleSchema`) is the
optional manual save of one fresh exact-version Agent-search preview into
Reading; it names that version, its `preview_id` and an `idempotency_key`, and
never starts continuous following. There is no other start entry. Rollback
names binding and expected revision. A repeated confirmation returns the
existing state, including a paused state; it never resurrects work. Activation
(`goals/activation.ts#activateGoalVersion`, shared by both) locks the selected
channels in one transaction, refuses pending legacy work, pauses their old
scan/Project-monitoring tasks, and sets manual channel frequency before creating
the single goal task. Mapping alone never transfers schedules.

The existing SystemActionDispatcher exposes bound `source.goal.read`, `sources`,
`inspect`, `write_version`, `repair_candidate` actions to the existing Agent Run.
A queued Run carries goal, purpose and (for repair) exact binding in its immutable
contract, selected runtime Profile, limited attempts and duration. Goal row locks
bound exploration attempts and deduplicate concurrent queue requests. Model
routing, spend authorization and Agent execution remain in their existing owners.
There is no direct model SDK invocation, model substitution or template presented
as AI output. New-source activation still uses the existing activation proposal.

`source.goal.inspect` is a bounded source document read, through the same executor
and quota as preview/live collection. It explicitly labels external content as
untrusted data. Source prompt egress is checked against the selected Profile,
not an unrelated default Profile. Credentials remain server-only callbacks;
code, model prompts and subprocess environments do not receive credential values.
The isolated handler receives `{cursor,endpoint_url}` as input and uses the
stage-one sequential `request(url)` channel. Dependencies, native network,
ambient credentials, arbitrary host directories and unsafe runner fallback are
not offered. Host capability describes executability only, never authorization.

Planning may supply an optional `plan.title` (trimmed, 1–60 characters), a short
subject label in the user's language. The existing author-bound, revision-checked
version write stores it in the immutable plan and the goal's
`compatibility_json.display_title` in the same transaction. Goal lists, detail,
filters and authorized Reading topic links prefer that label; older plans work
without one. The label changes presentation only, never collection intent,
approved scope, cadence or budgets. Existing topics receive a label on their
next planning write; opening a page never launches a naming Run.

## Authority, preview and execution

Creation resolves Personal Space without a Project, or the canonical Project
read/write context with one. Every domain access checks membership, owner and
Project access. Each source additionally needs full content access, matching
owner/Project, active connection/channel and canonical Source permissions.
Metadata visibility is insufficient for source content. Source configuration,
credential reference and approved version are fingerprinted in the preview.
Start, each execution, physical send and result acceptance revalidate authority.
Changed source scope refuses old previews and bindings rather than expanding
network or credential reach. Pausing/deleting cancels existing goal Agent Runs;
subsequent physical requests and business result commits refuse authorization.

A preview reserves one of three attempts on its immutable plan version, runs all
sources through the same bounded executor, and records observation time,
contributions and limitations. Empty/invalid/failed contributions are partial.
Ready requires successful nonempty relevant data from each selected Source. A single Source or multiple Sources of one type are valid; the two-kind requirement belongs to the acceptance fixture only. A ready
preview expires in 15 minutes. Start locks the goal, creates bindings and upserts
one existing scheduler task atomically. No independent scheduler is added.

Existing scheduler tasks enqueue `source_goal_tick` jobs; existing job workers
apply their lease, retry and deployment-drain handling. Per-source leases expire
in five minutes; execution plus one history attempt are bounded below that lease.
After a crash the next claim marks old audit executions interrupted. Agent repair
Runs finishing without a publication are reconciled into bounded retry/pause.

Every physical request uses the stage-one persistent atomic account and endpoint
quota. Goal execution adds a shared bounded request group, per (server Run/preview identity, Source), shared by repeated inspect calls and live candidate validation. Offline fixture replay makes
no upstream request and consumes no live request quota. Account identity survives
connection/run changes. Current conservative hard bounds are 10/minute and
100/day as a stable owner/provider fallback and an owner-scoped endpoint group; shared credential references additionally share a credential-account group, narrowed by the goal's
1–20 requests per Source/execution scope; they are ceilings, not a promise of capacity.
Credential routes require HTTPS. Query keys and paths derive from the canonical
connector's initial request, not generated grants. Existing hard-deny settings
currently refuse goal execution as a whole; they are not ignored.

## Persistence, repair and coverage

Only CustomSourceMaterializationService writes collected Source items and their
existing Project/Reader associations. Its accepted result and the binding cursor
commit in one transaction under the live lease and revision. Stable source IDs
and URLs filter already-successful items, preserving their original history.
An empty valid incremental scan is permitted; an empty preview is insufficient.
Source output still needs canonical field/filesystem/size validation.

Network, quota, timeout, unavailable isolation and Host recovery defer the source;
they do not invoke AI code repair. Parser/execution failures create honest gap
records, with bounded repair attempts and cooldown. At 64 unresolved gaps the source
pauses instead of discarding coverage history. Covered/unrecoverable history remains audit data and consumes no active capacity. Other bindings remain independent.
A candidate cannot change the source binding or approval envelope. It must pass
saved offline fixtures (including stable identity comparison) and a small live
sample (fields, time, URL, duplicates, quantity and lexical includes/excludes).
A single Run/base revision can reserve validation only once, enforced in PG.
These checks do not prove full semantic correctness.

Publication CASes the binding's base revision with no active execution lease,
rechecks source scope and the administrator's existing automatic-repair policy,
and retains the previous implementation. Stale candidates refuse. A subsequent
parser failure automatically restores the previous implementation once; explicit
rollback also requires the exact revision. Administrator restrictions are never
rewritten by setup or repair.

New material commits before at most one bounded old gap is attempted using the
same executor/request budget. History cursors are independent of the new-material
watermark. Existing connector capabilities, not the model's assertion, determine
connector history support. Returned time-window items are checked before
materialization; coverage needs exhaustion for the exact requested window.
Unsupported history is unrecoverable; quota/network limits defer the gap. A bare
HTTP 200 or a partial page never means complete coverage. Generated handler
exhaustion remains an untrusted, validated contract assertion, not proof of all
upstream history.

## Verification and remaining acceptance

Verification distinguishes deterministic fixtures, real HTTP/PG/OS execution
and real Agent/model generation. Implementation and review history is recorded
in commits `5409ce02`, `a6679858`, `d9e02a3f` and `a1b6590c`. A fixture author Run or test-authored
handler is never evidence of actual model generation. Real Agent smoke requires
an authorized existing Profile and live runtime route; absent that capability,
record it unverified rather than switching model or spend paths.
Standard-container successful execution still requires administrator-owned
cgroup/userns provisioning before deployment. Host opt-in and runtime isolation
remain mandatory, including on trusted Hosts; no instance permission was widened.

## First-review corrections

While a goal runs, exploration and candidate versions leave its approved active
version collecting. A fresh exact candidate preview can atomically replace the
active version only when no source lease is held. Source claims compare both
binding revision and active version; stale workers cannot commit after switching.

Connector selection excludes successful IDs/URLs, filters unrelated rows and
reports observed/filtered/selected/pending counts. A truncated page stays pending
until its relevant rows have persisted; API continuation cannot skip that page.
Only persisted item times contribute to the server watermark. Neither an arbitrary
handler watermark nor an unmaterialized row can advance it. Empty/irrelevant
results are insufficient, not parser failure and never grounds for AI repair.

Incremental commit and history recovery have separate error dispositions. A
history quota/timeout/storage failure cannot overwrite the incremental success,
roll back its implementation or manufacture another gap from an old cursor.

Validation is distinct from publication. Disabled automatic application or a
lease/CAS conflict retains a validated candidate. Explicit owner publication uses
`POST /:goalId/repairs/:repairId/publish`, rechecks original Source activation policy,
runner/admin restrictions, full Source access and unchanged scope. It does not
pretend automatic-apply permission is human permission. Successful publication
updates the current live calibration fixture, retaining one previous fixture for
rollback; later repairs are not pinned forever to the initial preview.

Raw calibration/failure bodies never appear in ordinary goal reads or preview
responses. Nested validation outputs are also removed, and displayed output uses
the existing retention filter. Repair reads get bounded keys/types-only failure
diagnostics; live inspection still requires the exact Profile's content-egress
consent and original Source authorization. It is a durable/charged inspection,
not a side-effect-free read. Headless Sources goal explore/repair Runs receive a work skill for their
actual granted actions rather than instructions to invoke unavailable Task tools.
The handler contract explicitly documents base64 response bytes, exact SHA and
sequential requests. No Room concurrency behavior is changed by stage two.

Real generation and repair now have recorded native Agent evidence and a captured
fixture in `server/test/fixtures/sourceGoals/observations.real-agent.json`.
Five actual native model Runs included failed generation/repair attempts; the
final check replayed captured real generation and performed a new real repair.
Monetary cost was unknown. Synthetic candidates and replay are not additional
model generation. Full attempts remain in the implementation commit history.

### Stage-two closeout boundaries

The server validates the complete response's structure, IDs, links, times and
source scope before selecting a commit batch, for connector, recipe and isolated
implementations alike. It filters relevance independently, deduplicates against
successful items and selects at most the lesser of the goal batch cap and the
existing envelope item cap. A nonempty remainder freezes the upstream page and
business watermark. Successful commits alone advance the watermark; repeated
reads consume the remaining stable IDs, including equal timestamps. Byte,
file/evidence and request limits remain enforced. A recipe's own approved
extraction limit can truncate its view before this selection; the interpreter
reports this and the binding records an unrecoverable remainder, not completed
coverage or a parser fault. It neither increases that extraction limit nor
spends an AI repair attempt merely because a batch is large.

Calibration storage follows connection **and** execution-envelope policy.
`reference_only`, `metadata_only`, summary and text extraction do not permit raw
HTTP fixtures here. Only explicitly approved `archive_original` plus
`full_snapshot`/`archived` can retain original response bytes. Every retained
sample is bounded to 1,500,000 serialized bytes, carries its original expiry and
uses the existing Custom Source artifact retention enable/days settings; no new
TTL can authorize otherwise forbidden storage. Parsed sample output passes the
canonical retention filter at the minimum of connection, envelope and capture
permissions. Approved extract_text/full_text can keep parsed excerpts without
keeping raw HTTP; expiry/disable/delete downgrade those excerpts as well. Samples
without raw-retention permission discard untrusted diagnostics text and
implementation cursor fields, keeping controlled schema diagnostics. Previous and failure samples and repair live samples
obey the same rules. Existing artifact maintenance scrubs all these copies on
expiry or policy downgrade; reads/repair/start also recheck before using samples.
Goal deletion scrubs them immediately, without deleting successful SourceItems.
When no raw calibration can be retained, repair uses the transient validation
path below; it never silently enables archiving. A lone successful live response
is insufficient. The historical opt-in Agent smoke explicitly seeded archive
permission; its five model Runs are not re-executed for the transient path.

Only an actual `workflow_input_json.source_goal` explore/repair contract with
Source goal grants, no Session and no Task reporting contract selects the bounded
domain work skill. It has normal skill frontmatter. Other headless, Task,
Conversation and Artifact consumers retain their existing work skill.

Plan changeover, repair publication, explicit rollback and automatic rollback
reset implementation-specific cursor state. Only the server's committed business
watermark and successful item identities survive; tokens/pages/continuations and
pending derived state do not cross implementations. Existing gaps keep their
business windows and audit status but lose old implementation cursors. Pending
pages become explicit changeover gaps instead of being silently forgotten.
Exact preview/version checks, revision CAS and lease exclusion still apply.

The final implementation checks passed 5513 server tests (3 opt-in skips),
with no test or performance-gate failure. Five pre-existing server type errors
in two untouched test files were independently reproduced against the baseline.
Historical failed checks remain in Git history; these counts are a dated
2026-10-27 checkpoint, not a claim about future trees.


## Conversation setup and recovery

`/library/reading/goals/new`, `/library/reading/goals/:goalId` and
`/library/reading/goals` are the personal setup and management routes. Project
entrypoints use `/projects/:projectId/sources/goals[/new|/:goalId]` inside the
existing Project layout; both mount the same goal components.
ReadingStart keeps direct URL saving and opens setup without creating a goal,
Session or request. A cancelled unsent setup never invalidates the Reading list.
Source list/detail edit links carry `channel_id` into the same setup route;
legacy Project Sources/settings tabs remain valid deep links.

The browser reuses ConversationScope, ConversationView, useConversationDraft,
Run turn streaming and ActionPreviewCards. The server creates canonical Session
messages and existing headless source_goal Runs. Their `chat_turn` association
uses the existing finalizer to persist replies. Conversation Runs carry the
canonical `runs.session_id` before execution-control/context capture; recovering
a headless Run may attach a Session only while queued, unstarted and without
an execution-control snapshot. A different or already-captured scope is refused.
Sources goal Runs retain their bounded domain-action work instructions even
when linked to a Session; ordinary conversations keep their existing work Skill.
This adds no chat engine or model
route. The selected enabled owned non-system Agent/Profile must already exist;
missing setup refuses rather than creating a credential/model fallback.
Goal and message request keys make reconnect/replay idempotent. An interrupted
queue leaves a recoverable pending message; another message cannot race it.
Read projection returns `can_manage`; the server still rechecks every mutation.

This conversation is the topic page's Advanced section (see
[Topic reading journey](#topic-reading-journey-ui)), not the setup path: it
adjusts the plan, shows reasons, bounded cadence/usage, include/exclude
preferences and an optional real trial sample (retained title, origin, time and
excerpt). A partial, empty, expired or stale sample never blocks following;
only manual save needs a fresh one. All sources may be one type. A draft refinement invalidates its previews but leaves active bindings,
filters and intent snapshot running. Faster cadence than the approved goal limit
is refused; conversation cannot silently enlarge the spending envelope. Existing
finite exploration limits apply, with honest errors rather than unlimited retries.
Repairs use the active intent snapshot while a separate draft is being prepared.

Credentials are entered only at `/sources/access`, which submits to the existing
encrypted Source credential endpoint and retains no plaintext in browser storage
or messages. Server policy/admin gates and separate source authorization remain
required. Recognizable secret patterns are refused before initial goal storage as
well as before message persistence. The text-only goal composer does not expose
unsupported attachment or Retrieval controls; ordinary conversation consumers
keep their existing controls.

## Compatibility ownership and safe rollback

POST `/api/v1/sources/goal-setup/legacy` accepts `channel_id` and optional
`dry_run:true`. It validates owner, Space, Project writer and full Source access,
then maps each channel separately under a unique (Space,channel) identity.
Unknown original intent is labelled with the existing source/channel name;
unrelated sources are never combined. Repeated mapping is a no-op. Nullable
Agent/Profile fields allow this metadata-only mapping without inventing an Agent;
actual conversation still requires an existing enabled Profile.

Mapping preserves connection/channel IDs, Project binding, SourceItems and links,
subscriptions, request quota, legacy cursor/task metadata and next/last timestamps.
Legacy progress is read from the original task until scheduling is transferred.
Legacy goal pause/resume uses the original channel task and canonical Project
monitoring pause gate. Existing handler/recipe versions stay readable and their
legacy owner remains unchanged while mapped; no code is re-executed by mapping.
New goal code always uses the isolated executor and never falls back to the old
runner. Host capabilities confer no Source authorization.

Channel row locking and the database legacy-job admission guard serialize a
late old scheduler against takeover. Competing goals cannot both own a channel.
Repeated plan changes preserve the first transfer snapshot rather than replacing
it with an already-manual state. Project manual monitoring is also refused while
an active goal owns its source. Goal stop leaves successful SourceItems intact.

POST `goal-setup/compatibility_rollback` with `goal_id` restores the original
channel settings and task state before any goal collection has run, pauses goal
bindings/task, and releases the active version. It is idempotent and rechecks
Source management rights. After any goal Run exists it explicitly refuses an
automatic rollback, because translating implementation-specific cursors could
repeat or lose material. This conservative boundary is not a data migration or
history deletion; operators retain all original records and APIs.

Real Host/OS integration passed 39 cases. Real-backend browser acceptance passed
three scenarios (EN desktop, ZH narrow, Project), using real PostgreSQL/HTTP and
a deterministic external-Agent boundary, not live model execution. Compatibility
tests verify rerun/no-op, rollback and single scheduling ownership without
rewriting successful history. Standard-container successful isolation remains
a separate deployment gate; see [product acceptance](PRODUCT_ACCEPTANCE.md)
and the [deferred register](../tasks/deferred-register.md).

### Adjustment cycles and review-fix invariants

Each authenticated, new conversation message opens one audited adjustment cycle
(`adjustment_cycle` on goal/version and Run contract). Message-key replay reuses
its existing message/Run and never resets or charges the cycle twice. The existing
finite Agent-attempt and version limits apply within that cycle; automatic calls
cannot open a cycle. Canonical Profile, Run admission, budget and fee gates still
apply. The goal stores original intent plus latest adjustment rather than an
unbounded concatenation; the canonical Session retains the conversation. Old
exploration Runs cannot author a later cycle. Active collection and its approved
intent remain unchanged until an exact validated version is explicitly started.

Failed dispatch releases its pending claim and stores a safe failure category;
retry of a committed attachment returns the same Run. Disabled Profile, budget
admission and pause races do not leave permanent pending messages. A paused goal
can prepare a draft but cannot preview, send collection requests or follow until
explicit resume. Deleted goals refuse changes.

Legacy takeover also snapshots and pauses eligible historical backfill plans.
The dispatcher locks the channel without waiting on a conflicting takeover and
refuses legacy work owned by a goal before job/quota admission. PATCH and both
manual-scan entry points enforce the same domain owner under channel lock; the
DB trigger remains the final defense. Rollback compares complete managed row
snapshots and refuses intervening changes. Successful rollback clears effective
transfers, retains transfer audit, and restart obtains fresh snapshots. Resume
uses original owner rules: manual channels and Project monitoring without a
schedule remain paused. GET `goal-setup/legacy/:channelId` resolves an existing
mapping read-only with owner/Space/Project/content checks; absence creates nothing.

The goal composer opts into recognized-secret draft filtering before browser
storage and clears an older forbidden draft. This is bounded pattern detection,
not a claim to identify arbitrary secrets; credentials belong in the secure input
route. Other conversation draft consumers retain existing behavior. EN/ZH guidance
distinguishes budget, credentials, setup, active Run, stopped, access and version
conflicts. Owned Source settings link to goal controls rather than legacy PATCH.

Every explicit user request may open a new finite adjustment cycle. There is no
additional per-day goal total. Canonical Run/Profile cost approval and shared
account quotas still apply; automatic retries cannot renew their own budget.

## Automatic repair with optional raw calibration

Original response retention still requires explicit `archive_original` capture,
`full_snapshot`/`archived` connection and envelope policy, and enabled artifact
retention. No repair action grants retention, model egress, network scope,
credentials or extra spending. Existing cleanup runs before admission and use.
Admission checks source authority even when no stored raw sample exists.

With compliant, unexpired raw calibration and saved output, repair replays the
saved baseline (including stable-ID overlap), an available failure fixture, and a
live sample. Without it, metadata/reference/extract-text sources may also use the
same bounded repair Agent Run and exact-SHA isolated executor:

- Repair `read` omits real preview/content/history values. Repair `inspect` passes
  only bounded schema diagnostics and synthetic fixtures to the Agent. Source
  primitives, response headers and query values are replaced/removed before a
  tool result can enter Run history. Ordinary explicit exploration keeps its
  existing, consent-gated content behavior. Both paths keep the canonical
  Profile/Space/Source model-egress gate; synthetic data is untrusted too.
- The server performs two independent rounds. Each executes the candidate live
  once, validates its output and reuses its complete captured response sequence
  for a newly randomized synthetic replay offline. A one-request candidate thus
  uses two physical requests, not four; multi-request candidates retain their
  sequence across replay. A candidate needing N sends per live execution consumes
  2N validation requests, plus any earlier inspect calls; insufficient remaining
  budget never raises the approved limit. All actual sends use the same broker, original
  source fingerprint, account/endpoint quotas and per-Run request budget. Total
  transient validation has one 120-second deadline, without raising limits.
- Live response/output bytes stay inside the validation call and existing
  isolated execution channel. Trials do not materialize items or advance the
  committed business watermark. Only counts, successful check kinds, authority,
  active-version and canonical implementation hashes, plus a five-minute proof
  expiry are persisted. Publication rechecks proof, permissions, administrator
  controls, active version, binding revision and absence of a collection lease.
- Evidence must validate structure, uniqueness, relevance, timestamp/link/ID
  fields and same-record semantic anchors; a title cannot substitute for an ID.
  Known successful URI/ID pairs cannot change. Two HTTP 200 responses alone do
  not suffice. Synthetic values change between rounds to reject constant output.
  This is bounded evidence, not proof that a parser handles every possible input.
- The transient adapter supports bounded JSON and XML/RSS with recognizable
  semantic field names (ID/guid, title/headline/name, date/pubDate/publishedAt
  and links, including an approved endpoint plus ID). Unknown semantics,
  unsupported media, entity declarations, overlarge/deep schemas, or typical HTML
  without these anchors cannot auto-publish. They fail closed; no claim of
  universal HTML extraction or historical raw replay is made.
- A quota/network/Host interruption retains the generated candidate and retries
  validation once after cooldown through the existing goal tick, sharing the
  original Run request budget and consuming no new model Run/repair attempt.
  This candidate expires within 15 minutes and before the UTC quota-window reset;
  an interrupted recheck has a 130-second claim lease. Expiry, a cooldown beyond
  that deadline or a further transient failure pauses that binding. Other validation failures use
  the existing finite repair-attempt budget, then pause with stable
  `source_repair_validation_insufficient`. Paused bindings clear retry times.
  Only explicit Source authorization/scope errors report `source_authority_revoked`;
  cancelled/failed Runs and stale versions do not. EN/ZH offers a new source/plan and
  exact preview, without requesting archive opt-in. Other sources continue.

Explicit authorized explore can prepare a new plan; it does not resume a paused
binding, reset repair budgets, auto-publish or enable archiving. The old
`source_repair_calibration_unavailable` read reason remains compatible for older
paused bindings; this release does not silently resume them. Worker checks still
isolate known authorization/fingerprint changes as `source_authority_revoked`;
database/unknown errors are not disguised as revocation.

Reuse / Dependency Check: the implementation reuses the existing Agent Run,
Source executor, broker/quota, sample cleanup, scheduler tick, validation and CAS
publication. JSON uses the built-in parser; XML synthesis uses already installed
`fast-xml-parser`. Purpose-specific transient adapters add no dependency,
scheduler, model route or persistent raw-response store. Archive replay remains
available; no schema migration is needed.

### Reading execution selection

Initial Reading setup explicitly selects an owned active Agent and one of its
existing enabled runtime profiles. The setup API accepts the pair together;
creation idempotency also binds that exact pair. Existing API clients omitting
both retain the historical default selection. Legacy goals without an execution
binding accept the explicit pair with their first message; bound goals reject
silent changes. The UI shows the pinned configuration after navigation/reload.
Provider-backed profiles use their existing model API binding and spending gates;
native profiles use their existing runtime account. No credentials are entered
in Reading, and no model/provider fallback is introduced.

The Reading UI routes are `/library/reading/goals/:goalId` and
`/projects/:projectId/sources/goals/:goalId`; the corresponding list routes omit
the final segment. UI navigation does not relocate the `/sources/goals` API or
change collection, Run, authorization, quotas or scheduler ownership.

### Runtime options and execution feedback

Reading uses the existing conversation-backend catalog and ConversationSessionConfig
controls for runtime-reported model/mode choices. Explicit message selections are
validated against the selected Profile's current catalog, saved through the
canonical Session backend binding (the existing settings Save action can also
persist changes without starting another Run), and snapshotted as `acp_session_config` onto
the queued Run, including later headless exploration/repair Runs for the same
goal without changing their input/session scope. Same-message replay rejects different selections; saved selections
follow the existing reconciliation/drop notice contract. Provider-bound profiles
retain their Provider's fixed model. Missing advertised choices are disclosed;
there is no alternate model, account or spending route.

`goal.execution` is a read-only projection of the current adjustment cycle's
canonical Run, latest Source action and pending approval count. A failed/cancelled
or planless terminal exploration projects an exploring goal as needs-information;
active collection remains running. Safe failure reasons do not copy arbitrary
provider errors or response bodies. Existing failed Runs need no data backfill.
The goal view keeps the canonical turn stream through `chat_completed`, including
the interval between Run success/degraded and persisted assistant reply. Run markers
are read before message history so a completed snapshot cannot omit its reply.
Progress and pending Source decision cards render inside the conversation; the
plan panel leads with the saved plan summary and folds the original request.
Reading always offers goal recovery even with a nonempty recommendation list.

Source discovery distinguishes provider catalog entries from authorized channel
and connection IDs. The catalog includes creation requirements; a public URL
must be known for feed/page Sources. Activation returns a real paused draft and
reviewable proposal. No draft IDs may enter a plan until activation is approved
and a fresh authorized-source read returns them. Approval remains on the existing
Source proposal/applier path; requesting it is a successful stopping point, not
permission to fabricate IDs, bypass credentials or keep retrying failed writes.

### Source setup confirmation

Owner-started goal chat may submit a pending Source activation proposal without
a separate permission request to submit that proposal. The declared-resource
policy derives this exception from the current canonical goal owner, Agent,
Project, Session, adjustment cycle and bound user message; it is limited to
`source.channel.propose_activation`. Headless/repair Runs, stale cycles, other
users and unrelated requestable actions retain the existing grant gate. No
ActionApprovalGrant is created by setup, so activation remains pending unless
an independently existing human grant applies. The Source applier still owns
accept/reject, visibility, credentials, scope and quota checks. Pending proposals
are read through the existing viewer-aware action-preview projection and decided
inline through the canonical proposal API, without claiming another Agent turn
was started. Preview of an already authorized exact plan directly executes the
bounded sample; it creates neither a proposal nor a planning Run.

Reuse / Dependency Check: canonical Session messages, chat completion markers,
turn streaming, action-preview cards, declared-resource policy and proposal
applier are reused. No new queue, chat store, approval store or dependency.

### Built-in search preview and visible failure feedback

Goal execution reads a search channel's compiled query from the canonical
`source_search_specs`, just as the ordinary extraction worker does. That query
is part of the source fingerprint; edits require a fresh exact preview. A new
built-in Source without a recipe uses a valid bounded envelope (including a
positive log byte limit); missing Brave credentials fail before requests and
quota consumption. Credentials are never inferred from the Agent/model login.

Trusted built-in search connectors can return article links on origins other
than the search API and can lack publication dates. Their metadata-only output
may keep those returned links and an unknown publication date. The executor
and materializer independently derive the allowed metadata-link origins from
system-owned search parser output and the bound connector implementation; this
does not expand the request broker's network routes, the approved envelope,
snapshot/evidence permissions or generated-handler authority. Invalid provided
dates still fail, and generated implementations retain the existing strict
validation. No retrieval date is invented as a publication date.

Progress is a plain status line in the conversation, without an extra framed
panel. Preview shows immediate in-flight feedback and safe translated failure
reasons per source, including empty/filtered results, credentials, quota and
network failures. It displays only the current version's latest preview,
observation time and three-attempt budget. An exhausted version offers an
explicit draft adjustment, not an automatic Agent Run or budget reset. A
pending unexpired preview is resumed by reads/polling; concurrent reservations
for the same version are rejected. No live instance data is rewritten.

## Selected Agent-assisted search

New and saved-link processing share [Source material processing](SOURCE_MATERIAL_PROCESSING.md).
The goal module owns query/version/scheduler context, not an alternate content path.

Agent-assisted information search uses the existing canonical Agent Run, selected
Profile/model/mode/account, Host ACP adapter, queue, Work Skill and Run-scoped
system-action transport. No search-specific overlay, SDK manifest, CLI version
lock, collector launch command, plugin gateway or Host capability is required.
Ordinary Agent tool permissions and Host isolation still apply; this is **not** a
search-only tool sandbox. Default selection uses an eligible owned Agent and its configured default Profile;
explicit Agent/Profile selections take precedence. A managed Room assistant is not
a headless execution identity. Configured OpenCode profiles use the same path.
Runtime readiness is not proof that its chosen model/account can search. No API
or other Agent is substituted automatically. API sources retain their independent
credential preflight, consent, quota and exact-version gates.

A collection Run receives only `source.material.submit`, not general
Sources/Task/Artifact writes or `authorization.request`. Its strict public schema
requires a bound processing ID, succeeded/failed status, HTTP(S) URLs
without embedded credentials, titles, bounded nullable summaries, observation timestamps,
optional reading content (kind, source_text/agent_summary format, literal text and supporting URLs),
and explicit failure/coverage. Failed searches require zero items and a failure;
an actual zero-result search is succeeded with an empty array. Final conversation
text, JSON answers and native tool events do not submit results. Returned links
are **Agent-provided, not independently verified**; neither a valid URL nor a
successful action attests retrieval, publication date or source truth. External
text cannot grant authority.

The dispatcher exposes the actual action schema. Invalid submissions return field
paths; at most three format/semantic submissions are allowed in the same Run,
without new model Runs or renewed model-attempt budgets. Identical accepted
submissions are idempotent; a different replacement is refused. Each call reloads
the persisted running Run, its sole grant, deadline, owner/Space/Project, selected
Agent/Profile/configuration and Source/version authority. Cancellation, expiry,
revocation and stale results fail closed. A corrected submission may settle a Run
degraded solely by this action's field-validation errors (including transcribed
bound IDs). Once a valid submission exists, this action's already-recorded/limit
refusals do not discard it. Actual authority revocation and any other action
failure still prevent acceptance. Queued time does not consume the 600-second dispatched
execution budget; deadline recovery takes effect on the next existing tick/read.

New Agent-search drafts request extract_text/full_text so the Agent can autonomously
read articles or repository README/docs and submit readable, attributed material.
The same action supports both original text supplied by the Agent and Agent synthesis;
neither is independently verified. A link that cannot be read can disclose a bounded
unavailable reason. Per-item and aggregate text/byte limits keep submissions bounded.
Existing sources retain their actual consent/capture/retention policy: reference-only
and metadata-only sources require null summary/content; summary-only permits a short
summary, not a retained body. Policy checks run before audit persistence and again at
settlement. Policy changes invalidate the exact preview rather than expanding it.

Body text is converted by the server to literal paragraphs in an extracted JSON
Reader document and passed to the existing Source materializer, ACL inheritance,
indexing and recovery. No raw-page snapshot, external image, HTML execution or
Agent-supplied file path is accepted. Full-text retention permits these extracted
Reader documents through the shared inline content writer, not handler snapshot
files; original snapshots still require archive permission. Completed
submission/recovery copies are removed by existing goal sample maintenance, which
also reapplies current Source policy. Existing credential-text safeguards apply,
but cannot detect every possible secret. URL deduplication, per-source budgets and
unknown publication dates remain unchanged.

Reuse / Dependency Check: reuse the existing submission gateway, Source policy,
structured Reader documents, canonical Source materializer and sample maintenance.
The Agent's existing read tools choose acquisition; no new fetcher, model loop,
CLI driver, parser dependency or scheduler is introduced.

Preview and ongoing collection share the same Run queue and result validator.
Closing Reading preserves canonical progress. Start requires a fresh qualified
preview of the exact immutable version and reauthorizes every Source. Draft
adjustments do not mutate the active plan. A fresh preview can be saved directly
to Reading (`execution_mode=manual`); ownership/subscription promotion and sample
staging share one transaction. It uses the same materialization lease/recovery and
stable-ID dedupe, with no active scheduler. Continuous collection reuses the
existing scheduler owner. Successful item persistence precedes cursor commit;
restart replays accepted output, not a paid model call. CAS prevents old Run
settlement from pausing or overwriting replacement bindings. Failure, actual zero
results and preview insufficiency remain distinct. User cancellation does not
silently create another paid Run.

Native supplier requests, quota and cost may be unknown and are not Source broker
request counts. Existing Run/Profile spend/account admission and automatic-run
standing consent remain authoritative. There is no extra per-CLI search-capability
promise. Deterministic external Agent submission fixtures test the real PG/backend
and browser path; they are not live Agent/search success or new paid model calls.
No database migration is needed; existing JSON audit storage and catalog IDs are
reused, preserving administrator state and existing source history.

Reading cards and the shared Reader expose a whitelisted Agent-provided/unverified
provenance enum, derived by the server from the collection implementation and
preserved under metadata-only retention. Reader labels Agent synthesis separately from
Agent-supplied source text and lists supporting URLs. Links without saved text show
an explanation and an original-source link instead of an unexplained blank page.
Source/Space/Project consent still applies.
Malformed submission attempts use the same gateway policy/audit path before counting.

Agent-path planning reads the goal and describes the version-write action, then
saves an `agent_search` query without connection/channel IDs. It does not inspect
API connectors or enumerate API prerequisites. API and repair instructions retain
their own plan shapes; planning never performs the subsequent search preview.

Agent search previews allow bounded search and reading in the same existing Run.
The Agent chooses the resource type and what to read, preferring fewer useful,
readable results over a long link list. Repository results may summarize README
and documentation; article results may supply text or a clearly labeled synthesis.
Item limits remain ceilings, not targets. Access failures keep the link with an
explicit reason. Coverage remains non-exhaustive; tool failure without results is
submitted as failure rather than waiting for the deadline.

## Continuous following: confirmation, lifecycle and topic membership

`source_goals` remains the single authority for a followed topic; a Project is
its scope. `POST /api/v1/sources/goals/:goalId/follow`
(`SourceGoalFollowRequestSchema`, `SourceGoalService.follow`) is the owner's one
confirmation of the topic's frequency and per-run budget (bounded by
`SourceGoalBudgetSchema`). It persists `source_goals.follow_json`
(`SourceGoalFollowSchema`: confirmer, idempotency key, pinned version or null,
limits, activated version, reused preview, last refusal) and needs no manual
preview:

- With a current plan, `goals/activation.ts#activateGoalVersion` activates that
  exact immutable version in the same locked transaction: every Source is
  preflighted and fingerprinted, scheduling ownership transfers, native drafts
  are promoted, bindings get their authority fixture, and `source_goal_tick` is
  due now. Spend/account/Run admission, credential and new-Source gates are the
  unchanged downstream checks. A pinned `version_id` must equal the current
  plan; a later draft stays inactive until the owner confirms it.
- Without a plan, the confirmation and its preparation commit together: the
  existing bound planning Run and its queued job (`queueSourceGoalAgent('explore')`,
  deduplicated and attempt-bounded, joining the follow transaction under a
  savepoint) are written in the same transaction, so there is no window where a
  confirmed follow lacks durable background work. A determinate refusal (for
  example a disabled Profile) rolls back only the savepoint and is recorded as
  `follow_json.last_error`; database faults abort the follow. The first plan
  the planning Run writes activates inside the plan-write transaction under a
  savepoint; an activation refusal is recorded and never fails the plan write.
- A fresh exact-version preview is optional. When one exists, its succeeded
  Agent-search contributions become the first batch through the existing
  accepted-output/materialization lease (`manualSearch.ts#stagePreviewBootstrap`);
  settlement then defers that binding's next check by one interval, so one
  confirmation never pays twice for the same window. API/recipe bindings start
  from a fresh bounded check. An empty or partial preview never blocks following.
- Replaying a key with the same limits ensures the confirmed bootstrap: while
  nothing is active it re-attempts the missing preparation, or the first-plan
  activation for a plan whose activation was refused, without a second attempt
  charge when work already exists (queued planning Runs are reused). It never
  activates a later draft of an already active goal. The same key with
  different limits is `source_goal_follow_key_changed`. Concurrent confirmations
  and replays serialize on the goal row. A paused follow uses resume; a
  manual-save goal may follow.
- Post-commit cleanup (`cancelSupersededCollections`) acts only while the
  caller's version is still the authoritative active version and re-checks each
  victim's version against the current active version immediately before
  cancelling, so a delayed older activation never cancels a newer version's
  queued or running collection.

The former preview-gated continuous `start` is removed with its UI, tests and
fixtures; no alias remains. Manual save (`POST .../save`, Agent-search plans
only) keeps requiring a fresh exact-version preview because it stores that
sample; a stale, partial or expired preview only blocks manual save, never
following.

### Goal ↔ SourceItem membership

`source_goal_items` records which materials each goal collected. The goal
materializer (`materialization.ts` → `goals/goalItems.ts`) writes it in the same
transaction as items and the cursor, from the server-held goal, active version,
leased binding, connection and collection audit (`first_goal_run_id`,
`last_goal_run_id`, Agent `agent_run_id` when present). Item ids come from the
canonical materializer's actual written/matched rows, including items already
stored for that connection and canonical-URL matches from other Sources, so one
SourceItem can belong to several goals, including two goals on different
channels of one connection. `selection.ts#selectGoalPage` treats new items and
stored items this goal has not yet recorded as one unprocessed list sharing the
per-run batch in source order; stored items already recorded for this goal are
refresh-only (`last_goal_run_id`) and never consume the batch. The page and its
watermark are consumed only when nothing remains unprocessed; otherwise the
cursor stays `pending_page` with `remaining_count`, committed with the recorded
memberships, and the next check continues. Stored content and reading history
are never rewritten, and recorded members advance the watermark only by their
persisted `occurred_at` when newer. A deleted (tombstone) row still suppresses
re-materialization so it is never resurrected, but it is not membership work:
it takes no batch, keeps no page pending, never joins a goal and contributes no
watermark. Model-authored metadata never creates
or removes membership. `selection_status` is `unjudged` from collection; the
`important` / `not_selected` / `judgment_failed` values and `selection_reason`
are reserved for topic judgment (not implemented in this phase). Migration 0006
backfills only memberships provable by the previous Reading proof (a succeeded
goal audit, its binding's connection, the same Project, or for a personal goal
an item owned by the goal owner); forged audits, failed audits, another
connection, scope or owner never backfill, and rerunning it is a no-op.

### Follow-state projection

Goal list/read return `follow_state` (`SourceGoalFollowStateSchema`,
`goals/followState.ts`) with separate dimensions: intent (unconfirmed /
following / paused / deleted, pending adjustment), phase (preparing, waiting for
permission, first collection, checking, scheduled, blocked, stopped), per-source
health (ok, collecting, backoff, needs_permission, failing, stopped, with the
stable error code from the binding or its latest collection audit), and results
(membership totals, each source's latest finished check: new items / no new /
partial / failed, last checked, last success, next check), plus `collections`:
in-flight collection audits split into `queued` (waiting for a worker or Agent
slot; a native audit counts as queued while its Agent Run is queued) and
`running`. Authorization errors are `needs_permission`, never "no new items";
native collection refusals keep their stable code (Profile/route/safety/credential,
spend budget) instead of one generic refusal, while network, parsing and unknown
failures stay `failing`. Each problem source also carries `attention` and
`resolvable_by`, the same in list and detail:

- `source_changed` (you / topic_owner): a paused binding refused with
  `source_authority_revoked`/`source_scope_changed` whose Source and channel are
  still active, under the same owner and Project (normally its fingerprint now
  differs from the binding's `authority_sha256`; one changed back stays
  confirmable, since only the owner resumes the binding) — the Source was legitimately changed
  after confirmation (e.g. an accepted `source_material_retention` proposal from
  Reader "allow saving text" sets `extract_text`/`full_text`). Health
  `needs_permission`; resolved in the topic by reconfirmation (below).
- `access` (source_owner, or the topic owner for credential/search-path
  decisions): the Source is unavailable, archived, paused, moved or now owned by
  someone else; the topic cannot resolve it. Health `needs_permission`.
- `setup` (Agent Profile/route/native safety) and `budget` (spend or exploration
  budget): `failing`, never `needs_permission`; when no source is collecting the
  phase is `blocked` with that reason.

A latest-run error that ended before the binding's `confirmed_at` is not
reported again.

### Source change reconfirmation

Activation records, beside `fixture_json.authority_sha256`, the readable
`authority_scope` (capture/retention policy, statuses, credential use, owner,
Project and short digests of endpoint/query/versions/consent/policy/config) and
`confirmed_at`. `GET /api/v1/sources/goals/:goalId/bindings/:bindingId/source-confirmation`
(`goals/reconfirm.ts`) shows the goal owner the Source as it is now: who can
resolve it, current scope, changed keys (null for bindings confirmed before the
scope was recorded), accepted proposals on that Source since the later of
confirmation and last success, and the current fingerprint as an opaque
`authority`. It runs the full activation preflight as the owner; a refusal is
`source_access`. `POST` (same path, `source.goal.manage`, body
`{binding_revision, authority}`) locks the goal and binding (FOR UPDATE),
requires the same revision, a `source_changed` pause (on the binding or, for
connector collection, its latest run since confirmation), no lease and the
Source in the active plan, then takes FOR SHARE locks on the rows the
fingerprint is computed from — `source_connections`, `source_channels`, the
channel's `source_search_specs` — in that order, and only then runs preflight
and compares the fingerprint. Lock order is goal → binding → Source → channel →
search spec, the same goal-before-Source order as repair admission
(`goals/agent.ts`); Source writers never lock goal rows. A Source write that
committed before the confirmation's locks is seen and refused; one that arrives
while they are held waits for the confirmation to commit and is then a new
change the next collection refuses (confirmation does not prevent later
changes). Channel edits that also rename the Source lock channel before Source;
if that rare opposite order deadlocks, PostgreSQL aborts one side and a
confirmation aborted that way is 409 `source_scope_changed`, nothing confirmed.
Any difference is 409 (`source_binding_changed`, `source_binding_not_blocked`,
`source_binding_not_active`, `source_scope_changed`). On success it activates the
binding (revision+1, errors cleared, new authority/scope, `reconfirmed_by`); a
retried identical request returns the result. Nothing else refreshes a
fingerprint: reads, list, ticks and resume keep refusing, so old topics recover
only by this explicit owner step, without rebuilding the topic.

Goal list and detail stay available to a viewer who may manage or read the goal
even when a bound or historical Source is deleted or no longer readable. Only a
Source access refusal (403/404) marks it unavailable; other errors propagate.
For an unavailable Source the detail omits its binding spec, fixture, cursor and
repair candidates, its plan entries (listed by id in `unavailable_sources`),
preview sample and collection results, and `follow_state` reports it as
`source_unavailable` (needs permission) alongside the healthy Sources. It reads canonical
rows only; it is not a second state machine, and explore progress is only its
preparation input.

### Freshness, topic judgment and owner feedback

Collection for a followed topic stays on its existing managed Run, Profile,
account and model: Agent-search bindings submit through `source.material.submit`
and structured Sources keep their own cursors. The collection prompt asks the
Agent to keep discovering relevant public sources within its existing
permissions; a found link never authorizes credentials, paid APIs, private
Sources or wider access.

Submission items may carry `published_at` (only a time the source itself
states; future claims are dropped), `change` (`new_publication`/`release`/
`update` with an `evidence_url`) and `topic_judgment` (`important` or
`not_selected` with a reason); `judgment_failure` reports that judging failed.
These signals travel with the accepted output (and a preview contribution, so
a reused preview or manual save keeps them) and are applied by
`goals/topicJudgment.ts` inside the materialization transaction, together with
items, membership and cursor:

- Delivery (`source_goal_items.delivery_kind`): a new membership inside the
  binding's first-collection window, or from a history window, is `baseline`.
  The window is persisted as `cursor_json.baseline_window` with
  `baseline_pages`: it stays `open` while the current response still has
  uncommitted rows (bounded batches) or the upstream explicitly reports another
  page, and becomes `complete` after the last page commits. Continuation is read
  only from existing connector contracts (`selection.ts#upstreamContinuation`:
  `cursor` token or null, `offset` number or null, `more_results_available`);
  any other cursor shape is one page. At most `BASELINE_MAX_PAGES` upstream
  pages belong to the window, so an endless provider cannot extend it; deeper
  backlog is judged by time. Window state commits with the batch, survives
  cursor resets (which drop only the continuation) and stays open when a batch
  fails; bindings without the flag fall back to "never succeeded".
  Afterwards a newly recorded cited release/update is `evidenced_change`; a
  valid source-stated time strictly after the committed previous watermark is
  `new_publication`; anything else — no time, an equal or older time, a future
  claim, or no committed watermark — is `unknown_freshness`. Agent change labels
  never bypass the time rule, and observation time is never publication time.
- Change history (`source_goal_item_changes`): a cited release/update of a
  material is recorded once per goal, item and evidence URL with its source
  collection and Agent Run and its own judgment, so a repeated entry page or the
  same evidence is never delivered again while a later, different change is.
  A newly recorded change outside the baseline window becomes the member's
  latest delivery (`evidenced_change`, `change_evidence_url`) and re-judges the
  member unless the owner decided. Stored bodies, reading revisions and reading
  state are never rewritten (a canonical match from another Source may refresh
  title metadata, as the materializer always did). Goal detail returns the
  recent `changes`, omitting Sources the viewer can no longer read;
  `follow_state.results.changes_total` counts the viewer's full-readable cited
  changes; material totals count currently readable memberships, not all-time
  administrative totals. Actual SourceItem ACL/Source consent/Project access is
  applied before the recent-history limit; the collecting binding is provenance,
  never a replacement for the item's actual storage connection authority.
- Same-URL change delivery: a new cited change to an existing member outside the
  baseline window receives `delivered_at` in the same materialization transaction.
  Reading projects it as `topic-change:<change id>`, sorted/paged by delivery time,
  with `topic_change` identifying the exact topic and evidence. New material is
  delivered once as material, not again as a change. Evidence replay cannot create
  another change. Older history predating this delivery field remains history;
  the migration does not re-run collections or retro-deliver old changes.
  `source_goal_change_user_states` records each viewer's acknowledgement/dismissal
  of that exact change. `Reading.state.topic_change_id` rechecks canonical item
  and goal access in the write statement. Reading and Reader confirmations of v2
  cannot acknowledge v3 or another topic/user. SourceItem reading state, body
  revisions and annotations remain unchanged. The Reader has an explicit update
  confirmation; opening a link alone does not acknowledge it.
  `last_new_items` counts newly linked materials; `last_new_changes` separately
  counts newly delivered same-material changes. Either makes the last collection
  non-empty; mixed collections do not count one new material twice.
- Business watermarks use server-owned calendar/finite-time validation with the
  existing five-minute clock tolerance. Future/malformed publication claims never
  advance committed or pending watermarks, including already-stored members.
  The shared selector/materializer and executor guard cover connector, recipe,
  isolated and Agent result paths. Raw source-stated dates remain under existing
  retention policy and do not become trusted publication facts. A leased worker
  repairs old polluted cursors from a valid committed audit watermark, otherwise
  the earliest valid committed member, conservatively replaying when necessary.
  Invalid continuation is retired into a coverage gap for server audit (not
  exposed as a public continuation); success history is not rewritten. Supported
  history uses the existing bounded gap recovery/quota path; unavailable history
  stays explicitly unrecoverable. Neither unknown time nor a successful HTTP
  response claims complete coverage.
- Judgment (new or still-unjudged memberships; owner feedback is final): owner
  exclusion rules → `not_selected` (`judged_by=owner`); else the collecting
  Agent's judgment (`collection_agent`); else deterministic topic rules — an
  include term in the title → `important` (`topic_rules`); else a reported
  judgment failure → `judgment_failed`; otherwise `unjudged` (pending). Judgment
  costs nothing beyond the collection Run and is never retried by itself.
  Every candidate remains stored and listed under the topic's `all` view; the
  plan's explicit include/exclude filters remain scope, applied before storage.

`POST .../goals/:goalId/feedback` (`SourceGoalFeedbackRequestSchema`) applies
only tightening: `exclude_origin` and `exclude_term` add to
`follow_json.rules` and mark matching members `not_selected` by the owner;
`not_relevant` marks one member of this topic; `slow_down` lengthens the
interval and never schedules an earlier check. Each idempotency key applies
once and is stored with a payload hash: an exact replay is a no-op, a reused key
with a different payload is `source_goal_feedback_key_changed`. Faster collection, larger budgets or new Sources are refused here and go
through `follow` and the existing Source/credential gates. `follow_state.results`
reports totals by selection and delivery kind. Phase 2 does not cluster events,
verify facts or claim complete web coverage; importance is not verification.

## Topic reading journey (UI)

The personal routes `/library/reading/goals[/new|/:goalId]` and the Project
routes `/projects/:projectId/sources/goals[/new|/:goalId]` mount the same
Sources-owned page (`SourceGoalPage.tsx` → `topics/`). Project topics keep the
Project's read/write and Source ACL; nothing is shared across scopes.

- **Create** (`topics/TopicCreate.tsx`): the topic text, a frequency
  (6h/12h/daily/3 days/weekly) and an effort preset (requests and items per
  source, inside `SourceGoalBudgetSchema`) are the only required inputs. One
  confirmation is a single `goal-setup/begin` carrying `follow` (and, when an
  Agent/Profile was chosen, its `session_config`): the topic, its search path,
  explicit model/mode choices (validated against the Profile's catalog and
  saved on the topic's canonical Session) and the follow confirmation commit in
  one transaction (`SourceGoalConversation.begin` → `SourceGoalService.followLocked`
  with key `begin:<creation key>`), so the first planning Run is queued already
  carrying the chosen `acp_session_config`. A replay with the same key and
  payload (fingerprinted in `compatibility_json.creation_fingerprint`) returns
  the same topic and reuses its queued planning Run without charging another
  attempt; a changed payload is `source_goal_creation_key_changed`; concurrent
  replays serialize. Without an explicit choice the server's existing default
  Agent/Profile is used, and a replay keeps the pair it was confirmed with
  (a since-disabled Profile is refused, never replaced). Typing or opening the
  page writes nothing. `GET goal-setup/begin/:creationKey` (owner-only) finds a
  committed creation only in the exact requested Space and personal/Project scope.
  It revalidates canonical goal/Project read access before returning an identifier;
  deleted or unreadable Projects, other owners and scope mismatches remain hidden.
  Lookup never writes or follows a draft. A lost response opens that topic; when nothing was
  committed the page keeps the confirmed choices and the same key (never the
  topic text) for the owner to resubmit. A legacy `?channel_id=` link opens its
  existing mapping read-only, or maps it, sends the described topic as its first
  message and follows; on return, follow is continued only if that message is
  shown committed. Recognized secrets are refused before any write.
- **Topic page** (`topics/TopicDetail.tsx`): the update stream comes first —
  the canonical Reading API filtered by `topic` with `topic_selection`
  `important` (default) or `all` (`?selection=all` survives refresh). Items show
  freshness (background / new / changed / unknown), judgment, its stated reason
  and who judged, cited change evidence and the unverified Agent label. Reader
  links return to the exact topic view. Empty states distinguish preparing,
  first collection, paused, "checked, nothing new" and "nothing important yet".
  The side panel shows `follow_state` dimensions (phase, health, queued/running
  collections, last/next check, last outcome, per-source health with localized
  reasons by `attention`/`resolvable_by`; missing permission is never "no
  updates"). A `source_changed` source offers "Review change and continue": a
  dialog with the current scope, what changed or related decisions, and the
  effect; confirming sends the shown revision and token and a 409 shows the
  current state again. The Source page link appears only for `access` problems
  (not for a change, setup or limit the topic resolves); badges and the waiting
  phase name the category and who is waited for (`topics/attention.ts`), the
  change history, and management: pause/resume, delete (material kept),
  tightening-only feedback (not relevant, hide a site, exclude a word, check
  less often). Pause is offered for any confirmed topic, including one still
  preparing (no active plan): it cancels the planning Run, and a plan that Run
  still writes stays a draft. Resume of such a topic continues the same
  confirmation — the current plan activates, otherwise one planning Run is
  ensured within the original attempt budget and Profile/spend gates (a refusal
  is recorded as the follow's blocked reason, not charged again). Unconfirmed
  drafts and manual-save topics offer neither. A binding whose Source the viewer
  can no longer read arrives redacted (`SourceGoalUnavailableBindingSchema`:
  identity and state only); the status panel shows it as an unavailable Source
  with no details or link, while healthy Sources stay listed. An unfollowed or manual-save-only topic offers the same follow
  confirmation; a pending adjusted plan is applied with `follow` on that exact
  version. The plan conversation, plan details, optional trial sample, manual
  save and Agent/model/mode settings are folded under Advanced. Collection
  progress is shown only in the status panel, not repeated in the chat.
- **List** (`SourceGoalsList.tsx`): each topic with its phase, health,
  important/total/changes counts, last/next check, open, pause/resume and
  delete.

Existing data needs no migration for this journey: unconfirmed drafts stay
unfollowed (their page offers the confirmation), paused topics stay paused,
manual-save-only topics stay manual until confirmed, previously started
continuous goals keep running, finished Runs are never re-run, and reading
state, annotations and Source permissions are untouched. Following never widens
access, budget or credentials; a found public link is not authorization. The
product choices behind this journey — one confirmation, continued discovery of
public sources within existing permissions, important-by-default with "all"
meaning only what was actually collected — are recorded here and in
[library](../modules/library.md); history lives in Git.

Real-backend browser acceptance (`test/sourceGoalBrowser.browser.ts`, EN
desktop, ZH narrow, Project EN) drives this journey through HTTP, PostgreSQL,
the scheduler tick, the materializer, Reading and Reader in Chromium. Only the
planning Agent is a deterministic fixture that writes the plan its real queued
Run would write; it covers the first collection, an incremental new
publication, no-update, a partial Source failure, a Source changed after
confirmation (explained in the topic, a change meanwhile refused and shown again,
then confirmed and collected), a deleted Source (access), Important/All with refresh, the Reading topic filter and
Reader return, pause and delete. It is not evidence of real search quality.


## Manual check of a followed topic

The owner's Topic management section exposes **Check now** independently of
Refresh progress (a read). `POST /api/v1/sources/goals/:goalId/check` takes the
shown `expected_version_id` (null only for a legacy schedule). It requires the
existing `source.goal.manage` gate, owner/Project writer and a running follow.
Paused/deleted/unconfirmed/manual-save topics are not resumed by this action.

Admission locks the goal, checks the active version and current Source
preflight/fingerprints, and queues the existing `source_goal_tick` worker.
Scheduler admission uses the same queue helper and goal lock: an outstanding
job, live native Run or unexpired binding lease is reused instead of starting a duplicate.
An expired lease or abandoned/terminal audit alone never blocks the recovery tick.
The job carries the active version; a superseded version stops without executing.
The worker still enforces Source authority, budgets, runtime, cooldowns, cursors
and materialization. No pause, repair or cooldown is cleared, no history reset,
and manual admission does not change the automatic cadence. Queue acknowledgement
is not collection success; pending ticks appear in the existing follow-state
queue counts until per-source collection audits take over.

Legacy-owned following uses the original channel's `scanChannel` path after
owner/Source checks and channel locking. Existing pending/running channel scans
are reused; it does not transfer scheduling ownership or create a goal tick.
The entry is owner-only, disabled while stopped or collecting, and reports a
queued/in-progress acknowledgement or retryable failure. UI late replies cannot
show a previous topic's acknowledgement after scope/session change.

Reuse / Dependency Check: reuse `PgJobQueueRepository`, the scheduler's goal row
lock, `runSourceGoalTick`, metadata-only `preflightGoalSource`, original channel
scan and follow-state projection. No new queue, model path or dependency.


## Latest collection arrival in topic cards

Both the main Reading list and a topic-filtered Reading response may set `topics[].new_in_latest_collection`.
It compares the server-owned first membership Run with the latest finished
collection audit for that binding, bounded by the page's as-of time. Only a
successful/insufficient terminal collection can mark membership, and the viewer
must have full material and collecting-Source access. Pending checks keep the
previous finished check; a later empty, repeated or failed check does not mark
old material as newly collected. Independent change deliveries do not receive this marker. Main Reading computes
it only over goals visible in the current personal/Project scope; a topic filter
limits arrival projection to that goal. It is neither publication freshness nor
a durable since-last-visit acknowledgement, and reading this projection writes
no state. Original publication/change classifications stay in Details.

Main Reading and Following cards share `ReadingStatusBadge`, replacing the existing unread chip with **Just collected / 本次新增**
only for unread arrivals. No extra badge, row, card background, button or count
is added. Read/skimmed states retain their existing chip; a tooltip explains the
per-Source latest-finished-check meaning and does not claim recent publication.
Reuse: existing membership/audit provenance, Reading ACL/collection gate,
existing Badge and metadata row; no schema migration, client timestamp or
second freshness store.


### Reading-method integration and layered readers

Agent-native collection uses the versioned investigation strategy without changing
its requester/Source consent or per-reader full/summary projection contract.
A Project's private brief/constraints/instructions may influence saved material
only when the connection and canonical output item belong to that Project.
Otherwise collection continues as ordinary evidence-led reading using the
Space/system method, with an explicit missing-Project-context note and a null
Project in both Run and closed WorkContext. It does not request wider Source
sharing or secretly inject Project instructions. Actual Source revocation still
fails existing preflight; ordinary layered readership is not authority revocation.
Delivery and final writer check frozen context, actual egress and output scope.
