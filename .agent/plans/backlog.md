# Backlog

Date: 2026-08-13
Status: real work with no trigger condition. Merged from the retired
`hardening-blind-spot-remediation-plan.md`, `product-capability-followups-plan.md`,
and `protocol-client-contract-drift-plan.md` after a full audit against the code
on 2026-08-13.

## How to use this file

Every item here is a genuine gap that someone will eventually close; none of
them is waiting on a trigger. Anything that *is* waiting on a trigger belongs in
[../tasks/deferred-register.md](../tasks/deferred-register.md) instead. Nothing
here is scheduled: [../tasks/current-focus.md](../tasks/current-focus.md)
declares no active sequence, so items are pulled on demand.

Implementation truth remains the code. Current-state architecture belongs under
`.agent/architecture/`; this file is forward-looking only. Remove an item once
its behavior is implemented and recorded in a current-state architecture
document — do not leave a closed section behind as history. That belongs to git.

## 1. Verification Engine

### A2.1 — Manual and model-based verification

`evaluate()` returns `skipped` with `implementation_status: "deferred"` for both
declared types, so a Workflow can declare them and receive nothing.

- [ ] Implement the declared `manual_review` verifier lifecycle, including
  durable pending/approved/rejected state and its effect on completion.
- [ ] Implement `model_judge` with a separately selected verifier model, never
  silently reusing the generator model.
- [ ] Add policy, audit, retry, and API read-model coverage.

Constraint: deterministic Verification Engine results remain the completion
authority; model or human judgment must be an explicit verifier result.

Scheduling rule: must be completed before any Workflow declaring one of these
verifier types as required completion evidence is enabled.

## 2. Workflow / Automation Lifecycle

### B4.1 — Complete Save Run as Workflow lifecycle

Current code provides the Run-detail UI, sanitized preview/extraction, low-risk
draft creation, and a high-risk `workflow_save` Proposal whose acceptance creates
a draft `workflow_template` asset version. Real-PostgreSQL coverage
(`server/test/runWorkflowServiceDb.test.ts`) stops at that draft boundary.

- [ ] Connect the created draft visibly into the existing proposal/promotion
  lifecycle so the user can review and promote it without reconstructing which
  asset came from the source Run.
- [ ] Add end-to-end coverage from source Run through save Proposal (when
  required), draft, promotion/approval, approved version, and subsequent
  Workflow launch.

Constraints: extraction stays sanitized; credentials, host paths, transient Run
IDs, and unreviewed mutable runtime state must not become Workflow definition
content. Always-draft behavior and standard proposal/promotion gates remain in
force.

## 3. Evolution and Artifact Provenance

### D1.2 — Artifact user-edit tracking

The `artifacts` module records no revision or edit history at all. The
`edited_by_user` flags elsewhere (research evidence cards, note revisions) are
their own domains' state and do not cover generated artifacts.

- [ ] Record user edits to generated artifacts with actor, artifact version,
  source Run, and before/after provenance.
- [ ] Convert meaningful edit patterns into evolution evidence/signals without
  treating every edit as an automatic promotion or memory write.
- [ ] Add Project Folder, Artifact, privacy, and cross-space isolation tests.

Interim: Proposal reject/request-changes signals remain the user-correction
evidence — see
[../architecture/EVOLUTION_SIGNAL_SYSTEM.md](../architecture/EVOLUTION_SIGNAL_SYSTEM.md).

## 4. Project Surfaces

### G1.1 — Project-level entry point for the academic citation graph

Scope corrected 2026-08-13. The earlier claim that this graph is reachable only
by hand-assembling a URL is no longer true: `ProjectSourcesPage` builds a
Project-scoped graph link and already derives the lens from the Project's active
Source bindings' extraction profiles. What is still missing is narrower.

- [ ] Add a Project-scoped Graph destination under Explore, beside Inquiry and
  Sources, so the map is reachable from Project navigation rather than only from
  the Sources page.
- [ ] Confirm the lens degrades honestly for Projects with no academic entities,
  rather than rendering an empty canvas with no explanation.

Constraint: the graph stays read-only and the projection contract stays the
producer's; this is navigation and defaulting, not a graph feature. Distinct from
the Inquiry Area's Map view, which projects Thread-to-Thread structure.

### G1.2 — Two loose ends left by the Inquiry Step model

Both are unreachable today and neither blocks anything; they are recorded so the
next person to touch these paths does not rediscover them the hard way.

- [ ] `updateWork` consumes `next_focus_note` only when the request also names a
  `next_focus_kind`, so a note-only request succeeds and changes nothing. No
  caller sends one, and the change panel has no note field. If a standalone note
  edit is ever added, make that path real first rather than letting a user's note
  vanish silently.
- [ ] Nothing prevents two open background Steps of the same kind on one Thread.
  `completeBackgroundStep` closes the oldest rather than all of them, which is
  correct while a Thread pins at most one research Workflow. A genuine
  multi-Workflow Thread would need the Step id carried through the completion
  path so each operation closes the Step it actually produced.

