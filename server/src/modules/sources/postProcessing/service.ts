import type { ServerConfig } from "../../../config";
import { getDbPool, type Pool } from "../../../db/pool";
import type {
  RetrievalObjectType,
  RetrievalSearchResult,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { PgAgentRepository } from "../../agents/repository";
import { PgJobQueueRepository } from "../../jobs/repository";
import { PgRunRepository, type RunRecord } from "../../runs/repository";
import { RunMaterializationService } from "../../runs/materializationService";
import { RunOrchestrationService } from "../../runs/orchestrationService";
import { runOutputResult } from "../../runs/orchestrationResults";
import { sharedCliProcessRegistry } from "../../runs/processRegistry";
import { createManagedExecutionPolicy } from "../../policy/managedExecutionPolicy";
import { PgCodePatchCollector, PgRunSandboxManager } from "../../projectFolders";
import { PgVerificationEngine } from "../../runs/verification";
import {
  HttpError,
  objectValue,
  optionalString,
  requiredString,
  type Queryable,
  type SpaceUserIdentity,
} from "../../routeUtils/common";
import { normalizeThreadScope, checkPinnedThreadDrift } from "../../projectResearch/threadScope";
import {
  enforceSourceDerivedImportTarget,
  normalizeSourceConnectionReadGovernance,
} from "../sourceConsent";
import { knowledgeRetrievalRegistry } from "../../knowledge/retrievalAdapter";
import { memoryRetrievalRegistry } from "../../memory/retrievalAdapter";
import { projectRetrievalRegistry } from "../../projects/retrievalAdapter";
import { RetrievalSearchService, type RetrievalRegistry } from "../../retrieval";
import { ProviderQueryEmbedder } from "../../retrieval/embedding/queryEmbedder";
import { ProviderReranker } from "../../retrieval/rerankProvider/providerReranker";
import { readSpaceRetrievalSettings } from "../../retrieval/settings";
import { resolveProviderCommandStore } from "../../providers/commands/store";
import { assertSourcePromptEgressAllowed } from "../sourcePromptEgress";
import { ITEM_COLUMNS, type EvidenceRow, type SourceItemRow, type SourceConnectionRow } from "../sourceRepositoryRows";
import { sourceRetrievalRegistry } from "../retrievalAdapter";
import { contentReadSql } from "../../access/contentAccessSql";
import {
  PgSourcePostProcessingRepository,
  SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,
  cursorWatermark,
  isRelevanceScreeningEnabled,
  normalizeActions,
  normalizeDecisionReviewStatus,
  normalizeInputConfig,
  normalizeItemRelevance,
  normalizeRuleStatus,
  normalizeTriggerConfig,
  normalizeTriggerType,
  timestampString,
  type SourcePostProcessingActions,
  type SourcePostProcessingBacklogOut,
  type SourcePostProcessingBriefingDaySummaryOut,
  type SourcePostProcessingBriefingDetailOut,
  type SourcePostProcessingInputBatch,
  type SourcePostProcessingInputConfig,
  type SourcePostProcessingItemDecision,
  type SourcePostProcessingItemDecisionOut,
  type SourcePostProcessingRelevanceProfile,
  type SourcePostProcessingRetrievalDomain,
  type SourcePostProcessingRuleOut,
  type SourcePostProcessingRuleRow,
  type SourcePostProcessingRunOut,
  type SourcePostProcessingTriggerConfig,
  type SourcePostProcessingTriggerType,
} from "./repository";
import { ProjectResearchAreaService } from "../../projectResearch/areaService";
import { resolveProjectResearchEvidenceCardPrompt } from "../../projectResearch/promptRegistry";
import {
  buildRetrievalContextQuery,
  renderInstruction,
  type SourcePostProcessingRetrievalContextRef,
  type SourcePostProcessingRetrievalContextSnapshot,
} from "./instruction";
import {
  parsePostProcessingResult,
  resultSummary,
  type ParsedPostProcessingResult,
} from "./resultParser";
import { joinText, stringList } from "./textUtils";
import { SOURCE_POST_PROCESSING_LIMITS } from "./config";
import { resolveModelWindow } from "../../usage/modelCatalog";
import { SOURCE_POST_PROCESSING_OUTPUT_CONTRACT } from "../../projectResearch/outputSchemas";

interface RetrievalContextDomainConfig {
  registry: RetrievalRegistry;
  objectTypes?: RetrievalObjectType[];
  surface: string;
}

interface CandidatePrefilterResult {
  promptBatch: SourcePostProcessingInputBatch;
  syntheticDecisions: SourcePostProcessingItemDecision[];
  metadata: Record<string, unknown> | null;
}

/**
 * Floor for the prompt budget, used when the rule's model is not in the model
 * registry. The budget itself is derived from the model's context window — see
 * `promptBudgetCharsFor`.
 */
const SOURCE_POST_PROCESSING_PROMPT_BUDGET_FLOOR_CHARS = 48_000;
/**
 * The context planner counts a token as one UTF-8 byte, and one character can
 * be three bytes, so a character budget of a third of the token budget cannot
 * overflow the window even on CJK-heavy material.
 */
const SOURCE_POST_PROCESSING_PROMPT_BYTES_PER_CHAR = 3;
const SOURCE_POST_PROCESSING_PROMPT_FIXED_RESERVE_CHARS = 12_000;
const SOURCE_POST_PROCESSING_EXTRACTED_TEXT_SNIPPET_RESERVE_CHARS = 2_400;

export class SourcePostProcessingService {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  async listRules(identity: SpaceUserIdentity, connectionId: string): Promise<SourcePostProcessingRuleOut[]> {
    await this.requireConnection(identity.spaceId, connectionId);
    return new PgSourcePostProcessingRepository(this.db).listRules(identity.spaceId, connectionId);
  }

  async createRule(
    identity: SpaceUserIdentity,
    connectionId: string,
    body: Record<string, unknown>,
  ): Promise<SourcePostProcessingRuleOut> {
    const connection = await this.requireConnection(identity.spaceId, connectionId);
    const triggerType = normalizeTriggerType(body.trigger_type);
    const triggerConfig = normalizeTriggerConfig(body.trigger_config_json, triggerType);
    const inputConfig = normalizeInputConfig(body.input_config_json);
    const actions = normalizeActions(body.actions_json);
    this.assertActions(actions);
    await this.enforceSourceTargets(connection, actions);
    const agentId = await this.resolveAgentId(identity, optionalString(body.agent_id));
    const projectId = optionalString(body.project_id);
    if (projectId) await this.assertProjectInSpace(identity.spaceId, projectId);
    this.validateInputContextBinding(projectId, inputConfig, actions);
    const name = optionalString(body.name) ?? defaultRuleName(triggerType, actions);
    return new PgSourcePostProcessingRepository(this.db).createRule({
      spaceId: identity.spaceId,
      sourceChannelId: connectionId,
      agentId,
      projectId,
      name,
      triggerType,
      triggerConfig,
      inputConfig,
      actions,
      createdByUserId: identity.userId,
    });
  }

  async updateRule(
    identity: SpaceUserIdentity,
    connectionId: string,
    ruleId: string,
    body: Record<string, unknown>,
  ): Promise<SourcePostProcessingRuleOut> {
    const repo = new PgSourcePostProcessingRepository(this.db);
    const existing = await repo.getRule(identity.spaceId, ruleId);
    if (!existing || existing.source_channel_id !== connectionId) {
      throw new HttpError(404, "Post-processing rule not found");
    }
    const connection = await this.requireConnection(identity.spaceId, connectionId);
    const triggerType = Object.hasOwn(body, "trigger_type")
      ? normalizeTriggerType(body.trigger_type)
      : existing.trigger_type;
    const triggerConfig = Object.hasOwn(body, "trigger_config_json")
      ? normalizeTriggerConfig(body.trigger_config_json, triggerType)
      : undefined;
    const inputConfig = Object.hasOwn(body, "input_config_json")
      ? normalizeInputConfig(body.input_config_json)
      : undefined;
    const actions = Object.hasOwn(body, "actions_json")
      ? normalizeActions(body.actions_json)
      : undefined;
    if (actions) {
      this.assertActions(actions);
      await this.enforceSourceTargets(connection, actions);
    }
    const agentId = Object.hasOwn(body, "agent_id")
      ? await this.resolveAgentId(identity, optionalString(body.agent_id))
      : undefined;
    const projectId = Object.hasOwn(body, "project_id") ? optionalString(body.project_id) : undefined;
    if (projectId) await this.assertProjectInSpace(identity.spaceId, projectId);
    this.validateInputContextBinding(
      projectId === undefined ? existing.project_id : projectId,
      inputConfig ?? normalizeInputConfig(existing.input_config_json),
      actions ?? normalizeActions(existing.actions_json),
    );
    return repo.updateRule(identity.spaceId, ruleId, {
      name: Object.hasOwn(body, "name") ? requiredString(body.name, "name") : undefined,
      agentId,
      projectId,
      status: Object.hasOwn(body, "status") ? normalizeRuleStatus(body.status) : undefined,
      triggerType: Object.hasOwn(body, "trigger_type") ? triggerType : undefined,
      triggerConfig,
      inputConfig,
      actions,
    });
  }

  async runRuleNow(
    identity: SpaceUserIdentity,
    connectionId: string,
    ruleId: string,
  ): Promise<SourcePostProcessingRunOut> {
    const repo = new PgSourcePostProcessingRepository(this.db);
    const rule = await repo.getRule(identity.spaceId, ruleId);
    if (!rule || rule.source_channel_id !== connectionId) {
      throw new HttpError(404, "Post-processing rule not found");
    }
    return this.executeRule(rule, {
      triggerType: "manual",
      actorUserId: identity.userId,
      force: true,
    });
  }

  async runDeepAnalysisForItems(input: {
    spaceId: string;
    ruleId: string;
    itemIds: string[];
    actorUserId: string | null;
    sourceRunId: string | null;
  }): Promise<SourcePostProcessingRunOut | null> {
    if (input.itemIds.length === 0) return null;
    const repo = new PgSourcePostProcessingRepository(this.db);
    const rule = await repo.getRule(input.spaceId, input.ruleId);
    if (!rule || rule.status !== "active") return null;
    const baseInputConfig = normalizeInputConfig(rule.input_config_json);
    if (!baseInputConfig.deep_analysis.enabled) return null;
    this.validateInputContextBinding(rule.project_id, baseInputConfig, normalizeActions(rule.actions_json));
    const connection = await this.requireConnection(rule.space_id, rule.source_channel_id);
    const deepInputConfig = deepAnalysisInputConfig(baseInputConfig, input.sourceRunId);
    const itemIds = input.itemIds.slice(0, deepInputConfig.deep_analysis.max_candidates_per_run);
    const batch = await repo.collectInputBatch({
      spaceId: rule.space_id,
      sourceChannelId: rule.source_channel_id,
      inputConfig: deepInputConfig,
      cursor: null,
      viewerUserId: input.actorUserId ?? connection.owner_user_id,
      explicitItemIds: itemIds,
    });
    if (batch.items.length === 0) return null;
    const baseActions = normalizeActions(rule.actions_json);
    const deepActions: SourcePostProcessingActions = {
      batch_digest: baseInputConfig.deep_analysis.output === "deep_report",
      per_item_summary: baseInputConfig.deep_analysis.output === "per_item_deep_summary",
      extract_evidence: baseActions.extract_evidence,
      create_proposals: baseActions.create_proposals,
      mark_items: false,
    };
    return this.executeBatch({
      rule,
      sourceChannelId: rule.source_channel_id,
      connection,
      agentId: rule.agent_id,
      projectId: rule.project_id,
      triggerType: "manual",
      actorUserId: input.actorUserId ?? rule.created_by_user_id,
      actions: deepActions,
      inputConfig: deepInputConfig,
      triggerConfig: normalizeTriggerConfig(rule.trigger_config_json, "manual"),
      batch,
      summaryGoal: deepInputConfig.summary_goal ?? baseInputConfig.summary_goal ?? null,
    });
  }

  /**
   * Re-run a rule for a known set of source items without consulting the
   * monitor cursor. Research recovery uses this path when ingestion already
   * advanced the rule cursor but the corresponding classification run was
   * never materialized.
   */
  async runRuleForItems(input: {
    spaceId: string;
    ruleId: string;
    itemIds: string[];
  }): Promise<SourcePostProcessingRunOut | null> {
    if (input.itemIds.length === 0) return null;
    if (input.itemIds.length > SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize) {
      throw new HttpError(
        422,
        `Research structured-output recovery accepts at most ${SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize} source items per run`,
      );
    }
    const repo = new PgSourcePostProcessingRepository(this.db);
    const rule = await repo.getRule(input.spaceId, input.ruleId);
    if (!rule || rule.status !== "active") return null;
    const connection = await this.requireConnection(rule.space_id, rule.source_channel_id);
    const actions = normalizeActions(rule.actions_json);
    const inputConfig = { ...normalizeInputConfig(rule.input_config_json), window: "explicit" as const };
    const triggerConfig = normalizeTriggerConfig(rule.trigger_config_json, rule.trigger_type);
    await this.enforceSourceTargets(connection, actions);
    this.validateInputContextBinding(rule.project_id, inputConfig, actions);
    const batch = await repo.collectInputBatch({
      spaceId: rule.space_id,
      sourceChannelId: rule.source_channel_id,
      inputConfig,
      cursor: null,
      viewerUserId: rule.created_by_user_id,
      explicitItemIds: input.itemIds,
    });
    if (batch.items.length === 0 && batch.evidence.length === 0) return null;
    return this.executeBatch({
      rule,
      sourceChannelId: rule.source_channel_id,
      connection,
      agentId: rule.agent_id,
      projectId: rule.project_id,
      triggerType: "items_materialized",
      actorUserId: rule.created_by_user_id,
      actions,
      inputConfig,
      triggerConfig,
      batch,
      summaryGoal: inputConfig.summary_goal ?? null,
      executionTimeoutMs: SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputTimeoutMs,
    });
  }

  async drainRuleNow(
    identity: SpaceUserIdentity,
    connectionId: string,
    ruleId: string,
  ): Promise<{ runs: SourcePostProcessingRunOut[]; stopped_reason: string; pending_item_count: number }> {
    const repo = new PgSourcePostProcessingRepository(this.db);
    const firstRule = await repo.getRule(identity.spaceId, ruleId);
    if (!firstRule || firstRule.source_channel_id !== connectionId) {
      throw new HttpError(404, "Post-processing rule not found");
    }
    const maxBatches = normalizeInputConfig(firstRule.input_config_json).max_batches_per_event;
    const runs: SourcePostProcessingRunOut[] = [];
    let stoppedReason = "max_batches_reached";
    for (let index = 0; index < maxBatches; index += 1) {
      const rule = await repo.getRule(identity.spaceId, ruleId);
      if (!rule || rule.source_channel_id !== connectionId) {
        stoppedReason = "rule_missing";
        break;
      }
      const run = await this.executeRule(rule, {
        triggerType: "manual",
        actorUserId: identity.userId,
        force: true,
      });
      runs.push(run);
      if (run.status === "skipped") {
        stoppedReason = "no_inputs";
        break;
      }
      if (run.status !== "succeeded") {
        stoppedReason = "run_failed";
        break;
      }
      if (run.input_item_ids.length === 0) {
        stoppedReason = "no_inputs";
        break;
      }
    }
    const backlog = await repo.backlog(identity.spaceId, connectionId);
    const ruleBacklog = backlog.rules.find((item) => item.rule_id === ruleId);
    if ((ruleBacklog?.pending_item_count ?? 0) === 0 && stoppedReason === "max_batches_reached") {
      stoppedReason = "drained";
    }
    return {
      runs,
      stopped_reason: stoppedReason,
      pending_item_count: ruleBacklog?.pending_item_count ?? 0,
    };
  }

  async listRuns(
    identity: SpaceUserIdentity,
    connectionId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: SourcePostProcessingRunOut[]; total: number; limit: number; offset: number }> {
    await this.requireConnection(identity.spaceId, connectionId);
    return new PgSourcePostProcessingRepository(this.db).listRuns(identity.spaceId, connectionId, limit, offset);
  }

  async backlog(identity: SpaceUserIdentity, connectionId: string): Promise<SourcePostProcessingBacklogOut> {
    await this.requireConnection(identity.spaceId, connectionId);
    return new PgSourcePostProcessingRepository(this.db).backlog(identity.spaceId, connectionId);
  }

  async listDecisions(
    identity: SpaceUserIdentity,
    filters: {
      connectionId?: string | null;
      projectId?: string | null;
      ruleId?: string | null;
      relevance?: string | null;
      reviewStatus?: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: SourcePostProcessingItemDecisionOut[]; total: number; limit: number; offset: number }> {
    if (filters.connectionId) await this.requireConnection(identity.spaceId, filters.connectionId);
    if (filters.projectId) await this.assertProjectInSpace(identity.spaceId, filters.projectId);
    return new PgSourcePostProcessingRepository(this.db).listDecisions({
      spaceId: identity.spaceId,
      connectionId: filters.connectionId,
      projectId: filters.projectId,
      ruleId: filters.ruleId,
      relevance: filters.relevance ? normalizeItemRelevance(filters.relevance) : null,
      reviewStatus: filters.reviewStatus ? normalizeDecisionReviewStatus(filters.reviewStatus) : null,
      limit: filters.limit,
      offset: filters.offset,
    });
  }

  /** Space-level Brief reading stream. Documented in .agent/modules/brief.md. */
  async listBriefings(
    identity: SpaceUserIdentity,
    filters: {
      connectionId?: string | null;
      projectId?: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: SourcePostProcessingBriefingDaySummaryOut[]; total: number; limit: number; offset: number }> {
    if (filters.connectionId) await this.requireConnection(identity.spaceId, filters.connectionId);
    if (filters.projectId) await this.assertProjectInSpace(identity.spaceId, filters.projectId);
    return new PgSourcePostProcessingRepository(this.db).listBriefings({
      spaceId: identity.spaceId,
      userId: identity.userId,
      connectionId: filters.connectionId,
      projectId: filters.projectId,
      limit: filters.limit,
      offset: filters.offset,
    });
  }

  async getBriefing(
    identity: SpaceUserIdentity,
    connectionId: string,
    date: string,
  ): Promise<SourcePostProcessingBriefingDetailOut> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(422, "date must be an ISO calendar date (YYYY-MM-DD)");
    }
    await this.requireConnection(identity.spaceId, connectionId);
    const briefing = await new PgSourcePostProcessingRepository(this.db).getBriefing({
      spaceId: identity.spaceId,
      userId: identity.userId,
      connectionId,
      date,
    });
    if (!briefing) throw new HttpError(404, "No briefing found for that source and date");
    return briefing;
  }

  async decisionAction(
    identity: SpaceUserIdentity,
    decisionId: string,
    body: Record<string, unknown>,
  ): Promise<{
    decision: SourcePostProcessingItemDecisionOut;
    proposal_id?: string;
    job_ids?: string[];
    run?: SourcePostProcessingRunOut;
  }> {
    const repo = new PgSourcePostProcessingRepository(this.db);
    const decision = await repo.getDecision(identity.spaceId, decisionId);
    if (!decision) throw new HttpError(404, "Post-processing decision not found");
    const connection = await this.requireConnection(identity.spaceId, decision.source_channel_id);
    const action = requiredString(body.action, "action");
    if (action === "select" || action === "triage" || action === "ignore") {
      const status = action === "select" ? "selected" : action === "ignore" ? "ignored" : "triaged";
      await repo.setItemStatus(identity.spaceId, identity.userId, decision.source_item_id, status);
      return {
        decision: await repo.updateDecisionReview({
          spaceId: identity.spaceId,
          decisionId,
          reviewStatus: action === "ignore" ? "ignored" : "accepted",
          action: { [action]: { at: new Date().toISOString(), by_user_id: identity.userId } },
        }),
      };
    }
    if (action === "queue_content") {
      const jobIds = await repo.queueFullTextExtractionForItems({
        spaceId: identity.spaceId,
        connection,
        itemIds: [decision.source_item_id],
        metadata: {
          source: "source_post_processing_decision_review",
          source_post_processing_decision_id: decision.id,
        },
      });
      return {
        decision: await repo.updateDecisionReview({
          spaceId: identity.spaceId,
          decisionId,
          reviewStatus: "queued",
          action: { queue_content: { at: new Date().toISOString(), by_user_id: identity.userId, job_ids: jobIds } },
        }),
        job_ids: jobIds,
      };
    }
    if (action === "extract_evidence") {
      const item = await this.loadDecisionItem(identity.spaceId, decision.source_item_id);
      if (!item) throw new HttpError(404, "Source item not found");
      const evidenceId = await repo.insertEvidence({
        spaceId: identity.spaceId,
        item,
        artifactId: null,
        title: item.title,
        content: decision.reason || item.excerpt || item.title,
        createdByUserId: identity.userId,
        createdByAgentId: null,
        createdByRunId: null,
        metadata: {
          source: "source_post_processing_decision_review",
          source_post_processing_decision_id: decision.id,
          relevance: decision.relevance,
        },
      });
      if (decision.project_id) {
        await repo.linkEvidenceToProject({
          spaceId: identity.spaceId,
          evidenceId,
          projectId: decision.project_id,
          createdByUserId: identity.userId,
          createdByAgentId: null,
          createdByRunId: null,
          reason: `source_post_processing_decision:${decision.id}`,
        });
      }
      return {
        decision: await repo.updateDecisionReview({
          spaceId: identity.spaceId,
          decisionId,
          reviewStatus: "accepted",
          action: { extract_evidence: { at: new Date().toISOString(), by_user_id: identity.userId, evidence_id: evidenceId } },
        }),
      };
    }
    if (action === "create_proposal") {
      const item = await this.loadDecisionItem(identity.spaceId, decision.source_item_id);
      if (!item) throw new HttpError(404, "Source item not found");
      const proposalMarkdown = [
        `# ${item.title}`,
        "",
        decision.reason ? `Relevance: ${decision.reason}` : null,
        item.excerpt ? `Excerpt: ${item.excerpt}` : null,
        item.source_uri ? `Source: ${item.source_uri}` : null,
      ].filter(Boolean).join("\n\n");
      const proposalId = await repo.insertProposal({
        spaceId: identity.spaceId,
        runId: null,
        agentId: null,
        userId: identity.userId,
        projectId: decision.project_id,
        title: `Review source candidate: ${item.title}`,
        summary: proposalMarkdown,
        payload: {
          operation: "create",
          proposed_content: proposalMarkdown,
          source_refs: [{ type: "source_item", id: item.id }],
          metadata: {
            generated_by: "source_post_processing_decision_review",
            source_post_processing_decision_id: decision.id,
            source_channel_id: decision.source_channel_id,
            project_id: decision.project_id,
          },
        },
      });
      return {
        decision: await repo.updateDecisionReview({
          spaceId: identity.spaceId,
          decisionId,
          reviewStatus: "proposed",
          action: { create_proposal: { at: new Date().toISOString(), by_user_id: identity.userId, proposal_id: proposalId } },
        }),
        proposal_id: proposalId,
      };
    }
    if (action === "rerun_item") {
      const rule = decision.rule_id ? await repo.getRule(identity.spaceId, decision.rule_id) : null;
      if (!rule) throw new HttpError(422, "Decision rerun requires an existing rule");
      const inputConfig = { ...normalizeInputConfig(rule.input_config_json), window: "explicit" as const };
      const batch = await repo.collectInputBatch({
        spaceId: identity.spaceId,
        sourceChannelId: decision.source_channel_id,
        inputConfig,
        cursor: null,
        viewerUserId: identity.userId,
        explicitItemIds: [decision.source_item_id],
      });
      const run = await this.executeBatch({
        rule,
        sourceChannelId: decision.source_channel_id,
        connection,
        agentId: rule.agent_id,
        projectId: rule.project_id,
        triggerType: "manual",
        actorUserId: identity.userId,
        actions: normalizeActions(rule.actions_json),
        inputConfig,
        triggerConfig: normalizeTriggerConfig(rule.trigger_config_json, "manual"),
        batch,
        summaryGoal: inputConfig.summary_goal ?? null,
      });
      return {
        decision: await repo.updateDecisionReview({
          spaceId: identity.spaceId,
          decisionId,
          reviewStatus: "rerun",
          action: { rerun_item: { at: new Date().toISOString(), by_user_id: identity.userId, run_id: run.id } },
        }),
        run,
      };
    }
    if (action === "deep_analysis") {
      if (!decision.rule_id) throw new HttpError(422, "Deep analysis requires a rule-backed decision");
      const run = await this.runDeepAnalysisForItems({
        spaceId: identity.spaceId,
        ruleId: decision.rule_id,
        itemIds: [decision.source_item_id],
        actorUserId: identity.userId,
        sourceRunId: decision.run_id,
      });
      if (!run) throw new HttpError(422, "Deep analysis is not enabled for this rule or item.");
      return {
        decision: await repo.updateDecisionReview({
          spaceId: identity.spaceId,
          decisionId,
          reviewStatus: "rerun",
          action: { deep_analysis: { at: new Date().toISOString(), by_user_id: identity.userId, run_id: run.id } },
        }),
        run,
      };
    }
    if (action === "dismiss") {
      return {
        decision: await repo.updateDecisionReview({
          spaceId: identity.spaceId,
          decisionId,
          reviewStatus: "dismissed",
          action: { dismiss: { at: new Date().toISOString(), by_user_id: identity.userId } },
        }),
      };
    }
    throw new HttpError(422, "Unsupported post-processing decision action");
  }

  async runOneOff(
    identity: SpaceUserIdentity,
    body: Record<string, unknown>,
  ): Promise<SourcePostProcessingRunOut & { artifact_id: string | null; proposal_ids: string[]; summary_preview: string }> {
    const itemIds = stringList(body.source_item_ids);
    const evidenceIds = stringList(body.evidence_ids);
    if (!itemIds.length && !evidenceIds.length) {
      throw new HttpError(422, "At least one source_item_id or evidence_id is required");
    }
    const repo = new PgSourcePostProcessingRepository(this.db);
    const sourceChannelId = await this.resolveOneOffSourceConnection(identity.spaceId, itemIds, evidenceIds, identity.userId);
    const connection = await this.requireConnection(identity.spaceId, sourceChannelId);
    const actions = normalizeActions(body.actions_json ?? { batch_digest: true });
    this.assertActions(actions);
    await this.enforceSourceTargets(connection, actions);
    const agentId = await this.resolveAgentId(identity, optionalString(body.agent_id));
    const projectId = optionalString(body.project_id);
    if (projectId) await this.assertProjectInSpace(identity.spaceId, projectId);
    this.validateInputContextBinding(projectId, normalizeInputConfig(body.input_config_json), actions);
    const batch = await repo.collectInputBatch({
      spaceId: identity.spaceId,
      sourceChannelId,
      inputConfig: {
        ...normalizeInputConfig(body.input_config_json),
        window: "explicit",
      },
      cursor: null,
      viewerUserId: identity.userId,
      explicitItemIds: itemIds,
      explicitEvidenceIds: evidenceIds,
    });
    const run = await this.executeBatch({
      rule: null,
      sourceChannelId,
      connection,
      agentId,
      projectId,
      triggerType: "manual",
      actorUserId: identity.userId,
      actions,
      inputConfig: { ...normalizeInputConfig(body.input_config_json), window: "explicit" },
      triggerConfig: normalizeTriggerConfig(body.trigger_config_json, "manual"),
      batch,
      summaryGoal: optionalString(body.summary_goal),
    });
    return {
      ...run,
      artifact_id: run.output_artifact_ids[0] ?? null,
      proposal_ids: run.output_proposal_ids,
      summary_preview: (run.summary ?? "").slice(0, 500),
    };
  }

  async fireSourceEvent(input: {
    spaceId: string;
    sourceChannelId: string;
    newItemCount: number;
  }): Promise<{
    matched: number;
    fired: number;
    skipped: Array<{ rule_id: string; reason: string }>;
    successful_runs: Array<{ run_id: string; project_id: string | null; source_channel_id: string; source_item_ids: string[]; user_id: string | null }>;
  }> {
    const repo = new PgSourcePostProcessingRepository(this.db);
    const rules = await repo.listActiveRulesForSource(
      input.spaceId,
      input.sourceChannelId,
      "items_materialized",
    );
    const skipped: Array<{ rule_id: string; reason: string }> = [];
    const successfulRuns: Array<{ run_id: string; project_id: string | null; source_channel_id: string; source_item_ids: string[]; user_id: string | null }> = [];
    let fired = 0;
    for (const rule of rules) {
      const triggerConfig = normalizeTriggerConfig(rule.trigger_config_json, rule.trigger_type);
      if (input.newItemCount < triggerConfig.min_new_items) {
        skipped.push({ rule_id: rule.id, reason: "below_min_new_items" });
        continue;
      }
      if (inCooldown(rule.last_fired_at, triggerConfig.cooldown_seconds)) {
        skipped.push({ rule_id: rule.id, reason: "cooldown" });
        continue;
      }
      if (await repo.hasInFlightRun(rule.space_id, rule.id)) {
        skipped.push({ rule_id: rule.id, reason: "run_in_flight" });
        continue;
      }
      try {
        const result = await this.drainActiveRuleFromEvent(rule);
        if (result.runs.length === 0 || result.runs.every((run) => run.status === "skipped")) {
          skipped.push({ rule_id: rule.id, reason: "no_inputs" });
        } else {
          const succeeded = result.runs.filter((run) => run.status === "succeeded");
          fired += succeeded.length;
          successfulRuns.push(...succeeded.map((run) => ({
            run_id: run.id,
            project_id: run.project_id,
            source_channel_id: run.source_channel_id,
            source_item_ids: run.input_item_ids,
            user_id: run.triggered_by_user_id,
          })));
          if (result.stopped_reason === "run_failed") skipped.push({ rule_id: rule.id, reason: "run_failed" });
        }
      } catch (error) {
        if (isTransientPostProcessingError(error)) throw error;
        skipped.push({ rule_id: rule.id, reason: error instanceof Error ? error.message : "run_failed" });
      }
    }
    return { matched: rules.length, fired, skipped, successful_runs: successfulRuns };
  }

  async fireScheduledRule(rule: SourcePostProcessingRuleRow): Promise<SourcePostProcessingRunOut> {
    return this.executeRule(rule, {
      triggerType: "schedule",
      actorUserId: rule.created_by_user_id,
    });
  }

  private async drainActiveRuleFromEvent(
    initialRule: SourcePostProcessingRuleRow,
  ): Promise<{ runs: SourcePostProcessingRunOut[]; stopped_reason: string }> {
    const repo = new PgSourcePostProcessingRepository(this.db);
    const maxBatches = normalizeInputConfig(initialRule.input_config_json).max_batches_per_event;
    const runs: SourcePostProcessingRunOut[] = [];
    let stoppedReason = "max_batches_reached";
    for (let index = 0; index < maxBatches; index += 1) {
      const rule = index === 0 ? initialRule : await repo.getRule(initialRule.space_id, initialRule.id);
      if (!rule || rule.status !== "active") {
        stoppedReason = "rule_inactive";
        break;
      }
      const run = await this.executeRule(rule, {
        triggerType: "items_materialized",
        actorUserId: rule.created_by_user_id,
      });
      runs.push(run);
      if (run.status === "skipped") {
        stoppedReason = "no_inputs";
        break;
      }
      if (run.status !== "succeeded") {
        stoppedReason = "run_failed";
        break;
      }
      if (run.input_item_ids.length === 0) {
        stoppedReason = "no_inputs";
        break;
      }
    }
    return { runs, stopped_reason: stoppedReason };
  }

  private async executeRule(
    rule: SourcePostProcessingRuleRow,
    options: {
      triggerType: SourcePostProcessingTriggerType;
      actorUserId: string;
      force?: boolean;
    },
  ): Promise<SourcePostProcessingRunOut> {
    if (rule.status !== "active" && !options.force) {
      throw new HttpError(409, "Post-processing rule is not active");
    }
    if (await this.researchQuestionDrift(rule)) {
      const repo = new PgSourcePostProcessingRepository(this.db);
      const cursor = cursorWatermark(rule.cursor_json);
      const run = await repo.createRun({
        spaceId: rule.space_id,
        ruleId: rule.id,
        sourceChannelId: rule.source_channel_id,
        agentId: rule.agent_id,
        projectId: rule.project_id,
        triggeredByUserId: options.actorUserId,
        triggerType: options.triggerType,
        inputItemIds: [],
        inputEvidenceIds: [],
        cursorBefore: cursor,
        cursorAfter: cursor,
      });
      await repo.recordRuleFire(rule.space_id, rule.id);
      return repo.markRunFinished({
        runId: run.id,
        spaceId: rule.space_id,
        status: "skipped",
        summary: "Research question changed; source processing is paused until the new question is applied to future runs.",
      });
    }
    const connection = await this.requireConnection(rule.space_id, rule.source_channel_id);
    const actions = normalizeActions(rule.actions_json);
    const inputConfig = effectiveInputConfig(rule);
    const triggerConfig = normalizeTriggerConfig(rule.trigger_config_json, rule.trigger_type);
    await this.enforceSourceTargets(connection, actions);
    this.validateInputContextBinding(rule.project_id, inputConfig, actions);
    const repo = new PgSourcePostProcessingRepository(this.db);
    const batch = await repo.collectInputBatch({
      spaceId: rule.space_id,
      sourceChannelId: rule.source_channel_id,
      inputConfig,
      cursor: cursorWatermark(rule.cursor_json),
      viewerUserId: options.actorUserId,
    });
    if (batch.items.length === 0 && batch.evidence.length === 0 && triggerConfig.skip_when_no_new_items) {
      const run = await repo.createRun({
        spaceId: rule.space_id,
        ruleId: rule.id,
        sourceChannelId: rule.source_channel_id,
        agentId: rule.agent_id,
        projectId: rule.project_id,
        triggeredByUserId: options.actorUserId,
        triggerType: options.triggerType,
        inputItemIds: [],
        inputEvidenceIds: [],
        cursorBefore: batch.cursorBefore,
        cursorAfter: batch.cursorAfter,
      });
      await repo.recordRuleFire(rule.space_id, rule.id);
      return repo.markRunFinished({
        runId: run.id,
        spaceId: rule.space_id,
        status: "skipped",
        summary: "No new source items matched this rule.",
      });
    }
    return this.executeBatch({
      rule,
      sourceChannelId: rule.source_channel_id,
      connection,
      agentId: rule.agent_id,
      projectId: rule.project_id,
      triggerType: options.triggerType,
      actorUserId: options.actorUserId,
      actions,
      inputConfig,
      triggerConfig,
      batch,
      summaryGoal: inputConfig.summary_goal ?? null,
    });
  }

  private async researchQuestionDrift(rule: SourcePostProcessingRuleRow): Promise<boolean> {
    if (!rule.project_id || !rule.name.startsWith("Auto Research:")) return false;
    const result = await this.db.query<{ workflow_state_json: unknown }>(
      `SELECT workflow.state_json AS workflow_state_json
         FROM project_research_workflows workflow
         JOIN space_objects object ON object.id=workflow.object_id AND object.space_id=workflow.space_id
        WHERE workflow.space_id=$1 AND workflow.project_id=$2 AND workflow.status IN ('active','paused')
        ORDER BY object.updated_at DESC
        LIMIT 1`,
      [rule.space_id, rule.project_id],
    );
    const row = result.rows[0];
    if (!row) return false;
    // The pinned Inquiry Thread is the sole Question authority; there is
    // nothing to compare drift against once the Workflow has no scope yet.
    const pinned = normalizeThreadScope(objectValue(row.workflow_state_json).thread_scope)[0];
    if (!pinned) return false;
    return (await checkPinnedThreadDrift(this.db, rule.space_id, rule.project_id, pinned)).drifted;
  }

  private async executeBatch(input: {
    rule: SourcePostProcessingRuleRow | null;
    sourceChannelId: string;
    connection: SourceConnectionRow;
    agentId: string;
    projectId: string | null;
    triggerType: SourcePostProcessingTriggerType;
    actorUserId: string;
    actions: SourcePostProcessingActions;
    inputConfig: SourcePostProcessingInputConfig;
    triggerConfig: SourcePostProcessingTriggerConfig;
    batch: SourcePostProcessingInputBatch;
    summaryGoal: string | null;
    executionTimeoutMs?: number;
  }): Promise<SourcePostProcessingRunOut> {
    if (input.rule && await this.researchQuestionDrift(input.rule)) {
      throw new HttpError(409, "Research question changed; apply it to future runs before processing this item");
    }
    const repo = new PgSourcePostProcessingRepository(this.db);
    const batch = fitBatchToPromptBudget(
      input.batch,
      input.inputConfig,
      promptBudgetCharsFor(await this.agentModelName(input.connection.space_id, input.agentId)),
    );
    // Trimming is not free: the items left behind carry no decision, so the
    // Research recovery loop re-queues them as another batch and the reviewer
    // gets another gate. Say so in the run rather than dropping them quietly.
    const trimmedItemCount = input.batch.items.length - batch.items.length;
    const prefilter = await this.prefilterCandidateBatch({
      connection: input.connection,
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      actions: input.actions,
      inputConfig: input.inputConfig,
      batch,
      summaryGoal: input.summaryGoal,
    });
    const promptBatch = prefilter.promptBatch;
    const itemIds = batch.items.map((item) => item.id);
    const evidenceIds = batch.evidence.map((row) => row.id);
    const promptItemIds = promptBatch.items.map((item) => item.id);
    const postRun = await repo.createRun({
      spaceId: input.connection.space_id,
      ruleId: input.rule?.id ?? null,
      sourceChannelId: input.sourceChannelId,
      agentId: input.agentId,
      projectId: input.projectId,
      triggeredByUserId: input.actorUserId,
      triggerType: input.triggerType,
      inputItemIds: itemIds,
      inputEvidenceIds: evidenceIds,
      cursorBefore: batch.cursorBefore,
      cursorAfter: batch.cursorAfter,
    });
    let retrievalContext: SourcePostProcessingRetrievalContextSnapshot = disabledRetrievalContext(
      input.inputConfig.retrieval_context.domains,
    );
    let agentOutputPreview: string | null = null;
    let evidenceCardPromptHash: string | null = null;
    try {
      await assertSourcePromptEgressAllowed(this.db, input.connection, input.agentId);
      const evidenceCardPrompt = input.projectId && input.inputConfig.processing_phase === "deep_analysis"
        ? await resolveProjectResearchEvidenceCardPrompt(this.db, {
            spaceId: input.connection.space_id,
            userId: input.actorUserId,
            projectId: input.projectId,
            agentId: input.agentId,
          })
        : null;
      evidenceCardPromptHash = evidenceCardPrompt?.resolveResult.rendered_hash ?? null;
      retrievalContext = await this.buildRetrievalContext({
        connection: input.connection,
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        inputConfig: input.inputConfig,
        batch,
        summaryGoal: input.summaryGoal,
      });
      const extractedTextSnippets = input.inputConfig.content_source === "excerpt_only"
        ? new Map<string, string>()
        : await repo.loadExtractedTextSnippets(input.connection.space_id, promptItemIds, 2400);
      if (
        input.inputConfig.content_source === "require_extracted_text_for_candidates" &&
        promptItemIds.some((id) => !extractedTextSnippets.has(id))
      ) {
        throw new HttpError(409, "This post-processing rule requires extracted text, but no input items have extracted text yet.");
      }
      const agentRun = await this.createAndExecuteAgentRun({
        spaceId: input.connection.space_id,
        userId: input.actorUserId,
        agentId: input.agentId,
        projectId: input.projectId,
        prompt: input.summaryGoal ?? input.inputConfig.summary_goal ?? promptForActions(input.actions),
        triggerType: input.triggerType,
        instruction: [renderInstruction({
          connection: input.connection,
          items: promptBatch.items,
          evidence: promptBatch.evidence,
          actions: input.actions,
          inputConfig: input.inputConfig,
          triggerConfig: input.triggerConfig,
          retrievalContext,
          extractedTextSnippets,
          candidatePrefilter: prefilter.metadata,
        }), evidenceCardPrompt?.instruction].filter(Boolean).join("\n\n"),
        runtimeProfileId: input.inputConfig.runtime_profile_id ?? null,
        structuredOutputContract: input.inputConfig.structured_output_schema_id === "source_post_processing.result.v1"
          ? SOURCE_POST_PROCESSING_OUTPUT_CONTRACT
          : null,
        postProcessingRunId: postRun.id,
        executionTimeoutMs: input.executionTimeoutMs,
      });
      if (agentRun.status !== "succeeded" && agentRun.status !== "degraded") {
        const agentOutput = runOutputResult(agentRun.output_json);
        const structuredOutputDiagnostics = recordValue(agentOutput.structured_output_diagnostics);
        return repo.markRunFinished({
          runId: postRun.id,
          spaceId: input.connection.space_id,
          status: "failed",
          agentRunId: agentRun.id,
          retrievalContext: retrievalContext as unknown as Record<string, unknown>,
          summary: "Agent run failed.",
          errorJson: {
            agent_run_id: agentRun.id,
            agent_run_status: agentRun.status,
            agent_run_error_code: errorCodeFromRun(agentRun),
            agent_run_model_provider_id: agentRun.model_provider_id,
            error_message: agentRun.error_message ?? null,
            ...(Object.keys(structuredOutputDiagnostics).length > 0
              ? { structured_output_diagnostics: structuredOutputDiagnostics }
              : {}),
          },
        });
      }
      const output = structuredOutput(agentRun, input.inputConfig.structured_output_schema_id ?? null);
      agentOutputPreview = output.slice(0, 1200);
      if (!output.trim()) {
        return repo.markRunFinished({
          runId: postRun.id,
          spaceId: input.connection.space_id,
          status: "failed",
          agentRunId: agentRun.id,
          retrievalContext: retrievalContext as unknown as Record<string, unknown>,
          summary: "Agent run returned no output.",
          errorJson: { error_code: "empty_agent_output" },
        });
      }
      const result = parsePostProcessingResult(
        output,
        input.actions,
        input.inputConfig,
        promptItemIds,
        retrievalContextRefs(retrievalContext),
      );
      result.item_decisions = mergeSyntheticItemDecisions(result.item_decisions, prefilter.syntheticDecisions);
      const materialized = await this.materializeOutputs({
        sourceChannelId: input.sourceChannelId,
        connection: input.connection,
        rule: input.rule,
        postProcessingRunId: postRun.id,
        agentRun,
        actorUserId: input.actorUserId,
        items: batch.items,
        evidence: batch.evidence,
        actions: input.actions,
        inputConfig: input.inputConfig,
        cursorBefore: batch.cursorBefore,
        cursorAfter: batch.cursorAfter,
        retrievalContext,
        result,
        evidenceCardPromptHash,
      });
      if (input.rule && input.inputConfig.window !== "explicit") {
        await repo.advanceRuleCursor({
          spaceId: input.rule.space_id,
          ruleId: input.rule.id,
          cursor: batch.cursorAfter,
        });
        await repo.recordRuleFire(input.rule.space_id, input.rule.id);
      }
      return repo.markRunFinished({
        runId: postRun.id,
        spaceId: input.connection.space_id,
        status: "succeeded",
        agentRunId: agentRun.id,
        outputArtifactIds: materialized.artifactIds,
        outputProposalIds: materialized.proposalIds,
        outputJobIds: materialized.jobIds,
        retrievalContext: retrievalContext as unknown as Record<string, unknown>,
        itemDecisions: result.item_decisions as unknown as Record<string, unknown>[],
        summary: [
          resultSummary(result),
          trimmedItemCount > 0
            ? `${trimmedItemCount} item(s) did not fit this run's prompt budget and were left for a follow-up batch.`
            : null,
        ].filter(Boolean).join("\n").slice(0, 1000),
      });
    } catch (error) {
      const failed = await repo.markRunFinished({
        runId: postRun.id,
        spaceId: input.connection.space_id,
        status: "failed",
        retrievalContext: retrievalContext as unknown as Record<string, unknown>,
        summary: "Post-processing failed.",
        errorJson: {
          error_message: error instanceof Error ? error.message : String(error),
          retryable: isTransientPostProcessingError(error),
          ...(agentOutputPreview ? { agent_output_preview: agentOutputPreview } : {}),
        },
      });
      if (isTransientPostProcessingError(error)) throw error;
      return failed;
    }
  }

  private async prefilterCandidateBatch(input: {
    connection: SourceConnectionRow;
    projectId: string | null;
    actorUserId: string;
    actions: SourcePostProcessingActions;
    inputConfig: SourcePostProcessingInputConfig;
    batch: SourcePostProcessingInputBatch;
    summaryGoal: string | null;
  }): Promise<CandidatePrefilterResult> {
    const config = input.inputConfig.candidate_prefilter;
    if (!config.enabled || !isRelevanceScreeningEnabled(input.actions, input.inputConfig)) {
      return { promptBatch: input.batch, syntheticDecisions: [], metadata: null };
    }
    if (input.batch.items.length <= config.max_candidates) {
      return {
        promptBatch: input.batch,
        syntheticDecisions: [],
        metadata: {
          enabled: true,
          skipped_reason: "batch_within_candidate_limit",
          max_candidates: config.max_candidates,
          mode: config.mode,
        },
      };
    }

    const pinned: SourcePostProcessingRetrievalContextRef[] = [];
    if (input.projectId) {
      try {
        const project = await this.loadPinnedProjectContext(input.connection.space_id, input.projectId);
        if (project) pinned.push(project);
      } catch {
        // Prefilter falls back through the retrieval query without pinned context.
      }
    }
    const query = buildRetrievalContextQuery(input.connection, input.inputConfig, input.summaryGoal, pinned);
    if (!query) {
      return {
        promptBatch: input.batch,
        syntheticDecisions: [],
        metadata: {
          enabled: true,
          skipped_reason: "empty_query",
          max_candidates: config.max_candidates,
          mode: config.mode,
        },
      };
    }

    try {
      const scored = rankCurrentBatchCandidates(input.batch, query);
      const ranked = scored
        .filter((item) => item.score > 0)
        .filter((item) => config.min_score === undefined || item.score >= config.min_score)
        .slice(0, config.max_candidates);
      if (ranked.length === 0) {
        return {
          promptBatch: input.batch,
          syntheticDecisions: [],
          metadata: {
            enabled: true,
            query,
            mode: config.mode,
            scoring: "batch_local_lexical",
            max_candidates: config.max_candidates,
            fallback_reason: "no_current_batch_matches",
          },
        };
      }

      const scores = new Map(scored.map((item) => [item.object_id, item.score]));
      const candidateIds = new Set(ranked.map((item) => item.object_id));
      const promptItems = input.batch.items.filter((item) => candidateIds.has(item.id));
      if (promptItems.length === input.batch.items.length) {
        return {
          promptBatch: input.batch,
          syntheticDecisions: [],
          metadata: {
            enabled: true,
            query,
            mode: config.mode,
            scoring: "batch_local_lexical",
            max_candidates: config.max_candidates,
            selected_item_count: promptItems.length,
            filtered_item_count: 0,
          },
        };
      }
      const promptIds = new Set(promptItems.map((item) => item.id));
      const promptBatch: SourcePostProcessingInputBatch = {
        items: promptItems,
        evidence: input.batch.evidence.filter((row) => !row.source_item_id || promptIds.has(row.source_item_id)),
        cursorBefore: input.batch.cursorBefore,
        cursorAfter: input.batch.cursorAfter,
      };
      const syntheticDecisions: SourcePostProcessingItemDecision[] = input.batch.items
        .filter((item) => !promptIds.has(item.id))
        .map((item) => ({
          source_item_id: item.id,
          relevance: "maybe",
          confidence: 0.2,
          reason: "Not sent to the LLM in this pass because the candidate prefilter ranked other current-batch items higher. Left as maybe for review instead of automatically ignoring it.",
          matched_context_refs: [{
            stage: "candidate_prefilter",
            outcome: "filtered_out_before_llm",
            query,
            score: scores.get(item.id) ?? null,
          }],
        }));
      return {
        promptBatch,
        syntheticDecisions,
        metadata: {
          enabled: true,
          query,
          mode: config.mode,
          scoring: "batch_local_lexical",
          max_candidates: config.max_candidates,
          min_score: config.min_score ?? null,
          selected_item_count: promptItems.length,
          filtered_item_count: syntheticDecisions.length,
        },
      };
    } catch (error) {
      return {
        promptBatch: input.batch,
        syntheticDecisions: [],
        metadata: {
          enabled: true,
          mode: config.mode,
          max_candidates: config.max_candidates,
          fallback_reason: errorMessage(error),
        },
      };
    }
  }

  /**
   * The model the rule's agent runs on, which decides how much prompt one
   * screening batch may spend. Null when the agent has no pinned model — the
   * caller then falls back to the conservative floor.
   */
  private async agentModelName(spaceId: string, agentId: string): Promise<string | null> {
    const result = await this.db.query<{ model: string | null }>(
      `SELECT COALESCE(version.model_config_json->>'model', version.model_name) AS model
         FROM agents agent
         JOIN agent_versions version
           ON version.id = agent.current_version_id
          AND version.agent_id = agent.id
          AND version.space_id = agent.space_id
        WHERE agent.space_id = $1 AND agent.id = $2
        LIMIT 1`,
      [spaceId, agentId],
    );
    const model = result.rows[0]?.model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  }

  private async createAndExecuteAgentRun(input: {
    spaceId: string;
    userId: string;
    agentId: string;
    projectId: string | null;
    prompt: string;
    triggerType: SourcePostProcessingTriggerType;
    instruction: string;
    runtimeProfileId: string | null;
    structuredOutputContract: typeof SOURCE_POST_PROCESSING_OUTPUT_CONTRACT | null;
    postProcessingRunId: string;
    executionTimeoutMs?: number;
  }): Promise<RunRecord> {
    const pool = this.requirePool();
    await refreshSourcePostProcessingAgentPrompt(pool, input.spaceId, input.agentId);
    const runs = new PgRunRepository(pool);
    const run = await runs.createQueuedRun({
      space_id: input.spaceId,
      user_id: input.userId,
      agent_id: input.agentId,
      project_id: input.projectId,
      project_folder_id: null,
      prompt: input.prompt,
      instruction: input.instruction,
      // Source post-processing is a Sources-owned job, not a user Automation.
      // The rule was configured by the user before this unattended job runs;
      // preserve that authorization in the immutable run contract so the
      // runtime credential gate does not ask for a second approval.
      trigger_origin: input.triggerType === "manual" ? "manual" : "job",
      run_type: "agent",
      mode: "live",
      runtime_profile_id: input.runtimeProfileId,
      contract_snapshot: {
        source: { kind: "direct", id: input.postProcessingRunId },
        project_id: input.projectId,
        ...(input.structuredOutputContract ? { structured_output_json: input.structuredOutputContract } : {}),
        policy_context_json: createManagedExecutionPolicy(
          "source_post_processing",
          input.triggerType !== "manual",
        ),
      },
    });
    await new PgSourcePostProcessingRepository(this.db).updateRunAgentRunId(
      input.spaceId,
      input.postProcessingRunId,
      run.id,
    );
    const repository = new PgRunRepository(pool);
    const orchestration = new RunOrchestrationService(this.config, repository, {
      materializer: RunMaterializationService.fromConfig(this.config),
      workspaceManager: PgRunSandboxManager.fromConfig(this.config),
      codePatchCollector: PgCodePatchCollector.fromConfig(this.config),
      verificationEngine: PgVerificationEngine.fromConfig(this.config),
      processRegistry: sharedCliProcessRegistry,
    });
    await orchestration.executeRun({
      run_id: run.id,
      space_id: input.spaceId,
      ...sourcePostProcessingExecutionRequest(input.postProcessingRunId, input.executionTimeoutMs),
      prompt: sourcePostProcessingRuntimePrompt(input.instruction),
      // The runtime prompt is the rendered batch; the rule's goal is the query.
      retrieval_intent: input.prompt,
    });
    const finished = await repository.getRun(input.spaceId, run.id);
    if (!finished) throw new Error("Agent run disappeared after execution");
    return finished;
  }

  private async enqueueDeepAnalysisFollowUp(input: {
    spaceId: string;
    sourceChannelId: string;
    ruleId: string;
    itemIds: string[];
    sourceRunId: string;
    userId: string | null;
  }): Promise<{ id: string }> {
    if (input.itemIds.length === 0) throw new HttpError(422, "Deep analysis follow-up requires source items");
    const job = await new PgJobQueueRepository(this.db).enqueue({
      job_type: SOURCE_POST_PROCESSING_EVENT_JOB_TYPE,
      payload: {
        phase: "deep_analysis",
        trigger_type: "manual",
        source_channel_id: input.sourceChannelId,
        rule_id: input.ruleId,
        source_item_ids: input.itemIds,
        source_post_processing_run_id: input.sourceRunId,
      },
      space_id: input.spaceId,
      user_id: input.userId,
    });
    return { id: job.id };
  }

  private async buildRetrievalContext(input: {
    connection: SourceConnectionRow;
    projectId: string | null;
    actorUserId: string;
    inputConfig: SourcePostProcessingInputConfig;
    batch: SourcePostProcessingInputBatch;
    summaryGoal: string | null;
  }): Promise<SourcePostProcessingRetrievalContextSnapshot> {
    const config = input.inputConfig.retrieval_context;
    if (!config.enabled) return disabledRetrievalContext(config.domains);
    if (config.domains.includes("project") && !input.projectId) {
      throw new HttpError(422, "Project retrieval context requires a project on this post-processing rule.");
    }

    const currentRefs = new Set<string>([
      ...input.batch.items.map((item) => refKey("source_item", item.id)),
      ...input.batch.evidence.map((row) => refKey("extracted_evidence", row.id)),
    ]);
    const pinned: SourcePostProcessingRetrievalContextRef[] = [];
    const items: SourcePostProcessingRetrievalContextRef[] = [];
    const errors: SourcePostProcessingRetrievalContextSnapshot["errors"] = [];

    if (input.projectId) {
      try {
        const project = await this.loadPinnedProjectContext(input.connection.space_id, input.projectId);
        if (project) pinned.push(project);
      } catch (error) {
        errors.push({ domain: "project", message: errorMessage(error) });
      }
    }

    const query = buildRetrievalContextQuery(input.connection, input.inputConfig, input.summaryGoal, pinned);
    if (!query) {
      return {
        enabled: true,
        query: null,
        domains: config.domains,
        pinned,
        items,
        ...(errors.length ? { errors } : {}),
      };
    }

    const settings = await readSpaceRetrievalSettings(this.db, input.connection.space_id);
    const store = resolveProviderCommandStore(this.config);
    const egressPolicy = { externalEgressEnabled: settings.externalEgressEnabled };

    for (const domain of config.domains) {
      const domainConfig = retrievalContextDomainConfig(domain);
      try {
        const search = new RetrievalSearchService(this.db, domainConfig.registry, {
          egressPolicy,
          queryEmbedder: new ProviderQueryEmbedder(
            store,
            null,
            undefined,
            settings.embeddingDimensions,
            egressPolicy,
          ),
          reranker: settings.rerankEnabled && config.mode === "hybrid_rerank"
            ? new ProviderReranker(store, {
                databaseUrl: this.config.databaseUrl,
                surface: domainConfig.surface,
                egressPolicy,
              })
            : undefined,
        });
        const response = await search.search({
          spaceId: input.connection.space_id,
          viewerUserId: input.actorUserId,
          objectTypes: domainConfig.objectTypes,
          query,
          maxResults: Math.min(50, config.max_results_per_domain + currentRefs.size),
          includeTrace: false,
          mode: config.mode,
          useCache: settings.useQueryCache,
          adaptiveReturn: false,
          rankingConfig: settings.rankingConfig,
        });
        const domainItems = response.items
          .filter((item) => !currentRefs.has(refKey(item.object_type, item.object_id)))
          .slice(0, config.max_results_per_domain)
          .map((item) => retrievalContextRef(domain, item));
        items.push(...domainItems);
      } catch (error) {
        errors.push({ domain, message: errorMessage(error) });
      }
    }

    return {
      enabled: true,
      query,
      domains: config.domains,
      pinned,
      items,
      ...(errors.length ? { errors } : {}),
    };
  }

  private async loadPinnedProjectContext(
    spaceId: string,
    projectId: string,
  ): Promise<SourcePostProcessingRetrievalContextRef | null> {
    const result = await this.db.query<{
      id: string;
      name: string;
      description: string | null;
      current_focus: string | null;
      summary_text: string | null;
      topics_json: unknown;
      highlights_json: unknown;
    }>(
      `SELECT p.id,
              p.name,
              p.description,
              p.current_focus,
              ps.summary_text,
              ps.topics_json,
              ps.highlights_json
         FROM projects p
         LEFT JOIN project_public_summaries ps
           ON ps.space_id = p.space_id
          AND ps.project_id = p.id
          AND ps.review_status = 'approved'
        WHERE p.space_id = $1
          AND p.id = $2
          AND p.status <> 'deleted'
        LIMIT 1`,
      [spaceId, projectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const snippet = joinText([
      row.description,
      row.current_focus,
      row.summary_text,
      stringList(row.topics_json).join(", "),
      stringList(row.highlights_json).join("\n"),
    ]).slice(0, 2000);
    return {
      ref: contextRefKey("project", "project_public_summary", row.id),
      domain: "project",
      object_type: "project_public_summary",
      object_id: row.id,
      title: row.name,
      snippet: snippet || null,
    };
  }

  private async materializeOutputs(input: {
    sourceChannelId: string;
    connection: SourceConnectionRow;
    rule: SourcePostProcessingRuleRow | null;
    postProcessingRunId: string;
    agentRun: RunRecord;
    actorUserId: string;
    items: SourceItemRow[];
    evidence: EvidenceRow[];
    actions: SourcePostProcessingActions;
    inputConfig: SourcePostProcessingInputConfig;
    cursorBefore: SourcePostProcessingInputBatch["cursorBefore"];
    cursorAfter: SourcePostProcessingInputBatch["cursorAfter"];
    retrievalContext: SourcePostProcessingRetrievalContextSnapshot;
    result: ParsedPostProcessingResult;
    evidenceCardPromptHash: string | null;
  }): Promise<{ artifactIds: string[]; proposalIds: string[]; jobIds: string[] }> {
    const repo = new PgSourcePostProcessingRepository(this.db);
    const artifactIds: string[] = [];
    const proposalIds: string[] = [];
    const jobIds: string[] = [];
    const itemById = new Map(input.items.map((item) => [item.id, item]));
    const projectId = input.rule?.project_id ?? input.agentRun.project_id ?? null;
    const metadata = {
      generated_by: "source_post_processing",
      processing_phase: input.inputConfig.processing_phase ?? "standard",
      source_post_processing_parent_run_id: input.inputConfig.source_post_processing_parent_run_id ?? null,
      processing_strategy: input.inputConfig.processing_strategy,
      content_source: input.inputConfig.content_source,
      source_channel_id: input.sourceChannelId,
      source_post_processing_rule_id: input.rule?.id ?? null,
      source_post_processing_run_id: input.postProcessingRunId,
      agent_id: input.agentRun.agent_id,
      agent_run_id: input.agentRun.id,
      project_id: projectId,
      input_item_ids: input.items.map((item) => item.id),
      input_evidence_ids: input.evidence.map((row) => row.id),
      input_window: {
        type: input.inputConfig.window,
        cursor_before: input.cursorBefore,
        cursor_after: input.cursorAfter,
      },
      retrieval_context_refs: retrievalContextRefs(input.retrievalContext),
      ...(isRelevanceScreeningEnabled(input.actions, input.inputConfig)
        ? { relevance_profile: relevanceProfileSummary(input.inputConfig.relevance_profile) }
        : {}),
    };
    if (input.actions.batch_digest) {
      const artifactId = await repo.insertArtifact({
        spaceId: input.connection.space_id,
        runId: input.agentRun.id,
        ownerUserId: input.actorUserId,
        projectId,
        artifactType: "summary",
        title: input.inputConfig.processing_phase === "deep_analysis"
          ? `${input.connection.name} deep analysis`
          : `${input.connection.name} digest`,
        content: input.result.digest_markdown,
        metadata: { ...metadata, action: "batch_digest" },
      });
      artifactIds.push(artifactId);
    }
    if (input.actions.per_item_summary) {
      for (const summary of input.result.item_summaries) {
        const item = itemById.get(summary.source_item_id);
        if (!item) continue;
        const artifactId = await repo.insertArtifact({
          spaceId: input.connection.space_id,
          runId: input.agentRun.id,
          ownerUserId: input.actorUserId,
          projectId,
          artifactType: "summary",
          title: `Summary: ${item.title}`,
          content: summary.summary_markdown,
          metadata: { ...metadata, action: "per_item_summary", source_item_id: item.id },
        });
        await repo.updateItemSummary(input.connection.space_id, item.id, artifactId);
        artifactIds.push(artifactId);
      }
      if (projectId && input.inputConfig.processing_phase === "deep_analysis" && input.result.item_summaries.length) {
        await new ProjectResearchAreaService(this.db).materializeEvidenceCardsFromDeepAnalysis({
          spaceId: input.connection.space_id,
          projectId,
          runId: input.agentRun.id,
          promptHash: input.evidenceCardPromptHash,
          summaries: input.result.item_summaries,
        });
      }
    }
    if (input.actions.extract_evidence) {
      for (const candidate of input.result.evidence_candidates) {
        const item = itemById.get(candidate.source_item_id);
        if (!item) continue;
        const evidenceId = await repo.insertEvidence({
          spaceId: input.connection.space_id,
          item,
          artifactId: artifactIds[0] ?? null,
          title: candidate.title,
          content: candidate.content_excerpt,
          createdByUserId: input.actorUserId,
          createdByAgentId: input.agentRun.agent_id,
          createdByRunId: input.agentRun.id,
          metadata: {
            ...metadata,
            action: "extract_evidence",
            source_item_id: item.id,
            confidence: candidate.confidence,
            matched_context_refs: candidate.matched_context_refs,
          },
        });
        if (projectId) {
          await repo.linkEvidenceToProject({
            spaceId: input.connection.space_id,
            evidenceId,
            projectId,
            createdByUserId: input.actorUserId,
            createdByAgentId: input.agentRun.agent_id,
            createdByRunId: input.agentRun.id,
            reason: `source_post_processing:${input.postProcessingRunId}`,
          });
        }
      }
    }
    if (input.inputConfig.deep_analysis.enabled && input.rule) {
      const deepConfig = input.inputConfig.deep_analysis;
      const candidateItemIds = input.result.item_decisions
        .filter((decision) => deepConfig.trigger_relevance.includes(decision.relevance as "relevant" | "maybe"))
        .filter((decision) => decision.confidence === null || decision.confidence >= deepConfig.min_confidence)
        .map((decision) => decision.source_item_id)
        .filter((id) => itemById.has(id))
        .slice(0, deepConfig.max_candidates_per_run);
      const uniqueCandidateItemIds = [...new Set(candidateItemIds)];
      try {
        const alreadyExtracted = await repo.loadExtractedTextSnippets(input.connection.space_id, uniqueCandidateItemIds, 1);
        const readyItemIds = uniqueCandidateItemIds.filter((id) => alreadyExtracted.has(id));
        if (readyItemIds.length > 0) {
          const followUp = await this.enqueueDeepAnalysisFollowUp({
            spaceId: input.connection.space_id,
            sourceChannelId: input.sourceChannelId,
            ruleId: input.rule.id,
            itemIds: readyItemIds,
            sourceRunId: input.postProcessingRunId,
            userId: input.actorUserId,
          });
          jobIds.push(followUp.id);
        }
        jobIds.push(...await repo.queueFullTextExtractionForItems({
          spaceId: input.connection.space_id,
          connection: input.connection,
          itemIds: uniqueCandidateItemIds.filter((id) => !alreadyExtracted.has(id)),
          metadata: {
            source: "source_post_processing",
            source_post_processing_followups: [{
              phase: "deep_analysis",
              source_post_processing_run_id: input.postProcessingRunId,
              source_post_processing_rule_id: input.rule.id,
              triggered_by_user_id: input.actorUserId,
              content_source: deepConfig.content_source,
            }],
          },
        }));
      } catch (error) {
        if (input.inputConfig.deep_analysis.content_source === "require_extracted_text") throw error;
      }
    }
    if (input.actions.create_proposals) {
      const proposalMarkdown = input.result.proposal_markdown ?? input.result.digest_markdown;
      const proposalId = await repo.insertProposal({
        spaceId: input.connection.space_id,
        runId: input.agentRun.id,
        agentId: input.agentRun.agent_id,
        userId: input.actorUserId,
        projectId,
        title: `${input.connection.name} post-processing proposal`,
        summary: proposalMarkdown,
        payload: {
          operation: "create",
          proposed_content: proposalMarkdown,
          source_artifact_ids: artifactIds,
          source_refs: input.items.map((item) => ({ type: "source_item", id: item.id })),
          metadata,
        },
      });
      proposalIds.push(proposalId);
    }
    await repo.persistItemDecisions({
      spaceId: input.connection.space_id,
      sourceChannelId: input.sourceChannelId,
      ruleId: input.rule?.id ?? null,
      runId: input.postProcessingRunId,
      projectId,
      decisions: input.result.item_decisions,
    });
    return { artifactIds, proposalIds, jobIds };
  }

  private async resolveAgentId(identity: SpaceUserIdentity, requestedAgentId: string | null): Promise<string> {
    if (requestedAgentId) {
      await this.assertAgentUsable(identity.spaceId, requestedAgentId);
      return requestedAgentId;
    }
    const pool = this.requirePool();
    const agent = await ensureSourcePostProcessingAgent(pool, identity.spaceId);
    return agent.id;
  }

  private async assertAgentUsable(spaceId: string, agentId: string): Promise<void> {
    const row = await this.db.query<{ id: string }>(
      `SELECT id FROM agents WHERE space_id = $1 AND id = $2 AND status = 'active' LIMIT 1`,
      [spaceId, agentId],
    );
    if (!row.rows[0]) throw new HttpError(404, "Agent not found or inactive");
  }

  private async assertProjectInSpace(spaceId: string, projectId: string): Promise<void> {
    const row = await this.db.query<{ id: string }>(
      `SELECT id FROM projects WHERE space_id = $1 AND id = $2 AND status <> 'deleted' LIMIT 1`,
      [spaceId, projectId],
    );
    if (!row.rows[0]) throw new HttpError(404, "Project not found");
  }

  private async requireConnection(spaceId: string, connectionId: string): Promise<SourceConnectionRow> {
    const connection = await new PgSourcePostProcessingRepository(this.db).getConnection(spaceId, connectionId);
    if (!connection) throw new HttpError(404, "Source connection not found");
    return connection;
  }

  private async loadDecisionItem(spaceId: string, itemId: string): Promise<SourceItemRow | null> {
    const result = await this.db.query<SourceItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM source_items
        WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [spaceId, itemId],
    );
    return result.rows[0] ?? null;
  }

  private async enforceSourceTargets(
    connection: SourceConnectionRow,
    actions: SourcePostProcessingActions,
  ): Promise<void> {
    const governance = normalizeSourceConnectionReadGovernance(connection);
    if (actions.batch_digest || actions.per_item_summary || actions.extract_evidence) {
      enforceSourceDerivedImportTarget(governance.policy, "source_artifact");
    }
    if (actions.create_proposals) {
      enforceSourceDerivedImportTarget(governance.policy, "knowledge");
    }
  }


  private validateInputContextBinding(
    projectId: string | null,
    inputConfig: SourcePostProcessingInputConfig,
    actions: SourcePostProcessingActions,
  ): void {
    validateSourcePostProcessingInputContextBinding(projectId, inputConfig, actions);
  }

  private assertActions(actions: SourcePostProcessingActions): void {
    if (
      !actions.batch_digest &&
      !actions.per_item_summary &&
      !actions.extract_evidence &&
      !actions.create_proposals &&
      !actions.mark_items
    ) {
      throw new HttpError(422, "At least one post-processing action is required");
    }
  }

  private async resolveOneOffSourceConnection(
    spaceId: string,
    itemIds: string[],
    evidenceIds: string[],
    viewerUserId: string,
  ): Promise<string> {
    const itemRows = itemIds.length
      ? await this.db.query<{ connection_id: string | null }>(
          `SELECT connection_id FROM source_items
            WHERE space_id = $1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL
              AND ${contentReadSql("source_item", "source_items", "$3")}`,
          [spaceId, itemIds, viewerUserId],
        )
      : { rows: [] };
    const evidenceRows = evidenceIds.length
      ? await this.db.query<{ connection_id: string | null }>(
          `SELECT ii.connection_id
             FROM extracted_evidence ee
             LEFT JOIN source_items ii
               ON ii.space_id = ee.space_id
              AND ii.id = ee.source_item_id
            WHERE ee.space_id = $1
              AND ee.id::text = ANY($2::text[])
              AND ee.deleted_at IS NULL
              AND ${contentReadSql("extracted_evidence", "ee", "$3")}
              AND (ii.id IS NULL OR ${contentReadSql("source_item", "ii", "$3")})`,
          [spaceId, evidenceIds, viewerUserId],
        )
      : { rows: [] };
    const ids = [...itemRows.rows, ...evidenceRows.rows]
      .map((row) => row.connection_id)
      .filter((id): id is string => Boolean(id));
    const unique = [...new Set(ids)];
    if (unique.length !== 1) {
      throw new HttpError(422, "One-off source post-processing requires inputs from exactly one source");
    }
    return unique[0]!;
  }

  private requirePool(): Pool {
    if (!this.config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return getDbPool(this.config.databaseUrl);
  }
}

export function validateSourcePostProcessingInputContextBinding(
  projectId: string | null,
  inputConfig: SourcePostProcessingInputConfig,
  actions: SourcePostProcessingActions,
): void {
  if (inputConfig.retrieval_context.enabled && inputConfig.retrieval_context.domains.includes("project") && !projectId) {
    throw new HttpError(422, "Project context requires selecting a project for this post-processing rule.");
  }
  if (!projectId && isRelevanceScreeningEnabled(actions, inputConfig) && inputConfig.relevance_profile?.enabled !== true) {
    throw new HttpError(
      422,
      "Relevance screening without a project requires a source-level relevance profile.",
    );
  }
}

export function sourcePostProcessingExecutionRequest(postProcessingRunId: string, timeoutMs?: number): {
  worker_id: string;
  job_id: null;
  command_source: "internal";
  timeout_ms?: number;
} {
  return {
    worker_id: `source_post_processing:${postProcessingRunId}`,
    job_id: null,
    command_source: "internal",
    ...(timeoutMs && timeoutMs > 0 ? { timeout_ms: timeoutMs } : {}),
  };
}

export function sourcePostProcessingRuntimePrompt(instruction: string): string {
  return instruction;
}

async function ensureSourcePostProcessingAgent(pool: Pool, spaceId: string): Promise<{ id: string }> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id
       FROM agents
      WHERE space_id = $1
        AND agent_kind = 'system_source_post_processor'
        AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1`,
    [spaceId],
  );
  if (existing.rows[0]) {
    await refreshSourcePostProcessingAgentPrompt(pool, spaceId, existing.rows[0].id);
    return existing.rows[0];
  }
  const provider = await defaultModelProviderForSpace(pool, spaceId);
  if (!provider) {
    throw new HttpError(
      409,
      "Configure a default model provider before creating source post-processing rules without an agent.",
    );
  }
  const agents = new PgAgentRepository(pool);
  const created = await agents.create({
    spaceId,
    userId: await firstSpaceUserId(pool, spaceId),
    name: "Source post-processing",
    description: "System-managed reusable agent for source summaries and post-processing.",
    visibility: "space_shared",
    systemPrompt: sourcePostProcessingAgentSystemPrompt(),
    adapterType: "model_api",
    defaultModelProviderId: provider.id,
    defaultModel: provider.default_model,
  });
  await pool.query(
    `UPDATE agents
        SET owner_user_id = NULL,
            agent_kind = 'system_source_post_processor',
            updated_at = $3
      WHERE space_id = $1 AND id = $2`,
    [spaceId, created.id, new Date().toISOString()],
  );
  return { id: created.id };
}

export async function refreshSourcePostProcessingAgentPrompt(
  pool: Pool,
  spaceId: string,
  agentId: string,
): Promise<void> {
  const managed = await pool.query<{ agent_kind: string }>(
    `SELECT agent_kind
       FROM agents
      WHERE space_id = $1 AND id = $2 AND status = 'active'
      LIMIT 1`,
    [spaceId, agentId],
  );
  if (managed.rows[0]?.agent_kind !== "system_source_post_processor") return;
  await new PgAgentRepository(pool).publishSystemManagedPrompt({
    spaceId,
    agentId,
    agentKind: "system_source_post_processor",
    systemPrompt: sourcePostProcessingAgentSystemPrompt(),
  });
}

function sourcePostProcessingAgentSystemPrompt(): string {
  return [
    "You are the system-managed Source post-processing agent.",
    "You analyze newly captured source material and return structured results for server-side materialization.",
    "Your final response must be exactly one valid JSON object matching schema source_post_processing.result.v1.",
    "Do not output prose, Markdown fences, or explanations outside the JSON object.",
    "Markdown content is allowed only inside JSON string fields such as digest_markdown, summary_markdown, content_excerpt, and proposal_markdown.",
    "Do not claim to have read content that is not present in the provided source items, evidence, retrieval context, or extracted text snippets.",
  ].join("\n");
}

export async function defaultModelProviderForSpace(
  db: Queryable,
  spaceId: string,
): Promise<{ id: string; default_model: string | null } | null> {
  const result = await db.query<{ id: string; default_model: string | null }>(
    `SELECT p.id, p.default_model
       FROM model_provider_space_grants g
       JOIN model_providers p ON p.id = g.provider_id
      WHERE g.space_id = $1
        AND g.enabled = true
        AND g.is_default = true
        AND p.enabled = true
      ORDER BY g.updated_at DESC, p.created_at DESC
      LIMIT 1`,
    [spaceId],
  );
  return result.rows[0] ?? null;
}

async function firstSpaceUserId(pool: Pool, spaceId: string): Promise<string> {
  const membership = await pool.query<{ user_id: string }>(
    `SELECT user_id
       FROM space_memberships
      WHERE space_id = $1 AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1`,
    [spaceId],
  );
  const userId = membership.rows[0]?.user_id;
  if (userId) return userId;
  const user = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`,
  );
  const fallback = user.rows[0]?.id;
  if (!fallback) throw new HttpError(409, "Cannot create default source post-processing agent without an active user");
  return fallback;
}

function promptForActions(actions: SourcePostProcessingActions): string {
  if (actions.per_item_summary && !actions.batch_digest) return "Summarize each source item.";
  if (actions.extract_evidence) return "Summarize this source material and highlight citable evidence.";
  return "Create a concise digest for these source items.";
}

function defaultRuleName(triggerType: SourcePostProcessingTriggerType, actions: SourcePostProcessingActions): string {
  const action = actions.per_item_summary
    ? "Item summaries"
    : actions.extract_evidence
      ? "Evidence extraction"
      : "Source digest";
  return `${action} (${triggerType})`;
}

function relevanceProfileSummary(profile: SourcePostProcessingRelevanceProfile | undefined): Record<string, unknown> {
  return {
    objective: profile?.objective ?? null,
    include_criteria_count: profile?.include_criteria.length ?? 0,
    exclude_criteria_count: profile?.exclude_criteria.length ?? 0,
  };
}

function mergeSyntheticItemDecisions(
  parsed: SourcePostProcessingItemDecision[],
  synthetic: SourcePostProcessingItemDecision[],
): SourcePostProcessingItemDecision[] {
  if (!synthetic.length) return parsed;
  const seen = new Set(parsed.map((decision) => decision.source_item_id));
  return [
    ...parsed,
    ...synthetic.filter((decision) => !seen.has(decision.source_item_id)),
  ];
}

function rankCurrentBatchCandidates(
  batch: SourcePostProcessingInputBatch,
  query: string,
): Array<{ object_id: string; score: number }> {
  const terms = tokenizeForCandidateRank(query);
  if (terms.length === 0) return [];
  const evidenceByItem = new Map<string, string[]>();
  for (const row of batch.evidence) {
    if (!row.source_item_id) continue;
    const current = evidenceByItem.get(row.source_item_id) ?? [];
    current.push(joinText([row.title, row.content_excerpt, boundedJsonChars(row.metadata_json, 600)]));
    evidenceByItem.set(row.source_item_id, current);
  }
  const rawScores = batch.items.map((item, index) => {
    const metadata = boundedJsonChars(item.metadata_json, 1_200);
    const score =
      scoreText(item.title, terms) * 5 +
      scoreText(item.excerpt, terms) * 3 +
      scoreText(joinText([item.author, item.source_domain, item.source_uri, metadata]), terms) +
      scoreText((evidenceByItem.get(item.id) ?? []).join("\n"), terms) * 2;
    return { object_id: item.id, rawScore: score, index };
  });
  const maxScore = Math.max(0, ...rawScores.map((item) => item.rawScore));
  if (maxScore <= 0) return rawScores.map((item) => ({ object_id: item.object_id, score: 0 }));
  return rawScores
    .map((item) => ({ object_id: item.object_id, score: item.rawScore / maxScore, index: item.index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ object_id, score }) => ({ object_id, score }));
}

function tokenizeForCandidateRank(value: string): string[] {
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "into",
    "about",
    "paper",
    "papers",
    "research",
    "source",
    "digest",
    "summary",
    "find",
    "relevant",
  ]);
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !stopwords.has(item));
  return [...new Set(tokens)].slice(0, 80);
}

