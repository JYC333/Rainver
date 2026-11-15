# ADR 0029 — Isolated execution workspaces and verified integration

Date: 2026-11-06; native-session simplification: 2026-11-08; delegated placement and grouped overview: 2026-11-10
Status: accepted for staged implementation; enabled paths are documented in the owning guides.

## Scope

This decision supersedes ADR 0016 §11 and B19/B65 only for newly admitted
conversation/delegation execution explicitly stamped with isolated workspace
version 1. Existing Runs retain their immutable contract. Task completion,
Project authority, Host ownership and the server-only code_patch path retain
those decisions' other constraints. Current implementation and recovery behavior
are documented in the [Hosts](../modules/hosts.md) and
[Project Files](../modules/project-files.md) guides. The completed implementation
plan was retired on 2026-11-07; its execution and review history remains in Git.

## Decision

A registered Location identifies the source and target repository, not an
exclusive execution directory. New folder-backed conversations run in a
Host-owned Git worktree before the ACP process starts. One logical workspace
belongs to a conversation, Task or delegation and a Location; retries and
continuations reuse it. Independent (parallel) delegated writers fork a frozen parent
checkpoint and integrate back into their parent before root publication;
serial delegated work reuses the coordinator's workspace (see "Delegated
workspace placement" below).
No Task Board object is invented to obtain a workspace.

The control plane owns logical workspace/change-set identity, authorization,
completion intent, integration and cleanup Jobs. The Host owns physical paths,
Git metadata and idempotent step journals. References contain identity and
generation, never caller-supplied absolute paths. Unsupported Hosts and invalid
repositories refuse isolated execution rather than running in place. Worktrees
are not a security boundary on trusted personal Hosts; strict execution keeps
namespace enforcement and the registered owner's/Project's existing authority.

A change set snapshots its base, result and completion basis. Checkpointing is
not publication. On native-integration Hosts, completion records a durable Git
operation while the Agent remains active. The Agent prepares, repairs, checks
and publishes before ending its turn. A cancelled/ended Run cannot start new
publication; an already-applied publication can still be reconciled from evidence. A worktree may contain unpublished commits;
physical-tree reclamation must preserve the refs needed to recover them.

A workspace failure belongs to that generation. Blocked or exhausted checkpoint
recovery remains explicit on that identity; a new turn cannot allocate another
workspace around it. Existing authorized recovery, Project/Host/Location checks
and immutable old bindings remain mandatory. An absent launch receipt is an
operational recovery failure, not evidence of a permission breach.

Checkpoint identity is `(Run, workspace, launch_sequence)`: a logical Run may
yield and resume several times. The existing workspace binding owns recovery
for its current launch; change-set summaries do not authorize retry or block
other bindings. Host receipts keep each launch's saved version, including no-op
takeovers. Runtime exit and the existing recovery Job use one checkpoint
lifecycle, and only a durable save admits dependent children. Stale Jobs and
callbacks are fenced by launch/recovery identity and cannot report a newer save.
Reuse / Dependency Check: this extends existing bindings, Jobs, Task leases and
Git settlement rather than introducing an orchestrator, Agent loop or queue.

Native-session integration reuses Git and the existing Host publication helper.
The Agent keeps its native session, cwd, profile, dependencies, cancellation and
Run budget. `workspace.change.complete` admits prepare/checkpoint/publish intents
through Operation Core and a durable Job. Its afterCommit hook only kicks that
rebuildable intent. `workspace.change.get` reads the actual result and revision.
Checkpoint alone saves privately without publication intent, and settlement
preserves native commit identities/history. No Host I/O happens in the core transaction; no Agent loop is owned by Rainver.

Preparation rebases by default: the batch's own commits after its frozen base
(never the base itself, so a private snapshot baseline does not travel) are
replayed one at a time onto the target in the same owned worktree, and
publication fast-forwards the target to them, keeping their authors and
messages. A conflict stops at its commit for the Agent; the next prepare
continues. Squash, one new commit carrying the whole baseline-to-source delta,
is used only on the person's explicit request; fast-forward and merge of an
unchanged chain remain explicit plans. Preparation preserves a preimage,
dependency/build directories and all source history. The Agent resolves conflicts and necessary related files
with its ordinary tools. There is no frozen repair-path allowlist, configuration
phase, fixed one-repair budget, candidate profile or final-summary invocation.
Trusted Hosts allow normal Git in the Agent's own branch; strict Hosts keep
shared Git metadata read-only and offer the checkpoint operation for saving.
Target ref publication remains Host-owned on both paths.

