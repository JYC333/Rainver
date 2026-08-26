import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { dbPool, HttpError, jsonBody, optionalString, query, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { requireInstanceAdmin } from "../routeUtils/access.js";
import { RuntimeToolRegistry } from "../runtimeTools/index.js";
import { LocalCliConformanceProbeRunner } from "./probeRunner.js";
import { RuntimeConformanceService } from "./service.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.post("/api/v1/runtime-conformance/run", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      if (!(await requireInstanceAdmin(context.config, identity, reply, "Runtime conformance requires instance admin"))) return reply;
      const body = jsonBody(request);
      const runtime = optionalString(body.runtime);
      if (!runtime) throw new HttpError(422, "runtime is required");
      const requestedVersion = optionalString(body.runtime_version);
      const tool = await new RuntimeToolRegistry(context.config).resolveForExecution(runtime, requestedVersion);
      const result = await new RuntimeConformanceService(dbPool(context.config)).run({
        space_id: identity.spaceId,
        runtime_adapter_type: runtime,
        runtime_version: tool.version,
        runner: new LocalCliConformanceProbeRunner(context.config, identity),
      });
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/runtime-conformance", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await new RuntimeConformanceService(dbPool(context.config)).list(optionalString(query(request).runtime)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
