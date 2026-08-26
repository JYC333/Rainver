import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { InquiryThreadService } from "../inquiry/threadService.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, dateIso, withQueryableTransaction } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access.js";
import { ProjectResearchExecutionProfileService } from "./executionProfileService.js";
import {
  COMPARISON_BATCH_SIZE,
  ProjectResearchMonitorComparisonService,
  parseMonitorComparisons,
  type MonitorComparison,
} from "./monitorComparisonService.js";
import { resolveNotebookNote } from "./notebookNotes.js";

export const STANDING_COMPARISON_DAILY_RUN_LIMIT = 20;
export const STANDING_COMPARISON_WINDOW_MINUTES = 15;
export const STANDING_COMPARISON_JOB_TYPE = "project_research_standing_dispatch";
export const STANDING_COMPARISON_RECONCILE_JOB_TYPE = "project_research_standing_reconcile";

type StandingBatchRow = {
  id: string;
  space_id: string;
  project_id: string;
  status: string;
  source_item_ids_json: unknown;
  ready_at: unknown;
  run_id: string | null;
  missing_baseline_role: string | null;
  error: string | null;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
};

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
    : [];
}

/** Project-level, workflow-free standing comparison lifecycle. */
export class ProjectResearchStandingComparisonService {
  constructor(private readonly db: Queryable, private readonly config?: ServerConfig) {}

  /** Called inside the Project routing transaction after a matching item lands. */
  async collect(input: { spaceId: string; projectId: string; sourceItemId: string }, now = new Date()): Promise<string> {
    // Routing already owns this lock. Taking it here as well makes direct
    // callers safe and establishes the one lock order used by collection and
    // dispatch: Project first, then its pending batch.
    await lockActiveProjectForMutation(this.db, input.spaceId, input.projectId);
    const existing = await this.db.query<StandingBatchRow>(
      `SELECT * FROM project_research_standing_batches
        WHERE space_id=$1 AND project_id=$2 AND status='pending'
        FOR UPDATE`,
      [input.spaceId, input.projectId],
    );
    const row = existing.rows[0];
    if (row) {
      const ids = stringIds(row.source_item_ids_json);
      if (!ids.includes(input.sourceItemId)) ids.push(input.sourceItemId);
      await this.db.query(
        `UPDATE project_research_standing_batches
            SET source_item_ids_json=$4::jsonb,updated_at=$5
          WHERE id=$1 AND space_id=$2 AND project_id=$3`,
        [row.id, input.spaceId, input.projectId, JSON.stringify(ids), now.toISOString()],
      );
      return row.id;
    }

    const batchId = randomUUID();
    const readyAt = new Date(now.getTime() + STANDING_COMPARISON_WINDOW_MINUTES * 60_000);
    await this.db.query(
      `INSERT INTO project_research_standing_batches (
         id,space_id,project_id,status,source_item_ids_json,window_started_at,ready_at,created_at,updated_at
       ) VALUES ($1,$2,$3,'pending',$4::jsonb,$5,$6,$5,$5)`,
      [batchId, input.spaceId, input.projectId, JSON.stringify([input.sourceItemId]), now.toISOString(), readyAt.toISOString()],
    );
    await new PgJobQueueRepository(this.db).enqueue({
      job_type: STANDING_COMPARISON_JOB_TYPE,
      space_id: input.spaceId,
      user_id: null,
      scheduled_at: readyAt,
      payload: { batch_id: batchId, project_id: input.projectId },
    }, now);
    return batchId;
  }

