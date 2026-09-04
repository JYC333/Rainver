# Module: Client-Server Protocol

## Status
**CURRENT REST + PARTIAL STREAMING** — REST API exists. Agent turn SSE exists
at `GET /api/v1/runs/{runId}/turn/stream`. General WebSocket / real-time layer
is not yet built.

## Purpose
Define how frontend and mobile clients communicate with the client-facing API
entrypoint. The default path is `apps/web` -> `server` -> server-owned routes.
Unknown `/api/v1/*` routes return `{ "detail": "Route not found" }` from the
local catch-all. This module records REST conventions already in place, the run
event SSE surface, and the planned real-time event layer. It is the contract
between clients, server routing, and owning backend modules — changes here
affect both sides.

## Owns
- REST API conventions (request/response shape, error format, pagination)
- WebSocket event protocol (planned)
- Server-Sent Events for streaming agent output (planned)
- API versioning strategy

## Does Not Own
- Auth token generation (auth module)
- Business logic behind any endpoint (owning feature module)
- Transport security (deployment / infra layer)

## REST Conventions (Current)

**Base URL:** `GET /api/v1/...`

**Auth:** Session-cookie identity is current for the web app. Google OAuth is
available when configured. Persisted API keys are feature-gated and disabled
until the schema adds `api_keys`. Internal service routes use the server
internal token, not browser credentials.

**Request body:** JSON with snake_case fields.

**Response shape:**
```json
// Single resource
{ "id": "...", "field": "...", ... }

// Collection
{ "items": [...], "total": 42, "limit": 50, "offset": 0 }

// Error
{ "detail": "human-readable message" }
// or server-owned route error envelope:
{ "error": "machine_code", "message": "human-readable message", "request_id": "..." }
```

**HTTP status codes:**
- 200 OK — success (GET, PUT, PATCH)
- 201 Created — new resource created (POST)
- 204 No Content — delete success
- 400 Bad Request — validation error (`detail`)
- 401 Unauthorized — missing or invalid API key
- 403 Forbidden — authenticated but not allowed (wrong space)
- 404 Not Found — resource not found
- 422 Unprocessable Entity — body parse or semantic validation error
- 500 Internal Server Error — unexpected error

**Pagination:** current DB-backed list routes generally use `?limit=50&offset=0`
with a route-specific maximum.

**Filtering:** query params matching model field names (e.g., `?scope=user&type=preference`).

**Ordering:** `?order_by=created_at&desc=true`

## Current: Run Event SSE

Run event streaming is implemented as:

```
GET /api/v1/runs/{runId}/turn/stream
Accept: text/event-stream
```

The stream carries the turn, not the log it was recorded in. A client gets one
`turn.snapshot` frame with everything so far, then `turn.part_appended`,
`turn.part_updated` and `turn.state_changed` as it happens. A part changes in
place — a tool call finishing updates the part it started as — so a frame's
`part.index` is where it belongs in the list, not a running counter.
`turn.state_changed` carries `blocked_on` alongside `state`, because `blocked`
on its own does not say what the turn is waiting for.

`GET /api/v1/runs/{runId}/turn` is the same projection as a plain read, always
whole: part indices restart at 0 and the reply and Proposals are appended
unconditionally, so a partial read is not something a client could merge.

Assistant Chat is a two-step use of this transport:

1. `POST /api/v1/agents/{agentId}/chat` returns HTTP 202 with
   `chat_turn_accepted.v1`, including the queued `run_id` and an API-rooted
   `event_stream_url` pointing at the turn stream.
2. The client follows the turn. It ends on `done` or `failed`; on `done` the
   client reads the persisted assistant message, which is the durable reply.
   The turn deliberately does not report `done` until that message exists —
   the adapter returning and the Run going terminal both happen earlier.

   `blocked` is neither. A turn that stops to wait on a person — an
   authorization to grant, a review somebody owes it — is not finished and
   resumes where it stopped, so the stream stays open and the client keeps
   watching. Treating it as terminal sends the reader to fetch a reply that
   does not exist; treating it as ordinary work tells them nothing is
   expected of them. `blocked_on` says which kind of waiting it is.

There is no Chat-specific streaming endpoint and no polling execution path.

## Planned: Real-time Event Layer

**Transport:** WebSocket at `ws://host/api/v1/ws?space_id=...`

**Event envelope:**
```json
{
  "event": "event_type",
  "space_id": "personal",
  "payload": { ... }
}
```

**Event types:**

| Event | Payload | When |
|---|---|---|
| `agent_run.started` | `{run_id, agent_id}` | Run begins |
| `agent_run.output` | `{run_id, chunk}` | Streaming output chunk |
| `agent_run.completed` | `{run_id, status, exit_code}` | Run finishes |
| `proposal.created` | `{proposal_id, type}` | New proposal pending |
| `proposal.resolved` | `{proposal_id, status}` | Proposal accepted/rejected |
| `memory.updated` | `{memory_id}` | Memory record changed |
| `status.changed` | `{component, status}` | Runtime status change |
| `sync.conflict` | `{record_type, record_id}` | Sync conflict detected |

**Client → server messages:**
```json
{ "action": "subscribe", "channels": ["agent_runs", "proposals"] }
{ "action": "ping" }
```

## Planned: Generic SSE for Agent Output

The generic `GET /api/v1/runs/{id}/stream` route is not the current product
surface. Use the run-event SSE endpoint above until a separate output stream is
implemented.

```
GET /api/v1/runs/{id}/stream
Accept: text/event-stream

data: {"chunk": "...", "run_id": "..."}
data: {"done": true, "exit_code": 0}
```

## API Versioning

- Current: `v1` prefix on all routes
- Breaking changes → increment to `v2`; maintain `v1` for one release cycle
- Non-breaking additions (new fields, new endpoints) do not require version bump
- Frontend must gracefully handle unknown event types and extra JSON fields

## Invariants
- Browser data calls run inside `RequireAuth`; server identity resolution and
  object visibility remain authoritative.
- Most product routes are space-scoped through identity, request context, path,
  or query/body fields. `/me/*` routes are intentionally user-scoped
  cross-space aggregates and omit active-space params.
- Unknown `/api/v1/*` routes fail closed through the local 404 catch-all.
- Internal `/internal/*` routes are service-authenticated and are not browser
  product APIs.
- WebSocket connection is planned per space. Until then, run-event streaming
  uses SSE.
- Error responses must be client-safe and never expose stack traces.

## Related Files
- `server/src/modules/` — REST route modules
- `server/src/server.ts` — app entry and CORS config
- `server/src/modules/auth/` — session/auth route and identity handling
- `apps/web/src/api/client.ts` — current REST client
- `apps/web/src/types/api.ts` — web-local API/view types during protocol alignment

## Related Modules
- [product-shell.md](product-shell.md) — shell connects to WebSocket for live proposal badges
- [server-status.md](server-status.md) — status events pushed over WebSocket
- [agents.md](agents.md) — agent run output streamed via SSE
- [sync-and-conflicts.md](sync-and-conflicts.md) — sync conflict events over WebSocket
