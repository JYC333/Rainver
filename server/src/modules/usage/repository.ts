import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import {
  contentAccessLevelSql,
  contentAccessSql,
  contentOwnerFilterSql,
  contentVisibilityFilterSql,
} from "../access/contentAccessSql";
import { countFromRow, type Queryable } from "../routeUtils/common";
import type { NormalizedUsageObservation } from "./types";
import { accuracyMixZero } from "./normalizer";
import {
  estimateUsageCost,
  modelPatternMatches,
  modelPatternSpecificity,
  type PricingRuleRecord,
} from "./pricing";

export interface UsageEventRecord {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  visibility: "private" | "space_shared" | "selected_users";
  access_level: "full" | "summary";
  event_type: string;
  source_type: string;
  source_resource_type: string | null;
  source_resource_id: string | null;
  execution_channel: string;
  meter_subject_type: string;
  meter_subject_id: string;
  provider_id: string | null;
  provider_type: string | null;
  provider_name_snapshot: string | null;
  vendor: string | null;
  model: string | null;
  task: string | null;
  run_id: string | null;
  session_id: string | null;
  external_session_id: string | null;
  session_path: string | null;
  session_name: string | null;
  agent_id: string | null;
  project_id: string | null;
  project_folder_id: string | null;
  occurred_at: string;
  recorded_at: string;
  input_tokens: number | string;
  output_tokens: number | string;
  total_tokens: number | string | null;
  cache_creation_input_tokens: number | string;
  cache_read_input_tokens: number | string;
  reasoning_tokens: number | string;
  request_count: number | string;
  estimated_cost_usd: number | string | null;
  usage_details_json: Record<string, unknown>;
  total_tokens_source: string;
  usage_accuracy: string;
  dimensions_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface UsageTotals {
  event_count: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  observed_event_percentage: number;
}

export interface UsageRunSummaryRecord {
  agent_run_count: number | string;
  completed_agent_run_count: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  total_tokens: number | string | null;
  estimated_cost_usd: number | string | null;
  model_names: string[] | null;
}

export interface UsageBreakdownRow {
  group_key: string;
  group_label: string;
  totals: UsageTotals;
  accuracy_mix: ReturnType<typeof accuracyMixZero>;
  last_seen_at: string | null;
}

export interface UsageTimeseriesRow extends UsageBreakdownRow {
  bucket_start: string;
}

export interface UsageQueryFilters {
  activeSpaceId: string;
  userId: string;
  view: "mine" | "shared" | "all_visible";
  from: string;
  to: string;
  includeImported?: boolean;
  accuracy?: string | null;
  executionChannel?: string | null;
  providerId?: string | null;
  model?: string | null;
  task?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  sessionId?: string | null;
  externalSessionId?: string | null;
  sessionPath?: string | null;
  dimensionKey?: string | null;
  dimensionValue?: string | null;
  groupBy?: string | null;
  limit?: number;
  offset?: number;
}

export interface UsageImportBatchRecord {
  id: string;
  instance_id: string;
  target_space_id: string;
  owner_user_id: string;
  source_type: string;
  source_kind: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  source_fingerprint: string | null;
  preview_summary_json: Record<string, unknown>;
  import_summary_json: Record<string, unknown>;
  error_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface UsageImportBatchCreateInput {
  instanceId: string;
  targetSpaceId: string;
  ownerUserId: string;
  sourceType: string;
  sourceKind: string;
  sourceFingerprint: string;
  previewSummary: Record<string, unknown>;
}

interface AggregateRow {
  group_key: string | null;
  group_label: string | null;
  event_count: string | number;
  request_count: string | number;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_creation_input_tokens: string | number | null;
  cache_read_input_tokens: string | number | null;
  reasoning_tokens: string | number | null;
  total_tokens: string | number | null;
  estimated_cost_usd: string | number | null;
  observed_events: string | number;
  provider_reported: string | number;
  proxy_observed: string | number;
  transcript_lower_bound: string | number;
  estimated: string | number;
  quota_snapshot: string | number;
  unknown: string | number;
  last_seen_at: string | null;
}

interface TimeseriesAggregateRow extends AggregateRow {
  bucket_start: string;
}

interface BudgetPreviewRow extends AggregateRow {
  meter_subject_type: string;
  meter_subject_id: string;
  costed_events: string | number;
}

export class PgUsageRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgUsageRepository {
    if (!config.databaseUrl) throw new Error("SERVER_DATABASE_URL is required");
    return new PgUsageRepository(getDbPool(config.databaseUrl));
  }

  async getOrCreateInstanceId(): Promise<string> {
    const now = new Date();
    const result = await this.db.query<{ instance_id: string }>(
      `INSERT INTO instance_identity (id, instance_id, created_at, updated_at)
       VALUES ('local', $1, $2, $2)
       ON CONFLICT (id) DO UPDATE SET updated_at = instance_identity.updated_at
       RETURNING instance_id`,
      [randomUUID(), now],
    );
    const instanceId = result.rows[0]?.instance_id;
    if (!instanceId) throw new Error("instance identity row was not returned");
    return instanceId;
  }

