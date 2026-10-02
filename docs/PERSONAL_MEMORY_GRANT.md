# PersonalMemoryGrant

## Purpose

PersonalMemoryGrant is an explicit, narrow, auditable mechanism that allows a user to
authorize a single shared-space run to use a summary of selected personal-space private
memories as reasoning-only context.

The safe default is unchanged: a shared-space run cannot read personal-space private
memory without an explicit grant. PersonalMemoryGrant is the only exception path and
provides no shared persistence of the personal memory content.

```
No grant → no cross-space personal memory read.
```

---

## Data Model

### `personal_memory_grants`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `granting_user_id` | UUID FK users | Server-assigned from authenticated user; not client-writable |
| `personal_space_id` | UUID FK spaces | Server-assigned from granting user's personal space |
| `target_space_id` | UUID FK spaces | The shared space where the target run executes |
| `target_run_id` | UUID FK runs | Required in MVP; run-scoped grants only |
| `target_agent_id` | UUID FK agents | Always NULL; there are no agent-level grants |
| `grant_scope` | TEXT | `run` only in current MVP |
| `access_mode` | TEXT | `summary_only` only in current MVP |
| `memory_filter_json` | JSON | Optional filter: `memory_layers`, `memory_types`, `namespaces`, `max_items` (1–50) |
| `status` | TEXT | `active \| consuming \| used \| revoked \| expired \| failed` |
| `read_expires_at` | TIMESTAMP | Required; grant is invalid after this time |
| `egress_review_expires_at` | TIMESTAMP | Optional deadline for egress review/apply |
| `consume_started_at` | TIMESTAMP | Set when Delivery authorization claims the grant |
| `used_at` | TIMESTAMP | Set when grant transitions to `used` |
| `revoked_at` | TIMESTAMP | Set on explicit user revoke |
| `failed_at` | TIMESTAMP | Reserved; no code path writes it today |
| `failure_stage` | TEXT | Reserved; no code path writes it today |
| `created_at` | TIMESTAMP | Creation time |
| `updated_at` | TIMESTAMP | Last status change |

**Uniqueness:** at most one `active` or `consuming` grant per `(target_run_id, granting_user_id)`.

### `personal_memory_grant_events`

Audit log for all grant lifecycle transitions. Contains `grant_id`, `event_type`,
`actor_user_id`, `run_id`, `proposal_id`, `source_space_id`, `target_space_id`,
`metadata_json` (safe metadata only, no personal memory content), `created_at`.

### `proposal_approvals`

First-class approval rows required before any egress-review proposal may be applied.
Stores `proposal_id`, `approval_type` (`egress_granting_user` or `action_grant`),
`approver_user_id`, `grant_id`, `action_grant_id`, `target_space_id`, `status`
(`approved \| revoked`), `revoked_at`, approval metadata. No raw memory content,
summaries, or memory IDs.

---

## Grant Lifecycle

```
active → (Delivery authorization) → consuming → used   [normal path]
active → (explicit user revoke)    → revoked             [user cancels]
```

The claim happens inside the Invocation Delivery authorization transaction
(`runtimeContext/gateway.ts`): the grant row is locked with `SELECT … FOR UPDATE`,
checked against the Run, viewer, and planned summary, and moved
`active → consuming → used` in the same transaction. If no usable row is found,
Delivery is refused. Expiry is not a written transition: a grant past
`read_expires_at` simply stops matching. The `expired` and `failed` status values
are allowed by the schema but no code path writes them today.

---

## API Endpoints

