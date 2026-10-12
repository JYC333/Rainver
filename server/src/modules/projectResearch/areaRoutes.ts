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
   * Notebook chat is Project-level, not research-level. It discusses and edits
   * the Project's notes on the Project's own notes surface. Register it under
   * the Project base, not under `.../research/`.
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
  // Note editing, revisions, and rollback are the generic
  // /api/v1/knowledge/notes/:noteId endpoints. Do not add them here.
  app.post(`${base}/ask-ai`, route((identity, request) => area().askAi(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.post(`${projectBase}/notebook-chat`, route((identity, request) => area().notebookChat(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.put(`${base}/reading-list/:sourceItemId/card`, route((identity, request) => area().upsertEvidenceCard(identity, requireParam(request, "projectId"), requireParam(request, "sourceItemId"), jsonBody(request))));
  app.post(`${base}/checklist`, route((identity, request) => area().createChecklistItem(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.patch(`${base}/checklist/:itemId`, route((identity, request) => area().updateChecklistItem(identity, requireParam(request, "projectId"), requireParam(request, "itemId"), jsonBody(request))));
  app.delete(`${base}/checklist/:itemId`, route((identity, request) => area().deleteChecklistItem(identity, requireParam(request, "projectId"), requireParam(request, "itemId"))));
}
