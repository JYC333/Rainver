export type {
  RuntimeContextDeliveryAcknowledgement,
  RuntimeContextFinalizeInput,
  RuntimeContextGatewayPort,
  RuntimeContextInvocationGatewayPort,
  RuntimeContextInvocationInput,
  RuntimeContextPreviewInput,
} from "./contracts";
export {
  MANAGED_CONVERSATION_ENTRYPOINT_INVENTORY,
  RUNTIME_INVOCATION_INVENTORY,
  type ManagedConversationEntrypoint,
  type RuntimeInvocationClass,
  type RuntimeInvocationEntry,
} from "./invocationInventory";
export { normalizeContextItem, contextItemText, type ContextItemSource } from "./itemNormalizer";
export {
  RetrievalCoordinator,
  type RetrievalContextAuthorizationPort,
  type RetrievalEnginePort,
  type RuntimeContextRetrievalRequest,
} from "./retrievalCoordinator";
export {
  RuntimeContextAcquisitionComposition,
  type RuntimeContextAuthorityPort,
  type RuntimeContextAuthoritySnapshot,
  type RuntimeContextChannelProvider,
  type RuntimeContextRetrievalIntentPort,
} from "./acquisitionComposition";
export { RuntimeContextPlanner, type RuntimeContextPlanningInput } from "./planner";
export {
  RuntimeContextPlanningService,
  type AcquiredRuntimeContext,
  type RuntimeContextAcquisitionPort,
  type RuntimeContextExecutionPlan,
  type RuntimeContextExecutionPlanningRequest,
  type ContextWindowPlanRecorderPort,
  type RuntimeContextPlanningRequest,
} from "./planningService";
export { ContextWindowReconciliationRepository } from "./reconciliationRepository";
export { createProductionRuntimeContextPlanningService } from "./productionAcquisition";
export { ContextWindowPlanner, RuntimeContextPlanningError, type WindowPlannerInput } from "./windowPlanner";
export {
  MANAGED_RENDERER_VERSION,
  managedAdapterRequest,
  managedProviderMessages,
  renderManagedDelivery,
  type ManagedDeliveryRenderInput,
  type ManagedAdapterRequest,
  type ManagedProviderMessages,
} from "./managedRenderer";
export {
  PgExecutionControlLoader,
  PgInvocationDeliveryAuthorizer,
  RuntimeContextInvocationGateway,
  createProductionRuntimeContextInvocationGateway,
  type ExecutionControlLoaderPort,
  type InvocationSnapshotStorePort,
  type RuntimeContextContinuityPort,
} from "./gateway";
export {
  RuntimeContextContinuityService,
  type SemanticCheckpointProviderPort,
} from "./continuity/service";
export { ManagedSemanticCheckpointProvider } from "./continuity/semanticExtractor";
export {
  RuntimeContextCliContinuityService,
  renderCliEventDelta,
  type CliRotationReason,
  type PreparedCliBinding,
  type PreparedCliDeliveryState,
} from "./continuity/cliContinuity";
export { registerRuntimeContextCheckpointHandler, RUNTIME_CONTEXT_CHECKPOINT_JOB } from "./continuity/job";
export { loadActiveSemanticCheckpoint, loadConversationContinuityThroughMessage } from "./conversationContinuity";
export {
  InvocationSnapshotService,
  SealedPayloadService,
  type InvocationAttemptDraft,
  type InvocationAttemptInput,
  type InvocationDeliveryAuthorizer,
  type SealedPayloadReadAuthorizer,
} from "./invocationSnapshotService";
export { SealedPayloadCipher } from "./sealedPayloadCrypto";
export { WorkContextService } from "./workContextService";
import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const runtimeContextModule: ServerModule = {
  name: "runtime_context",
  registerRoutes,
};
