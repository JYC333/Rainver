import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  dbPool,
  jsonBody,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { enforceSources } from "./enforceSources.js";
import { SourceRecipeService } from "./sourceRecipeService.js";
import {introspectIdentity} from '../auth/identity.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';

/** Level 2 Source recipe routes: plan/create, dry-run preview, activation, and the recipe-version read model. */
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

  app.post("/api/v1/sources/source-recipes", {config:{operation:'source.recipe.create'}}, async (request, reply) => {
    const requestId=resolveRequestId(request);reply.header('cache-control','private, no-store');
    const auth=await introspectIdentity(context.config,request,reply);
    if(!auth.ok){const error=auth.reason==='denied'?new OperationError(auth.statusCode===401?'authentication_required':'operation_not_found',auth.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(error.httpStatus).send(error.body(requestId));}
    let body:Record<string,unknown>;
    try{body=jsonBody(request);}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    const key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(context.config)).execute('source.recipe.create',body,sessionActor({spaceId:auth.spaceId,userId:auth.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
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
        identity,
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
          identity,
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
