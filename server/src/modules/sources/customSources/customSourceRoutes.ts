import {registerOperationAdapters} from "../../systemActions/operations/routeAdapter.js";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../../gateway/routeRegistry.js";
import {
  dbPool,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../../routeUtils/common.js";
import { requireInstanceAdmin } from "../../routeUtils/access.js";
import { PgCustomSourceHandlerRepository } from "./customSourceHandlerRepository.js";
import { CustomSourceCredentialService } from "./customSourceCredentialService.js";

/** Custom Source create-flow, repair/rollback, credentials, and read-model routes. */
export function registerCustomSourceRoutes(app: FastifyInstance, context: ModuleContext): void {
  const customSourceRepository = () =>
    new PgCustomSourceHandlerRepository(dbPool(context.config), context.config);
  const customSourceCredentials = () => new CustomSourceCredentialService(dbPool(context.config), context.config);

  const connection={connectionId:'source_connection_id'};
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/sources/custom-sources/drafts',operation:'source.custom.draft.create'},
    {method:'POST',url:'/api/v1/sources/custom-sources/:connectionId/generate-handler',operation:'source.custom.handler.generate',params:connection},
    {method:'POST',url:'/api/v1/sources/custom-sources/:connectionId/test-handler',operation:'source.custom.handler.test.request',params:connection},
    {method:'POST',url:'/api/v1/sources/custom-sources/:connectionId/activate',operation:'source.custom.handler.activate',params:connection},
    {method:'POST',url:'/api/v1/sources/custom-sources/:connectionId/repair',operation:'source.custom.repair.request',params:connection},
    {method:'POST',url:'/api/v1/sources/custom-sources/:connectionId/rollback',operation:'source.custom.rollback',params:connection},
    {method:'POST',url:'/api/v1/sources/custom-sources/:connectionId/bridge-pipeline',operation:'source.custom.pipeline_bridge',params:connection},
    {method:'POST',url:'/api/v1/sources/custom-source-credentials',operation:'source.custom.credential.create'},
    {method:'PUT',url:'/api/v1/sources/custom-source-settings/space',operation:'source.custom.settings.space.update'},
    {method:'PUT',url:'/api/v1/sources/custom-source-settings/instance',operation:'source.custom.settings.instance.update'},
  ]);

  app.get("/api/v1/sources/custom-source-credentials", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await customSourceCredentials().list(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/custom-source-settings/space", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await customSourceRepository().getSpacePolicy(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/custom-source-settings/instance", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      return reply.send(await customSourceRepository().getInstanceRunnerSettings());
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/connections/:connectionId/custom-source", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await customSourceRepository().getHandlerSummary(identity, params(request).connectionId ?? ""),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/connections/:connectionId/handler-versions", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(
        await customSourceRepository().listHandlerVersions(identity, params(request).connectionId ?? "", {
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(
    "/api/v1/sources/connections/:connectionId/handler-versions/:versionId",
    async (request, reply) => {
      const identity = await resolveIdentity(context.config, request, reply);
      if (!identity) return reply;
      try {
        const p = params(request);
        const version = await customSourceRepository().getHandlerVersion(
          identity,
          p.connectionId ?? "",
          p.versionId ?? "",
        );
        if (!version) return reply.code(404).send({ detail: "Handler version not found" });
        return reply.send(version);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );

  app.get("/api/v1/sources/connections/:connectionId/handler-runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(
        await customSourceRepository().listHandlerRuns(identity, params(request).connectionId ?? "", {
          limit,
          offset,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/sources/connections/:connectionId/handler-runs/:runId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const p = params(request);
      const run = await customSourceRepository().getHandlerRun(identity, p.connectionId ?? "", p.runId ?? "");
      if (!run) return reply.code(404).send({ detail: "Handler run not found" });
      return reply.send(run);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
