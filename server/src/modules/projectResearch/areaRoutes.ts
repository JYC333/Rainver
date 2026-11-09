import {registerProjectManagementOperationRoutes} from '../projects/managementOperationRoutes.js';
import {registerResearchWorkspaceOperationRoutes} from "./workspaceOperationRoutes.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, params, query, resolveIdentity, sendRouteError, HttpError } from "../routeUtils/common.js";
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
  _projectBase: string,
): void {
  registerProjectManagementOperationRoutes(app,context,'projectResearch');
  registerResearchWorkspaceOperationRoutes(app,context);
  const area = () => new ProjectResearchAreaService(dbPool(context.config), context.config);
  const route = (handler: (identity: { spaceId: string; userId: string }, request: Parameters<typeof params>[0]) => Promise<unknown>, status = 200) =>
    async (request: Parameters<typeof params>[0], reply: Parameters<typeof resolveIdentity>[2]) => {
      reply.header('cache-control','private, no-store');
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        return reply.code(status).send(await handler(identity, request));
      } catch (error) {
        return sendRouteError(reply, error);
      }
    };

  app.get(`${base}/checklist/:itemId`,route((identity,request)=>area().getChecklistItem(identity,requireParam(request,'projectId'),requireParam(request,'itemId'))));
  app.get(`${base}/reading-list/:sourceItemId/card`,route((identity,request)=>area().getEvidenceCard(identity,requireParam(request,'projectId'),requireParam(request,'sourceItemId'))));
  app.get(`${base}/area`, route((identity, request) => area().getArea(identity, requireParam(request, "projectId"))));
  app.get(`${base}/reading-list`, route((identity, request) => area().readingList(identity, requireParam(request, "projectId"), query(request))));
  // Note editing, revisions, and rollback are the generic
  // /api/v1/knowledge/notes/:noteId endpoints. Do not add them here.
  app.get('/api/v1/projects/:projectId/notebook-chat/:runId',route((identity,request)=>area().notebookChatResult(identity,requireParam(request,'projectId'),requireParam(request,'runId'))));
}
