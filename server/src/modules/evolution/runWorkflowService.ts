import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { HttpError, requiredString } from "../routeUtils/common";
import { PgRunRepository, type RunRecord } from "../runs/repository";
import { insertProposalRow } from "../proposals/reviewPackets";
import { loadProtocol } from "../providers/protocolRuntime";
import { sha256Json } from "./hash";
import { normalizeAssetOwnerScopeForCreate } from "./assetAccess";
import { redactSecretPatterns } from "../runs/evidenceRedaction";

const RISK_ORDER = ["low", "medium", "high", "critical"] as const;
const MAX_TEXT_LENGTH = 512;

interface WorkflowSource {
  prompt: string | null;
  run_type: string;
  capability_id: string | null;
  contract_snapshot_json: unknown;
}

export interface RunWorkflowPreview {
  run_id: string;
  source_kind: "run" | "plan";
  risk_level: string;
  requires_proposal: boolean;
  definition: WorkflowDefinition;
  evidence: {
    artifact_types: string[];
    verification: Array<{ verifier_type: string; verifier_version: string; status: string; summary: string | null }>;
  };
}

export interface SaveRunAsWorkflowInput {
  run_id: string;
  asset_key?: string | null;
  display_name?: string | null;
  description?: string | null;
  input_schema_json?: Record<string, unknown> | null;
}

export class RunWorkflowService {
  constructor(private readonly db: Queryable) {}

  async preview(identity: SpaceUserIdentity, input: SaveRunAsWorkflowInput): Promise<RunWorkflowPreview> {
    const run = await this.visibleSuccessfulRun(identity, input.run_id);
    return this.extract(identity, run, input);
  }

  async save(identity: SpaceUserIdentity, input: SaveRunAsWorkflowInput): Promise<Record<string, unknown>> {
    const run = await this.visibleSuccessfulRun(identity, input.run_id);
    const preview = await this.extract(identity, run, input);
    const assetKey = assetKeyFor(input.asset_key, run.id);
    const displayName = boundedText(input.display_name) ?? `Saved workflow from ${run.run_type}`;
    const description = boundedText(input.description) ?? "Workflow saved from a successful run.";
    if (preview.requires_proposal) {
      const proposal = await insertProposalRow(this.db, {
        spaceId: identity.spaceId,
        proposalType: "workflow_save",
        title: `Save workflow: ${displayName}`,
        summary: "A workflow extracted from a successful run requires review before the draft is saved.",
        payload: {
          proposal_type: "workflow_save",
          asset_key: assetKey,
          display_name: displayName,
          description,
          content_json: preview.definition,
          content_hash: sha256Json(preview.definition),
        },
        rationale: `Extracted from a ${preview.source_kind} with risk level ${preview.risk_level}.`,
        createdByUserId: identity.userId,
        createdByRunId: run.id,
        projectFolderId: run.project_folder_id,
        projectId: run.project_id,
        visibility: "space_shared",
        riskLevel: preview.risk_level,
      });
      return {
        status: "proposal_required",
        proposal_id: proposal.id,
        proposal_type: proposal.proposal_type,
        risk_level: preview.risk_level,
        preview,
      };
    }
    const draft = await this.createDraft(identity, {
      assetKey,
      displayName,
      description,
      definition: preview.definition,
    });
    return {
      status: "draft_saved",
      risk_level: preview.risk_level,
      preview,
      ...draft,
    };
  }

  private async visibleSuccessfulRun(identity: SpaceUserIdentity, runId: string): Promise<RunRecord> {
    const id = requiredString(runId, "run_id");
    const run = await new PgRunRepository(this.db).getVisibleRun(identity.spaceId, identity.userId, id);
    if (!run) throw new HttpError(404, "Run not found");
    if (run.status !== "succeeded" && run.status !== "degraded") {
      throw new HttpError(422, "Only a successful or degraded terminal run can be saved as a workflow");
    }
    const evaluation = await new PgRunRepository(this.db).getLatestRunEvaluation(identity.spaceId, run.id);
    if (!evaluation || evaluation.outcome_status !== "passed") {
      throw new HttpError(422, "Run must have a passed post-run evaluation before workflow extraction");
    }
    return run;
  }