  async dispatchBatch(spaceId: string, batchId: string, now = new Date()): Promise<Record<string, unknown>> {
    return withQueryableTransaction(this.db, async (db) => {
      const batchProject = await db.query<{ project_id: string }>(
        `SELECT project_id FROM project_research_standing_batches WHERE id=$1 AND space_id=$2`,
        [batchId, spaceId],
      );
      if (!batchProject.rows[0]) throw new Error("Standing comparison batch not found");
      await lockActiveProjectForMutation(db, spaceId, batchProject.rows[0].project_id);
      const batch = await db.query<StandingBatchRow>(
        `SELECT * FROM project_research_standing_batches WHERE id=$1 AND space_id=$2 FOR UPDATE`,
        [batchId, spaceId],
      );
      const row = batch.rows[0];
      if (!row) throw new Error("Standing comparison batch not found");
      if (row.status !== "pending") return { batch_id: row.id, status: row.status, run_id: row.run_id };

      const actor = await standingProjectActor(db, spaceId, row.project_id);
      if (!actor) {
        await markBatch(db, row, "failed", now, { error: "Standing comparison requires an active Project writer" });
        return { batch_id: row.id, status: "failed" };
      }
      const baseline = await resolveNotebookNote(db, spaceId, row.project_id, "understanding");
      if (!baseline.present) {
        await markBatch(db, row, "blocked_baseline", now, { missingBaselineRole: baseline.role });
        return { batch_id: row.id, status: "blocked_baseline", missing_baseline_role: baseline.role };
      }
      const used = await standingRunsUsedToday(db, spaceId, row.project_id, now);
      if (used >= STANDING_COMPARISON_DAILY_RUN_LIMIT) {
        await markBatch(db, row, "budget_exhausted", now);
        return { batch_id: row.id, status: "budget_exhausted", daily_used: used, daily_limit: STANDING_COMPARISON_DAILY_RUN_LIMIT };
      }

      const allIds = stringIds(row.source_item_ids_json);
      const selectedIds = allIds.slice(0, COMPARISON_BATCH_SIZE);
      if (selectedIds.length === 0) {
        await markBatch(db, row, "completed", now);
        return { batch_id: row.id, status: "completed", compared: 0 };
      }
      const config = this.config;
      if (!config) {
        await markBatch(db, row, "failed", now, { error: "Standing comparison execution is not configured" });
        return { batch_id: row.id, status: "failed" };
      }
      const execution = await new ProjectResearchExecutionProfileService(db, config).resolve(
        { spaceId, userId: actor },
        {},
      );
      const queued = await new ProjectResearchMonitorComparisonService(db).queue({
        spaceId,
        userId: actor,
        projectId: row.project_id,
        standingBatchId: row.id,
        agentId: execution.agentId,
        runtimeProfileId: execution.runtimeProfileId,
        researchQuestion: "Identify how new material changes the project's current understanding and possible directions.",
        sourceItemIds: selectedIds,
      });
      if (queued.outcome === "no_baseline") {
        await markBatch(db, row, "blocked_baseline", now, { missingBaselineRole: queued.role });
        return { batch_id: row.id, status: "blocked_baseline", missing_baseline_role: queued.role };
      }
      if (queued.outcome === "no_eligible_material") {
        await markBatch(db, row, "completed", now);
        return { batch_id: row.id, status: "completed", compared: 0 };
      }
      await db.query(
        `UPDATE project_research_standing_batches
            SET status='running',source_item_ids_json=$3::jsonb,run_id=$4,updated_at=$5
          WHERE id=$1 AND space_id=$2`,
        [row.id, spaceId, JSON.stringify(queued.sourceItemIds), queued.runId, now.toISOString()],
      );
      const remaining = allIds.filter((id) => !selectedIds.includes(id));
      if (remaining.length > 0) await this.createFollowupBatch(db, spaceId, row.project_id, remaining, now);
      return {
        batch_id: row.id,
        status: "running",
        run_id: queued.runId,
        job_id: queued.jobId,
        daily_used: used + 1,
        daily_limit: STANDING_COMPARISON_DAILY_RUN_LIMIT,
      };
    });
  }

  async reconcileRun(spaceId: string, runId: string, now = new Date()): Promise<Record<string, unknown>> {
    return withQueryableTransaction(this.db, async (db) => {
      const batchResult = await db.query<StandingBatchRow>(
        `SELECT * FROM project_research_standing_batches
          WHERE space_id=$1 AND run_id=$2 FOR UPDATE`,
        [spaceId, runId],
      );
      const batch = batchResult.rows[0];
      if (!batch) return { run_id: runId, status: "not_standing" };
      if (batch.status !== "running") return { batch_id: batch.id, status: batch.status };
      const run = await db.query<{ status: string; output_json: unknown }>(
        `SELECT status,output_json FROM runs WHERE id=$1 AND space_id=$2`,
        [runId, spaceId],
      );
      const terminal = run.rows[0];
      if (!terminal) throw new Error("Standing comparison run not found");
      if (!['succeeded', 'degraded'].includes(terminal.status)) {
        await markBatch(db, batch, "failed", now, { error: `Standing comparison run ${terminal.status}` });
        return { batch_id: batch.id, status: "failed" };
      }
      const expected = stringIds(batch.source_item_ids_json);
      const comparisons = parseMonitorComparisons(terminal.output_json, expected);
      await this.persistResults(db, batch, runId, comparisons, now);
      await markBatch(db, batch, "completed", now);
      return { batch_id: batch.id, status: "completed", comparison_count: comparisons.length };
    });
  }

