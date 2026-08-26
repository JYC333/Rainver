import type {
  ContextEvent,
  DeliveryAcknowledgement,
  InvocationDelivery,
  InvocationSnapshotSafe,
  RuntimeContextEventIngress,
  RuntimeContextEnvelope,
  TurnContextRequest,
} from "@agent-space/protocol";

export interface RuntimeContextPreviewInput {
  identity: {
    userId: string;
    spaceId: string;
  };
  turn: TurnContextRequest;
}

export interface RuntimeContextInvocationInput extends RuntimeContextPreviewInput {
  invocationId: string;
  executionControlSnapshotId: string;
  adapterType: string;
  providerId?: string | null;
  model?: string | null;
  usageSourceId: string;
  mode?: "full" | "delta";
  runtimeSessionBindingRef?: { type: string; id: string; version?: string | null } | null;
  rawReplayPayload?: unknown;
  cliBinding?: {
    id: string;
    runtime_state_key: string;
    vendor_session_id: string | null;
    cli_known_cursor: number;
    acknowledged_item_ids: string[];
    generation: number;
    rotation_reason: string | null;
  } | null;
}

export interface RuntimeContextDeliveryAcknowledgement {
  spaceId: string;
  deliveryId: string;
  status: DeliveryAcknowledgement["status"];
  actualPromptTokens?: number | null;
  adapterReceiptRef?: { type: string; id: string; version?: string | null } | null;
  errorCode?: string | null;
}

export interface RuntimeContextFinalizeInput {
  spaceId: string;
  invocationId: string;
  deliveryId: string;
  errorCode?: string | null;
}

export interface RuntimeContextInvocationGatewayPort {
  preview(input: RuntimeContextPreviewInput): Promise<RuntimeContextEnvelope>;
  prepareInvocation(input: RuntimeContextInvocationInput): Promise<InvocationDelivery>;
  acknowledgeDelivery(input: RuntimeContextDeliveryAcknowledgement): Promise<InvocationSnapshotSafe>;
  acknowledgeCliContextPhase?(input: { spaceId: string; deliveryId: string; vendorSessionId: string }): Promise<void>;
  finalizeInvocation(input: RuntimeContextFinalizeInput): Promise<InvocationSnapshotSafe>;
}

export interface RuntimeContextGatewayPort extends RuntimeContextInvocationGatewayPort {
  ingestRuntimeEvent(event: RuntimeContextEventIngress): Promise<ContextEvent>;
  recordRuntimeEventGap(event: RuntimeContextEventIngress, detail?: string | null): Promise<void>;
}
