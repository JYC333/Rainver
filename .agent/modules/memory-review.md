# Module: Memory Review

## Status
**IMPLEMENTED** — `apps/web/src/modules/memory/MemoryModule.tsx` at
`/memory`, and proposal review at `/proposals`.

## Purpose
Governance UI for long-term memory and pending proposals.

## Owns
- Memory list, filters (including written-by-Agent / by-a-person /
  archived), `?session=` / `?run=` deep links
- Memory detail and version History
- Owner Archive / Restore on their own entry (no proposal)
- Proposal list/detail accept/reject (shared Review scene)

## Does Not Own
- Memory storage (`memory` module)
- Proposal apply (`proposals` module)

## Current API (used by the UI)

```
GET  /api/v1/memory...
GET  /api/v1/proposals
POST /api/v1/proposals/{id}/accept
POST /api/v1/proposals/{id}/reject
GET  /api/v1/content-access/:resourceType/:resourceId/access-logs
```

## Related Files
- `apps/web/src/modules/memory/`
- `server/src/modules/memory/`
- `server/src/modules/proposals/`
- `server/src/modules/contentAccess/`

## Related Modules
- [memory.md](memory.md)
- [proposals.md](proposals.md)
