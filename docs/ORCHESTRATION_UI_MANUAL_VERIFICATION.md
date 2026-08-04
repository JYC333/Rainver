# Orchestration and Evolution UI Manual Verification

This checklist verifies the current clickable UI paths. It uses the shared
operational space selected in the shell and never requires direct database edits.

## Task contract and Run recovery

1. Open `/tasks` and choose **New task**.
2. Fill title, risk, acceptance criteria JSON, Definition of Done, required
   outputs, max runs, max cost, duration, policy, metadata, and tags.
3. Create the task, open it, and confirm the Overview shows the saved contract.
4. Use **Edit contract**, change one structured field and one JSON field, save,
   and confirm the values survive refresh.
5. Create a queued Run and open its Run Detail.
6. For a Run in `waiting_for_review`, confirm **Resume** and **Abandon** are
   visible. Resume should requeue the Run; Abandon should request a reason and
   move the Run to terminal `cancelled`.

## Plan creation and execution

1. Open `/plans` and choose **New plan**.
2. Select an approved Workflow template, optionally select a version, enter a
   budget cap, and create the Plan.
3. If the Plan requires review, follow **Open proposals** or **Evolution Inbox**,
   approve the `plan_review`, then return to the Plan Detail.
4. Choose **Execute**, select an Agent, and confirm the root Run link appears.
5. Use **Reconcile** while the Plan is active and confirm the node statuses and
   root Run read model refresh.
6. Choose **Revise**, provide a new validated definition JSON, and confirm a new
   Plan version is created without mutating the previous version.

## Workflow Automation

1. Open `/automations` and choose **New automation**.
2. Select **Workflow**, choose a Workflow template and version, enter input JSON,
   and choose manual or scheduled execution.
3. Confirm scheduled Workflow automation forces `pin`; manual execution may use
   `follow`.
4. Create the Automation, use **Run now**, and confirm a queued Run is created.
5. Confirm Pause, Resume, and Archive remain available through the Automation card.

## Evaluation and Promotion

1. Open `/evolution` and select a Workflow or Prompt asset.
2. Choose **Create candidate version**, enter content JSON, then transition the
   draft to **Candidate** and **Testing**.
3. Choose **Create evaluation case** with an approved baseline, input JSON,
   baseline output (or a passed source Run), and a non-empty verification recipe.
4. Choose **Run evaluation**, select the candidate version, case, and an existing
   successful Run whose `workflow_version_id` matches the candidate.
5. Refresh Evaluation runs and inspect status, metrics, and blockers.
6. Choose **Promotion proposal**, select evidence and target scope, then follow
   the link to `/evolution/inbox` and approve through the normal Proposal flow.

The UI intentionally does not launch a candidate Run automatically from an
Evaluation Case. That remains D2.1. Workflow Canvas, runtime conformance
administration, and runtime-session checkpoint/fork semantics remain outside
this manual UI path.
