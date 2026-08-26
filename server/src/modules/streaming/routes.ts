/**
 * Streaming edge routes.
 *
 * - GET /api/v1/runs/:runId/events/stream
 *
 * Query:
 * - `from_event_index` starts replay at an index (default 0).
 * - `tail=false` replays available events and closes instead of polling.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { streamRunEvents } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/runs/:runId/events/stream", async (request, reply) =>
    streamRunEvents(context.config, request, reply),
  );
}
