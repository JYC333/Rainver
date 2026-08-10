import type { ServerConfig } from "../../../config";
import type { Queryable, SpaceUserIdentity } from "../../routeUtils/common";
import { HttpError, objectValue } from "../../routeUtils/common";
import { lockActiveProjectForMutation } from "../../projects/access";
import { ProjectSourceBindingService } from "../../projects/projectSourceBindingService";
import { SourceBackfillPlanningService } from "../../sources/sourceBackfillService";
import { SourceBackfillExecutionService } from "../../sources/sourceBackfillExecutionService";
import { SOURCE_POST_PROCESSING_LIMITS } from "../../sources/postProcessing/config";
import { SourcePostProcessingService } from "../../sources/postProcessing/service";
import { relevanceProfileFromResearchContext, type ResearchScopeContext } from "../researchContext";
import { hasProjectScreeningCriteria, loadProjectScreeningCriteria } from "../screeningCriteria";
import { ProjectResearchDiscoveryBridge } from "./researchDiscoveryBridge";
import type { ResearchThreadScopeRef } from "../threadScope";

export interface InitialIntakeRuleInput {
  researchQuestion: string;
  threadScope: ResearchThreadScopeRef[];
  agentId: string;
  runtimeProfileId: string;
  researchScope: ResearchScopeContext;
}

export interface InitialIntakeProvisionInput extends InitialIntakeRuleInput {
  historyMode: "bounded_range" | "all_available";
  from: string | null;
  to: string | null;
  maxItems: number;
  monitoringField: "submittedDate" | "lastUpdatedDate";
  idempotencyKey: string;
}

export interface InitialIntakeProvisionResult {
  channels: Record<string, unknown>[];
  bindings: Record<string, unknown>[];
  rules: Record<string, unknown>[];
  plans: Record<string, unknown>[];
}

/** Owns the reusable Source-side resources required by initial intake. */
export class ProjectResearchInitialIntakeCoordinator {
  constructor(
    private readonly db: Queryable,
    private readonly config?: ServerConfig,
  ) {}

  resolveDiscovery(identity: SpaceUserIdentity, projectId: string, queryStrategyId: string) {
    return new ProjectResearchDiscoveryBridge(this.db).resolve(identity, projectId, queryStrategyId);
  }

