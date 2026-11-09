# ADR 0029 — Isolated execution workspaces and verified integration

Date: 2026-11-06; native-session simplification: 2026-11-08
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
continuations reuse it. Independent delegated writers fork a frozen parent
checkpoint and integrate back into their parent before root publication.
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

A workspace failure belongs to that generation, not to the whole conversation.
A new authorized turn can allocate a fresh generation when the previous one is
blocked or has exhausted checkpoint recovery. An unsuccessful turn without a
launch receipt triggers this only if the generation has never launched and no
other bound Run remains unfinished. The previous identity, changes, refs and failure evidence remain
untouched; its unverified result is not imported, abandoned or published. A replay
of the old Run still uses its frozen binding and cannot revive a blocked owner.
Current Project/Host/Location authority and delegated parent-checkpoint checks
remain mandatory. An absent launch receipt alone is an operational recovery
failure, not evidence of a permission breach.

Native-session integration reuses Git and the existing Host publication helper.
The Agent keeps its native session, cwd, profile, dependencies, cancellation and
Run budget. `workspace.change.complete` admits prepare/checkpoint/publish intents
through Operation Core and a durable Job. Its afterCommit hook only kicks that
rebuildable intent. `workspace.change.get` reads the actual result and revision.
Checkpoint alone saves privately without publication intent, and settlement
preserves native commit identities/history. No Host I/O happens in the core transaction; no Agent loop is owned by Rainver.

Preparation applies the frozen baseline-to-source delta onto the target in the
same owned worktree. It preserves a preimage, dependency/build directories and
all source history. The Agent resolves conflicts and necessary related files
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
after a short configurable grace, including its managed branch, attributable
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
