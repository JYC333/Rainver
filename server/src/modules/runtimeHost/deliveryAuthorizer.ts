import { createHash } from "node:crypto";
import type { RuntimeHostExecuteRequest } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common";

interface DeliveryAuthorizationRow {
  delivery_metadata_json: unknown;
  snapshot_status: string;
  safe_snapshot_json: unknown;
}

interface StoredMessageBinding {
  role: "user" | "assistant";
  content_hash: string;
}

interface StoredRuntimeHostBinding {
  model: string | null;
  provider_id: string | null;
  system_prompt_hash: string;
  prompt_hash: string;
  messages: StoredMessageBinding[];
}

/** Validate the immutable Delivery and atomically claim it for one Runtime Host request. */
export async function authorizeRuntimeHostDelivery(
  db: Queryable,
  input: RuntimeHostExecuteRequest,
): Promise<void> {
  const refs = input.invocation_audit_refs;
  if (!refs) throw new HttpError(409, "Runtime Host execution requires Invocation Delivery audit references");
  await withQueryableTransaction(db, async (transaction) => {
    const result = await transaction.query<DeliveryAuthorizationRow>(
      `SELECT delivery.delivery_metadata_json,
              snapshot.status AS snapshot_status,
              snapshot.safe_snapshot_json
         FROM invocation_deliveries delivery
         JOIN invocation_snapshots snapshot
           ON snapshot.delivery_id=delivery.id AND snapshot.space_id=delivery.space_id
         JOIN execution_control_snapshots control_row
           ON control_row.id=delivery.execution_control_snapshot_id AND control_row.space_id=delivery.space_id
        WHERE delivery.space_id=$1 AND delivery.id=$2 AND delivery.invocation_id=$3
          AND snapshot.id=$4 AND control_row.id=$5
          AND delivery.provider_id IS NOT DISTINCT FROM $6
        FOR UPDATE OF snapshot`,
      [input.space_id, refs.delivery_id, input.run_id, refs.invocation_snapshot_id,
        refs.execution_control_snapshot_id, input.model_provider_id],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(409, "Runtime Host Invocation Delivery is missing or does not match the request");
    const metadata = recordValue(row.delivery_metadata_json);
    const auditRefs = recordValue(metadata.audit_refs);
    if (auditRefs.delivery_id !== refs.delivery_id
      || auditRefs.invocation_snapshot_id !== refs.invocation_snapshot_id
      || auditRefs.execution_control_snapshot_id !== refs.execution_control_snapshot_id
      || auditRefs.usage_source_id !== refs.usage_source_id) {
      throw new HttpError(409, "Runtime Host Invocation Delivery audit references do not match persisted authority");
    }
    if (row.snapshot_status !== "draft" || recordValue(row.safe_snapshot_json).dispatch) {
      throw new HttpError(409, "Runtime Host Invocation Delivery has already been dispatched");
    }
    assertStoredRequestBinding(metadata.runtime_host_binding, input);
    const expectedFingerprint = recordValue(recordValue(row.safe_snapshot_json).dispatch_binding).request_fingerprint;
    const requestFingerprint = hashValue(input);
    if (expectedFingerprint !== requestFingerprint) {
      throw new HttpError(409, "Runtime Host request differs from the adapter-bound dispatch");
    }
    const dispatch = {
      request_fingerprint: requestFingerprint,
      dispatched_at: new Date().toISOString(),
    };
    const updated = await transaction.query(
      `UPDATE invocation_snapshots
          SET safe_snapshot_json=safe_snapshot_json || $3::jsonb,updated_at=$4
        WHERE space_id=$1 AND id=$2 AND status='draft'
          AND NOT (safe_snapshot_json ? 'dispatch')
        RETURNING id`,
      [input.space_id, refs.invocation_snapshot_id, JSON.stringify({ dispatch }), dispatch.dispatched_at],
    );
    if (!updated.rows[0]) throw new HttpError(409, "Runtime Host Invocation Delivery was concurrently dispatched");
  });
}

/** Persist the trusted adapter's complete request fingerprint before any transport can claim it. */
export async function bindRuntimeHostDeliveryRequest(
  db: Queryable,
  input: RuntimeHostExecuteRequest,
): Promise<void> {
  const refs = input.invocation_audit_refs;
  if (!refs) throw new HttpError(409, "Runtime Host execution requires Invocation Delivery audit references");
  await withQueryableTransaction(db, async (transaction) => {
    const result = await transaction.query<DeliveryAuthorizationRow>(
      `SELECT delivery.delivery_metadata_json,
              snapshot.status AS snapshot_status,
              snapshot.safe_snapshot_json
         FROM invocation_deliveries delivery
         JOIN invocation_snapshots snapshot
           ON snapshot.delivery_id=delivery.id AND snapshot.space_id=delivery.space_id
         JOIN execution_control_snapshots control_row
           ON control_row.id=delivery.execution_control_snapshot_id AND control_row.space_id=delivery.space_id
        WHERE delivery.space_id=$1 AND delivery.id=$2 AND delivery.invocation_id=$3
          AND snapshot.id=$4 AND control_row.id=$5
          AND delivery.provider_id IS NOT DISTINCT FROM $6
        FOR UPDATE OF snapshot`,
      [input.space_id, refs.delivery_id, input.run_id, refs.invocation_snapshot_id,
        refs.execution_control_snapshot_id, input.model_provider_id],
    );
    const row = result.rows[0];
    if (!row || row.snapshot_status !== "draft") {
      throw new HttpError(409, "Runtime Host Invocation Delivery is unavailable for dispatch binding");
    }
    const metadata = recordValue(row.delivery_metadata_json);
    const auditRefs = recordValue(metadata.audit_refs);
    if (auditRefs.delivery_id !== refs.delivery_id
      || auditRefs.invocation_snapshot_id !== refs.invocation_snapshot_id
      || auditRefs.execution_control_snapshot_id !== refs.execution_control_snapshot_id
      || auditRefs.usage_source_id !== refs.usage_source_id) {
      throw new HttpError(409, "Runtime Host Invocation Delivery audit references do not match persisted authority");
    }
    assertStoredRequestBinding(metadata.runtime_host_binding, input);
    const snapshot = recordValue(row.safe_snapshot_json);
    if (snapshot.dispatch) throw new HttpError(409, "Runtime Host Invocation Delivery has already been dispatched");
    const requestFingerprint = hashValue(input);
    const existing = recordValue(snapshot.dispatch_binding).request_fingerprint;
    if (existing && existing !== requestFingerprint) {
      throw new HttpError(409, "Runtime Host Invocation Delivery already has a different dispatch binding");
    }
    if (existing === requestFingerprint) return;
    const boundAt = new Date().toISOString();
    const updated = await transaction.query(
      `UPDATE invocation_snapshots
          SET safe_snapshot_json=safe_snapshot_json || $3::jsonb,updated_at=$4
        WHERE space_id=$1 AND id=$2 AND status='draft'
          AND NOT (safe_snapshot_json ? 'dispatch')
          AND NOT (safe_snapshot_json ? 'dispatch_binding')
        RETURNING id`,
      [input.space_id, refs.invocation_snapshot_id, JSON.stringify({
        dispatch_binding: { request_fingerprint: requestFingerprint, bound_at: boundAt },
      }), boundAt],
    );
    if (!updated.rows[0]) throw new HttpError(409, "Runtime Host Invocation Delivery was concurrently bound");
  });
}

function assertStoredRequestBinding(raw: unknown, input: RuntimeHostExecuteRequest): void {
  const binding = parseBinding(raw);
  if (binding.provider_id !== input.model_provider_id || binding.model !== (input.model ?? null)) {
    throw new HttpError(409, "Runtime Host provider or model differs from the accepted Delivery");
  }
  if (binding.system_prompt_hash !== hashValue(input.system_prompt ?? null)
    || binding.prompt_hash !== hashValue(input.prompt)) {
    throw new HttpError(409, "Runtime Host prompt differs from the accepted Delivery");
  }
  const messages = input.messages?.length
    ? input.messages
    : [{ role: "user" as const, content: input.prompt }];
  if (messages.length < binding.messages.length) {
    throw new HttpError(409, "Runtime Host messages omit accepted Delivery content");
  }
  for (const [index, expected] of binding.messages.entries()) {
    const actual = messages[index];
    if (!actual || actual.role !== expected.role || hashValue(actual.content ?? "") !== expected.content_hash) {
      throw new HttpError(409, "Runtime Host messages differ from the accepted Delivery");
    }
  }
  if (!validToolLoopSuffix(messages.slice(binding.messages.length))) {
    throw new HttpError(409, "Runtime Host messages contain content outside the accepted Delivery and tool-loop suffix");
  }
}

function validToolLoopSuffix(messages: RuntimeHostExecuteRequest["messages"] extends Array<infer T> | undefined ? T[] : never): boolean {
  if (messages.length === 0) return true;
  let index = 0;
  while (index < messages.length) {
    const assistant = messages[index];
    if (assistant?.role !== "assistant" || !assistant.tool_calls?.length) return false;
    const callIds = new Set(assistant.tool_calls.map((call) => call.id));
    if (callIds.size !== assistant.tool_calls.length) return false;
    index += 1;
    const consumedIds = new Set<string>();
    while (index < messages.length && messages[index]?.role === "tool") {
      const tool = messages[index]!;
      if (!tool.tool_call_id || !callIds.has(tool.tool_call_id) || consumedIds.has(tool.tool_call_id)) return false;
      consumedIds.add(tool.tool_call_id);
      index += 1;
    }
    if (consumedIds.size !== callIds.size) return false;
  }
  return true;
}

function parseBinding(value: unknown): StoredRuntimeHostBinding {
  const binding = recordValue(value);
  const messages = Array.isArray(binding.messages) ? binding.messages : null;
  if ((binding.model !== null && typeof binding.model !== "string")
    || (binding.provider_id !== null && typeof binding.provider_id !== "string")
    || typeof binding.system_prompt_hash !== "string"
    || typeof binding.prompt_hash !== "string"
    || !messages) {
    throw new HttpError(409, "Runtime Host Invocation Delivery binding is invalid");
  }
  return {
    model: binding.model as string | null,
    provider_id: binding.provider_id as string | null,
    system_prompt_hash: binding.system_prompt_hash,
    prompt_hash: binding.prompt_hash,
    messages: messages.map((message) => {
      const row = recordValue(message);
      if ((row.role !== "user" && row.role !== "assistant") || typeof row.content_hash !== "string") {
        throw new HttpError(409, "Runtime Host Invocation Delivery message binding is invalid");
      }
      return { role: row.role, content_hash: row.content_hash };
    }),
  };
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
