# Module: Client-Server Protocol

## Status
**REST + turn and user aggregate SSE.** Agent-turn SSE:
`GET /api/v1/runs/{runId}/turn/stream`. Host pairing uses WebSocket on
the hosts module. There is no general product event bus.

## Purpose
How the web client talks to `/api/v1`. Unknown paths return the local
404 catch-all.

The Files & Code recovery-draft and lazy message-owned input-resource contract
is recorded in [ADR 0021](../decisions/0021-files-code-codemirror-drafts-and-input-resources.md).

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
available when configured. Persisted API keys are feature-gated and disabled.
There is no `api_keys` table. The browser must not keep a leftover key in
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
`input_resource.read` is addressed by line and continued by byte: a line longer
than one read returns a bounded piece ending on a UTF-8 character boundary, and
the cursor `next_line` + `next_byte_offset` continues it on the same line
number. `eof` marks the end; `truncated` means more remains. An offset inside a
multi-byte character, past the line's end, or a `sha256` that does not match the
frozen resource is refused. Reads joined in cursor order reproduce the
resource.
File snapshots already stored on older messages stay readable on retry paths.

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

**Ordering:** fixed per route; there is no generic `order_by` / `desc` query parameter.

## Conversation session options and model identity

`PUT /api/v1/agents/{agentId}/conversation-session-config` accepts
`{ session_id, runtime_profile_id, session_config }` and returns the saved
`session_config`. A backend catalog GET reads the saved member selection, so
refresh does not depend on sending another message. Editors keep unsaved
choices separate from execution; Save affects future runs only. Save and a
selection sent with a message are validated strictly; a saved or inherited
selection the backend has since withdrawn is dropped at Run creation instead
of refusing the turn, and `RunTurn.model_selection.dropped` lists it
(`{ id, category, value, reason }`) so the turn says the runtime default was
used. A direct chat
without a Session yet carries its initial selection on the first message and
persists it in that creation transaction.

Run detail/status and `RunTurn.model_selection` distinguish `requested` from
`reported`, with `pending`, `reported`, or `unknown` observation state. The
reported model comes from ACP after option application, never from the request
or router prediction. An adapter's `default` is a policy rather than a concrete
model and displays as unknown. The existing Turn stream carries
`turn.model_changed` metadata without replacing streamed text or tool parts.

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
Each server poll also writes an SSE keepalive comment, including when the turn
has no changes, so long commands and approval waits do not trigger the proxy's
idle read timeout. These comments create no progress events.

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
   expected of them. `blocked_on` says which kind of waiting it is:
   `authorization`, `run_decision`, or `workspace` — the host queued the
   Run's launch behind another Run writing the same directory, which needs
   nobody and turns back into `working` once the host starts it
   (`modules/hosts.md`, "Location lease").

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

## Authentication protocol

The auth client uses the explicit `/api/v1/auth/*` facade. Login and recovery
errors are intentionally generic. Registration authority is carried in a
short-lived claim secret returned by the invitation/bootstrap intent endpoint;
the invitation token itself is read from a URL fragment and never sent in a
request URL. Session-management DTOs contain a server-owned session id and
metadata, not a cookie token or database digest. Password recovery returns no
raw link to an unauthenticated caller; an instance admin or the local sole-admin
CLI retrieves a manual link exactly once.


## Agent Attention read API

The session-authenticated `/api/v1/me/agent-attention` list, `/item` reader and
`PATCH /read-state` use the shared protocol DTOs; see
[Agent Attention](agent-attention.md) for query fields, child cursors, complete
counts, retention and 409 reading conflicts. Each selected Space is reauthorized;
no body user identity or operation descriptor grants authority.

