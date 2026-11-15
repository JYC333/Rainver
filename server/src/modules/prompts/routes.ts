import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { HttpError, dbPool, optionalString, params, query, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { PromptRepository } from "./repository.js";
import { registerPromptOperationRoutes } from "./operations.js";

let repositoryFactoryOverride: ((context: ModuleContext) => PromptRepository) | null = null;

export function __setPromptRepositoryFactoryForTests(
  factory: ((context: ModuleContext) => PromptRepository) | null,
): void {
  repositoryFactoryOverride = factory;
}

function repository(context: ModuleContext): PromptRepository {
  if (repositoryFactoryOverride) return repositoryFactoryOverride(context);
  return new PromptRepository(dbPool(context.config));
}

function requireParam(request: FastifyRequest, name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const base = "/api/v1/prompts/assets";
  registerPromptOperationRoutes(app, context.config);

  app.get(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await repository(context).listAssets(identity, { promptType: optionalString(q.prompt_type) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:assetKey`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).getAsset(identity, requireParam(request, "assetKey")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:assetKey/versions`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).listVersions(identity, requireParam(request, "assetKey")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });






  app.get(`${base}/:assetKey/deployments`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).listDeployments(identity, requireParam(request, "assetKey"), {
        includeHistory: query(request).include_history === "true",
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


}
