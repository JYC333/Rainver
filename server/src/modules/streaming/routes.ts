/**
 * Streaming edge routes.
 *
 * - GET /api/v1/runs/:runId/turn/stream
 * - GET /api/v1/me/agent-attention/stream (authorized aggregate, no Turn bodies)
 *
 * The turn arrives as an ordered list of parts: a snapshot of everything so
 * far, then a frame per change. Which event log the Run wrote to is not part
 * of the contract — see `turnStream.ts`.
 */

import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { streamAgentAttention } from "./agentAttentionStream.js";
import { streamRunTurn } from "./turnStream.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/me/agent-attention/stream", async (request, reply) => streamAgentAttention(context.config, request, reply));
  app.get("/api/v1/runs/:runId/turn/stream", async (request, reply) =>
    streamRunTurn(context.config, request, reply),
  );
}