The Agent chooses and runs project checks in its original runtime environment.
It submits the checked version, successful command summaries and an honest note;
no configured Folder test/build commands are required. Evidence is explicitly
Agent-attested, not an independently repeated test result. No applicable checks
must be described honestly. The Host compares the captured tree with that
checked version and rejects unresolved changes before native fast-forward/CAS.
Target movement returns to the same Agent for another prepare/check cycle.
Ordinary output validation and materialization still run on the final response;
a file publication is its own authorized operation, not a deferred consequence
of that response. Legacy Task acceptance/verification remains unchanged.

`workspaceRunReply.ts` invokes the adapter exactly once and checks durable
integration facts before releasing its answer. It cannot create a repair Run,
change runtime profiles or reopen the CLI to produce a summary. Queued or
prepared work cannot be reported as merged; a result the Agent already received,
including a reported failure, does not override its answer. Git Jobs cannot invent another Agent
turn. Historical candidate records and explicit legacy controls remain readable
and recoverable; an authorized retry on a native Host uses the current session.
Cross-repository publication remains per repository rather than atomic.

Original checkout changes are never stashed, reset or committed automatically.
Dirty-baseline import freezes a bounded snapshot without modifying the user's
index; only the delta from that snapshot to the agent result may be published.
Publication into a checked-out target carries the person's uncommitted edits on
overlapping regular files onto the published content, file by file: a three-way
merge of the working file, and of a divergent staged version, between the
current target content and the published content, the way `git pull --autostash`
would without a stash. The pre-publication content of those files is retained
under `refs/rainver/local-preimages/` before anything is written. A file whose
merge is not clean, a binary file, a symlink, a mode change, a local deletion, a
differing both-added file or an unmerged index entry blocks publication for that
file alone; unrelated local work is never touched. No implicit .env or
credential copying is added. Agent shell access on strict Hosts must not mutate
shared target refs; checkpoint/integration ref writes are Host-owned.

Cleanup is independent from business success. A committed completion includes
a durable cleanup intent, per-resource manifest and generation fence. Workers
remove only their own idle trees, Git registrations, disposable refs and private
scratch resources. Cleanup failure remains visible and retryable after Host
reconnect. Periodic reconciliation compares journals, logical records and
physical resources; unknown ownership preserves evidence. Unpublished results
and unsafe-to-capture nested repositories must survive reclamation. Closing a
conversation never means permission to delete its unfinished work.

New complete/retry/abandon commands are registered by the workspace feature in
the existing Operation Core. Its transaction persists intent and Job only; Host,
model and verification work executes outside it. Existing Task lifecycle
operations adapt into the same owner. Operation replay identity, Run launch
attempt and integration generation are distinct. No new policy/approval/queue
or ACP execution channel is introduced. User messages within a conversation
and a vendor session stay ordered; independent workspace writers are compatible
subject to dependencies, Host capacity and existing quota/budget gates.

## Frozen integration contracts

- Workspace reference: opaque UUID, positive generation and Location identity.
  Scope and owner are loaded from server records and rechecked on replay.
- `workspace.change.complete`: change_set_id, expected_revision, summary and
  native action (`prepare`, `checkpoint`, `publish`, `reconcile`). Publish carries
  Agent verification for the exact saved version. Returns an admission receipt.
- `workspace.change.get`: change_set_id. Returns current revision, actual progress
  and the visible original conversation/Agent for an explicit user follow-up.
- `workspace.integration.retry`: integration_id and expected_revision.
  Only recoverable blocked work can create another attempt; already landed
  results cannot be undone by this command. A later writable Run in the same
  conversation workspace/session/Project may retry a visible historical batch
  on behalf of the instructing user. Full origin visibility, Project and Host
  authority, checkpoint safety and revision checks remain mandatory. Complete
  and abandon retain their original authority checks.
  Agent-only `repair_instruction` remains optional recovery guidance. Native
  retries do not dispatch a candidate Agent. Human `resolution` remains distinct
  from Agent guidance; historical candidate controls retain their old contract.
- `workspace.change.abandon`: change_set_id, expected_revision and reason.
  Withdraws unpublished intent, retaining results and cleanup evidence.
- Progress is projected through existing authorized Run/Conversation readers;
  run_output.v1 stores references under result, not new envelope fields.
- Host protocol advertises `execution_workspaces.version = 2`. A new reference
  without that capability is refused. Version 1 was the primitive-only offer;
  version 2 adds explicit baselines, ordered checkpoints, canonical mount scopes
  and isolated profile containers. The optional `native_workspace_integration: true` offer
  adds active-session Git operations without changing version-1 Run contracts. Legacy Task frames remain narrow adapters
  to the same mechanical implementation until their users have migrated.

