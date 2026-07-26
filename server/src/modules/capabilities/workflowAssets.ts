import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { HttpError, type Queryable } from "../routeUtils/common";
import { resolveEvolvableAssetVersion } from "../evolution/assetResolutionService";
import { sha256Json, stableJsonStringify } from "../evolution/hash";
import { loadProtocol } from "../providers/protocolRuntime";
import { listBuiltInWorkflowTemplates } from "./workflowRegistry";
import type { WorkflowTemplate } from "./types";

const WORKFLOW_ASSET_TYPE = "workflow_template";

export interface WorkflowAssetSyncResult {
  assetKeys: string[];
  versionsCreated: string[];
}

export async function syncBuiltinWorkflows(db: Queryable): Promise<WorkflowAssetSyncResult> {
  const result: WorkflowAssetSyncResult = { assetKeys: [], versionsCreated: [] };
  for (const template of listBuiltInWorkflowTemplates()) {
    const definition = await workflowDefinitionFromTemplate(template);
    await upsertBuiltinWorkflowAsset(db, template);
    result.assetKeys.push(template.id);
    if (await ensureBuiltinWorkflowVersion(db, template.id, definition)) {
      result.versionsCreated.push(template.id);
    }
  }
  return result;
}

export async function resolveWorkflowVersionId(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    projectId: string | null;
    agentId: string;
    workflowId: string;
  },
): Promise<string | null> {
  try {
    const resolved = await resolveEvolvableAssetVersion(db, {
      spaceId: input.spaceId,
      userId: input.userId,
      projectId: input.projectId,
      agentId: input.agentId,
      assetKey: input.workflowId,
      assetType: WORKFLOW_ASSET_TYPE,
    });
    return resolved.versionId;
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) return null;
    throw error;
  }
}

export async function workflowDefinitionFromTemplate(template: WorkflowTemplate): Promise<WorkflowDefinition> {
  let previousNodeId: string | null = null;
  const nodes = template.capability_ids.map((capabilityId, index) => {
    const nodeId = `step_${index + 1}_${capabilityId.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    const node = {
      id: nodeId,
      title: capabilityId,
      depends_on: previousNodeId ? [previousNodeId] : [],
      input_bindings: previousNodeId
        ? [{ name: "previous_step_output", from_node: previousNodeId, source: "output_text" as const, required: true }]
        : [],
      capability_id: capabilityId,
      prompt_asset_key: `workflow.${template.id}.run`,
      agent_id: null,
      runtime_profile_id: null,
      verification_recipe_refs: [],
      approval_checkpoint: {
        required: index === template.capability_ids.length - 1,
        proposal_type: index === template.capability_ids.length - 1 ? "workflow_output_review" : null,
      },
      contract_json: {
        risk_level: "low",
        max_attempts: 1,
        required_outputs_json: [{ type: "output_schema", schema: { type: "object" } }],
      },
      metadata_json: {
        source: "builtin_workflow_template",
        runtime_delegation_allowed: false,
      },
    };
    previousNodeId = nodeId;
    return node;
  });
  const protocol = await loadProtocol();
  return protocol.WorkflowDefinitionSchema.parse({
    schema_version: "workflow_definition.v1",
    workflow_id: template.id,
    name: template.name,
    description: template.description,
    input_schema_json: template.input_schema_json,
    output_artifact_types: template.output_artifact_types,
    nodes,
    metadata_json: {
      category: template.category,
      primary_objective: template.description,
      scope_json: { inputs: Object.keys(template.input_schema_json) },
      capability_ids: template.capability_ids,
      proposal_policy: template.proposal_policy,
      recommended_runtime_adapters: template.recommended_runtime_adapters,
      execution_shape: template.execution_shape ?? "structured_generation",
      required_capabilities: template.required_capabilities ?? [],
      required_tools: template.required_tools ?? [],
      prompt_asset_keys: template.prompt_asset_keys,
    },
  });
}

async function upsertBuiltinWorkflowAsset(db: Queryable, template: WorkflowTemplate): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO evolvable_assets (
       id, space_id, asset_type, asset_key, display_name, description, owner_scope_type,
       owner_scope_id, status, metadata_json, created_at, updated_at
     ) VALUES ($1, NULL, $2, $3, $4, $5, 'system', NULL, 'active', $6::jsonb, $7, $7)
     ON CONFLICT (asset_key) WHERE space_id IS NULL DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       metadata_json = COALESCE(evolvable_assets.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
       updated_at = EXCLUDED.updated_at
     WHERE evolvable_assets.asset_type = EXCLUDED.asset_type`,
    [
      randomUUID(),
      WORKFLOW_ASSET_TYPE,
      template.id,
      template.name,
      template.description,
      JSON.stringify({ workflow_id: template.id, source: "builtin_workflow_template" }),
      now,
    ],
  );
}

async function ensureBuiltinWorkflowVersion(
  db: Queryable,
  workflowId: string,
  definition: WorkflowDefinition,
): Promise<boolean> {
  const asset = await db.query<{ id: string; current_system_version_id: string | null }>(
    `SELECT id, current_system_version_id
       FROM evolvable_assets
      WHERE asset_key = $1 AND asset_type = $2 AND space_id IS NULL
      LIMIT 1`,
    [workflowId, WORKFLOW_ASSET_TYPE],
  );
  const assetRow = asset.rows[0];
  if (!assetRow) throw new HttpError(500, `Workflow asset '${workflowId}' was not created before version sync`);
  const contentHash = sha256Json(definition);
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM evolvable_asset_versions WHERE asset_id = $1 AND content_hash = $2 LIMIT 1`,
    [assetRow.id, contentHash],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].id !== assetRow.current_system_version_id) {
      await db.query(
        `UPDATE evolvable_assets SET current_system_version_id = $2, updated_at = $3 WHERE id = $1`,
        [assetRow.id, existing.rows[0].id, new Date().toISOString()],
      );
    }
    return false;
  }
  const next = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM evolvable_asset_versions WHERE asset_id = $1`,
    [assetRow.id],
  );
  const versionId = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO evolvable_asset_versions (
       id, asset_id, space_id, scope_type, scope_id, version, status, source,
       content_hash, content_json, created_at, updated_at
     ) VALUES ($1, $2, NULL, 'system', NULL, $3, 'approved', 'built_in', $4, $5::jsonb, $6, $6)`,
    [versionId, assetRow.id, next.rows[0]?.next ?? 1, contentHash, stableJsonStringify(definition), now],
  );
  await db.query(
    `UPDATE evolvable_assets SET current_system_version_id = $2, updated_at = $3 WHERE id = $1`,
    [assetRow.id, versionId, now],
  );
  return true;
}
