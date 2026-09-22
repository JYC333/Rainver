# Module: Client-Server Protocol

## Status
**REST + turn SSE.** Agent-turn SSE:
`GET /api/v1/runs/{runId}/turn/stream`. Host pairing uses WebSocket on
the hosts module. There is no general product event bus.

## Purpose
How the web client talks to `/api/v1`. Unknown paths return the local
404 catch-all.

The Files & Code recovery-draft and lazy message-owned input-resource contract
is recorded in [ADR 0021](../decisions/0021-files-code-codemirror-drafts-and-input-resources.md)
and is now the shipped behavior.

## Owns
- REST API conventions (request/response shape, error format, pagination)
- Agent-turn SSE
- API versioning (`v1`)

## Does Not Own
- Auth token generation (auth module)
- Business logic behind any endpoint (owning feature module)
- Transport security (deployment / infra layer)

## REST Conventions (Current)

**Base URL:** `GET /api/v1/...`

**Auth:** Session-cookie identity is current for the web app. Google OAuth is
available when configured. Persisted API keys are feature-gated and disabled
until the schema adds `api_keys`. The browser must not keep a leftover key in
`localStorage` or send it after logout. Internal service routes use the server
internal token, not browser credentials. The production PWA service worker
uses NetworkOnly for `/api/v1/*` so authenticated GET bodies are not reused
across accounts. In-app `href` values from the server must be same-origin
paths (`/` and not `//`); the browser drops anything else.

**Request body:** JSON with snake_case fields.

Conversation message requests accept a trimmed `content`/`message` string plus
an ordered `input_parts` array. Text-only requests remain compatible; an
image-only request is valid when the selected runtime/model explicitly supports
images. Image bytes use the authenticated multipart endpoint
`POST /api/v1/conversation-inputs/media` and are referenced in JSON by the
server-issued `media_id`; the browser never sends a Host path or base64 image
body. Historical image bytes are served only through the authenticated
Space-scoped `GET /api/v1/conversation-inputs/media/{mediaId}` endpoint.
Current-file attachments carry only server-validated saved/draft metadata in
`input_parts` (Folder, Location, relative path, source state, version/hash, and
optional selection). At send time the server freezes the exact bounded body in
an immutable message-owned resource and gives the Run a server-issued resource
id. The initial prompt contains the descriptor, not the body. Agents read or
search it through the Run-scoped `input_resource.read/search` actions; no
generic database URL, Host temporary path, or absolute browser path is exposed.
Legacy file snapshots remain readable for older messages and retry paths.

Files & Code draft routes use optimistic `draft_id`/`draft_version` mutations;
draft content stays in the authenticated server database and is not carried in
a current-file attachment descriptor. `GET .../file?path=...&convert=utf8` is
the explicit UTF-16 preview request; ordinary malformed/binary reads return
bounded read-only metadata and no replacement-decoded body.

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

## Run read model (`runs/runReadModel.ts`, `runToOut`)

A Run DTO carries `execution_kind` — `agent` or `provider_task` — and the
client branches on it rather than on a missing field. For a `provider_task`
Run, `agent_id` and `agent_version_id` are **null by construction**: a bounded
Server-side model call has no Agent, AgentVersion or runtime snapshot, and the
database CHECK on `runs` forbids them. `capability_id` is on the same DTO and
names the bounded operation (for example `research.adhoc_analyze`).

The web types say the same (`apps/web/src/types/api.ts`, `Run`), and the Runs
page uses the pair: `runActorLabel` renders a `provider_task` Run as
"Bounded provider task · <capability_id>" with a `provider task` badge, instead
of the "Agent unavailable" it shows for an `agent` Run whose Agent name did not
resolve. A null Agent on a `provider_task` Run is not a missing name.

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
- Error responses must be client-safe and never expose stack traces.

## Related Files
- `server/src/modules/` — REST route modules
- `server/src/server.ts` — app entry and CORS config
- `server/src/modules/auth/` — session/auth route and identity handling
- `apps/web/src/api/client.ts` — current REST client
- `apps/web/src/types/api.ts` — web-local API/view types during protocol alignment

## Related Modules
- [product-shell.md](product-shell.md)
- [server-status.md](server-status.md)
- [agents.md](agents.md)

Unimplemented generic WS / chunk SSE:
[unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §7.
