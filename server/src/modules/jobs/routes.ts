import { AUTOMATION_FIRE_JOB, SKILL_IO_JOB, SOURCE_RETRIEVAL_JOB, CONTENT_RETRIEVAL_JOB, READER_WRITE_JOB } from "@rainver/protocol";
import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { PgJobQueueRepository } from "./repository.js";
import type { JobEventRecord, JobRecord } from "./repository.js";
import { buildJobHandlerRegistry } from "./workerRuntime.js";
import { registerOperationAdapters } from "../systemActions/operations/routeAdapter.js";

interface JobOut {
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

interface JobEventOut {
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
        job_type: optionalString(q.job_type),
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
      if (!job || jobNotFoundForSpace(job, identity.spaceId, identity.userId)) {
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
      if (!job || jobNotFoundForSpace(job, identity.spaceId, identity.userId)) {
        return reply.code(404).send({ detail: "Job not found" });
      }
      const events = await queue().getEvents(job.id);
      return reply.send(events.map(event=>{
        const out=jobEventToOut(event);
        return [AUTOMATION_FIRE_JOB,SKILL_IO_JOB,'information_digest_backfill','activity_upload','activity_summary','daily_capture_report','research_query_evaluation'].includes(job.job_type)?{...out,message:out.event_type,data:null}:out;
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Formal adapter over the generic Job cancellation command.
  registerOperationAdapters(app, context.config, [
    { method: "POST", url: "/api/v1/jobs/:jobId/cancel", operation: "job.cancel", params: { jobId: "job_id" } },
  ]);
}

export function jobNotFoundForSpace(
  job: Pick<JobRecord, "space_id" | "user_id">,
  spaceId: string,
  userId: string,
): boolean {
  return job.space_id !== spaceId || job.user_id !== userId;
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
    payload: [AUTOMATION_FIRE_JOB,SKILL_IO_JOB,'information_digest_backfill','activity_upload','activity_summary','daily_capture_report','research_query_evaluation'].includes(job.job_type)?null:job.payload_json ?? null,
    // Source retrieval results are Source content: only their own reader releases them, under current access.
    result: [AUTOMATION_FIRE_JOB,SKILL_IO_JOB,SOURCE_RETRIEVAL_JOB,CONTENT_RETRIEVAL_JOB,READER_WRITE_JOB,'activity_upload','activity_summary','daily_capture_report','research_query_evaluation'].includes(job.job_type) ? null : job.result_json ?? null,
    error: [AUTOMATION_FIRE_JOB,SKILL_IO_JOB,'information_digest_backfill','activity_upload','activity_summary','daily_capture_report','research_query_evaluation'].includes(job.job_type)?null:job.error,
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
