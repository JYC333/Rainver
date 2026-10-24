import type {
  ContextEvent,
  DeliveryAcknowledgement,
  InvocationDelivery,
  InvocationSnapshotSafe,
  RuntimeContextEventIngress,
  RuntimeContextEnvelope,
  TurnContextRequest,
} from "@rainver/protocol";

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
  runtimeKey: string;
  providerId?: string | null;
  model?: string | null;
  usageSourceId: string;
  runtimeSessionBindingRef?: { type: string; id: string; version?: string | null } | null;
  rawReplayPayload?: unknown;
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
  finalizeInvocation(input: RuntimeContextFinalizeInput): Promise<InvocationSnapshotSafe>;
}

export interface RuntimeContextGatewayPort extends RuntimeContextInvocationGatewayPort {
  ingestRuntimeEvent(event: RuntimeContextEventIngress): Promise<ContextEvent>;
  recordRuntimeEventGap(event: RuntimeContextEventIngress, detail?: string | null): Promise<void>;
}
