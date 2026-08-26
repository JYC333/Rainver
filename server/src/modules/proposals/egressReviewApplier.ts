import { randomUUID } from "node:crypto";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { isContentAccessLevel } from "../access/contentAccessTypes.js";
import { parseRunContextTaint } from "../runs/contextTaint.js";
import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "./applierRegistry.js";

interface TaintedResourceRow {
  context_taint: unknown;
  owner_user_id: string | null;
  project_id: string | null;
}

export function registerEgressReviewProposalApplier(registry: ProposalApplierRegistry): void {
  registry.register("egress_review", applyEgressReview);
}

async function applyEgressReview(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};
  const resourceType = requiredString(payload.target_resource_type, "target_resource_type");
  const resourceId = requiredString(payload.target_resource_id, "target_resource_id");
  const definition = contentResourceDefinition(resourceType);
  if (!definition?.publishable || !definition.contextTaintColumn) {
    throw invalid("target resource does not support taint-reviewed publication");
  }
  if (payload.requested_visibility !== "space_shared") {
    throw invalid("egress review may only publish to space_shared");
  }
  if (!isContentAccessLevel(payload.requested_access_level)) {
    throw invalid("requested_access_level is invalid");
  }

  const resource = await context.db.query<TaintedResourceRow>(
    `SELECT ${definition.contextTaintColumn}->'context_taint' AS context_taint,
            ${definition.ownerColumn} AS owner_user_id,
            ${definition.projectColumn ?? "NULL::varchar"} AS project_id
       FROM ${definition.tableName}
      WHERE id = $1 AND space_id = $2
      LIMIT 1 FOR UPDATE`,
    [resourceId, context.proposal.space_id],
  );
  const taint = parseRunContextTaint(resource.rows[0]?.context_taint);
  if (!taint) throw invalid("target resource no longer has a valid context taint summary");
  const target = resource.rows[0]!;
  const requesterId = context.proposal.created_by_user_id;
  if (!requesterId) throw invalid("egress review is missing its requesting user");
  const requesterRole = await context.db.query<{ role: string }>(
    `SELECT role FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [context.proposal.space_id, requesterId],
  );
  if (target.owner_user_id !== requesterId && !["owner", "admin"].includes(requesterRole.rows[0]?.role ?? "")) {
    throw invalid("egress review requester no longer manages the target resource");
  }
  const requiredApprovers = taint.non_instructing_owner_user_ids;
  if (requiredApprovers.length === 0) throw invalid("target resource has no owner approval requirement");
  const declaredApprovers = stringArray(payload.required_egress_approver_user_ids);
  if (!sameSet(requiredApprovers, declaredApprovers)) {
    throw invalid("required approvers no longer match the target resource taint");
  }
  const approvals = await context.db.query<{ approver_user_id: string }>(
    `SELECT DISTINCT approver_user_id
       FROM proposal_approvals
      WHERE proposal_id = $1
        AND approval_type = 'egress_granting_user'
        AND grant_id IS NULL
        AND status = 'approved'
        AND revoked_at IS NULL`,
    [context.proposal.id],
  );
  const approved = new Set(approvals.rows.map((row) => row.approver_user_id));
  const missing = requiredApprovers.filter((userId) => !approved.has(userId));
  if (missing.length > 0) {
    const error = invalid("publication requires approval from every taint owner");
    error.statusCode = 409;
    error.detail = { code: "egress_owner_approval_required", missing_approver_user_ids: missing };
    throw error;
  }

  const projectColumn = definition.projectColumn;
  const requestedProjectId = nullableString(payload.requested_project_id);
  if (requestedProjectId !== target.project_id) {
    throw invalid("egress review cannot move content into another Project");
  }
  const now = new Date().toISOString();
  const projectUpdate = projectColumn ? `, ${projectColumn} = $5` : "";
  await context.db.query(
    `UPDATE ${definition.tableName}
        SET visibility = 'space_shared', access_level = $3, updated_at = $4${projectUpdate}
      WHERE id = $1 AND space_id = $2`,
    projectColumn
      ? [resourceId, context.proposal.space_id, payload.requested_access_level, now, requestedProjectId]
      : [resourceId, context.proposal.space_id, payload.requested_access_level, now],
  );
  await context.db.query(
    `UPDATE content_access_grants
        SET revoked_at = $4, revoked_by_user_id = $5, updated_at = $4
      WHERE space_id = $1 AND resource_type = $2 AND resource_id = $3 AND revoked_at IS NULL`,
    [context.proposal.space_id, resourceType, resourceId, now, context.userId],
  );
  const grants = requestedGrants(payload.requested_grants);
  if (grants.length > 0) {
    const active = await context.db.query<{ user_id: string }>(
      `SELECT user_id FROM space_memberships
        WHERE space_id = $1 AND user_id = ANY($2::varchar[]) AND status = 'active'`,
      [context.proposal.space_id, grants.map((grant) => grant.user_id)],
    );
    const activeIds = new Set(active.rows.map((row) => row.user_id));
    if (grants.some((grant) => !activeIds.has(grant.user_id))) {
      throw invalid("every publication grantee must remain an active Space member");
    }
  }
  for (const grant of grants) {
    await context.db.query(
      `INSERT INTO content_access_grants (
         id, space_id, resource_type, resource_id, grantee_user_id,
         granted_by_user_id, access_level, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT (space_id, resource_type, resource_id, grantee_user_id)
       DO UPDATE SET granted_by_user_id=EXCLUDED.granted_by_user_id,
                     access_level=EXCLUDED.access_level, revoked_at=NULL,
                     revoked_by_user_id=NULL, updated_at=EXCLUDED.updated_at`,
      [randomUUID(), context.proposal.space_id, resourceType, resourceId, grant.user_id, context.userId, grant.access_level, now],
    );
  }
  return {
    result_type: "egress_review",
    result: { resource_type: resourceType, resource_id: resourceId, visibility: "space_shared" },
  };
}

function invalid(message: string): Error & { statusCode: number; detail: unknown } {
  return Object.assign(new Error(message), { statusCode: 422, detail: message });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(`${name} is required`);
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw invalid("requested_project_id is invalid");
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw invalid("required_egress_approver_user_ids is invalid");
  }
  return [...new Set(value as string[])].sort();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\0") === [...new Set(right)].sort().join("\0");
}

function requestedGrants(value: unknown): Array<{ user_id: string; access_level: "full" | "summary" }> {
  if (!Array.isArray(value)) throw invalid("requested_grants is invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid("requested_grants is invalid");
    const row = item as Record<string, unknown>;
    if (typeof row.user_id !== "string" || !isContentAccessLevel(row.access_level)) {
      throw invalid("requested_grants is invalid");
    }
    return { user_id: row.user_id, access_level: row.access_level };
  });
}
