export type {
  RuntimeContextDeliveryAcknowledgement,
  RuntimeContextFinalizeInput,
  RuntimeContextGatewayPort,
  RuntimeContextInvocationGatewayPort,
  RuntimeContextInvocationInput,
  RuntimeContextPreviewInput,
} from "./contracts.js";
export {
  MANAGED_CONVERSATION_ENTRYPOINT_INVENTORY,
  RUNTIME_INVOCATION_INVENTORY,
  type ManagedConversationEntrypoint,
  type RuntimeInvocationClass,
  type RuntimeInvocationEntry,
} from "./invocationInventory.js";
export { normalizeContextItem, contextItemText, type ContextItemSource } from "./itemNormalizer.js";
export {
  RetrievalCoordinator,
  type RetrievalContextAuthorizationPort,
  type RetrievalEnginePort,
  type RuntimeContextRetrievalRequest,
} from "./retrievalCoordinator.js";
export {
  RuntimeContextAcquisitionComposition,
  type RuntimeContextAuthorityPort,
  type RuntimeContextAuthoritySnapshot,
  type RuntimeContextChannelProvider,
  type RuntimeContextRetrievalIntentPort,
} from "./acquisitionComposition.js";
export { RuntimeContextPlanner, type RuntimeContextPlanningInput } from "./planner.js";
export {
  RuntimeContextPlanningService,
  type AcquiredRuntimeContext,
  type RuntimeContextAcquisitionPort,
  type RuntimeContextExecutionPlan,
  type RuntimeContextExecutionPlanningRequest,
  type ContextWindowPlanRecorderPort,
  type RuntimeContextPlanningRequest,
} from "./planningService.js";
export { ContextWindowReconciliationRepository } from "./reconciliationRepository.js";
export { createProductionRuntimeContextPlanningService } from "./productionAcquisition.js";
export { ContextWindowPlanner, RuntimeContextPlanningError, type WindowPlannerInput } from "./windowPlanner.js";
export {
  MANAGED_RENDERER_VERSION,
  managedAdapterRequest,
  managedProviderMessages,
  renderManagedDelivery,
  type ManagedDeliveryRenderInput,
  type ManagedAdapterRequest,
  type ManagedProviderMessages,
} from "./managedRenderer.js";
export {
  PgExecutionControlLoader,
  PgInvocationDeliveryAuthorizer,
  RuntimeContextInvocationGateway,
  createProductionRuntimeContextInvocationGateway,
  type ExecutionControlLoaderPort,
  type InvocationSnapshotStorePort,
  type RuntimeContextContinuityPort,
} from "./gateway.js";
export {
  RuntimeContextContinuityService,
  type SemanticCheckpointProviderPort,
} from "./continuity/service.js";
export { ManagedSemanticCheckpointProvider } from "./continuity/semanticExtractor.js";
export {
  RuntimeContextCliContinuityService,
  renderCliEventDelta,
  type CliRotationReason,
  type PreparedCliBinding,
  type PreparedCliDeliveryState,
} from "./continuity/cliContinuity.js";
export { registerRuntimeContextCheckpointHandler, RUNTIME_CONTEXT_CHECKPOINT_JOB } from "./continuity/job.js";
export { loadActiveSemanticCheckpoint, loadConversationContinuityThroughMessage } from "./conversationContinuity.js";
export {
  InvocationSnapshotService,
  SealedPayloadService,
  type InvocationAttemptDraft,
  type InvocationAttemptInput,
  type InvocationDeliveryAuthorizer,
  type SealedPayloadReadAuthorizer,
} from "./invocationSnapshotService.js";
export { SealedPayloadCipher } from "./sealedPayloadCrypto.js";
export { WorkContextService } from "./workContextService.js";
import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const runtimeContextModule: ServerModule = {
  name: "runtime_context",
  registerRoutes,
};
