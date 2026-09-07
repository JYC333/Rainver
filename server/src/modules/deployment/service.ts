import type { Pool } from "../../db/pool.js";
import type {
  DeploymentHeartbeatRequest,
  DeploymentHeartbeatResponse,
  DeploymentJob,
  DeploymentJobDetail,
  DeploymentJobType,
  DeploymentStatus,
  DeploymentStageEventRequest,
} from "@rainver/protocol";
import { withDbTransaction } from "../routeUtils/common.js";
import { DeploymentRepository, isUniqueViolation } from "./repository.js";

/** ADR 0020 §4: the drain waits this long before the deployer proceeds anyway. */
export const DEFAULT_DRAIN_TIMEOUT_SECONDS = 600;

/** A stage's output is a diagnostic on a job row, not a log store. */
export const MAX_LOG_TAIL_BYTES = 8 * 1024;

/**
 * A running job whose deployer has not reported for this long is lost. It has
 * to exceed the deployer's own per-stage budget (thirty minutes), or a slow
 * pull would be swept while it is still working.
 */
export const DEPLOYER_LOST_AFTER_MS = 60 * 60 * 1000;

/**
 * A queued job nobody claimed in this long has no deployer. The heartbeat is
 * every thirty seconds, so the only thing this waits out is a deployer
 * restart — and a non-terminal job defers every unattended Run meanwhile.
 */
export const DEPLOYER_UNAVAILABLE_AFTER_MS = 30 * 60 * 1000;

/**
 * No heartbeat for this long and the deployer is treated as not there.
 *
 * Six missed beats: long enough to ride out a deployer restart, short enough
 * that an administrator is not offered an Update that would only sit queued —
 * and a queued update pauses every unattended Run until the sweep fails it
 * half an hour later.
 */
export const DEPLOYER_OFFLINE_AFTER_MS = 3 * 60 * 1000;

export class DeploymentConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "DeploymentConflictError";
  }
}

export class DeploymentNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "DeploymentNotFoundError";
  }
}

export class DeploymentUnsupportedError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "DeploymentUnsupportedError";
  }
}

/**
 * The deployer is not reporting, so nothing would execute the job.
 *
 * Refused rather than queued because a queued `update` is not inert: it defers
 * every unattended Run from the moment it exists, and only the half-hour sweep
 * would release them.
 */
export class DeploymentDeployerOfflineError extends Error {
  readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = "DeploymentDeployerOfflineError";
  }
}

function boundLogTail(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= MAX_LOG_TAIL_BYTES) return value;
  // Keep the tail: the end of a failed stage is what names the failure. The
  // cut is at a byte offset, so drop a partial character rather than store a
  // replacement one.
  // A cut two bytes into a three-byte character decodes to two replacement
  // characters, so strip the run rather than one.
  return buffer.subarray(buffer.length - MAX_LOG_TAIL_BYTES).toString("utf8").replace(/^\uFFFD+/, "");
}

function serverObservation(observations: DeploymentStatus["observations"]) {
  return observations?.services.find((entry) => entry.service === "server") ?? null;
}

/** A heartbeat recent enough to believe a job would be claimed. */
function isDeployerOnline(
  observations: DeploymentStatus["observations"],
  now = Date.now(),
): boolean {
  if (!observations) return false;
  const at = Date.parse(observations.observed_at);
  return Number.isFinite(at) && now - at <= DEPLOYER_OFFLINE_AFTER_MS;
}

/**
 * The running deployer carries a different deployment surface than this
 * release expects.
 *
 * It never recreates itself (ADR 0020 §6), so after an update its image stays
 * where the last host run left it — which makes its *commit* differ from the
 * server's after every single update, whether or not anything about it
 * changed. Comparing commits would therefore be an alarm that is always on.
 * The surface label is a content digest of the deployer's own sources and the
 * ops tree, stamped on every image of a release, so a difference means the host
 * step is genuinely due. Null when either image carries no label, which is every instance whose
 * images were built locally.
 */
