# Product Acceptance

This is the durable acceptance procedure for the Project product loop. Run it
in a dedicated local test space with disposable Projects, Sources, credentials,
and Project Folders. Record product-visible outcomes and durable records; do not
use implementation call order as acceptance evidence.

## Gates and evidence

Before manual acceptance:

```bash
./ops/scripts/product-acceptance-gate.sh
```

Record the commit, date, operator, browser, and whether the deterministic gate
passed. For every manual section record:

- the product route used to return to the object;
- the visible final state;
- the durable Project object, Run, Artifact, Proposal, Task, or operation;
- the Activity, Attention, Operations, or review link that exposes its audit
  trail;
- any recovery action exercised.

Do not copy internal UUIDs into normal product fields. Copyable identifiers in
collapsed technical details are diagnostic evidence only.

## Preconditions

- Start the local stack from `.agent/COMMANDS.md` and sign in as a member with
  Project write access. Use a separate acceptance space.
- Configure one real Source, one active Managed API Agent, and one OpenCode
  runtime profile. Keep real-provider credentials isolated through the normal
  credential UI.
- Prepare a disposable Git repository inside an allowed root for the Folder
  scenario. Never connect the product source repository itself.
- Use distinctive names prefixed `acceptance-<date>-` so all created data can be
  found and removed later.

## Manual product script

### 1. Create and prepare a Project

Create a Project with Name and an initial Brief containing Goal and Scope.
Confirm creation binds no Sources, creates no Workflow, installs no starter
content, and records no Project type (ADR 0019). Every installed Area must
remain reachable. In Project Sources,
bind the real Source and select its extraction profile explicitly; configure the
required Provider, Agent, and policy choices in their owning surfaces, then
explicitly start work.

Evidence: Project, initial Brief, explicit
Source binding plus extraction profile, and the started Workflow/Run only after
the explicit action. Visit every grouped Area; each route must remain reachable
and have content or an actionable empty state.

### 2. Run two scoped Inquiry/Research tracks

Create two Question/Hypothesis Threads. Select the first and start a Research
Workflow, then repeat for the second. Switch between them and confirm each
Workflow keeps its own question, strategy, progress, corpus, notes, and
checkpoints.

Evidence: two Threads, two independently addressable Research Workflows, their
Runs/operations, and links from the selected Thread and Research history.

### 3. Acquire and review evidence

Run the linked Source, backfill or acquire evidence, and review the bounded
Knowledge packet. Exercise view-all and at least accept, edit/merge or gap,
defer, reopen, and dismiss where applicable. Routine supporting evidence should
not create duplicate review noise.

Evidence: Source items, corpus membership, Signals/Candidates or review rows,
review decisions, Delta summary, and exact links from Attention/Review to the
source object.

### 4. Promote Knowledge and observe revalidation

Promote one reviewed item through its Proposal. Revise or reacquire its Source
and confirm the promoted Knowledge is not overwritten; a revalidation state or
review item should appear instead. Search and select Knowledge by name in
Learning and inspect version-pinned provenance through technical details only
when needed.

Evidence: immutable source revision, Proposal and decision, Knowledge version,
revalidation record, Learning selection, and audit links.

### 5. Run manual and managed Experiments

Create a manual Experiment, protocol Version, Run, Observation, and
Interpretation. Then run a managed Experiment using named Version, runtime,
Agent, and optional Folder selections. Confirm terminal canonical output and
Artifacts reconcile into the Experiment. Turn an Interpretation into a Signal
and verify the Hypothesis changes only after Candidate acceptance.

Evidence: Experiment/Versions/Runs, canonical Run I/O, Artifacts, Observation,
Interpretation, Candidate/Proposal, and accepted Iteration.

### 6. Decide and deliver

Create a standalone Decision with options and criteria. Link it contextually to
an Inquiry Thread, decide, write a commitment, and create a Delivery Task.
Assign the Task to yourself or a named Agent, start it, complete it, and reopen
it.

