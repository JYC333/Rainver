import type { Queryable } from "../routeUtils/common.js";
import { runOutputResult } from "../runs/orchestrationResults.js";

export interface PlanIntegrationVerification {
  status: "passed" | "failed";
  summary: string;
  checks: Array<{ name: string; status: "passed" | "failed"; details: Record<string, unknown> }>;
  nodes: Array<{
    node_key: string;
    status: string;
    run_id: string | null;
    outcome_status: string | null;
    output_ref_count: number;
  }>;
}

interface PlanNodeOutputRow {
  node_id: string;
  node_key: string;
  node_kind: string;
  status: string;
  run_id: string | null;
  outcome_status: string | null;
  output_json: unknown;
  required_outputs_json: unknown;
  verification_passed: boolean;
  verification_count: number;
}

interface OutputValidation {
  valid: boolean;
  output_ref_count: number;
  reasons: string[];
}

export async function verifyIntegrationNode(
  client: Queryable,
  spaceId: string,
  nodeId: string,
  dependencyNodeIds: string[],
): Promise<{ status: "passed" | "failed"; summary: string }> {
  if (dependencyNodeIds.length === 0) {
    return { status: "failed", summary: "Integration node has no dependencies to verify." };
  }
  const result = await client.query<PlanNodeOutputRow>(nodeQuery("n.id = ANY($2::varchar[])"), [spaceId, dependencyNodeIds]);
  const validations = await validateRows(client, spaceId, result.rows);
  const failed = result.rows.filter((row) => {
    const validation = validations.get(row.node_id);
    return row.status !== "done" || row.outcome_status !== "passed" || !validation?.valid;
  });
  const passed = result.rows.length === dependencyNodeIds.length && failed.length === 0;
  return {
    status: passed ? "passed" : "failed",
    summary: passed
      ? `Integration node '${nodeId}' verified ${result.rows.length} completed dependencies and their durable outputs.`
      : `Integration node '${nodeId}' found an incomplete, failed, or unaccounted dependency output.`,
  };
}

export async function verifyPlanIntegration(
  client: Queryable,
  spaceId: string,
  planVersionId: string,
): Promise<PlanIntegrationVerification> {
  const rows = await client.query<PlanNodeOutputRow>(nodeQuery("n.plan_version_id = $2"), [spaceId, planVersionId]);
  const dependencies = await client.query<{ node_id: string; depends_on_node_id: string }>(
    `SELECT d.node_id, d.depends_on_node_id
       FROM plan_node_dependencies d
      WHERE d.space_id = $1 AND d.plan_version_id = $2`,
    [spaceId, planVersionId],
  );
  const validations = await validateRows(client, spaceId, rows.rows);
  const statusByNodeId = new Map(rows.rows.map((row) => [row.node_id, row.status]));
  const dependencyClosure = dependencies.rows.every((edge) =>
    statusByNodeId.get(edge.node_id) === "done" && statusByNodeId.get(edge.depends_on_node_id) === "done",
  );
  const outputBearingRows = rows.rows.filter((row) => !isNonOutputNode(row.node_kind));
  const outputFailures = outputBearingRows.flatMap((row) => {
    const validation = validations.get(row.node_id);
    return validation?.valid ? [] : [{ node_key: row.node_key, reasons: validation?.reasons ?? ["output_not_validated"] }];
  });
  const dependencyOutputFailures = dependencies.rows.flatMap((edge) => {
    const validation = validations.get(edge.depends_on_node_id);
    return validation?.valid ? [] : [{ node_id: edge.depends_on_node_id, reasons: validation?.reasons ?? ["output_not_validated"] }];
  });
  const nodes = rows.rows.map((row) => ({
    node_key: row.node_key,
    status: row.status,
    run_id: row.run_id,
    outcome_status: row.outcome_status,
    output_ref_count: validations.get(row.node_id)?.output_ref_count ?? 0,
  }));
  const checks: PlanIntegrationVerification["checks"] = [
    {
      name: "all_nodes_completed",
      status: rows.rows.length > 0 && rows.rows.every((row) => row.status === "done") ? "passed" : "failed",
      details: { node_count: rows.rows.length },
    },
    {
      name: "child_evaluations_passed",
      status: rows.rows.every((row) => isNonOutputNode(row.node_kind) || (row.run_id !== null && row.outcome_status === "passed")) ? "passed" : "failed",
      details: { evaluated_child_count: rows.rows.filter((row) => row.run_id !== null).length },
    },
    {
      name: "dependency_closure",
      status: dependencyClosure ? "passed" : "failed",
      details: { dependency_count: dependencies.rows.length },
    },
    {
      name: "cross_node_outputs_accounted",
      status: outputFailures.length === 0 && dependencyOutputFailures.length === 0 ? "passed" : "failed",
      details: {
        output_ref_count: nodes.reduce((sum, node) => sum + node.output_ref_count, 0),
        output_bearing_node_count: outputBearingRows.length,
        output_failures: outputFailures,
        dependency_output_failures: dependencyOutputFailures,
      },
    },
  ];
  const status = checks.every((check) => check.status === "passed") ? "passed" : "failed";
  return {
    status,
    summary: status === "passed"
      ? `Root integration verification passed for ${rows.rows.length} plan nodes.`
      : "Root integration verification failed; child completion and cross-node output evidence were not sufficient for plan acceptance.",
    checks,
    nodes,
  };
}