function scoreText(value: string | null | undefined, terms: string[]): number {
  if (!value) return 0;
  const text = value.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!text.includes(term)) continue;
    score += term.length > 5 ? 2 : 1;
    const occurrences = text.split(term).length - 1;
    if (occurrences > 1) score += Math.min(3, occurrences - 1) * 0.5;
  }
  return score;
}

function deepAnalysisInputConfig(
  inputConfig: SourcePostProcessingInputConfig,
  sourceRunId: string | null,
): SourcePostProcessingInputConfig {
  const contentSource = inputConfig.deep_analysis.content_source === "require_extracted_text"
    ? "require_extracted_text_for_candidates"
    : "prefer_extracted_text_for_candidates";
  const sourceLine = sourceRunId ? `Follow-up to screening run ${sourceRunId}.` : "Follow-up to a screening run.";
  return {
    ...inputConfig,
    window: "explicit",
    item_limit: inputConfig.deep_analysis.max_candidates_per_run,
    processing_strategy: "screen_extract_digest",
    content_source: contentSource,
    processing_phase: "deep_analysis",
    source_post_processing_parent_run_id: sourceRunId,
    include_evidence: true,
    candidate_prefilter: {
      ...inputConfig.candidate_prefilter,
      enabled: false,
    },
    deep_analysis: {
      ...inputConfig.deep_analysis,
      enabled: false,
    },
    summary_goal: joinText([
      inputConfig.summary_goal,
      "Perform a deep follow-up analysis for the selected candidate items using extracted full-text snippets when available.",
    ]),
    output_instructions: joinText([
      inputConfig.output_instructions,
      sourceLine,
      "This is the second-stage deep analysis pass. Focus on what the full text changes relative to the abstract-level screening: concrete contributions, methods, limitations, evidence, and recommended next actions.",
    ]),
  };
}

