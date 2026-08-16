# Backlog

Date: 2026-08-13
Status: real work with no trigger condition. Merged from the retired
`hardening-blind-spot-remediation-plan.md`, `product-capability-followups-plan.md`,
and `protocol-client-contract-drift-plan.md` after a full audit against the code
on 2026-08-13.

## How to use this file

Every item here is a genuine gap that someone will eventually close; none of
them is waiting on a trigger. Anything that *is* waiting on a trigger, and every
standing enablement gate, belongs in
[../tasks/deferred-register.md](../tasks/deferred-register.md) instead. Nothing
here is scheduled; items are pulled on demand.

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
existing or new — can produce an observation. Check the running instance for
whether one is installed; see also the CLI gate in
[../tasks/deferred-register.md](../tasks/deferred-register.md).

### C3.2 — Routing cannot express a provider or model requirement

Found 2026-08-15 while retiring the routing plan. The router never reads
`model_provider_id` or `model_name` — they are carried on `RouteCandidate` and
referenced nowhere in `router.ts`. A caller that needs a specific provider has
exactly one way to get it: pin the profile as `explicit`, which hard-filters
every other candidate and takes the run out of routing entirely. Project
Research does this, and it is why its stage runs record a foregone route
decision.

- [ ] Decide whether a run may declare a provider/model requirement, and
  whether it is a hard filter or a scoring term.
- [ ] Wire both sides. A requirement dimension needs a producer *and* a
  populated candidate side; `required_tools` has the first without the second
  and therefore rejects every candidate when used. See
  [../architecture/ROUTING.md](../architecture/ROUTING.md).
- [ ] Decide whether `required_tools` should be repaired or removed while here.
  It is reachable today from four carriers — Task `policy_json`, workflow node
  `contract_json`, plan node `policy_json`, and automation `config_json` — and
  any of them rejects every system-created candidate. Removal has to close all
  four; repair means populating the candidate side.

Constraint: this must land before "Let Project Research stage runs route" in
[deferred-register.md](../tasks/deferred-register.md), or unpinning Project
Research silently discards the user's provider choice rather than letting the
router honour it.

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

### G1.4 — A managed run cannot produce an artifact

Found 2026-08-15 during the routing plan review. Both artifact materialisation
paths require a sandbox working directory: `produced_artifact_paths` and
`exchange_artifact_paths` are read from `sandbox_cwd` / `exchange_output_cwd`,
and `materializationService.ts:285` throws without one. `managedApiAdapter.ts`
contains no artifact reference at all — a managed run's entire output surface is
`output_text` and `output_json`.

The consequence is a real limit on what the managed path can produce: anything
durable needs a domain service and a domain table to receive it. Project
Research works this way, writing to `project_research_reports.content_json`. So
the set of things a managed agent can produce equals the set of things someone
has already written a table for; it cannot produce something whose shape was not
anticipated.

- [ ] Decide whether a managed run may declare an artifact (type plus content)
  directly, materialised without a sandbox cwd.
- [ ] If so, route it through the same provenance, policy, and visibility path
  as a sandbox-produced artifact, so the two do not become separate lifecycles.

Constraint: this is a materialisation question, not a sandbox one. Giving the
managed path a working directory is a separate and much larger decision, and
routing deliberately does not take it: a provider API has no file primitive, and
a server-side `file.write` tool is a worse version of what a CLI runtime does
natively while turning an ungated mutation surface loose in the one path that
currently has none.

### G1.5 — Every Project shows all fifteen Areas from birth

Found 2026-08-16. `ProjectAreaLayout.tsx` declares its navigation as a
hardcoded four-group, fifteen-item `as const`: Project (Overview, Notes, Rooms,
Raw material), Explore (Inquiry, Research, Sources, Digest, Files & Code,
Experiments), Decide & learn (Decisions, Learning, Knowledge review), Execute
(Delivery, Operations).

`primary_mode` is read in that file only to render the words "<mode> mode" — it
does not filter. There is no visibility or presence check anywhere in the
component. So a Project created to hold a few notes presents the same fifteen
destinations as one running experiments and deliveries, and most of them will
never hold data.

- [ ] Decide what governs an Area's visibility — `primary_mode`, data presence,
  explicit enablement, or a combination.
- [ ] Make the list contributed rather than literal. The back end is already
  contribution-based (`projects/attentionRegistry.ts` plus the per-module
  `projectIntegration.ts` files); only this component is not.

Constraint: an Area that has data must never become unreachable. Hiding is a
default, not a deletion — a Project whose Mode changes cannot lose access to
what it already produced.

## 7. Harness And Scope Convergence

Two remaining specifications cover capability shrink and the two-Scope user
model. Each is a separate convergence with its own prerequisites; pointers only
here, detail there. Runtime-boundary and registry-lifecycle work completed on
2026-08-14, and the routing specification was retired on 2026-08-15 — its
shipped behaviour is in
[../architecture/ROUTING.md](../architecture/ROUTING.md) and its untriggered
remainder in [../tasks/deferred-register.md](../tasks/deferred-register.md).

None is currently active. The completed managed execution replatform is
current-state architecture, not backlog work.

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
- [ ] Focus areas: classify from where content lives. The first slice shipped
  ([ADR 0015](../decisions/0015-focus-area-classification.md)) with
  classification available only from a focus area's own page, through pickers
  that list the first 100 notes and knowledge items. That does not scale and it
  is the wrong direction of travel: filing something should be possible from the
  note, the knowledge item or the Project itself. `focusAreasApi.setForObject`
  and `setForProject` already exist, so this is a front-end affordance rather
  than new API. The aggregation page also caps objects at 200 with no paging.
- [ ] [capability-shrink-plan.md](capability-shrink-plan.md) — the authority
  documents and the workflow template layer landed on 2026-08-14. The remaining
  items collapse the implementation to
  `SkillPackage + SkillBinding + SkillPolicy`.

## Completion and retirement

Remove an item once it is implemented and recorded in current-state
architecture, or once it is re-scoped elsewhere. Retire this file when no item
remains.
