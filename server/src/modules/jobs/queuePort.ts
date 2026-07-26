import type { JobRecord, JobReclaimResult, JobStatus } from "./repository";

export interface JobQueuePort {
  claimNext(
    workerId: string,
    jobTypes: readonly string[] | null,
  ): Promise<JobRecord | null>;
  claimNextAgentRun(workerId: string): Promise<JobRecord | null>;
  startJob(jobId: string, workerId: string | null): Promise<boolean>;
  completeJob(
    jobId: string,
    resultJson: unknown,
    workerId: string | null,
  ): Promise<boolean>;
  failJob(
    jobId: string,
    error: string,
    workerId: string | null,
  ): Promise<JobStatus | null>;
  deferJob?(
    jobId: string,
    error: string,
    workerId: string | null,
    scheduledAt: Date,
  ): Promise<boolean>;
  cancelJob(jobId: string, workerId: string | null): Promise<boolean>;
  touchHeartbeat(jobId: string, workerId: string | null): Promise<boolean>;
  appendJobEvent(input: {
    job_id: string;
    event_type: string;
    message: string;
    data?: unknown;
  }): Promise<unknown>;
  reclaimStuckJobs(stuckAfterSeconds?: number): Promise<JobReclaimResult>;
}