function effectiveInputConfig(rule: SourcePostProcessingRuleRow): SourcePostProcessingInputConfig {
  const inputConfig = normalizeInputConfig(rule.input_config_json);
  if (inputConfig.structured_output_schema_id !== "source_post_processing.result.v1") {
    return inputConfig;
  }
  return {
    ...inputConfig,
    item_limit: Math.min(
      inputConfig.item_limit,
      SOURCE_POST_PROCESSING_LIMITS.researchStructuredOutputBatchSize,
    ),
  };
}

/**
 * How much prompt one screening run may spend, in characters.
 *
 * This used to be a flat 48k — a figure from when every model was assumed to
 * have a ~16k context window. On a model with a half-million-token window it
 * trimmed a sixteen-item intake to four items per run, and because the trim is
 * silent the leftovers came back as fresh recovery batches: one research pass
 * turned into five screening runs and the reviewer was asked to approve the
 * same intake more than once. The window is the real constraint, so read it
 * from the model registry.
 */
export function promptBudgetCharsFor(model: string | null): number {
  if (!model) return SOURCE_POST_PROCESSING_PROMPT_BUDGET_FLOOR_CHARS;
  const spec = resolveModelWindow(model);
  const availableTokens = spec.contextWindowTokens
    - spec.defaultOutputReserveTokens
    - spec.providerOverheadTokens;
  return Math.max(
    SOURCE_POST_PROCESSING_PROMPT_BUDGET_FLOOR_CHARS,
    Math.floor(availableTokens / SOURCE_POST_PROCESSING_PROMPT_BYTES_PER_CHAR),
  );
}