Publication assesses the frozen batch's Runs, adopted child changes and current
repair Run. Valid requester-owned private context alone does not block authorized
code integration. Foreign private context, personal-memory grants and missing
provenance still require review; this does not clear Run taint or grant a generic
egress approval. Legacy/uncertain child adoption is conservatively included.
Retries preserve recorded base/source/target and publication provenance. A proven
already-adopted change closes without altering newer private work, including when
another batch of the same workspace publishes the same recorded delta. Otherwise
a historical batch is prepared into the worktree only while the bound batch has
no unsubmitted changes; those are never overwritten or mixed into the old batch.
Source worktrees persist between turns and their durable idle cleanup reclaims
physical files only after active Runs/checkpoints finish. Completed native Host
receipts are reclaimed with the source; incomplete journals/preimages remain
recoverable. A lost publish receipt is reconciled from the recorded candidate
and target ancestry without launching or publishing anything new.

## Delivery and review

Each of the six plan stages is reviewed, fixed, checked and committed on the
feature worktree. Full relevant package suites run before code-stage commits;
focused guide checks cover documentation-only stages. Schema is authored in
Drizzle and migrations are generated, never applied to a live instance here.
The completed plan is retired; its execution history remains in Git.
Final integration of dev is into the feature branch only. No push, deployment
or merge back into dev is authorized by this decision.


### Workspace publication recovery

An authorized complete may explicitly submit a single commit whose parent is
published target history, after proving its workspace batch has no other changes.
This does not grant native target-ref writes or import a private branch history.
The existing completion and integration owners freeze, verify and publish the
exact delta with the original Run/context authority. A target-content adoption
proof can settle an old integration without re-publishing it; unsuccessful proof
retains the old source. Reconciliation cannot waive verification for a new write.
Details and current controls live in the Project Files and Hosts module guides.


### Source retention (2026-11-08)

Physical-tree reclamation alone let finished worktrees, branches and recovery
refs accumulate. A source generation whose batches all closed as integrated or
no-change, with nothing running, owed, held or depended upon, is now reclaimed
immediately after the last using Run settles, including its managed branch, attributable
refs and receipts. The decision uses server merge facts and exact versions; the
Host re-proves the tip (target history, tree equal to a recorded merge commit
in target history, or its delta from a verified common base already applied to
the target) in one critical section under the Task lease, with CAS. Shared content-addressed
refs are released only without other dependents. Every later ref deletion is a
claimed, Host-journaled operation that only a reply naming it confirms (a
timeout keeps it pending and re-sends the same operation). A shared-ref
deletion records a durable per-(Host, commit, operation) intent in its claim
transaction under the same advisory lock a database trigger on every dependent
writer takes; until every such operation's proven end clears it, no new
dependent of the commit (one shared definition, native explicit commits
included) can take effect (Git may prune an old unreachable object at once, so
re-pinning after a deletion is never relied on). A deletion claimed before that
fence is never re-sent: one Host operation under the same Task lease first
keeps every commit with a dependent under an independent keeper ref no release
list can name, then settles it (finished, or cancelled for good), then restores
the shared name where no other deletion of it can still run and drops that
keeper; a keeper left for another unended operation is the resource's recorded
responsibility. A settle persisted by an earlier server (without that plan)
is never re-sent: a new operation settles its whole chain after the keepers.
A keeper write that fails while its object exists is retried, never read as a
lost source. A Host at that protocol deletes shared sources only for
fence-marked requests, and fsyncs (file, rename, directory) every ref-operation,
release and epoch record before acknowledging it. Incomplete
protection is never reported finished, and Hosts below the protocol a step needs
are paused, not exhausted. Run-history renewal is fenced on the Host by keeper
epochs; unattributable refs are kept and reported. A release request is
bound to a digest of its whole content, so only the same request replays. A materialization epoch raised before release, plus a server-held
launch-sequence floor, let the same conversation identity rebuild from the
target without a new generation or an older cleanup removing it. Unmerged,
blocked, kept-without-merging and private-baseline work is never released by
age, and Rainver never prunes objects or reflogs itself. Exact past-Run versions
survive a release only as owned, expiring run-history refs; after that period
the Run preview reports them expired rather than reading a different version,
and only when Git cleanly reports the version missing, never on a read fault. Details and controls are
in the Hosts and Project Files guides.


