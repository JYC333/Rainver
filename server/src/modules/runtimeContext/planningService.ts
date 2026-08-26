import type { ContextItem, RuntimeContextEnvelope, TurnContextRequest } from "@agent-space/protocol";
import { RuntimeContextPlanner } from "./planner.js";
import { RuntimeContextPlanningError } from "./windowPlanner.js";
import type { ModelWindowOverride } from "../usage/modelCatalog.js";

export interface RuntimeContextPlanningRequest {
  identity: { userId: string; spaceId: string };
  turn: TurnContextRequest;
}

export interface RuntimeContextExecutionPlanningRequest extends RuntimeContextPlanningRequest {
  invocationId: string;
  deliveryId: string;
}

export interface AcquiredRuntimeContext {
  executionControlSnapshotId: string;
  setupRef: { type: string; id: string; version?: string | null } | null;
  model: string;
  outputReserveTokens?: number | null;
  modelWindowOverride?: ModelWindowOverride | null;
  directItems: ContextItem[];
  explicitItems?: ContextItem[];
  continuityItems?: ContextItem[];
  retrievalItems?: ContextItem[];
}

export interface RuntimeContextAcquisitionPort {
  acquire(
    request: RuntimeContextPlanningRequest,
    mode: "preview" | "execution",
  ): Promise<AcquiredRuntimeContext>;
}

export interface RuntimeContextExecutionPlan {
  envelope: RuntimeContextEnvelope;
  optionalRetrievalDrift: {
    addedSourceRefs: string[];
    removedSourceRefs: string[];
    changedSourceRefs: string[];
  };
}

export interface ContextWindowPlanRecorderPort {
  recordPlan(input: {
    spaceId: string;
    invocationId: string;
    deliveryId: string;
    plan: RuntimeContextEnvelope["window_plan"];
  }): Promise<void>;
  reconcile(input: {
    spaceId: string;
    invocationId: string;
    deliveryId: string;
    actualPromptTokens: number;
  }): Promise<void>;
}

/** Shared preview/execution orchestration. Execution always reacquires live data. */
export class RuntimeContextPlanningService {
  constructor(
    private readonly acquisition: RuntimeContextAcquisitionPort,
    private readonly planRecorder: ContextWindowPlanRecorderPort,
    private readonly planner = new RuntimeContextPlanner(),
  ) {}

  async preview(request: RuntimeContextPlanningRequest): Promise<RuntimeContextEnvelope> {
    return this.plan(request, "preview");
  }

  async prepareExecution(
    request: RuntimeContextExecutionPlanningRequest,
    preview?: RuntimeContextEnvelope | null,
  ): Promise<RuntimeContextExecutionPlan> {
    const prepared = await this.planExecution(request, preview);
    await this.planRecorder.recordPlan({
      spaceId: request.identity.spaceId,
      invocationId: request.invocationId,
      deliveryId: request.deliveryId,
      plan: prepared.envelope.window_plan,
    });
    return prepared;
  }

  /** Plan without persistence so the gateway can commit plan + Delivery atomically. */
  async planExecution(
    request: RuntimeContextExecutionPlanningRequest,
    preview?: RuntimeContextEnvelope | null,
  ): Promise<RuntimeContextExecutionPlan> {
    const envelope = await this.plan(request, "execution");
    const optionalRetrievalDrift = preview
      ? comparePreviewToExecution(preview, envelope)
      : { addedSourceRefs: [], removedSourceRefs: [], changedSourceRefs: [] };
    return { envelope, optionalRetrievalDrift };
  }

  async reconcileActualUsage(input: {
    spaceId: string;
    invocationId: string;
    deliveryId: string;
    actualPromptTokens: number;
  }): Promise<void> {
    await this.planRecorder.reconcile(input);
  }

  private async plan(
    request: RuntimeContextPlanningRequest,
    mode: "preview" | "execution",
  ): Promise<RuntimeContextEnvelope> {
    const acquired = await this.acquisition.acquire(request, mode);
    if (acquired.setupRef?.type !== "work_context_setup"
      || acquired.setupRef.version !== String(request.turn.expected_setup_version)) {
      throw new RuntimeContextPlanningError("invalid_context_item", "Work Context Setup version does not match the turn request");
    }
    for (const item of allItems(acquired)) {
      if (item.space_id !== request.identity.spaceId) {
        throw new RuntimeContextPlanningError("invalid_context_item", "Context acquisition crossed the Space boundary", [item.id]);
      }
      if (item.revalidation.status !== "live" || typeof item.revalidation.checked_at !== "string") {
        throw new RuntimeContextPlanningError("invalid_context_item", `Context item ${item.id} failed live revalidation`, [item.id]);
      }
    }
    return this.planner.plan({ ...acquired, turn: request.turn });
  }
}

function comparePreviewToExecution(
  preview: RuntimeContextEnvelope,
  execution: RuntimeContextEnvelope,
): RuntimeContextExecutionPlan["optionalRetrievalDrift"] {
  if (preview.setup_ref?.id !== execution.setup_ref?.id
    || (preview.setup_ref?.version ?? null) !== (execution.setup_ref?.version ?? null)) {
    throw new RuntimeContextPlanningError("invalid_context_item", "Work Context Setup changed after preview");
  }
  if (preview.execution_control_snapshot_id !== execution.execution_control_snapshot_id
    || stableJson(preview.turn_request) !== stableJson(execution.turn_request)
    || stableJson(nonRetrievalFingerprints(preview.items)) !== stableJson(nonRetrievalFingerprints(execution.items))
    || stableJson(staticWindow(preview)) !== stableJson(staticWindow(execution))) {
    throw new RuntimeContextPlanningError("invalid_context_item", "Non-Retrieval planning state changed after preview");
  }
  const before = retrievalFingerprints(preview.items);
  const after = retrievalFingerprints(execution.items);
  return {
    addedSourceRefs: [...after.keys()].filter((ref) => !before.has(ref)).sort(),
    removedSourceRefs: [...before.keys()].filter((ref) => !after.has(ref)).sort(),
    changedSourceRefs: [...after.keys()].filter((ref) => before.has(ref) && before.get(ref) !== after.get(ref)).sort(),
  };
}

function allItems(acquired: AcquiredRuntimeContext): ContextItem[] {
  return [
    ...acquired.directItems,
    ...(acquired.explicitItems ?? []),
    ...(acquired.continuityItems ?? []),
    ...(acquired.retrievalItems ?? []),
  ];
}

function nonRetrievalFingerprints(items: ContextItem[]): string[] {
  return items.filter((item) => item.acquisition !== "retrieval").map(itemFingerprint).sort();
}

function retrievalFingerprints(items: ContextItem[]): Map<string, string> {
  return new Map(items
    .filter((item) => item.acquisition === "retrieval")
    .map((item) => [refKey(item.source_ref), itemFingerprint(item)] as const));
}

function itemFingerprint(item: ContextItem): string {
  const { checked_at: _checkedAt, ...materialRevalidation } = item.revalidation;
  return stableJson({ ...item, revalidation: materialRevalidation });
}

function refKey(ref: { type: string; id: string; version?: string | null }): string {
  return `${ref.type}:${ref.id}:${ref.version ?? ""}`;
}

function staticWindow(envelope: RuntimeContextEnvelope): Record<string, unknown> {
  const plan = envelope.window_plan;
  return {
    model: plan.model,
    model_catalog_version: plan.model_catalog_version,
    tokenizer_version: plan.tokenizer_version,
    total_window_tokens: plan.total_window_tokens,
    reserved_output_tokens: plan.reserved_output_tokens,
    provider_overhead_tokens: plan.provider_overhead_tokens,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
