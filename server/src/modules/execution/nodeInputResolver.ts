import type { WorkflowNodeInputBinding } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { Queryable } from "../routeUtils/common";
import { runOutputResult } from "../runs/orchestrationResults";

const MAX_BINDING_CHARS = 12_000;

export interface ResolvedNodeInputs {
  values: Record<string, unknown>;
  bindings: Array<{
    name: string;
    from_node: string;
    source: WorkflowNodeInputBinding["source"];
    source_run_id: string | null;
    value: unknown;
    artifact_id: string | null;
    truncated: boolean;
    missing_reason: string | null;
  }>;
  contextArtifactIds: string[];
}

export class InputBindingResolutionError extends Error {
  constructor(readonly bindingName: string, readonly reason: string) {
    super(`Required input binding '${bindingName}' could not be resolved: ${reason}`);
    this.name = "InputBindingResolutionError";
  }
}

export async function resolveNodeInputs(
  db: Queryable,
  input: {
    spaceId: string;
    bindings: WorkflowNodeInputBinding[];
    sourceTable: "plan_nodes" | "workflow_execution_nodes";
    linkTable: "plan_node_runs" | "workflow_execution_node_runs";
    linkNodeColumn: "plan_node_id" | "node_id";
    scopeColumn: "plan_version_id" | "execution_id";
    scopeId: string;
  },
): Promise<ResolvedNodeInputs> {
  const result: ResolvedNodeInputs = { values: {}, bindings: [], contextArtifactIds: [] };
  for (const binding of input.bindings) {
    const source = await db.query<{ node_id: string; run_id: string; output_json: unknown }>(
      `SELECT source_node.id AS node_id, r.id AS run_id, r.output_json
         FROM ${input.sourceTable} source_node
         JOIN ${input.linkTable} link
           ON link.${input.linkNodeColumn} = source_node.id AND link.space_id = source_node.space_id
         JOIN runs r ON r.id = link.run_id AND r.space_id = link.space_id
         JOIN LATERAL (
           SELECT evaluation.outcome_status
             FROM run_evaluations evaluation
            WHERE evaluation.space_id = r.space_id AND evaluation.run_id = r.id
            ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC
            LIMIT 1
         ) latest_evaluation ON latest_evaluation.outcome_status = 'passed'
        WHERE source_node.space_id = $1 AND source_node.node_key = $2
          AND source_node.${input.scopeColumn} = $3
        ORDER BY (link.role='delegated') DESC, link.created_at DESC, link.id DESC
        LIMIT 1`,
      [input.spaceId, binding.from_node, input.scopeId],
    );
    const row = source.rows[0];
    const canonicalOutput = row ? record(row.output_json) : {};
    const hasCanonicalOutput = canonicalOutput.schema_version === "run_output.v1";
    const canonicalResult = hasCanonicalOutput ? runOutputResult(row?.output_json) : {};
    let value: unknown = null;
    let artifactId: string | null = null;
    let missingReason: string | null = row ? null : "passed_source_run_missing";
    if (row && binding.source !== "artifact" && !hasCanonicalOutput) {
      missingReason = "canonical_output_missing";
    } else if (row && binding.source === "output_text") {
      value = canonicalOutput.summary ?? null;
      if (value === null) missingReason = "output_text_missing";
    } else if (row && binding.source === "output_json") {
      value = jsonPointer(canonicalResult, binding.json_pointer ?? "");
      if (value === undefined) {
        value = null;
        missingReason = "json_pointer_missing";
      }
    } else if (row && binding.source === "artifact") {
      const artifact = await db.query<{ id: string }>(
        `SELECT id FROM artifacts
          WHERE space_id = $1 AND run_id = $2 AND artifact_type = $3
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [input.spaceId, row.run_id, binding.artifact_type],
      );
      artifactId = artifact.rows[0]?.id ?? null;
      value = artifactId ? { artifact_id: artifactId, artifact_type: binding.artifact_type } : null;
      if (!artifactId) missingReason = "artifact_missing";
    }
    if (missingReason && binding.required) throw new InputBindingResolutionError(binding.name, missingReason);
    const bounded = boundValue(value);
    result.values[binding.name] = bounded.value;
    result.bindings.push({
      name: binding.name,
      from_node: binding.from_node,
      source: binding.source,
      source_run_id: row?.run_id ?? null,
      value: bounded.value,
      artifact_id: artifactId,
      truncated: bounded.truncated,
      missing_reason: missingReason,
    });
    if (artifactId) result.contextArtifactIds.push(artifactId);
  }
  return result;
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else return undefined;
  }
  return current;
}

function boundValue(value: unknown): { value: unknown; truncated: boolean } {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized || serialized.length <= MAX_BINDING_CHARS) return { value, truncated: false };
  return { value: `${serialized.slice(0, MAX_BINDING_CHARS)}\n[truncated upstream input]`, truncated: true };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