### Delegated workspace placement (2026-11-10)

Forking every delegation produced a workspace, batch, checkpoint and
"unmerged" record per review or follow-up, even for strictly serial work. The
owner authorized reuse for serial work while keeping the other constraints.
Placement is decided when a delegated child of a version-1 conversation binds
its primary Location (`projectFolders/delegatedWorkspacePlacement.ts`):

- **Serial writer → the coordinator's workspace.** The child joins the
  coordinator's conversation workspace (same conversation, Location, Project
  and Host; never another conversation's) and its current batch, only when the
  coordinator's binding is saved at the workspace head (or a saved serial
  child checkpoint advanced the same still-open batch), every other
  bound Run has settled with a saved checkpoint, no batch is publishing or
  blocked, the tree is not released/reclaiming/missing, and no other unfinished
  writing sibling of the same coordinator Run exists. Mutual exclusion is the
  Host's exclusive worktree lease (every writer of that worktree key, including
  later conversation turns) plus these server checks under the conversation
  workspace's advisory lock. The child keeps its own vendor session; it may
  save (Git commit or `checkpoint`) but `prepare`/`publish`/`reconcile`,
  retry, abandon and conversation recovery reach are refused for it: the
  coordinator alone publishes. Every Run that checkpoints or prepares into a
  batch is its contributor (its binding, or `contributor_run_ids` for a
  native operation; a parent also carries its `adopted_child_change_ids`).
  Every read model, change get/diff, publication and closure requires the
  origin *and* every contributor to be readable with an unwithheld body
  (`workspaceContributors.ts`), so a readable coordinator never exposes an
  unreadable child's commit identity, activity time or content; one
  unreadable contributor hides the batch. A stopped or failed child's leftovers are
  captured by the existing per-Run checkpoint as its own commit range, never
  silently discarded or published; a blocked checkpoint strands that generation
  exactly as for any other Run of it.
- **Read-only child → review at a frozen version.** On a personal Host that
  advertises `execution_workspaces.shared_review = 1` and verified read-only
  namespaces, a reviewer with no concurrent user of that worktree reads the
  coordinator's worktree at the coordinator's saved checkpoint
  (`ExecutionWorkspaceRef.review_commit`). The Host refuses unless the branch,
  HEAD and a clean tree equal that commit, holds the worktree lease shared (so
  readers run together and no writer, cleanup or release runs beside them) and
  never launches it outside the read-only namespace. No workspace, batch,
  binding or checkpoint is created. The first placement stores an immutable
  review reference (`execution_workspace_reviews`: workspace, generation,
  Location, `expected_commit`); every replay of that Run reuses it verbatim,
  so a retry after the coordinator moved is neither re-placed nor forked and
  the Host refuses the stale basis instead. Expected and observed stay apart:
  the review is `verified` only when the Host's read-only basis report (sent
  only for a review it verified and started) names exactly the expected
  commit; a Host refusal or another HEAD is `refused`, an unreadable HEAD
  stays `pending`. The Run's `review_basis` mirrors that state and its result
  says "Reviewed" only when verified. Instruction text never substitutes for
  these checks.
- **Everything else keeps an isolated fork** from the parent checkpoint:
  parallel writers, readers beside a writer of that same tree, attachments,
  strict or non-capable Hosts. Independent fork writers do not block a frozen
  shared review. Pending reviews also participate in writer placement before
  the Host acquires their shared lease. An unavailable/moved parent, pending or
  blocked checkpoint recovery, or unfinished publication explicitly blocks
  placement rather than allocating a fork around the fault. New fork admission
  also waits for any settled temporary child whose physical release is still
  owed, under the same conversation lock; no fixed room-size constant is used.

Unchanged: Project/Host/Location authority, parent-checkpoint and Host
fencing, retention and approval rules, per-repository publication and the
cleanup contract. Completed, proven-adopted forks with no dependents continue
through the existing retention sweep; unproven work is never released by age.

### Grouped Agent workspaces overview (2026-11-10)

The default overview aggregates on the server one entry per conversation ×
repository (`projectFolders/workspaceOverviewGroups.ts`): current state,
latest result and open problems. Delegations, batches, older generations and
reclaims are the folded execution history (`view=all&group=…`). Visibility
(Project read, owned Host, readable conversation, unwithheld Run body) is
applied before grouping, counting or paging; delegated children join their
coordinator's conversation group through their own visible Run, so neither
paging nor the coordinator's view hides them. A batch is visible only when
its origin and every contributing Run are readable (above). Saved work is
folded away only by an exact commit match with work that provably reached the
target (published from a root workspace, or a recorded target adoption proof)
or another unconfirmed batch at the same commit; otherwise it stays listed as
unconfirmed. A child adopted into its parent's batch is not such proof: the
parent's unpublished work at that commit stays listed until the target proof
exists. Diff sizes or missing states are never evidence of adoption. The
group's current workspace is the session's conversation workspace with the
highest generation; activity only orders groups and picks the latest result,
so a late update to an older generation never replaces it.

