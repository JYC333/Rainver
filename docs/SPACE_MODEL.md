# Space Model

## Concept

A **space** is the primary collaboration and permission boundary in rainver. One deployment
instance can host many spaces:

```
Deployment Instance
  ├── Personal Space   (type=personal, exactly one member: the owner)
  ├── Family Space     (type=household, multi-member)
  └── Team Space       (type=team, multi-member)
```

A space is **not** the only meaningful worldview for a user. A user may belong to several spaces
simultaneously. Future model concepts (PersonalView, ExecutionContext) will make cross-space
aggregation explicit without breaking the per-space permission boundary. See
`docs/TARGET_VIEW_MODEL.md` for the target concepts.

## Database model

```sql
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,           -- e.g. "personal", "family", "acme-team"
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- personal | household | team
  created_by_user_id TEXT,
  oversight_mode TEXT NOT NULL,  -- none | summary | content | full; creation-time immutable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE space_memberships (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- owner | admin | reviewer | member | guest
  status TEXT NOT NULL,          -- active for current membership; invitations are separate rows
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- owner | editor | viewer | agent_operator
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## Personal space convention

- A personal space has **exactly one member**: the space owner.
- `Space.type = "personal"` is the structural marker; it is not redundant with membership.
- The canonical personal Space has an active owner `space_memberships` row;
  absence of that row is inconsistent state, not an implicit membership.
- Personal Spaces always use `oversight_mode=none`.

## Personal-space private memory definition

"Personal-space private memory" means **all three** of the following are true:

1. `MemoryEntry.visibility = "private"`
2. `MemoryEntry.space_id = <the user's personal space id>`
3. `MemoryEntry.owner_user_id = <that user's id>`

Private content is also valid in shared Spaces, but it is not personal-space
memory. Missing `owner_user_id` is rejected by the memory proposal/apply path.

## Private content in shared spaces

Private content is valid in any Space and remains owner-only. Other members,
including Space admins, do not receive a read bypass **by default**. A Space
may instead choose an immutable creation-time oversight mode: `none` (the
default), `summary`, `content`, or `full`. It grants active owner/admin members
of that same Space read-only oversight of other members' otherwise-hidden
content; `summary` yields summary access, while `content` and `full` yield full
access. Only `full` may read `highly_restricted` memory. It never overrides a
workspace/project gate, grants no write/publish/proposal authority, and gives
instance admins nothing. The mode is returned to every member, shown during
Space creation, and displayed read-only afterwards so it cannot be discovered
after the fact.

Sharing uses either `space_shared` or explicit same-Space `selected_users`
grants. On a `space_shared` row, grants are optional disclosure upgrades: a
summary-visible row can give named members full content, and a grant cannot
narrow a full base row. On `selected_users`, an active grant's access level is
authoritative for that reader. Private rows never consult grants.
PersonalMemoryGrant is a separate run-scoped mechanism for personal memory
reasoning context.

## Personal ledger / participation records

A "participation record" or "personal ledger entry" for shared-space activity is a **future
model concept** (see `docs/TARGET_VIEW_MODEL.md` → `ParticipationRecord`). It is not
implemented. When built, it must **not** copy raw shared-space content into a user's personal
space; it records only a pointer and the user's personal context around the activity.

## Rules

- Every data record (Memory, Session, Task, Run, etc.) carries a `space_id`.
- The ContextBuilder requires `space_id` and `user_id` — it will raise if either is missing.
- Memory queries filter by `space_id` first. No query can retrieve memory across spaces.
- `space_shared` visibility means visible to all eligible members of the same space; named active grants may upgrade summary disclosure to full.
- Workspace and Project are independent scope gates; they are not visibility values.
- `private` visibility has no grant-based reader; eligible Space owner/admin
  oversight may add read-only access according to the immutable Space mode.
- `selected_users` visibility requires explicit same-Space grants for ordinary
  readers; the grant level controls that reader's disclosure, while eligible
  oversight remains the only non-grant exception.

## Roles

Space-level roles:
- `owner` — full control, can delete the space
- `admin` — manage members and workspaces
- `reviewer` — proposal/review responsibility without admin membership control
- `member` — normal access
- `guest` — read-only, limited access

Workspace-level roles:
- `owner` — full workspace control
- `editor` — read/write
- `viewer` — read-only
- `agent_operator` — can trigger agent runs

## Cross-space transfer

There is no direct cross-Space content read or cross-Space grant. An owner may
publish an immutable snapshot to explicitly selected target Spaces. A target
member imports that snapshot as a new private resource owned by the importer;
the source resource is never exposed. `PersonalMemoryGrant` remains the separate
reasoning-context mechanism for a shared-space run. See
`docs/CONTENT_PUBLICATIONS.md` and `docs/PERSONAL_MEMORY_GRANT.md`.

## See also

- `docs/README.md` — full documentation index
- `docs/TARGET_VIEW_MODEL.md` — target model concepts (PersonalView, ExecutionContext, etc.)
- `docs/PERSONAL_MEMORY_GRANT.md` — explicit personal memory grant mechanism
- `docs/CONTENT_PUBLICATIONS.md` — targeted cross-space snapshot transfer
- `docs/POLICY_AND_PRIVACY_BOUNDARIES.md` — policy enforcement inventory
- `docs/FEDERATED_ACCESS_MODEL.md` — federated access (deferred)
- `server/src/modules/access/contentAccessPolicy.ts` — memory and content read authorization
- `server/src/modules/memory/memoryApplyRepository.ts` — accepted memory proposal apply path
