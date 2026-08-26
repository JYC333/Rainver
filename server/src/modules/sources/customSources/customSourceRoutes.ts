import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../../gateway/routeRegistry.js";
import {
  dbPool,
  jsonBody,
  parsePage,
  params,
  query,
  optionalString,
  resolveIdentity,
  sendRouteError,
} from "../../routeUtils/common.js";
import { requireInstanceAdmin } from "../../routeUtils/access.js";
import { enforceSources } from "../enforceSources.js";
import { PgCustomSourceHandlerRepository } from "./customSourceHandlerRepository.js";
import { CustomSourceCreateFlowService } from "./customSourceCreateFlowService.js";
import { CustomSourceRepairService } from "./customSourceRepairService.js";
import { CustomSourceCredentialService } from "./customSourceCredentialService.js";
import { applyContentCreationContext, resolveContentCreationContext } from "../../access/creationContext.js";

/** Custom Source create-flow (Phase 5), repair/rollback (Phase 9), credentials (Phase 10), and read-model (Phase 2) routes, split out of routes.ts per its own size. */
export function registerCustomSourceRoutes(app: FastifyInstance, context: ModuleContext): void {
  const customSourceRepository = () =>
    new PgCustomSourceHandlerRepository(dbPool(context.config), context.config);
  const customSourceCreateFlow = () =>
    new CustomSourceCreateFlowService(dbPool(context.config), context.config);
  const customSourceRepair = () => new CustomSourceRepairService(dbPool(context.config), context.config);
  const customSourceCredentials = () => new CustomSourceCredentialService(dbPool(context.config), context.config);

  app.post("/api/v1/sources/custom-sources/drafts", async (request, reply) => {
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
      const gate = await enforceSources(context, creationIdentity, "source.custom.create", "source_connection");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.code(201).send(await customSourceCreateFlow().createDraft(
        creationIdentity,
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/custom-sources/:connectionId/generate-handler", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.custom.generate", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply
        .code(201)
        .send(await customSourceCreateFlow().generateHandler(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/custom-sources/:connectionId/test-handler", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.custom.test", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await customSourceCreateFlow().testHandler(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/custom-sources/:connectionId/activate", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.custom.activate", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await customSourceCreateFlow().activateHandler(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/custom-sources/:connectionId/repair", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.custom.repair", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await customSourceRepair().repairHandler(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/custom-sources/:connectionId/rollback", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const connectionId = params(request).connectionId ?? "";
      const gate = await enforceSources(context, identity, "source.custom.rollback", "source_connection", connectionId);
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      return reply.send(await customSourceRepair().rollbackHandler(identity, connectionId, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/sources/custom-source-credentials", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.custom.credential_create", "custom_source_credential");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const payload = protocol.CustomSourceCredentialCreateSchema.parse(jsonBody(request));
      return reply.code(201).send(await customSourceCredentials().create(identity, payload));
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        return reply.code(422).send({ detail: "Invalid Custom Source credential" });
      }
      return sendRouteError(reply, error);
    }
  });

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

  app.put("/api/v1/sources/custom-source-settings/instance", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    if (!(await requireInstanceAdmin(context.config, identity, reply))) return reply;
    try {
      const payload = protocol.CustomSourceInstanceRunnerSettingsUpdateSchema.parse(jsonBody(request));
      return reply.send(await customSourceRepository().updateInstanceRunnerSettings(identity, payload));
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        return reply.code(422).send({ detail: "Invalid Custom Source runner settings" });
      }
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/sources/custom-source-settings/space", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const gate = await enforceSources(context, identity, "source.custom.settings_update", "custom_source_settings");
      if (gate.blocked) return reply.code(403).send(gate.reply403);
      const payload = protocol.CustomSourceSpacePolicyUpdateSchema.parse(jsonBody(request));
      return reply.send(await customSourceRepository().updateSpacePolicy(identity, payload));
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        return reply.code(422).send({ detail: "Invalid Custom Source settings" });
      }
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
