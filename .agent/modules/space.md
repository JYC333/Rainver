# Module: Space

## Purpose
Product-level isolation boundary. Every piece of data lives inside a space. Enables personal, household, and team deployments from a single instance.

## Owns
- `Space` ORM model (space_id, name, type)
- `SpaceMembership` (user ↔ space relationship, role)
- All `space_id` scoping enforcement at the data layer

Project Folders (`project_folders`) are owned by the `projectFolders` module,
not Space — a Folder inherits its owning Project's ACL completely and has no
separate Space-level membership table.

## Does Not Own
- User identity lifecycle and authentication (`users` is authored by the auth schema/module)
- Memory content (memory module)
- Agent definitions (agents module)

## Key Models

```
Space: id, name, type (personal|household|team), created_at
SpaceMembership: id, space_id, user_id, role, status
```

## Main Flows
- On first run, bootstrap seeds the default owner's personal space (a generated UUID, located by owner membership — no fixed/magic space id)
- All API calls include `space_id` (from session / header / default)
- ContextBuilder requires `space_id` and raises if missing

## Invariants
- Every core data record must carry `space_id`
- Data from space A must never appear in context built for space B
- One deployment instance hosts many spaces — never create one instance per space

## Related Files
- `server/src/db/schema/auth.ts` — User schema authority
- `server/src/db/schema/spaces.ts` — Space and SpaceMembership schema authority
- `server/src/db/schema/projectFolders.ts` — Project Folder schema authority; Folder access is inherited entirely from the owning Project's ACL, not a separate membership table
- `packages/protocol/src/` — shared Project Folder/space DTOs when exported
- `server/src/config.ts` — bootstrap/default config
- `server/src/modules/spaces/` — default space and membership routes
- `server/src/modules/context/` — context assembly with space boundary enforcement

## Related Decisions
- [0001-space-model.md](../decisions/0001-space-model.md)
