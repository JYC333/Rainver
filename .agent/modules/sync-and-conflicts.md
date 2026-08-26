# Module: Sync and Conflicts

## Status
**PLANNED** — No sync implementation. Single-instance local deployment only. Architecture must remain sync-ready.

## Purpose
Define the sync strategy for a future where Rainver can run on multiple devices or have a cloud-backed instance. Sync is not active now, but every data model decision must remain aligned with the sync model described here to avoid a painful migration later.

## Owns
- Sync protocol design (local-first captures and drafts; CRDT-friendly merges for syncable objects)
- Conflict detection and resolution rules
- Sync status UI indicators
- Merge policy per model type

## Does Not Own
- Transport implementation (HTTP/WebSocket — future infrastructure layer)
- Authentication for sync endpoints (auth module)
- Memory content arbitration (memory module decides merge policy, sync executes it)

## Core Design Principles

**Local-first for syncable objects:** Captures, drafts, tasks, card reviews, and user preferences write locally first. Sync is a background operation, not a prerequisite. Proposal apply and active memory writes remain server-authoritative, and agent execution stays authoritative to the control plane's server host or a paired execution host — none of this follows the local-first principle; see [architecture/LOCAL_FIRST_COMPATIBILITY.md](../architecture/LOCAL_FIRST_COMPATIBILITY.md) for the full data classification and [decisions/0016-control-plane-execution-hosts.md](../decisions/0016-control-plane-execution-hosts.md) for the execution-host model.

**Append-bias:** Prefer creating new records over in-place mutation. New Memory versions are new records (version field increments). Agent runs are immutable once complete.

**Human wins on conflict:** When a user edit conflicts with an agent-proposed change, the user edit wins. Agent proposals go through the proposal workflow and never overwrite directly.

**Space as sync unit:** Each `space_id` is an independent sync unit. Syncing space A does not touch space B data.

## Conflict Categories

| Category | Strategy | Example |
|---|---|---|
| Memory content conflict | Create new version; surface both in memory review | Two devices edit the same memory |
| Proposal status conflict | Last-writer-wins on `status`; log both events | Two devices accept/reject same proposal |
| Activity record duplicate | Deduplicate by (space_id, source, created_at, hash) | Same file imported twice |
| Knowledge item conflict | Version branching; merge UI surfaced to user | Two devices edit same knowledge item |
| Card scheduling conflict | Take later `next_review_at` (conservative) | Two devices review same card |
| Agent run conflict | Runs are immutable; no conflict possible | — |

## Sync Identifiers

All models must use globally unique IDs (UUID or nanoid) — never auto-increment integers. This is already the case for most models. Any new model must follow this rule.

## Sync Metadata (Per Record — Planned)

```
sync_clock     — Lamport timestamp or HLC
device_id      — originating device
synced_at      — last sync confirmation timestamp
sync_status    — local | synced | conflict | pending_push
```

These fields are not yet in the canonical schema, but every new model should be designed so they can be added without breaking existing queries.

## Sync Status UI

**RuntimeStatusBar integration (when sync enabled):**
- Green: all local changes pushed, all remote changes pulled
- Yellow: pending push (offline or slow)
- Red: conflict requiring user resolution

**Conflict resolution panel:**
- List of conflicting records with diff view
- For each: Accept Local / Accept Remote / Merge (open in editor)
- Resolved conflicts logged in audit trail

## Future Transport Options

1. **Self-hosted cloud relay** — Rainver server as sync hub between devices
2. **Peer-to-peer** — direct device sync (no cloud dependency)
3. **Third-party client-side sync store** — a client-side local store for offline capture (not the server-side backend)

The sync layer must be pluggable — the choice of transport must not leak into model or business logic code.

## Invariants
- All model PKs must be UUIDs or equivalent globally-unique strings (never sequences)
- `created_at` is immutable after record creation
- Sync must never delete user data without explicit user action (tombstone, not hard delete)
- Memory writes always go through proposals — never direct DB write from sync layer
- Sync is disabled by default; opt-in per deployment via config

## Related Files
- `server/migrations/` — all durable tables must have UUID PKs and immutable `created_at`
- `server/src/config.ts` — TODO: add `sync_enabled` flag
- `apps/web/src/components/` — TODO: SyncStatusIndicator in RuntimeStatusBar

## Related Modules
- [server-status.md](server-status.md) — sync status shown in RuntimeStatusBar
- [memory-review.md](memory-review.md) — conflict resolution surface for memory
- [client-server-protocol.md](client-server-protocol.md) — real-time event layer that sync uses