function deployerBehind(observations: DeploymentStatus["observations"]): boolean | null {
  const expected = serverObservation(observations)?.surface ?? null;
  const running = observations?.services.find((entry) => entry.service === "deployer")?.surface ?? null;
  return expected && running ? expected !== running : null;
}

/** `ghcr.io/owner/rainver-server:stable` → `stable`; null when the ref has no tag. */
function imageTag(imageRef: string | undefined): string | null {
  if (!imageRef) return null;
  const lastColon = imageRef.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tag = imageRef.slice(lastColon + 1);
  return tag.includes("/") || tag.length === 0 ? null : tag;
}

/**
 * Instance update authority.
 *
 * The administrator creates a job (that request is the ADR 0017 §1 approval),
 * the deployer claims it over the internal channel and reports stages back.
 * The server never contacts Docker or a registry: everything it knows about
 * images arrives on the heartbeat.
 */
export class DeploymentService {
  private readonly repository: DeploymentRepository;

  constructor(
    private readonly pool: Pool,
    private readonly rainverEnv: string = "",
    private readonly log?: { warn(message: string): void },
  ) {
    this.repository = new DeploymentRepository(pool);
  }

  async createJob(jobType: DeploymentJobType, requestedByUserId: string): Promise<DeploymentJob> {
    // An update pulls published images; dev and test build theirs from a
    // checkout the deployer does not mount. Refusing here is what keeps a job
    // that could only fail from being created — and from pausing every
    // unattended Run on that instance while it waits to fail.
    if (jobType === "update" && !this.updatesSupported()) {
      throw new DeploymentUnsupportedError(
        "Instance updates run on a production instance; this one is " +
          `${this.rainverEnv || "not identified by RAINVER_ENV"}.`,
      );
    }
    // A queued update is not inert — it defers every unattended Run — so it is
    // only created when something is there to pick it up. `check_update` has no
    // such cost and may wait for a deployer that is restarting.
    if (jobType === "update" && !isDeployerOnline(await this.repository.getObservations())) {
      throw new DeploymentDeployerOfflineError(
        "The deployer has not reported recently, so an update would sit queued " +
          "and pause scheduled work. Check the deployer container before retrying.",
      );
    }
    try {
      return await this.repository.createJob({
        job_type: jobType,
        requested_by_user_id: requestedByUserId,
        drain_timeout_seconds: DEFAULT_DRAIN_TIMEOUT_SECONDS,
      });
    } catch (error) {
      // The single-active unique index is the authority, not a prior read:
      // two administrators can press Update in the same instant.
      if (isUniqueViolation(error)) {
        throw new DeploymentConflictError("A deployment job is already queued or running");
      }
      throw error;
    }
  }

  async cancelJob(jobId: string): Promise<DeploymentJob> {
    const cancelled = await this.repository.cancelQueuedJob(jobId);
    if (cancelled) return cancelled;
    const existing = await this.repository.getJob(jobId);
    if (!existing) throw new DeploymentNotFoundError("Deployment job not found");
    throw new DeploymentConflictError(`A ${existing.status} deployment job cannot be cancelled`);
  }

  async listJobs(limit: number): Promise<DeploymentJob[]> {
    return this.repository.listJobs(limit);
  }

  async getJobDetail(jobId: string): Promise<DeploymentJobDetail> {
    const job = await this.repository.getJob(jobId);
    if (!job) throw new DeploymentNotFoundError("Deployment job not found");
    return { job, events: await this.repository.listEvents(jobId) };
  }