### Exact adoption and independent resource release (2026-11-12)

An adoption proof binds generation, base, source and the exact adopting version.
Later target edits do not invalidate historical adoption; deletion still requires
live Git evidence that the version is reachable from the actual publication
target, or a durable owner recovery ref. A merged database row only nominates
proof candidates. A rewrite that removes that evidence retains the source.
External manual merges use the same content/ancestry proof, never a person's
statement that the work was merged. Reconciliation may backfill exact evidence
on older integrated/adopted batches without changing an integrated outcome.

A saved parent checkpoint can adopt a child before final publication. Reclaim-6
Hosts re-prove the child's complete base/source delta under its worktree lease,
then durably CAS-pin the adopting checkpoint in the existing parent-owned
`refs/rainver/recovery/<parent>/<commit>` namespace before deleting the child
branch. Parent release remains blocked until the child release has settled;
the physical child branch is then unnecessary. The parent recovery ref has no
age expiry: its deletion independently re-proves adoption in live target history.
It cannot be released by the child, an older materialization or an unproven
parent publication. Older Hosts defer this release. Existing Operation Core,
Jobs, source-release fences, epochs, journals and authorization remain owners.
No extra cleanup engine, backup namespace or schema is introduced.

Branch/ref release and directory reclamation remain separate. Run end and
observed content changes set their clocks; status-only timestamps do not.
Physical-only idle cleanup safely snapshots consistent working/index contents as new
unpublished work and restarts the 24-hour content clock before removing files.
A newer dirty tree never inherits an older branch-release permission. Divergent
staging, nested repositories and unreadable snapshots stay in place; unique
ignored content is preserved in manifest quarantine, and ignored node_modules
are disposable dependencies. Unknown old
branches, including groups with equal tips, are audited rather than discarded.

Reuse / Dependency Check: extend existing cleanup Jobs, reconciliation, Git
snapshot/delta helpers and durable ref/journal primitives. Git is the installed
mature implementation; adoption authority is Rainver domain logic. No new package dependency, scheduler or storage mechanism is needed. Linux
mutual exclusion uses the installed util-linux `flock` kernel-lock utility.

Idle reclamation preserves ignored files in an owner-governed manifest quarantine with bounded admission and explicitly
declared rebuildable snapshots joining the existing 30-day retired sweep instead of treating build-output names as deletion authority.
Equal index/working snapshots may be captured; distinct staging remains blocked
with both versions intact. Capture acknowledgement replaces the cleanup request,
so its original replay receipt cannot renew the idle clock indefinitely.
Checkpoint pins use shared-target proof, exact publication evidence outside the
bounded recent history window, or an authorized discard with bounded Run-history
recovery. Unproven pins remain visible in exponentially backed-off ref-page Jobs (one hour to one week); reconciliation
re-enqueues missing Jobs. The nearest actual shared parent target is selected. Existing parent
pin facts require reclaim:6 even after a Host downgrade. See the Hosts guide for
restoration and retry details.

Same-generation rematerialization restores its manifest after rebuilding Git;
collisions freeze both versions. A committed journal plus an empty matching
source permits idempotent deletion retry. Rollback shells are removed; only
active manifests count toward the 128-slot quota. Owner continuous declarations
bind exact Location-relative directory prefixes, with no-follow/credential checks;
only explicitly authorized paths enter the existing 30-day sweep, including
large roots moved without copying. Mixed roots retain unknown siblings. Linux
service, foreground daemon and owner mutations share a kernel flock; systemd
status is not a lock. Cross-generation deduplication remains unimplemented.

### Immediate post-publication reclamation (2026-11-12)

Closed, proven merged/no-change sources have no automatic grace period. Completion
enqueues cleanup immediately in its transaction; the final using Run must settle
and checkpoint first. Legacy grace configuration cannot postpone this release.
Explicit user holds, active dependencies, dirty/new sources, Host proof and epoch
fences still apply. Retained unpublished work keeps its separate idle rule;
recovery/history refs keep their declared retention. An offline Host or failed
cleanup remains visibly pending and retries; enqueueing alone is not reclamation.


