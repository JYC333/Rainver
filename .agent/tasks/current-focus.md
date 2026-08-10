# Current Focus

The Runtime Context Engine clean cutover is complete. Current work is the
remaining acceptance-readiness corrections and controlled acceptance, followed
by unattended hardening and dogfooding.

The implemented boundary is described by
[Memory / Runtime Context](../architecture/MEMORY_CONTEXT_RUNTIME.md), the
[Runtime Context module guide](../modules/runtime-context.md), and
[ADR 0014](../decisions/0014-unified-runtime-context-engine.md). Code, schema,
and current-state architecture are implementation truth; Git history retains
the retired clean-cutover execution and review evidence.

The repository contains no recorded controlled-acceptance result for the
already-implemented, self-service Always-on capability (`autonomous_tick`; see
[modules/autonomy.md](../modules/autonomy.md) and
[modules/automations.md](../modules/automations.md)). Treat it as shipped ahead
of its recorded acceptance gate: it is included explicitly in the procedure
below and is not accepted for unattended production dogfooding until that
evidence exists.

## Active delivery sequence

### 1 — Close acceptance evidence and containment gaps

Before the acceptance run, close the remaining runtime gap that would otherwise
make its enabled surface dishonest:

- do not leave `codex_cli` enabled by default while its runtime-internal
  subagents and delegation remain uncontrollable. Either implement and test a
  working disable mechanism or make the adapter opt-in until one exists.

Also treat managed tool degradation as explicit uncertainty in Run evidence.
The existing retrieval/delegation summaries record that a tool was removed,
but the terminal result still needs a stable degraded/uncertain signal that a
consumer cannot mistake for a clean completion.

### 2 — Controlled product acceptance

Follow the durable [product acceptance procedure](../architecture/PRODUCT_ACCEPTANCE.md):

- rerun the deterministic gate at the acceptance commit;
- execute the ten-section local manual script and record product-visible
  evidence, covering the Room and CLI conversation surface;
- run one controlled real Managed API, Source, and OpenCode smoke with
  dedicated data and short-lived credentials;
- include bounded Always-on activation, one controlled tick/launch, and
  deactivation in the manual evidence so the open question above is resolved
  by an actual acceptance result rather than by inference;
- fix any observed correctness or recovery defect before proceeding.

### 3 — Unattended hardening

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
- Database-backed behavior uses the shared real-PostgreSQL fixture. That means
  the migrated template, never a hand-maintained SQL copy of the schema loaded
  into an empty database. Such a copy drifts silently and then cannot fail when
  code and production shape disagree, which is the only thing it exists to
  catch. The former Custom Source schema copy had lost five
  `project_source_bindings` columns before anyone noticed; its five consumers
  now use the migrated template with explicit per-suite seed data.
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

Do not pull a deferred item into the active sequence without its recorded
trigger or a newly observed correctness/security requirement.
