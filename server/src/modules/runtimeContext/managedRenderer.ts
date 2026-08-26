import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type {
  ExecutionControlSnapshot,
  InvocationDelivery,
  RuntimeContextEnvelope,
} from "@rainver/protocol";
import { contextItemText } from "./itemNormalizer.js";

export const MANAGED_RENDERER_VERSION = "managed-semantic.v1";

export interface ManagedDeliveryRenderInput {
  envelope: RuntimeContextEnvelope;
  control: ExecutionControlSnapshot;
  invocationId: string;
  attempt: number;
  adapterType: string;
  providerId: string | null;
  model: string | null;
  mode?: "full" | "delta";
  usageSourceId: string;
  deliveryId?: string;
  snapshotId?: string;
  cliSession?: InvocationDelivery["cli_session"];
}

export async function renderManagedDelivery(input: ManagedDeliveryRenderInput): Promise<InvocationDelivery> {
  const envelope = protocol.RuntimeContextEnvelopeSchema.parse(input.envelope);
  const control = protocol.ExecutionControlSnapshotSchema.parse(input.control);
  if (envelope.execution_control_snapshot_id !== control.id) {
    throw new Error("Runtime Context envelope does not match the execution control snapshot");
  }
  if (envelope.turn_request.work_context_scope_id !== control.work_context_scope_id) {
    throw new Error("Runtime Context envelope work scope does not match execution controls");
  }
  if (!sameRef(envelope.setup_ref, control.work_context_setup_ref)) {
    throw new Error("Runtime Context envelope setup does not match execution controls");
  }
  if (envelope.setup_ref?.version !== undefined
    && envelope.setup_ref.version !== null
    && envelope.setup_ref.version !== String(envelope.turn_request.expected_setup_version)) {
    throw new Error("Runtime Context envelope setup version does not match the turn request");
  }
  if (control.space_id !== envelope.items[0]?.space_id
    || envelope.items.some((item) => item.space_id !== control.space_id)) {
    throw new Error("Runtime Context Delivery must remain within its control Space");
  }
  if (control.egress.destination_type === "model_provider"
    && (!input.providerId
      || input.providerId !== control.egress.destination_id
      || !control.egress.allowed_provider_ids.includes(input.providerId))) {
    throw new Error("Runtime Context Delivery provider is not authorized by execution controls");
  }
  if (control.egress.destination_type !== "model_provider" && input.providerId !== null) {
    throw new Error("Non-provider Runtime Context Delivery cannot select a model provider");
  }
  if (control.egress.destination_type === "local_cli"
    && control.egress.destination_id !== input.adapterType) {
    throw new Error("Runtime Context Delivery CLI adapter is not authorized by execution controls");
  }
  if (input.model !== null && input.model !== envelope.window_plan.model) {
    throw new Error("Runtime Context Delivery model does not match the planned model");
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Invocation delivery attempt must be a positive integer");
  }
  const decisions = new Map(envelope.window_plan.decisions.map((decision) => [decision.item_id, decision]));
  const accepted = envelope.items.filter((item) => decisions.get(item.id)?.decision !== "blocked");
  const deliveryId = input.deliveryId ?? randomUUID();
  const snapshotId = input.snapshotId ?? randomUUID();
  return {
    id: deliveryId,
    invocation_id: input.invocationId,
    delivery_kind: "agent_task",
    adapter_type: input.adapterType,
    provider_id: input.providerId,
    model: envelope.window_plan.model,
    renderer_version: MANAGED_RENDERER_VERSION,
    mode: input.mode ?? "full",
    planned_items: accepted.map((item) => ({
      item_id: item.id,
      semantic_role: item.semantic_role,
      required: item.selection !== "ranked",
    })),
    message_blocks: [...accepted].sort(compareProviderOrder).map((item) => ({
      semantic_role: item.semantic_role,
      content: renderSemanticContent(item.semantic_role, contextItemText(item)),
      source_item_ids: [item.id],
      ...(input.cliSession
        ? {
            delivery_phase: sameRef(item.source_ref, envelope.turn_request.current_message_ref)
              ? "current_user" as const
              : (input.mode ?? "full") === "full"
                ? "bootstrap_context" as const
                : "context_delta" as const,
          }
        : {}),
    })),
    cli_session: input.cliSession ?? null,
    control_ref: { type: "execution_control_snapshot", id: control.id },
    sandbox_ref: control.sandbox_profile_ref,
    tool_grant_refs: control.tool_grant_refs,
    output_contract_ref: control.output_contract.schema_ref,
    expected_prompt_tokens: envelope.window_plan.planned_prompt_tokens,
    max_output_tokens: envelope.window_plan.reserved_output_tokens,
    snapshot_draft_ref: { type: "invocation_snapshot", id: snapshotId },
    audit_refs: {
      delivery_id: deliveryId,
      invocation_snapshot_id: snapshotId,
      execution_control_snapshot_id: control.id,
      usage_source_id: input.usageSourceId,
    },
  };
}

