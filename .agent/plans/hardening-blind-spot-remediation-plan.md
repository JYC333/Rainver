# Hardening Remaining-Work Plan

Date: 2026-07-24
Status: active small backlog and trigger register.
Audited 2026-08-08: every remaining claim checked against the code; completed
runtime-audit findings and obsolete Project/Note items removed, live runtime
gaps absorbed below, and temporary reports retired.

## Purpose

Track cross-cutting hardening that is neither owned by the active Project
cutover nor by the orchestration/evolution backlog. Completed history is
removed rather than kept as a changelog; implementation truth lives in current
architecture and code, and what a completed item did lives in git.

## Routed to active plans

These items are not duplicated here:

- Project/Folder/Profile/Area cleanup is complete; usage-triggered follow-ups
  live in the
  [Project / Inquiry defer register](../tasks/project-inquiry-defer-register.md);
- completed structured runtime I/O, runtime convergence, and governed CLI
  tools are documented in
  [Runs and Outputs](../architecture/RUNS_AND_OUTPUTS.md);
- completed UUID-selector and product-acceptance implementation is documented
  in [Product Acceptance](../architecture/PRODUCT_ACCEPTANCE.md);
- backoff, egress, scheduler catch-up, and unattended failure alerting →
  [unattended-execution-hardening-plan.md](unattended-execution-hardening-plan.md);
- the Always-on autonomous-work chain is delivered, including self-service
  activation; current-state behavior lives in
  [autonomy.md](../modules/autonomy.md) and
  [automations.md](../modules/automations.md). Its one open item — whether
  autonomous launch shipped ahead of the controlled-acceptance /
  unattended-hardening gates — is tracked in
  [current-focus.md](../tasks/current-focus.md), not here;
- unrelated Verification Engine, Workflow-lifecycle, and Artifact-provenance
  follow-ups, plus parked ideas →
  [product-capability-followups-plan.md](product-capability-followups-plan.md);
- protocol/client type duplication and the drift coverage the 2026-07-24 gate
  promised →
  [protocol-client-contract-drift-plan.md](protocol-client-contract-drift-plan.md).

## Acceptance blockers

### Runtime evidence and containment

These are current correctness/containment gaps and therefore also appear in
`tasks/current-focus.md` as acceptance-readiness work:

- [ ] **Provider fallback mismatch event.** Managed runtime and adapter evidence
  now preserve the routed Provider as `requested_model_provider_id` and the
  actual executing Provider/model as `model_provider_id` / `model`. Emit a
  stable Run event when those Provider ids differ so Operations and routing
  diagnostics do not have to infer the fallback from terminal metadata.
- [ ] **Codex internal-agent containment.** `codex_cli` is implemented and
  enabled by default while its `subagent_disable_mechanism` and
  `delegation_controllability` are both `unknown`. Either implement a tested
  runtime configuration that disables internal delegation or make Codex
  opt-in/default-off until one exists. Existing routing trust gates remain
  defense in depth, not a substitute for an honest default.
- [ ] **Explicit managed-tool degradation.** Retrieval/delegation tool fallback
  now records failed tool summaries, so it is no longer silent. Add a typed
  degraded/uncertain terminal signal and Run event so downstream evaluation
  cannot treat a no-tool fallback as a clean equivalent result.

## Scheduled but not blocking

### C3.1 — Conformance second wave

Moved 2026-07-26 from the now-retired orchestration-and-self-evolution-plan.md,
which no longer tracks anything: its Always-on chain was delivered and its
other items moved out to this file and product-capability-followups-plan.md.

- [ ] Add forbidden-tool detection.
- [ ] Add premature-completion detection.
- [ ] Add validation-compliance checks.
- [ ] Add artifact-production checks.
- [ ] Add timeout-behavior checks.
- [ ] Add cost/latency profiling.
- [ ] Feed the results into routing trust decisions without weakening the
  current fail-closed behavior.

Minimum structured event/output conformance and execution-shape routing are
implemented. This item retains the broader trust/profiling wave after
controlled smoke, following the same controlled-smoke needs as the active
acceptance work.

### Personal / team content boundary leftovers

[ADR 0013](../decisions/0013-personal-team-content-boundary.md) is implemented
and its plan is retired; current-state behavior lives in the ADR and in
[Security and Access Boundaries](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md).
Three items were deliberately left open and none blocks single- or two-person
use, because each needs a real second member before its shape is knowable.

- [ ] **Orphaned `private` rows after a member leaves a Space.** Their owner can
  no longer read them and no one else ever could, so they are unreachable but
  still counted, indexed, and backed up. Deleting them destroys content the
  person may return for; reassigning them hands their private material to
  someone else. Trigger: a member actually leaves a real shared Space.
- [ ] **Explicit consent to `oversight_mode` when joining an existing Space.**
  The mode is immutable and visible to members, but nothing makes a joiner
  acknowledge it before their content lands under it. Trigger: someone joins a
  Space they did not create.
- [ ] **Detail-read auditing beyond the four wired types.**
  `recordDetailRead` covers Task, Activity, Artifact, and note/`space_object`;
  Run, Proposal, Agent, Reader annotation, and the Source types still record
  nothing on a detail read, so a demotion disclosure for those reports no
  readers even when there were some. Mechanical to extend, but each addition is
  a write on a read path, so extend on evidence rather than pre-emptively.
  Trigger: a demotion disclosure for one of those types is actually consulted.

### Retention and pruning design

Append-only Run/Event/Evolution/usage data and Artifact storage need explicit
retention semantics. Trigger when the database reaches a few GB, backups exceed
15 minutes, or real Run logs make growth materially visible.

The design must preserve audit obligations, Proposal/Artifact provenance, and
per-type policy; it cannot be a generic age-based delete job.

### Operations runbook consolidation

After unattended hardening, consolidate one operator page covering:

- service placement and health;
- backup/restore and host-loss recovery;
- runtime-tool and credential recovery;
- retry/alert/scheduler diagnosis;
- safe stop and escalation boundaries.

## Watch items

| Item | Trigger |
|---|---|
| Broader browser E2E suite | Second real user, or a frontend regression that loses/corrupts data |
| TLS/rate limiting/CSRF hardening | Any move toward public internet exposure, currently forbidden |
| Multi-user sharing regression expansion | Second member joins a real shared Space |
| Private content carried into shared digests | Second member joins a real shared Space. Only `highly_restricted` is excluded from digests and maintenance outputs; ordinary `private` source content can reach a digest that its owner later shares by hand. Owned by the digest/context mechanism, not by any single digest producer (see [autonomy.md](../modules/autonomy.md)) |
| Offline queue | Real mobile/offline usage; until then docs must not claim unsupported behavior |
| Large-file/module splits | Next substantive edit to the affected oversized file |
| Master-key rotation | Suspected exposure or a future multi-instance requirement |
| Commercialization posture | A real external-user/product decision |

## Completion/retirement

Remove an item when its behavior is implemented and recorded in current-state
architecture. Retire this file when no scheduled or watch-triggered hardening
remains.