  private async extract(
    identity: SpaceUserIdentity,
    run: RunRecord,
    input: SaveRunAsWorkflowInput,
  ): Promise<RunWorkflowPreview> {
    const repository = new PgRunRepository(this.db);
    const [children, steps] = await Promise.all([
      repository.listChildRuns(identity.spaceId, run.id),
      repository.listRunSteps(identity.spaceId, run.id),
    ]);
    const sourceRunIds = [run.id, ...children.map((child) => child.id)];
    const [artifacts, verification] = await Promise.all([
      this.listArtifacts(identity.spaceId, sourceRunIds),
      this.listVerification(identity.spaceId, sourceRunIds),
    ]);
    const sources: WorkflowSource[] = children.length > 0
      ? children.map((child) => sourceFromRun(child))
      : steps.length > 0
        ? steps.map((step) => ({
            prompt: sanitizedText(step.title) ?? sanitizedText(step.output_summary),
            run_type: `step:${step.step_type}`,
            capability_id: run.capability_id ?? null,
            contract_snapshot_json: run.contract_snapshot_json,
          }))
        : [sourceFromRun(run)];
    const maxRisk = sources.reduce<string>((current, source) => {
      const risk = normalizedRisk(contractRecord(source.contract_snapshot_json).risk_level);
      return riskRank(risk) > riskRank(current) ? risk : current;
    }, "low");
    const definition = await this.buildDefinition(run, sources, artifacts, verification, input, maxRisk);
    const protocol = await loadProtocol();
    const parsed = protocol.WorkflowDefinitionSchema.parse(definition);
    return {
      run_id: run.id,
      source_kind: children.length > 0 || run.run_type === "workflow" ? "plan" : "run",
      risk_level: maxRisk,
      requires_proposal: maxRisk !== "low",
      definition: parsed,
      evidence: {
        artifact_types: unique(artifacts.map((artifact) => boundedText(artifact.artifact_type)).filter((value): value is string => Boolean(value))),
        verification: verification.map((result) => ({
          verifier_type: result.verifier_type,
          verifier_version: result.verifier_version,
          status: result.status,
          summary: sanitizedText(result.summary),
        })),
      },
    };
  }

  private async buildDefinition(
    run: RunRecord,
    sources: WorkflowSource[],
    artifacts: Array<{ artifact_type: string; title: string; mime_type: string | null }>,
    verification: Array<{ verifier_type: string; verifier_version: string; status: string; summary: string | null }>,
    input: SaveRunAsWorkflowInput,
    risk: string,
  ): Promise<Record<string, unknown>> {
    const nodes = sources.map((source, index) => {
      const contract = contractRecord(source.contract_snapshot_json);
      const capabilityId = boundedText(source.capability_id);
      return {
        id: `step_${index + 1}`,
        title: sanitizedText(source.prompt) ?? `Workflow step ${index + 1}`,
        depends_on: index === 0 ? [] : [`step_${index}`],
        input_bindings: index === 0
          ? []
          : [{ name: "previous_step_output", from_node: `step_${index}`, source: "output_text", required: true }],
        capability_id: capabilityId,
        prompt_asset_key: capabilityId ? null : "workflow.generated.step",
        agent_id: null,
        runtime_profile_id: null,
        verification_recipe_refs: verification.map((result) => `${result.verifier_type}:${result.verifier_version}`),
        approval_checkpoint: { required: false, proposal_type: null },
        contract_json: sanitizedContract(contract, risk),
        metadata_json: {
          source: "run_extraction",
          runtime_delegation_allowed: false,
          run_type: source.run_type,
          artifact_types: unique(artifacts.map((artifact) => boundedText(artifact.artifact_type)).filter((value): value is string => Boolean(value))),
          verification: verification.map((result) => ({
            verifier_type: result.verifier_type,
            verifier_version: result.verifier_version,
            status: result.status,
            summary: sanitizedText(result.summary),
          })),
        },
      };
    });
    return {
      schema_version: "workflow_definition.v1",
      workflow_id: assetKeyFor(input.asset_key, run.id),
      name: boundedText(input.display_name) ?? `Saved workflow from ${run.run_type}`,
      description: boundedText(input.description) ?? "Workflow saved from a successful run.",
      input_schema_json: sanitizeObject(input.input_schema_json ?? { type: "object", properties: {} }),
      output_artifact_types: unique(artifacts.map((artifact) => boundedText(artifact.artifact_type)).filter((value): value is string => Boolean(value))),
      nodes,
      metadata_json: {
        source: "run_extraction",
        primary_objective: boundedText(input.description) ?? `Saved workflow from ${run.run_type}`,
        scope_json: { inputs: Object.keys(sanitizeObject(input.input_schema_json ?? { type: "object", properties: {} })) },
        risk_level: risk,
        artifact_evidence: artifacts.map((artifact) => ({
          type: boundedText(artifact.artifact_type),
          title: sanitizedText(artifact.title),
          mime_type: sanitizedText(artifact.mime_type),
        })),
        verification_evidence: verification.map((result) => ({
          verifier_type: result.verifier_type,
          verifier_version: result.verifier_version,
          status: result.status,
          summary: sanitizedText(result.summary),
        })),
      },
    };
  }

  private async listArtifacts(spaceId: string, runIds: string[]): Promise<Array<{ artifact_type: string; title: string; mime_type: string | null }>> {
    const result = await this.db.query<{ artifact_type: string; title: string; mime_type: string | null }>(
      `SELECT artifact_type, title, mime_type FROM artifacts WHERE space_id = $1 AND run_id = ANY($2::varchar[]) ORDER BY created_at ASC, id ASC`,
      [spaceId, runIds],
    );
    return result.rows;
  }

