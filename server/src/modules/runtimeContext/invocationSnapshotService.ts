import { createHash, randomUUID } from "node:crypto";
import type {
  DeliveryAcknowledgement,
  ExecutionControlSnapshot,
  InvocationDelivery,
  InvocationSnapshotSafe,
  RuntimeContextEnvelope,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { Queryable } from "../routeUtils/common";
import { HttpError, withQueryableTransaction } from "../routeUtils/common";
import { loadProtocol } from "../providers/protocolRuntime";
import { managedProviderMessages, renderManagedDelivery } from "./managedRenderer";
import { ContextWindowReconciliationRepository } from "./reconciliationRepository";
import { SealedPayloadCipher } from "./sealedPayloadCrypto";
import type { RuntimeContextContinuityService } from "./continuity/service";
import type { RuntimeContextCliContinuityService } from "./continuity/cliContinuity";
import { persistRunContextTaint } from "../runs/contextTaint";
import type { ContentVisibility } from "../access/contentAccessTypes";

export interface InvocationAttemptInput {
  spaceId: string;
  invocationId: string;
  envelope: RuntimeContextEnvelope;
  control: ExecutionControlSnapshot;
  adapterType: string;
  providerId: string | null;
  model: string | null;
  usageSourceId: string;
  mode?: "full" | "delta";
  runtimeSessionBindingRef?: { type: string; id: string; version?: string | null } | null;
  rawReplayPayload?: unknown;
  viewerUserId?: string;
  requireLiveAuthorization?: boolean;
  deliveryId?: string;
  snapshotId?: string;
  cliSession?: InvocationDelivery["cli_session"];
}

export interface InvocationAttemptDraft {
  delivery: InvocationDelivery;
  snapshot: InvocationSnapshotSafe;
}

export interface InvocationDeliveryAuthorizer {
  /** Revalidate and lock mutable delivery authorities through the attempt transaction. */
  authorize(db: Queryable, input: InvocationAttemptInput, control: ExecutionControlSnapshot): Promise<void>;
}

export class InvocationSnapshotService {
  constructor(
    private readonly db: Queryable,
    private readonly sealedCipher?: SealedPayloadCipher,
    private readonly deliveryAuthorizer?: InvocationDeliveryAuthorizer,
    private readonly continuity?: Pick<RuntimeContextContinuityService, "finalizeInvocationInTransaction">,
    private readonly cliContinuity?: Pick<RuntimeContextCliContinuityService, "acknowledgeDeliveryInTransaction">,
  ) {}

  async createAttempt(input: InvocationAttemptInput): Promise<InvocationAttemptDraft> {
    return withQueryableTransaction(this.db, async (db) => {
      const protocol = await loadProtocol();
      const controlResult = await db.query<{ snapshot_json: unknown }>(
        `SELECT snapshot_json FROM execution_control_snapshots
          WHERE id=$1 AND space_id=$2 FOR SHARE`,
        [input.control.id, input.spaceId],
      );
      if (!controlResult.rows[0]) throw new HttpError(404, "Execution Control Snapshot not found");
      const control = protocol.ExecutionControlSnapshotSchema.parse(controlResult.rows[0].snapshot_json);
      if (stableJson(control) !== stableJson(input.control)) {
        throw new HttpError(409, "Execution Control Snapshot does not match persisted authority");
      }
      if (input.requireLiveAuthorization && !this.deliveryAuthorizer) {
        throw new Error("Live Invocation Delivery authorization is unavailable");
      }
      await this.deliveryAuthorizer?.authorize(db, input, control);
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `invocation-delivery:${input.spaceId}:${input.invocationId}`,
      ]);
      const attemptResult = await db.query<{ next_attempt: number }>(
        `SELECT COALESCE(max(attempt), 0) + 1 AS next_attempt
           FROM invocation_snapshots
          WHERE space_id=$1 AND invocation_id=$2`,
        [input.spaceId, input.invocationId],
      );
      const attempt = Number(attemptResult.rows[0]?.next_attempt ?? 1);
      const deliveryId = input.deliveryId ?? randomUUID();
      const snapshotId = input.snapshotId ?? randomUUID();
      const delivery = await renderManagedDelivery({
        envelope: input.envelope,
        control,
        invocationId: input.invocationId,
        attempt,
        adapterType: input.adapterType,
        providerId: input.providerId,
        model: input.model,
        mode: input.mode,
        usageSourceId: input.usageSourceId,
        deliveryId,
        snapshotId,
        cliSession: input.cliSession,
      });
      const parsedDelivery = protocol.InvocationDeliverySchema.parse(delivery);
      await new ContextWindowReconciliationRepository(db).recordPlan({
        spaceId: input.spaceId,
        invocationId: input.invocationId,
        deliveryId,
        plan: input.envelope.window_plan,
      });
      const now = new Date().toISOString();
      const snapshot = protocol.InvocationSnapshotSafeSchema.parse({
        id: snapshotId,
        invocation_id: input.invocationId,
        delivery_id: deliveryId,
        attempt,
        space_id: input.spaceId,
        actor: control.actor,
        project_id: control.project_id,
        project_folder_id: control.project_folder_id,
        agent_id: control.agent_id,
        work_context_scope_id: control.work_context_scope_id,
        runtime_session_binding_ref: input.cliSession?.binding_ref
          ?? input.runtimeSessionBindingRef
          ?? null,
        control_ref: parsedDelivery.control_ref,
        setup_ref: input.envelope.setup_ref,
        governing_policy_version_refs: control.governing_policy_version_refs,
        audit_refs: parsedDelivery.audit_refs,
        source_refs: acceptedSourceRefs(input.envelope),
        included_item_hashes: acceptedItems(input.envelope).map(hashValue),
        dropped_items: input.envelope.window_plan.decisions.filter((decision) => decision.decision !== "included"),
        budget: input.envelope.window_plan,
        renderer_version: parsedDelivery.renderer_version,
        planned_tokens: input.envelope.window_plan.planned_prompt_tokens,
        actual_tokens: null,
        delivered_at: null,
        acknowledgement: null,
        checkpoint_cursor: null,
        cli_known_cursor: input.cliSession?.cursor_from ?? null,
        capture_status: "partial",
        error_code: null,
        created_at: now,
      });
      await db.query(
        `INSERT INTO invocation_deliveries (
           id,space_id,invocation_id,attempt,execution_control_snapshot_id,
           adapter_type,provider_id,renderer_version,delivery_metadata_json,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [deliveryId, input.spaceId, input.invocationId, attempt, control.id,
          input.adapterType, input.providerId, parsedDelivery.renderer_version,
          JSON.stringify(safeDeliveryMetadata(parsedDelivery)), now],
      );
      await db.query(
        `INSERT INTO invocation_snapshots (
           id,space_id,invocation_id,delivery_id,attempt,safe_snapshot_json,status,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'draft',$7,$7)`,
        [snapshotId, input.spaceId, input.invocationId, deliveryId, attempt, JSON.stringify(snapshot), now],
      );
      const runAuthority = await db.query<{
        instructed_by_user_id: string | null;
        visibility: ContentVisibility;
      }>(
        `SELECT instructed_by_user_id,visibility FROM runs
          WHERE id=$1 AND space_id=$2 FOR UPDATE`,
        [input.invocationId, input.spaceId],
      );
      const run = runAuthority.rows[0];
      if (!run) throw new HttpError(404, "Invocation Run not found while persisting context taint");
      const deliveredItems = acceptedItems(input.envelope);
      await persistRunContextTaint(db, {
        runId: input.invocationId,
        spaceId: input.spaceId,
        instructingUserId: run.instructed_by_user_id,
        runVisibility: run.visibility,
        items: deliveredItems.map((item) => ({
          ownerUserId: item.owner_user_id,
          visibility: item.visibility,
        })),
        personalMemoryGrantIds: deliveredItems.flatMap((item) =>
          item.source_ref.type === "personal_memory_grant" ? [item.source_ref.id] : []),
      });
      if (input.rawReplayPayload !== undefined) {
        await this.persistSealedPayload(db, input, control, snapshotId, now);
      }
      return { delivery: parsedDelivery, snapshot };
    });
  }

  async acknowledge(input: {
    spaceId: string;
    deliveryId: string;
    status: DeliveryAcknowledgement["status"];
    actualTokens?: number | null;
    adapterReceiptRef?: { type: string; id: string; version?: string | null } | null;
    errorCode?: string | null;
  }): Promise<InvocationSnapshotSafe> {
    return withQueryableTransaction(this.db, async (db) => {
      const result = await db.query<{
        id: string;
        safe_snapshot_json: unknown;
        status: string;
        acknowledgement_fingerprint: string | null;
        delivery_metadata_json: unknown;
      }>(
        `SELECT snapshot.id,snapshot.safe_snapshot_json,snapshot.status,
                snapshot.acknowledgement_fingerprint,delivery.delivery_metadata_json
           FROM invocation_snapshots snapshot
           JOIN invocation_deliveries delivery
             ON delivery.id=snapshot.delivery_id AND delivery.space_id=snapshot.space_id
          WHERE snapshot.space_id=$1 AND snapshot.delivery_id=$2
          FOR UPDATE OF snapshot,delivery`,
        [input.spaceId, input.deliveryId],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "Invocation Snapshot not found");
      const protocol = await loadProtocol();
      const current = protocol.InvocationSnapshotSafeSchema.parse(row.safe_snapshot_json);
      const acknowledgementFingerprint = hashValue({
        status: input.status,
        actualTokens: input.actualTokens ?? null,
        adapterReceiptRef: input.adapterReceiptRef ?? null,
        errorCode: input.errorCode ?? null,
      });
      if (row.status !== "draft") {
        if (row.acknowledgement_fingerprint === acknowledgementFingerprint) return current;
        throw new HttpError(409, "Invocation delivery already has a different acknowledgement");
      }
      const acknowledgedAt = new Date().toISOString();
      const acknowledgement: DeliveryAcknowledgement = {
        status: input.status,
        acknowledged_at: acknowledgedAt,
        adapter_receipt_ref: input.adapterReceiptRef ?? null,
      };
      const deliveryMetadata = record(row.delivery_metadata_json);
      const cliSession = record(deliveryMetadata.cli_session);
      const cliBindingRef = record(cliSession.binding_ref);
      const cursorFrom = nonnegativeInteger(cliSession.cursor_from);
      const cursorThrough = nonnegativeInteger(cliSession.cursor_through);
      if (input.status === "accepted" && this.cliContinuity
        && typeof cliBindingRef.id === "string"
        && current.work_context_scope_id
        && cursorFrom !== null && cursorThrough !== null) {
        await this.cliContinuity.acknowledgeDeliveryInTransaction(db, {
          bindingId: cliBindingRef.id,
          spaceId: input.spaceId,
          workContextScopeId: current.work_context_scope_id,
          fromCursor: cursorFrom,
          throughCursor: cursorThrough,
          itemIds: plannedItemIds(deliveryMetadata),
        });
      }
      const next = protocol.InvocationSnapshotSafeSchema.parse({
        ...current,
        actual_tokens: input.actualTokens ?? null,
        delivered_at: input.status === "accepted" ? acknowledgedAt : null,
        acknowledgement,
        cli_known_cursor: input.status === "accepted" && cursorThrough !== null
          ? cursorThrough
          : current.cli_known_cursor,
        // Adapter acceptance proves delivery, not continuity capture. Only a
        // committed terminal Context Event + Micro Checkpoint may mark this
        // snapshot complete.
        capture_status: "partial",
        error_code: input.errorCode ?? null,
      });
      await db.query(
        `UPDATE invocation_snapshots
            SET safe_snapshot_json=$3::jsonb,status=$4,acknowledgement_fingerprint=$5,updated_at=$6
          WHERE space_id=$1 AND delivery_id=$2`,
        [input.spaceId, input.deliveryId, JSON.stringify(next), input.status,
          acknowledgementFingerprint, acknowledgedAt],
      );
      return next;
    });
  }

  /** Advance only the CLI context cursor after the bootstrap/delta turn is accepted. */
  async acknowledgeCliContextPhase(input: { spaceId: string; deliveryId: string; vendorSessionId: string }): Promise<void> {
    if (!this.cliContinuity) throw new Error("CLI continuity service is unavailable");
    await withQueryableTransaction(this.db, async (db) => {
      const result = await db.query<{
        status: string;
        safe_snapshot_json: unknown;
        delivery_metadata_json: unknown;
      }>(
        `SELECT snapshot.status,snapshot.safe_snapshot_json,delivery.delivery_metadata_json
           FROM invocation_snapshots snapshot
           JOIN invocation_deliveries delivery
             ON delivery.id=snapshot.delivery_id AND delivery.space_id=snapshot.space_id
          WHERE snapshot.space_id=$1 AND snapshot.delivery_id=$2
          FOR UPDATE OF snapshot,delivery`,
        [input.spaceId, input.deliveryId],
      );
      const row = result.rows[0];
      if (!row || row.status !== "draft") {
        throw new HttpError(409, "CLI context phase is unavailable for acknowledgement");
      }
      const snapshot = (await loadProtocol()).InvocationSnapshotSafeSchema.parse(row.safe_snapshot_json);
      const metadata = record(row.delivery_metadata_json);
      const cliSession = record(metadata.cli_session);
      const bindingRef = record(cliSession.binding_ref);
      const cursorFrom = nonnegativeInteger(cliSession.cursor_from);
      const cursorThrough = nonnegativeInteger(cliSession.cursor_through);
      if (typeof bindingRef.id !== "string" || !snapshot.work_context_scope_id
        || cursorFrom === null || cursorThrough === null) {
        throw new HttpError(409, "Invocation Delivery has no CLI context phase");
      }
      const vendor = input.vendorSessionId.trim();
      if (!vendor) throw new HttpError(422, "CLI context phase requires a vendor session id");
      const recorded = await db.query(
        `UPDATE runtime_context_cli_bindings
            SET vendor_session_id=$3,updated_at=now()
          WHERE id=$1 AND runtime_state_key=$2 AND status='active'`,
        [bindingRef.id, cliSession.runtime_state_key, vendor],
      );
      if ((recorded.rowCount ?? 0) !== 1) {
        throw new HttpError(409, "CLI Delivery binding is no longer active");
      }
      await this.cliContinuity!.acknowledgeDeliveryInTransaction(db, {
        bindingId: bindingRef.id,
        spaceId: input.spaceId,
        workContextScopeId: snapshot.work_context_scope_id,
        fromCursor: cursorFrom,
        throughCursor: cursorThrough,
        itemIds: plannedItemIds(metadata),
      });
    });
  }

  async getSafe(spaceId: string, snapshotId: string): Promise<InvocationSnapshotSafe | null> {
    const result = await this.db.query<{ safe_snapshot_json: unknown }>(
      `SELECT safe_snapshot_json FROM invocation_snapshots WHERE space_id=$1 AND id=$2`,
      [spaceId, snapshotId],
    );
    if (!result.rows[0]) return null;
    return (await loadProtocol()).InvocationSnapshotSafeSchema.parse(result.rows[0].safe_snapshot_json);
  }

  async listSafeForInvocation(
    spaceId: string,
    invocationId: string,
  ): Promise<InvocationSnapshotSafe[]> {
    const result = await this.db.query<{ safe_snapshot_json: unknown }>(
      `SELECT safe_snapshot_json
         FROM invocation_snapshots
        WHERE space_id=$1 AND invocation_id=$2
        ORDER BY attempt ASC, created_at ASC, id ASC`,
      [spaceId, invocationId],
    );
    const protocol = await loadProtocol();
    return result.rows.map((row) =>
      protocol.InvocationSnapshotSafeSchema.parse(row.safe_snapshot_json));
  }

  async finalize(input: {
    spaceId: string;
    invocationId: string;
    deliveryId: string;
    errorCode?: string | null;
  }): Promise<InvocationSnapshotSafe> {
    return withQueryableTransaction(this.db, async (db) => {
      const result = await db.query<{
        safe_snapshot_json: unknown;
        status: string;
        finalization_fingerprint: string | null;
      }>(
        `SELECT safe_snapshot_json,status,finalization_fingerprint FROM invocation_snapshots
          WHERE space_id=$1 AND invocation_id=$2 AND delivery_id=$3 FOR UPDATE`,
        [input.spaceId, input.invocationId, input.deliveryId],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "Invocation Snapshot not found");
      const protocol = await loadProtocol();
      const current = protocol.InvocationSnapshotSafeSchema.parse(row.safe_snapshot_json);
      const requestedError = input.errorCode ?? current.error_code;
      const finalizationFingerprint = hashValue({ errorCode: requestedError });
      if (row.status === "draft") {
        throw new HttpError(409, "Invocation delivery must be acknowledged before finalization");
      }
      if (row.status === "finalized") {
        if (row.finalization_fingerprint === finalizationFingerprint) return current;
        throw new HttpError(409, "Invocation delivery already has a different finalization");
      }
      if (current.error_code !== null && input.errorCode !== undefined
        && input.errorCode !== null && current.error_code !== input.errorCode) {
        throw new HttpError(409, "Finalization cannot replace the acknowledged error");
      }
      const checkpoint = this.continuity
        ? await this.continuity.finalizeInvocationInTransaction(db, {
            spaceId: input.spaceId,
            invocationId: input.invocationId,
            snapshotId: current.id,
          })
        : null;
      const next = protocol.InvocationSnapshotSafeSchema.parse({
        ...current,
        checkpoint_cursor: checkpoint?.checkpoint_cursor ?? current.checkpoint_cursor,
        cli_known_cursor: checkpoint?.cli_known_cursor ?? current.cli_known_cursor,
        capture_status: checkpoint?.capture_status ?? current.capture_status,
        error_code: requestedError,
      });
      await db.query(
        `UPDATE invocation_snapshots
            SET safe_snapshot_json=$4::jsonb,status='finalized',finalization_fingerprint=$5,updated_at=$6
          WHERE space_id=$1 AND invocation_id=$2 AND delivery_id=$3`,
        [input.spaceId, input.invocationId, input.deliveryId, JSON.stringify(next),
          finalizationFingerprint, new Date().toISOString()],
      );
      return next;
    });
  }

  private async persistSealedPayload(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    snapshotId: string,
    now: string,
  ): Promise<void> {
    const retention = control.persistence.sealed_payload_retention_seconds;
    if (retention <= 0) throw new Error("Execution controls prohibit Sealed Payload persistence");
    if (!this.sealedCipher) throw new Error("Sealed Payload encryption is unavailable");
    const plaintext = input.rawReplayPayload;
    const deadline = new Date(Date.parse(now) + retention * 1000).toISOString();
    const payloadId = randomUUID();
    const encrypted = this.sealedCipher.encrypt(plaintext, {
      spaceId: input.spaceId,
      snapshotId,
      payloadId,
      retentionDeadline: deadline,
    });
    await db.query(
      `INSERT INTO sealed_invocation_payloads (
         id,space_id,invocation_snapshot_id,encrypted_payload,payload_hash,retention_deadline,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [payloadId, input.spaceId, snapshotId, encrypted, hashValue(plaintext), deadline, now],
    );
  }
}

export interface SealedPayloadReadAuthorizer {
  /** Revalidate and lock the authoritative permission rows through this transaction. */
  authorize(
    db: Queryable,
    input: { spaceId: string; snapshotId: string; viewerUserId: string },
  ): Promise<boolean>;
}

export class SealedPayloadService {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: SealedPayloadCipher,
    private readonly authorizer: SealedPayloadReadAuthorizer,
  ) {}

  async read(input: {
    spaceId: string;
    snapshotId: string;
    viewerUserId: string;
    reason: string;
  }): Promise<unknown> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 512) throw new HttpError(422, "Sealed Payload read reason must be 1-512 characters");
    const readResult = await withQueryableTransaction(this.db, async (db): Promise<
      { status: "expired" } | { status: "available"; payload: unknown }
    > => {
      const result = await db.query<{
        id: string;
        encrypted_payload: string | null;
        payload_hash: string;
        retention_deadline: string;
        deleted_at: string | null;
      }>(
        `SELECT id,encrypted_payload,payload_hash,retention_deadline,deleted_at
           FROM sealed_invocation_payloads
          WHERE space_id=$1 AND invocation_snapshot_id=$2 FOR UPDATE`,
        [input.spaceId, input.snapshotId],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "Sealed Payload not found");
      const allowed = await this.authorizer.authorize(db, input);
      if (!allowed) throw new HttpError(403, "Dedicated Sealed Payload read permission required");
      if (row.deleted_at || !row.encrypted_payload) throw new HttpError(410, "Sealed Payload was deleted");
      const retentionDeadline = timestampIso(row.retention_deadline);
      if (Date.parse(retentionDeadline) <= Date.now()) {
        await deleteSealedRow(db, row.id);
        return { status: "expired" };
      }
      const payload = this.cipher.decrypt(row.encrypted_payload, {
        spaceId: input.spaceId,
        snapshotId: input.snapshotId,
        payloadId: row.id,
        retentionDeadline,
      });
      if (hashValue(payload) !== row.payload_hash) throw new Error("Sealed Payload integrity check failed");
      await db.query(
        `INSERT INTO sealed_invocation_payload_access_audits (
           id,space_id,sealed_payload_id,viewer_user_id,reason,accessed_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), input.spaceId, row.id, input.viewerUserId, reason, new Date().toISOString()],
      );
      return { status: "available", payload };
    });
    if (readResult.status === "expired") throw new HttpError(410, "Sealed Payload retention expired");
    return readResult.payload;
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const result = await this.db.query(
      `UPDATE sealed_invocation_payloads
          SET encrypted_payload=NULL,deleted_at=$1
        WHERE deleted_at IS NULL AND retention_deadline <= $1
        RETURNING id`,
      [now.toISOString()],
    );
    return result.rows.length;
  }
}

function timestampIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid Sealed Payload retention deadline");
  return date.toISOString();
}

function acceptedItems(envelope: RuntimeContextEnvelope) {
  const decisions = new Map(envelope.window_plan.decisions.map((decision) => [decision.item_id, decision.decision]));
  return envelope.items.filter((item) => decisions.get(item.id) !== "blocked");
}

function acceptedSourceRefs(envelope: RuntimeContextEnvelope) {
  return acceptedItems(envelope).map((item) => item.source_ref);
}

function safeDeliveryMetadata(delivery: InvocationDelivery): Record<string, unknown> {
  const providerRequest = managedProviderMessages(delivery);
  return {
    id: delivery.id,
    invocation_id: delivery.invocation_id,
    delivery_kind: delivery.delivery_kind,
    adapter_type: delivery.adapter_type,
    provider_id: delivery.provider_id,
    model: delivery.model,
    renderer_version: delivery.renderer_version,
    mode: delivery.mode,
    planned_items: delivery.planned_items,
    message_blocks: delivery.message_blocks.map((block) => ({
      semantic_role: block.semantic_role,
      source_item_ids: block.source_item_ids,
      delivery_phase: block.delivery_phase,
      content_hash: hashValue(block.content),
    })),
    cli_session: delivery.cli_session,
    control_ref: delivery.control_ref,
    sandbox_ref: delivery.sandbox_ref,
    tool_grant_refs: delivery.tool_grant_refs,
    output_contract_ref: delivery.output_contract_ref,
    expected_prompt_tokens: delivery.expected_prompt_tokens,
    max_output_tokens: delivery.max_output_tokens,
    snapshot_draft_ref: delivery.snapshot_draft_ref,
    audit_refs: delivery.audit_refs,
    runtime_host_binding: {
      model: delivery.model,
      provider_id: delivery.provider_id,
      system_prompt_hash: hashValue(providerRequest.system),
      prompt_hash: hashValue(providerRequest.messages.at(-1)?.content ?? ""),
      messages: providerRequest.messages.map((message) => ({
        role: message.role,
        content_hash: hashValue(message.content),
      })),
    },
  };
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function plannedItemIds(metadata: Record<string, unknown>): string[] {
  const currentIds = new Set(
    (Array.isArray(metadata.message_blocks) ? metadata.message_blocks : [])
      .map(record)
      .filter((block) => block.delivery_phase === "current_user")
      .flatMap((block) => Array.isArray(block.source_item_ids)
        ? block.source_item_ids.filter((id): id is string => typeof id === "string")
        : []),
  );
  const value = metadata.planned_items;
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const id = record(item).item_id;
        return typeof id === "string" && !currentIds.has(id) ? [id] : [];
      })
    : [];
}

async function deleteSealedRow(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE sealed_invocation_payloads SET encrypted_payload=NULL,deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL`,
    [id, new Date().toISOString()],
  );
}
