import type { ContextItem } from "@agent-space/protocol";
import type { ModelWindowOverride } from "../usage/modelCatalog.js";
import type { ExecutionControlSnapshot } from "@agent-space/protocol";
import type {
  AcquiredRuntimeContext,
  RuntimeContextAcquisitionPort,
  RuntimeContextPlanningRequest,
} from "./planningService.js";
import { RetrievalCoordinator, type RuntimeContextRetrievalRequest } from "./retrievalCoordinator.js";
import type { RetrievalEgressDestination } from "../retrieval/egress/egressPolicy.js";

export interface RuntimeContextAuthoritySnapshot {
  executionControlSnapshotId: string;
  setupRef: { type: "work_context_setup"; id: string; version: string };
  model: string;
  outputReserveTokens?: number | null;
  modelWindowOverride?: ModelWindowOverride | null;
  agentId: string;
  projectId: string | null;
  controlSnapshot: ExecutionControlSnapshot;
  egressDestination: RetrievalEgressDestination | "internal_process";
}

export interface RuntimeContextAuthorityPort {
  resolve(
    request: RuntimeContextPlanningRequest,
    mode: "preview" | "execution",
  ): Promise<RuntimeContextAuthoritySnapshot>;
}

export interface RuntimeContextChannelProvider {
  acquire(
    request: RuntimeContextPlanningRequest,
    authority: RuntimeContextAuthoritySnapshot,
    mode: "preview" | "execution",
  ): Promise<ContextItem[]>;
}

export interface RuntimeContextRetrievalIntentPort {
  resolve(
    request: RuntimeContextPlanningRequest,
    authority: RuntimeContextAuthoritySnapshot,
    mode: "preview" | "execution",
  ): Promise<RuntimeContextRetrievalRequest | null>;
}

/**
 * Production acquisition composition used by the gateway cutover. Each owning
 * domain remains responsible for its own authorization and version lookup;
 * this class only coordinates the four typed acquisition channels.
 */
export class RuntimeContextAcquisitionComposition implements RuntimeContextAcquisitionPort {
  constructor(
    private readonly authority: RuntimeContextAuthorityPort,
    private readonly direct: RuntimeContextChannelProvider,
    private readonly explicit: RuntimeContextChannelProvider,
    private readonly continuity: RuntimeContextChannelProvider,
    private readonly retrievalIntent: RuntimeContextRetrievalIntentPort,
    private readonly retrieval: RetrievalCoordinator,
  ) {}

  async acquire(
    request: RuntimeContextPlanningRequest,
    mode: "preview" | "execution",
  ): Promise<AcquiredRuntimeContext> {
    const authority = await this.authority.resolve(request, mode);
    const [directItems, explicitItems, continuityItems, retrievalRequest] = await Promise.all([
      this.direct.acquire(request, authority, mode),
      this.explicit.acquire(request, authority, mode),
      this.continuity.acquire(request, authority, mode),
      this.retrievalIntent.resolve(request, authority, mode),
    ]);
    const retrievalItems = retrievalRequest
      ? (await this.retrieval.retrieve(retrievalRequest)).items
      : [];
    return {
      ...authority,
      directItems,
      explicitItems,
      continuityItems,
      retrievalItems,
    };
  }
}
