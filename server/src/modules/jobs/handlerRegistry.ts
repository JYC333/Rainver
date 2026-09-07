export type JobHandlerResult = Record<string, unknown> | null | undefined;

export interface JobEnvelopeForHandler {
  job_id: string;
  space_id: string;
  user_id: string | null;
  job_type: string;
  attempts: number;
  max_attempts: number;
  worker_id: string;
  payload: Record<string, unknown>;
}

export type JobHandler = (job: JobEnvelopeForHandler) => Promise<JobHandlerResult>;

export class JobDeferredError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "JobDeferredError";
  }
}

export class DuplicateJobHandlerError extends Error {
  constructor(readonly jobType: string) {
    super(`a handler is already registered for job type ${JSON.stringify(jobType)}`);
    this.name = "DuplicateJobHandlerError";
  }
}

export class UnknownJobTypeError extends Error {
  constructor(readonly jobType: string) {
    super(`no handler registered for job type ${JSON.stringify(jobType)}`);
    this.name = "UnknownJobTypeError";
  }
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(jobType: string, handler: JobHandler): void {
    if (!jobType || typeof jobType !== "string") {
      throw new Error("job_type must be a non-empty string");
    }
    if (typeof handler !== "function") {
      throw new TypeError(`handler for job type ${JSON.stringify(jobType)} must be callable`);
    }
    if (this.handlers.has(jobType)) {
      throw new DuplicateJobHandlerError(jobType);
    }
    this.handlers.set(jobType, handler);
  }

  get(jobType: string): JobHandler | undefined {
    return this.handlers.get(jobType);
  }

  /**
   * Replace a registered handler with one built from it. The seam exists so a
   * cross-cutting admission rule (an instance update draining unattended work)
   * lives in one declarative place instead of being repeated inside each
   * domain's handler.
   */
  wrap(jobType: string, wrapper: (handler: JobHandler) => JobHandler): void {
    const handler = this.handlers.get(jobType);
    if (!handler) throw new UnknownJobTypeError(jobType);
    this.handlers.set(jobType, wrapper(handler));
  }

  registeredJobTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async dispatch(job: JobEnvelopeForHandler): Promise<JobHandlerResult> {
    const handler = this.handlers.get(job.job_type);
    if (!handler) throw new UnknownJobTypeError(job.job_type);
    return handler(job);
  }
}