### Amendment (2026-11-13): bounded reclamation and post-release admission

Reclamation retains one permanent owner epoch and full release-request digest,
not one permanent tombstone per terminal physical operation. A cleanup whose
older epoch (or absent epoch after release) cannot authorize the current tree is
refused before effects; expired responses are not completion evidence. A renewed
operation must recheck the exact current source and all existing permission,
activity and tip guards. Unknown-owner legacy journals require visible owner
review or an exact attributable replay; age grants no deletion authority.

Source admissions use explicit epochs. All integration candidate mutations and
resolution launches use the epoch persisted when that attempt was created; the
Host records the candidate's immutable admission before mutation. Resolution opens its existing conflict tree;
it cannot recreate an old candidate through a new source's epoch. Quota proof
serializes all manifest state changes under the existing FIFO lease, with finite
inspection bounds and visible blocks rather than stamp tolerance or endless
pending rounds. Bounded sweeps persist progress and promptly continue; scheduling
cursors are disposable and carry no authority. Git reachability, CAS, source
fences, leases, read-only enforcement and unknown-asset preservation are unchanged.


### Amendment (2026-11-13): fair progress and separate candidate ownership

A source-fence refusal does not supersede an extant integration candidate.
Candidate cleanup may renew its operation at the current source epoch only after
locked settlement/dependency checks; the candidate's own later admission alone
supersedes its old cleanup. Terminal physical journals expire only below a
strictly greater permanent owner fence, never at an equal epoch.

Proof probes choose at most four globally oldest/null-first waiting owners per
round, independently of the 50-owner reconciliation id cursor and the five-minute
rate floor. Slow rounds therefore still reach the tail. Sweep phase and Location
frontiers persist progress before slow work; global receipt directories are shared
scans rather than rescanned for every owner.

Fully retired ignored snapshots have a separate suffix and compatible migration,
list/restore/expiry. Active quota remains 128; malformed manifests each consume a
slot with visible governance. Refusal receipts converge only on exact resolved
owner facts with no new source, never on age. Unknown legacy evidence stays.


Successful candidate disposal now atomically records its own E+1 fence and exact
cleanup result, retaining immutable admission. This never advances the source;
old prepares cannot rebuild the candidate and exact cleanup replay still confirms
completion after journal expiry. A missing legacy attempt epoch may reuse only
that candidate's durable Host admission, never the current source epoch. Legacy
cleanup owner recovery follows at most 64 previous-detail links, backfills the
exact merge owner after settlement/dependency checks, and visibly blocks unknown
owners instead of retrying forever. No new dependency or storage authority.

### Exact native child receipts and empty inherited work (2026-11-13)

The native publisher records the parent identity/generation before its Host
request and writes exact child adoption in its publication transaction through
`hosts/workspaceNativeAdoption.ts`. The receipt binds child generation,
base/source, integration/attempt, target and landing to a parent-owned checkpoint.
Historical reconciliation calls this same writer before external/manual proof.
A legacy receipt without the frozen parent identity needs the actual matching
parent head; a changed generation cannot acquire its predecessor's proof.
Cleanup still re-proves live Git and durably pins that checkpoint before deleting
any child resource. Database completion is never physical deletion evidence.

A child whose source equals its base can nominate a saved parent version only
when that exact inherited baseline is its ancestor. The existing reclaim:6 Host
checkpoint proof/pin then preserves private baseline bytes before release.
Empty delta alone, a missing branch, or a no-change label grants no deletion.
Parent baseline candidates remain subject to the unchanged common-history and
whole-delta Host guards. Recovery pins retain the existing owner and governance.

### Publication landing and release lifecycle

New native and controlled integration landings persist `detail_json.lifecycle`
in the publication transaction. Its `operation_id` is the existing integration
identity; it freezes workspace generation, base/source, target, landing and the
source cleanup key. Cleanup resources carry `owner_integration_id`; their Host
operation/journal identities remain distinct replay keys. This extends Operation
Core admission and existing Jobs/lease/journal execution, not a second executor.

`merged` / `no_changes` remain publication facts for existing clients. They do
not mean a delegated source has been released. The additional lifecycle phases
are `awaiting_release`, `cleanup`, `blocked`, and `complete`. Cleanup persistence
refreshes this record without submitting another publication. `workspace.change.get`
and Run/conversation workspace APIs return the typed lifecycle; conversation
pending work includes incomplete lifecycle records. The shared web list displays
and polls it instead of using a legacy cleanup label as overall completion.
An active publisher returns its publication receipt without waiting on its cwd.