  async appendEvent(event: NormalizedUsageObservation): Promise<UsageEventRecord> {
    event = await this.withEstimatedCost(event);
    const result = await this.db.query<UsageEventRecord>(
      `WITH inserted_event AS (
      INSERT INTO token_usage_events (
        id, instance_id, reporting_instance_id, origin_instance_id, space_id,
        owner_user_id, visibility, access_level, origin_space_id,
        event_type, source_type, source_resource_type, source_resource_id,
        execution_channel, meter_subject_type, meter_subject_id,
        subject_user_id, subject_team_id, adapter_type, runtime_tool_version,
        provider_id, provider_type, provider_name_snapshot, vendor, model, task,
        run_id, root_run_id, parent_run_id, run_group_id, session_id, external_session_id,
        session_path, session_name, agent_id, project_id, project_folder_id, trigger_origin,
        occurred_at, recorded_at, input_tokens, output_tokens, total_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, reasoning_tokens,
        request_count, estimated_cost_usd, usage_schema, usage_details_json,
        cost_details_json, provider_usage_json, usage_normalization_version,
        total_tokens_source, currency, pricing_rule_id, pricing_tier_name,
        dimensions_json, usage_accuracy, dedupe_confidence, import_batch_id,
        idempotency_key, metadata_json, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26,
        $27, $28, $29, $30, $31, $32,
        $33, $34, $35, $36, $37, $38,
        $39, $40, $41, $42, $43,
        $44, $45, $46,
        $47, $48, $49, $50::jsonb,
        $51::jsonb, $52::jsonb, $53,
        $54, $55, $56, $57,
        $58::jsonb, $59, $60, $61,
        $62, $63::jsonb, $64, $64
      )
      ON CONFLICT ON CONSTRAINT uq_token_usage_events_space_idempotency
      DO NOTHING
      RETURNING
        id, space_id, owner_user_id, visibility, access_level,
        event_type, source_type, source_resource_type, source_resource_id,
        execution_channel, meter_subject_type,
        meter_subject_id, provider_id, provider_type, provider_name_snapshot, vendor,
        model, task, run_id, session_id, external_session_id, session_path,
        session_name, agent_id, project_id, project_folder_id, occurred_at, recorded_at,
        input_tokens, output_tokens, total_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, reasoning_tokens, request_count, estimated_cost_usd,
        usage_details_json, total_tokens_source, usage_accuracy, dimensions_json,
        metadata_json, created_at
      ), inserted_grants AS (
        INSERT INTO content_access_grants (
          id, space_id, resource_type, resource_id, grantee_user_id,
          granted_by_user_id, access_level, created_at, updated_at,
          revoked_at, revoked_by_user_id
        )
        SELECT grant_row.id, inserted_event.space_id, 'token_usage_event', inserted_event.id,
               grant_row.user_id, grant_row.granted_by_user_id, grant_row.access_level,
               grant_row.created_at, grant_row.created_at, NULL, NULL
          FROM inserted_event
          CROSS JOIN jsonb_to_recordset($65::jsonb) AS grant_row(
            id text,
            user_id text,
            granted_by_user_id text,
            access_level text,
            created_at timestamptz
          )
        ON CONFLICT ON CONSTRAINT uq_content_access_grants_resource_grantee DO NOTHING
      )
      SELECT * FROM inserted_event`,
      [
        event.id,
        event.instance_id,
        event.reporting_instance_id,
        event.origin_instance_id,
        event.space_id,
        event.owner_user_id,
        event.visibility,
        event.access_level,
        event.origin_space_id,
        event.event_type,
        event.source_type,
        event.source_resource_type,
        event.source_resource_id,
        event.execution_channel,
        event.meter_subject_type,
        event.meter_subject_id,
        event.subject_user_id,
        event.subject_team_id,
        event.adapter_type,
        event.runtime_tool_version,
        event.provider_id,
        event.provider_type,
        event.provider_name_snapshot,
        event.vendor,
        event.model,
        event.task,
        event.run_id,
        event.root_run_id,
        event.parent_run_id,
        event.run_group_id,
        event.session_id,
        event.external_session_id,
        event.session_path,
        event.session_name,
        event.agent_id,
        event.project_id,
        event.project_folder_id,
        event.trigger_origin,
        event.occurred_at,
        event.recorded_at,
        event.input_tokens,
        event.output_tokens,
        event.total_tokens,
        event.cache_creation_input_tokens,
        event.cache_read_input_tokens,
        event.reasoning_tokens,
        event.request_count,
        event.estimated_cost_usd,
        event.usage_schema,
        JSON.stringify(event.usage_details_json),
        JSON.stringify(event.cost_details_json),
        JSON.stringify(event.provider_usage_json),
        event.usage_normalization_version,
        event.total_tokens_source,
        event.currency,
        event.pricing_rule_id,
        event.pricing_tier_name,
        JSON.stringify(event.dimensions_json),
        event.usage_accuracy,
        event.dedupe_confidence,
        event.import_batch_id,
        event.idempotency_key,
        JSON.stringify(event.metadata_json),
        event.created_at,
        JSON.stringify(event.grant_snapshots),
      ],
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await this.getEventByIdempotencyKey(event.space_id, event.idempotency_key);
    if (!existing) throw new Error("usage event insert was deduped but existing row was not found");
    return existing;
  }

  private async withEstimatedCost(
    event: NormalizedUsageObservation,
  ): Promise<NormalizedUsageObservation> {
    if (event.estimated_cost_usd !== null || event.pricing_rule_id || !event.model || !hasBillableUsage(event)) {
      return event;
    }
    const rule = await this.findPricingRuleForEvent(event);
    if (!rule) return event;
    const estimate = estimateUsageCost(event, rule);
    if (!estimate) return event;
    return {
      ...event,
      estimated_cost_usd: estimate.estimatedCostUsd,
      currency: estimate.currency,
      pricing_rule_id: estimate.pricingRuleId,
      pricing_tier_name: estimate.pricingTierName,
      cost_details_json: estimate.costDetails,
    };
  }

  private async findPricingRuleForEvent(
    event: NormalizedUsageObservation,
  ): Promise<PricingRuleRecord | null> {
    const result = await this.db.query<PricingRuleRecord>(
      `SELECT
        id, scope_type, space_id, provider_type, provider_id, model_pattern,
        input_usd_per_million, output_usd_per_million, cache_write_usd_per_million,
        cache_read_usd_per_million, reasoning_usd_per_million, usage_type_prices_json,
        tier_conditions_json, priority, pricing_normalization_version, currency,
        effective_from, effective_until, source, metadata_json, created_at, updated_at
       FROM model_pricing_rules
       WHERE currency = $1
         AND effective_from <= $2::timestamptz
         AND (effective_until IS NULL OR effective_until > $2::timestamptz)
         AND (scope_type IN ('system', 'instance') OR (scope_type = 'space' AND space_id = $3))
         AND (space_id IS NULL OR space_id = $3)
         AND (provider_id IS NULL OR provider_id = $4)
         AND (provider_type IS NULL OR provider_type = $5)
       ORDER BY priority DESC, effective_from DESC
       LIMIT 100`,
      [
        event.currency || "USD",
        event.occurred_at,
        event.space_id,
        event.provider_id,
        event.provider_type,
      ],
    );
    const matches = result.rows
      .filter((rule) => modelPatternMatches(rule.model_pattern, event.model))
      .sort((left, right) => pricingRuleScore(right, event) - pricingRuleScore(left, event));
    return matches[0] ?? null;
  }

  async createImportBatch(input: UsageImportBatchCreateInput): Promise<UsageImportBatchRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<UsageImportBatchRecord>(
      `INSERT INTO usage_import_batches (
        id, instance_id, target_space_id, owner_user_id, source_type, source_kind,
        status, started_at, completed_at, source_fingerprint, preview_summary_json,
        import_summary_json, error_json, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        'previewed', NULL, NULL, $7, $8::jsonb,
        '{}'::jsonb, NULL, $9, $9
      )
      RETURNING id, instance_id, target_space_id, owner_user_id, source_type, source_kind,
        status, started_at, completed_at, source_fingerprint, preview_summary_json,
        import_summary_json, error_json, created_at, updated_at`,
      [
        id,
        input.instanceId,
        input.targetSpaceId,
        input.ownerUserId,
        input.sourceType,
        input.sourceKind,
        input.sourceFingerprint,
        JSON.stringify(input.previewSummary),
        now,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("usage import batch was not returned");
    return row;
  }

  async getImportBatch(id: string, targetSpaceId: string): Promise<UsageImportBatchRecord | null> {
    const result = await this.db.query<UsageImportBatchRecord>(
      `SELECT id, instance_id, target_space_id, owner_user_id, source_type, source_kind,
              status, started_at, completed_at, source_fingerprint, preview_summary_json,
              import_summary_json, error_json, created_at, updated_at
         FROM usage_import_batches
        WHERE id = $1 AND target_space_id = $2
        LIMIT 1`,
      [id, targetSpaceId],
    );
    return result.rows[0] ?? null;
  }

  async markImportBatchImporting(id: string): Promise<void> {
    await this.db.query(
      `UPDATE usage_import_batches
          SET status = 'importing', started_at = COALESCE(started_at, $2), updated_at = $2
        WHERE id = $1`,
      [id, new Date().toISOString()],
    );
  }

  async completeImportBatch(id: string, summary: Record<string, unknown>): Promise<UsageImportBatchRecord> {
    const now = new Date().toISOString();
    const result = await this.db.query<UsageImportBatchRecord>(
      `UPDATE usage_import_batches
          SET status = 'completed',
              completed_at = $2,
              import_summary_json = $3::jsonb,
              updated_at = $2
        WHERE id = $1
        RETURNING id, instance_id, target_space_id, owner_user_id, source_type, source_kind,
          status, started_at, completed_at, source_fingerprint, preview_summary_json,
          import_summary_json, error_json, created_at, updated_at`,
      [id, now, JSON.stringify(summary)],
    );
    const row = result.rows[0];
    if (!row) throw new Error("usage import batch was not returned");
    return row;
  }

  async failImportBatch(id: string, error: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `UPDATE usage_import_batches
          SET status = 'failed', error_json = $2::jsonb, completed_at = $3, updated_at = $3
        WHERE id = $1`,
      [id, JSON.stringify(error), new Date().toISOString()],
    );
  }

  async countExistingIdempotencyKeys(spaceId: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const result = await this.db.query<{ count: string | number }>(
      `SELECT count(*)::int AS count
         FROM token_usage_events
        WHERE space_id = $1
          AND idempotency_key = ANY($2::text[])`,
      [spaceId, keys],
    );
    return intValue(result.rows[0]?.count);
  }

  async getEventByIdempotencyKey(
    spaceId: string,
    idempotencyKey: string,
  ): Promise<UsageEventRecord | null> {
    const result = await this.db.query<UsageEventRecord>(
      `SELECT
        id, space_id, owner_user_id, visibility, access_level,
        event_type, source_type, source_resource_type, source_resource_id,
        execution_channel, meter_subject_type,
        meter_subject_id, provider_id, provider_type, provider_name_snapshot, vendor,
        model, task, run_id, session_id, external_session_id, session_path,
        session_name, agent_id, project_id, project_folder_id, occurred_at, recorded_at,
        input_tokens, output_tokens, total_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, reasoning_tokens, request_count, estimated_cost_usd,
        usage_details_json, total_tokens_source, usage_accuracy, dimensions_json,
        metadata_json, created_at
       FROM token_usage_events
       WHERE space_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [spaceId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  async getRunEstimatedCost(spaceId: string, runId: string): Promise<number | null> {
    const result = await this.db.query<{ estimated_cost_usd: string | number | null }>(
      `SELECT sum(estimated_cost_usd)::numeric AS estimated_cost_usd
         FROM token_usage_events
        WHERE space_id = $1 AND run_id = $2`,
      [spaceId, runId],
    );
    return numberOrNull(result.rows[0]?.estimated_cost_usd);
  }

  /**
   * Read the canonical usage ledger for a project-scoped set of runs.
   *
   * Run rows provide lifecycle counts; token_usage_events is the accounting
   * authority for token and cost totals. Keeping the join here prevents
   * product read models from treating a run-level snapshot as a second ledger.
   */
  async summarizeRunUsage(
    spaceId: string,
    projectId: string | null,
    runIds: readonly string[],
  ): Promise<UsageRunSummaryRecord> {
    if (runIds.length === 0) {
      return {
        agent_run_count: 0,
        completed_agent_run_count: 0,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        estimated_cost_usd: null,
        model_names: [],
      };
    }

    const result = await this.db.query<UsageRunSummaryRecord>(
      `WITH scoped_runs AS (
          SELECT r.id, r.status
           FROM runs r
          WHERE r.space_id = $1
            AND ($3::text IS NULL OR r.project_id = $3)
            AND r.id = ANY($2::text[])
       ), usage_by_run AS (
         SELECT e.run_id,
                sum(e.input_tokens)::numeric AS input_tokens,
                sum(e.output_tokens)::numeric AS output_tokens,
                sum(COALESCE(
                  e.total_tokens,
                  e.input_tokens + e.output_tokens + e.cache_creation_input_tokens +
                    e.cache_read_input_tokens + e.reasoning_tokens
                ))::numeric AS total_tokens,
                sum(e.estimated_cost_usd)::numeric AS estimated_cost_usd
           FROM token_usage_events e
           JOIN scoped_runs sr ON sr.id = e.run_id
          WHERE e.space_id = $1
          GROUP BY e.run_id
       )
       SELECT count(sr.id)::int AS agent_run_count,
              count(sr.id) FILTER (WHERE sr.status IN ('succeeded','degraded'))::int AS completed_agent_run_count,
              sum(ur.input_tokens)::numeric AS input_tokens,
              sum(ur.output_tokens)::numeric AS output_tokens,
              sum(ur.total_tokens)::numeric AS total_tokens,
              sum(ur.estimated_cost_usd)::numeric AS estimated_cost_usd,
              ARRAY(
                SELECT model_name
                  FROM (
                    SELECT DISTINCT COALESCE(e.model, e.provider_name_snapshot, e.provider_type, 'Unknown provider') AS model_name
                      FROM token_usage_events e
                      JOIN scoped_runs sr_models ON sr_models.id = e.run_id
                     WHERE e.space_id = $1
                  ) model_names_sorted
                 ORDER BY model_name
              ) AS model_names
         FROM scoped_runs sr
         LEFT JOIN usage_by_run ur ON ur.run_id = sr.id`,
      [spaceId, runIds, projectId],
    );
    return result.rows[0] ?? {
      agent_run_count: 0,
      completed_agent_run_count: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      estimated_cost_usd: null,
      model_names: [],
    };
  }

  async summarizeRunUsageByRunIds(
    spaceId: string,
    runIds: readonly string[],
  ): Promise<Map<string, UsageRunSummaryRecord>> {
    if (runIds.length === 0) return new Map();

    const result = await this.db.query<UsageRunSummaryRecord & { run_id: string }>(
      `WITH scoped_runs AS (
         SELECT r.id, r.status
           FROM runs r
          WHERE r.space_id = $1
            AND r.id = ANY($2::text[])
       ), usage_by_run AS (
         SELECT e.run_id,
                sum(e.input_tokens)::numeric AS input_tokens,
                sum(e.output_tokens)::numeric AS output_tokens,
                sum(COALESCE(
                  e.total_tokens,
                  e.input_tokens + e.output_tokens + e.cache_creation_input_tokens +
                    e.cache_read_input_tokens + e.reasoning_tokens
                ))::numeric AS total_tokens,
                sum(e.estimated_cost_usd)::numeric AS estimated_cost_usd
           FROM token_usage_events e
           JOIN scoped_runs sr ON sr.id = e.run_id
          WHERE e.space_id = $1
          GROUP BY e.run_id
       )
       SELECT sr.id AS run_id,
              1::int AS agent_run_count,
              CASE WHEN sr.status IN ('succeeded','degraded') THEN 1 ELSE 0 END AS completed_agent_run_count,
              ur.input_tokens,
              ur.output_tokens,
              ur.total_tokens,
              ur.estimated_cost_usd,
              ARRAY(
                SELECT model_name
                  FROM (
                    SELECT DISTINCT COALESCE(e.model, e.provider_name_snapshot, e.provider_type, 'Unknown provider') AS model_name
                      FROM token_usage_events e
                     WHERE e.space_id = $1 AND e.run_id = sr.id
                  ) model_names_sorted
                 ORDER BY model_name
              ) AS model_names
         FROM scoped_runs sr
         LEFT JOIN usage_by_run ur ON ur.run_id = sr.id`,
      [spaceId, runIds],
    );
    return new Map(result.rows.map((row) => [row.run_id, row]));
  }

  async aggregate(filters: UsageQueryFilters): Promise<{ totals: UsageTotals; items: UsageBreakdownRow[] }> {
    const group = groupExpression(filters.groupBy ?? "provider", effectiveAccessLevelSql(filters));
    const where = buildWhere(filters);
    const params = where.params;
    const rows = await this.db.query<AggregateRow>(
      `SELECT
        ${group.keySql} AS group_key,
        ${group.labelSql} AS group_label,
        ${aggregateSelectSql()}
       FROM token_usage_events e
       ${where.sql}
       GROUP BY 1, 2
       ORDER BY total_tokens DESC, event_count DESC
       LIMIT ${safeLimit(filters.limit ?? 100)} OFFSET ${safeOffset(filters.offset ?? 0)}`,
      params,
    );
    const totalRows = await this.db.query<AggregateRow>(
      `SELECT
        'all' AS group_key,
        'All usage' AS group_label,
        ${aggregateSelectSql()}
       FROM token_usage_events e
       ${where.sql}`,
      params,
    );
    return {
      totals: aggregateRowToBreakdown(totalRows.rows[0]).totals,
      items: rows.rows.map(aggregateRowToBreakdown),
    };
  }

  async timeseries(
    filters: UsageQueryFilters & { granularity: "day" | "week" | "month" },
  ): Promise<UsageTimeseriesRow[]> {
    const group = groupExpression(filters.groupBy ?? "provider", effectiveAccessLevelSql(filters));
    const where = buildWhere(filters);
    const bucket = filters.granularity === "week"
      ? "week"
      : filters.granularity === "month"
        ? "month"
        : "day";
    const rows = await this.db.query<TimeseriesAggregateRow>(
      `SELECT
        date_trunc('${bucket}', e.occurred_at)::timestamptz AS bucket_start,
        ${group.keySql} AS group_key,
        ${group.labelSql} AS group_label,
        ${aggregateSelectSql()}
       FROM token_usage_events e
       ${where.sql}
       GROUP BY 1, 2, 3
       ORDER BY bucket_start ASC, total_tokens DESC`,
      where.params,
    );
    return rows.rows.map((row) => ({
      ...aggregateRowToBreakdown(row),
      bucket_start: dateIso(row.bucket_start),
    }));
  }

  async listEvents(filters: UsageQueryFilters): Promise<{ items: UsageEventRecord[]; total: number }> {
    const where = buildWhere(filters, { fullOnly: true });
    const limit = safeLimit(filters.limit ?? 50);
    const offset = safeOffset(filters.offset ?? 0);
    const items = await this.db.query<UsageEventRecord>(
      `SELECT
        id, space_id, owner_user_id, visibility, access_level,
        event_type, source_type, source_resource_type, source_resource_id,
        execution_channel, meter_subject_type,
        meter_subject_id, provider_id, provider_type, provider_name_snapshot, vendor,
        model, task, run_id, session_id, external_session_id, session_path,
        session_name, agent_id, project_id, project_folder_id, occurred_at, recorded_at,
        input_tokens, output_tokens, total_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, reasoning_tokens, request_count, estimated_cost_usd,
        usage_details_json, total_tokens_source, usage_accuracy, dimensions_json,
        metadata_json, created_at
       FROM token_usage_events e
       ${where.sql}
       ORDER BY occurred_at DESC, created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      where.params,
    );
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(*)::int AS total FROM token_usage_events e ${where.sql}`,
      where.params,
    );
    return { items: items.rows, total: countFromRow(total.rows[0]) };
  }

  async dimensions(filters: UsageQueryFilters): Promise<{
    providers: Array<{ id: string | null; label: string; total_tokens: number }>;
    models: Array<{ model: string; total_tokens: number }>;
    tasks: Array<{ task: string; total_tokens: number }>;
    execution_channels: Array<{ execution_channel: string; total_tokens: number }>;
    accuracies: Array<{ usage_accuracy: string; event_count: number }>;
    custom_dimension_keys: string[];
  }> {
    const where = buildWhere(filters, { fullOnly: true });
    const params = where.params;
    const totalExpr = effectiveTotalSql();
    const providers = await this.db.query<{ id: string | null; label: string; total_tokens: string | number }>(
      `SELECT provider_id AS id,
              COALESCE(provider_name_snapshot, provider_type, provider_id, 'Unknown provider') AS label,
              COALESCE(sum(${totalExpr}), 0)::bigint AS total_tokens
         FROM token_usage_events e
         ${where.sql}
        GROUP BY provider_id, provider_name_snapshot, provider_type
        ORDER BY total_tokens DESC
        LIMIT 100`,
      params,
    );
    const models = await this.db.query<{ model: string; total_tokens: string | number }>(
      `SELECT COALESCE(model, 'unknown') AS model,
              COALESCE(sum(${totalExpr}), 0)::bigint AS total_tokens
         FROM token_usage_events e
         ${where.sql}
        GROUP BY COALESCE(model, 'unknown')
        ORDER BY total_tokens DESC
        LIMIT 100`,
      params,
    );
    const tasks = await this.db.query<{ task: string; total_tokens: string | number }>(
      `SELECT COALESCE(task, 'unknown') AS task,
              COALESCE(sum(${totalExpr}), 0)::bigint AS total_tokens
         FROM token_usage_events e
         ${where.sql}
        GROUP BY COALESCE(task, 'unknown')
        ORDER BY total_tokens DESC
        LIMIT 100`,
      params,
    );
    const channels = await this.db.query<{ execution_channel: string; total_tokens: string | number }>(
      `SELECT execution_channel,
              COALESCE(sum(${totalExpr}), 0)::bigint AS total_tokens
         FROM token_usage_events e
         ${where.sql}
        GROUP BY execution_channel
        ORDER BY total_tokens DESC`,
      params,
    );
    const accuracies = await this.db.query<{ usage_accuracy: string; event_count: string | number }>(
      `SELECT usage_accuracy, count(*)::int AS event_count
         FROM token_usage_events e
         ${where.sql}
        GROUP BY usage_accuracy
        ORDER BY event_count DESC`,
      params,
    );
    const dimensionKeys = await this.db.query<{ key: string }>(
      `SELECT DISTINCT dims.key
         FROM token_usage_events e
         CROSS JOIN LATERAL jsonb_object_keys(e.dimensions_json) AS dims(key)
         ${where.sql}
        ORDER BY dims.key
        LIMIT 200`,
      params,
    );
    return {
      providers: providers.rows.map((row) => ({
        id: row.id,
        label: row.label,
        total_tokens: intValue(row.total_tokens),
      })),
      models: models.rows.map((row) => ({ model: row.model, total_tokens: intValue(row.total_tokens) })),
      tasks: tasks.rows.map((row) => ({ task: row.task, total_tokens: intValue(row.total_tokens) })),
      execution_channels: channels.rows.map((row) => ({
        execution_channel: row.execution_channel,
        total_tokens: intValue(row.total_tokens),
      })),
      accuracies: accuracies.rows.map((row) => ({
        usage_accuracy: row.usage_accuracy,
        event_count: intValue(row.event_count),
      })),
      custom_dimension_keys: dimensionKeys.rows.map((row) => row.key),
    };
  }

  async subjects(filters: UsageQueryFilters): Promise<{ items: UsageBreakdownRow[]; total: number }> {
    const rows = await this.aggregate({ ...filters, groupBy: "subject", limit: filters.limit ?? 100 });
    return { items: rows.items, total: rows.items.length };
  }

  async sessions(filters: UsageQueryFilters): Promise<{
    items: Array<{
      session_id: string | null;
      external_session_id: string | null;
      session_path: string | null;
      session_name: string | null;
      run_ids: string[];
      totals: UsageTotals;
      last_seen_at: string | null;
    }>;
    total: number;
  }> {
    const where = buildWhere(filters, { fullOnly: true });
    const rows = await this.db.query<AggregateRow & {
      session_id: string | null;
      external_session_id: string | null;
      session_path: string | null;
      session_name: string | null;
      run_ids: string[] | null;
    }>(
      `SELECT
        COALESCE(session_id, external_session_id, 'unknown') AS group_key,
        COALESCE(session_name, session_path, session_id, external_session_id, 'Unknown session') AS group_label,
        session_id,
        external_session_id,
        session_path,
        session_name,
        array_remove(array_agg(DISTINCT run_id), NULL) AS run_ids,
        ${aggregateSelectSql()}
       FROM token_usage_events e
       ${where.sql}
       GROUP BY session_id, external_session_id, session_path, session_name
       ORDER BY total_tokens DESC, event_count DESC
       LIMIT ${safeLimit(filters.limit ?? 100)} OFFSET ${safeOffset(filters.offset ?? 0)}`,
      where.params,
    );
    return {
      items: rows.rows.map((row) => ({
        session_id: row.session_id,
        external_session_id: row.external_session_id,
        session_path: row.session_path,
        session_name: row.session_name,
        run_ids: row.run_ids ?? [],
        totals: aggregateRowToBreakdown(row).totals,
        last_seen_at: dateIsoOrNull(row.last_seen_at),
      })),
      total: rows.rows.length,
    };
  }

  async budgetPreview(
    filters: UsageQueryFilters,
    projectionWindowDays: number,
  ): Promise<{
    observed_days: number;
    projection_window_days: number;
    total_projected_estimated_cost_usd: number | null;
    items: Array<{
      meter_subject_type: string;
      meter_subject_id: string;
      current_estimated_cost_usd: number | null;
      projected_estimated_cost_usd: number | null;
      costed_event_percentage: number;
      totals: UsageTotals;
      last_seen_at: string | null;
    }>;
  }> {
    const where = buildWhere(filters, { fullOnly: true });
    const observedDays = Math.max(
      1,
      (new Date(filters.to).getTime() - new Date(filters.from).getTime()) / (24 * 60 * 60 * 1000),
    );
    const rows = await this.db.query<BudgetPreviewRow>(
      `SELECT
        e.meter_subject_type,
        e.meter_subject_id,
        e.meter_subject_type || ':' || e.meter_subject_id AS group_key,
        e.meter_subject_type || ' ' || e.meter_subject_id AS group_label,
        count(*) FILTER (WHERE e.estimated_cost_usd IS NOT NULL)::int AS costed_events,
        ${aggregateSelectSql()}
       FROM token_usage_events e
       ${where.sql}
       GROUP BY e.meter_subject_type, e.meter_subject_id
       ORDER BY estimated_cost_usd DESC NULLS LAST, total_tokens DESC
       LIMIT ${safeLimit(filters.limit ?? 100)} OFFSET ${safeOffset(filters.offset ?? 0)}`,
      where.params,
    );
    const items = rows.rows.map((row) => {
      const breakdown = aggregateRowToBreakdown(row);
      const currentCost = numberOrNull(row.estimated_cost_usd);
      const projected = currentCost === null
        ? null
        : roundCost((currentCost / observedDays) * projectionWindowDays);
      return {
        meter_subject_type: row.meter_subject_type,
        meter_subject_id: row.meter_subject_id,
        current_estimated_cost_usd: currentCost,
        projected_estimated_cost_usd: projected,
        costed_event_percentage: breakdown.totals.event_count > 0
          ? (intValue(row.costed_events) / breakdown.totals.event_count) * 100
          : 0,
        totals: breakdown.totals,
        last_seen_at: breakdown.last_seen_at,
      };
    });
    const projectedCosts = items
      .map((item) => item.projected_estimated_cost_usd)
      .filter((value): value is number => value !== null);
    return {
      observed_days: observedDays,
      projection_window_days: projectionWindowDays,
      total_projected_estimated_cost_usd: projectedCosts.length
        ? roundCost(projectedCosts.reduce((sum, value) => sum + value, 0))
        : null,
      items,
    };
  }

  async operationalTotals(input: { from: string; to: string }): Promise<UsageTotals> {
    const result = await this.db.query<AggregateRow>(
      `SELECT 'all' AS group_key, 'All usage' AS group_label, ${aggregateSelectSql()}
         FROM token_usage_events e
        WHERE e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz`,
      [input.from, input.to],
    );
    return aggregateRowToBreakdown(result.rows[0]).totals;
  }
}

export function usageRepositoryFromPool(pool: Pool): PgUsageRepository {
  return new PgUsageRepository(pool);
}

function hasBillableUsage(event: NormalizedUsageObservation): boolean {
  return Object.entries(event.usage_details_json).some(([bucket, raw]) => {
    if (bucket === "total" && Object.keys(event.usage_details_json).length > 1) return false;
    const value = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(value) && value > 0;
  });
}

function pricingRuleScore(rule: PricingRuleRecord, event: NormalizedUsageObservation): number {
  const scopeScore = rule.scope_type === "space" ? 30 : rule.scope_type === "instance" ? 20 : 10;
  const providerScore =
    rule.provider_id && rule.provider_id === event.provider_id ? 8 :
      rule.provider_type && rule.provider_type === event.provider_type ? 4 :
        0;
  return (
    intValue(rule.priority) * 1000 +
    scopeScore +
    providerScore +
    modelPatternSpecificity(rule.model_pattern)
  );
}

function buildWhere(
  filters: UsageQueryFilters,
  options: { fullOnly?: boolean } = {},
): { sql: string; params: unknown[] } {
  const params: unknown[] = [filters.from, filters.to, filters.activeSpaceId, filters.userId];
  const definition = usageResourceDefinition();
  const userExpr = "$4";
  const clauses = [
    "e.occurred_at >= $1",
    "e.occurred_at < $2",
    "e.space_id = $3",
    contentAccessSql({ definition, alias: "e", userExpr }),
  ];
  if (filters.view === "mine") {
    clauses.push(contentOwnerFilterSql("token_usage_event", "e", userExpr));
  }
  if (filters.view === "shared") {
    clauses.push(contentVisibilityFilterSql("e", ["space_shared"]));
  }
  if (options.fullOnly || hasDetailFilters(filters)) {
    clauses.push(`${contentAccessLevelSql({ definition, alias: "e", userExpr })} = 'full'`);
  }
  if (filters.includeImported === false) {
    clauses.push(`e.source_type NOT IN ('cli_history_import', 'cross_instance_import', 'manual_import')`);
  }
  if (filters.accuracy) {
    params.push(filters.accuracy);
    clauses.push(`e.usage_accuracy = $${params.length}`);
  }
  if (filters.executionChannel) {
    params.push(filters.executionChannel);
    clauses.push(`e.execution_channel = $${params.length}`);
  }
  if (filters.providerId) {
    params.push(filters.providerId);
    clauses.push(`e.provider_id = $${params.length}`);
  }
  if (filters.model) {
    params.push(filters.model);
    clauses.push(`e.model = $${params.length}`);
  }
  if (filters.task) {
    params.push(filters.task);
    clauses.push(`e.task = $${params.length}`);
  }
  if (filters.subjectType) {
    params.push(filters.subjectType);
    clauses.push(`e.meter_subject_type = $${params.length}`);
  }
  if (filters.subjectId) {
    params.push(filters.subjectId);
    clauses.push(`e.meter_subject_id = $${params.length}`);
  }
  if (filters.sessionId) {
    params.push(filters.sessionId);
    clauses.push(`e.session_id = $${params.length}`);
  }
  if (filters.externalSessionId) {
    params.push(filters.externalSessionId);
    clauses.push(`e.external_session_id = $${params.length}`);
  }
  if (filters.sessionPath) {
    params.push(filters.sessionPath);
    clauses.push(`e.session_path = $${params.length}`);
  }
  if (filters.dimensionKey) {
    params.push(filters.dimensionKey);
    const keyParam = params.length;
    if (filters.dimensionValue) {
      params.push(filters.dimensionValue);
      clauses.push(`jsonb_extract_path_text(e.dimensions_json, $${keyParam}::text) = $${params.length}`);
    } else {
      clauses.push(`e.dimensions_json ? $${keyParam}`);
    }
  }
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function hasDetailFilters(filters: UsageQueryFilters): boolean {
  return Boolean(
    filters.includeImported === false ||
    filters.accuracy ||
    filters.executionChannel ||
    filters.providerId ||
    filters.model ||
    filters.task ||
    filters.subjectType ||
    filters.subjectId ||
    filters.sessionId ||
    filters.externalSessionId ||
    filters.sessionPath ||
    filters.dimensionKey ||
    filters.dimensionValue
  );
}

function groupExpression(
  groupBy: string,
  accessLevelSql: string,
): { keySql: string; labelSql: string } {
  const group = rawGroupExpression(groupBy);
  return {
    keySql: `CASE WHEN ${accessLevelSql} = 'full' THEN ${group.keySql} ELSE 'summary' END`,
    labelSql: `CASE WHEN ${accessLevelSql} = 'full' THEN ${group.labelSql} ELSE 'Shared summary' END`,
  };
}

function rawGroupExpression(groupBy: string): { keySql: string; labelSql: string } {
  if (groupBy.startsWith("dimension:")) {
    const rawKey = groupBy.slice("dimension:".length);
    const key = /^[A-Za-z0-9_.:-]{1,64}$/.test(rawKey) ? rawKey : "invalid";
    return {
      keySql: `COALESCE(e.dimensions_json ->> '${key}', 'missing')`,
      labelSql: `COALESCE(e.dimensions_json ->> '${key}', 'Missing ${key}')`,
    };
  }
  switch (groupBy) {
    case "model":
      return { keySql: "COALESCE(e.model, 'unknown')", labelSql: "COALESCE(e.model, 'Unknown model')" };
    case "platform":
      return { keySql: "e.execution_channel", labelSql: "e.execution_channel" };
    case "date":
      return {
        keySql: "date_trunc('day', e.occurred_at)::date::text",
        labelSql: "date_trunc('day', e.occurred_at)::date::text",
      };
    case "session":
      return {
        keySql: "COALESCE(e.session_id, e.external_session_id, 'unknown')",
        labelSql: "COALESCE(e.session_name, e.session_id, e.external_session_id, 'Unknown session')",
      };
    case "session_path":
      return {
        keySql: "COALESCE(e.session_path, 'unknown')",
        labelSql: "COALESCE(e.session_path, 'Unknown session path')",
      };
    case "subject":
      return {
        keySql: "e.meter_subject_type || ':' || e.meter_subject_id",
        labelSql: "e.meter_subject_type || ' ' || e.meter_subject_id",
      };
    case "agent":
      return { keySql: "COALESCE(e.agent_id, 'unknown')", labelSql: "COALESCE(e.agent_id, 'Unknown agent')" };
    case "task":
      return { keySql: "COALESCE(e.task, 'unknown')", labelSql: "COALESCE(e.task, 'Unknown task')" };
    case "provider":
    default:
      return {
        keySql: "COALESCE(e.provider_id, e.provider_type, 'unknown')",
        labelSql: "COALESCE(e.provider_name_snapshot, e.provider_type, e.provider_id, 'Unknown provider')",
      };
  }
}

function usageResourceDefinition() {
  const definition = contentResourceDefinition("token_usage_event");
  if (!definition) throw new Error("Token usage event content resource is not registered");
  return definition;
}

function effectiveAccessLevelSql(filters: UsageQueryFilters): string {
  void filters;
  return contentAccessLevelSql({ definition: usageResourceDefinition(), alias: "e", userExpr: "$4" });
}

function aggregateSelectSql(): string {
  const totalExpr = effectiveTotalSql();
  return `
    count(*)::int AS event_count,
    COALESCE(sum(e.request_count), 0)::bigint AS request_count,
    COALESCE(sum(e.input_tokens), 0)::bigint AS input_tokens,
    COALESCE(sum(e.output_tokens), 0)::bigint AS output_tokens,
    COALESCE(sum(e.cache_creation_input_tokens), 0)::bigint AS cache_creation_input_tokens,
    COALESCE(sum(e.cache_read_input_tokens), 0)::bigint AS cache_read_input_tokens,
    COALESCE(sum(e.reasoning_tokens), 0)::bigint AS reasoning_tokens,
    COALESCE(sum(${totalExpr}), 0)::bigint AS total_tokens,
    sum(e.estimated_cost_usd)::numeric AS estimated_cost_usd,
    count(*) FILTER (WHERE e.usage_accuracy IN ('provider_reported', 'proxy_observed'))::int AS observed_events,
    count(*) FILTER (WHERE e.usage_accuracy = 'provider_reported')::int AS provider_reported,
    count(*) FILTER (WHERE e.usage_accuracy = 'proxy_observed')::int AS proxy_observed,
    count(*) FILTER (WHERE e.usage_accuracy = 'transcript_lower_bound')::int AS transcript_lower_bound,
    count(*) FILTER (WHERE e.usage_accuracy = 'estimated')::int AS estimated,
    count(*) FILTER (WHERE e.usage_accuracy = 'quota_snapshot')::int AS quota_snapshot,
    count(*) FILTER (WHERE e.usage_accuracy = 'unknown')::int AS unknown,
    max(e.occurred_at)::text AS last_seen_at`;
}

function effectiveTotalSql(): string {
  return `COALESCE(
    e.total_tokens,
    e.input_tokens + e.output_tokens + e.cache_creation_input_tokens + e.cache_read_input_tokens + e.reasoning_tokens,
    0
  )`;
}

function aggregateRowToBreakdown(row: AggregateRow | undefined): UsageBreakdownRow {
  const eventCount = intValue(row?.event_count);
  const observedEvents = intValue(row?.observed_events);
  const mix = accuracyMixZero();
  mix.provider_reported = intValue(row?.provider_reported);
  mix.proxy_observed = intValue(row?.proxy_observed);
  mix.transcript_lower_bound = intValue(row?.transcript_lower_bound);
  mix.estimated = intValue(row?.estimated);
  mix.quota_snapshot = intValue(row?.quota_snapshot);
  mix.unknown = intValue(row?.unknown);
  return {
    group_key: row?.group_key ?? "all",
    group_label: row?.group_label ?? "All usage",
    totals: {
      event_count: eventCount,
      request_count: intValue(row?.request_count),
      input_tokens: intValue(row?.input_tokens),
      output_tokens: intValue(row?.output_tokens),
      cache_creation_input_tokens: intValue(row?.cache_creation_input_tokens),
      cache_read_input_tokens: intValue(row?.cache_read_input_tokens),
      reasoning_tokens: intValue(row?.reasoning_tokens),
      total_tokens: intValue(row?.total_tokens),
      estimated_cost_usd: numberOrNull(row?.estimated_cost_usd),
      observed_event_percentage: eventCount > 0 ? (observedEvents / eventCount) * 100 : 0,
    },
    accuracy_mix: mix,
    last_seen_at: dateIsoOrNull(row?.last_seen_at ?? null),
  };
}

export function eventToOut(row: UsageEventRecord): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    owner_user_id: row.owner_user_id,
    visibility: row.visibility,
    access_level: row.access_level,
    event_type: row.event_type,
    source_type: row.source_type,
    source_resource_type: row.source_resource_type,
    source_resource_id: row.source_resource_id,
    execution_channel: row.execution_channel,
    meter_subject_type: row.meter_subject_type,
    meter_subject_id: row.meter_subject_id,
    provider_id: row.provider_id,
    provider_type: row.provider_type,
    provider_name_snapshot: row.provider_name_snapshot,
    vendor: row.vendor,
    model: row.model,
    task: row.task,
    run_id: row.run_id,
    session_id: row.session_id,
    external_session_id: row.external_session_id,
    session_path: row.session_path,
    session_name: row.session_name,
    agent_id: row.agent_id,
    project_id: row.project_id,
    project_folder_id: row.project_folder_id,
    occurred_at: dateIso(row.occurred_at),
    recorded_at: dateIso(row.recorded_at),
    usage_details: row.usage_details_json ?? {},
    input_tokens: intValue(row.input_tokens),
    output_tokens: intValue(row.output_tokens),
    total_tokens: row.total_tokens === null ? null : intValue(row.total_tokens),
    cache_creation_input_tokens: intValue(row.cache_creation_input_tokens),
    cache_read_input_tokens: intValue(row.cache_read_input_tokens),
    reasoning_tokens: intValue(row.reasoning_tokens),
    request_count: intValue(row.request_count),
    estimated_cost_usd: numberOrNull(row.estimated_cost_usd),
    usage_accuracy: row.usage_accuracy,
    total_tokens_source: row.total_tokens_source,
    dimensions: row.dimensions_json ?? {},
    metadata: row.metadata_json ?? {},
    created_at: dateIso(row.created_at),
  };
}

function safeLimit(value: number): number {
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

function safeOffset(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function intValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return 0;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}

function dateIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  return dateIso(value);
}