function fitBatchToPromptBudget(
  batch: SourcePostProcessingInputBatch,
  inputConfig: SourcePostProcessingInputConfig,
  budgetChars: number,
): SourcePostProcessingInputBatch {
  if (batch.items.length <= 1) return batch;
  const available = Math.max(
    6_000,
    budgetChars -
      SOURCE_POST_PROCESSING_PROMPT_FIXED_RESERVE_CHARS -
      estimateInputConfigPromptChars(inputConfig),
  );
  const evidenceByItem = new Map<string, EvidenceRow[]>();
  for (const row of batch.evidence) {
    if (!row.source_item_id) continue;
    const current = evidenceByItem.get(row.source_item_id) ?? [];
    current.push(row);
    evidenceByItem.set(row.source_item_id, current);
  }
  const kept: SourceItemRow[] = [];
  let used = 0;
  for (const item of batch.items) {
    const cost = estimateItemPromptChars(item, inputConfig) +
      (evidenceByItem.get(item.id) ?? []).reduce((sum, row) => sum + estimateEvidencePromptChars(row), 0);
    if (kept.length > 0 && used + cost > available) break;
    kept.push(item);
    used += cost;
  }
  if (kept.length === batch.items.length) return batch;
  const keptIds = new Set(kept.map((item) => item.id));
  const last = kept[kept.length - 1]!;
  return {
    items: kept,
    evidence: batch.evidence.filter((row) => row.source_item_id ? keptIds.has(row.source_item_id) : true),
    cursorBefore: batch.cursorBefore,
    cursorAfter: {
      id: last.id,
      created_at: timestampString(last.created_at) ?? new Date().toISOString(),
    },
  };
}