For a lifecycle-managed current primary conversation generation, source cleanup
keeps the working directory and branch. Older generations and explicit reviewed
discard still follow existing guards. Reconciliation backfills legacy landings only from matching settled integration
and batch generation/base/source facts with a recorded landed commit. Uncertain
rows retain their existing semantics; no merge is submitted by backfill. Delayed history/preimage expiry remains
independent of physical release.

After a settled delegated writer has saved its checkpoint, cleanup is queued even
when its work is unmerged, cancelled or failed. Physical-only cleanup of these
temporary trees no longer waits 24 hours; its branch, unique saved work and ignored
content remain under existing preservation and quarantine rules. A captured new
version is acknowledged before the next cleanup attempt. This is not a claim that
retained bytes, branches or quarantine storage have all been released.

Reuse / Dependency Check: reuse existing integration JSON, Job queue, cleanup
resources, Host journal/lease and exact adoption proof. No new scheduler, queue,
external dependency or schema column is needed for these state additions.

### Bounded temporary slots and failed-source preservation

`delegatedWorkspaceSlots.ts` runs under the existing parent admission lock. The
declared collaboration participants bound temporary slots: the coordinator
occupies the permanent primary, and each other declared participant contributes
one temporary slot. A larger Room roster cannot widen a fixed collaboration.
Without a collaboration, the active Room roster bounds the total including the
primary (one temporary slot only when no roster exists). Running coordinators, started children, pending Runs
and delegation history never enlarge that bound. Capacity
waits use existing deferred Jobs. A released idle slot is preferred over a new
identity, with a fresh batch, monotonically fenced epoch/launch floor and the
new exact parent checkpoint. Original delegation provenance and old bindings
remain immutable. Reuse is scoped to the same parent conversation, repository,
Host, Project and collaboration Task (or the originating group for ad-hoc work).
An unsettled checkpoint/recovery, live lease, unconfirmed cleanup/ref operation,
hold or unknown asset blocks reuse. Pending/exhausted primary recovery does not
allocate another generation around the failure.

A Host advertising `execution_workspaces.preserve_source=1` can preserve a failed
or cancelled temporary source without adopting it: after checkpoint and dirty/
index/ignored-content guards, the existing cleanup critical section durably pins
its exact tip at `refs/rainver/recovery/<workspace>/<commit>` before branch CAS
and physical deletion. This pin has no age expiry; it is governed by the existing
recovery-ref proof/release path. Recovery commit/ref are visible in retention and
in the old batch's verification metadata. An open saved old batch becomes blocked
recovery when the slot is reused, never integrated/abandoned. Its exact source and
assets survive, while the next batch starts from its new parent checkpoint.
Unknown ignored assets remain in the existing manifest store, not an endlessly
renamed worktree. This does not claim those preserved bytes were freed.
Older Hosts block explicitly until capability upgrade; the existing reconciler
reoffers that responsibility after upgrade. No deployment is implicit.

Hosts advertise `execution_workspaces.lifecycle=1` for linked cleanup. A new
linked release blocks before Host effects on an older capability; reconciliation
reoffers it after upgrade. Cleanup carries its landed integration identity through the Host request,
full-request digest, durable journal and acknowledgement. RPC replay identity is
separate. Old in-flight requests retain their payload; they are not relabelled.
Native preparation/publication receipts use the same durable-file primitive.
A temporary lifecycle completes only with branch/tree/registration absence and
confirmed cleanup, and a later slot use cannot reopen that completed release.

Reuse / Dependency Check: extend existing Operation Core, deferred Jobs, Git,
Host leases, source fences, epochs, durable refs/journals and manifest recovery.
No dependency, schema column, scheduler or execution engine is added.


### Reused-slot publication and reconciliation fences

Each reuse assigns a new `slot_use_id` in the existing retention JSON and freezes
it into the new batch, integration lifecycle and source cleanup resource. The
workspace id, generation and branch remain stable; epoch and launch sequence
continue increasing. Adoption nominations and cleanup-owner lookup require the
current use identity, including equal-tip/no-change rounds. Late source replies
need both the resource operation and use identity before updating inventory or
cleanup state. Completed historical lifecycles remain complete.

