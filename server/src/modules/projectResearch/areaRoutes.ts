import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, jsonBody, params, query, resolveIdentity, sendRouteError, HttpError } from "../routeUtils/common.js";
import { ProjectResearchAreaService } from "./areaService.js";

function requireParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}

export function registerProjectResearchAreaRoutes(
  app: FastifyInstance,
  context: ModuleContext,
  base: string,
  /**
   * Notebook chat is Project-level, not research-level: it discusses and edits
   * the Project's notes, and those moved out of the Research Area onto the
   * Project's own notes surface. Its path moved with it, so it is registered
   * under the Project base rather than under `.../research/`.
   */
  projectBase: string,
): void {
  const area = () => new ProjectResearchAreaService(dbPool(context.config), context.config);
  const route = (handler: (identity: { spaceId: string; userId: string }, request: Parameters<typeof params>[0]) => Promise<unknown>, status = 200) =>
    async (request: Parameters<typeof params>[0], reply: Parameters<typeof resolveIdentity>[2]) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        return reply.code(status).send(await handler(identity, request));
      } catch (error) {
        return sendRouteError(reply, error);
      }
    };

  app.get(`${base}/area`, route((identity, request) => area().getArea(identity, requireParam(request, "projectId"))));
  app.post(`${base}/area`, route((identity, request) => area().initializeArea(identity, requireParam(request, "projectId")), 201));
  app.get(`${base}/reading-list`, route((identity, request) => area().readingList(identity, requireParam(request, "projectId"), query(request))));
  // Per-note editing/revisions/rollback now go through the generic
  // /api/v1/knowledge/notes/:noteId endpoints — see areaService.ts.
  app.post(`${base}/ask-ai`, route((identity, request) => area().askAi(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.post(`${projectBase}/notebook-chat`, route((identity, request) => area().notebookChat(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.put(`${base}/reading-list/:sourceItemId/card`, route((identity, request) => area().upsertEvidenceCard(identity, requireParam(request, "projectId"), requireParam(request, "sourceItemId"), jsonBody(request))));
  app.post(`${base}/checklist`, route((identity, request) => area().createChecklistItem(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.patch(`${base}/checklist/:itemId`, route((identity, request) => area().updateChecklistItem(identity, requireParam(request, "projectId"), requireParam(request, "itemId"), jsonBody(request))));
  app.delete(`${base}/checklist/:itemId`, route((identity, request) => area().deleteChecklistItem(identity, requireParam(request, "projectId"), requireParam(request, "itemId"))));
}
