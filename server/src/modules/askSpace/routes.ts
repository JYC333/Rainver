import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { jsonBody, resolveIdentity, sendRouteError, HttpError } from "../routeUtils/common.js";
import { AskSpaceService } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  // Unified Ask Space / Think entry point. Read-only and proposal-first: it
  // gathers across the viewer-visible retrieval domains, returns one cited /
  // gap-aware answer, and offers follow-up actions that reuse existing routes.
  app.post("/api/v1/ask-space/think", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const parsed = protocol.AskSpaceRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) {
        throw new HttpError(422, validationMessage(parsed.error.issues));
      }
      const service = AskSpaceService.fromConfig(context.config);
      const result = await service.think({
        spaceId: identity.spaceId,
        userId: identity.userId,
        query: parsed.data.query,
        domains: parsed.data.domains,
        maxResultsPerDomain: parsed.data.max_results_per_domain,
        mode: parsed.data.mode,
        includeTrace: parsed.data.include_trace,
        adaptiveReturn: parsed.data.adaptive_return,
        persist: parsed.data.persist,
        combine: parsed.data.combine,
        combineIncludeMemory: parsed.data.combine_include_memory,
        includeClaimTrajectory: parsed.data.include_claim_trajectory,
      });
      return reply.send(protocol.AskSpaceResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function validationMessage(issues: Array<{ path: Array<string | number>; message: string }>): string {
  const issue = issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