function estimateInputConfigPromptChars(inputConfig: SourcePostProcessingInputConfig): number {
  const profile = inputConfig.relevance_profile;
  const profileChars = profile
    ? textChars(
      profile.objective,
      ...profile.include_criteria,
      ...profile.exclude_criteria,
      ...profile.must_have,
      ...profile.nice_to_have,
      profile.decision_policy?.relevant,
      profile.decision_policy?.maybe,
      profile.decision_policy?.not_relevant,
    )
    : 0;
  const retrievalReserve = inputConfig.retrieval_context.enabled
    ? inputConfig.retrieval_context.domains.length * inputConfig.retrieval_context.max_results_per_domain * 1_000
    : 0;
  return textChars(inputConfig.summary_goal, inputConfig.output_instructions, inputConfig.retrieval_context.query) +
    profileChars +
    retrievalReserve;
}

function estimateItemPromptChars(item: SourceItemRow, inputConfig: SourcePostProcessingInputConfig): number {
  const metadata = boundedJsonChars(item.metadata_json, 1_200);
  const extractedTextReserve = inputConfig.content_source === "excerpt_only"
    ? 0
    : SOURCE_POST_PROCESSING_EXTRACTED_TEXT_SNIPPET_RESERVE_CHARS;
  return textChars(
    item.title,
    item.author,
    item.source_uri,
    item.source_domain,
    item.source_external_id,
    item.excerpt,
    metadata,
  ) + extractedTextReserve + 400;
}

