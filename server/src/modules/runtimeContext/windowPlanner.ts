import type {
  ContextItem,
  ContextWindowAllocations,
  ContextWindowDecision,
  ContextWindowPlan,
} from "@rainver/protocol";
import {
  estimateModelTokens,
  resolveModelWindow,
  trimTextToModelTokens,
  type ModelWindowOverride,
} from "../usage/modelCatalog.js";
import { contextItemText } from "./itemNormalizer.js";

export class RuntimeContextPlanningError extends Error {
  constructor(
    readonly code: "required_context_overflow" | "instruction_conflict" | "invalid_context_item",
    message: string,
    readonly itemIds: string[] = [],
  ) {
    super(message);
  }
}

export interface WindowPlannerInput {
  model: string;
  items: ContextItem[];
  currentMessageItemId: string;
  outputReserveTokens?: number | null;
  modelWindowOverride?: ModelWindowOverride | null;
}

export class ContextWindowPlanner {
  plan(input: WindowPlannerInput): { items: ContextItem[]; windowPlan: ContextWindowPlan } {
    const conflicts = resolveTypedConflicts(input.items);
    const items = conflicts.items;
    assertItems(items, input.currentMessageItemId);
    const spec = resolveModelWindow(input.model, input.modelWindowOverride);
    const reserve = input.outputReserveTokens ?? spec.defaultOutputReserveTokens;
    if (!Number.isInteger(reserve) || reserve < 0) {
      throw new RuntimeContextPlanningError("invalid_context_item", "Output reserve must be a non-negative integer");
    }
    const available = spec.contextWindowTokens - reserve - spec.providerOverheadTokens;
    if (available < 0) {
      throw new RuntimeContextPlanningError("required_context_overflow", "Output reserve exceeds the model context window");
    }
    const ordered = [...items].sort(compareItems);
    const mandatoryTokens = ordered
      .filter((item) => item.selection !== "ranked" && !conflicts.suppressed.has(item.id))
      .reduce((total, item) => total + item.token_estimate, 0);
    if (mandatoryTokens > available) {
      throw new RuntimeContextPlanningError(
        "required_context_overflow",
        `Required and pinned context needs ${mandatoryTokens} tokens but only ${available} are available`
        + ` (model ${spec.model}: ${spec.contextWindowTokens}-token window, ${reserve} reserved for output,`
        + ` ${spec.providerOverheadTokens} provider overhead)`,
        ordered.filter((item) => item.selection !== "ranked" && !conflicts.suppressed.has(item.id)).map((item) => item.id),
      );
    }

    let remaining = available;
    const decisions: ContextWindowDecision[] = [];
    const allocations: ContextWindowAllocations = {};
    const deliveredItems: ContextItem[] = [];
    for (const originalItem of ordered) {
      let item = originalItem;
      if (conflicts.suppressed.has(item.id)) {
        decisions.push({ item_id: item.id, decision: "blocked", reason: "typed_conflict_lower_authority", planned_tokens: 0 });
        deliveredItems.push(item);
        continue;
      }
      let plannedTokens = item.token_estimate;
      let decision: ContextWindowDecision["decision"] = "included";
      let reason = item.selection === "ranked" ? "ranked_item_fits" : `${item.selection}_item_reserved`;
      if (item.selection === "ranked" && plannedTokens > remaining) {
        if (remaining > 0) {
          const text = trimTextToModelTokens(contextItemText(item), remaining);
          plannedTokens = estimateModelTokens(text);
          if (plannedTokens === 0) {
            decision = "blocked";
            reason = "ranked_item_cannot_materialize_within_window";
          } else {
            item = {
              ...item,
              payload: { ...item.payload, text, trimmed_from_tokens: item.token_estimate },
              token_estimate: plannedTokens,
            };
            decision = "trimmed";
            reason = "ranked_item_trimmed_to_window";
          }
        } else {
          plannedTokens = 0;
          decision = "blocked";
          reason = "ranked_item_outside_window";
        }
      }
      decisions.push({ item_id: item.id, decision, reason, planned_tokens: plannedTokens });
      deliveredItems.push(item);
      remaining -= decision === "blocked" ? 0 : plannedTokens;
      const bucket = allocationBucket(item, input.currentMessageItemId);
      allocations[bucket] = (allocations[bucket] ?? 0) + (decision === "blocked" ? 0 : plannedTokens);
    }
    const plannedPromptTokens = available - remaining;
    return {
      items: deliveredItems,
      windowPlan: {
        model: spec.model,
        model_catalog_version: spec.catalogVersion,
        tokenizer_version: spec.tokenizerVersion,
        total_window_tokens: spec.contextWindowTokens,
        reserved_output_tokens: reserve,
        provider_overhead_tokens: spec.providerOverheadTokens,
        planned_prompt_tokens: plannedPromptTokens,
        allocations,
        decisions,
        overflow_blockers: [],
      },
    };
  }
}

