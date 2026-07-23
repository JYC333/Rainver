import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { dbPool, jsonBody, params, query, resolveIdentity, sendRouteError, HttpError } from "../routeUtils/common";
import { ProjectResearchWorkspaceService } from "./workspaceService";

function requireParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}

export function registerProjectResearchWorkspaceRoutes(
  app: FastifyInstance,
  context: ModuleContext,
  base: string,
): void {
  const workspace = () => new ProjectResearchWorkspaceService(dbPool(context.config), context.config);
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

  app.get(`${base}/workspace`, route((identity, request) => workspace().getWorkspace(identity, requireParam(request, "projectId"))));
  app.post(`${base}/workspace`, route((identity, request) => workspace().initializeWorkspace(identity, requireParam(request, "projectId")), 201));
  app.get(`${base}/reading-list`, route((identity, request) => workspace().readingList(identity, requireParam(request, "projectId"), query(request))));
  // Per-note editing/revisions/rollback now go through the generic
  // /api/v1/knowledge/notes/:noteId endpoints — see workspaceService.ts.
  app.post(`${base}/ask-ai`, route((identity, request) => workspace().askAi(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.post(`${base}/notebook-chat`, route((identity, request) => workspace().notebookChat(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.put(`${base}/reading-list/:sourceItemId/card`, route((identity, request) => workspace().upsertPaperCard(identity, requireParam(request, "projectId"), requireParam(request, "sourceItemId"), jsonBody(request))));
  app.post(`${base}/checklist`, route((identity, request) => workspace().createChecklistItem(identity, requireParam(request, "projectId"), jsonBody(request)), 201));
  app.patch(`${base}/checklist/:itemId`, route((identity, request) => workspace().updateChecklistItem(identity, requireParam(request, "projectId"), requireParam(request, "itemId"), jsonBody(request))));
  app.delete(`${base}/checklist/:itemId`, route((identity, request) => workspace().deleteChecklistItem(identity, requireParam(request, "projectId"), requireParam(request, "itemId"))));
}
