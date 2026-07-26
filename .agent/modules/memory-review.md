# Module: Memory Review

## Status
**PLANNED** — Memory backend exists. Review UI not yet built. API partially wired.

## Purpose
The governance UI for long-term memory. Memory review is not just a list — it is the surface where users inspect what agents believe, approve or reject proposed changes, trace memory provenance, and audit access patterns.

## Owns
- Memory review page and filters UI
- Pending memory proposal review UI (accept / reject / edit)
- Memory access log viewer
- Memory provenance inspector (which run / session created this?)

## Does Not Own
- Memory storage and CRUD (memory module)
- Proposal creation logic (agents / reflector)
- Proposal approval execution (proposals module)

## UI Sections

### 1. Active Memory List
- List all active memories for current space + user
- Filters: scope, type, visibility, Project Folder, importance, confidence, created_at
- Sort: by importance, last accessed, updated_at
- Each item: scope badge, title, content preview, access_count, last_accessed_at
- Actions: view detail, archive, flag for review

### 2. Memory Detail
- Full title and content
- Scope, namespace, type, visibility
- Importance / confidence scores
- Version history (version field)
- Source: linked session or run that produced this memory
- Access log: when was this memory last read, by which agent?
- Related proposals (Proposal records)

### 3. Pending Proposals
- List all `Proposal` with `status=pending`
- Shows: proposed_title, proposed_content, rationale
- Shows: source_session_id, source_run_id (click to open)
- Actions: Accept, Reject, Edit then Accept
- Accept → calls `POST /api/v1/proposals/{id}/accept`
- Reject → calls `POST /api/v1/proposals/{id}/reject`

### 4. Memory Access Logs
- Table of `MemoryReadTrace` entries for the selected memory
- Columns: accessed_at, agent_id, access_type, reason
- Shows which agents read which memories and when
- Useful for understanding agent context usage

## Invariants
- Users can only review memories in their own spaces (enforced by API)
- Accepting a proposal creates a new MemoryEntry record (or updates existing)
- Rejecting a proposal does not delete the source session or run
- Memory review is read-write for governance actions, read-only for content (editing goes through a new proposal)

## API Endpoints (Partial — needs wiring)

```
GET  /api/v1/memories?space_id=...&scope=...&type=...
GET  /api/v1/memories/{id}
GET  /api/v1/memories/{id}/access-logs
GET  /api/v1/proposals?type=memory_update&status=pending
POST /api/v1/proposals/{id}/accept
POST /api/v1/proposals/{id}/reject
```

## Related Files
- `server/src/modules/memory/` — Memory repositories and CRUD/read auth
- proposal API/service modules — Proposal workflow
- `server/migrations/` — MemoryEntry, Proposal, MemoryReadTrace tables
- `apps/web/src/pages/` — TODO: memory review page

## Related Modules
- [memory.md](memory.md) — backend memory system
- [proposals.md](proposals.md) — generalized proposal system
- [activity-inbox.md](activity-inbox.md) — upstream source of memory proposals
