import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { HttpError, dbPool, jsonBody, optionalString, params, query, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { PromptRepository } from "./repository.js";
import { resolvePrompt } from "./resolver.js";

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

  app.post(`${base}/:assetKey/versions`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository(context).createVersion(identity, requireParam(request, "assetKey"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetKey/resolve`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      return reply.send(await resolvePrompt(dbPool(context.config), {
        spaceId: identity.spaceId,
        userId: identity.userId,
        assetKey: requireParam(request, "assetKey"),
        projectId: optionalString(body.project_id),
        agentId: optionalString(body.agent_id),
        explicitVersionId: optionalString(body.explicit_version_id),
        allowUserPin: body.allow_user_pin === true,
        label: optionalString(body.label),
        variables: typeof body.variables === "object" && body.variables !== null && !Array.isArray(body.variables)
          ? body.variables as Record<string, unknown>
          : undefined,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetKey/render-preview`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).renderPreview(identity, requireParam(request, "assetKey"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetKey/evaluate`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository(context).recordEvaluation(identity, requireParam(request, "assetKey"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetKey/promote`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository(context).createPromotionProposal(identity, requireParam(request, "assetKey"), jsonBody(request)));
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

  app.put(`${base}/:assetKey/deployments/:label`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).setDeployment(
          identity,
          requireParam(request, "assetKey"),
          requireParam(request, "label"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetKey/rollback`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).rollbackDeployment(identity, requireParam(request, "assetKey"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
