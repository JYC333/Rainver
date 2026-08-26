import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const jobsModule: ServerModule = {
  name: "jobs",
  registerRoutes,
};

export {
  JobHandlerRegistry,
  DuplicateJobHandlerError,
  UnknownJobTypeError,
} from "./handlerRegistry.js";
export { PgJobQueueRepository, type JobRecord, type EnqueueJobInput } from "./repository.js";
export { JobWorker } from "./worker.js";
export { startJobsWorker, buildJobHandlerRegistry, type JobsWorkerHandle } from "./workerRuntime.js";
export { SchedulerRegistry, startSchedulerRegistry, type ScheduledTask } from "../scheduler/registry.js";
export {
  PgSchedulerTaskStore,
  type SchedulerTaskRow,
  type SchedulerTaskScopeType,
  type SchedulerTaskStatus,
  type SchedulerTaskUpsertInput,
} from "../scheduler/taskStore.js";
