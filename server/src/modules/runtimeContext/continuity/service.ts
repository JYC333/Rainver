import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type {
  ContextEvent,
  MicroCheckpoint,
  RuntimeContextEventIngress,
  SemanticCheckpoint,
  SemanticCheckpointExtraction,
} from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import { HttpError, withQueryableTransaction } from "../../routeUtils/common.js";
import type { SpaceUserIdentity } from "../../routeUtils/common.js";
import { assertActiveWorkContextReadable } from "../workContextService.js";
import { wakeJobWorkers } from "../../jobs/wakeSignal.js";
import type { RetrievalEgressPolicy } from "../../retrieval/egress/egressPolicy.js";

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

export interface SemanticCheckpointProviderPort {
  extract(input: {
    spaceId: string;
    workContextScopeId: string;
    previous: SemanticCheckpoint | null;
    events: ContextEvent[];
    egressPolicy: RetrievalEgressPolicy;
  }): Promise<{ extraction: unknown; extractorRef: Ref }>;
}

/**
 * The sole writer for ordered Runtime Context continuity.  All sequence and
 * checkpoint mutations run under the same per-scope transaction lock.
 */
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

export class RuntimeContextContinuityService {
  constructor(
    private readonly db: Queryable,
    private readonly semanticProvider?: SemanticCheckpointProviderPort,
  ) {}

