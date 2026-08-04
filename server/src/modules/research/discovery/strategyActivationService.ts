import { randomUUID } from "node:crypto";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common";
import { assertProjectWriter } from "../../projects/access";

export type ResearchStrategyActivationReason = "initial" | "monitoring_feedback" | "rollback" | "manual";

interface StrategyRow {
  id: string;
  project_id: string;
  research_context_version_id: string;
  status: string;
}

interface ActiveRow {
  id: string;
  strategy_id: string;
  sequence: number;
}

export class ResearchStrategyActivationService {
  constructor(private readonly db: Queryable) {}

  async activate(input: {
    identity: SpaceUserIdentity;
    strategyId: string;
    reason: ResearchStrategyActivationReason;
    proposalId?: string | null;
  }): Promise<{ strategy_id: string; previous_strategy_id: string | null; sequence: number; channel_ids: string[] }> {
    const { identity } = input;
    const strategyResult = await this.db.query<StrategyRow>(
      `SELECT id,project_id,research_context_version_id,status
         FROM research_query_strategies
        WHERE id=$1 AND space_id=$2
        FOR UPDATE`,
      [input.strategyId, identity.spaceId],
    );
    const strategy = strategyResult.rows[0];
    if (!strategy) throw new HttpError(404, "Research query strategy not found");
    await assertProjectWriter(this.db, identity.spaceId, strategy.project_id, identity.userId);
    if (strategy.status !== "materialized") throw new HttpError(409, "Research query strategy must be materialized before activation");
    // When a context has never had an active strategy, SELECT ... FOR UPDATE
    // on the activation table locks no row. Lock the shared context identity so
    // two first activations serialize before either inserts the unique active
    // activation record.
    await this.db.query(
      `SELECT id FROM project_research_context_versions
        WHERE id=$1 AND project_id=$2 AND space_id=$3
        FOR UPDATE`,
      [strategy.research_context_version_id, strategy.project_id, identity.spaceId],
    );
    const channels = await strategyChannelIds(this.db, identity.spaceId, strategy.id);
    if (channels.length === 0) throw new HttpError(409, "Research query strategy has no materialized source channels");

    const activeResult = await this.db.query<ActiveRow>(
      `SELECT id,strategy_id,sequence
         FROM research_query_strategy_activations
        WHERE space_id=$1 AND project_id=$2 AND research_context_version_id=$3 AND deactivated_at IS NULL
        FOR UPDATE`,
      [identity.spaceId, strategy.project_id, strategy.research_context_version_id],
    );
    const active = activeResult.rows[0] ?? null;
    if (active?.strategy_id === strategy.id) {
      return { strategy_id: strategy.id, previous_strategy_id: null, sequence: Number(active.sequence), channel_ids: channels };
    }

    const now = new Date().toISOString();
    const previousStrategyId = active?.strategy_id ?? null;
    const reason = input.reason === "initial" && active ? "manual" : input.reason;
    if (active) {
      const previousChannels = await strategyChannelIds(this.db, identity.spaceId, active.strategy_id);
      if (previousChannels.length > 0) {
        const liveConsumer = await this.db.query<{ id: string }>(
          `SELECT id FROM project_operations
            WHERE space_id=$1 AND project_id=$2 AND kind='research'
              AND status IN ('active','waiting_review')
              AND (
                COALESCE(progress_json->'channel_ids','[]'::jsonb) ?| $3::text[]
                OR COALESCE(progress_json->'query'->'source_channel_ids','[]'::jsonb) ?| $3::text[]
              )
            LIMIT 1`,
          [identity.spaceId, strategy.project_id, previousChannels],
        );
        if (liveConsumer.rows[0]) {
          throw new HttpError(409, "Wait for the active research operation to finish before activating a replacement query strategy");
        }
        await this.db.query(
          `UPDATE project_source_bindings SET status='archived',updated_at=$3
            WHERE space_id=$1 AND project_id=$2 AND source_channel_id=ANY($4::text[]) AND status <> 'archived'`,
          [identity.spaceId, strategy.project_id, now, previousChannels],
        );
        const archived = await this.db.query<{ id: string }>(
          `UPDATE source_channels SET status='archived',updated_at=$3
            WHERE space_id=$1 AND id=ANY($2::text[]) AND status <> 'archived'
              AND NOT EXISTS (
                SELECT 1 FROM project_source_bindings b
                 WHERE b.space_id=source_channels.space_id
                   AND b.source_channel_id=source_channels.id
                   AND b.project_id<>$4 AND b.status='active'
              )
            RETURNING id`,
          [identity.spaceId, previousChannels, now, strategy.project_id],
        );
        const archivedChannelIds = archived.rows.map((row) => row.id);
        if (archivedChannelIds.length > 0) {
          await this.db.query(
            `UPDATE scheduler_tasks SET status='archived',next_run_at=NULL,updated_at=$3
              WHERE space_id=$1 AND task_type='source_channel_scan' AND task_key=ANY($2::text[])`,
            [identity.spaceId, archivedChannelIds, now],
          );
        }
      }
      await this.db.query(
        `UPDATE research_query_strategy_activations SET deactivated_at=$3 WHERE id=$1 AND space_id=$2`,
        [active.id, identity.spaceId, now],
      );
    }
    await this.db.query(
      `UPDATE source_channels SET status='active',updated_at=$3 WHERE space_id=$1 AND id=ANY($2::text[])`,
      [identity.spaceId, channels, now],
    );
    await this.db.query(
      `UPDATE scheduler_tasks SET status='active',next_run_at=COALESCE(next_run_at,$3),updated_at=$3
        WHERE space_id=$1 AND task_type='source_channel_scan' AND task_key=ANY($2::text[])`,
      [identity.spaceId, channels, now],
    );
    await this.db.query(
      `UPDATE project_source_bindings SET status='active',updated_at=$4
        WHERE space_id=$1 AND project_id=$2 AND source_channel_id=ANY($3::text[])`,
      [identity.spaceId, strategy.project_id, channels, now],
    );
    const sequence = Number(active?.sequence ?? 0) + 1;
    await this.db.query(
      `INSERT INTO research_query_strategy_activations
        (id,space_id,project_id,research_context_version_id,strategy_id,previous_strategy_id,sequence,reason,proposal_id,activated_by_user_id,activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), identity.spaceId, strategy.project_id, strategy.research_context_version_id, strategy.id, previousStrategyId, sequence, reason, input.proposalId ?? null, identity.userId, now],
    );
    await this.db.query(
      `UPDATE project_research_workflows
          SET state_json=jsonb_set(
                jsonb_set(
                  jsonb_set(state_json,'{query_strategy_id}',to_jsonb($4::text),true),
                  '{channel_ids}',$5::jsonb,true
                ),
                '{source_channel_ids}',$5::jsonb,true
              ),updated_at=$6
        WHERE space_id=$1 AND project_id=$2 AND status='active'
          AND ($3::text IS NULL OR state_json->>'query_strategy_id'=$3 OR NOT (state_json ? 'query_strategy_id'))`,
      [identity.spaceId, strategy.project_id, previousStrategyId, strategy.id, JSON.stringify(channels), now],
    );
    return { strategy_id: strategy.id, previous_strategy_id: previousStrategyId, sequence, channel_ids: channels };
  }
}

async function strategyChannelIds(db: Queryable, spaceId: string, strategyId: string): Promise<string[]> {
  const result = await db.query<{ source_channel_id: string }>(
    `SELECT ss.source_channel_id
       FROM research_query_provider_plans p
       JOIN research_query_provider_selections sel ON sel.provider_plan_id=p.id AND sel.space_id=p.space_id
       JOIN source_search_specs ss ON ss.research_query_attempt_id=sel.attempt_id AND ss.space_id=sel.space_id
      WHERE p.strategy_id=$1 AND p.space_id=$2
      ORDER BY p.provider_key`,
    [strategyId, spaceId],
  );
  return result.rows.map((row) => row.source_channel_id);
}