function estimateEvidencePromptChars(row: EvidenceRow): number {
  return textChars(row.title, row.content_excerpt, boundedJsonChars(row.metadata_json, 600)) + 240;
}

function textChars(...values: Array<string | null | undefined>): number {
  return values.reduce((sum, value) => sum + (value?.length ?? 0), 0);
}

function boundedJsonChars(value: unknown, maxChars: number): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return "";
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorCodeFromRun(run: RunRecord): string | null {
  const errorJson = recordValue(run.error_json);
  return stringValue(errorJson.error_code);
}

function structuredOutput(run: RunRecord, expectedSchemaId: string | null): string {
  // canonicalRunOutput() nests the model/tool result under `.result`
  // (schema_version: "run_output.v1" at the envelope's top level); read
  // through that wrapper instead of treating the envelope itself as the
  // result, or every schema/output_text lookup below sees undefined.
  const output = runOutputResult(run.output_json);
  if (expectedSchemaId) {
    if (output.schema !== expectedSchemaId) {
      throw new HttpError(422, `Structured output schema must be ${expectedSchemaId}`);
    }
    return JSON.stringify(output);
  }
  const value = output.output_text;
  return typeof value === "string" ? value : "";
}

function disabledRetrievalContext(
  domains: SourcePostProcessingRetrievalDomain[],
): SourcePostProcessingRetrievalContextSnapshot {
  return {
    enabled: false,
    query: null,
    domains,
    pinned: [],
    items: [],
  };
}

