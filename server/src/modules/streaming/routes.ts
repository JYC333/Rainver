/**
 * Streaming edge routes.
 *
 * - GET /api/v1/runs/:runId/turn/stream
 *
 * The turn arrives as an ordered list of parts: a snapshot of everything so
 * far, then a frame per change. Which event log the Run wrote to is not part
 * of the contract — see `turnStream.ts`.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { streamRunTurn } from "./turnStream.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/runs/:runId/turn/stream", async (request, reply) =>
    streamRunTurn(context.config, request, reply),
  );
}
