import type { ServerConfig } from "../../../config.js";
import type { Queryable } from "../../routeUtils/common.js";
import { ProjectResearchOrchestrator } from "../orchestrator.js";

/**
 * Public command boundary for the adaptive research pipeline.
 *
 * Stage behavior belongs to the stage coordinators. This facade deliberately
 * contains no transition, persistence, or provider logic. The internal
 * composition root remains behind this stable pipeline-facing API while its
 * remaining command ownership is extracted by domain.
 */
export class ProjectResearchPipelineService {
  private readonly orchestrator: ProjectResearchOrchestrator;

  constructor(db: Queryable, config: ServerConfig) {
    this.orchestrator = new ProjectResearchOrchestrator(db, config);
  }

  startInitialIntake(...args: Parameters<ProjectResearchOrchestrator["startInitialIntake"]>) {
    return this.orchestrator.startInitialIntake(...args);
  }

  saveInitialIntakeDraft(...args: Parameters<ProjectResearchOrchestrator["saveInitialIntakeDraft"]>) {
    return this.orchestrator.saveInitialIntakeDraft(...args);
  }

  startHistoricalBackfill(...args: Parameters<ProjectResearchOrchestrator["startHistoricalBackfill"]>) {
    return this.orchestrator.startHistoricalBackfill(...args);
  }

  applyQuestionForward(...args: Parameters<ProjectResearchOrchestrator["applyQuestionForward"]>) {
    return this.orchestrator.applyQuestionForward(...args);
  }

  questionChangeImpact(...args: Parameters<ProjectResearchOrchestrator["questionChangeImpact"]>) {
    return this.orchestrator.questionChangeImpact(...args);
  }

  resolveQuestionChange(...args: Parameters<ProjectResearchOrchestrator["resolveQuestionChange"]>) {
    return this.orchestrator.resolveQuestionChange(...args);
  }

  generateReportSnapshot(...args: Parameters<ProjectResearchOrchestrator["generateReportSnapshot"]>) {
    return this.orchestrator.generateReportSnapshot(...args);
  }

  triggerIncremental(...args: Parameters<ProjectResearchOrchestrator["triggerIncremental"]>) {
    return this.orchestrator.triggerIncremental(...args);
  }

  decideCheckpoint(...args: Parameters<ProjectResearchOrchestrator["decideCheckpoint"]>) {
    return this.orchestrator.decideCheckpoint(...args);
  }

  reconcileOperation(...args: Parameters<ProjectResearchOrchestrator["reconcileOperation"]>) {
    return this.orchestrator.reconcileOperation(...args);
  }

  reconcileRun(...args: Parameters<ProjectResearchOrchestrator["reconcileRun"]>) {
    return this.orchestrator.reconcileRun(...args);
  }

  reconcileCompletedRun(...args: Parameters<ProjectResearchOrchestrator["reconcileCompletedRun"]>) {
    return this.orchestrator.reconcileCompletedRun(...args);
  }

  resumeAfterCheckpoint(...args: Parameters<ProjectResearchOrchestrator["resumeAfterCheckpoint"]>) {
    return this.orchestrator.resumeAfterCheckpoint(...args);
  }

  retryFailedOperation(...args: Parameters<ProjectResearchOrchestrator["retryFailedOperation"]>) {
    return this.orchestrator.retryFailedOperation(...args);
  }

  reconcileOperationForUser(...args: Parameters<ProjectResearchOrchestrator["reconcileOperationForUser"]>) {
    return this.orchestrator.reconcileOperationForUser(...args);
  }

  updateInitialItemLimit(...args: Parameters<ProjectResearchOrchestrator["updateInitialItemLimit"]>) {
    return this.orchestrator.updateInitialItemLimit(...args);
  }

  updateItemLimit(...args: Parameters<ProjectResearchOrchestrator["updateItemLimit"]>) {
    return this.orchestrator.updateItemLimit(...args);
  }

  rescanEmptyBackfill(...args: Parameters<ProjectResearchOrchestrator["rescanEmptyBackfill"]>) {
    return this.orchestrator.rescanEmptyBackfill(...args);
  }

  reconcileAll(...args: Parameters<ProjectResearchOrchestrator["reconcileAll"]>) {
    return this.orchestrator.reconcileAll(...args);
  }

  onSourceScanCompleted(...args: Parameters<ProjectResearchOrchestrator["onSourceScanCompleted"]>) {
    return this.orchestrator.onSourceScanCompleted(...args);
  }

  onPostProcessingRecoveryStarted(...args: Parameters<ProjectResearchOrchestrator["onPostProcessingRecoveryStarted"]>) {
    return this.orchestrator.onPostProcessingRecoveryStarted(...args);
  }

  onPostProcessingSucceeded(...args: Parameters<ProjectResearchOrchestrator["onPostProcessingSucceeded"]>) {
    return this.orchestrator.onPostProcessingSucceeded(...args);
  }

  reconcilePostProcessingRun(...args: Parameters<ProjectResearchOrchestrator["reconcilePostProcessingRun"]>) {
    return this.orchestrator.reconcilePostProcessingRun(...args);
  }

  onPostProcessingRecoveryFinished(...args: Parameters<ProjectResearchOrchestrator["onPostProcessingRecoveryFinished"]>) {
    return this.orchestrator.onPostProcessingRecoveryFinished(...args);
  }
}
