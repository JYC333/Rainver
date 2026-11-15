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
- `seedSpaceDefaults` includes the code-owned builtin Skill catalog inside the
  creation transaction. The catalog currently has no product packages; when a
  release ships one, this creates only immutable Space-local package/source
  rows, never bindings. Startup also syncs existing Spaces (see [skills.md](skills.md)).
- A non-personal Space owner/admin can create a seven-day email-bound invitation. The same fragment link authorizes a new account's registration and Space membership, or lets an existing active account with that email accept membership through an authenticated, atomic claim. Personal Spaces cannot invite additional members.
- Space writes are core operations (`server/src/modules/spaces/operations.ts`, writers in `writers.ts`; human API only, keyed, identity-only receipts): `space.create` (`POST /spaces`; household or team, creator becomes owner), `space.invitation.create` / `space.invitation.accept`, `space.snapshot_defaults.update`, `space.content_egress.update` and `space.retrieval_settings.update`. A `/spaces/:spaceId/...` URL acts in exactly that Space (`spaceParam` adapter binding; a header naming another Space is refused). The person's user and membership rows are held `FOR SHARE` until commit, so a concurrent role change, exit or account disable serializes against the write; owner/admin standing is required again before a replayed receipt is released. The caller generates the invitation secret (256-bit base64url) and keeps it for the claim link; the server stores only its hash and the fingerprint keys it, so no receipt or replay can disclose it. An embedding-dimension change queues the existing retrieval embedding backfill Job in the same transaction. Reads stay the legacy GET routes in `routes.ts`.
- All API calls include `space_id` (from session / header / default)
- Runtime Context requires explicit Space identity and raises on missing or drifting authority

## Invariants
- Every core data record must carry `space_id`
- Data from space A must never appear in context built for space B
- One deployment instance hosts many spaces — never create one instance per space

## Related Files
- `server/src/db/schema/auth.ts` — User schema authority
- `server/src/db/schema/spaces.ts` — Space and SpaceMembership schema authority
- `server/src/db/schema/projectFolders.ts` — Project Folder schema authority; Folder access is inherited entirely from the owning Project's ACL, not a separate membership table
- `packages/protocol/src/` — shared Project Folder/space DTOs when exported
- `server/src/modules/auth/registration.ts` / `server/src/modules/auth/identity.ts` — personal Space creation at registration and default Space selection
- `server/src/modules/spaces/` — Space GET readers (`routes.ts`), core operations (`operations.ts`, `operationRoutes.ts`) and their writers (`writers.ts`)
- `server/src/modules/runtimeContext/` — typed acquisition, Delivery authorization, and continuity with Space boundary enforcement

## Related Decisions
- [0001-space-model.md](../decisions/0001-space-model.md)
