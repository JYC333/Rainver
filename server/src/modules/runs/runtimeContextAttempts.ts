import { randomUUID } from "node:crypto";
import type {
  ExecutionControlSnapshot,
  InvocationDelivery,
  InvocationSnapshotSafe,
  RunAdapterResultEnvelope,
  TurnContextRequest,
} from "@rainver/protocol";
import type { RuntimeContextInvocationGatewayPort } from "../runtimeContext/index.js";
import type { RunRecord } from "./repository.js";

export interface RunInvocationAttemptLifecycle {
  prepare(): Promise<InvocationDelivery>;
  acknowledge(delivery: InvocationDelivery, response: RunAdapterResultEnvelope): Promise<InvocationSnapshotSafe>;
  finalize(delivery: InvocationDelivery, errorCode?: string | null): Promise<InvocationSnapshotSafe>;
}

export function createRunInvocationAttemptLifecycle(input: {
  gateway: RuntimeContextInvocationGatewayPort;
  run: RunRecord;
  control: ExecutionControlSnapshot;
  turn: TurnContextRequest;
  model: string | null;
  runtimeSessionBindingRef?: { type: string; id: string; version?: string | null } | null;
}): RunInvocationAttemptLifecycle {
  const viewerUserId = input.run.instructed_by_user_id ?? input.run.owner_user_id;
  if (!viewerUserId) throw new Error("Runtime Context invocation requires an instructing user");
  return {
    prepare: () => input.gateway.prepareInvocation({
      identity: { spaceId: input.run.space_id, userId: viewerUserId },
      turn: input.turn,
      invocationId: input.run.id,
      executionControlSnapshotId: input.control.id,
      runtimeKey: input.run.runtime_key ?? "unknown",
      providerId: input.run.model_provider_id,
      model: input.model,
      usageSourceId: `runtime-context:${input.run.id}:${randomUUID()}`,
      runtimeSessionBindingRef: input.runtimeSessionBindingRef ?? null,
    }),
    acknowledge: (delivery, response) => input.gateway.acknowledgeDelivery({
      spaceId: input.run.space_id,
      deliveryId: delivery.id,
      status: response.success ? "accepted" : "failed",
      // CLI usage aggregates all internal calls (and often multiple ACP turns).
      // It cannot be reconciled as the input size of this one Delivery. The
      // exclusive buckets are retained in the usage ledger instead.
      actualPromptTokens: response.adapter_kind === "local_cli" ? null : response.usage?.input_tokens ?? null,
      adapterReceiptRef: { type: "runtime_attempt", id: delivery.id },
      errorCode: response.error_code ?? null,
    }),
    finalize: (delivery, errorCode) => input.gateway.finalizeInvocation({
      spaceId: input.run.space_id,
      invocationId: input.run.id,
      deliveryId: delivery.id,
      errorCode: errorCode ?? null,
    }),
  };
}
