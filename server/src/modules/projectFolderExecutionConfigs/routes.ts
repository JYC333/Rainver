import { ProjectFolderExecutionConfigRepository } from './repository.js';
import { registerProjectFolderConfigOperationRoutes } from '../projectFolders/operationRoutes.js';
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  params,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerProjectFolderConfigOperationRoutes(app, context);
  const repository = () => new ProjectFolderExecutionConfigRepository(dbPool(context.config));

  app.get("/api/v1/projects/:projectId/folders/:folderId/execution-config", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const row = await repository().get(identity, projectId(request), folderId(request));
      if (!row) return reply.code(404).send({ detail: "Project Folder Execution Config not found" });
      return reply.send(row);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
function folderId(request: FastifyRequest): string {
  const id = params(request).folderId;
  if (!id) throw new HttpError(422, "folderId is required");
  return id;
}

function projectId(request: FastifyRequest): string {
  const id = params(request).projectId;
  if (!id) throw new HttpError(422, "projectId is required");
  return id;
}
