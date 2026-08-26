import type { Queryable, SpaceUserIdentity } from "../../routeUtils/common.js";
import { HttpError, objectValue } from "../../routeUtils/common.js";
import { assertProjectWriter } from "../../projects/access.js";
import type { ResearchScopeContext } from "../researchContext.js";

interface MaterializedChannelRow {
  question_snapshot: string;
  context_json: unknown;
  source_channel_id: string;
}

export interface MaterializedResearchDiscovery {
  question: string;
  sourceChannelIds: string[];
  scope: ResearchScopeContext;
}

/** Resolves the project-owned strategy into its immutable materialized channels. */
export class ProjectResearchDiscoveryBridge {
  constructor(private readonly db: Queryable) {}

  async resolve(
    identity: SpaceUserIdentity,
    projectId: string,
    queryStrategyId: string,
  ): Promise<MaterializedResearchDiscovery> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<MaterializedChannelRow>(
      `SELECT qs.question_snapshot,cv.context_json,ss.source_channel_id
         FROM research_query_strategies qs
         JOIN project_research_context_versions cv
           ON cv.id=qs.research_context_version_id AND cv.project_id=qs.project_id AND cv.space_id=qs.space_id
         JOIN research_query_provider_plans qp
           ON qp.strategy_id=qs.id AND qp.space_id=qs.space_id
         JOIN research_query_provider_selections sel
           ON sel.provider_plan_id=qp.id AND sel.space_id=qp.space_id
         JOIN source_search_specs ss
           ON ss.research_query_attempt_id=sel.attempt_id AND ss.space_id=sel.space_id
         JOIN source_channels ch
           ON ch.id=ss.source_channel_id AND ch.space_id=ss.space_id AND ch.status <> 'archived'
        WHERE qs.id=$1 AND qs.space_id=$2 AND qs.project_id=$3 AND qs.status='materialized'
        ORDER BY qp.created_at,qp.provider_key`,
      [queryStrategyId, identity.spaceId, projectId],
    );
    if (rows.rows.length === 0) {
      throw new HttpError(422, "query_strategy_id is not materialized for this project");
    }
    const context = objectValue(rows.rows[0]!.context_json);
    return {
      question: rows.rows[0]!.question_snapshot,
      sourceChannelIds: rows.rows.map((row) => row.source_channel_id),
      scope: {
        sub_questions: strings(context.sub_questions),
        in: strings(context.in_scope),
        out: strings(context.out_of_scope),
        must_have: strings(context.must_have),
        nice_to_have: strings(context.nice_to_have),
      },
    };
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
