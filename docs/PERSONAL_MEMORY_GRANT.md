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
| `target_agent_id` | UUID FK agents | Always NULL in current MVP; agent-level grants deferred |
| `grant_scope` | TEXT | `run` only in current MVP |
| `access_mode` | TEXT | `summary_only` only in current MVP |
| `memory_filter_json` | JSON | Optional filter specifying namespaces, layers, kinds, max_items |
| `status` | TEXT | `active \| consuming \| used \| revoked \| expired \| failed` |
| `read_expires_at` | TIMESTAMP | Required; grant is invalid after this time |
| `egress_review_expires_at` | TIMESTAMP | Optional deadline for egress review/apply |
| `consume_started_at` | TIMESTAMP | Set when resolver claims the grant atomically |
| `used_at` | TIMESTAMP | Set when grant transitions to `used` |
| `revoked_at` | TIMESTAMP | Set on explicit user revoke |
| `failed_at` | TIMESTAMP | Set on resolver failure after memory was accessed |
| `failure_stage` | TEXT | Diagnostic stage label for failed grants |
| `created_at` | TIMESTAMP | Creation time |

**Uniqueness:** at most one `active` or `consuming` grant per `(target_run_id, granting_user_id)`.

### `personal_memory_grant_events`

Audit log for all grant lifecycle transitions. Contains `grant_id`, `event_type`,
`event_data_json` (safe metadata only, no personal memory content), `created_at`.

### `proposal_approvals`

First-class approval rows required before any egress-review proposal may be applied.
Stores `proposal_id`, `approval_type` (`egress_granting_user`), `approver_user_id`,
`grant_id`, `status` (`approved \| revoked`), approval metadata. No raw memory
content, summaries, or memory IDs.

---

## Grant Lifecycle

```
active → (atomic claim) → consuming → used      [normal path]
active → (explicit user revoke)  → revoked       [user cancels]
active → (expiry)                → expired        [time-based]
consuming → (failure after read) → failed         [terminal]
```

Status transitions are enforced at the service layer. The resolver uses an atomic
conditional UPDATE to claim the grant (`active → consuming`), preventing concurrent
double-consumption. If the claim returns no rows, the grant was already consumed,
revoked, or expired — context build aborts.

After the resolver reads personal memory and produces a summary, the grant transitions
`consuming → used`. If the resolver fails after accessing raw personal memory, the
grant transitions `consuming → failed` (never back to `active`).

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
- Rate limits and max active/consuming limits enforced (combined cap of 10 per user).

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
- Only the granting user may record that approval.
- Approval rejects payloads marked `raw_private_memory_included = true`.
- Tainted Artifact publication revalidates the target taint at apply time and requires
  every contributing owner named by that summary.

Not implemented yet:

- automatic grant-derived output blocking in `RunMaterializationService`
- automatic `egress_review` proposal creation from artifacts, memory proposals, or code patches
- a registered `egress_review` applier that creates shared artifacts/memory
- semantic leakage detection for paraphrased personal-memory content

---

## Proposal Approval Rows

An explicit egress approval row has:
- `approval_type = egress_granting_user`
- `approver_user_id = PersonalMemoryGrant.granting_user_id`
- `status = approved`

**Only the granting user may provide this approval.** Space admins and owners cannot
approve on behalf of the granting user. Payload metadata flags
(`approved_by_granting_user`, `granting_user_approved`, etc.) are never treated as
proof of approval.

Revoked, failed, or expired grants block approval. `used` grants remain valid for egress
approval only for the same source run while the egress review deadline is still valid.

Approval rows are metadata-only in the current MVP. Approval records permission to proceed
to a later shared-content review step; no shared artifact or memory is automatically
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
8. **Space admin cannot substitute for granting user.** Only `granting_user_id` may record `egress_granting_user` approval.
9. **Payload flags are not proof of approval.** Approval metadata in proposal payloads is never treated as a valid approval gate.
10. **Egress guard fails closed.** Unknown target spaces are treated as non-personal and trigger BLOCK.

---

## Current Limitations

- **Run-scoped only.** Agent-level and space-level grants are deferred.
- **One-time lifecycle.** Long-lived grants are deferred.
- **`summary_only` only.** `retrieval_context` access mode is deferred.
- **Server-derived granting fields.** `granting_user_id` and `personal_space_id` are not client-writable.
- **`schema_version = 1`** required for non-empty `memory_filter_json`.
- **Egress review is metadata-only.** Approved egress review does not automatically create a shared artifact or memory — a future phase is required for the full shared-content pipeline.
- **Semantic leakage detection is manual.** The current materialization path does not detect paraphrased or inferred personal-memory meaning in outputs.
- **No public publishing or federation.** `visibility=public` and cross-instance federation are not supported.
- **No multi-user grants.** Only single granting user per grant.
- **No admin grant-stats endpoint.** Aggregate grant statistics for space admins are deferred.

---

## Future Roadmap

See `docs/FUTURE_ROADMAP.md` for deferred items including:
- Full shared-content pipeline from approved egress_review
- Semantic leakage detection / redaction
- Long-lived grants
- Agent-level and space-level grants
- Multi-user grants
- Admin grant-stats endpoint

---

## See Also

- `docs/SPACE_MODEL.md` — space types and private memory definition
- `docs/CONTENT_PUBLICATIONS.md` — independent targeted snapshot transfer
- `docs/POLICY_AND_PRIVACY_BOUNDARIES.md` — policy enforcement inventory
- `docs/FUTURE_ROADMAP.md` — future work
- `server/src/modules/personalMemoryGrants/` — API implementation
- `server/src/modules/proposals/` — approval/apply gate
- `server/src/modules/context/` — grant-aware context assembly
- `server/test/agentsChatRoutes.test.ts`
- `server/test/contextPrepareService.test.ts`
