import { z } from "zod";

/**
 * Instance update contracts (ADR 0020).
 *
 * The server stores deployment jobs; the privileged deployer polls for them
 * over the internal-token channel and reports each stage back. Nothing here
 * gives the server Docker authority, and no request carries caller arguments
 * beyond the job type.
 */

export const DeploymentJobTypeSchema = z.enum(["update", "check_update"]);
export type DeploymentJobType = z.infer<typeof DeploymentJobTypeSchema>;

export const DeploymentJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type DeploymentJobStatus = z.infer<typeof DeploymentJobStatusSchema>;

/**
 * The stages the deployer actually reports. ADR 0020 §5 names backup and
 * migrate separately; `ops/scripts/db/migrate.sh` performs both in one
 * invocation that refuses to migrate on a failed dump, so it is reported as
 * one `migrate` stage whose log tail carries the dump path. `remote_check` is
 * the only stage a `check_update` job has.
 */
export const DeploymentStageSchema = z.enum([
  "pull",
  "drain",
  "migrate",
  "recreate",
  "health",
  "remote_check",
]);
export type DeploymentStage = z.infer<typeof DeploymentStageSchema>;

export const DeploymentStageStatusSchema = z.enum(["started", "succeeded", "failed"]);
export type DeploymentStageStatus = z.infer<typeof DeploymentStageStatusSchema>;

export const DeploymentJobSchema = z.object({
  id: z.string(),
  job_type: DeploymentJobTypeSchema,
  status: DeploymentJobStatusSchema,
  requested_by_user_id: z.string(),
  requested_at: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  current_stage: DeploymentStageSchema.nullable(),
  failure_stage: DeploymentStageSchema.nullable(),
  error_text: z.string().nullable(),
  /** What the instance `.env` resolved to when the deployer picked the job up. */
  target_tag: z.string().nullable(),
  drain_timeout_seconds: z.number().int().positive(),
  /** Pulled digests per service, dump path, health result. */
  result_json: z.record(z.unknown()),
  last_progress_at: z.string().nullable(),
});
export type DeploymentJob = z.infer<typeof DeploymentJobSchema>;

export const DeploymentJobEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  event_id: z.string(),
  stage: DeploymentStageSchema,
  status: DeploymentStageStatusSchema,
  at: z.string(),
  log_tail: z.string().nullable(),
});
export type DeploymentJobEvent = z.infer<typeof DeploymentJobEventSchema>;

export const DeploymentJobDetailSchema = z.object({
  job: DeploymentJobSchema,
  events: z.array(DeploymentJobEventSchema),
});
export type DeploymentJobDetail = z.infer<typeof DeploymentJobDetailSchema>;

export const DeploymentServiceObservationSchema = z.object({
  service: z.string(),
  image_ref: z.string(),
  digest: z.string().nullable(),
  /** `org.opencontainers.image.revision` — the commit CI published from. */
  revision: z.string().nullable(),
  /**
   * `com.rainver.deployment-surface` — a content digest of `deployer/` and
   * `ops/`, the part of a release an update cannot carry. Every image built
   * from one commit carries the same value, so it changes only when that
   * surface actually changed, unlike the commit itself.
   */
  surface: z.string().nullable(),
});
export type DeploymentServiceObservation = z.infer<typeof DeploymentServiceObservationSchema>;

export const DeploymentRemoteCheckSchema = z.object({
  tag: z.string(),
  digest: z.string().nullable(),
  checked_at: z.string(),
});
export type DeploymentRemoteCheck = z.infer<typeof DeploymentRemoteCheckSchema>;

export const DeploymentObservationsSchema = z.object({
  services: z.array(DeploymentServiceObservationSchema),
  remote: DeploymentRemoteCheckSchema.nullable(),
  /** The Docker daemon the deployer talks to, for diagnosis. Not its own version. */
  docker_version: z.string().nullable(),
  observed_at: z.string(),
});
export type DeploymentObservations = z.infer<typeof DeploymentObservationsSchema>;