function nodeQuery(filter: string): string {
  return `SELECT n.id AS node_id, n.node_key, n.node_kind, n.status,
                 latest.run_id, latest.outcome_status, latest.output_json,
                 n.required_outputs_json,
                 COALESCE(latest.verification_passed, false) AS verification_passed,
                 COALESCE(latest.verification_count, 0)::int AS verification_count
            FROM plan_nodes n
            LEFT JOIN LATERAL (
              SELECT r.id AS run_id, evaluation.outcome_status, r.output_json,
                     verification.verification_passed, verification.verification_count
                FROM plan_node_runs pnr
                JOIN runs r ON r.id = pnr.run_id AND r.space_id = pnr.space_id
                LEFT JOIN LATERAL (
                  SELECT re.outcome_status
                    FROM run_evaluations re
                   WHERE re.run_id = r.id AND re.space_id = r.space_id
                   ORDER BY re.evaluated_at DESC, re.id DESC
                   LIMIT 1
                ) evaluation ON true
                LEFT JOIN LATERAL (
                  SELECT COALESCE(bool_and(vr.status = 'passed'), false) AS verification_passed,
                         count(*)::int AS verification_count
                    FROM verification_results vr
                   WHERE vr.run_id = r.id AND vr.space_id = r.space_id
                ) verification ON true
               WHERE pnr.space_id = n.space_id AND pnr.plan_node_id = n.id
               ORDER BY pnr.created_at DESC, pnr.id DESC
               LIMIT 1
            ) latest ON true
           WHERE n.space_id = $1 AND ${filter}
           ORDER BY n.created_at ASC, n.id ASC`;
}

async function validateRows(client: Queryable, spaceId: string, rows: PlanNodeOutputRow[]): Promise<Map<string, OutputValidation>> {
  const validations = new Map<string, OutputValidation>();
  for (const row of rows) {
    validations.set(row.node_id, isNonOutputNode(row.node_kind)
      ? { valid: true, output_ref_count: 0, reasons: [] }
      : await validateNodeOutput(client, spaceId, row));
  }
  return validations;
}

