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

An Agent writes memory within bounds and is read afterwards
([ADR 0003](../decisions/0003-memory-proposal-flow.md)). `memory.remember`
and `memory.revise` apply directly when the entry stays `private`,
`normal`-sensitivity and about the person in the turn, and when a revision
replaces something the Agent itself wrote. Each write is a new version with
`created_by = agent:<id>`, `approved_by = null`,
`created_from_proposal_id = null`, and provenance carrying the run, session
and the rationale the Agent gave. The entry is user-scoped and carries no
Project (`ck_memory_entries_scope_placement`); what ties it to the work is
the Project work event.

Anything that changes reach — a wider `visibility`, a sensitivity above
normal, another person as subject, or replacing what a person or another
Agent wrote — becomes
a `memory_create`/`memory_update` proposal instead of an error, so the write
is recorded and only the decision waits. An Agent version whose
`memory_policy_json.requires_proposal` is true writes only by proposal; that
flag is enforced in `memoryDirectWriteExecutors.ts`. When one person's
writing passes `SERVER_MEMORY_DIRECT_WRITES_PER_SESSION` (default 50) —
counting active entries plus pending memory proposals, so ordinary revision
does not walk toward it — their memory writing is paused and raises one
`uncertain` attention item. A fault to look at, never a queue to approve, and
archiving what was written is the reset.

The boundary it counts within is the session, or the Run where there is no
session: a conversation outside a Room has none, and a surface with no
counter at all is the one thing the breaker must not leave behind. The
attention item keys the same way — `/memory?session=<id>` for a session,
`/memory?run=<id>` for a single turn — and a session-scoped one is raised in
every Project that session ran in, while a Run-scoped one belongs to that
Run's Project. Per person rather than per session, because a Room
conversation is one session shared by its members and only the owner of an
entry can archive it.

Archive and restore move one version: `setOwnStatus` takes the active head to
`archived` and back, and restores a `superseded` version once no newer one is
active — which is how the chain answers "put back what the Agent replaced".

The counterpart is that the writes are visible and reversible: the Memory
page filters to what Agents wrote, shows each version with its rationale, run
and session, and archives or restores the owner's own entry in one request
(`DELETE /memory/:id` returns 200 with the entry, or 202 with a proposal for
someone else's). In a Project run the write also appears in the Project's
updates as `memory.remembered` / `memory.revised` with a one-step
`archive_memory` undo.

Everything else — post-session reflection, activity-to-memory pipelines,
consolidation, maintenance packets and every import — continues through
**proposal → approval**. Proposal payloads
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
- Serialization / redaction: `server/src/modules/memory/repository.ts` — memory row to API output helpers; `versions()` returns the chain with each version's provenance.
- Direct Agent writes: `server/src/modules/memory/memoryApplyRepository.ts` (`applyDirect`, `setOwnStatus`, `MemoryReachError`) and `server/src/modules/memory/memoryDirectWriteExecutors.ts`.
- Paused-session attention: `server/src/modules/memory/projectIntegration.ts`.
- Persistence of cross-person reads: `server/src/modules/contentAccess/audit.ts`;
  table `content_access_logs`. Only the resource owner may query a resource's
  audit log by default. `GET /memory/:id` logs; the list and
  `GET /memory/:id/versions` do not — a browse is not a read of one person's
  memory, and logging every row of a filtered list would bury the reads that
  matter.

## Future work (TODO)

- Validate `subject_user_id` and `owner_user_id` against space membership when a membership service is available.
- Richer policy for `sensitivity_level` beyond MVP.
- Deduplicate audit logs if the same memory is injected multiple ways in one request (optional product decision).

## Non-goals

Provider credentials, Project Folder filesystem posture, and system administration
are not content visibility grants.
