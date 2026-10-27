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
and repair candidates. POST suffixes `explore`, `preview`, `start`, `resume`,
`pause`, `delete`, `rollback` operate the domain. Preview names an exact
`version_id`; start names that version, its fresh `preview_id` and an
`idempotency_key`. Rollback names binding and expected revision. A repeated
start returns the existing state, including a paused state; it never resurrects
work. Start transfers the selected channels only after a fresh exact-version preview.
Within the same transaction it locks the channels, refuses pending legacy work,
pauses their old scan/Project-monitoring tasks, and sets manual channel frequency
before creating the single goal task. Mapping alone never transfers schedules.

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

`/sources/goals/new[?project_id=…]`, `/sources/goals/:goalId` and
`/sources/goals` are the shared Personal/Project setup and management routes.
ReadingStart keeps direct URL saving and opens setup without creating a goal,
Session or request. A cancelled unsent setup never invalidates the Reading list.
Source list/detail edit links carry `channel_id` into the same setup route;
legacy Project Sources/settings tabs remain valid deep links.

The browser reuses ConversationScope, ConversationView, useConversationDraft,
Run turn streaming and ActionPreviewCards. The server creates canonical Session
messages and existing headless source_goal Runs. Their `chat_turn` association
uses the existing finalizer to persist replies; it adds no chat engine or model
route. The default enabled owned non-system Agent/Profile must already exist;
missing setup refuses rather than creating a credential/model fallback.
Goal and message request keys make reconnect/replay idempotent. An interrupted
queue leaves a recoverable pending message; another message cannot race it.
Read projection returns `can_manage`; the server still rechecks every mutation.

Desktop presents conversation beside plan/sample; narrow screens switch these
panels on the same page. Plan cards show reasons, bounded cadence/usage and
include/exclude preferences. Real samples show retained title, origin, time and
excerpt. Partial/empty/expired/stale previews cannot start. All sources may be
one type. A draft refinement invalidates its previews but leaves active bindings,
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
can prepare a draft but cannot preview, send collection requests or start until
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