Constraint: do not add a note edit or a second concurrent Workflow per Thread
without closing the matching item.

## 5. Runtime Conformance

### C3.1 — Conformance second wave

The probe runner implements four checks — file-scope obedience, subagent-attempt
detection, cancellation reliability, and structured-output compliance. The trust
and profiling wave below is entirely unimplemented, and
`runtime_conformance_results` is empty because no CLI runtime has ever been
installed on this instance.

- [ ] Add forbidden-tool detection.
- [ ] Add premature-completion detection.
- [ ] Add validation-compliance checks.
- [ ] Add artifact-production checks.
- [ ] Add timeout-behavior checks.
- [ ] Add cost/latency profiling.
- [ ] Feed the results into routing trust decisions without weakening the current
  fail-closed behavior.

Prerequisite: a CLI runtime must exist in the sandbox image before any probe —
existing or new — can produce an observation. See the instance reality section of
[../tasks/current-focus.md](../tasks/current-focus.md).

### G1.3 — Chat provider presets cover one vendor

Found 2026-08-14 during the runtime-boundary audit. `server/src/modules/providers/presets/`
holds five presets: four retrieval-side (OpenAI embeddings, Cohere, ZeroEntropy,
Ollama) and exactly one chat preset, MiniMax. Anthropic, OpenAI chat, OpenRouter
and DeepSeek have none, so adding one means typing a base URL and model names by
hand.

- [ ] Decide which chat vendors deserve a preset and add them, or state that
  presets are deliberately retrieval-only and stop implying otherwise in the
  add-provider form.

Constraint: a preset pre-fills configuration; it must not carry a credential,
and `api_key_required` stays a server-declared fact. The server-owned vendor
registry and its API are current-state authority; see
[provider-policy.md](../modules/provider-policy.md).

## 7. Harness And Scope Convergence

Three remaining specifications cover routing, capability shrink, and the
two-Scope user model. Each is a separate convergence with its own prerequisites;
pointers only here, detail there. Runtime-boundary and registry-lifecycle work
completed on 2026-08-14 and is recorded in current-state architecture.

None is currently active — see
[../tasks/current-focus.md](../tasks/current-focus.md). The completed managed
execution replatform is current-state architecture, not backlog work.

### H1 — Managed tool families cannot contribute to the system prompt

Found during Step 0's discovery review, 2026-08-13.

`managedApiAdapter.ts:128` overwrites `system_prompt` with the
InvocationDelivery's system content on every dispatch, and `baseExecute` refuses
to run without the delivery's `invocation_audit_refs`. Anything a tool loop
writes to `system_prompt` is therefore discarded before the provider call.

The concrete casualty was Agent room delegation. `delegationSystemPrompt()`
built guidance — when to delegate, that every room agent may delegate rather
than only the manager, that several `agent.delegate` calls may run in one turn,
that `agent.wait_for_results` is the alternative to guessing, and that the model
must not invent the delegated agent's answer — and none of it has ever reached a
model. Step 0 deleted the builder rather than leave code that looks live and is
not; recover it from Git when this is implemented.

Valid `target_agent_id` values are unaffected: they reach the model through the
tool schema's `enum`, not the prompt. What is missing is behavioural guidance,
of which "do not invent the delegated agent's answer" is the one with
correctness weight.

- [ ] Decide where a tool family contributes instructions, given that the
  delivery owns the system prompt. The Runtime Context render path is the
  candidate; the loop is not.
- [ ] Restore the delegation guidance through that seam.
- [ ] Cover it with a test that fails if the contribution is dropped before the
  provider call, rather than one that asserts the loop's own input.

Constraint: the delivery is immutable audit evidence. A contribution has to be
part of what the delivery renders, not a mutation applied after it.
- [ ] [runtime-routing-plan.md](runtime-routing-plan.md) — remove the
  `adapter_type`-name special cases from `executionShapeScore()`, unpin
  `RESEARCH_ADAPTER`, and (Stage B) let the router read funding mode and the
  subscription quota state the credential broker already caches. Two claims in
  its first version were wrong and are corrected in place: the router has no
  cost signal at all, and Stage B's trigger is a connected non-payg funding
  channel rather than an installed CLI.
- [ ] [scope-model-plan.md](scope-model-plan.md) — raise Domain to a first-class
  Scope beside Project and generalize the project-only content governance
  interface. Needs an ADR first.
- [ ] [capability-shrink-plan.md](capability-shrink-plan.md) — Item 1 amended
  ADR 0009 and the authority documents on 2026-08-14. Items 2–7 still collapse
  the implementation to `SkillPackage + SkillBinding + SkillPolicy`.

## Completion and retirement

Remove an item once it is implemented and recorded in current-state
architecture, or once it is re-scoped elsewhere. Retire this file when no item
remains.
