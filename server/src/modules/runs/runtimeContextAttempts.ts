import { randomUUID } from "node:crypto";
import type {
  ExecutionControlSnapshot,
  InvocationDelivery,
  InvocationSnapshotSafe,
  RuntimeHostExecuteResponse,
  TurnContextRequest,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type {
  RuntimeContextInvocationGatewayPort,
  RuntimeContextInvocationInput,
} from "../runtimeContext";
import type { RunRecord } from "./repository";

export interface RunInvocationAttemptLifecycle {
  prepare(): Promise<InvocationDelivery>;
  acknowledge(delivery: InvocationDelivery, response: RuntimeHostExecuteResponse | {
    success: boolean;
    usage?: { input_tokens?: number } | null;
    error_code?: string | null;
  }): Promise<InvocationSnapshotSafe>;
  finalize(delivery: InvocationDelivery, errorCode?: string | null): Promise<InvocationSnapshotSafe>;
  acknowledgeContext?(delivery: InvocationDelivery, vendorSessionId: string): Promise<void>;
}

export function createRunInvocationAttemptLifecycle(input: {
  gateway: RuntimeContextInvocationGatewayPort;
  run: RunRecord;
  control: ExecutionControlSnapshot;
  turn: TurnContextRequest;
  model: string | null;
  runtimeSessionBindingRef?: { type: string; id: string; version?: string | null } | null;
  cliBinding?: RuntimeContextInvocationInput["cliBinding"];
}): RunInvocationAttemptLifecycle {
  const viewerUserId = input.run.instructed_by_user_id ?? input.run.owner_user_id;
  if (!viewerUserId) throw new Error("Runtime Context invocation requires an instructing user");
  return {
    prepare: () => input.gateway.prepareInvocation({
      identity: { spaceId: input.run.space_id, userId: viewerUserId },
      turn: input.turn,
      invocationId: input.run.id,
      executionControlSnapshotId: input.control.id,
      adapterType: input.run.adapter_type ?? "unknown",
      providerId: input.run.model_provider_id,
      model: input.model,
      usageSourceId: `runtime-context:${input.run.id}:${randomUUID()}`,
      runtimeSessionBindingRef: input.runtimeSessionBindingRef ?? null,
      cliBinding: input.cliBinding ?? null,
    }),
    acknowledge: (delivery, response) => input.gateway.acknowledgeDelivery({
      spaceId: input.run.space_id,
      deliveryId: delivery.id,
      status: response.success ? "accepted" : "failed",
      actualPromptTokens: response.usage?.input_tokens ?? null,
      adapterReceiptRef: { type: "runtime_attempt", id: delivery.id },
      errorCode: response.error_code ?? null,
    }),
    acknowledgeContext: (delivery, vendorSessionId) => {
      if (!input.gateway.acknowledgeCliContextPhase) {
        throw new Error("CLI context-phase acknowledgement is unavailable");
      }
      return input.gateway.acknowledgeCliContextPhase({
        spaceId: input.run.space_id,
        deliveryId: delivery.id,
        vendorSessionId,
      });
    },
    finalize: (delivery, errorCode) => input.gateway.finalizeInvocation({
      spaceId: input.run.space_id,
      invocationId: input.run.id,
      deliveryId: delivery.id,
      errorCode: errorCode ?? null,
    }),
  };
}
