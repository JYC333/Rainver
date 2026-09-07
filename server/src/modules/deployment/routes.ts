import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DeploymentDrainResponseSchema,
  DeploymentHeartbeatRequestSchema,
  DeploymentJobCreateSchema,
  DeploymentStageEventRequestSchema,
} from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { checkInternalToken } from "../../gateway/internalAuth.js";
import { getDbPool } from "../../db/pool.js";
import { requireInstanceAdmin } from "../routeUtils/access.js";
import { jsonBody, resolveIdentity, sendRouteError } from "../routeUtils/common.js";
import { DeploymentService } from "./service.js";

/**
 * Two entries, both without caller arguments beyond a job type (B43):
 *
 * - `/api/v1/deployments/*` — the instance administrator. Creating a job is
 *   the human approval a deployment requires; there is no Proposal.
 * - `/internal/deployment/*` — the deployer, on the internal token. It pulls
 *   work and reports stages; it can never create a job.
 */
export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  function service(reply: FastifyReply): DeploymentService | null {
    if (!context.config.databaseUrl) {
      reply.code(503).send({ detail: "SERVER_DATABASE_URL is required for deployment jobs" });
      return null;
    }
    return new DeploymentService(
      getDbPool(context.config.databaseUrl),
      context.config.rainverEnv,
      reply.log,
    );
  }

  async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ deployment: DeploymentService; userId: string } | null> {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return null;
    if (!(await requireInstanceAdmin(context.config, identity, reply, "Deployment requires instance admin"))) {
      return null;
    }
    const deployment = service(reply);
    return deployment ? { deployment, userId: identity.userId } : null;
  }

  function requireDeployer(request: FastifyRequest, reply: FastifyReply): DeploymentService | null {
    if (!checkInternalToken(context.config, request)) {
      reply.code(401).send({ detail: "Unauthorized" });
      return null;
    }
    return service(reply);
  }

  app.get("/api/v1/deployments/status", async (request, reply) => {
    try {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;
      return reply.send(await admin.deployment.status());
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/deployments/jobs", async (request, reply) => {
    try {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;
      const raw = (request.query as { limit?: string } | undefined)?.limit;
      const limit = raw === undefined ? 20 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(422).send({ detail: "limit must be an integer between 1 and 100" });
      }
      return reply.send({ items: await admin.deployment.listJobs(limit) });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/deployments/jobs", async (request, reply) => {
    try {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;
      const parsed = DeploymentJobCreateSchema.safeParse(jsonBody(request));
      if (!parsed.success) return reply.code(422).send({ detail: "job_type must be update or check_update" });
      return reply.code(201).send(await admin.deployment.createJob(parsed.data.job_type, admin.userId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/deployments/jobs/:jobId", async (request, reply) => {
    try {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;
      const { jobId } = request.params as { jobId: string };
      return reply.send(await admin.deployment.getJobDetail(jobId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/deployments/jobs/:jobId/cancel", async (request, reply) => {
    try {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;
      const { jobId } = request.params as { jobId: string };
      return reply.send(await admin.deployment.cancelJob(jobId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/internal/deployment/heartbeat", async (request, reply) => {
    try {
      const deployment = requireDeployer(request, reply);
      if (!deployment) return reply;
      const parsed = DeploymentHeartbeatRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) return reply.code(422).send({ detail: "Invalid deployment heartbeat" });
      return reply.send(await deployment.heartbeat(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/internal/deployment/jobs/:jobId/events", async (request, reply) => {
    try {
      const deployment = requireDeployer(request, reply);
      if (!deployment) return reply;
      const parsed = DeploymentStageEventRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) return reply.code(422).send({ detail: "Invalid deployment stage event" });
      const { jobId } = request.params as { jobId: string };
      return reply.send(await deployment.recordStageEvent(jobId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/internal/deployment/drain", async (request, reply) => {
    try {
      const deployment = requireDeployer(request, reply);
      if (!deployment) return reply;
      return reply.send(DeploymentDrainResponseSchema.parse(await deployment.drain()));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
