import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { HttpError, params, resolveIdentity, sendRouteError } from "../routeUtils/common";
import { ProjectTemplatesService } from "./service";

let serviceFactoryOverride: ((context: ModuleContext) => ProjectTemplatesService) | null = null;

export function __setProjectTemplatesServiceFactoryForTests(
  factory: ((context: ModuleContext) => ProjectTemplatesService) | null,
): void {
  serviceFactoryOverride = factory;
}

function service(context: ModuleContext): ProjectTemplatesService {
  if (serviceFactoryOverride) return serviceFactoryOverride(context);
  return ProjectTemplatesService.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/project-templates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(service(context).listAvailableTemplates());
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/template", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = params(request).projectId;
      if (!projectId) throw new HttpError(422, "projectId is required");
      return reply.send({ template_key: await service(context).getProjectTemplate(identity, projectId) });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
