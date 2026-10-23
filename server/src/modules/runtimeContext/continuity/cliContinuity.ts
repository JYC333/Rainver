import { createHash, randomUUID } from "node:crypto";
import type {
  ContextItem,
  ExecutionControlSnapshot,
} from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { HttpError, withQueryableTransaction } from "../../routeUtils/common.js";
import { contextItemText, normalizeContextItem } from "../itemNormalizer.js";
import { estimateModelTokens } from "../../usage/modelCatalog.js";
import { historicalRunRequest, RUN_REQUEST_INCLUDES_INSTRUCTION } from "../runRequest.js";
import { INPUT_RESOURCE_TOOL_ALLOWANCE } from "../../systemActions/scenarioToolAllowance.js";
import { CLI_REPLAY_TOKENS, renderCliEventDelta, renderCliReconstruction, type CliDeltaEvent } from "./cliHistory.js";
export { renderCliEventDelta } from "./cliHistory.js";

/**
 * An execution lease lives this long without a heartbeat. The holder renews
 * it while it runs; a holder that stops renewing (a crashed worker) loses it
 * after this, and a holder Run that is no longer live loses it at once.
 */
const EXECUTION_LEASE_TTL_SECONDS = 300;
export const EXECUTION_LEASE_HEARTBEAT_MS = 60_000;
/** How long a Run waits for another Run's lease before giving up, retryably. */
const EXECUTION_LEASE_MAX_WAIT_MS = 10 * 60_000;
const LIVE_LEASE_HOLDER_STATUSES = "('queued','running','cancelling')";

/**
 * A lease is held while it has not expired and its holder Run is still live.
 * The acquiring Run's own earlier attempt (a crashed worker of the same Run)
 * does not hold it against that Run.
 */
function leaseHeldSql(binding: string, acquiringRunParam: string | null): string {
  return `(${binding}.execution_lease_id IS NOT NULL
           AND ${binding}.execution_lease_expires_at > now()
           ${acquiringRunParam ? `AND ${binding}.execution_lease_run_id IS DISTINCT FROM ${acquiringRunParam}` : ""}
           AND (${binding}.execution_lease_run_id IS NULL OR EXISTS (
             SELECT 1 FROM runs holder
              WHERE holder.id = ${binding}.execution_lease_run_id
                AND holder.status IN ${LIVE_LEASE_HOLDER_STATUSES})))`;
}

export interface CliExecutionLease {
  leaseId: string;
  /** The fencing token deliveries carry; see `execution_lease_generation`. */
  generation: number;
}

/** A wait for another Run's lease that ran out of time, or whose own Run stopped. */
export class CliExecutionLeaseUnavailableError extends HttpError {
  constructor(message: string) {
    super(409, message, { code: "cli_execution_lease_unavailable", retryable: true });
    this.name = "CliExecutionLeaseUnavailableError";
  }
}

export type CliRotationReason =
  | "new_scope"
  | "user_reset"
  | "vendor_state_missing"
  | "vendor_session_mismatch"
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
  /** The lease fencing token the binding carries now. */
  lease_generation: number;
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
  execution_lease_id?: string | null;
  execution_lease_expires_at?: Date | string | null;
  execution_lease_run_id?: string | null;
  execution_lease_generation?: number | null;
  /** Whether a live execution lease is held on the binding. */
  leased?: boolean;
}