Evidence: Decision, bidirectional Inquiry relation, commitment, canonical Task,
status history, and exact Delivery/Attention deep links.

### 7. Operate and recover

Create or select a Project Automation and fire it. Inspect active, waiting,
failed/degraded, and completed Runs in Operations. Cause one recoverable alert
or use prepared test evidence; confirm the alert links to the exact Run or
Automation and that pause/resume or recovery actions update the owning object.
Then explicitly activate Always-on autonomous work for the acceptance Space,
run one controlled discovery tick that either launches one bounded candidate or
records why none was eligible, inspect its budget/policy/review evidence, and
deactivate it again. It must not remain enabled merely because the acceptance
operator navigated away.

Evidence: Automation, operation/alert, Run, retry/review/failure category,
recovery action, Always-on activation/tick/deactivation records, and
Operations/Attention links.

### 8. Exercise Files & Code governance

Create a managed Folder, clone the disposable repository, or connect it through
an allowed-root choice. Verify primary and execution-enabled state, tree,
content, Git status/diff, and Folder settings. Execute isolated code work,
review validation and a patch Proposal, then apply or reject it and exercise
rollback. Unregister a Folder and confirm disk content is not deleted.

Evidence: Project Folder, configuration, snapshots, code Run, bounded diff,
validation, Proposal decision, apply/rollback operation, and remaining disk
repository. No Exchange directory, credential path, or arbitrary host path may
appear as product state.

### 9. Room conversation and materialize

Open a project-bound Room without requiring a Folder. Use two human members:
each sends a message under their own CLI subscription binding. Address an
agent with `@`, observe the collaboration task and lifecycle progress, cite a
Project Source or Artifact, and produce a pending proposal through tool use or
the declared `conversation_capture` output.

Evidence: persistent Room and conversation, both human sender identities,
per-user backend bindings, task group and Run links, terminal agent messages,
visible Source/Artifact references, and a pending Proposal that still requires
normal review.

### 10. Archive and reactivate

Archive the Project and verify its history remains readable while execution,
Automation firing, and Files write actions are blocked with useful recovery
guidance. Reactivate it and confirm the same Project, Areas, Folders, and
history return without duplication.

Evidence: lifecycle transitions, archived banner, denied write attempts and
their audit records, then restored execution/files behavior.

## Real integration smoke

Run this only after the deterministic and manual gates. In the acceptance space,
prepare queued Runs whose names clearly identify these cases:

- a real Managed API success;
- a real OpenCode file/tool success or review wait;
- a structured-output validation failure;
- a long-enough Run to cancel;
- a transient adapter failure with a configured retry/fallback;
- optionally one explicitly configured Codex or Claude CLI Run.

Also prepare a real Source channel and enabled post-processing rule. Export only
their opaque identifiers into the current shell; do not write them to `.env` in
the repository:

```bash
export ACCEPTANCE_AUTH_TOKEN='<short-lived token>'
export ACCEPTANCE_SPACE_ID='<dedicated space>'
export ACCEPTANCE_MANAGED_RUN_ID='<queued run>'
export ACCEPTANCE_SOURCE_CHANNEL_ID='<real source>'
export ACCEPTANCE_SOURCE_RULE_ID='<enabled rule>'
export ACCEPTANCE_OPENCODE_RUN_ID='<queued run>'
export ACCEPTANCE_VALIDATION_FAILURE_RUN_ID='<queued run>'
export ACCEPTANCE_CANCELLATION_RUN_ID='<queued run>'
export ACCEPTANCE_FALLBACK_RUN_ID='<queued run>'
# Optional:
export ACCEPTANCE_VENDOR_CLI_RUN_ID='<queued run>'

./ops/scripts/product-acceptance-real-smoke.sh
```

The script intentionally fails when credentials or prepared records are
missing. It executes real external work, verifies canonical logical I/O,
validation evidence, cancellation, retry/fallback evidence, and routing
evidence, but it does not automatically delete audit data.
