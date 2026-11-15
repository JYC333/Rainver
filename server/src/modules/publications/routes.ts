import {registerOperationAdapters} from "../systemActions/operations/routeAdapter.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { PublicationService } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const service = () => PublicationService.fromConfig(context.config);
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/publications',operation:'publication.create'},
    {method:'POST',url:'/api/v1/publications/:publicationId/import',operation:'publication.import',params:{publicationId:'publication_id'}},
    {method:'POST',url:'/api/v1/publications/:publicationId/revoke',operation:'publication.revoke',params:{publicationId:'publication_id'}},
  ]);

  app.get("/api/v1/publications", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const view = optionalString(query(request).view) ?? "received";
      if (view === "received") return reply.send(await service().listReceived(identity));
      if (view === "published") return reply.send(await service().listPublished(identity));
      throw new HttpError(422, "view must be received or published");
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/publications/:publicationId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service().get(identity, requiredParam(request, "publicationId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


}

function requiredParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}