function resolveTypedConflicts(items: ContextItem[]): { items: ContextItem[]; suppressed: Set<string> } {
  const result: ContextItem[] = [];
  const suppressed = new Set<string>();
  const groups = new Map<string, ContextItem[]>();
  for (const item of items) {
    if (!item.conflict_key) result.push(item);
    else groups.set(item.conflict_key, [...(groups.get(item.conflict_key) ?? []), item]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]!);
      continue;
    }
    const ordered = [...group].sort(compareAuthority);
    const mandatory = ordered.filter((item) => item.selection !== "ranked");
    if (mandatory.length > 1) {
      throw new RuntimeContextPlanningError(
        "instruction_conflict",
        `Conflicting mandatory context for ${mandatory[0]!.conflict_key}`,
        mandatory.map((item) => item.id),
      );
    }
    const winner = mandatory[0] ?? ordered[0]!;
    result.push(...ordered);
    for (const item of ordered) if (item.id !== winner.id) suppressed.add(item.id);
  }
  return { items: result, suppressed };
}

function assertItems(items: ContextItem[], currentMessageItemId: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new RuntimeContextPlanningError("invalid_context_item", `Duplicate context item ${item.id}`, [item.id]);
    ids.add(item.id);
    if (!item.egress_eligible) throw new RuntimeContextPlanningError("invalid_context_item", `Context item ${item.id} is not egress eligible`, [item.id]);
    if (item.revalidation.status !== "live" || typeof item.revalidation.checked_at !== "string") {
      throw new RuntimeContextPlanningError("invalid_context_item", `Context item ${item.id} lacks affirmative live revalidation`, [item.id]);
    }
    const rendererText = item.payload.text;
    if (item.selection !== "ranked"
      && (typeof rendererText !== "string" || rendererText.trim().length === 0)) {
      throw new RuntimeContextPlanningError("invalid_context_item", `Mandatory context item ${item.id} is empty`, [item.id]);
    }
  }
  const current = items.find((item) => item.id === currentMessageItemId);
  if (!current || current.acquisition !== "direct" || current.selection !== "required" || current.semantic_role !== "user_input") {
    throw new RuntimeContextPlanningError("invalid_context_item", "Current message must be a direct required user_input", [currentMessageItemId]);
  }
}

function compareItems(left: ContextItem, right: ContextItem): number {
  const selection = { required: 0, pinned: 1, ranked: 2 } as const;
  const semantic = { delegated_instruction: 0, user_input: 1, reference_data: 2 } as const;
  return selection[left.selection] - selection[right.selection]
    || semantic[left.semantic_role] - semantic[right.semantic_role]
    || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id);
}

function compareAuthority(left: ContextItem, right: ContextItem): number {
  const trust = { system_approved: 0, domain_approved: 1, user_confirmed: 2, derived: 3, external_untrusted: 4 } as const;
  return trust[left.trust] - trust[right.trust] || compareItems(left, right);
}

function allocationBucket(item: ContextItem, currentMessageItemId: string): keyof ContextWindowAllocations {
  if (item.id === currentMessageItemId) return "current_input";
  if (item.semantic_role === "delegated_instruction") return "instructions";
  if (item.acquisition === "continuity" || item.acquisition === "runtime_event") return "checkpoint_tail";
  if (item.acquisition === "retrieval") return "retrieval";
  if (item.acquisition === "explicit") return "attachments";
  return "history";
}