  async status(): Promise<DeploymentStatus> {
    const [observations, activeJob, lastJob] = await Promise.all([
      this.repository.getObservations(),
      this.repository.activeJob(),
      this.repository.lastTerminalJob(),
    ]);
    const server = serverObservation(observations);
    const running = server?.digest ?? null;
    const remote = observations?.remote?.digest ?? null;
    // A remote check for a different channel says nothing about this one: the
    // remote result survives heartbeats for a day, and the operator may have
    // changed RAINVER_IMAGE_TAG in between.
    const sameChannel = observations?.remote
      ? imageTag(server?.image_ref) === observations.remote.tag
      : false;
    return {
      observations,
      // An unknown digest on either side is not "up to date".
      update_available: running && remote && sameChannel ? running !== remote : null,
      updates_supported: this.updatesSupported(),
      deployer_online: isDeployerOnline(observations),
      deployer_behind: deployerBehind(observations),
      active_job: activeJob,
      last_job: lastJob,
    };
  }

  /**
   * One heartbeat: record what the deployer sees, then hand it the queued job
   * if there is one. Both happen in one transaction so an observation is never
   * recorded for a job handout that rolled back.
   */
  async heartbeat(input: DeploymentHeartbeatRequest): Promise<DeploymentHeartbeatResponse> {
    return withDbTransaction(this.pool, async (client) => {
      const repository = new DeploymentRepository(client);
      await repository.upsertObservations({
        services: input.services,
        remote: input.remote,
        docker_version: input.docker_version,
        observed_at: new Date().toISOString(),
      });
      // A beat from the deployer that holds a running job means that job's
      // executor died: the loop cannot beat and execute at the same time. A
      // beat from a different deployer says nothing about it, so that case is
      // left to the sweep rather than killing work another process is doing.
      const abandoned = await repository.releaseAbandonedRunningJob(input.deployer_id);
      if (abandoned > 0) {
        this.log?.warn(
          `[deployment] failed ${abandoned} job(s) abandoned by deployer ${input.deployer_id}`,
        );
      }
      const job = await repository.claimQueuedJob(input.deployer_id);
      return {
        job: job
          ? { id: job.id, job_type: job.job_type, drain_timeout_seconds: job.drain_timeout_seconds }
          : null,
      };
    });
  }

  async recordStageEvent(jobId: string, input: DeploymentStageEventRequest): Promise<DeploymentJobDetail> {
    let recorded: Awaited<ReturnType<DeploymentRepository["appendEvent"]>>;
    try {
      recorded = await withDbTransaction(this.pool, async (client) => {
        const repository = new DeploymentRepository(client);
        return repository.appendEvent({
          job_id: jobId,
          event_id: input.event_id,
          stage: input.stage,
          status: input.status,
          log_tail: boundLogTail(input.log_tail),
          target_tag: input.target_tag ?? null,
          result_json: input.result_json,
          terminal: input.terminal,
        });
      });
    } catch (error) {
      // A retry that started before its own first attempt committed reads no
      // event and then loses on the unique index. The event is recorded; say
      // so rather than making the deployer retry a report it already made.
      if (!isUniqueViolation(error)) throw error;
      return this.getJobDetail(jobId);
    }
    if (!recorded) {
      const existing = await this.repository.getJob(jobId);
      if (!existing) throw new DeploymentNotFoundError("Deployment job not found");
      // Cancelled or swept while the stage ran: the job is not revived.
      throw new DeploymentConflictError(`Deployment job is ${existing.status}, not running`);
    }
    return this.getJobDetail(jobId);
  }

  async drain(): Promise<{ running_runs: number }> {
    return { running_runs: await this.repository.runningRunCount() };
  }

  async sweepLostJobs(now = Date.now()): Promise<number> {
    return this.repository.failStaleJobs({
      running_before: new Date(now - DEPLOYER_LOST_AFTER_MS).toISOString(),
      queued_before: new Date(now - DEPLOYER_UNAVAILABLE_AFTER_MS).toISOString(),
    });
  }

  async updatePending(): Promise<boolean> {
    return this.repository.updatePending();
  }

  /** dev and test build their images from a checkout the deployer does not mount. */
  private updatesSupported(): boolean {
    return this.rainverEnv === "prod";
  }
}
