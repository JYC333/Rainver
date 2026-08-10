import { createHash, randomUUID } from "node:crypto";
import type {
  ContextItem,
  ExecutionControlSnapshot,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { Queryable } from "../../routeUtils/common";
import { HttpError, withQueryableTransaction } from "../../routeUtils/common";
import { contextItemText, normalizeContextItem } from "../itemNormalizer";

export type CliRotationReason =
  | "new_scope"
  | "user_reset"
  | "vendor_state_missing"
  | "runtime_changed"
  | "credential_changed"
  | "sandbox_changed"
  | "delegated_instruction_changed"
  | "tool_policy_changed"
  | "egress_policy_changed"
  | "sensitive_revocation"
  | "governing_policy_changed"
  | "overflow_reconstruction";

export interface PreparedCliBinding {
  id: string;
  runtime_state_key: string;
  vendor_session_id: string | null;
  cli_known_cursor: number;
  acknowledged_item_ids: string[];
  generation: number;
  rotation_reason: CliRotationReason | null;
}

export interface PreparedCliDeliveryState extends PreparedCliBinding {
  mode: "full" | "delta";
  target_cursor: number;
  delta_item: ContextItem | null;
}

interface BindingRow {
  id: string;
  runtime_state_key: string;
  vendor_session_id: string | null;
  authority_fingerprint: string;
  runtime_fingerprint: string;
  fingerprint_json: unknown;
  cli_known_cursor: number;
  acknowledged_item_ids_json: unknown;
  generation: number;
  rotation_reason: CliRotationReason | null;
}

interface BindingFingerprint {
  authority: {
    space_id: string;
    project_id: string | null;
    project_folder_id: string | null;
    agent_id: string;
    user_id: string;
    project_instruction_ref: unknown;
    governing_policy_version_refs: unknown;
    readable_sensitivity_ceiling: string;
    tool_grant_refs: unknown;
    egress: unknown;
    egress_generation: unknown;
    agent_version_id: string;
  };
  runtime: {
    runtime_profile_id: string;
    adapter_type: string;
    provider_id: string | null;
    model: string | null;
    credential_profile_id: string | null;
    sandbox_profile_ref: unknown;
    runtime_generation: unknown;
    credential_generation: unknown;
    provider_generation: unknown;
    runtime_tool_version: string | null;
  };
}

export class RuntimeContextCliContinuityService {
  constructor(private readonly db: Queryable) {}

  async prepareBinding(input: {
    spaceId: string;
    workContextScopeId: string;
    setupId: string;
    setupVersion: number;
    userId: string;
    agentId: string;
    runtimeProfileId: string;
    credentialProfileId: string | null;
    adapterType: string;
    providerId: string | null;
    model: string | null;
    agentVersionId: string;
    runtimeToolVersion: string | null;
    control: ExecutionControlSnapshot;
  }): Promise<PreparedCliBinding> {
    return withQueryableTransaction(this.db, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `cli-binding:${input.spaceId}:${input.workContextScopeId}:${input.userId}:${input.agentId}`,
      ]);
      const setup = await db.query<{ scope_kind: string }>(
        `SELECT scope_kind FROM work_context_setups
          WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3
            AND version=$4 AND user_id=$5 AND agent_id=$6
          FOR SHARE`,
        [input.setupId, input.spaceId, input.workContextScopeId,
          input.setupVersion, input.userId, input.agentId],
      );
      const scopeKind = setup.rows[0]?.scope_kind;
      if (!scopeKind) throw new HttpError(409, "CLI binding Work Context Setup is no longer authoritative");
      const fingerprint = bindingFingerprint(input, await loadBindingGenerations(db, input));
      const authorityFingerprint = hash(fingerprint.authority);
      const runtimeFingerprint = hash(fingerprint.runtime);
      const existing = await this.activeBinding(db, input);
      if (existing
        && existing.authority_fingerprint === authorityFingerprint
        && existing.runtime_fingerprint === runtimeFingerprint) {
        return bindingOut(existing);
      }
      const reason = existing
        ? rotationReason(existing.fingerprint_json, fingerprint)
        : "new_scope";
      if (existing) {
        await db.query(
          `UPDATE runtime_context_cli_bindings
              SET status='rotated',rotation_reason=$2,updated_at=now()
            WHERE id=$1 AND status='active'`,
          [existing.id, reason],
        );
      }
      const created = await db.query<BindingRow>(
        `INSERT INTO runtime_context_cli_bindings (
           id,space_id,work_context_scope_id,scope_kind,user_id,agent_id,
           runtime_profile_id,credential_profile_id,adapter_type,provider_id,model,
           runtime_state_key,vendor_session_id,authority_fingerprint,runtime_fingerprint,
           fingerprint_json,cli_known_cursor,acknowledged_item_ids_json,generation,
           status,rotation_reason,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15::jsonb,
                   0,'[]'::jsonb,$16,'active',$17,now(),now())
         RETURNING id,runtime_state_key,vendor_session_id,authority_fingerprint,
                   runtime_fingerprint,fingerprint_json,cli_known_cursor,
                   acknowledged_item_ids_json,generation,rotation_reason`,
        [randomUUID(), input.spaceId, input.workContextScopeId, scopeKind,
          input.userId, input.agentId, input.runtimeProfileId,
          input.credentialProfileId, input.adapterType, input.providerId, input.model,
          randomUUID(), authorityFingerprint, runtimeFingerprint,
          JSON.stringify(fingerprint), (existing?.generation ?? 0) + 1, reason],
      );
      if (!created.rows[0]) throw new Error("CLI continuity binding was not persisted");
      return bindingOut(created.rows[0]);
    });
  }

  async rotateMissingVendorState(bindingId: string): Promise<PreparedCliBinding> {
    return withQueryableTransaction(this.db, async (db) => {
      const current = await db.query<any>(
        `SELECT * FROM runtime_context_cli_bindings WHERE id=$1 AND status='active' FOR UPDATE`,
        [bindingId],
      );
      const row = current.rows[0];
      if (!row) throw new HttpError(409, "CLI continuity binding is no longer active");
      await db.query(
        `UPDATE runtime_context_cli_bindings
            SET status='rotated',rotation_reason='vendor_state_missing',updated_at=now()
          WHERE id=$1`,
        [bindingId],
      );
      const created = await db.query<BindingRow>(
        `INSERT INTO runtime_context_cli_bindings (
           id,space_id,work_context_scope_id,scope_kind,user_id,agent_id,
           runtime_profile_id,credential_profile_id,adapter_type,provider_id,model,
           runtime_state_key,vendor_session_id,authority_fingerprint,runtime_fingerprint,
           fingerprint_json,cli_known_cursor,acknowledged_item_ids_json,generation,
           status,rotation_reason,execution_lease_id,execution_lease_expires_at,created_at,updated_at
         ) SELECT $2,space_id,work_context_scope_id,scope_kind,user_id,agent_id,
                  runtime_profile_id,credential_profile_id,adapter_type,provider_id,model,
                  $3,NULL,authority_fingerprint,runtime_fingerprint,fingerprint_json,
                  0,'[]'::jsonb,generation+1,'active','vendor_state_missing',
                  execution_lease_id,execution_lease_expires_at,now(),now()
             FROM runtime_context_cli_bindings WHERE id=$1
         RETURNING id,runtime_state_key,vendor_session_id,authority_fingerprint,
                   runtime_fingerprint,fingerprint_json,cli_known_cursor,
                   acknowledged_item_ids_json,generation,rotation_reason`,
        [bindingId, randomUUID(), randomUUID()],
      );
      if (!created.rows[0]) throw new Error("Replacement CLI continuity binding was not persisted");
      return bindingOut(created.rows[0]);
    });
  }

  async acquireExecutionLease(bindingId: string): Promise<string> {
    const leaseId = randomUUID();
    for (;;) {
      const result = await this.db.query(
        `UPDATE runtime_context_cli_bindings
            SET execution_lease_id=$2,
                execution_lease_expires_at=now() + interval '2 hours',updated_at=now()
          WHERE id=$1 AND status='active'
            AND (execution_lease_id IS NULL OR execution_lease_expires_at<=now())
          RETURNING id`,
        [bindingId, leaseId],
      );
      if (result.rows[0]) return leaseId;
      const active = await this.db.query(
        `SELECT 1 FROM runtime_context_cli_bindings WHERE id=$1 AND status='active'`,
        [bindingId],
      );
      if (!active.rows[0]) throw new HttpError(409, "CLI continuity binding is no longer active");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async bindingForExecutionLease(bindingId: string, leaseId: string): Promise<PreparedCliBinding> {
    const result = await this.db.query<BindingRow>(
      `SELECT id,runtime_state_key,vendor_session_id,authority_fingerprint,
              runtime_fingerprint,fingerprint_json,cli_known_cursor,
              acknowledged_item_ids_json,generation,rotation_reason
         FROM runtime_context_cli_bindings
        WHERE id=$1 AND execution_lease_id=$2 AND status='active'`,
      [bindingId, leaseId],
    );
    if (!result.rows[0]) throw new HttpError(409, "CLI execution lease is no longer authoritative");
    return bindingOut(result.rows[0]);
  }

  async releaseExecutionLease(bindingId: string, leaseId: string): Promise<void> {
    await this.db.query(
      `UPDATE runtime_context_cli_bindings
          SET execution_lease_id=NULL,execution_lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND execution_lease_id=$2`,
      [bindingId, leaseId],
    );
  }

  async prepareDelivery(input: {
    bindingId: string;
    spaceId: string;
    workContextScopeId: string;
    invocationId: string;
    currentMessageRef: { type: string; id: string; version?: string | null };
    ownerUserId: string;
    authorizedSourceRefs: Array<{ type: string; id: string; version?: string | null }>;
  }): Promise<PreparedCliDeliveryState> {
    return withQueryableTransaction(this.db, async (db) => {
      const bindingResult = await db.query<BindingRow & { work_context_scope_id: string; space_id: string; status: string }>(
        `SELECT id,space_id,work_context_scope_id,status,runtime_state_key,vendor_session_id,
                authority_fingerprint,runtime_fingerprint,fingerprint_json,cli_known_cursor,
                acknowledged_item_ids_json,generation,rotation_reason
           FROM runtime_context_cli_bindings WHERE id=$1 FOR UPDATE`,
        [input.bindingId],
      );
      const binding = bindingResult.rows[0];
      if (!binding || binding.status !== "active"
        || binding.space_id !== input.spaceId
        || binding.work_context_scope_id !== input.workContextScopeId) {
        throw new HttpError(409, "CLI Delivery binding is no longer active for this work scope");
      }
      const scope = await db.query<{ event_head_cursor: number }>(
        `SELECT event_head_cursor FROM context_event_scopes
          WHERE space_id=$1 AND work_context_scope_id=$2 FOR SHARE`,
        [input.spaceId, input.workContextScopeId],
      );
      const targetCursor = Number(scope.rows[0]?.event_head_cursor ?? 0);
      const mode = binding.vendor_session_id ? "delta" : "full";
      let checkpoint = mode === "full"
        ? await loadActiveCheckpointForCli(db, input.spaceId, input.workContextScopeId, targetCursor)
        : null;
      if (checkpoint && !(await checkpointSourcesAuthorized(db, checkpoint.checkpoint_json, {
        spaceId: input.spaceId,
        workContextScopeId: input.workContextScopeId,
        viewerUserId: input.ownerUserId,
        authorizedRefs: input.authorizedSourceRefs,
      }))) {
        checkpoint = null;
      }
      const events = mode === "delta"
        ? await loadCliDeltaEvents(db, {
            spaceId: input.spaceId,
            workContextScopeId: input.workContextScopeId,
            afterCursor: binding.cli_known_cursor,
            throughCursor: targetCursor,
            currentMessageRef: input.currentMessageRef,
          })
        : await loadCliReconstructionEvents(db, {
            spaceId: input.spaceId,
            workContextScopeId: input.workContextScopeId,
            throughCursor: targetCursor,
            currentMessageRef: input.currentMessageRef,
            checkpoint,
          });
      const deltaText = mode === "full"
        ? renderCliReconstruction(checkpoint?.checkpoint_json ?? null, events)
        : renderCliEventDelta(events);
      const deltaItem = deltaText
        ? normalizeContextItem({
            sourceRef: {
              type: mode === "full" ? "context_scope_reconstruction" : "context_event_range",
              id: binding.id,
              version: mode === "full"
                ? String(targetCursor)
                : `${binding.cli_known_cursor + 1}-${targetCursor}`,
            },
            acquisition: "runtime_event",
            selection: "pinned",
            semanticRole: "reference_data",
            trust: "domain_approved",
            sensitivity: "normal",
            visibility: "private",
            ownerUserId: input.ownerUserId,
            spaceId: input.spaceId,
            egressEligible: true,
            text: deltaText,
            structuredPayload: {
              after_cursor: mode === "full"
                ? Number(checkpoint?.covered_cursor ?? 0)
                : binding.cli_known_cursor,
              through_cursor: targetCursor,
              checkpoint_ref: checkpoint
                ? { type: "semantic_checkpoint", id: checkpoint.id, version: String(checkpoint.version) }
                : null,
              event_refs: events.map((event) => ({ type: "context_event", id: event.id, version: String(event.scope_sequence) })),
            },
            revalidation: { status: "live", checked_at: new Date().toISOString() },
          })
        : null;
      return {
        ...bindingOut(binding),
        mode,
        target_cursor: targetCursor,
        delta_item: deltaItem,
      };
    });
  }

  async acknowledgeDeliveryInTransaction(db: Queryable, input: {
    bindingId: string;
    spaceId: string;
    workContextScopeId: string;
    fromCursor: number;
    throughCursor: number;
    itemIds: string[];
  }): Promise<void> {
    const result = await db.query<{ cli_known_cursor: number; acknowledged_item_ids_json: unknown }>(
      `SELECT cli_known_cursor,acknowledged_item_ids_json
         FROM runtime_context_cli_bindings
        WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3 AND status='active'
        FOR UPDATE`,
      [input.bindingId, input.spaceId, input.workContextScopeId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(409, "CLI Delivery binding is no longer active");
    const current = Number(row.cli_known_cursor);
    if (current !== input.fromCursor && current !== input.throughCursor) {
      throw new HttpError(409, "CLI Delivery acknowledgement cursor is stale");
    }
    if (input.throughCursor < current) throw new HttpError(409, "CLI Delivery cursor cannot move backwards");
    const known = [...new Set([...stringArray(row.acknowledged_item_ids_json), ...input.itemIds])];
    await db.query(
      `UPDATE runtime_context_cli_bindings
          SET cli_known_cursor=$2,acknowledged_item_ids_json=$3::jsonb,
              last_acknowledged_at=now(),updated_at=now()
        WHERE id=$1`,
      [input.bindingId, input.throughCursor, JSON.stringify(known)],
    );
  }

  async recordVendorSession(input: {
    bindingId: string;
    runtimeStateKey: string;
    vendorSessionId: string;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE runtime_context_cli_bindings
          SET vendor_session_id=$3,updated_at=now()
        WHERE id=$1 AND runtime_state_key=$2 AND status='active'`,
      [input.bindingId, input.runtimeStateKey, input.vendorSessionId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  private async activeBinding(db: Queryable, input: {
    spaceId: string;
    workContextScopeId: string;
    userId: string;
    agentId: string;
  }): Promise<BindingRow | null> {
    const result = await db.query<BindingRow>(
      `SELECT id,runtime_state_key,vendor_session_id,authority_fingerprint,
              runtime_fingerprint,fingerprint_json,cli_known_cursor,
              acknowledged_item_ids_json,generation,rotation_reason
         FROM runtime_context_cli_bindings
        WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3 AND agent_id=$4
          AND status='active' FOR UPDATE`,
      [input.spaceId, input.workContextScopeId, input.userId, input.agentId],
    );
    return result.rows[0] ?? null;
  }
}

interface CliDeltaEvent {
  id: string;
  scope_sequence: number;
  event_type: string;
  canonical_type: string;
  canonical_id: string;
  content: string | null;
}

interface CliCheckpointRow {
  id: string;
  version: number;
  covered_cursor: number;
  checkpoint_json: unknown;
}

async function loadCliDeltaEvents(db: Queryable, input: {
  spaceId: string;
  workContextScopeId: string;
  afterCursor: number;
  throughCursor: number;
  currentMessageRef: { type: string; id: string };
}): Promise<CliDeltaEvent[]> {
  const result = await db.query<CliDeltaEvent>(
    `SELECT event.id,event.scope_sequence,event.event_type,
            event.canonical_ref_json->>'type' AS canonical_type,
            event.canonical_ref_json->>'id' AS canonical_id,
            CASE
              WHEN event.canonical_ref_json->>'type'='message' THEN message.content
              WHEN event.canonical_ref_json->>'type'='run_request' THEN
                concat_ws(E'\n\n', run.prompt, run.instruction)
              WHEN event.canonical_ref_json->>'type'='run_event'
                AND run_event.event_type='assistant_message_completed' THEN
                COALESCE(NULLIF(run.output_json->>'summary',''),run_event.summary)
              WHEN event.canonical_ref_json->>'type'='run_event' THEN run_event.summary
              ELSE NULL
            END AS content
       FROM context_events event
       LEFT JOIN messages message
         ON event.canonical_ref_json->>'type'='message'
        AND message.id=event.canonical_ref_json->>'id' AND message.space_id=event.space_id
       LEFT JOIN run_events run_event
         ON event.canonical_ref_json->>'type'='run_event'
        AND run_event.id=event.canonical_ref_json->>'id' AND run_event.space_id=event.space_id
       LEFT JOIN runs run
         ON run.space_id=event.space_id AND (
           (event.canonical_ref_json->>'type'='run_request'
             AND run.id=event.canonical_ref_json->>'id')
           OR (event.canonical_ref_json->>'type'='run_event'
             AND run.id=run_event.run_id)
         )
      WHERE event.space_id=$1 AND event.work_context_scope_id=$2
        AND event.scope_sequence>$3 AND event.scope_sequence<=$4
        AND NOT (event.canonical_ref_json->>'type'=$5 AND event.canonical_ref_json->>'id'=$6)
      ORDER BY event.scope_sequence`,
    [input.spaceId, input.workContextScopeId, input.afterCursor, input.throughCursor,
      input.currentMessageRef.type, input.currentMessageRef.id],
  );
  return result.rows.map((row) => ({ ...row, scope_sequence: Number(row.scope_sequence) }));
}

async function loadCliReconstructionEvents(db: Queryable, input: {
  spaceId: string;
  workContextScopeId: string;
  throughCursor: number;
  currentMessageRef: { type: string; id: string };
  checkpoint?: CliCheckpointRow | null;
}): Promise<CliDeltaEvent[]> {
  const checkpoint = input.checkpoint === undefined
    ? await loadActiveCheckpointForCli(db, input.spaceId, input.workContextScopeId, input.throughCursor)
    : input.checkpoint;
  return loadCliDeltaEvents(db, {
    ...input,
    afterCursor: Number(checkpoint?.covered_cursor ?? 0),
  });
}

async function loadActiveCheckpointForCli(
  db: Queryable,
  spaceId: string,
  workContextScopeId: string,
  throughCursor: number,
): Promise<CliCheckpointRow | null> {
  const result = await db.query<CliCheckpointRow>(
    `SELECT id,version,covered_cursor,checkpoint_json
       FROM context_semantic_checkpoints
      WHERE space_id=$1 AND work_context_scope_id=$2 AND status='active'
        AND covered_cursor<=$3
      ORDER BY version DESC LIMIT 1`,
    [spaceId, workContextScopeId, throughCursor],
  );
  const row = result.rows[0];
  return row ? { ...row, version: Number(row.version), covered_cursor: Number(row.covered_cursor) } : null;
}

export async function authorizeCliDeltaItem(db: Queryable, input: {
  item: ContextItem;
  spaceId: string;
  workContextScopeId: string;
  viewerUserId: string;
  agentId: string | null;
  currentMessageRef: { type: string; id: string; version?: string | null };
  authorizedSourceRefs: Array<{ type: string; id: string; version?: string | null }>;
}): Promise<void> {
  const afterCursor = nonnegativeInteger(input.item.payload.after_cursor);
  const throughCursor = nonnegativeInteger(input.item.payload.through_cursor);
  const full = input.item.source_ref.type === "context_scope_reconstruction";
  if ((!full && input.item.source_ref.type !== "context_event_range")
    || afterCursor === null || throughCursor === null
    || throughCursor < afterCursor) {
    throw new HttpError(409, "CLI Delivery event delta is malformed");
  }
  const binding = await db.query<{ generation: number }>(
    `SELECT generation FROM runtime_context_cli_bindings
      WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3
        AND user_id=$4 AND agent_id=$5 AND status='active' FOR SHARE`,
    [input.item.source_ref.id, input.spaceId, input.workContextScopeId,
      input.viewerUserId, input.agentId],
  );
  const generation = Number(binding.rows[0]?.generation ?? 0);
  const expectedVersion = full ? String(throughCursor) : `${afterCursor + 1}-${throughCursor}`;
  if (!generation || input.item.source_ref.version !== expectedVersion) {
    throw new HttpError(409, "CLI Delivery event delta binding is no longer authoritative");
  }
  const requestedCheckpoint = record(input.item.payload.checkpoint_ref);
  const checkpoint = full && typeof requestedCheckpoint.id === "string"
    ? await loadActiveCheckpointForCli(db, input.spaceId, input.workContextScopeId, throughCursor)
    : null;
  if (checkpoint && (checkpoint.id !== requestedCheckpoint.id
    || !(await checkpointSourcesAuthorized(db, checkpoint.checkpoint_json, {
      spaceId: input.spaceId,
      workContextScopeId: input.workContextScopeId,
      viewerUserId: input.viewerUserId,
      authorizedRefs: input.authorizedSourceRefs,
    })))) {
    throw new HttpError(409, "CLI reconstruction checkpoint is no longer authorized");
  }
  const events = full
    ? await loadCliReconstructionEvents(db, {
        spaceId: input.spaceId,
        workContextScopeId: input.workContextScopeId,
        throughCursor,
        currentMessageRef: input.currentMessageRef,
        checkpoint,
      })
    : await loadCliDeltaEvents(db, {
        spaceId: input.spaceId,
        workContextScopeId: input.workContextScopeId,
        afterCursor,
        throughCursor,
        currentMessageRef: input.currentMessageRef,
      });
  const rendered = full
    ? renderCliReconstruction(checkpoint?.checkpoint_json ?? null, events)
    : renderCliEventDelta(events);
  if (!rendered || contextItemText(input.item) !== rendered) {
    throw new HttpError(409, "CLI Delivery event delta changed after planning");
  }
}

export function renderCliEventDelta(events: CliDeltaEvent[]): string | null {
  const meaningful = events.filter((event) => event.event_type !== "model.text_delta"
    && event.event_type !== "model.tool_call_delta");
  if (meaningful.length === 0) return null;
  return [
    "Agent Space context changes since the last acknowledged CLI delivery:",
    ...meaningful.map((event) => {
      const content = event.content?.trim();
      return content
        ? `- ${event.event_type}: ${content}`
        : `- ${event.event_type} (${event.canonical_type})`;
    }),
  ].join("\n");
}

function renderCliReconstruction(checkpoint: unknown, events: CliDeltaEvent[]): string | null {
  const delta = renderCliEventDelta(events);
  if (!checkpoint && !delta) return null;
  return [
    "Agent Space canonical continuity reconstruction:",
    ...(checkpoint
      ? ["Validated semantic checkpoint:", stableJson(checkpoint)]
      : []),
    ...(delta ? [delta] : []),
  ].join("\n\n");
}

function bindingFingerprint(input: {
  spaceId: string;
  userId: string;
  agentId: string;
  runtimeProfileId: string;
  credentialProfileId: string | null;
  adapterType: string;
  providerId: string | null;
  model: string | null;
  agentVersionId: string;
  runtimeToolVersion: string | null;
  control: ExecutionControlSnapshot;
}, generations: {
  egress: unknown;
  runtime: unknown;
  credential: unknown;
  provider: unknown;
}): BindingFingerprint {
  return {
    authority: {
      space_id: input.spaceId,
      project_id: input.control.project_id,
      project_folder_id: input.control.project_folder_id,
      agent_id: input.agentId,
      user_id: input.userId,
      project_instruction_ref: input.control.project_instruction_ref,
      governing_policy_version_refs: input.control.governing_policy_version_refs,
      readable_sensitivity_ceiling: input.control.readable_scope.sensitivity_ceiling,
      tool_grant_refs: input.control.tool_grant_refs,
      egress: input.control.egress,
      egress_generation: generations.egress,
      agent_version_id: input.agentVersionId,
    },
    runtime: {
      runtime_profile_id: input.runtimeProfileId,
      adapter_type: input.adapterType,
      provider_id: input.providerId,
      model: input.model,
      credential_profile_id: input.credentialProfileId,
      sandbox_profile_ref: input.control.sandbox_profile_ref,
      runtime_generation: generations.runtime,
      credential_generation: generations.credential,
      provider_generation: generations.provider,
      runtime_tool_version: input.runtimeToolVersion,
    },
  };
}

function rotationReason(previous: unknown, next: BindingFingerprint): CliRotationReason {
  const before = record(previous) as Partial<BindingFingerprint>;
  if (hash(before.runtime) !== hash(next.runtime)) {
    const oldRuntime = record(before.runtime);
    if (oldRuntime.credential_profile_id !== next.runtime.credential_profile_id) return "credential_changed";
    if (hash(oldRuntime.sandbox_profile_ref) !== hash(next.runtime.sandbox_profile_ref)) return "sandbox_changed";
    return "runtime_changed";
  }
  const old = record(before.authority);
  if (hash(old.project_instruction_ref) !== hash(next.authority.project_instruction_ref)
    || old.agent_id !== next.authority.agent_id
    || old.agent_version_id !== next.authority.agent_version_id) return "delegated_instruction_changed";
  if (hash(old.tool_grant_refs) !== hash(next.authority.tool_grant_refs)) return "tool_policy_changed";
  if (hash(old.egress) !== hash(next.authority.egress)
    || hash(old.egress_generation) !== hash(next.authority.egress_generation)) {
    return "egress_policy_changed";
  }
  if (old.readable_sensitivity_ceiling !== next.authority.readable_sensitivity_ceiling) return "sensitive_revocation";
  return "governing_policy_changed";
}

function bindingOut(row: BindingRow): PreparedCliBinding {
  return {
    id: row.id,
    runtime_state_key: row.runtime_state_key,
    vendor_session_id: row.vendor_session_id,
    cli_known_cursor: Number(row.cli_known_cursor),
    acknowledged_item_ids: stringArray(row.acknowledged_item_ids_json),
    generation: Number(row.generation),
    rotation_reason: row.rotation_reason,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function loadBindingGenerations(db: Queryable, input: {
  spaceId: string;
  userId: string;
  agentId: string;
  runtimeProfileId: string;
  credentialProfileId: string | null;
  providerId: string | null;
}): Promise<{ egress: unknown; runtime: unknown; credential: unknown; provider: unknown }> {
  const [egress, runtime, credential, provider] = await Promise.all([
    db.query(
      `SELECT settings_json FROM settings
        WHERE scope_type='space' AND scope_id=$1
          AND settings_key='runtime_context.cli_egress_generation'`,
      [input.spaceId],
    ),
    db.query(
      `SELECT updated_at,adapter_type,model_provider_id,model_name,
              runtime_config_json,runtime_policy_json,enabled
         FROM agent_runtime_profiles
        WHERE id=$1 AND space_id=$2 AND agent_id=$3`,
      [input.runtimeProfileId, input.spaceId, input.agentId],
    ),
    input.credentialProfileId
      ? db.query(
          `SELECT profile.updated_at AS profile_updated_at,profile.runtime,
                  grant_row.updated_at AS grant_updated_at,grant_row.enabled,
                  grant_row.is_default,grant_row.network_profile_id,
                  network.updated_at AS network_updated_at,network.mode,network.enabled AS network_enabled
             FROM cli_credential_profiles profile
             JOIN cli_credential_space_grants grant_row
               ON grant_row.profile_id=profile.id AND grant_row.space_id=$2
             LEFT JOIN network_profiles network ON network.id=grant_row.network_profile_id
            WHERE profile.id=$1 AND profile.owner_user_id=$3`,
          [input.credentialProfileId, input.spaceId, input.userId],
        )
      : Promise.resolve({ rows: [] }),
    input.providerId
      ? db.query(
          `SELECT provider.updated_at AS provider_updated_at,provider.provider_type,provider.base_url,
                  provider.network_profile_id AS provider_network_profile_id,
                  provider.default_model,provider.enabled AS provider_enabled,
                  provider.credential_id,provider.capabilities_json,provider.config_json,
                  grant_row.updated_at AS grant_updated_at,
                  grant_row.enabled AS grant_enabled,grant_row.is_default,
                  grant_row.network_profile_id AS grant_network_profile_id,
                  network.updated_at AS network_updated_at,network.mode AS network_mode,
                  network.enabled AS network_enabled
             FROM model_provider_space_grants grant_row
             JOIN model_providers provider ON provider.id=grant_row.provider_id
             LEFT JOIN network_profiles network
               ON network.id=COALESCE(grant_row.network_profile_id,provider.network_profile_id)
            WHERE grant_row.provider_id=$1 AND grant_row.space_id=$2
              AND grant_row.enabled=TRUE AND provider.enabled=TRUE`,
          [input.providerId, input.spaceId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  if (!runtime.rows[0]) throw new HttpError(409, "CLI runtime profile is no longer authoritative");
  if (input.credentialProfileId && !credential.rows[0]) {
    throw new HttpError(409, "CLI credential profile grant is no longer authoritative");
  }
  if (input.providerId && !provider.rows[0]) {
    throw new HttpError(409, "CLI provider configuration is no longer authoritative");
  }
  return {
    egress: jsonSafe(egress.rows[0] ?? { default_external_egress: true }),
    runtime: jsonSafe(runtime.rows[0]),
    credential: jsonSafe(credential.rows[0] ?? null),
    provider: jsonSafe(provider.rows[0] ?? null),
  };
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function checkpointSourcesAuthorized(
  db: Queryable,
  checkpoint: unknown,
  input: {
    spaceId: string;
    workContextScopeId: string;
    viewerUserId: string;
    authorizedRefs: Array<{ type: string; id: string; version?: string | null }>;
  },
): Promise<boolean> {
  const sources = Array.isArray(record(checkpoint).source_refs)
    ? record(checkpoint).source_refs as unknown[]
    : [];
  const authorized = new Set(input.authorizedRefs.map(refIdentity));
  for (const source of sources) {
    const value = record(source);
    const ref = record(value.ref ?? value);
    if (typeof ref.type !== "string" || typeof ref.id !== "string") return false;
    const normalized = {
      type: ref.type,
      id: ref.id,
      version: typeof ref.version === "string" ? ref.version : null,
    };
    if (authorized.has(refIdentity(normalized))) continue;
    if (ref.type !== "message" && ref.type !== "run" && ref.type !== "run_request"
      && ref.type !== "run_event" && ref.type !== "invocation_snapshot"
      && ref.type !== "checkpoint_correction") return false;
    const canonical = await db.query(
      `SELECT 1 FROM context_events event
        WHERE event.space_id=$1 AND event.work_context_scope_id=$2
          AND (event.canonical_ref_json @> $3::jsonb OR event.source_refs_json @> $4::jsonb)
          AND ($5::varchar <> 'message' OR EXISTS (
            SELECT 1 FROM messages message JOIN sessions session
              ON session.id=message.session_id AND session.space_id=message.space_id
             LEFT JOIN room_user_members member
               ON member.room_id=session.room_id AND member.space_id=session.space_id
              AND member.user_id=$6 AND member.status='active'
            WHERE message.id=$7 AND message.space_id=$1
              AND ((session.room_id IS NULL AND session.user_id=$6)
                OR (session.room_id IS NOT NULL AND member.user_id IS NOT NULL))
          )) LIMIT 1`,
      [input.spaceId, input.workContextScopeId,
        JSON.stringify({ type: ref.type, id: ref.id }),
        JSON.stringify([{ type: ref.type, id: ref.id }]),
        ref.type, input.viewerUserId, ref.id],
    );
    if (!canonical.rows[0]) return false;
  }
  return true;
}

function refIdentity(ref: { type: string; id: string; version?: string | null }): string {
  return `${ref.type}:${ref.id}:${ref.version ?? ""}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;
    return `{${Object.keys(recordValue).sort().map((key) => `${JSON.stringify(key)}:${stableJson(recordValue[key])}`).join(",")}}`;
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
