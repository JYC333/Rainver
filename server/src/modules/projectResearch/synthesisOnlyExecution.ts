import { randomUUID } from "node:crypto";
import { HttpError, objectValue, optionalString, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { lockActiveProjectForMutation } from "../projects/access";
import { ProjectOperationRepository } from "../projects/projectOperationRepository";
import { PgAutomationRepository, type AutomationRow } from "../automations/repository";
import { WorkflowExecutionService } from "../automations/workflowExecutionService";
import { actionNodeHandlerRegistry, ActionNodeHandlerError, type ActionNodeContext, type ActionNodeResult } from "../automations/actionNodeRegistry";
import { workflowExecutionOutcomeHandlerRegistry } from "../automations/workflowExecutionOutcomeRegistry";
import { ProjectResearchArtifactService } from "./artifactService";
import { resolveProjectResearchSynthesisPrompt, PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY } from "./promptRegistry";
import { RESEARCH_SYNTHESIS_OUTPUT_CONTRACT } from "./outputSchemas";
import { validateResearchArtifacts, type ResearchArtifactRecord } from "./artifactValidation";
import { ProjectResearchReportMaterializer } from "./reportMaterializer";
import { deriveStepStates, operationSteps, type ResearchOperationState } from "./operationProjection";
import { setResearchOperationState } from "./pipeline/operationProjectionWriter";
import { researchQueryText } from "./pipeline/synthesisCoordinator";
import { upsertPendingResearchCheckpoint } from "./checkpointWriter";

const RESEARCH_AUTOMATION_PURPOSE = "academic_research_workflow_execution";
const MATERIALIZE_REPORT_ACTION_KEY = "project_research.materialize_report";
const SYNTHESIS_ONLY_WORKFLOW_ID = "academic_literature_review.synthesis_only";

/**
 * Dedicated synthesis-only execution-per-pass Workflow. The general Academic
 * Research pipeline uses the same WorkflowExecution authority through
 * researchPassExecution.ts; this specialized pass exists because generating
 * an on-demand immutable snapshot has a smaller two-node graph.
 */
export async function startSynthesisOnlyExecution(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  workflow: { id: string; state_json: unknown },
  state: ResearchOperationState,
): Promise<{ id: string }> {
  return withQueryableTransaction(db, async (tx) => {
    await lockActiveProjectForMutation(tx, identity.spaceId, projectId);
    const derivedSteps = deriveStepStates(state);
    const operation = await new ProjectOperationRepository(tx).createManagedResearch(identity, projectId, {
      title: "Generate research report snapshot",
      intentText: "Synthesize the current reviewed corpus into a new immutable report snapshot.",
      status: "active",
      progress: state as unknown as Record<string, unknown>,
      steps: operationSteps().map((title, seq) => ({ title, status: derivedSteps.find((step) => step.seq === seq)?.status ?? "pending" })),
    });
    const matrixArtifactId = await new ProjectResearchArtifactService(tx).ensureLiteratureMatrix({
      spaceId: identity.spaceId, projectId, workflowId: workflow.id, operationId: operation.id, ownerUserId: identity.userId,
    });
    const resolvedPrompt = await resolveProjectResearchSynthesisPrompt(tx, {
      spaceId: identity.spaceId, userId: identity.userId, projectId, agentId: state.agent_id,
      researchQuestion: researchQueryText(state), researchScope: state.research_scope, reportDepth: state.report_depth,
    });
    if (!resolvedPrompt) throw new HttpError(500, "Project Research synthesis prompt is not resolvable");

    const automation = await findOrCreateResearchAutomation(tx, identity, projectId, state.agent_id);
    const versionId = await findOrCreateSynthesisOnlyTemplateVersion(tx, identity);
    const executionService = new WorkflowExecutionService();
    await executionService.start({
      db: tx,
      identity,
      automation,
      target: {
        versionId,
        resolutionTrace: [`project_research_operation:${operation.id}`],
        contentJson: synthesisOnlyDefinition({
          instruction: resolvedPrompt.instruction,
          promptVersionId: resolvedPrompt.resolveResult.version_id,
          promptContentHash: resolvedPrompt.resolveResult.content_hash,
          operationId: operation.id,
          workflowId: workflow.id,
          matrixArtifactId,
          researchQuestion: state.research_question,
          researchQuestionVersion: state.research_question_version,
        }),
      },
      triggerType: "manual",
      inputJson: {
        project_research: { workflow_id: workflow.id, operation_id: operation.id, run_kind: "synthesis_only" },
      },
      preflightSnapshot: { executable: true },
      budgetSources: [],
      researchOperationId: operation.id,
      beforeSchedule: async (executionId) => {
        await tx.query(
          `UPDATE project_operations
              SET current_execution_id=$3, generation=generation+1, updated_at=$4
            WHERE id=$1 AND space_id=$2`,
          [operation.id, identity.spaceId, executionId, new Date().toISOString()],
        );
      },
    });
    return { id: operation.id };
  });
}

export async function findOrCreateResearchAutomation(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  agentId: string,
): Promise<AutomationRow> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM automations
      WHERE space_id=$1 AND project_id=$2 AND agent_id=$4
        AND config_json->>'purpose'=$3
      ORDER BY created_at ASC LIMIT 1`,
    [identity.spaceId, projectId, RESEARCH_AUTOMATION_PURPOSE, agentId],
  );
  if (existing.rows[0]) {
    const row = await db.query<AutomationRow>(`SELECT * FROM automations WHERE id=$1 AND space_id=$2`, [existing.rows[0].id, identity.spaceId]);
    if (row.rows[0]) return row.rows[0];
  }
  return new PgAutomationRepository(db).create({
    spaceId: identity.spaceId,
    ownerUserId: identity.userId,
    name: "Academic Research: Workflow Execution",
    description: "System-managed Automation bridging Project Research operations to Workflow Executions. Never fired on a schedule; each pass is started directly by the Project Research pipeline.",
    agentId,
    projectId,
    triggerType: "manual",
    configJson: { purpose: RESEARCH_AUTOMATION_PURPOSE },
    preflightSnapshot: {},
  });
}

const SYNTHESIS_ONLY_TEMPLATE_ASSET_KEY = "academic_literature_review.synthesis_only";

/**
 * One approved `workflow_definition.v1` Workflow Version per Space, found or
 * created once (plan section 18: "the current pipeline becomes the Academic
 * Literature Review Workflow Template"). Its `content_json` is a generic,
 * unresolved shape for audit/discoverability; the actual per-pass definition
 * (with the resolved synthesis instruction) lives on `workflow_executions.
 * definition_json`, materialized fresh by `synthesisOnlyDefinition` above —
 * `workflowVersionId` here is provenance, not what gets executed.
 */
async function findOrCreateSynthesisOnlyTemplateVersion(db: Queryable, identity: SpaceUserIdentity): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT v.id FROM evolvable_asset_versions v
       JOIN evolvable_assets a ON a.id=v.asset_id
      WHERE a.asset_key=$1 AND v.space_id=$2 AND v.status='approved'
      ORDER BY v.version DESC LIMIT 1`,
    [SYNTHESIS_ONLY_TEMPLATE_ASSET_KEY, identity.spaceId],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const now = new Date().toISOString();
  const assetId = randomUUID();
  await db.query(
    `INSERT INTO evolvable_assets (
       id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
       status, metadata_json, created_at, updated_at
     ) VALUES ($1, $2, 'workflow_template', $3, 'Academic Literature Review — synthesis only', $4, 'space', $2, 'active', '{}'::jsonb, $5, $5)
     ON CONFLICT DO NOTHING`,
    [assetId, identity.spaceId, SYNTHESIS_ONLY_TEMPLATE_ASSET_KEY,
      "Synthesizes the current reviewed corpus into an immutable research report snapshot. See synthesisOnlyExecution.ts.", now],
  );
  const asset = await db.query<{ id: string }>(
    `SELECT id FROM evolvable_assets WHERE space_id=$1 AND asset_key=$2`,
    [identity.spaceId, SYNTHESIS_ONLY_TEMPLATE_ASSET_KEY],
  );
  const versionId = randomUUID();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO evolvable_asset_versions (
       id, asset_id, space_id, scope_type, scope_id, version, status, source, content_json, created_at, updated_at
     ) VALUES ($1, $2, $3, 'space', $3, 1, 'approved', 'user_authored', $4::jsonb, $5, $5)
     ON CONFLICT (asset_id, version) DO NOTHING
     RETURNING id`,
    [versionId, asset.rows[0]!.id, identity.spaceId, JSON.stringify(synthesisOnlyTemplateShape()), now],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const raced = await db.query<{ id: string }>(
    `SELECT id FROM evolvable_asset_versions WHERE asset_id=$1 AND version=1`,
    [asset.rows[0]!.id],
  );
  return raced.rows[0]!.id;
}

function synthesisOnlyTemplateShape(): Record<string, unknown> {
  return synthesisOnlyDefinition({
    instruction: "(resolved per pass — see workflow_executions.definition_json)",
    promptVersionId: "", promptContentHash: null,
    operationId: "", workflowId: "", matrixArtifactId: "",
    researchQuestion: "", researchQuestionVersion: 1,
  });
}

function synthesisOnlyDefinition(input: {
  instruction: string;
  promptVersionId: string;
  promptContentHash: string | null;
  operationId: string;
  workflowId: string;
  matrixArtifactId: string;
  researchQuestion: string;
  researchQuestionVersion: number;
}): Record<string, unknown> {
  return {
    schema_version: "workflow_definition.v1",
    workflow_id: SYNTHESIS_ONLY_WORKFLOW_ID,
    name: "Academic Literature Review — synthesis only",
    description: "Synthesizes the current reviewed corpus into an immutable research report snapshot.",
    input_schema_json: {},
    output_artifact_types: ["research_report.archive.v1"],
    metadata_json: {},
    nodes: [
      {
        id: "synthesize",
        title: "Synthesize the approved research corpus",
        description: input.instruction,
        depends_on: [],
        capability_id: "research.brief_synthesize",
        contract_json: {
          risk_level: "low",
          required_outputs_json: { artifact_types: ["research_report.archive.v1"] },
          structured_output_json: RESEARCH_SYNTHESIS_OUTPUT_CONTRACT,
        },
        metadata_json: {
          prompt_asset_key: PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY,
          prompt_version_id: input.promptVersionId,
          prompt_content_hash: input.promptContentHash,
        },
      },
      {
        id: "materialize_report",
        title: "Materialize the research report",
        depends_on: ["synthesize"],
        input_bindings: [
          { name: "report_archive", from_node: "synthesize", source: "artifact", artifact_type: "research_report.archive.v1" },
        ],
        contract_json: {},
        metadata_json: {
          node_kind: "action",
          action_key: MATERIALIZE_REPORT_ACTION_KEY,
          operation_id: input.operationId,
          workflow_id: input.workflowId,
          matrix_artifact_id: input.matrixArtifactId,
          research_question: input.researchQuestion,
          research_question_version: input.researchQuestionVersion,
        },
      },
    ],
  };
}

registerSynthesisOnlyHandlers();

function registerSynthesisOnlyHandlers(): void {
  actionNodeHandlerRegistry.register(MATERIALIZE_REPORT_ACTION_KEY, materializeReport);
  workflowExecutionOutcomeHandlerRegistry.register(
    SYNTHESIS_ONLY_WORKFLOW_ID,
    async ({ db, spaceId, executionId, researchOperationId, status }) => {
      if (!researchOperationId || status !== "failed") return;
      await applyExecutionOutcomeToOperation(db, spaceId, researchOperationId, executionId, "failed", {
        failure_reason: "Workflow Execution failed after exhausting its node attempts",
      }, true);
    },
  );
}

async function materializeReport(context: ActionNodeContext): Promise<ActionNodeResult> {
  const metadata = context.metadata;
  const operationId = requireMetadataString(metadata, "operation_id");
  const workflowId = requireMetadataString(metadata, "workflow_id");
  const projectId = context.projectId;
  if (!projectId) throw new ActionNodeHandlerError("materialize_report requires a Project-scoped Workflow Execution");
  await lockOperationExecutionAuthority(
    context.db,
    context.identity.spaceId,
    operationId,
    context.executionId,
  );

  const archiveBinding = context.bindings.find((binding) => binding.name === "report_archive");
  const archiveArtifactId = objectValue(context.inputs.report_archive).artifact_id;
  if (!archiveBinding?.source_run_id || typeof archiveArtifactId !== "string") {
    throw new ActionNodeHandlerError("Synthesis did not produce a research_report.archive.v1 artifact");
  }
  const artifactRows = await context.db.query<ResearchArtifactRecord>(
    `SELECT id, artifact_type, content FROM artifacts WHERE id=$1 AND space_id=$2 AND run_id=$3`,
    [archiveArtifactId, context.identity.spaceId, archiveBinding.source_run_id],
  );
  const validation = await validateResearchArtifacts(artifactRows.rows);
  if (!validation.ok) {
    throw new ActionNodeHandlerError(validation.failure.message, { failure: validation.failure });
  }

  const materialized = await new ProjectResearchReportMaterializer(context.db).materialize({
    spaceId: context.identity.spaceId,
    projectId,
    workflowId,
    operationId,
    synthesisRunId: archiveBinding.source_run_id,
    runKind: "synthesis_only",
    researchQuestion: requireMetadataString(metadata, "research_question"),
    researchQuestionVersion: Number(metadata.research_question_version) || 1,
    report: validation.report,
    archiveArtifactId: validation.archive.id,
    literatureMatrixArtifactId: optionalString(metadata.matrix_artifact_id),
  });
  const checkpointId = await upsertPendingResearchCheckpoint(context.db, {
    spaceId: context.identity.spaceId,
    projectId,
    workflowId,
    operationId,
    checkpointType: "idea_review",
    machineResult: {
      operation_id: operationId,
      run_kind: "synthesis_only",
      report_id: materialized.id,
      idea_count: materialized.ideaCount,
      requires_batch_decision: true,
    },
  });

  await applyExecutionOutcomeToOperation(
    context.db,
    context.identity.spaceId,
    operationId,
    context.executionId,
    "waiting_review",
    {
      research_report_id: materialized.id,
      idea_count: materialized.ideaCount,
      checkpoint_ids: [checkpointId],
    },
  );
  return { output: { research_report_id: materialized.id, idea_count: materialized.ideaCount } };
}

/**
 * Applies the terminal outcome of this specialized WorkflowExecution to the
 * Project operation projection. Keeps
 * `progress_json.current_stage`/`stage_state` as an informational last-known
 * snapshot (existing UI reads it), while the WorkflowExecution's own nodes
 * remain the real authority throughout the pass.
 */
async function applyExecutionOutcomeToOperation(
  db: Queryable,
  spaceId: string,
  operationId: string,
  executionId: string,
  outcome: "waiting_review" | "failed",
  detail: Record<string, unknown>,
  ignoreStale = false,
): Promise<void> {
  const row = await db.query<{ project_id: string; progress_json: ResearchOperationState }>(
    `SELECT project_id, progress_json FROM project_operations
      WHERE id=$1 AND space_id=$2
        AND current_execution_id=$3
      FOR UPDATE`,
    [operationId, spaceId, executionId],
  );
  const operation = row.rows[0];
  if (!operation) {
    if (ignoreStale) return;
    throw new HttpError(409, "Operation is not governed by this Workflow Execution");
  }
  const nextState: ResearchOperationState = {
    ...operation.progress_json,
    current_stage: outcome === "waiting_review" ? "idea_review" : "failed",
    stage_state: outcome === "waiting_review" ? "waiting_review" : "failed",
    heartbeat_at: new Date().toISOString(),
    ...detail,
  };
  await setResearchOperationState(
    db,
    { id: operationId, space_id: spaceId, project_id: operation.project_id, progress_json: operation.progress_json },
    nextState,
    outcome === "waiting_review"
      ? [{ seq: 3, status: "done" }, { seq: 4, status: "blocked", detail: { checkpoint_id: nextState.checkpoint_ids[0] } }]
      : deriveStepStates(nextState),
  );
}

async function lockOperationExecutionAuthority(
  db: Queryable,
  spaceId: string,
  operationId: string,
  executionId: string,
): Promise<void> {
  const row = await db.query(
    `SELECT 1 FROM project_operations
      WHERE id=$1 AND space_id=$2
        AND current_execution_id=$3
      FOR UPDATE`,
    [operationId, spaceId, executionId],
  );
  if (!row.rows[0]) {
    throw new ActionNodeHandlerError(
      "materialize_report is not governed by this Workflow Execution",
    );
  }
}

function requireMetadataString(metadata: Record<string, unknown>, key: string): string {
  const value = optionalString(metadata[key]);
  if (!value) throw new ActionNodeHandlerError(`materialize_report node metadata is missing '${key}'`);
  return value;
}
