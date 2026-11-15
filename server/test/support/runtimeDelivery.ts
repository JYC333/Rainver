import type {InvocationDelivery} from "@rainver/protocol";

/** Deterministic Gateway delivery; no retrieval or inference. */
export function invocationDelivery(prompt = "Say hello"): InvocationDelivery {
  return {
    id: "delivery-1",
    invocation_id: "run-1",
    delivery_kind: "agent_task",
    runtime_key: "codex_cli",
    provider_id: null,
    model: "gpt-4o-mini",
    renderer_version: "acp.v1",
    planned_items: [
      { item_id: "system-item", semantic_role: "delegated_instruction", required: true },
      { item_id: "user-item", semantic_role: "user_input", required: true },
    ],
    message_blocks: [
      { semantic_role: "delegated_instruction", content: "System prompt for agent-from-setup", source_item_ids: ["system-item"] },
      { semantic_role: "user_input", content: prompt, source_item_ids: ["user-item"] },
    ],
    control_ref: { type: "execution_control_snapshot", id: "control-1" },
    sandbox_ref: null,
    tool_grant_refs: [],
    output_contract_ref: null,
    expected_prompt_tokens: 8,
    context_estimate: { instructions: 3, current_input: 5 },
    max_output_tokens: null,
    snapshot_draft_ref: { type: "invocation_snapshot", id: "snapshot-1" },
    audit_refs: {
      delivery_id: "delivery-1",
      invocation_snapshot_id: "snapshot-1",
      execution_control_snapshot_id: "control-1",
      usage_source_id: "usage-delivery-1",
    },
  };
}