  async status(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const [bindings, batches, advice, inflow, used] = await Promise.all([
      this.db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM project_source_bindings
          WHERE space_id=$1 AND project_id=$2 AND status='active' AND standing_comparison_enabled=true`,
        [identity.spaceId, projectId],
      ),
      this.db.query<StandingBatchRow>(
        `SELECT * FROM project_research_standing_batches
          WHERE space_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 10`,
        [identity.spaceId, projectId],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT a.*,si.title AS source_title
           FROM project_research_standing_advice a
           JOIN source_items si ON si.id=a.source_item_id AND si.space_id=a.space_id AND si.deleted_at IS NULL
          WHERE a.space_id=$1 AND a.project_id=$2 AND a.status='open'
            AND ${contentReadSql("source_item", "si", "$3")}
          ORDER BY a.created_at DESC LIMIT 20`,
        [identity.spaceId, projectId, identity.userId],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT recent.source_item_id,recent.title,recent.excerpt,recent.matched_at
           FROM (
             SELECT DISTINCT ON (link.source_item_id)
                    link.source_item_id,si.title,si.excerpt,link.matched_at
               FROM project_source_item_links link
               JOIN source_items si ON si.id=link.source_item_id AND si.space_id=link.space_id AND si.deleted_at IS NULL
              WHERE link.space_id=$1 AND link.project_id=$2 AND link.status='active'
                AND ${contentReadSql("source_item", "si", "$3")}
              ORDER BY link.source_item_id,link.matched_at DESC
           ) recent
          ORDER BY recent.matched_at DESC,recent.source_item_id
          LIMIT 20`,
        [identity.spaceId, projectId, identity.userId],
      ),
      standingRunsUsedToday(this.db, identity.spaceId, projectId, new Date()),
    ]);
    return {
      enabled: Number(bindings.rows[0]?.count ?? 0) > 0,
      enabled_binding_count: Number(bindings.rows[0]?.count ?? 0),
      budget: { daily_limit: STANDING_COMPARISON_DAILY_RUN_LIMIT, daily_used: used },
      batches: batches.rows.map(batchOut),
      advice: advice.rows,
      recent_inflow: inflow.rows,
    };
  }

  async retryBatch(
    identity: SpaceUserIdentity,
    projectId: string,
    batchId: string,
    now = new Date(),
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const result = await db.query<StandingBatchRow>(
        `SELECT * FROM project_research_standing_batches
          WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,
        [batchId, identity.spaceId, projectId],
      );
      const batch = result.rows[0];
      if (!batch) throw new HttpError(404, "Standing comparison batch not found");
      if (batch.status === "pending" || batch.status === "running") return batchOut(batch);
      if (!["blocked_baseline", "failed", "budget_exhausted"].includes(batch.status)) {
        throw new HttpError(409, "Standing comparison batch cannot be retried");
      }
      await db.query(
        `UPDATE project_research_standing_batches
            SET status='pending',ready_at=$4,run_id=NULL,missing_baseline_role=NULL,
                error=NULL,completed_at=NULL,updated_at=$4
          WHERE id=$1 AND space_id=$2 AND project_id=$3`,
        [batchId, identity.spaceId, projectId, now.toISOString()],
      );
      await new PgJobQueueRepository(db).enqueue({
        job_type: STANDING_COMPARISON_JOB_TYPE,
        space_id: identity.spaceId,
        user_id: identity.userId,
        scheduled_at: now,
        payload: { batch_id: batchId, project_id: projectId },
      }, now);
      return { ...batchOut(batch), status: "pending", ready_at: now.toISOString(), run_id: null, missing_baseline_role: null, error: null };
    });
  }

  async dismissAdvice(identity: SpaceUserIdentity, projectId: string, adviceId: string): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<Record<string, unknown>>(
      `UPDATE project_research_standing_advice SET status='dismissed',updated_at=$4
        WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status='open' RETURNING *`,
      [adviceId, identity.spaceId, projectId, new Date().toISOString()],
    );
    if (!row.rows[0]) throw new HttpError(404, "Standing advice not found");
    return row.rows[0];
  }

  async actionAdvice(identity: SpaceUserIdentity, projectId: string, adviceId: string): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      const result = await db.query<Record<string, unknown>>(
        `SELECT * FROM project_research_standing_advice
          WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,
        [adviceId, identity.spaceId, projectId],
      );
      const advice = result.rows[0];
      if (!advice) throw new HttpError(404, "Standing advice not found");
      if (advice.status === "dismissed") throw new HttpError(409, "Dismissed standing advice cannot be actioned");
      if (advice.action_id !== "source.raise_as_question") throw new HttpError(422, "Unsupported standing advice action");
      const input = advice.action_input_json;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new HttpError(422, "Standing advice action input is invalid");
      }
      const thread = await new InquiryThreadService(db).createThread(identity, projectId, input as Record<string, unknown>);
      const updated = await db.query<Record<string, unknown>>(
        `UPDATE project_research_standing_advice SET status='actioned',updated_at=$4
          WHERE id=$1 AND space_id=$2 AND project_id=$3 RETURNING *`,
        [adviceId, identity.spaceId, projectId, new Date().toISOString()],
      );
      return { advice: updated.rows[0], thread };
    });
  }

  private async createFollowupBatch(db: Queryable, spaceId: string, projectId: string, ids: string[], now: Date): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO project_research_standing_batches (
         id,space_id,project_id,status,source_item_ids_json,window_started_at,ready_at,created_at,updated_at
       ) VALUES ($1,$2,$3,'pending',$4::jsonb,$5,$5,$5,$5)`,
      [id, spaceId, projectId, JSON.stringify(ids), now.toISOString()],
    );
    await new PgJobQueueRepository(db).enqueue({
      job_type: STANDING_COMPARISON_JOB_TYPE,
      space_id: spaceId,
      user_id: null,
      scheduled_at: now,
      payload: { batch_id: id, project_id: projectId },
    }, now);
  }

  private async persistResults(
    db: Queryable,
    batch: StandingBatchRow,
    runId: string,
    comparisons: MonitorComparison[],
    now: Date,
  ): Promise<void> {
    for (const comparison of comparisons) {
      await db.query(
        `INSERT INTO research_evidence_cards (
           id,space_id,project_id,source_item_id,object_id,why_md,how_md,what_md,
           provenance_json,edited_by_user,stance,comparison_detail,created_at,updated_at
         ) SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,pci.object_id,'','','',$5::jsonb,false,$6::varchar,$7::text,$8::timestamptz,$8::timestamptz
             FROM project_corpus_items pci
             JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
            WHERE pci.space_id=$2 AND pci.project_id=$3 AND pcis.source_item_id=$4 AND pci.status='active'
            LIMIT 1
         ON CONFLICT (space_id,project_id,source_item_id) DO UPDATE SET
           stance=EXCLUDED.stance,comparison_detail=EXCLUDED.comparison_detail,
           provenance_json=research_evidence_cards.provenance_json || EXCLUDED.provenance_json,
           updated_at=EXCLUDED.updated_at`,
        [randomUUID(), batch.space_id, batch.project_id, comparison.source_item_id,
          JSON.stringify({ standing_comparison_run_id: runId, standing_batch_id: batch.id }),
          comparison.stance, comparison.detail, now.toISOString()],
      );
      if (comparison.stance === "new_direction") {
        const adviceId = randomUUID();
        const idempotencyKey = `standing-advice:${adviceId}`;
        await db.query(
          `INSERT INTO project_research_standing_advice (
             id,space_id,project_id,source_item_id,batch_id,detail,affected_sections_json,
             status,action_id,action_input_json,idempotency_key,created_by_run_id,created_at,updated_at
           ) VALUES ($1::varchar,$2::varchar,$3::varchar,$4::varchar,$5::varchar,$6::text,$7::jsonb,'open','source.raise_as_question',$8::jsonb,$9::varchar,$10::varchar,$11::timestamptz,$11::timestamptz)
           ON CONFLICT (space_id,project_id,source_item_id) DO UPDATE SET
             batch_id=EXCLUDED.batch_id,detail=EXCLUDED.detail,
             affected_sections_json=EXCLUDED.affected_sections_json,status='open',
             action_input_json=EXCLUDED.action_input_json,idempotency_key=EXCLUDED.idempotency_key,
             created_by_run_id=EXCLUDED.created_by_run_id,updated_at=EXCLUDED.updated_at`,
          [adviceId, batch.space_id, batch.project_id, comparison.source_item_id, batch.id,
            comparison.detail, JSON.stringify(comparison.affected_sections),
            JSON.stringify({ kind: "question", statement: comparison.detail, producer_idempotency_key: idempotencyKey }),
            idempotencyKey, runId, now.toISOString()],
        );
      }
    }
    const counts = {
      supports: comparisons.filter((item) => item.stance === "supports").length,
      contradicts: comparisons.filter((item) => item.stance === "contradicts").length,
      newDirection: comparisons.filter((item) => item.stance === "new_direction").length,
    };
    await db.query(
      `INSERT INTO research_scan_summaries (
         id,space_id,project_id,workflow_id,operation_id,scan_key,scan_window_start,scan_window_end,
         scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,supports_count,
         contradicts_count,new_direction_count,comparisons_json,integrity_alerts_json,created_at
       ) VALUES ($1::varchar,$2::varchar,$3::varchar,NULL,NULL,$4::varchar,$5::timestamptz,$6::timestamptz,$6::timestamptz,$7::integer,$7::integer,0,0,$8::integer,$9::integer,$10::integer,$11::jsonb,'[]'::jsonb,$6::timestamptz)
       ON CONFLICT (space_id,project_id,scan_key) WHERE workflow_id IS NULL DO NOTHING`,
      [randomUUID(), batch.space_id, batch.project_id, `standing:${batch.id}`,
        dateIso(batch.created_at), now.toISOString(), stringIds(batch.source_item_ids_json).length,
        counts.supports, counts.contradicts, counts.newDirection, JSON.stringify(comparisons)],
    );
  }
}

