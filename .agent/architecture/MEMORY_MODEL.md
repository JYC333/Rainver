# Memory model and family-space safety

## Principle

A **Space** is a collaboration boundary, not a shared mind. Members of a household or team space work together, but private cognition, restricted facts, and per-user context must remain enforceable at read time.

## What lives in family space memory

- **Space-shared memory** — visibility `space_shared`; readable by any member of the same space unless `sensitivity_level` blocks it.
- **User-owned memory** — `owner_user_id` identifies the human who controls the row for ACL; distinct from who the memory is *about*.
- **Subject-user memory** — `subject_user_id` means who or what the memory is *about* (often another user or the self); must not be conflated with `owner_user_id`.
- **Project Folder / project memory** — scope is represented by `project_folder_id` / `project_id` and checked independently from visibility.
- **Selected-user memory** — visibility `selected_users`; readers require an active row in `content_access_grants` (or ownership). Its grant level is authoritative for the named reader.
- **Space-shared disclosure upgrades** — `space_shared` rows are readable to eligible members at their base level, and optional active grants can raise a named member from `summary` to `full`; grants never narrow the base level.
- **Restricted / highly restricted** — sensitivity remains separate from visibility. `highly_restricted` requires `private` visibility and is owner-only, except for an active Space owner/admin when that Space was created with immutable `oversight_mode=full`. `none`, `summary`, and `content` oversight modes, and all explicit grants, remain denied.
- **Summary access** — `access_level=summary` lets an authorized non-owner see metadata while withholding full `content`.
- **System-scoped memory** — `scope_type=system`; excluded from normal list/search/get/context bulk loads unless an explicit system path passes `include_system_scope=True` (e.g. the system policy branch in `ContextBuilder`).

## Field semantics

| Field | Role |
|-------|------|
| `owner_user_id` | Human who controls the memory and receives owner ACL (may be null for system, Project Folder, space-level, agent, capability, public-template, or policy-controlled rows). |
| `subject_user_id` | Who or what the memory is about. Never inferred from `owner_user_id`. |
| `scope_type` | Public placement category (`system`, `space`, `user`, `project_folder`, `agent`, etc.). Specific object placement uses the dedicated owner/project_folder/project/agent columns rather than a generic `scope_id`. |
| `memory_type` | Public memory category used by APIs, digests, and UI grouping. |
| `memory_layer` | Layer in the memory hierarchy (`semantic` or `episodic` in the current baseline). |
| `visibility` | Who may read (`private`, `space_shared`, `selected_users`). |
| `access_level` | Maximum disclosure for authorized non-owners (`full`, `summary`). |
| `sensitivity_level` | How cautiously the row may be used (`normal`, `sensitive`, `restricted`, `highly_restricted`). |
| `created_from_proposal_id` | Canonical accepted-proposal FK for active memory creation. |

## Agents and context

Agents must **not** load all memories in a space. `ContextBuilder` requires
`space_id` and `user_id`, applies the canonical content SQL predicate plus
Memory sensitivity gates, redacts summary access for non-owners, and writes one
`MemoryReadTrace` row per injected memory.

Canonical explicit reads (GET /memory/{id}, search hits) also append `MemoryReadTrace` rows.

Space oversight is read-only and is resolved inside that same predicate. It may
therefore contribute an eligible member's otherwise-private memory to that
owner/admin's own run context, subject to Project Folder/project and sensitivity
gates. It never puts `highly_restricted` memory into shared context blends,
digests, public summaries, or maintenance outputs.

## Writes and proposals

Long-lived writes continue through **proposal → approval**. Proposal payloads
carry `owner_user_id`, `subject_user_id`, `visibility`, `access_level`, and
`sensitivity_level`; acceptance must not conflate approving user, owner, and subject.

When a `memory_create` carries no explicit visibility, it defaults to `private`
in every Space and is owned by the creating user. Sharing is an explicit policy
change after the proposal is accepted.

## Implementation map

- Central rule: `server/src/modules/access/contentAccess*.ts`; Memory sensitivity
  and redaction are additional gates in Memory repositories.
- Serialization / redaction: `server/src/modules/memory/repository.ts` — memory row to API output helpers.
- Persistence of reads: `server/src/modules/memory/repository.ts`; table `memory_access_logs` / protocol type `MemoryReadTrace`.

## Future work (TODO)

- Validate `subject_user_id` and `owner_user_id` against space membership when a membership service is available.
- Richer policy for `sensitivity_level` beyond MVP.
- Deduplicate audit logs if the same memory is injected multiple ways in one request (optional product decision).

## Non-goals

Provider credentials, Project Folder filesystem posture, and system administration
are not content visibility grants.
