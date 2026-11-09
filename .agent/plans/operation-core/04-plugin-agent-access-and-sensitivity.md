# Plan 4 — Plugin Agent Access and Data Sensitivity

Status: not started. Depends on [plan 2](02-plugin-operation-platform.md).

## Goal

Decide who can grant an Agent access to plugin operations and which data it may
reach, with sensitive personal data (diary, private finance accounts) protected
by default. Then migrate finance_ledger and diary onto the new contract.

Until this plan lands, sensitive plugin data stays invisible to Agents.

## Design

### Two independent axes

- **What it can do**: toolsets derived from the manifest, `plugin:<id>:read` and
  `plugin:<id>:write` (write does not imply read; no `plugin:<id>:*`).
- **Which data it can touch**: the data class of the rows involved.

A toolset is shorthand, expanded **when the grant is written** and pinned:
`{toolset, plugin_id, manifest_version, expanded:[{action_id, action_version}], granted_by, scope, expires_at}`.
`buildRunToolGrants` keeps doing exact-id intersection; nothing expands at Run time.

Effective grant = Run declaration ∩ scenario allowance ∩ data-side consent ∩
plugin enabled ∩ optional Agent narrowing.

### Data classes

Declared per entity in the manifest as a floor; rows can only raise it; the host
computes a result's class from returned `owner_user_id / visibility / data_class`.

| Class | Data-side consent from | Example |
|---|---|---|
| normal | Plugin enabled by Space admin | PhD application records |
| personal | Space admin turns on "Agents may read" | finance space accounts |
| sensitive | **Only the data owner** | diary; private finance accounts and every posting, balance or report touching them |

The Agent author can only narrow: `allowed_tools` is an optional deny list for
plugin toolsets, not the grant vehicle. `authorization.request` for plugin data
is approved by the data owner; sensitive grants default to this Run only,
reusing the `PersonalMemoryGrant` shape (bound to a Run, expiring, revocable).

### Defaults

| | normal | personal | sensitive |
|---|---|---|---|
| Default grant | read in conversational scenarios once enabled | off until admin enables | off; tool names not listed |
| write | ADR 0017 origin rules | always proposal | draft or proposal only; never rewrites human-written text |
| Multi-party Room | available | only data every member can read — not the speaker's authority | never granted |
| Autonomous Run | read | read, no write | never, except the owner's own scheduled task with explicit "allow background read" |
| Context push | allowed | admin opt-in | off; when enabled, owner's private conversation only |

### Rooms, delegation, taint, egress

- Decided at grant computation. When the audience includes anyone else,
  sensitive toolsets are absent from the snapshot, names included (the list
  itself would reveal use; see [ADR 0018](../../decisions/0018-room-as-visibility-boundary.md)).
- Delegated child Runs do not inherit sensitive grants.
- Tool results write back to Run taint (`context_taint_json.plugin_reads`) so the
  existing output-visibility and egress-review chain applies.
- Granting sensitive read requires the Run to have network `none` and no outward
  tools, or no untrusted content sources; otherwise refuse or fall back to
  per-call approval (lethal trifecta / Agents Rule of Two).
- New invariant beside `rawPrivateMemoryBlocksEgress`: taint with a sensitive
  plugin read refuses export/persist/outward operations or forces an
  owner-approved egress review.
- Memory written by a Run that read sensitive data carries at least that
  sensitivity, which lands it in the gated path of
  [ADR 0003](../../decisions/0003-memory-proposal-flow.md).
- Imported bank text and counterpart names are untrusted content.

### Re-consent on upgrade

Diff the pinned expansion on plugin upgrade: added tools, read→write,
side-effect raise, data-class raise or gate-class change stay inactive until
re-consent; the rest keeps working; removed tools shrink the grant. Only
normal-class, read-only, official-plugin additions auto-extend. Running Runs
keep their snapshot.

### Audit

A new Agent read record when `run_id` is present, even when the reader is the
owner (today `content_access_logs` forbids viewer = owner). Store
`(run_id, action_id, resource_type, resource_ids, data_class)`, never content.
The owner can see which Runs read which entries or accounts and revoke in one step.

## Work items

- [ ] `access` / `data_class` in operation declarations; toolset derivation and pinned expansion.
- [ ] Grant records, data-owner consent flow, per-Run sensitive grants.
- [ ] Scenario rules: Room audience, delegation, autonomous background-read opt-in.
- [ ] Room-wide readable-intersection reads for personal data (the separate
  retrieval path `scenarioToolAllowance.ts` already calls for).
- [ ] Taint write-back from tool results; egress invariant; memory sensitivity inheritance.
- [ ] Upgrade diff and re-consent surface.
- [ ] Agent read audit table and owner-facing view.
- [ ] Wire `include_in_context` and other descriptor settings that nothing reads today.
- [ ] Migrate finance_ledger to operations (23 routes, ~6.6k server lines);
  private accounts sensitive; close the known `validate` error-text leak.
- [ ] Migrate diary to operations; sensitive; Agent writes are append-only drafts.

## Documents to update

[SECURITY_AND_ACCESS_BOUNDARIES](../../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md),
[OFFICIAL_OPTIONAL_MODULES](../../architecture/OFFICIAL_OPTIONAL_MODULES.md),
[SYSTEM_ACTIONS](../../architecture/SYSTEM_ACTIONS.md).