async function standingProjectActor(db: Queryable, spaceId: string, projectId: string): Promise<string | null> {
  const row = await db.query<{ user_id: string }>(
    `SELECT candidate.user_id
       FROM (
         SELECT p.owner_user_id AS user_id,0 AS rank
           FROM projects p WHERE p.id=$2 AND p.space_id=$1 AND p.owner_user_id IS NOT NULL
         UNION ALL
         SELECT pm.user_id,1 AS rank
           FROM project_members pm
          WHERE pm.project_id=$2 AND pm.space_id=$1 AND pm.status='active' AND pm.role IN ('owner','member')
       ) candidate
       JOIN users u ON u.id=candidate.user_id AND u.status='active'
       JOIN space_memberships sm ON sm.space_id=$1 AND sm.user_id=candidate.user_id AND sm.status='active'
      ORDER BY candidate.rank,candidate.user_id LIMIT 1`,
    [spaceId, projectId],
  );
  return row.rows[0]?.user_id ?? null;
}

async function standingRunsUsedToday(db: Queryable, spaceId: string, projectId: string, now: Date): Promise<number> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const row = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM runs
      WHERE space_id=$1 AND project_id=$2 AND capability_id='research.monitor_compare'
        AND contract_snapshot_json->'workflow_input_json' ? 'project_research_standing'
        AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
    [spaceId, projectId, dayStart.toISOString(), dayEnd.toISOString()],
  );
  return Number(row.rows[0]?.count ?? 0);
}

async function markBatch(
  db: Queryable,
  batch: StandingBatchRow,
  status: string,
  now: Date,
  options: { error?: string; missingBaselineRole?: string } = {},
): Promise<void> {
  await db.query(
    `UPDATE project_research_standing_batches
        SET status=$3::varchar,error=$4::text,missing_baseline_role=$5::varchar,updated_at=$6::timestamptz,
            completed_at=CASE WHEN $3::varchar IN ('completed','blocked_baseline','budget_exhausted','failed') THEN $6::timestamptz ELSE completed_at END
      WHERE id=$1 AND space_id=$2`,
    [batch.id, batch.space_id, status, options.error ?? null, options.missingBaselineRole ?? null, now.toISOString()],
  );
}

function batchOut(row: StandingBatchRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    source_item_ids: stringIds(row.source_item_ids_json),
    ready_at: dateIso(row.ready_at),
    run_id: row.run_id,
    missing_baseline_role: row.missing_baseline_role,
    error: row.error,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    completed_at: dateIso(row.completed_at),
  };
}