  async ingest(input: RuntimeContextEventIngress): Promise<ContextEvent> {
    return withQueryableTransaction(this.db, async (db) => {
      const authority = await this.resolveInvocation(db, input.invocation_id);
      const event = await this.appendCanonicalEvent(db, authority, input, "complete");
      if (input.event_type === "provider_compacted") {
        await this.ensureCheckpointJob(db, authority, event.scope_sequence);
      }
      return event;
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

  /** Replay one buffered non-critical event and close its immutable gap row. */
  async recoverCaptureGap(input: {
    gapId: string;
    event: RuntimeContextEventIngress;
  }): Promise<ContextEvent> {
    return withQueryableTransaction(this.db, async (db) => {
      const gap = await db.query<{ space_id: string; work_context_scope_id: string; invocation_id: string | null; status: string }>(
        `SELECT space_id,work_context_scope_id,invocation_id,status
           FROM context_capture_gaps WHERE id=$1 FOR UPDATE`,
        [input.gapId],
      );
      const row = gap.rows[0];
      if (!row) throw new HttpError(404, "Context capture gap not found");
      if (row.status !== "open") throw new HttpError(409, "Context capture gap is already recovered");
      if (row.invocation_id !== input.event.invocation_id) throw new HttpError(409, "Buffered event does not match its capture gap");
      const authority = await this.resolveInvocation(db, input.event.invocation_id, row.space_id);
      if (authority.work_context_scope_id !== row.work_context_scope_id) throw new HttpError(409, "Capture gap scope changed");
      const event = await this.appendCanonicalEvent(db, authority, input.event, "recovered");
      const now = new Date().toISOString();
      await db.query(`UPDATE context_capture_gaps SET status='recovered',resolved_at=$2 WHERE id=$1`, [input.gapId, now]);
      const remaining = await db.query(`SELECT 1 FROM context_capture_gaps WHERE space_id=$1 AND work_context_scope_id=$2 AND status='open' LIMIT 1`,
        [row.space_id, row.work_context_scope_id]);
      await this.setCaptureStatus(db, authority, remaining.rows.length > 0 ? "partial" : "recovered");
      return event;
    });
  }

  /** Replay every durable non-critical ingress for a scope before reconciliation. */
  async recoverOpenCaptureGaps(spaceId: string, workContextScopeId: string): Promise<number> {
    const result = await this.db.query<{ id: string; replay_event_json: unknown }>(
      `SELECT id,replay_event_json FROM context_capture_gaps
        WHERE space_id=$1 AND work_context_scope_id=$2 AND status='open'
          AND replay_event_json IS NOT NULL ORDER BY created_at,id`,
      [spaceId, workContextScopeId],
    );
    let recovered = 0;
    for (const row of result.rows) {
      const event = protocol.RuntimeContextEventIngressSchema.parse(row.replay_event_json) as RuntimeContextEventIngress;
      await this.recoverCaptureGap({ gapId: row.id, event });
      recovered += 1;
    }
    return recovered;
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
    const checkpoint = await this.createMicroCheckpointInTransaction(db, authority);
    await this.ensureCheckpointJob(db, authority, checkpoint.event_head_cursor);
    return checkpoint;
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
      const checkpoint = await this.createMicroCheckpointInTransaction(db, authority);
      await this.ensureCheckpointJob(db, authority, checkpoint.event_head_cursor);
      return checkpoint;
    });
  }

  /**
   * Conditional one-shot semantic extraction. Provider execution is outside a
   * transaction; persistence re-locks and rejects stale/non-canonical output.
   */
  async runSemanticExtraction(input: {
    spaceId: string;
    workContextScopeId: string;
    force?: boolean;
  }): Promise<SemanticCheckpoint | null> {
    if (!this.semanticProvider) return null;
    const selected = await this.selectSemanticInput(input.spaceId, input.workContextScopeId);
    if (!input.force && selected.events.length < 12 && !selected.events.some(isSemanticTrigger)) return null;
    if (selected.events.length === 0) return selected.previous;
    const result = await this.semanticProvider.extract({
      spaceId: input.spaceId,
      workContextScopeId: input.workContextScopeId,
      previous: selected.previous,
      events: selected.events,
      egressPolicy: await this.resolveExtractionEgressPolicy(input.spaceId, input.workContextScopeId),
    });
    const extraction = protocol.SemanticCheckpointExtractionSchema.parse(result.extraction) as SemanticCheckpointExtraction;
    return withQueryableTransaction(this.db, async (db) => {
      const authority: InvocationAuthority = {
        space_id: input.spaceId,
        invocation_id: selected.events.at(-1)?.invocation_id ?? input.workContextScopeId,
        work_context_scope_id: input.workContextScopeId,
        actor_user_id: null,
        agent_id: null,
      };
      await this.lockScope(db, authority);
      const scope = await this.scopeRow(db, authority);
      if (scope.event_head_cursor !== selected.safeHead) {
        throw new HttpError(409, "Semantic checkpoint input became stale");
      }
      const sources = await this.validateExtractionRefs(db, authority, extraction, selected.events, selected.previous);
      const current = await this.latestSemantic(db, input.spaceId, input.workContextScopeId, true);
      if ((current?.id ?? null) !== (selected.previous?.id ?? null)) {
        throw new HttpError(409, "Semantic checkpoint base became stale");
      }
      const version = (current?.version ?? 0) + 1;
      const now = new Date().toISOString();
      const checkpoint = protocol.SemanticCheckpointSchema.parse({
        id: randomUUID(),
        space_id: input.spaceId,
        work_context_scope_id: input.workContextScopeId,
        version,
        covered_cursor: selected.safeHead,
        ...enrichExtraction(extraction, sources),
        source_refs: sources,
        extractor_ref: result.extractorRef,
        created_at: now,
      }) as SemanticCheckpoint;
      if (current) {
        await db.query(`UPDATE context_semantic_checkpoints SET status='superseded' WHERE id=$1 AND status='active'`, [current.id]);
      }
      await db.query(
        `INSERT INTO context_semantic_checkpoints
           (id,space_id,work_context_scope_id,version,covered_cursor,status,checkpoint_json,extractor_ref_json,supersedes_id,created_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6::jsonb,$7::jsonb,$8,$9)`,
        [checkpoint.id, input.spaceId, input.workContextScopeId, version,
          selected.safeHead, JSON.stringify(checkpoint), JSON.stringify(result.extractorRef),
          current?.id ?? null, now],
      );
      await db.query(
        `UPDATE context_event_scopes
            SET checkpoint_cursor=$3,active_semantic_checkpoint_id=$4,updated_at=$5
          WHERE space_id=$1 AND work_context_scope_id=$2`,
        [input.spaceId, input.workContextScopeId, selected.safeHead, checkpoint.id, now],
      );
      return checkpoint;
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
      const micro = await this.createMicroCheckpointInTransaction(db, authority);
      await this.ensureCheckpointJob(db, authority, micro.event_head_cursor);
      return id;
    });
  }

  /** Scan durable rows and expose sequence/ref/terminal mismatches as gaps. */
  async reconcileScope(spaceId: string, workContextScopeId: string): Promise<"complete" | "recovered" | "partial"> {
    return withQueryableTransaction(this.db, async (db) => {
      const authority: InvocationAuthority = {
        space_id: spaceId, invocation_id: workContextScopeId, work_context_scope_id: workContextScopeId,
        actor_user_id: null, agent_id: null,
      };
      await this.lockScope(db, authority);
      const scope = await this.scopeRow(db, authority);
      const sequence = await db.query<{ count: number; maximum: number | null }>(
        `SELECT count(*)::int AS count,max(scope_sequence)::int AS maximum
           FROM context_events WHERE space_id=$1 AND work_context_scope_id=$2`,
        [spaceId, workContextScopeId],
      );
      const count = Number(sequence.rows[0]?.count ?? 0);
      const maximum = Number(sequence.rows[0]?.maximum ?? 0);
      const refs = await db.query<{ id: string; canonical_ref_json: Ref }>(
        `SELECT id,canonical_ref_json FROM context_events
          WHERE space_id=$1 AND work_context_scope_id=$2 ORDER BY scope_sequence`,
        [spaceId, workContextScopeId],
      );
      let badRefId: string | null = null;
      for (const event of refs.rows) {
        try {
          await this.resolveCanonical(db, authority, event.canonical_ref_json);
        } catch {
          badRefId = event.id;
          break;
        }
      }
      const terminalGap = await db.query<{ id: string }>(
        `SELECT snapshot.id FROM invocation_snapshots snapshot
          JOIN execution_control_snapshots control ON control.run_id=snapshot.invocation_id AND control.space_id=snapshot.space_id
         WHERE snapshot.space_id=$1 AND control.snapshot_json->>'work_context_scope_id'=$2
           AND snapshot.status='finalized'
           AND NOT EXISTS (
             SELECT 1 FROM context_events event
              WHERE event.space_id=snapshot.space_id AND event.invocation_id=snapshot.invocation_id
                AND event.event_type='invocation_finalized'
                AND event.canonical_ref_json->>'id'=snapshot.id
           ) LIMIT 1`,
        [spaceId, workContextScopeId],
      );
      const cursorMismatch = await db.query<{ id: string }>(
        `SELECT snapshot.id FROM invocation_snapshots snapshot
          JOIN execution_control_snapshots control ON control.run_id=snapshot.invocation_id AND control.space_id=snapshot.space_id
         WHERE snapshot.space_id=$1 AND control.snapshot_json->>'work_context_scope_id'=$2
           AND snapshot.safe_snapshot_json->>'capture_status'='complete'
           AND (
             snapshot.safe_snapshot_json->>'checkpoint_cursor' IS NULL
             OR (snapshot.safe_snapshot_json->>'checkpoint_cursor')::int > $3
           ) LIMIT 1`,
        [spaceId, workContextScopeId, scope.event_head_cursor],
      );
      const partial = count !== maximum || maximum !== scope.event_head_cursor
        || badRefId !== null || terminalGap.rows.length > 0 || cursorMismatch.rows.length > 0;
      if (partial) {
        await this.insertGapIfMissing(db, authority, "reconciliation_mismatch", scope.event_head_cursor,
          `count=${count}; max=${maximum}; bad_ref=${badRefId ?? "none"}; terminal=${terminalGap.rows[0]?.id ?? "none"}; cursor=${cursorMismatch.rows[0]?.id ?? "none"}`);
        await this.setCaptureStatus(db, authority, "partial");
        return "partial";
      }
      const open = await db.query(`SELECT 1 FROM context_capture_gaps WHERE space_id=$1 AND work_context_scope_id=$2 AND status='open' LIMIT 1`, [spaceId, workContextScopeId]);
      const status = open.rows.length > 0 ? "partial" : scope.capture_status === "partial" ? "recovered" : scope.capture_status;
      await this.setCaptureStatus(db, authority, status);
      return status;
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
      cli_known_cursor: scope.cli_known_cursor,
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
    event_head_cursor: number; checkpoint_cursor: number; cli_known_cursor: number | null;
    active_micro_checkpoint_id: string | null;
    capture_status: "complete" | "recovered" | "partial";
  }> {
    const result = await db.query<any>(
      `SELECT event_head_cursor,checkpoint_cursor,cli_known_cursor,active_micro_checkpoint_id,capture_status
         FROM context_event_scopes WHERE space_id=$1 AND work_context_scope_id=$2`,
      [authority.space_id, authority.work_context_scope_id],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Context Event scope state is unavailable");
    return { ...row, event_head_cursor: Number(row.event_head_cursor), checkpoint_cursor: Number(row.checkpoint_cursor), cli_known_cursor: row.cli_known_cursor === null ? null : Number(row.cli_known_cursor) };
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
               AND control.snapshot_json->>'work_context_scope_id'=$3
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
                 AND control.snapshot_json->>'work_context_scope_id'=$3
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
                 AND control.snapshot_json->>'work_context_scope_id'=$3
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
          (SELECT 1 FROM execution_control_snapshots control WHERE control.run_id=value.id AND control.space_id=value.space_id AND control.snapshot_json->>'work_context_scope_id'=$3)`
      : ref.type === "invocation_snapshot"
        ? `SELECT 1 FROM invocation_snapshots value WHERE value.id=$1 AND value.space_id=$2 AND EXISTS
            (SELECT 1 FROM execution_control_snapshots control WHERE control.run_id=value.invocation_id AND control.space_id=value.space_id AND control.snapshot_json->>'work_context_scope_id'=$3)`
        : ref.type === "artifact"
          ? `SELECT 1 FROM artifacts value WHERE value.id=$1 AND value.space_id=$2 AND value.run_id IS NOT NULL AND EXISTS
              (SELECT 1 FROM execution_control_snapshots control WHERE control.run_id=value.run_id AND control.space_id=value.space_id AND control.snapshot_json->>'work_context_scope_id'=$3)`
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

  private async insertGapIfMissing(db: Queryable, authority: InvocationAuthority, code: string, after: number, detail: string): Promise<void> {
    const found = await db.query(`SELECT 1 FROM context_capture_gaps WHERE space_id=$1 AND work_context_scope_id=$2 AND code=$3 AND status='open' LIMIT 1`,
      [authority.space_id, authority.work_context_scope_id, code]);
    if (found.rows[0]) return;
    await db.query(`INSERT INTO context_capture_gaps (id,space_id,work_context_scope_id,invocation_id,code,after_cursor,before_cursor,detail,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,'open',$8)`,
      [randomUUID(), authority.space_id, authority.work_context_scope_id, authority.invocation_id, code, after, detail.slice(0, 2000), new Date().toISOString()]);
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

  private async selectSemanticInput(spaceId: string, scopeId: string): Promise<{ previous: SemanticCheckpoint | null; events: ContextEvent[]; safeHead: number }> {
    return withQueryableTransaction(this.db, async (db) => {
      const authority: InvocationAuthority = { space_id: spaceId, invocation_id: scopeId, work_context_scope_id: scopeId, actor_user_id: null, agent_id: null };
      await this.lockScope(db, authority);
      const scope = await this.scopeRow(db, authority);
      if (scope.capture_status === "partial") throw new HttpError(409, "Cannot extract a checkpoint across capture gaps");
      const previous = await this.latestSemantic(db, spaceId, scopeId);
      const after = previous?.covered_cursor ?? 0;
      const rows = await db.query<{ event_json: unknown }>(
        `SELECT jsonb_build_object('id',id,'space_id',space_id,'work_context_scope_id',work_context_scope_id,
          'scope_sequence',scope_sequence,'event_type',event_type,'canonical_ref',canonical_ref_json,
          'actor_user_id',actor_user_id,'agent_id',agent_id,'invocation_id',invocation_id,
          'semantic_role',semantic_role,'trust',trust,'sensitivity',sensitivity,'token_estimate',token_estimate,
          'confirmation_state',confirmation_state,'source_refs',source_refs_json,'capture_status',capture_status,'created_at',created_at) AS event_json
         FROM context_events WHERE space_id=$1 AND work_context_scope_id=$2 AND scope_sequence>$3 AND scope_sequence<=$4 ORDER BY scope_sequence`,
        [spaceId, scopeId, after, scope.event_head_cursor],
      );
      return { previous, events: rows.rows.map((row) => protocol.ContextEventSchema.parse(row.event_json) as ContextEvent), safeHead: scope.event_head_cursor };
    });
  }

  private async ensureCheckpointJob(db: Queryable, authority: InvocationAuthority, targetCursor: number): Promise<void> {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO jobs
         (id,space_id,user_id,agent_id,job_type,status,priority,payload_json,attempts,max_attempts,scheduled_at,created_at,updated_at)
       SELECT $1::varchar(36),$2::varchar(36),$3::varchar(36),$4::varchar(36),
              'runtime_context_checkpoint','pending',10,$5::jsonb,0,5,
              $6::timestamptz,$6::timestamptz,$6::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM jobs WHERE space_id=$2::varchar(36) AND job_type='runtime_context_checkpoint'
            AND payload_json->>'work_context_scope_id'=$7
            AND (payload_json->>'target_cursor')::int=$8
            AND status IN ('pending','claimed','running','completed')
        ) ON CONFLICT DO NOTHING`,
      [randomUUID(), authority.space_id, authority.actor_user_id, authority.agent_id,
        JSON.stringify({ work_context_scope_id: authority.work_context_scope_id, target_cursor: targetCursor }),
        now, authority.work_context_scope_id, targetCursor],
    );
    // This path inserts straight into `jobs` rather than going through
    // `PgJobQueueRepository`, so it has to raise the wake itself.
    wakeJobWorkers();
  }

  private async resolveExtractionEgressPolicy(spaceId: string, scopeId: string): Promise<RetrievalEgressPolicy> {
    const result = await this.db.query<{ control_count: number; external_allowed: boolean }>(
      `SELECT count(*)::int AS control_count,
              COALESCE(bool_and((control.snapshot_json->'egress'->>'external_egress_allowed')::boolean),false) AS external_allowed
         FROM execution_control_snapshots control
        WHERE control.space_id=$1 AND control.snapshot_json->>'work_context_scope_id'=$2`,
      [spaceId, scopeId],
    );
    return {
      externalEgressEnabled: Number(result.rows[0]?.control_count ?? 0) > 0
        && result.rows[0]?.external_allowed === true,
    };
  }

  private async validateExtractionRefs(
    db: Queryable,
    authority: InvocationAuthority,
    extraction: SemanticCheckpointExtraction,
    events: ContextEvent[],
    previous: SemanticCheckpoint | null,
  ): Promise<Array<{ ref: Ref; confirmation_authority: "none" | "canonical_user" | "approved_domain" }>> {
    const allowed = new Map<string, Ref>();
    for (const event of events) {
      allowed.set(refKey(event.canonical_ref), event.canonical_ref);
      for (const source of event.source_refs) allowed.set(refKey(source), source);
    }
    for (const source of previous?.source_refs ?? []) allowed.set(refKey(source.ref), source.ref);
    const cited = extractionRefs(extraction);
    for (const ref of cited) if (!allowed.has(refKey(ref))) throw new HttpError(422, "Semantic checkpoint cited a ref outside its selected input");
    const unique = [...new Map(cited.map((ref) => [refKey(ref), ref])).values()];
    return Promise.all(unique.map(async (ref) => {
      const canonical = await this.resolveCanonical(db, authority, ref);
      return { ref, confirmation_authority: canonical.confirmationState === "confirmed" || canonical.confirmationState === "corrected"
        ? canonical.trust === "user_confirmed" ? "canonical_user" as const : "approved_domain" as const
        : "none" as const };
    }));
  }
}

function refKey(ref: Ref): string { return `${ref.type}\u001f${ref.id}\u001f${ref.version ?? ""}`; }

function extractionRefs(value: SemanticCheckpointExtraction): Ref[] {
  return [value.goals, value.user_intent, value.decisions, value.constraints, value.facts,
    value.open_questions, value.tasks].flat().flatMap((entry) => entry.source_refs)
    .concat(value.artifact_refs, value.tool_refs, value.correction_refs);
}

function enrichExtraction(
  extraction: SemanticCheckpointExtraction,
  sources: Array<{ ref: Ref; confirmation_authority: "none" | "canonical_user" | "approved_domain" }>,
): Record<string, unknown> {
  const authority = new Map(sources.map((source) => [refKey(source.ref), source.confirmation_authority]));
  const corrections = new Set(extraction.correction_refs.map(refKey));
  const enrich = <T extends { confirmation_state: "candidate"; source_refs: Ref[] }>(entry: T) => ({
    ...entry,
    confirmation_state: entry.source_refs.some((ref) => corrections.has(refKey(ref)))
      ? "corrected" as const
      : entry.source_refs.some((ref) => authority.get(refKey(ref)) !== "none")
        ? "confirmed" as const
        : "candidate" as const,
  });
  return {
    ...extraction,
    goals: extraction.goals.map(enrich), user_intent: extraction.user_intent.map(enrich),
    decisions: extraction.decisions.map(enrich), constraints: extraction.constraints.map(enrich),
    facts: extraction.facts.map(enrich), open_questions: extraction.open_questions.map(enrich),
  };
}

function isSemanticTrigger(value: { event_type: string }): boolean {
  return SEMANTIC_TRIGGER_EVENTS.has(value.event_type)
    || /(?:^|_)(?:error|failed|failure)(?:_|$)/.test(value.event_type);
}

const SEMANTIC_TRIGGER_EVENTS = new Set([
  "artifact_produced", "checkpoint_corrected",
  "approval_requested", "approval_resolved", "policy_checked",
  "provider_compacted", "model_changed", "policy_changed", "epoch_started",
]);
