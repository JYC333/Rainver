import type { Queryable } from "../../routeUtils/common.js";

export interface SourcePostProcessingRecoveryScope {
  spaceId: string;
  projectId: string;
  channelIds: string[];
  ruleIds: string[];
  sourceItemIds: string[];
  operationId: string;
  researchQuestionVersion: number;
  recoveryRequestedAt?: string;
  operationCreatedAt?: string;
}

export interface SourcePostProcessingCoverage {
  classified: string;
  failed_runs: string;
  failed_run_summary: string | null;
  failed_run_error: unknown;
  pending_recovery_jobs: string;
  failed_recovery_jobs: string;
  failed_recovery_job_error: string | null;
}

export interface ActiveProcessingRule {
  id: string;
  source_channel_id: string;
}

export class PgSourcePostProcessingRecoveryRepository {
  constructor(private readonly db: Queryable) {}

  async channelItemIds(
    spaceId: string,
    channelIds: string[],
    sourceItemIds: string[],
  ): Promise<string[]> {
    const result = await this.db.query<{ source_item_id: string }>(
      `SELECT DISTINCT source_item_id
         FROM source_channel_item_links
        WHERE space_id=$1
          AND source_channel_id=ANY($2::text[])
          AND source_item_id=ANY($3::text[])
          AND status='active'`,
      [spaceId, channelIds, sourceItemIds],
    );
    return result.rows.map((row) => row.source_item_id);
  }

  async coverage(scope: SourcePostProcessingRecoveryScope): Promise<SourcePostProcessingCoverage> {
    const result = await this.db.query<SourcePostProcessingCoverage>(
      `SELECT
         (SELECT count(DISTINCT source_item_id)::int
            FROM source_post_processing_item_decisions
           WHERE space_id=$1 AND project_id=$2 AND source_item_id=ANY($3::text[])
             AND source_channel_id=ANY($4::text[])
             AND research_question_version=$8) AS classified,
         (SELECT count(*)::int
            FROM source_post_processing_runs
           WHERE space_id=$1 AND project_id=$2 AND rule_id=ANY($5::text[])
             AND source_channel_id=ANY($4::text[])
             AND status='failed'
             AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)) AS failed_runs,
         (SELECT summary
            FROM source_post_processing_runs
           WHERE space_id=$1 AND project_id=$2 AND rule_id=ANY($5::text[])
             AND source_channel_id=ANY($4::text[])
             AND status='failed'
             AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)
           ORDER BY created_at DESC LIMIT 1) AS failed_run_summary,
         (SELECT error_json
            FROM source_post_processing_runs
           WHERE space_id=$1 AND project_id=$2 AND rule_id=ANY($5::text[])
             AND source_channel_id=ANY($4::text[])
             AND status='failed'
             AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)
           ORDER BY created_at DESC LIMIT 1) AS failed_run_error,
         (SELECT count(*)::int
            FROM jobs
           WHERE space_id=$1
             AND job_type='source_post_processing_event'
             AND status IN ('pending','claimed','running')
             AND payload_json->>'phase'='research_recovery'
             AND payload_json->>'recovery_for_operation_id'=$7) AS pending_recovery_jobs,
         (SELECT count(*)::int
            FROM jobs
           WHERE space_id=$1
             AND job_type='source_post_processing_event'
             AND status='failed'
             AND payload_json->>'phase'='research_recovery'
             AND payload_json->>'recovery_for_operation_id'=$7
             AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)) AS failed_recovery_jobs,
         (SELECT error
            FROM jobs
           WHERE space_id=$1
             AND job_type='source_post_processing_event'
             AND status='failed'
             AND payload_json->>'phase'='research_recovery'
             AND payload_json->>'recovery_for_operation_id'=$7
             AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)
           ORDER BY created_at DESC LIMIT 1) AS failed_recovery_job_error`,
      [
        scope.spaceId,
        scope.projectId,
        scope.sourceItemIds,
        scope.channelIds,
        scope.ruleIds,
        scope.recoveryRequestedAt ?? scope.operationCreatedAt ?? null,
        scope.operationId,
        scope.researchQuestionVersion,
      ],
    );
    return result.rows[0] ?? {
      classified: "0",
      failed_runs: "0",
      failed_run_summary: null,
      failed_run_error: null,
      pending_recovery_jobs: "0",
      failed_recovery_jobs: "0",
      failed_recovery_job_error: null,
    };
  }

  async classifiedItemIds(scope: SourcePostProcessingRecoveryScope): Promise<string[]> {
    const result = await this.db.query<{ source_item_id: string }>(
      `SELECT DISTINCT source_item_id
         FROM source_post_processing_item_decisions
        WHERE space_id=$1 AND project_id=$2 AND source_item_id=ANY($3::text[])
          AND source_channel_id=ANY($4::text[])
          AND research_question_version=$5`,
      [scope.spaceId, scope.projectId, scope.sourceItemIds, scope.channelIds, scope.researchQuestionVersion],
    );
    return result.rows.map((row) => row.source_item_id);
  }

  async activeRules(spaceId: string, ruleIds: string[]): Promise<ActiveProcessingRule[]> {
    const result = await this.db.query<ActiveProcessingRule>(
      `SELECT id, source_channel_id
         FROM source_post_processing_rules
        WHERE space_id=$1 AND id=ANY($2::text[]) AND status='active'`,
      [spaceId, ruleIds],
    );
    return result.rows;
  }
}
