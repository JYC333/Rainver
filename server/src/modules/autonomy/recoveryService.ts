import {withRunTerminalOwner} from '../systemActions/operations/proposalTransitions.js';
import {HttpError, type Queryable } from "../routeUtils/common.js";
import { PgRunRepository } from "../runs/repository.js";
import { OperationalAlertService } from "../notifications/operationalAlerts.js";
import { EvolutionSignalEmitter } from "../evolution/signalEmitters.js";
import { autonomyCoordinatorRefs, reconcileAutonomyRun } from "./finalizationReconciler.js";

export class AutonomyRecoveryService {
  constructor(private readonly db: Queryable) {}

  async cancelStaleWaitingForReview(input: {
    maxAgeSeconds: number;
    now?: Date;
  }): Promise<{ cancelled: number; run_ids: string[] }> {
    if (!Number.isInteger(input.maxAgeSeconds) || input.maxAgeSeconds < 1) {
      throw new Error("maxAgeSeconds must be a positive integer");
    }
    const host=this.db as Queryable&{connect?:unknown;release?:unknown};
    if(typeof host.connect!=='function'||typeof host.release==='function')throw new HttpError(503,'Independent maintenance requires a Pool owner');
    const now = input.now ?? new Date();
    const staleBefore = new Date(now.getTime() - input.maxAgeSeconds * 1000).toISOString();
    const targets=(await this.db.query<{id:string;space_id:string}>(`SELECT r.id,r.space_id FROM runs r
      JOIN autonomy_candidates c ON c.run_id=r.id AND c.space_id=r.space_id
      WHERE r.trigger_origin='autonomous' AND r.status='waiting_for_review' AND r.updated_at<$1 ORDER BY r.space_id,r.id`,[staleBefore])).rows;
    const cancelled:{id:string;space_id:string;owner_user_id:string;project_id:string|null}[]=[];
    for(const target of targets){try{
    const batch = await withRunTerminalOwner(this.db,async db=>{
      const children=(await db.query<{id:string;space_id:string}>(`SELECT r.id,r.space_id FROM runs r JOIN autonomy_candidates c ON c.run_id=r.id AND c.space_id=r.space_id
        WHERE r.id=$2 AND r.space_id=$3 AND r.trigger_origin='autonomous' AND r.status='waiting_for_review' AND r.updated_at<$1`,[staleBefore,target.id,target.space_id])).rows;
      return [...children,...await autonomyCoordinatorRefs(db,target.space_id,{childRunId:target.id})];
    },async client=>{
      const rows = await client.query<{
        id: string;
        space_id: string;
        owner_user_id: string;
        project_id: string | null;
      }>(
        `SELECT r.id, r.space_id, c.owner_user_id, c.project_id
           FROM runs r
           JOIN autonomy_candidates c ON c.run_id = r.id AND c.space_id = r.space_id
          WHERE r.id=$2 AND r.space_id=$3 AND r.trigger_origin = 'autonomous'
            AND r.status = 'waiting_for_review'
            AND r.updated_at < $1
          ORDER BY r.updated_at, r.id
          FOR UPDATE OF r, c NOWAIT`,
        [staleBefore,target.id,target.space_id],
      );
      const result: typeof rows.rows = [];
      for (const row of rows.rows) {
        const run = await new PgRunRepository(client).markRunTerminal({
          run_id: row.id,
          space_id: row.space_id,
          status: "cancelled",
          output_json: {},
          error_json: {
            error_code: "autonomous_review_timeout",
            error_message: "Autonomous Run was cancelled after waiting too long for interactive review.",
          },
          exit_code: null,
          completed_at: now.toISOString(),
        });
        if (!run) continue;
        await client.query(
          `UPDATE authorization_requests
              SET status = 'rejected', decided_by_user_id = $3, decided_at = $4
            WHERE space_id = $1 AND run_id = $2 AND status = 'pending'`,
          [row.space_id, row.id, row.owner_user_id, now.toISOString()],
        );
        await reconcileAutonomyRun(client, run);
        result.push(row);
      }
      return result;
    },{nonWaiting:true});
    cancelled.push(...batch);
    }catch(error){const code=(error as {code?:string}).code;
      if(code==='55P03'||code==='idempotency_in_progress'||code==='operation_conflict')continue;
      throw error;
    }}
    for (const row of cancelled) {
      await new OperationalAlertService(this.db).emit({
        kind: "autonomous_review_timeout",
        title: "Autonomous Run cancelled while waiting for review",
        message: `Autonomous Run ${row.id} was cancelled after the unattended review deadline.`,
        dedupeKey: `autonomous_review_timeout:${row.id}`,
        spaceId: row.space_id,
        userId: row.owner_user_id,
        projectId: row.project_id,
        sourceRunId: row.id,
        payload: { run_id: row.id, stale_before: staleBefore },
      }).catch(() => {});
      const run = await new PgRunRepository(this.db).getRun(row.space_id, row.id);
      if (run) {
        await new EvolutionSignalEmitter(this.db).emitSupervisorOutcomeForRun({
          run,
          sourceId: `autonomous_review_timeout:${row.id}`,
          outcome: "cancelled",
          summary: "Autonomous Run was cancelled after exceeding the waiting-for-review deadline.",
          payload: { stale_before: staleBefore },
          severity: "warning",
        }).catch(() => {});
      }
    }
    return { cancelled: cancelled.length, run_ids: cancelled.map((row) => row.id) };
  }
}
