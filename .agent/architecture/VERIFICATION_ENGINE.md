# Verification Engine

Status: current implementation after A2 (2026-07-11). The engine is the
completion authority for deterministic checks declared by a Run contract or a
Project Folder validation plan. `RunEvaluation` remains the post-run classifier;
it must consume verification facts rather than infer completion from exit code.

## Ownership and lifecycle

The Runs module owns the engine and the `verification_results` table. A run's
orchestration path evaluates checks after adapter output, artifact/proposal
materialization, and code-patch collection, but before the worktree/ephemeral
sandbox is cleaned up:

```text
adapter → materialize outputs → collect code patch → verify → terminal write
                                                        ↓
                                              RunEvaluation / TaskEvaluation
```

Each result is keyed by `(run_id, attempt_number, verifier_type,
verifier_version)` and stores status (`passed`, `failed`, `skipped`, or
`error`), a bounded summary, safe evidence references, verifier details, and
timestamps. Re-running the same engine version within one attempt upserts that
attempt's result for idempotent execution; a Supervisor retry writes new rows
for the next attempt and never overwrites a prior attempt's results. Reads
(evaluation and the run detail API) return the current attempt's rows, so a
retry that failed before verification yields an incomplete set instead of
borrowing the previous attempt's evidence. Raw stdout/stderr, full patches,
credentials, and file contents are not persisted.

## Deterministic verifier catalog

The current engine supports:

- `command`, `test`, `lint`, `typecheck`: argv commands from an enabled
  `ValidationRecipe` or Project Folder Execution Config, sent through the typed
  Sandbox Runner `verification` launch and executed without a shell in the one
  managed workspace mount, with bounded timeout, empty-root namespace, private
  HOME, the Runner image's Node toolchain path, no network or ambient server
  environment, and a 64 KiB combined stdout/stderr ceiling;
- `file_exists`, `file_changed`, `diff_scope`, `no_forbidden_change`: safe
  sandbox and git-scope checks;
- `artifact_exists`, `artifact_schema`, `output_schema`: materialization and
  bounded JSON-schema checks;
- `proposal_created`: proposal materialization evidence.

Code-patch collection records structural validation metadata. The engine then
asks the same no-egress Runner to inspect git diff/status, then checks that a
collected patch changed files and did not touch Project Folder
Execution Config-forbidden paths. A patch proposal is never marked as validated merely
because git text collection succeeded.

`manual_review` and `model_judge` are declared verifier types with explicit
`skipped` results. They cannot make a run pass until their authorities land;
the future model judge must use a model distinct from the generator.

Workflow/Plan nodes may declare `verification_recipe_refs`. The run contract
propagates these references in route hints, the repository resolves enabled
recipes in the same space, and missing references become deterministic error
results. A recipe reference is therefore an executable verification input, not
just stored metadata.

Root and integration verification are implemented by the Plan graph layer.
Integration nodes verify completed dependency evaluations, while the root
records dependency closure, child evaluation, and cross-node output-shape
checks before it can become succeeded.

## Evaluation contract

For a successful runtime:

- any failed/error deterministic result produces `RunEvaluation.failed` in the
  `validation` layer;
- any skipped or missing declared result produces
  `RunEvaluation.unknown` / `insufficient_evidence`;
- only all-passed declared results, or a run with no declared checks, can
  produce `passed`.

TaskEvaluation bridges carry the verification summary in their checklist and
surface failed/incomplete results as known issues. Read-only routes are
`GET /api/v1/runs/:runId/verification` and its plural alias.
