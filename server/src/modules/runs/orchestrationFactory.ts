import type { ServerConfig } from "../../config";
import { RunOrchestrationService } from "./orchestrationService";
import { RunMaterializationService } from "./materializationService";
import { PgRunRepository } from "./repository";
import { sharedCliProcessRegistry } from "./processRegistry";
import { PgCodePatchCollector, PgRunSandboxManager } from "../projectFolders";
import { PgVerificationEngine } from "./verification";
import type { RuntimeHostLogger } from "../runtimeHost";

/**
 * The one wiring of a fully adaptered `RunOrchestrationService`. This adapter
 * set is the definition of "a Run entrypoint that behaves like every other
 * Run entrypoint" — in particular `processRegistry` is what lets `cancelRun`
 * reach a child process or a managed API AbortController, so an entrypoint
 * assembled by hand with a partial set silently reports successful
 * cancellation of execution it never touched. Every constructor call site
 * outside this file should have a reason it cannot use this.
 */
export function buildRunOrchestration(
  config: ServerConfig,
  extras: { runtimeHostLogger?: RuntimeHostLogger } = {},
): { repository: PgRunRepository; orchestration: RunOrchestrationService; materializer: RunMaterializationService } {
  const repository = PgRunRepository.fromConfig(config);
  const materializer = RunMaterializationService.fromConfig(config);
  const orchestration = new RunOrchestrationService(config, repository, {
    materializer,
    workspaceManager: PgRunSandboxManager.fromConfig(config),
    codePatchCollector: PgCodePatchCollector.fromConfig(config),
    verificationEngine: PgVerificationEngine.fromConfig(config),
    processRegistry: sharedCliProcessRegistry,
    ...(extras.runtimeHostLogger ? { managedApi: { runtimeHostLogger: extras.runtimeHostLogger } } : {}),
  });
  return { repository, orchestration, materializer };
}