Successful preservation keeps the failed batch and exact recovery ref as history,
not as a live block on every later use. Reuse clears only the prior use's
retention/release/proof state; holds, cleanup manifests, immutable bindings and
recovery evidence remain governed by their existing owners. A genuine safety
block still refuses admission. Pending child release defers the existing Job
for 30 seconds, without spending a failure attempt; admission stops with a
visible timeout after 30 minutes spent waiting for the current slot release.
The durable `runs.output_json.waiting_for_workspace_release` records the exact
workspace/use identities and initial wait instant. Admission commits that wait
before propagating its deferred Job; status-only updates and retries cannot renew
it. Capacity queue age is separate. A future explicit hold defers to its deadline
and pauses this fault clock; releasing the hold resets its start to that explicit
release and makes the original Agent Job immediately due. This also covers a
claimed handler returning its old hold deadline: queue deferral preserves a
schedule moved after claim, and the Operation wakes workers after commit. Genuine safety
blocks still refuse admission. The hold adds no failure attempt. Capacity waits also use a
30-second interval. No additional scheduler or cleanup engine is introduced.

Reconciliation derives a temporary owner's closure from its bindings, not its
first delegation. After Host inspection, inventory changes, retirement and
thread closure share a row-locked recheck of active bindings/reviews, revision
and epoch with admission. Stale inspection failures cannot mark a newer use
blocked. Host I/O stays outside the row-lock transaction.

Controlled publication freezes the exact parent before Host effects and records
its parent checkpoint receipt through the existing adoption writer, including
no-change results. It records lifecycle before enqueueing source cleanup and
passes the integration owner explicitly. A source waits for linked candidate
cleanup; final ref-page confirmation refreshes lifecycle after retention facts
are persisted. Publication remains distinct from overall resource completion.

`delegatedWorkspacePlacementDb.test.ts` exercises five real-PG/Host-Git rounds:
controlled and native operation entry points, cancellation/failure preservation,
two equal-commit empty rounds, launched Node fixture processes holding Host
leases beside a running coordinator, repeated over-capacity admissions, paused
inspection/rebinding, lost publication/cleanup replies and stale cleanup epochs.
The native command fixtures are deterministic local processes, not vendor
inference or live-account acceptance. Unknown real assets are never touched.

### Release wait, reuse settlement and checkpoint attention

Before replacing a released slot's use identity, admission refreshes and verifies
its old lifecycle under the workspace row lock, using confirmed branch/worktree/
registration absence and settled cleanup resources (including no inflight ref
operation). Exact preserved-tip evidence may satisfy release while unique bytes
remain recoverable. An unresolved old lifecycle refuses reuse rather than being
silently orphaned. New-use retention reset cannot complete the new integration;
old cleanup operation/use/epoch fences remain required for late replies.

Reconciliation checks permanent checkpoint failures under the same revision,
state, epoch and live-binding fence used after Host I/O. A terminal blocked
checkpoint writes the path-free `workspace_checkpoint_blocked` attention reason;
active bindings and normal pending checkpoints do not acquire that diagnostic.
Saved checkpoint evidence clears only that diagnostic and refreshes the cleanup
summary. Cleanup retries and unrelated resource completion preserve this attention
until that evidence exists. The existing API cleanup-errors list exposes it through shared controls.
An old scan cannot update inventory, retire an owner or close a newly live thread.

Reuse / Dependency Check: extend existing deferred Jobs, Run wait JSON, row locks,
lifecycle refresh and cleanup evidence. PostgreSQL owns the persistent clock;
Git and existing Host leases/journals own physical proof. No new dependency,
schema column, scheduler, cleanup engine or UI control is introduced.

### Queued workspace admission correction (2026-11-13)

Slot admission must finish before Run/attempt/delegation running transitions.
A deferred Job never rolls back an already-started Run. The existing execution
lock spans admission and dispatch; replay revalidates authority and uses the
frozen binding. Cancellation during queued admission settles without a process.
Native integration repair retains its distinct owner and entry point.

All hold clearing/shortening operations wake only current workspace/use waiters
through scoped indexed Run lookup. A durable marker on claimed Jobs preserves
that wake against stale deferral without cross-clock comparisons. Ordinary
noncollaborative scopes retain a minimum slot; declared collaboration bounds
remain fixed. Another Task's blocked resource at the shared bound produces a
specific visible refusal, never unlimited allocation or indefinite capacity wait.
Checkpoint attention retains its own first timestamp and cannot erase unrelated
reconciliation evidence when the checkpoint is saved.

Reuse / Dependency Check: fixes the existing Run admission, Job deferral,
workspace canonicalizer and reconciliation fence. Shared deterministic Gateway
and ACP Host fixtures surround real PostgreSQL worker/attempt/lock state. No
new queue, scheduler, dependency or schema is needed.