All endpoints are under `/api/v1/personal-memory-grants`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/preview` | Structural eligibility preview without creating a grant |
| `POST` | `/` | Create a grant for a specific run |
| `GET` | `/` | List grants for the authenticated user |
| `POST` | `/{grant_id}/revoke` | Revoke an active or consuming grant |
| `GET` | `/{grant_id}/audit` | Retrieve safe audit events for a grant |

**Server-assigned fields:** `granting_user_id` and `personal_space_id` are derived
server-side from the authenticated session. They are not client-writable
(`extra=forbid` on the request schema).

**Authorization checks at create:**
- Authenticated user must own the personal space.
- Authenticated user must be a member of `target_space_id`.
- `target_run_id` must be in `target_space_id`.
- `granting_user_id` must equal `run.instructed_by_user_id`.
- At most one `active` or `consuming` grant per `(target_run_id, granting_user_id)`
  (partial unique index); `read_expires_in_seconds` is clamped to 60–86400.

---

## Runtime Behavior

When Runtime Context acquisition detects a valid grant for the current Run:

1. Atomically claims the grant (`active → consuming`).
2. Reads allowed personal memories from `personal_space_id` using the grant's filter.
3. Generates a `summary_only` digest — no raw memory text is retained.
4. Constructs an ephemeral aggregate-only reference-data item for Delivery.
5. Transitions the grant `consuming → used`.
6. Adds the grant ID and private granting-user attribution to the Run's general
   `has_context_taint` / `context_taint_json` summary. The summary contains safe
   metadata only (grant IDs, input owners, and narrowest visibility — no memory
   text, memory IDs, or generated summary).

The aggregate-only grant item is rendered into the accepted Delivery **in memory
only**. It is not written to:
- `Run.prompt`
- `AgentVersion.system_prompt`
- a vendor instruction file or canonical Memory row

The safe Invocation Snapshot source refs may contain only safe
grant metadata (`grant_id`, space ids, access mode, memory count, safety booleans).
They never contain raw memory, memory IDs, or generated summary text.

Run materialization narrows grant-derived durable outputs using the same context-taint
rule as same-Space private inputs. Publishing a tainted Artifact beyond the default
audience uses an `egress_review` proposal and the existing granting-user approval row.

---

## Egress Review Status

Current implementation:

- `Run.has_context_taint` and `Run.context_taint_json` store safe grant and source-owner
  attribution for audit, policy context, and output narrowing.
- `proposal_approvals` supports explicit `egress_granting_user` approval rows.
- A grant-derived egress approval may be recorded only by the grant's
  `granting_user_id`; a context-taint publication approval only by a required
  taint owner.
- Approval rejects payloads marked `raw_private_memory_included = true`.
- Tainted Artifact publication revalidates the target taint at apply time and requires
  every contributing owner named by that summary.

- A request to publish tainted content (`contentAccess/service.ts`) creates a pending
  `egress_review` proposal naming the required taint owners.
- The registered `egress_review` applier (`proposals/egressReviewApplier.ts`)
  publishes the existing tainted resource as `space_shared` and rewrites its
  content access grants once every taint owner has approved; it creates no new
  artifact or memory.

Not implemented yet:

- automatic grant-derived output blocking in `RunMaterializationService`
- semantic leakage detection for paraphrased personal-memory content

---

## Proposal Approval Rows

An explicit egress approval row has:
- `approval_type = egress_granting_user`
- `status = approved`
- for grant-derived egress: `grant_id` set and
  `approver_user_id = PersonalMemoryGrant.granting_user_id`
- for a context-taint publication: `grant_id` NULL and `approver_user_id` one of
  the taint owners; the applier requires a row from every taint owner

**Only the owners of the private inputs may provide this approval.** Space admins
and owners cannot approve on their behalf. Payload metadata flags
(`approved_by_granting_user`, `granting_user_approved`, etc.) are never treated as
proof of approval.

Revoked, failed, or expired grants block approval. `used` grants remain valid for egress
approval only for the same source run while the egress review deadline is still valid.

Approval rows are metadata-only. Applying an approved context-taint publication
changes the existing resource's visibility; no new shared artifact or memory is
created.

---

## UI Flow

The Run Detail page exposes a Personal context panel after a run has been created.
The panel allows the instructing user to:

- Preview structural grant eligibility (no raw memory shown).
- Create a `summary_only` grant after a run ID exists.
- View safe grant status metadata.
- Revoke active or consuming grants.
- Inspect safe audit events.

The Proposal list/detail page exposes egress review state to the granting user and
allows recording `egress_granting_user` approval when `currentUserId == required_approver_user_id`.

**UI invariants:**
- No raw personal memory text, generated personal summaries, memory IDs, or
  `personal_context_block` is shown in any shared-space UI surface.
- Grant description consistently says "used for reasoning only" — not "sharing personal memory."
- Egress review approval button says "Approve egress review"; supporting text clarifies
  that approval does not create shared content.
- Toast messages say "Egress review approval recorded."
- No multi-user, agent-level, space-level, or public grant UX is present.

---

## Security Invariants

These invariants are enforced at code level and covered by tests. They must never be weakened.

1. **No grant, no cross-space private memory.** A shared-space run without a valid grant cannot read personal-space private memory.
2. **User grants only their own memory.** `granting_user_id` is server-assigned from the authenticated user; a user cannot grant another user's memory.
3. **Publication does not replace grants.** A published copy does not authorize a shared-space run to read the source personal memory.
4. **Highly restricted memories excluded.** `sensitivity_level = highly_restricted` memories are never readable through a grant.
5. **Grant is run-scoped.** A grant for Run A cannot be reused by Run B.
6. **One-time lifecycle.** `expired`, `revoked`, and `used` grants cannot be reused.
7. **No raw personal memory in shared targets.** Personal memory summaries used as runtime context are not written into team memory, shared artifacts, or publication snapshots without explicit approved content creation.
8. **Space admin cannot substitute for granting user.** Only `granting_user_id` may record a grant-derived `egress_granting_user` approval, and only a required taint owner may record a context-taint one.
9. **Payload flags are not proof of approval.** Approval metadata in proposal payloads is never treated as a valid approval gate.
10. **Egress guard fails closed.** Unknown target spaces are treated as non-personal and trigger BLOCK.

---

## Current Limitations

- **Run-scoped only.** There are no agent-level or space-level grants.
- **One-time lifecycle.** There are no long-lived grants.
- **`summary_only` only.** There is no `retrieval_context` access mode.
- **Server-derived granting fields.** `granting_user_id` and `personal_space_id` are not client-writable.
- **Agent-scope memory excluded.** Grant summaries read only the user's own `private` memory with `sensitivity_level` `normal` or `sensitive`, never `scope_type = agent`.
- **Egress review creates no new content.** Approved egress review publishes the existing resource; it does not create a shared artifact or memory.
- **No semantic leakage detection.** Materialization does not detect paraphrased or inferred personal-memory meaning.
- **No public publishing or federation.** `visibility=public` and cross-instance federation are not supported.
- **No multi-user grants.** Only one granting user per grant.
- **No admin grant-stats endpoint.**

Unimplemented expansions: [`.agent/plans/unimplemented-from-guides.md`](../.agent/plans/unimplemented-from-guides.md) §13.

---

## See Also

- `docs/SPACE_MODEL.md` — space types and private memory definition
- `docs/CONTENT_PUBLICATIONS.md` — independent targeted snapshot transfer
- `docs/POLICY_AND_PRIVACY_BOUNDARIES.md` — policy enforcement inventory
- [`.agent/plans/unimplemented-from-guides.md`](../.agent/plans/unimplemented-from-guides.md) §13 — unimplemented grant expansions
- `server/src/modules/personalMemoryGrants/` — API implementation
- `server/src/modules/proposals/` — approval/apply gate
- `server/src/modules/runtimeContext/` — grant-aware context assembly and Delivery claim