function compareProviderOrder(
  left: RuntimeContextEnvelope["items"][number],
  right: RuntimeContextEnvelope["items"][number],
): number {
  // Reference material, including conversation continuity, must precede the
  // current user input. Delegated instructions are split into the provider's
  // system channel by managedProviderMessages, so their relative position does
  // not affect the user-message sequence.
  const order = { delegated_instruction: 0, reference_data: 1, user_input: 2 } as const;
  return order[left.semantic_role] - order[right.semantic_role];
}

export interface ManagedProviderMessages {
  system: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ManagedAdapterRequest extends ManagedProviderMessages {
  deliveryId: string;
  invocationId: string;
  providerId: string | null;
  model: string | null;
  expectedPromptTokens: number;
  maxOutputTokens: number | null;
  controlRef: InvocationDelivery["control_ref"];
  sandboxRef: InvocationDelivery["sandbox_ref"];
  toolGrantRefs: InvocationDelivery["tool_grant_refs"];
  outputContractRef: InvocationDelivery["output_contract_ref"];
  snapshotDraftRef: InvocationDelivery["snapshot_draft_ref"];
  auditRefs: InvocationDelivery["audit_refs"];
}

/** Pure provider mapping. Reference data is deliberately always a user-role block. */
export function managedProviderMessages(delivery: InvocationDelivery): ManagedProviderMessages {
  const system: string[] = [];
  const messages: ManagedProviderMessages["messages"] = [];
  for (const block of delivery.message_blocks) {
    if (block.semantic_role === "delegated_instruction") {
      system.push(block.content);
    } else {
      messages.push({ role: "user", content: block.content });
    }
  }
  return { system: system.length ? system.join("\n\n") : null, messages };
}

/** Validate the complete boundary object before deriving a provider request. */
export async function managedAdapterRequest(delivery: unknown): Promise<ManagedAdapterRequest> {
  const accepted = protocol.InvocationDeliverySchema.parse(delivery);
  const rendered = managedProviderMessages(accepted);
  return {
    ...rendered,
    deliveryId: accepted.id,
    invocationId: accepted.invocation_id,
    providerId: accepted.provider_id,
    model: accepted.model,
    expectedPromptTokens: accepted.expected_prompt_tokens,
    maxOutputTokens: accepted.max_output_tokens,
    controlRef: accepted.control_ref,
    sandboxRef: accepted.sandbox_ref,
    toolGrantRefs: accepted.tool_grant_refs,
    outputContractRef: accepted.output_contract_ref,
    snapshotDraftRef: accepted.snapshot_draft_ref,
    auditRefs: accepted.audit_refs,
  };
}

function renderSemanticContent(role: InvocationDelivery["message_blocks"][number]["semantic_role"], text: string): string {
  // Keep the exact planner materialization. Role mapping, rather than prompt
  // text decoration, is the authority boundary and must not add hidden tokens.
  void role;
  return text;
}

function sameRef(
  left: { type: string; id: string; version?: string | null } | null,
  right: { type: string; id: string; version?: string | null } | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.type === right.type
      && left.id === right.id
      && (left.version ?? null) === (right.version ?? null);
}