export const DeploymentStatusSchema = z.object({
  observations: DeploymentObservationsSchema.nullable(),
  /**
   * Remote server digest differs from the running one. Null when either is
   * unknown — an unknown comparison is not "up to date".
   */
  update_available: z.boolean().nullable(),
  /**
   * This instance can run an update at all: dev and test build their images
   * from a checkout the deployer does not mount. Derived from the server's own
   * environment so the surface can say so before a button is pressed.
   */
  updates_supported: z.boolean(),
  /**
   * A heartbeat arrived recently enough to believe a job would be picked up.
   * False when the deployer has never reported: a job created now would sit
   * queued — pausing every unattended Run — until the sweep failed it.
   */
  deployer_online: z.boolean(),
  /**
   * The deployment surface the running deployer carries differs from the one
   * this release expects. It never updates itself (ADR 0020 §6), so this is
   * the signal that the host step is due — and it compares content rather than
   * commits, because the deployer is a commit behind after every update
   * whether or not anything about it changed. Null when either image carries
   * no surface label, which is every locally built instance.
   */
  deployer_behind: z.boolean().nullable(),
  active_job: DeploymentJobSchema.nullable(),
  last_job: DeploymentJobSchema.nullable(),
});
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

export const DeploymentJobListSchema = z.object({ items: z.array(DeploymentJobSchema) });
export type DeploymentJobList = z.infer<typeof DeploymentJobListSchema>;

/** The only body an administrator sends: which of the two jobs to create. */
export const DeploymentJobCreateSchema = z.object({ job_type: DeploymentJobTypeSchema }).strict();
export type DeploymentJobCreate = z.infer<typeof DeploymentJobCreateSchema>;

// ── Internal channel (deployer ↔ server, internal token only) ────────────────

export const DeploymentHeartbeatRequestSchema = z.object({
  /**
   * Which deployer is beating. Stable across a restart of the process inside
   * one container, different between containers, so the server can tell a job
   * whose executor died apart from a job another deployer is still running.
   */
  deployer_id: z.string().min(1).max(128),
  services: z.array(DeploymentServiceObservationSchema),
  remote: DeploymentRemoteCheckSchema.nullable(),
  docker_version: z.string().nullable(),
}).strict();
export type DeploymentHeartbeatRequest = z.infer<typeof DeploymentHeartbeatRequestSchema>;

export const DeploymentHeartbeatJobSchema = z.object({
  id: z.string(),
  job_type: DeploymentJobTypeSchema,
  drain_timeout_seconds: z.number().int().positive(),
});
export type DeploymentHeartbeatJob = z.infer<typeof DeploymentHeartbeatJobSchema>;

export const DeploymentHeartbeatResponseSchema = z.object({
  job: DeploymentHeartbeatJobSchema.nullable(),
});
export type DeploymentHeartbeatResponse = z.infer<typeof DeploymentHeartbeatResponseSchema>;

export const DeploymentStageEventRequestSchema = z.object({
  /**
   * The deployer's own id for this event, kept across its retries. A report
   * whose response was lost is retried, and without this the append-only audit
   * would grow a duplicate — or reject the retry of an event it already has.
   */
  event_id: z.string().min(1).max(64),
  stage: DeploymentStageSchema,
  status: DeploymentStageStatusSchema,
  /** Bounded by the server; the deployer sends the tail it has. */
  log_tail: z.string().nullable().optional(),
  /** Bounded to the column: an over-long tag is a 422, never a failed insert. */
  target_tag: z.string().max(128).nullable().optional(),
  result_json: z.record(z.unknown()).optional(),
  /**
   * The last event of the job. The deployer owns its stage sequence, so it
   * says when the sequence is finished; a `failed` event always ends the job
   * regardless of this flag.
   */
  terminal: z.boolean().optional(),
}).strict();
export type DeploymentStageEventRequest = z.infer<typeof DeploymentStageEventRequestSchema>;

export const DeploymentDrainResponseSchema = z.object({
  running_runs: z.number().int().nonnegative(),
});
export type DeploymentDrainResponse = z.infer<typeof DeploymentDrainResponseSchema>;
