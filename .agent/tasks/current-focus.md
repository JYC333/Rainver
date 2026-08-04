# Current Focus

CLI conversation and Room delivery is complete: Project Chat and the hardcoded
default-Assistant chat entry are gone, replaced by `/rooms` — see
[modules/rooms.md](../modules/rooms.md), [modules/agents.md](../modules/agents.md),
and ADRs 0002/0004/0007/0008 for the delivered state. The current work is
controlled acceptance execution before unattended hardening and dogfooding.

**Open question, not silently resolved (2026-07-26):** the Always-on
autonomous-work capability (`autonomous_tick`, see
[modules/autonomy.md](../modules/autonomy.md) and
[modules/automations.md](../modules/automations.md)) is fully implemented and
self-service activatable by any Space member, including bounded unattended
launch, and shipped without item 1 below being recorded as passed here. Either
controlled acceptance was satisfied elsewhere and this file simply never
recorded it, or autonomous-launch capability shipped ahead of its own stated
entry gate. Confirm which, and record the resolution here (or fold Always-on
explicitly into the acceptance script below) before treating it as safe for
unattended production dogfooding.

## Active delivery sequence

### 1 — Controlled product acceptance

Follow the durable [product acceptance procedure](../architecture/PRODUCT_ACCEPTANCE.md):

- rerun the deterministic gate at the acceptance commit;
- execute the ten-section local manual script and record product-visible
  evidence, covering the Room and CLI conversation surface;
- run one controlled real Managed API, Source, and OpenCode smoke with
  dedicated data and short-lived credentials;
- fix any observed correctness or recovery defect before proceeding.

### 2 — Unattended hardening

After controlled acceptance passes, trigger
[../plans/unattended-execution-hardening-plan.md](../plans/unattended-execution-hardening-plan.md)
for backoff/jitter, managed-domain retry ownership, egress, scheduler catch-up,
and unattended alert/recovery behavior.

The 30-day Agent Workbench dogfooding checkpoint in ADR 0010 begins only after
the unattended completion gate passes.

## Working rules

- Code and schema remain current-state truth while the plans describe target
  state.
- Update the relevant architecture document in the same change that lands a
  behavior.
- Do not introduce compatibility aliases or dual authorities.
- There is no historical data to preserve. Schema changes are edited to their
  final shape in `server/src/db/schema/` and folded into the canonical
  `server/migrations/0001_baseline.sql`; do not add incremental migration files
  or compatibility shims for superseded shapes.
- Internal UUIDs remain valid storage/transport identifiers; users never type
  them in normal product flows.
- Runtime/Provider tests use deterministic fakes in canonical suites. Real
  credentials belong only in explicit integration smoke.
- Database-backed behavior uses the shared real-PostgreSQL fixture.
- Implementation functions and tests use domain names, never `phase1`,
  `phase2`, `phaseX`, or similar migration-stage names.
- Do not store runtime data, user folders, sandboxes, secrets, databases, or
  logs in the source repository.

## Explicitly deferred

Usage-triggered Project/Inquiry defers live in the
[Project / Inquiry defer register](project-inquiry-defer-register.md).
Verification Engine, Workflow-lifecycle, and Artifact-provenance follow-ups
live in
[../plans/product-capability-followups-plan.md](../plans/product-capability-followups-plan.md).
General hardening/watch items live in
[../plans/hardening-blind-spot-remediation-plan.md](../plans/hardening-blind-spot-remediation-plan.md).
The Always-on autonomous-work chain is delivered; current-state behavior
lives in [modules/autonomy.md](../modules/autonomy.md) and
[modules/automations.md](../modules/automations.md), not in a plan.

Do not pull a deferred item into the active sequence without its recorded
trigger or a newly observed correctness/security requirement.

A3.1 (runtime sessions and checkpoint/resume) is delivered. CLI conversation
and Room turns resume a vendor runtime session per the measured behavior of
each runtime; see the "Runtime session" section of ADR 0007 and
[modules/rooms.md](../modules/rooms.md).
