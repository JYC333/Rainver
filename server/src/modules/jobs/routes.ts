import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  HttpError,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { PgJobQueueRepository } from "./repository";
import type { JobEventRecord, JobRecord } from "./repository";
import { buildJobHandlerRegistry } from "./workerRuntime";

export interface JobOut {
  id: string;
  space_id: string;
  user_id: string | null;
  project_folder_id: string | null;
  agent_id: string | null;
  job_type: string;
  status: string;
  priority: number;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  scheduled_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEventOut {
  id: string;
  job_id: string;
  event_type: string;
  message: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const queue = () => PgJobQueueRepository.fromConfig(context.config);

  app.get("/api/v1/jobs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      const jobs = queue();
      const total = await jobs.countJobs({
        space_id: identity.spaceId,
        user_id: identity.userId,
        status: optionalString(q.status),
      });
      const items = await jobs.listJobs({
        space_id: identity.spaceId,
        user_id: identity.userId,
        status: optionalString(q.status),
        job_type: optionalString(q.job_type),
        limit,
        offset,
      });
      return reply.send({ items: items.map(jobToOut), total, limit, offset });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/jobs/handlers", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    return reply.send(buildJobHandlerRegistry(context.config).registeredJobTypes());
  });

  app.get("/api/v1/jobs/:jobId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const job = await queue().getJob(params(request).jobId ?? "");
      if (!job || jobNotFoundForSpace(job, identity.spaceId)) {
        return reply.code(404).send({ detail: "Job not found" });
      }
      return reply.send(jobToOut(job));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/jobs/:jobId/events", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const job = await queue().getJob(params(request).jobId ?? "");
      if (!job || jobNotFoundForSpace(job, identity.spaceId)) {
        return reply.code(404).send({ detail: "Job not found" });
      }
      const events = await queue().getEvents(job.id);
      return reply.send(events.map(jobEventToOut));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/jobs/:jobId/cancel", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const jobId = params(request).jobId ?? "";
      const job = await queue().getJob(jobId);
      if (!job || jobNotFoundForSpace(job, identity.spaceId)) {
        return reply.code(404).send({ detail: "Job not found" });
      }
      if (!["pending", "claimed"].includes(job.status)) {
        throw new HttpError(409, `Cannot cancel a job in status '${job.status}'`);
      }
      await queue().cancelJob(jobId, null);
      await queue().appendJobEvent({
        job_id: jobId,
        event_type: "status_change",
        message: "Job cancelled by user",
      });
      const updated = await queue().getJob(jobId);
      return reply.send(updated ? jobToOut(updated) : null);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

export function jobNotFoundForSpace(
  job: Pick<JobRecord, "space_id">,
  spaceId: string,
): boolean {
  return job.space_id !== spaceId;
}

export function jobToOut(job: JobRecord): JobOut {
  return {
    id: job.id,
    space_id: job.space_id,
    user_id: job.user_id,
    project_folder_id: job.project_folder_id,
    agent_id: job.agent_id,
    job_type: job.job_type,
    status: job.status,
    priority: job.priority,
    payload: job.payload_json ?? null,
    result: job.result_json ?? null,
    error: job.error,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    scheduled_at: job.scheduled_at,
    claimed_by: job.claimed_by,
    claimed_at: job.claimed_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    heartbeat_at: job.heartbeat_at,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

export function jobEventToOut(event: JobEventRecord): JobEventOut {
  return {
    id: event.id,
    job_id: event.job_id,
    event_type: event.event_type,
    message: event.message,
    data: event.data ?? null,
    created_at: event.created_at,
  };
}