const BINDING_COLUMNS = `id,runtime_state_key,vendor_session_id,authority_fingerprint,
                   runtime_fingerprint,fingerprint_json,cli_known_cursor,
                   acknowledged_item_ids_json,generation,rotation_reason,execution_lease_generation`;

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
    runtime_key: string;
    provider_id: string | null;
    model: string | null;
    /** Which copy on the host ran it (`own` / `managed:<version>`). Do not read a brokered credential profile. */
    runtime_installation: string | null;
    sandbox_profile_ref: unknown;
    runtime_generation: unknown;
    provider_generation: unknown;
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
    runtimeKey: string;
    providerId: string | null;
    model: string | null;
    agentVersionId: string;
    runtimeInstallation: string | null;
    control: ExecutionControlSnapshot;
    /** Present for HostThread dispatches; the context cursor must follow this exact ACP session. */
    expectedVendorSessionId?: string | null;
    /**
     * The Host thread whose ACP session the cursor follows. Each thread keeps
     * its own active binding: one scope's cursor must never follow two
     * independent vendor sessions, even if they share the same Work Context.
     */
    hostThreadId?: string | null;
    /** The Run preparing the binding; its own earlier attempt's lease does not hold it off. */
    runId: string;
    maxWaitMs?: number;
  }): Promise<PreparedCliBinding> {
    // A binding another Run still executes on is not rotated under it: that
    // Run's acknowledgements need it active, and the lease serializes the
    // scope. The rotation waits for the lease like an acquisition does.
    return this.waitForLease(input.runId, input.maxWaitMs, () => this.prepareUnleasedBinding(input));
  }

  /**
   * Retries `attempt` until it succeeds, backing off, for at most `maxWaitMs`.
   * The wait ends early, with the same retryable error, once the waiting Run
   * itself is no longer live: a cancelled Run does not sit on a queue slot.
   */
  private async waitForLease<T>(runId: string, maxWaitMs: number | undefined, attempt: () => Promise<T | null>): Promise<T> {
    const deadline = Date.now() + (maxWaitMs ?? EXECUTION_LEASE_MAX_WAIT_MS);
    let delay = 25;
    for (;;) {
      const result = await attempt();
      if (result !== null) return result;
      const waiting = await this.db.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1`, [runId]);
      const status = waiting.rows[0]?.status;
      if (status !== undefined && !["queued", "running"].includes(status)) {
        throw new CliExecutionLeaseUnavailableError("The Run stopped while waiting for its conversation's CLI execution lease.");
      }
      if (Date.now() >= deadline) {
        throw new CliExecutionLeaseUnavailableError("Another Run is still executing in this conversation's CLI session; try again when it finishes.");
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(1_000, delay * 2);
    }
  }

  private async prepareUnleasedBinding(
    input: Parameters<RuntimeContextCliContinuityService["prepareBinding"]>[0],
  ): Promise<PreparedCliBinding | null> {
    return withQueryableTransaction(this.db, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `cli-binding:${input.spaceId}:${input.workContextScopeId}:${input.userId}:${input.agentId}:${input.hostThreadId ?? ""}`,
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
      const existing = await this.activeBinding(db, input, input.runId);
      // Lock after the binding: a Delivery transaction can hold the binding
      // while upgrading its Run lock to persist taint. Taking the Run first
      // here would hold that upgrade off while waiting for the binding.
      const acquiring = await db.query<{ status: string }>(
        `SELECT status FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE`,
        [input.runId, input.spaceId],
      );
      if (!["queued", "running"].includes(acquiring.rows[0]?.status ?? "")) {
        throw new CliExecutionLeaseUnavailableError("The Run stopped before preparing its conversation's CLI binding.");
      }
      const vendorSessionMismatch = existing !== null
        && input.expectedVendorSessionId !== undefined
        && existing.vendor_session_id !== input.expectedVendorSessionId;
      if (existing
        && existing.authority_fingerprint === authorityFingerprint
        && existing.runtime_fingerprint === runtimeFingerprint
        && !vendorSessionMismatch) {
        return bindingOut(existing);
      }
      if (existing?.leased) return null;
      const reason = existing
        ? vendorSessionMismatch
          ? "vendor_session_mismatch"
          : rotationReason(existing.fingerprint_json, fingerprint)
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
           runtime_profile_id,runtime_key,provider_id,model,
           runtime_state_key,vendor_session_id,host_thread_id,authority_fingerprint,runtime_fingerprint,
           fingerprint_json,cli_known_cursor,acknowledged_item_ids_json,generation,
           status,rotation_reason,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$17,$12,$13,$14::jsonb,
                   0,'[]'::jsonb,$15,'active',$16,now(),now())
         RETURNING ${BINDING_COLUMNS}`,
        [randomUUID(), input.spaceId, input.workContextScopeId, scopeKind,
          input.userId, input.agentId, input.runtimeProfileId,
          input.runtimeKey, input.providerId, input.model,
          randomUUID(), authorityFingerprint, runtimeFingerprint,
          JSON.stringify(fingerprint), (existing?.generation ?? 0) + 1, reason, input.hostThreadId ?? null],
      );
      if (!created.rows[0]) throw new Error("CLI continuity binding was not persisted");
      return bindingOut(created.rows[0]);
    });
  }

  /**
   * The vendor session the binding names is gone: start a fresh one on a
   * replacement binding that takes over the caller's lease. Idempotent for
   * that lease: when the binding was already replaced under it (an overflow
   * rotation, or this same call made once before), the binding the lease now
   * holds is the answer, not a second rotation.
   */
  async rotateMissingVendorState(bindingId: string, leaseId: string): Promise<PreparedCliBinding> {
    return withQueryableTransaction(this.db, async (db) => {
      const current = await db.query<{
        id: string; status: string; execution_lease_id: string | null; execution_lease_run_id: string | null;
      }>(
        `SELECT id,status,execution_lease_id,execution_lease_run_id
           FROM runtime_context_cli_bindings WHERE id=$1 FOR UPDATE`,
        [bindingId],
      );
      const row = current.rows[0];
      if (!row) throw new HttpError(409, "CLI continuity binding is no longer active");
      if (row.status !== "active" || row.execution_lease_id !== leaseId) {
        const held = await db.query<BindingRow>(
          `SELECT ${BINDING_COLUMNS} FROM runtime_context_cli_bindings
            WHERE execution_lease_id=$1 AND status='active'`,
          [leaseId],
        );
        if (held.rows[0] && held.rows[0].id !== bindingId) return bindingOut(held.rows[0]);
        throw new HttpError(409, "CLI execution lease is no longer authoritative");
      }
      await db.query(
        `UPDATE runtime_context_cli_bindings
            SET status='rotated',rotation_reason='vendor_state_missing',
                execution_lease_id=NULL,execution_lease_expires_at=NULL,execution_lease_run_id=NULL,
                updated_at=now()
          WHERE id=$1`,
        [bindingId],
      );
      const created = await db.query<BindingRow>(
        `INSERT INTO runtime_context_cli_bindings (
           id,space_id,work_context_scope_id,scope_kind,user_id,agent_id,
           runtime_profile_id,runtime_key,provider_id,model,
           runtime_state_key,vendor_session_id,host_thread_id,authority_fingerprint,runtime_fingerprint,
           fingerprint_json,cli_known_cursor,acknowledged_item_ids_json,generation,
           status,rotation_reason,execution_lease_id,execution_lease_expires_at,
           execution_lease_run_id,execution_lease_generation,created_at,updated_at
         ) SELECT $2,space_id,work_context_scope_id,scope_kind,user_id,agent_id,
                  runtime_profile_id,runtime_key,provider_id,model,
                  $3,NULL,host_thread_id,authority_fingerprint,runtime_fingerprint,fingerprint_json,
                  0,'[]'::jsonb,generation+1,'active','vendor_state_missing',
                  $4,now() + make_interval(secs => ${EXECUTION_LEASE_TTL_SECONDS}),
                  $5,execution_lease_generation,now(),now()
             FROM runtime_context_cli_bindings WHERE id=$1
         RETURNING ${BINDING_COLUMNS}`,
        [bindingId, randomUUID(), randomUUID(), leaseId, row.execution_lease_run_id],
      );
      if (!created.rows[0]) throw new Error("Replacement CLI continuity binding was not persisted");
      return bindingOut(created.rows[0]);
    });
  }

  /**
   * Takes the binding's execution lease for `runId`, waiting (bounded, and
   * only while that Run is live) for another holder. A lease is free when
   * nobody holds it, when it expired without a heartbeat, or when its holder
   * Run is no longer live — or is this same Run, whose earlier attempt died.
   */
  async acquireExecutionLease(
    bindingId: string,
    holder: { runId: string; maxWaitMs?: number },
  ): Promise<CliExecutionLease> {
    const leaseId = randomUUID();
    return this.waitForLease(holder.runId, holder.maxWaitMs, async () => {
      const result = await this.db.query<{ execution_lease_generation: number }>(
        `UPDATE runtime_context_cli_bindings binding
            SET execution_lease_id=$2,
                execution_lease_run_id=$3,
                execution_lease_generation=binding.execution_lease_generation + 1,
                execution_lease_expires_at=now() + make_interval(secs => ${EXECUTION_LEASE_TTL_SECONDS}),
                updated_at=now()
          WHERE binding.id=$1 AND binding.status='active'
            AND EXISTS (SELECT 1 FROM runs acquiring
                         WHERE acquiring.id=$3 AND acquiring.space_id=binding.space_id
                           AND acquiring.status IN ('queued','running'))
            AND NOT ${leaseHeldSql("binding", "$3")}
          RETURNING binding.execution_lease_generation`,
        [bindingId, leaseId, holder.runId],
      );
      if (result.rows[0]) return { leaseId, generation: Number(result.rows[0].execution_lease_generation) };
      const active = await this.db.query(
        `SELECT 1 FROM runtime_context_cli_bindings WHERE id=$1 AND status='active'`,
        [bindingId],
      );
      if (!active.rows[0]) throw new HttpError(409, "CLI continuity binding is no longer active");
      return null;
    });
  }

  /**
   * Renews the lease while its holder runs. False once the lease is gone —
   * released, or taken over after it lapsed — and the holder's later
   * acknowledgements will be refused by its fencing generation.
   */
  async heartbeatExecutionLease(leaseId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE runtime_context_cli_bindings
          SET execution_lease_expires_at=now() + make_interval(secs => ${EXECUTION_LEASE_TTL_SECONDS})
        WHERE execution_lease_id=$1 AND status='active'`,
      [leaseId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async bindingForExecutionLease(bindingId: string, leaseId: string): Promise<PreparedCliBinding> {
    const result = await this.db.query<BindingRow>(
      `SELECT ${BINDING_COLUMNS}
         FROM runtime_context_cli_bindings
        WHERE id=$1 AND execution_lease_id=$2 AND status='active'`,
      [bindingId, leaseId],
    );
    if (!result.rows[0]) throw new HttpError(409, "CLI execution lease is no longer authoritative");
    return bindingOut(result.rows[0]);
  }

  /**
   * Released by the lease alone. An overflow rotation moves the lease onto a
   * replacement binding mid-turn, so the binding the caller acquired it on may
   * no longer hold it; the lease id is unique to one acquisition either way.
   */
  async releaseExecutionLease(leaseId: string): Promise<void> {
    await this.db.query(
      `UPDATE runtime_context_cli_bindings
          SET execution_lease_id=NULL,execution_lease_expires_at=NULL,execution_lease_run_id=NULL,updated_at=now()
        WHERE execution_lease_id=$1`,
      [leaseId],
    );
  }

  async prepareDelivery(input: {
    bindingId: string;
    /** The caller's acquired fencing token, never replaced by the current holder's. */
    leaseGeneration: number;
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
                acknowledged_item_ids_json,generation,rotation_reason,
                execution_lease_id,execution_lease_expires_at,execution_lease_run_id,execution_lease_generation
           FROM runtime_context_cli_bindings WHERE id=$1 FOR UPDATE`,
        [input.bindingId],
      );
      const binding = bindingResult.rows[0];
      if (!binding || binding.status !== "active"
        || binding.space_id !== input.spaceId
        || binding.work_context_scope_id !== input.workContextScopeId) {
        throw new HttpError(409, "CLI Delivery binding is no longer active for this work scope");
      }
      if (Number(binding.execution_lease_generation) !== input.leaseGeneration) {
        throw new HttpError(409, "CLI Delivery execution lease was taken over before planning");
      }
      const scope = await db.query<{ event_head_cursor: number }>(
        `SELECT event_head_cursor FROM context_event_scopes
          WHERE space_id=$1 AND work_context_scope_id=$2 FOR SHARE`,
        [input.spaceId, input.workContextScopeId],
      );
      const targetCursor = Number(scope.rows[0]?.event_head_cursor ?? 0);
      let effectiveBinding = binding;
      let mode: "full" | "delta" = binding.vendor_session_id ? "delta" : "full";
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
      let events = mode === "delta"
        ? await loadCliDeltaEvents(db, {
            spaceId: input.spaceId,
            workContextScopeId: input.workContextScopeId,
            afterCursor: binding.cli_known_cursor,
            throughCursor: targetCursor,
            currentMessageRef: input.currentMessageRef,
            knownBindingId: binding.id,
          })
        : await loadCliReconstructionEvents(db, {
            spaceId: input.spaceId,
            workContextScopeId: input.workContextScopeId,
            throughCursor: targetCursor,
            currentMessageRef: input.currentMessageRef,
            checkpoint,
          });
      let deltaText = mode === "full"
        ? renderCliReconstruction(checkpoint?.checkpoint_json ?? null, events)
        : renderCliEventDelta(events);
      if (mode === "delta" && deltaText && estimateModelTokens(deltaText) > CLI_REPLAY_TOKENS) {
        // A stale vendor cursor must never turn into an unbounded prompt. Rotate
        // to a fresh vendor session and reconstruct from the bounded checkpoint.
        await db.query(
          `UPDATE runtime_context_cli_bindings
              SET status='rotated',rotation_reason='overflow_reconstruction',
                  execution_lease_id=NULL,execution_lease_expires_at=NULL,execution_lease_run_id=NULL,
                  updated_at=now()
            WHERE id=$1 AND status='active'`,
          [binding.id],
        );
        const replacement = await db.query<BindingRow & { work_context_scope_id: string; space_id: string; status: string }>(
          `INSERT INTO runtime_context_cli_bindings (
             id,space_id,work_context_scope_id,scope_kind,user_id,agent_id,
             runtime_profile_id,runtime_key,provider_id,model,
             runtime_state_key,vendor_session_id,host_thread_id,authority_fingerprint,runtime_fingerprint,
             fingerprint_json,cli_known_cursor,acknowledged_item_ids_json,generation,
             status,rotation_reason,execution_lease_id,execution_lease_expires_at,
             execution_lease_run_id,execution_lease_generation,created_at,updated_at
           ) SELECT $2,space_id,work_context_scope_id,scope_kind,user_id,agent_id,
                    runtime_profile_id,runtime_key,provider_id,model,
                    $3,NULL,host_thread_id,authority_fingerprint,runtime_fingerprint,fingerprint_json,
                    0,'[]'::jsonb,generation+1,'active','overflow_reconstruction',$4,$5,$6,$7,now(),now()
               FROM runtime_context_cli_bindings
              WHERE id=$1
           RETURNING id,space_id,work_context_scope_id,status,runtime_state_key,vendor_session_id,
                     authority_fingerprint,runtime_fingerprint,fingerprint_json,cli_known_cursor,
                     acknowledged_item_ids_json,generation,rotation_reason,execution_lease_generation`,
          [binding.id, randomUUID(), randomUUID(),
            binding.execution_lease_id ?? null, binding.execution_lease_expires_at ?? null,
            binding.execution_lease_run_id ?? null, Number(binding.execution_lease_generation ?? 0)],
        );
        if (!replacement.rows[0]) throw new HttpError(409, "CLI continuity overflow rotation failed");
        effectiveBinding = replacement.rows[0];
        mode = "full";
        checkpoint = await loadActiveCheckpointForCli(db, input.spaceId, input.workContextScopeId, targetCursor);
        // The same source gate as a first full delivery: `authorizeCliDeltaItem`
        // refuses a checkpoint this viewer may not read, and the rotation
        // above has already committed by then, so the reconstruction must
        // leave it out here rather than fail the Run on it.
        if (checkpoint && !(await checkpointSourcesAuthorized(db, checkpoint.checkpoint_json, {
          spaceId: input.spaceId,
          workContextScopeId: input.workContextScopeId,
          viewerUserId: input.ownerUserId,
          authorizedRefs: input.authorizedSourceRefs,
        }))) {
          checkpoint = null;
        }
        events = await loadCliReconstructionEvents(db, {
          spaceId: input.spaceId,
          workContextScopeId: input.workContextScopeId,
          throughCursor: targetCursor,
          currentMessageRef: input.currentMessageRef,
          checkpoint,
        });
        deltaText = renderCliReconstruction(checkpoint?.checkpoint_json ?? null, events);
      }
      const deltaItem = deltaText
        ? normalizeContextItem({
            sourceRef: {
              type: mode === "full" ? "context_scope_reconstruction" : "context_event_range",
              id: effectiveBinding.id,
              version: mode === "full"
                ? String(targetCursor)
                : `${effectiveBinding.cli_known_cursor + 1}-${targetCursor}`,
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
                : effectiveBinding.cli_known_cursor,
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
        ...bindingOut(effectiveBinding),
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
    /** The fencing token the Delivery was planned under. */
    leaseGeneration: number;
  }): Promise<void> {
    const result = await db.query<{ cli_known_cursor: number; acknowledged_item_ids_json: unknown; execution_lease_generation: number }>(
      `SELECT cli_known_cursor,acknowledged_item_ids_json,execution_lease_generation
         FROM runtime_context_cli_bindings
        WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3 AND status='active'
        FOR UPDATE`,
      [input.bindingId, input.spaceId, input.workContextScopeId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(409, "CLI Delivery binding is no longer active");
    if (Number(row.execution_lease_generation) !== input.leaseGeneration) {
      throw new HttpError(409, "CLI Delivery was planned under an execution lease another Run has since taken over");
    }
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
    /** The fencing token the Delivery was planned under; a late holder records nothing. */
    leaseGeneration: number;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE runtime_context_cli_bindings
          SET vendor_session_id=$3,updated_at=now()
        WHERE id=$1 AND runtime_state_key=$2 AND status='active' AND execution_lease_generation=$4`,
      [input.bindingId, input.runtimeStateKey, input.vendorSessionId, input.leaseGeneration],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * The vendor session an active binding names, while the given lease
   * generation still holds it; null once another Run has taken it over.
   */
  async vendorSessionUnderLease(bindingId: string, leaseGeneration: number): Promise<string | null> {
    const result = await this.db.query<{ vendor_session_id: string | null }>(
      `SELECT vendor_session_id FROM runtime_context_cli_bindings
        WHERE id=$1 AND status='active' AND execution_lease_generation=$2`,
      [bindingId, leaseGeneration],
    );
    return result.rows[0]?.vendor_session_id ?? null;
  }

  private async activeBinding(db: Queryable, input: {
    spaceId: string;
    workContextScopeId: string;
    userId: string;
    agentId: string;
    hostThreadId?: string | null;
  }, runId: string): Promise<BindingRow | null> {
    const result = await db.query<BindingRow>(
      `SELECT ${BINDING_COLUMNS},
              ${leaseHeldSql("binding", "$5")} AS leased
         FROM runtime_context_cli_bindings binding
        WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3 AND agent_id=$4
          AND host_thread_id IS NOT DISTINCT FROM $6
          AND status='active' FOR UPDATE OF binding`,
      [input.spaceId, input.workContextScopeId, input.userId, input.agentId, runId, input.hostThreadId ?? null],
    );
    return result.rows[0] ?? null;
  }
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
  knownBindingId?: string;
}): Promise<CliDeltaEvent[]> {
  const result = await db.query<CliDeltaEvent & {
    run_prompt: string | null; run_instruction: string | null; run_request_includes_instruction: boolean | null;
  }>(
    `SELECT event.id,event.scope_sequence,event.event_type,
            event.canonical_ref_json->>'type' AS canonical_type,
            event.canonical_ref_json->>'id' AS canonical_id,
            run.prompt AS run_prompt,run.instruction AS run_instruction,
            (run.model_override_json->'${RUN_REQUEST_INCLUDES_INSTRUCTION}')='true'::jsonb AS run_request_includes_instruction,
            run.status AS run_status,
            CASE
              WHEN event.canonical_ref_json->>'type'='message' THEN message.content
              WHEN event.canonical_ref_json->>'type'='run_request' THEN NULL
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
           OR (event.canonical_ref_json->>'type'='message'
             AND run.id=message.run_id)
         )
      WHERE event.space_id=$1 AND event.work_context_scope_id=$2
        AND event.scope_sequence>$3 AND event.scope_sequence<=$4
        AND NOT (event.canonical_ref_json->>'type'=$5 AND event.canonical_ref_json->>'id'=$6)
        AND NOT ($7::varchar IS NOT NULL
          AND event.event_type IN ('assistant_message_completed','run_request_received','tool_call_completed','tool_call_failed','run_terminal')
          AND EXISTS (
            SELECT 1 FROM invocation_deliveries delivery
              JOIN invocation_snapshots snapshot ON snapshot.delivery_id=delivery.id AND snapshot.space_id=delivery.space_id
             WHERE delivery.space_id=event.space_id AND delivery.invocation_id=event.invocation_id
               AND delivery.delivery_metadata_json->'cli_session'->'binding_ref'->>'id'=$7
               AND snapshot.safe_snapshot_json->'acknowledgement'->>'status'='accepted'
          ))
      ORDER BY event.scope_sequence`,
    [input.spaceId, input.workContextScopeId, input.afterCursor, input.throughCursor,
      input.currentMessageRef.type, input.currentMessageRef.id, input.knownBindingId ?? null],
  );
  return result.rows.map((row) => ({
    ...row,
    scope_sequence: Number(row.scope_sequence),
    content: row.canonical_type === "run_request"
      ? historicalRunRequest({
        prompt: row.run_prompt,
        instruction: row.run_instruction,
        model_override_json: { [RUN_REQUEST_INCLUDES_INSTRUCTION]: row.run_request_includes_instruction === true },
      })
      : row.content,
  }));
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
        knownBindingId: input.item.source_ref.id,
      });
  const rendered = full
    ? renderCliReconstruction(checkpoint?.checkpoint_json ?? null, events)
    : renderCliEventDelta(events);
  if (!rendered || contextItemText(input.item) !== rendered) {
    throw new HttpError(409, "CLI Delivery event delta changed after planning");
  }
}

function bindingFingerprint(input: {
  spaceId: string;
  userId: string;
  agentId: string;
  runtimeProfileId: string;
  runtimeKey: string;
  providerId: string | null;
  model: string | null;
  agentVersionId: string;
  runtimeInstallation: string | null;
  control: ExecutionControlSnapshot;
}, generations: {
  egress: unknown;
  runtime: unknown;
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
      tool_grant_refs: sessionToolGrantRefs(input.control.tool_grant_refs),
      egress: input.control.egress,
      egress_generation: generations.egress,
      agent_version_id: input.agentVersionId,
    },
    runtime: {
      runtime_profile_id: input.runtimeProfileId,
      runtime_key: input.runtimeKey,
      provider_id: input.providerId,
      model: input.model,
      runtime_installation: input.runtimeInstallation,
      sandbox_profile_ref: input.control.sandbox_profile_ref,
      runtime_generation: generations.runtime,
      provider_generation: generations.provider,
    },
  };
}

/**
 * The tool grants a vendor session is bound to. The input-resource tools are
 * granted only for a turn whose message carries resources, so they come and
 * go with attachments; counting them would rotate the session twice per
 * attached message. The server still checks every call against that turn's
 * own grants, so a session that remembers them cannot use them later.
 */
function sessionToolGrantRefs(refs: ExecutionControlSnapshot["tool_grant_refs"]): ExecutionControlSnapshot["tool_grant_refs"] {
  return refs.filter((ref) => !(INPUT_RESOURCE_TOOL_ALLOWANCE as readonly string[]).includes(ref.id));
}

function rotationReason(previous: unknown, next: BindingFingerprint): CliRotationReason {
  const before = record(previous) as Partial<BindingFingerprint>;
  if (hash(before.runtime) !== hash(next.runtime)) {
    const oldRuntime = record(before.runtime);
    // A different copy on the host is a different login.
    if (oldRuntime.runtime_installation !== next.runtime.runtime_installation) return "credential_changed";
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
    lease_generation: Number(row.execution_lease_generation ?? 0),
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
  providerId: string | null;
}): Promise<{ egress: unknown; runtime: unknown; provider: unknown }> {
  const egress = await db.query(
    `SELECT settings_json FROM settings
      WHERE scope_type='space' AND scope_id=$1
        AND settings_key='runtime_context.cli_egress_generation'`,
    [input.spaceId],
  );
  const runtime = await db.query(
    `SELECT updated_at,runtime_key,model_provider_id,model_name,
            runtime_config_json,runtime_policy_json,enabled
       FROM agent_runtime_profiles
      WHERE id=$1 AND space_id=$2 AND agent_id=$3`,
    [input.runtimeProfileId, input.spaceId, input.agentId],
  );
  const provider = input.providerId
    ? await db.query(
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
    : { rows: [] };
  if (!runtime.rows[0]) throw new HttpError(409, "CLI runtime profile is no longer authoritative");
  if (input.providerId && !provider.rows[0]) {
    throw new HttpError(409, "CLI provider configuration is no longer authoritative");
  }
  return {
    egress: jsonSafe(egress.rows[0] ?? { default_external_egress: true }),
    runtime: jsonSafe(runtime.rows[0]),
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