`GET /api/v1/me/agent-attention/stream` uses the existing streaming edge and
SSE headers. Shared `AgentAttentionStreamFrameSchema` describes snapshot,
invalidation, resync, heartbeat and denied frames. Each carries a connection-local
`seq`, opaque equality-only `version`, complete unread-work count, optional
replacement 50-work personal page and at most 100 content-free revision notices.
`counts` carries the complete five group totals even when `page` is null
(optional on the wire for compatibility with older frames). Invalidation omits
an unchanged personal window; snapshot/resync includes it. Count changes and
as_of alone do not resend the window. Backpressure waits for drain with at most
one pending frame; it does not signal disconnection. Non-2xx stream responses
raise ApiRequestError with the actual HTTP status. `GET /snapshot` returns one
silent authorized snapshot as JSON for failed-connection fallback. These user
reads set `includeSpaceContext: false`; every source is independently authorized.
No Last-Event-ID replay, global sequence, Turn body subscription or new event log
is implied. Reconnect and sequence gaps require a new snapshot. The browser
client reuses `readServerSentEvents`, including multiline data/chunked CRLF,
and forwards AbortSignal; no parallel SSE parser exists.
See [Agent Attention](agent-attention.md#global-aggregation-and-delivery) for the
connection-owned two-second reread, visibility checks, bounded notices and
browser delivery/freshness behavior.

## Conversation source-Space options

The Room/Session conversation, Run command/read, Proposal, input-media/file and
retrieval-switch clients accept optional request options carrying `spaceId` and
`signal`. Existing signatures remain callable without them, defaulting to URL
active Space through the original request helper. Conversation surfaces pass an
explicit source through the entire subtree; no code switches the global Space
for an operation and switches it back. Image XHR upload and authenticated Blob
reads, Artifact export, accepted direct-chat streaming and persisted-message
readback preserve the same explicit scope and cancellation. Retry retains the
existing Idempotency-Key behavior. No automatic network resend was introduced.
See [Conversation](../architecture/CONVERSATION.md) for component ownership and
request lifetimes, and [Runs and outputs](../architecture/RUNS_AND_OUTPUTS.md) for
shared web Run commands.

Both Room file-reference and generic input composers pass explicit scope to
searchFiles and Folder tree/locations/file reads. Independent search and panel
signals are combined with `lib/mergeAbortSignals.ts` (AbortController listeners),
without requiring AbortSignal.any or throwIfAborted at runtime.

Room streams and Run commands release merged-signal listeners on normal completion
by aborting their own request controller; they leave the source panel signal live.

### Web Agent Attention consumer

`agentAttentionApi` in `apps/web/src/api/client.ts` uses the shared protocol query,
item, page and read-state contracts for list/item/PATCH. All three omit the active
Space header and forward AbortSignal; a source Space is explicit in the typed
query/body. `modules/agent_work/` consumes the server groups, complete counts and
opaque list/child cursors. The optional Run summary `agent_name`, `runtime_key`
and `started_at` fields provide bounded list display without per-row detail reads.
No API accepts a composed work_key or operation-supplied URL. Reading conflicts
preserve the returned current state and trigger an item refresh, not a retry that
acknowledges newer unseen content. Selected conversation/Run APIs still carry
their explicit source Space. The user-level aggregate stream above supplies only
collection invalidation/summary, not conversation content. Replies and exact-source
Run/authorization/Proposal commands retain their existing owning endpoints; no
second sender or execution watcher is introduced.

## Reading API usage

Use typed `informationDigestsApi.reading(spaceId, query, projectId?, {signal})`
for personal or Project views (`pending`, `read`, `all`). Forward the opaque
`next_cursor` unchanged only within the same Space/user/Project/view/search;
409 means restart from page one. Search is literal. Counts and group membership
are server-authoritative; do not combine per-source pages in a client cache.
Use `readingState` for read/restore/private dismissal and re-read the authorized
window after success; failures clear stale content. Preference GET/PUT changes
only the current user's default-off Project inclusion setting.

For fixed history use personal/Project edition lookup with explicit `date`;
GET never generates. Backfill is explicit and scope-authorized. Forward a full
reading card's `reader_origin` through `readingHref` to the shared Reader
(`from` becomes the document request's `origin`); summary-only cards do not link.
Project candidates, Source annotations and Research Reading List links explicitly
use project origin. `readingReturnTo` accepts only the enumerated local reading,
Sources candidates/settings, research reading-list and exact personal/Project
daily-edition destinations. Daily links retain the snapshot date; Project edition
returns must match the link’s explicit `projectId` context, independently of the
SourceItem’s own Project. This UI context grants no access. These UI
query parameters do not replace the Reader's current server authorization.
See [Information Digest](information-digest.md#unified-reading-projection) for
routes, pagination, state and immutable edition semantics.
