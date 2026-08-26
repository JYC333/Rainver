import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  jsonBody,
  parsePage,
  params,
  query,
  optionalString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { enforceSources } from "./enforceSources.js";
import { SourceRecipeService } from "./sourceRecipeService.js";
import { applyContentCreationContext, resolveContentCreationContext } from "../access/creationContext.js";

/** Level 2 Source recipe routes (plan/create, dry-run preview, activation, and the recipe-version read model), split out of routes.ts like customSourceRoutes.ts. */
export function registerSourceRecipeRoutes(app: FastifyInstance, context: ModuleContext): void {
  const recipeService = () => new SourceRecipeService(dbPool(context.config), context.config);

  app.get("/api/v1/sources/source-recipes/primitives", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return reply.send(recipeService().listPrimitives());
  });

  app.post("/api/v1/sources/source-recipes/plan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.recipe.create", "source_connection");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await recipeService().planSource(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/source-recipes", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      const creationIdentity = { spaceId: creation.spaceId, userId: identity.userId };
      const gate = await enforceSources(context, creationIdentity, "source.recipe.create", "source_connection");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await recipeService().createSource(
        creationIdentity,
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/source-recipes/:connectionId/activate", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.recipe.activate", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await recipeService().activateRecipe(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/custom-sources/:connectionId/bridge-pipeline", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.recipe.create", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(
        await recipeService().bridgePipelineHandler(identity, connectionId, jsonBody(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/source-recipes/:connectionId/dry-run", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.recipe.dry_run", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await recipeService().dryRunRecipeVersion(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/connections/:connectionId/recipe-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await recipeService().listVersions(
        identity.spaceId,
        params(request).connectionId ?? "",
        { limit, offset },
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(
    "/api/v1/sources/connections/:connectionId/recipe-versions/:versionId",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        const p = params(request);
        const version = await recipeService().getVersion(
          identity.spaceId,
          p.connectionId ?? "",
          p.versionId ?? "",
        );
        if (!version) return reply.code(404).send({ detail: "Recipe version not found" });
        return reply.send(version);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );
}