function retrievalContextDomainConfig(domain: SourcePostProcessingRetrievalDomain): RetrievalContextDomainConfig {
  if (domain === "memory") {
    return {
      registry: memoryRetrievalRegistry,
      objectTypes: ["memory_entry"],
      surface: "source_post_processing_retrieval_context_memory",
    };
  }
  if (domain === "project") {
    return {
      registry: projectRetrievalRegistry,
      objectTypes: ["project_public_summary"],
      surface: "source_post_processing_retrieval_context_project",
    };
  }
  if (domain === "source") {
    return {
      registry: sourceRetrievalRegistry,
      objectTypes: ["source_item", "extracted_evidence"],
      surface: "source_post_processing_retrieval_context_source",
    };
  }
  return {
    registry: knowledgeRetrievalRegistry,
    surface: "source_post_processing_retrieval_context_knowledge",
  };
}

function retrievalContextRef(
  domain: SourcePostProcessingRetrievalDomain,
  item: RetrievalSearchResult,
): SourcePostProcessingRetrievalContextRef {
  return {
    ref: contextRefKey(domain, item.object_type, item.object_id),
    domain,
    object_type: item.object_type,
    object_id: item.object_id,
    title: item.title,
    snippet: item.snippet,
    score: item.score,
    source_refs: item.source_refs,
  };
}

function retrievalContextRefs(context: SourcePostProcessingRetrievalContextSnapshot): string[] {
  return [...context.pinned, ...context.items].map((item) => item.ref);
}

function refKey(objectType: RetrievalObjectType, objectId: string): string {
  return `${objectType}:${objectId}`;
}

function contextRefKey(
  domain: SourcePostProcessingRetrievalDomain,
  objectType: RetrievalObjectType,
  objectId: string,
): string {
  return `${domain}:${objectType}:${objectId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientPostProcessingError(error: unknown): boolean {
  if (error instanceof HttpError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
    return false;
  }
  const message = errorMessage(error).toLowerCase();
  return [
    "timeout",
    "timed out",
    "rate limit",
    "too many requests",
    "econnreset",
    "econnrefused",
    "etimedout",
    "temporary",
    "temporarily",
    "503",
    "502",
    "504",
  ].some((pattern) => message.includes(pattern));
}

function inCooldown(lastFiredAt: unknown, cooldownSeconds: number): boolean {
  if (cooldownSeconds <= 0 || !lastFiredAt) return false;
  const ts = Date.parse(String(lastFiredAt));
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < cooldownSeconds * 1000;
}
