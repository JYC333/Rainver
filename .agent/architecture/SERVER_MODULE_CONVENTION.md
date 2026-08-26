# Server Module Convention

> **Status:** established 2026-06-11. Source of truth is the code under
> `server/src/`. Companions:
> [`SERVER_FOUNDATION.md`](SERVER_FOUNDATION.md) (the service),
> [`SERVER_OWNERSHIP.md`](SERVER_OWNERSHIP.md) (owned and deferred surfaces).

`server` is the **client-facing backend**. This document
defines the internal structure every server-owned module follows, so
future server features are added consistently. DB-persisted API-key storage
remains disabled until the canonical schema adds that table.

## Directory ownership

```
server/src/
  index.ts                 # process entrypoint (config load, listen, shutdown)
  server.ts                # composition root ONLY — no business route logic
  config.ts                # SERVER_* env parsing, fail-fast validation
  gateway/                 # PERMANENT HTTP entry layer
    routeRegistry.ts       #   module convention + registration order
    requestContext.ts      #   request-id continuity, safe header access
    errorEnvelope.ts       #   error shape + app-wide error handler
    logging.ts             #   logger options + secret redaction paths
  modules/                 # server-owned backend modules
    system/                #   health + features descriptors
      routes.ts            #     route registration for this module
      service.ts           #     pure logic (no Fastify types)
      index.ts             #     exports the ServerModule object
    catalog/               #   read-only surface over top-level catalog/ definitions
    capabilities/          #   capability/workflow/open-skill control plane
```

- **`gateway/` is permanent.** It is the entry/routing layer of the service:
  route registry, request context, error envelope, log hygiene. It is not a
  general plugin system and has no event bus.
- **`modules/` contains server-owned modules.** A new server module lives under
  `server/src/modules/<module_name>/` with `routes.ts` + `service.ts` +
  `index.ts`.
- **`server.ts` is composition root only.** It builds Fastify (logger, body
  passthrough) and delegates all route registration to
  `gateway/routeRegistry.ts`. Tests enforce that it contains no direct route
  registrations.

## Server-Owned Module Route Pattern

Each module exports a `ServerModule` (defined in
`gateway/routeRegistry.ts`):

```ts
// modules/<module_name>/index.ts
import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const myModule: ServerModule = { name: "<module_name>", registerRoutes };
```

```ts
// modules/<module_name>/routes.ts
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/server/<...>", async () => /* call service.ts */);
}
```

The module is then added to `SERVER_MODULES` in `gateway/routeRegistry.ts` and
advertised in `GET /api/v1/server/features`. `ModuleContext` carries the
validated config plus its immutable `ConfigSnapshot` (schema version + content
hash + load timestamp); future shared deps go there — it is dependency passing,
not a plugin system.

**Registration order is binding:** the registry mounts modules first and then a
final `/api/v1/*` catch-all that returns `404 { "detail": "Route not found" }`.
A route becomes owned only by explicit registration, never by accident.

## Request context convention

`gateway/requestContext.ts`:

- `resolveRequestId(request)` — preserve an incoming `x-request-id` or generate
  one. The gateway stamps it on every response.
- `buildRequestContext(request)` — `{ requestId, method, path }` for server-owned
  handlers. `modules/auth` owns session-cookie validation and may attach
  `{ userId, spaceId }` identity for downstream server-owned modules. OAuth callback
  semantics live in `modules/auth`; API-key persistence is feature-gated off
  while the canonical schema has no `api_keys` table.
- `readHeader(request, name)` — safe header access; refuses to return
  `Authorization`, `Cookie`, `Proxy-Authorization`. Auth resolution reads cookie
  material in `modules/auth`.
- `x-rainver-server: server` is trace metadata, never trust.

Authorization, Cookie, request bodies, and response bodies are never logged
(`gateway/logging.ts` redaction is defense in depth on top of Fastify's default
serializers).

## Error envelope convention

`gateway/errorEnvelope.ts`. Server-owned route errors use one JSON shape:

```json
{ "error": "<machine_code>", "message": "<human text>", "request_id": "<id>" }
```

- 5xx responses use a fixed generic message (`internal_error`) — no stack
  traces, no internal detail, in any environment.
- 4xx responses keep their intentional client-safe message.
- Unknown `/api/v1/*` routes return the local 404 catch-all shape
  `{ "detail": "Route not found" }`.

## Boundaries (what this convention does NOT change)

- Current server-owned contexts are listed in
  [`SERVER_OWNERSHIP.md`](SERVER_OWNERSHIP.md).
- Drizzle schema under `server/src/db/schema/` is the schema authoring source.
  Generated SQL under `server/migrations/` is invoked explicitly through ops
  commands, not by the long-running server process.
- The server adds no gateway caching or rate limiting.
- Routing rule: when a module claims a parametric route (`/:id`) under a prefix,
  it must claim every static sibling path under that prefix too. Parametric
  routes beat the catch-all, so an unclaimed static sibling (e.g.
  `/providers/presets`) would be swallowed by the parametric handler and
  mis-validated.
- Capability framework rule: `catalog` reads bundled/local manifests;
  `capabilities` owns canonical capability definitions, packs, workflow
  templates, imported skill records, and runtime skill render bindings. Do not
  add remote import, marketplace, or execution behavior to `catalog`.
