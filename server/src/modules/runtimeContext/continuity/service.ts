import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type {
  ContextEvent,
  MicroCheckpoint,
  RuntimeContextEventIngress,
  SemanticCheckpoint,
} from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { HttpError, withQueryableTransaction } from "../../routeUtils/common.js";
import type { SpaceUserIdentity } from "../../routeUtils/common.js";
import { assertActiveWorkContextReadable } from "../workContextService.js";

type Ref = { type: string; id: string; version?: string | null };

interface InvocationAuthority {
  space_id: string;
  invocation_id: string;
  work_context_scope_id: string;
  actor_user_id: string | null;
  agent_id: string | null;
}

interface CanonicalAuthority {
  trust: "system_approved" | "user_confirmed" | "domain_approved" | "derived" | "external_untrusted";
  sensitivity: "normal" | "sensitive" | "restricted" | "highly_restricted";
  confirmationState: "observed" | "candidate" | "confirmed" | "corrected";
  sourceRefs: Ref[];
  actorUserId?: string | null;
}

/**
 * The invocation never acquired a Runtime Context authority — normal for a
 * Run that died before execution (routing failure, admission refusal).
 * Callers that finalize such Runs skip context finalization on this type
 * instead of matching error text.
 */
export class InvocationAuthorityNotFoundError extends HttpError {
  constructor() {
    super(404, "Runtime Context invocation authority not found");
    this.name = "InvocationAuthorityNotFoundError";
  }
}

/**
 * The sole writer for ordered Runtime Context continuity. All sequence and
 * checkpoint mutations run under the same per-scope transaction lock. The
 * ledger is an audit record: nothing here extracts from it or replays it into
 * a vendor session (ADR 0014 §11).
 */
export class RuntimeContextContinuityService {
  constructor(private readonly db: Queryable) {}

  async ingest(input: RuntimeContextEventIngress): Promise<ContextEvent> {
    return withQueryableTransaction(this.db, async (db) => {
      const authority = await this.resolveInvocation(db, input.invocation_id);
      return this.appendCanonicalEvent(db, authority, input, "complete");
    });
  }

  /** Record a non-critical capture failure durably; callers still receive an error. */
  async recordCaptureGap(input: {
    invocationId: string;
    code: string;
    detail?: string | null;
    event?: RuntimeContextEventIngress;
  }): Promise<void> {
    await withQueryableTransaction(this.db, async (db) => {
      const authority = await this.resolveInvocation(db, input.invocationId);
      await this.lockScope(db, authority);
      const scope = await this.scopeRow(db, authority);
      await db.query(
        `INSERT INTO context_capture_gaps
           (id,space_id,work_context_scope_id,invocation_id,code,after_cursor,before_cursor,detail,replay_event_json,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8::jsonb,'open',$9)`,
        [randomUUID(), authority.space_id, authority.work_context_scope_id,
          authority.invocation_id, input.code, scope.event_head_cursor,
          input.detail?.slice(0, 2000) ?? null,
          input.event ? JSON.stringify(input.event) : null, new Date().toISOString()],
      );
      await this.setCaptureStatus(db, authority, "partial");
    });
  }

  /**
   * Capture a terminal invocation snapshot and atomically materialize its
   * deterministic Micro Checkpoint.  This is called from snapshot finalization
   * before that finalization can commit.
   */
  async finalizeInvocationInTransaction(
    db: Queryable,
    input: { spaceId: string; invocationId: string; snapshotId: string },
  ): Promise<MicroCheckpoint> {
    const authority = await this.resolveInvocation(db, input.invocationId, input.spaceId);
    await this.appendCanonicalEvent(db, authority, {
      invocation_id: input.invocationId,
      event_type: "invocation_finalized",
      canonical_ref: { type: "invocation_snapshot", id: input.snapshotId },
      semantic_role: null,
      token_estimate: 0,
    }, "complete");
    return this.createMicroCheckpointInTransaction(db, authority);
  }