  private async listVerification(spaceId: string, runIds: string[]): Promise<Array<{ verifier_type: string; verifier_version: string; status: string; summary: string | null }>> {
    const result = await this.db.query<{ verifier_type: string; verifier_version: string; status: string; summary: string | null }>(
      `SELECT verifier_type, verifier_version, status, summary FROM verification_results WHERE space_id = $1 AND run_id = ANY($2::varchar[]) ORDER BY created_at ASC, id ASC`,
      [spaceId, runIds],
    );
    return result.rows;
  }

  private async createDraft(
    identity: SpaceUserIdentity,
    input: { assetKey: string; displayName: string; description: string; definition: WorkflowDefinition },
  ): Promise<{ asset_id: string; version_id: string; version_status: "draft" }> {
    const owner = await normalizeAssetOwnerScopeForCreate(this.db, identity, "space", null);
    return withQueryableTransaction(this.db, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM evolvable_assets WHERE space_id = $1 AND asset_key = $2 LIMIT 1`,
        [identity.spaceId, input.assetKey],
      );
      if (existing.rows[0]) throw new HttpError(409, "asset_key is already in use in this space");
      const assetId = randomUUID();
      const versionId = randomUUID();
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO evolvable_assets (
           id, space_id, asset_type, asset_key, display_name, description,
           owner_scope_type, status, metadata_json, created_at, updated_at
         ) VALUES ($1, $2, 'workflow_template', $3, $4, $5, $6, 'active', $7::jsonb, $8, $8)`,
        [assetId, identity.spaceId, input.assetKey, input.displayName, input.description, owner.ownerScopeType, JSON.stringify({ source: "run_extraction" }), now],
      );
      await client.query(
        `INSERT INTO evolvable_asset_versions (
           id, asset_id, space_id, scope_type, scope_id, version, status, source,
           content_hash, content_json, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'space', $3, 1, 'draft', 'generated', $4, $5::jsonb, $6, $7, $7)`,
        [versionId, assetId, identity.spaceId, sha256Json(input.definition), JSON.stringify(input.definition), identity.userId, now],
      );
      return { asset_id: assetId, version_id: versionId, version_status: "draft" as const };
    });
  }
}

function contractRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sanitizedContract(contract: Record<string, unknown>, fallbackRisk: string): Record<string, unknown> {
  const allowed = ["acceptance_criteria_json", "definition_of_done", "required_outputs_json", "max_attempts", "max_duration_seconds"];
  const result: Record<string, unknown> = {
    risk_level: normalizedRisk(contract.risk_level) || fallbackRisk,
    max_attempts: positiveIntegerOrDefault(contract.max_attempts, 1),
    required_outputs_json: contract.required_outputs_json ?? [{ type: "output_schema", schema: { type: "object" } }],
  };
  for (const key of allowed) {
    if (contract[key] !== undefined) result[key] = sanitizeValue(contract[key]);
  }
  return result;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    const redacted = redactSecretPatterns(value);
    return redacted.length > MAX_TEXT_LENGTH ? `${redacted.slice(0, MAX_TEXT_LENGTH)}…` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 32).map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) continue;
    output[key] = sanitizeValue(child);
  }
  return output;
}

function sourceFromRun(run: RunRecord): WorkflowSource {
  return {
    prompt: sanitizedText(run.prompt),
    run_type: run.run_type ?? "agent",
    capability_id: run.capability_id ?? null,
    contract_snapshot_json: run.contract_snapshot_json,
  };
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return new Set([
    "credential", "credentials", "secret", "secrets", "token", "password", "api_key",
    "auth", "authorization", "run_id", "session_id", "sandbox", "sandbox_cwd",
    "working_dir", "working_dir_id", "cwd", "path", "host_source_path", "target_path",
  ]).has(normalized);
}

function assetKeyFor(value: string | null | undefined, runId: string): string {
  const key = value?.trim() || `workflow.saved.${sha256Json({ source_run: runId }).slice(0, 12)}`;
  if (!/^[a-z][a-z0-9_.-]{0,159}$/.test(key)) throw new HttpError(422, "asset_key must be a lowercase workflow asset key");
  return key;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

function sanitizedText(value: unknown): string | null {
  const text = boundedText(typeof value === "string" ? redactSecretPatterns(value) : value);
  if (!text) return null;
  return text.replace(/(?:^|\s)(?:\/[A-Za-z0-9._-]+)+(?:\/[A-Za-z0-9._-]+)*(?=\s|$)/g, " [PATH]");
}

function normalizedRisk(value: unknown): string {
  return RISK_ORDER.includes(value as typeof RISK_ORDER[number]) ? value as string : "medium";
}

function riskRank(value: string): number {
  return RISK_ORDER.indexOf(value as typeof RISK_ORDER[number]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