  async provisionBackfills(
    identity: SpaceUserIdentity,
    projectId: string,
    operationId: string,
    sourceChannelIds: string[],
    input: InitialIntakeProvisionInput,
  ): Promise<InitialIntakeProvisionResult> {
    const channels = await this.resolveChannels(identity, sourceChannelIds);
    if (channels.length === 0) throw new HttpError(422, "At least one source monitor is required");
    const bindings: Record<string, unknown>[] = [];
    const rules: Record<string, unknown>[] = [];
    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index]!;
      bindings.push(await this.ensureBinding(identity, projectId, String(channel.id)));
      rules.push(await this.ensurePostProcessingRule(
        identity,
        projectId,
        String(channel.id),
        input,
        String(channel.name ?? `Monitor ${index + 1}`),
        String(channel.provider_key ?? "generic"),
      ));
    }
    const planner = new SourceBackfillPlanningService(this.db, this.config);
    const plans: Record<string, unknown>[] = [];
    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index]!;
      const binding = bindings[index]!;
      const plan = await planner.create(identity, String(channel.id), {
        strategy: {
          window_unit: "date_window",
          history_mode: input.historyMode,
          from: input.from,
          to: input.to,
          window_size: 30,
          max_items: input.maxItems,
          direction: "backward",
          monitoring_field: input.monitoringField,
        },
        quota_policy: { window: "minute", limit_count: 10 },
        idempotency_key: `${input.idempotencyKey}:backfill:${String(channel.id)}`,
        project_source_binding_id: String(binding.id),
        project_operation_id: operationId,
      });
      await new SourceBackfillExecutionService(this.db).startUserAuthorized(
        identity.spaceId,
        String(plan.id),
        operationId,
        identity.userId,
      );
      plans.push(plan);
    }
    return { channels, bindings, rules, plans };
  }

  async resolveChannels(identity: SpaceUserIdentity, sourceChannelIds: string[]): Promise<Record<string, unknown>[]> {
    const channels = await this.db.query<Record<string, unknown>>(
      `SELECT sc.*, sp.provider_key
         FROM source_channels sc
         JOIN source_connections scon ON scon.id=sc.source_connection_id AND scon.space_id=sc.space_id
         JOIN source_provider_connectors spc ON spc.id=scon.provider_connector_id
         JOIN source_providers sp ON sp.id=spc.provider_id
        WHERE sc.space_id=$1 AND sc.id=ANY($2::text[]) AND sc.status <> 'archived'
        ORDER BY array_position($2::text[], sc.id)`,
      [identity.spaceId, sourceChannelIds],
    );
    if (channels.rows.length !== sourceChannelIds.length) {
      throw new HttpError(422, "One or more selected source monitors are unavailable");
    }
    return channels.rows;
  }

  async ensureBinding(
    identity: SpaceUserIdentity,
    projectId: string,
    channelId: string,
  ): Promise<Record<string, unknown>> {
    const existing = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM project_source_bindings
        WHERE space_id=$1 AND project_id=$2 AND source_channel_id=$3 AND status <> 'archived'
        ORDER BY updated_at DESC LIMIT 1`,
      [identity.spaceId, projectId, channelId],
    );
    if (existing.rows[0]) return existing.rows[0];
    return new ProjectSourceBindingService(this.db).createBinding(identity, {
      project_id: projectId,
      source_channel_id: channelId,
      binding_key: "auto-research",
      delivery_scope: "project_members",
      extraction_policy: { mode: "metadata_and_text", full_text: true },
      routing_policy: { archive_non_matching: false },
    });
  }

  async ensurePostProcessingRule(
    identity: SpaceUserIdentity,
    projectId: string,
    channelId: string,
    input: InitialIntakeRuleInput,
    monitorName: string,
    providerKey: string,
  ): Promise<Record<string, unknown>> {
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const primaryThreadId = input.threadScope[0]?.thread_id;
    if (!primaryThreadId) throw new HttpError(422, "Auto Research requires a pinned Inquiry Thread scope");
    const ruleName = `Auto Research ${primaryThreadId.slice(0, 8)}: ${monitorName}`.trim();
    const projectCriteria = await loadProjectScreeningCriteria(this.db, identity.spaceId, projectId);
    const relevanceProfile = {
      ...relevanceProfileFromResearchContext(input.researchQuestion, input.researchScope),
      ...(hasProjectScreeningCriteria(projectCriteria) ? { project_criteria: projectCriteria } : {}),
    };
    const existing = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM source_post_processing_rules
        WHERE space_id=$1 AND project_id=$2 AND source_channel_id=$3
          AND status <> 'archived' AND name=$4 LIMIT 1`,
      [identity.spaceId, projectId, channelId, ruleName],
    );
    if (existing.rows[0]) {
      const inputConfig = objectValue(existing.rows[0].input_config_json);
      await new SourcePostProcessingService(this.db, requiredConfig(this.config)).updateRule(
        identity,
        channelId,
        String(existing.rows[0].id),
        { input_config_json: { ...inputConfig, relevance_profile: relevanceProfile } },
      );
      await this.ensureProcessingBatchSize(identity, [String(existing.rows[0].id)]);
      const refreshed = await this.db.query<Record<string, unknown>>(
        `SELECT * FROM source_post_processing_rules WHERE space_id=$1 AND id=$2`,
        [identity.spaceId, String(existing.rows[0].id)],
      );
      return refreshed.rows[0] ?? existing.rows[0];
    }
    return asRecord(await new SourcePostProcessingService(this.db, requiredConfig(this.config)).createRule(identity, channelId, {
      project_id: projectId,
      agent_id: input.agentId,
      name: ruleName,
      trigger_type: "items_materialized",
      trigger_config_json: { min_new_items: 1, cooldown_seconds: 0, timezone: "UTC", skip_when_no_new_items: true },
      input_config_json: {
        window: "new_since_last_success",
        item_limit: SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize,
        max_batches_per_event: 10,
        processing_strategy: "screen_extract_digest",
        content_source: "prefer_extracted_text_for_candidates",
        include_excerpts: true,
        include_evidence: true,
        timezone: "UTC",
        runtime_profile_id: input.runtimeProfileId,
        structured_output_schema_id: "source_post_processing.result.v1",
        research_question_version: 1,
        thread_scope: input.threadScope,
        content_profile: contentProfileForProvider(providerKey),
        summary_goal: input.researchQuestion,
        retrieval_context: { enabled: true, domains: ["project"], query: input.researchQuestion, max_results_per_domain: 10, mode: "hybrid" },
        candidate_prefilter: { enabled: true, mode: "hybrid", max_candidates: 100 },
        deep_analysis: {
          enabled: true,
          trigger_relevance: ["relevant", "maybe"],
          min_confidence: 0.5,
          max_candidates_per_run: SOURCE_POST_PROCESSING_LIMITS.deepAnalysisMaxCandidatesPerRun,
          content_source: "prefer_extracted_text",
          output: "per_item_deep_summary",
        },
        relevance_profile: relevanceProfile,
      },
      actions_json: { batch_digest: true, per_item_summary: true, extract_evidence: true, create_proposals: false, mark_items: true },
    }));
  }

  async ensureProcessingBatchSize(identity: SpaceUserIdentity, ruleIds: string[]): Promise<void> {
    const rules = await this.db.query<{ id: string; source_channel_id: string; input_config_json: unknown }>(
      `SELECT id, source_channel_id, input_config_json
         FROM source_post_processing_rules
        WHERE space_id=$1 AND id=ANY($2::text[]) AND project_id IS NOT NULL AND status <> 'archived'`,
      [identity.spaceId, ruleIds],
    );
    const service = new SourcePostProcessingService(this.db, requiredConfig(this.config));
    for (const rule of rules.rows) {
      const inputConfig = objectValue(rule.input_config_json);
      if (inputConfig.item_limit === SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize) continue;
      await service.updateRule(identity, rule.source_channel_id, rule.id, {
        input_config_json: {
          ...inputConfig,
          item_limit: SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize,
        },
      });
    }
  }
}

function requiredConfig(config: ServerConfig | undefined): ServerConfig {
  if (!config) throw new HttpError(500, "Project Research source processing is not configured");
  return config;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentProfileForProvider(providerKey: string): "generic" | "arxiv_new_papers" {
  return providerKey === "arxiv" ? "arxiv_new_papers" : "generic";
}