async function validateNodeOutput(client: Queryable, spaceId: string, row: PlanNodeOutputRow): Promise<OutputValidation> {
  if (!row.run_id) return { valid: false, output_ref_count: 0, reasons: ["child_run_missing"] };
  const output = runOutputResult(row.output_json);
  const materialization = arrayValue(output.materialization);
  const reasons: string[] = arrayValue(output.materialization_errors).length > 0 ? ["materialization_errors_present"] : [];
  const artifactRefs = materialization.filter((item) => {
    const value = recordValue(item);
    return (value.status === "succeeded" || value.status === "warning") && value.kind === "artifact";
  });
  const proposalRefs = materialization.filter((item) => {
    const value = recordValue(item);
    return (value.status === "succeeded" || value.status === "warning") && ["proposal", "code_patch"].includes(String(value.kind));
  });
  const artifactIds = stringArray(artifactRefs.map((item) => recordValue(item).artifact_id));
  const proposalIds = stringArray(proposalRefs.map((item) => recordValue(item).proposal_id));
  if (artifactRefs.some((item) => !stringValue(recordValue(item).artifact_id))) reasons.push("artifact_reference_missing");
  if (proposalRefs.some((item) => !stringValue(recordValue(item).proposal_id))) reasons.push("proposal_reference_missing");
  const artifacts = artifactIds.length === 0 ? [] : (await client.query<{ id: string; artifact_type: string; title: string }>(
    `SELECT id, artifact_type, title FROM artifacts WHERE space_id = $1 AND run_id = $2 AND id = ANY($3::varchar[])`,
    [spaceId, row.run_id, artifactIds],
  )).rows;
  const proposals = proposalIds.length === 0 ? [] : (await client.query<{ id: string; proposal_type: string }>(
    `SELECT id, proposal_type FROM proposals WHERE space_id = $1 AND created_by_run_id = $2 AND id = ANY($3::varchar[])`,
    [spaceId, row.run_id, proposalIds],
  )).rows;
  if (artifacts.length !== new Set(artifactIds).size) reasons.push("artifact_reference_not_owned_by_run");
  if (proposals.length !== new Set(proposalIds).size) reasons.push("proposal_reference_not_owned_by_run");
  if (hasRequiredOutputs(row.required_outputs_json) && !requiredOutputsSatisfied(row.required_outputs_json, artifacts, proposals, row.verification_passed)) {
    reasons.push(row.verification_count === 0 ? "required_outputs_not_verified" : "required_outputs_not_satisfied");
  }
  const outputRefCount = artifacts.length + proposals.length;
  if (!hasRequiredOutputs(row.required_outputs_json) && outputRefCount === 0) reasons.push("no_durable_output_reference");
  if (materialization.some((item) => ["failed", "skipped"].includes(String(recordValue(item).status)))) reasons.push("materialization_item_not_successful");
  return { valid: reasons.length === 0, output_ref_count: outputRefCount, reasons: [...new Set(reasons)] };
}

function requiredOutputsSatisfied(required: unknown, artifacts: Array<{ artifact_type: string; title: string }>, proposals: Array<{ proposal_type: string }>, verificationPassed: boolean): boolean {
  if (required && typeof required === "object" && !Array.isArray(required)) {
    const value = recordValue(required);
    const artifactTypes = stringArray(value.artifact_types);
    if (artifactTypes.length > 0) return artifactTypes.every((type) => artifacts.some((artifact) => artifact.artifact_type === type));
    const title = stringValue(value.title);
    const artifactType = stringValue(value.artifact_type ?? value.artifactType);
    if (title || artifactType) return artifacts.some((artifact) => (!title || artifact.title === title) && (!artifactType || artifact.artifact_type === artifactType));
    return verificationPassed;
  }
  if (!Array.isArray(required) || required.length === 0) return false;
  return required.every((item) => {
    if (typeof item === "string") {
      if (item.startsWith("proposal:")) return proposals.some((proposal) => proposal.proposal_type === item.slice(9));
      if (item.startsWith("file:")) return verificationPassed;
      return artifacts.some((artifact) => artifact.title === item);
    }
    const value = recordValue(item);
    const type = stringValue(value.type ?? value.verifier_type ?? value.kind);
    if (type === "artifact_exists") return artifacts.some((artifact) => (!stringValue(value.title) || artifact.title === value.title) && (!stringValue(value.artifact_type) || artifact.artifact_type === value.artifact_type));
    if (type === "proposal_created") return proposals.some((proposal) => !stringValue(value.proposal_type) || proposal.proposal_type === value.proposal_type);
    return verificationPassed;
  });
}

function hasRequiredOutputs(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(recordValue(value)).length > 0);
}

function isNonOutputNode(kind: string): boolean {
  return kind === "approval_checkpoint" || kind === "integration";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