  /** Capture the final canonical assistant/failure message at the turn boundary. */
  async finalizeChatTurn(input: {
    invocationId: string;
    messageId: string | null;
    failedRun?: boolean;
  }): Promise<MicroCheckpoint> {
    return withQueryableTransaction(this.db, async (db) => {
      const authority = await this.resolveInvocation(db, input.invocationId);
      await this.appendCanonicalEvent(db, authority, {
        invocation_id: input.invocationId,
        event_type: input.messageId ? "assistant_message_completed" : "run_terminal",
        canonical_ref: input.messageId
          ? { type: "message", id: input.messageId }
          : { type: "run", id: input.invocationId },
        semantic_role: input.messageId ? "reference_data" : null,
        token_estimate: 0,
      }, "complete");
      return this.createMicroCheckpointInTransaction(db, authority);
    });
  }

  /** Append an immutable correction and supersede the active projection. */
  async correctSemanticCheckpoint(input: {
    spaceId: string;
    workContextScopeId: string;
    checkpointId: string;
    identity: SpaceUserIdentity;
    canonicalRef: Ref;
    correction: Record<string, unknown>;
  }): Promise<string> {
    return withQueryableTransaction(this.db, async (db) => {
      if (input.identity.spaceId !== input.spaceId) {
        throw new HttpError(403, "Checkpoint correction Space authority mismatch");
      }
      const authority: InvocationAuthority = {
        space_id: input.spaceId, invocation_id: input.workContextScopeId,
        work_context_scope_id: input.workContextScopeId, actor_user_id: input.identity.userId, agent_id: null,
      };
      await this.lockScope(db, authority);
      await assertActiveWorkContextReadable(db, input.identity, input.workContextScopeId);
      const active = await this.latestSemantic(db, input.spaceId, input.workContextScopeId, true);
      if (!active || active.id !== input.checkpointId) throw new HttpError(409, "Semantic checkpoint is not active");
      const canonical = await this.resolveCanonical(db, authority, input.canonicalRef);
      if (canonical.trust !== "user_confirmed" || canonical.actorUserId !== input.identity.userId) {
        throw new HttpError(422, "Correction requires a canonical message from the correcting user");
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO context_checkpoint_corrections
           (id,space_id,work_context_scope_id,semantic_checkpoint_id,canonical_ref_json,correction_json,created_by_user_id,created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
        [id, input.spaceId, input.workContextScopeId, input.checkpointId,
          JSON.stringify(input.canonicalRef), JSON.stringify(input.correction), input.identity.userId, now],
      );
      await this.appendCanonicalEvent(db, authority, {
        invocation_id: authority.invocation_id,
        event_type: "checkpoint_corrected",
        canonical_ref: { type: "checkpoint_correction", id },
        semantic_role: "reference_data",
        token_estimate: 0,
      }, "complete", { skipCanonicalResolution: true, override: canonical });
      await this.createMicroCheckpointInTransaction(db, authority);
      return id;
    });
  }

  private async appendCanonicalEvent(
    db: Queryable,
    authority: InvocationAuthority,
    input: RuntimeContextEventIngress,
    captureStatus: "complete" | "recovered" | "partial",
    options: { skipCanonicalResolution?: boolean; override?: CanonicalAuthority } = {},
  ): Promise<ContextEvent> {
    await this.lockScope(db, authority);
    const canonical = options.override ?? (options.skipCanonicalResolution
      ? { trust: "user_confirmed", sensitivity: "normal", confirmationState: "corrected", sourceRefs: [input.canonical_ref] } as CanonicalAuthority
      : await this.resolveCanonical(db, authority, input.canonical_ref));
    const key = refKey(input.canonical_ref);
    const existing = await db.query<{ event_json: unknown }>(
      `SELECT jsonb_build_object(
         'id',id,'space_id',space_id,'work_context_scope_id',work_context_scope_id,
         'scope_sequence',scope_sequence,'event_type',event_type,'canonical_ref',canonical_ref_json,
         'actor_user_id',actor_user_id,'agent_id',agent_id,'invocation_id',invocation_id,
         'semantic_role',semantic_role,'trust',trust,'sensitivity',sensitivity,
         'token_estimate',token_estimate,'confirmation_state',confirmation_state,
         'source_refs',source_refs_json,'capture_status',capture_status,'created_at',created_at
       ) AS event_json FROM context_events
       WHERE space_id=$1 AND work_context_scope_id=$2 AND event_type=$3 AND canonical_ref_key=$4`,
      [authority.space_id, authority.work_context_scope_id, input.event_type, key],
    );
    if (existing.rows[0]) return protocol.ContextEventSchema.parse(existing.rows[0].event_json) as ContextEvent;
    const scope = await this.scopeRow(db, authority);
    const sequence = scope.event_head_cursor + 1;
    const now = new Date().toISOString();
    const event = protocol.ContextEventSchema.parse({
      id: randomUUID(), space_id: authority.space_id,
      work_context_scope_id: authority.work_context_scope_id,
      scope_sequence: sequence, event_type: input.event_type,
      canonical_ref: input.canonical_ref, actor_user_id: authority.actor_user_id,
      agent_id: authority.agent_id, invocation_id: authority.invocation_id,
      semantic_role: input.semantic_role, trust: canonical.trust,
      sensitivity: canonical.sensitivity, token_estimate: input.token_estimate,
      confirmation_state: canonical.confirmationState,
      source_refs: canonical.sourceRefs, capture_status: captureStatus, created_at: now,
    }) as ContextEvent;
    await db.query(
      `INSERT INTO context_events
       (id,space_id,work_context_scope_id,scope_sequence,event_type,canonical_ref_json,canonical_ref_key,
        actor_user_id,agent_id,invocation_id,semantic_role,trust,sensitivity,token_estimate,
        confirmation_state,source_refs_json,capture_status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)`,
      [event.id, event.space_id, event.work_context_scope_id, sequence, event.event_type,
        JSON.stringify(event.canonical_ref), key, event.actor_user_id, event.agent_id,
        event.invocation_id, event.semantic_role, event.trust, event.sensitivity,
        event.token_estimate, event.confirmation_state, JSON.stringify(event.source_refs),
        event.capture_status, now],
    );
    await db.query(
      `UPDATE context_event_scopes SET event_head_cursor=$3,updated_at=$4
        WHERE space_id=$1 AND work_context_scope_id=$2`,
      [authority.space_id, authority.work_context_scope_id, sequence, now],
    );
    return event;
  }

  private async createMicroCheckpointInTransaction(db: Queryable, authority: InvocationAuthority): Promise<MicroCheckpoint> {
    await this.lockScope(db, authority);
    const scope = await this.scopeRow(db, authority);
    const previousMicro = scope.active_micro_checkpoint_id
      ? await db.query<{ event_head_cursor: number }>(
        `SELECT (checkpoint_json->>'event_head_cursor')::int AS event_head_cursor
           FROM context_micro_checkpoints WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3`,
        [scope.active_micro_checkpoint_id, authority.space_id, authority.work_context_scope_id],
      )
      : { rows: [] as Array<{ event_head_cursor: number }> };
    const previousMicroHead = Number(previousMicro.rows[0]?.event_head_cursor ?? 0);
    const refs = await db.query<{ canonical_ref_json: Ref; event_type: string }>(
      `SELECT canonical_ref_json,event_type FROM context_events
        WHERE space_id=$1 AND work_context_scope_id=$2 AND scope_sequence>$3 AND scope_sequence<=$4
        ORDER BY scope_sequence`,
      [authority.space_id, authority.work_context_scope_id, previousMicroHead, scope.event_head_cursor],
    );
    const gaps = await db.query<{ code: string; after_cursor: number; before_cursor: number | null; detail: string | null }>(
      `SELECT code,after_cursor,before_cursor,detail FROM context_capture_gaps
        WHERE space_id=$1 AND work_context_scope_id=$2 AND status='open'
        ORDER BY created_at,id`,
      [authority.space_id, authority.work_context_scope_id],
    );
    const versionResult = await db.query<{ version: number }>(
      `SELECT COALESCE(max(version),0)+1 AS version FROM context_micro_checkpoints
        WHERE space_id=$1 AND work_context_scope_id=$2`,
      [authority.space_id, authority.work_context_scope_id],
    );
    const version = Number(versionResult.rows[0]?.version ?? 1);
    const now = new Date().toISOString();
    const captureStatus = gaps.rows.length > 0 ? "partial"
      : scope.capture_status === "partial" ? "recovered" : scope.capture_status;
    const byType = (types: string[]) => refs.rows
      .filter((row) => types.includes(row.canonical_ref_json.type))
      .map((row) => row.canonical_ref_json);
    const checkpoint = protocol.MicroCheckpointSchema.parse({
      id: randomUUID(), space_id: authority.space_id,
      work_context_scope_id: authority.work_context_scope_id, version,
      event_head_cursor: scope.event_head_cursor,
      checkpoint_cursor: scope.checkpoint_cursor,
      capture_status: captureStatus,
      message_refs: byType(["message"]), artifact_refs: byType(["artifact"]),
      tool_refs: byType(["tool_result", "run_event"]),
      invocation_snapshot_refs: byType(["invocation_snapshot"]),
      capture_gaps: gaps.rows.map((gap) => ({ ...gap, after_cursor: Number(gap.after_cursor), before_cursor: gap.before_cursor === null ? null : Number(gap.before_cursor) })),
      created_at: now,
    }) as MicroCheckpoint;
    await db.query(
      `INSERT INTO context_micro_checkpoints (id,space_id,work_context_scope_id,version,checkpoint_json,created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [checkpoint.id, checkpoint.space_id, checkpoint.work_context_scope_id,
        checkpoint.version, JSON.stringify(checkpoint), now],
    );
    await db.query(
      `UPDATE context_event_scopes SET capture_status=$3,
         active_micro_checkpoint_id=$4,updated_at=$5
       WHERE space_id=$1 AND work_context_scope_id=$2`,
      [authority.space_id, authority.work_context_scope_id,
        captureStatus, checkpoint.id, now],
    );
    return checkpoint;
  }

  private async resolveInvocation(db: Queryable, invocationId: string, spaceId?: string): Promise<InvocationAuthority> {
    const result = await db.query<InvocationAuthority>(
      `SELECT run.space_id,run.id AS invocation_id,
              control.snapshot_json->>'work_context_scope_id' AS work_context_scope_id,
              COALESCE(run.instructed_by_user_id,run.owner_user_id) AS actor_user_id,
              run.agent_id
         FROM runs run
         JOIN LATERAL (
           SELECT snapshot_json FROM execution_control_snapshots
            WHERE run_id=run.id AND space_id=run.space_id ORDER BY created_at DESC,id DESC LIMIT 1
         ) control ON true
        WHERE run.id=$1 AND ($2::text IS NULL OR run.space_id=$2)`,
      [invocationId, spaceId ?? null],
    );
    const row = result.rows[0];
    if (!row?.work_context_scope_id) throw new InvocationAuthorityNotFoundError();
    return row;
  }

  private async lockScope(db: Queryable, authority: InvocationAuthority): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`context-event:${authority.space_id}:${authority.work_context_scope_id}`]);
    await db.query(
      `INSERT INTO context_event_scopes (space_id,work_context_scope_id,updated_at)
       VALUES ($1,$2,$3) ON CONFLICT (space_id,work_context_scope_id) DO NOTHING`,
      [authority.space_id, authority.work_context_scope_id, new Date().toISOString()],
    );
    await db.query(
      `SELECT 1 FROM context_event_scopes WHERE space_id=$1 AND work_context_scope_id=$2 FOR UPDATE`,
      [authority.space_id, authority.work_context_scope_id],
    );
  }

  private async scopeRow(db: Queryable, authority: InvocationAuthority): Promise<{
    event_head_cursor: number; checkpoint_cursor: number;
    active_micro_checkpoint_id: string | null;
    capture_status: "complete" | "recovered" | "partial";
  }> {
    const result = await db.query<{
      event_head_cursor: string | number; checkpoint_cursor: string | number;
      active_micro_checkpoint_id: string | null;
      capture_status: "complete" | "recovered" | "partial";
    }>(
      `SELECT event_head_cursor,checkpoint_cursor,active_micro_checkpoint_id,capture_status
         FROM context_event_scopes WHERE space_id=$1 AND work_context_scope_id=$2`,
      [authority.space_id, authority.work_context_scope_id],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Context Event scope state is unavailable");
    return { ...row, event_head_cursor: Number(row.event_head_cursor), checkpoint_cursor: Number(row.checkpoint_cursor) };
  }

  private async resolveCanonical(db: Queryable, authority: InvocationAuthority, ref: Ref): Promise<CanonicalAuthority> {
    if (ref.type === "message") {
      const result = await db.query<{ role: string; user_id: string | null; sender_agent_id: string | null }>(
        `SELECT message.role,message.user_id,message.sender_agent_id
           FROM messages message
          WHERE message.id=$1 AND message.space_id=$2
            AND EXISTS (
              SELECT 1 FROM runs run
              JOIN execution_control_snapshots control
                ON control.run_id=run.id AND control.space_id=run.space_id
             WHERE run.space_id=message.space_id AND run.session_id=message.session_id
               AND ${controlInScope("control", "$3")}
            )`,
        [ref.id, authority.space_id, authority.work_context_scope_id],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(422, "Context Event canonical Message does not exist in scope");
      return { trust: row.role === "user" ? "user_confirmed" : "domain_approved", sensitivity: "normal",
        confirmationState: row.role === "user" ? "confirmed" : "observed", sourceRefs: [ref], actorUserId: row.user_id };
    }
    if (ref.type === "run_event") {
      const result = await db.query<{ event_type: string; status: string }>(
        `SELECT event.event_type,event.status FROM run_events event
          WHERE event.id=$1 AND event.space_id=$2
            AND EXISTS (
              SELECT 1 FROM execution_control_snapshots control
               WHERE control.run_id=event.run_id AND control.space_id=event.space_id
                 AND ${controlInScope("control", "$3")}
            )`,
        [ref.id, authority.space_id, authority.work_context_scope_id],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(422, "Context Event canonical Run Event does not exist in scope");
      const approved = row.status === "succeeded"
        && (row.event_type === "policy_checked" || row.event_type === "approval_resolved");
      return { trust: approved ? "system_approved" : "domain_approved", sensitivity: "normal",
        confirmationState: approved ? "confirmed" : "observed", sourceRefs: [ref] };
    }
    if (ref.type === "policy_decision_record") {
      const result = await db.query<{ decision: string }>(
        `SELECT policy.decision FROM policy_decision_records policy
          WHERE policy.id=$1 AND policy.space_id=$2 AND policy.run_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM execution_control_snapshots control
               WHERE control.run_id=policy.run_id AND control.space_id=policy.space_id
                 AND ${controlInScope("control", "$3")}
            )`,
        [ref.id, authority.space_id, authority.work_context_scope_id],
      );
      if (!result.rows[0]) throw new HttpError(422, "Context Event canonical Policy Decision does not exist in scope");
      return { trust: "system_approved", sensitivity: "normal",
        confirmationState: result.rows[0].decision === "allow" ? "confirmed" : "observed", sourceRefs: [ref] };
    }
    if (ref.type === "checkpoint_correction") {
      const result = await db.query<{ created_by_user_id: string }>(
        `SELECT created_by_user_id FROM context_checkpoint_corrections
          WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3`,
        [ref.id, authority.space_id, authority.work_context_scope_id],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(422, "Context Checkpoint correction does not exist in scope");
      return { trust: "user_confirmed", sensitivity: "normal", confirmationState: "corrected",
        sourceRefs: [ref], actorUserId: row.created_by_user_id };
    }
    const scopedQuery = ref.type === "run" || ref.type === "run_request"
      ? `SELECT 1 FROM runs value WHERE value.id=$1 AND value.space_id=$2 AND EXISTS
          (SELECT 1 FROM execution_control_snapshots control WHERE control.run_id=value.id AND control.space_id=value.space_id AND ${controlInScope("control", "$3")})`
      : ref.type === "invocation_snapshot"
        ? `SELECT 1 FROM invocation_snapshots value WHERE value.id=$1 AND value.space_id=$2 AND EXISTS
            (SELECT 1 FROM execution_control_snapshots control WHERE control.run_id=value.invocation_id AND control.space_id=value.space_id AND ${controlInScope("control", "$3")})`
        : ref.type === "artifact"
          ? `SELECT 1 FROM artifacts value WHERE value.id=$1 AND value.space_id=$2 AND value.run_id IS NOT NULL AND EXISTS
              (SELECT 1 FROM execution_control_snapshots control WHERE control.run_id=value.run_id AND control.space_id=value.space_id AND ${controlInScope("control", "$3")})`
          : null;
    if (!scopedQuery) throw new HttpError(422, `Unsupported Context Event canonical ref type '${ref.type}'`);
    const result = await db.query(scopedQuery, [ref.id, authority.space_id, authority.work_context_scope_id]);
    if (!result.rows[0]) throw new HttpError(422, "Context Event canonical ref does not exist in scope");
    return { trust: "domain_approved", sensitivity: "normal", confirmationState: "observed", sourceRefs: [ref] };
  }

  private async setCaptureStatus(db: Queryable, authority: InvocationAuthority, status: string): Promise<void> {
    await db.query(`UPDATE context_event_scopes SET capture_status=$3,updated_at=$4 WHERE space_id=$1 AND work_context_scope_id=$2`,
      [authority.space_id, authority.work_context_scope_id, status, new Date().toISOString()]);
  }

  private async latestSemantic(db: Queryable, spaceId: string, scopeId: string, lock = false): Promise<SemanticCheckpoint | null> {
    const result = await db.query<{ checkpoint_json: unknown }>(
      `SELECT checkpoint_json FROM context_semantic_checkpoints
        WHERE space_id=$1 AND work_context_scope_id=$2 AND status='active'
        ORDER BY version DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [spaceId, scopeId],
    );
    if (!result.rows[0]) return null;
    return protocol.SemanticCheckpointSchema.parse(result.rows[0].checkpoint_json) as SemanticCheckpoint;
  }

}

/**
 * SQL predicate: the Run of an execution control snapshot (`alias`) belongs to
 * the scope bound to `scope`. Either the snapshot names that scope, or the
 * scope is a Room Conversation scope split from the recipient scope the
 * snapshot names and the Run belongs to that Conversation. Snapshots are audit
 * records and keep naming the recipient scope their Run executed under; the
 * split (the repair part of `0002_skill_library_and_upgrade_repairs`) moved those Runs' events by exactly
 * this Conversation relation.
 */
function controlInScope(alias: string, scope: string): string {
  return `(${alias}.snapshot_json->>'work_context_scope_id'=${scope}
    OR EXISTS (SELECT 1 FROM room_conversation_recipients split
                 JOIN runs split_run ON split_run.id=${alias}.run_id AND split_run.space_id=${alias}.space_id
                WHERE split.id=${scope} AND split.space_id=${alias}.space_id
                  AND split.session_id=split_run.session_id
                  AND split.room_agent_member_id=${alias}.snapshot_json->>'work_context_scope_id'))`;
}

function refKey(ref: Ref): string { return `${ref.type}\u001f${ref.id}\u001f${ref.version ?? ""}`; }
