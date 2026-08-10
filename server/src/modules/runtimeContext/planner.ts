import { randomUUID } from "node:crypto";
import type {
  ContextItem,
  RuntimeContextEnvelope,
  TurnContextRequest,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { ContextWindowPlanner } from "./windowPlanner";
import type { ModelWindowOverride } from "../usage/modelCatalog";

export interface RuntimeContextPlanningInput {
  executionControlSnapshotId: string;
  setupRef: { type: string; id: string; version?: string | null } | null;
  turn: TurnContextRequest;
  model: string;
  outputReserveTokens?: number | null;
  modelWindowOverride?: ModelWindowOverride | null;
  directItems: ContextItem[];
  explicitItems?: ContextItem[];
  continuityItems?: ContextItem[];
  retrievalItems?: ContextItem[];
}

export class RuntimeContextPlanner {
  constructor(private readonly windowPlanner = new ContextWindowPlanner()) {}

  plan(input: RuntimeContextPlanningInput): RuntimeContextEnvelope {
    const allItems = [
      ...input.directItems,
      ...(input.explicitItems ?? []),
      ...(input.continuityItems ?? []),
      ...(input.retrievalItems ?? []),
    ];
    const currentRef = input.turn.current_message_ref;
    const current = allItems.find((item) =>
      item.source_ref.type === currentRef.type
      && item.source_ref.id === currentRef.id
      && (item.source_ref.version ?? null) === (currentRef.version ?? null));
    const planned = this.windowPlanner.plan({
      model: input.model,
      items: allItems,
      currentMessageItemId: current?.id ?? "missing-current-message",
      outputReserveTokens: input.outputReserveTokens,
      modelWindowOverride: input.modelWindowOverride,
    });
    return {
      id: randomUUID(),
      execution_control_snapshot_id: input.executionControlSnapshotId,
      setup_ref: input.setupRef,
      turn_request: input.turn,
      items: planned.items,
      source_trace: planned.items.map((item) => item.source_ref),
      window_plan: planned.windowPlan,
    };
  }
}
