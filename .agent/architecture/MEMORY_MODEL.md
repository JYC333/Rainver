# Memory model and family-space safety

## Principle

A **Space** is a collaboration boundary, not a shared mind. Members of a household or team space work together, but private cognition, restricted facts, and per-user context must remain enforceable at read time.

## Attribution layers

Long-lived learned content has exactly three carriers. An Agent is never a
Memory read scope.

| Layer | Meaning | Carrier | Read attribution |
|---|---|---|---|
| Personal | about a person | `memory_entries`, `scope_type=user` | `owner_user_id`, `private` |
| Project | how a project is done | `memory_entries`, `scope_type=project` | `project_id` and Project membership |
| Capability | how an Agent works | `evolvable_assets` | Agent/capability evolution policy |

`memory_entries.agent_id` records which Agent produced a Memory version. It is
provenance only: list, get, search, retrieval, maintenance, context assembly,
and digests must never select or authorize Memory by that column.

Within the two Memory layers:

- **User-owned memory** — `owner_user_id` identifies the human who controls the row for ACL; distinct from who the memory is *about*.
- **Subject-user memory** — `subject_user_id` means who or what the memory is *about* (often another user or the self); must not be conflated with `owner_user_id`.
- **Project memory** — `project_id` is required and Project membership is checked independently from visibility.
- **Selected-user memory** — visibility `selected_users`; readers require an active row in `content_access_grants` (or ownership). Its grant level is authoritative for the named reader.
- **Space-shared disclosure upgrades** — `space_shared` rows are readable to eligible members at their base level, and optional active grants can raise a named member from `summary` to `full`; grants never narrow the base level.
- **Restricted / highly restricted** — sensitivity remains separate from visibility. `highly_restricted` requires `private` visibility and is owner-only, except for an active Space owner/admin when that Space was created with immutable `oversight_mode=full`. `none`, `summary`, and `content` oversight modes, and all explicit grants, remain denied.
- **Summary access** — `access_level=summary` lets an authorized non-owner see metadata while withholding full `content`.

## Field semantics

| Field | Role |
|-------|------|
| `owner_user_id` | Human who controls personal Memory and receives owner ACL. |
| `subject_user_id` | Who or what the memory is about. Never inferred from `owner_user_id`. |
| `scope_type` | Memory placement: exactly `user` or `project`. Enforced by a database CHECK. |
| `project_id` | Required for `scope_type=project`; null for `scope_type=user`. |
| `agent_id` | Producing Agent provenance only; never a read-attribution or authorization axis. |
| `memory_type` | Public memory category used by APIs, digests, and UI grouping. |
| `memory_layer` | Layer in the memory hierarchy (`semantic` or `episodic` in the current baseline). |
| `visibility` | Who may read (`private`, `space_shared`, `selected_users`). |
| `access_level` | Maximum disclosure for authorized non-owners (`full`, `summary`). |
| `sensitivity_level` | How cautiously the row may be used (`normal`, `sensitive`, `restricted`, `highly_restricted`). |
| `created_from_proposal_id` | Canonical accepted-proposal FK for active memory creation. |

## Agents and context

Agents must **not** load all memories in a Space. Runtime Context requires
`space_id` and `user_id`, acquires through the canonical Memory read predicate
and sensitivity gates, redacts summary-only access for non-owners, and writes
the required cross-person privacy audit before content enters a Delivery. Owner
reads do not produce privacy-audit rows.

Canonical explicit cross-person reads (GET /memory/{id}, search hits) also
append `ContentReadTrace` rows.

Space oversight is read-only and is resolved inside that same predicate. It may
therefore contribute an eligible member's otherwise-private memory to that
owner/admin's own run context, subject to Project Folder/project and sensitivity
gates. It never puts `highly_restricted` memory into shared context blends,
digests, public summaries, or maintenance outputs.

## Writes and proposals

Long-lived writes continue through **proposal → approval**. Proposal payloads
carry `owner_user_id`, `subject_user_id`, `visibility`, `access_level`, and
`sensitivity_level`; acceptance must not conflate approving user, owner, and subject.

Creation context resolves placement before proposal creation. Personal context
creates owner-private `user` Memory; Project context creates `project` Memory
bound to that Project. Run taint takes precedence: learning derived from private
input is forced to the instructing user's personal layer even when the Run has a
Project or shared Agent context. Capability learning belongs in
`evolvable_assets`, not `memory_entries`.

## Implementation map

- Central rule: `server/src/modules/access/contentAccess*.ts`; Memory sensitivity
  and redaction are additional gates in Memory repositories.
- Serialization / redaction: `server/src/modules/memory/repository.ts` — memory row to API output helpers.
- Persistence of cross-person reads: `server/src/modules/contentAccess/audit.ts`;
  table `content_access_logs`. Only the resource owner may query a resource's
  audit log by default.

## Future work (TODO)

- Validate `subject_user_id` and `owner_user_id` against space membership when a membership service is available.
- Richer policy for `sensitivity_level` beyond MVP.
- Deduplicate audit logs if the same memory is injected multiple ways in one request (optional product decision).

## Non-goals

Provider credentials, Project Folder filesystem posture, and system administration
are not content visibility grants.
