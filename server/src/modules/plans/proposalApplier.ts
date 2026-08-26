import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { HttpError, objectValue } from "../routeUtils/common.js";
import { materializePlanGraph, evaluatePlanAtomicity } from "./graph.js";
import { PlanExecutionService } from "./executionService.js";

interface PlanReviewPayload { plan_id: string; plan_version_id: string }
interface PlanCheckpointPayload extends PlanReviewPayload { node_id: string }

export function registerPlanProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("plan_review", applyPlanReview);
  registry.register("plan_checkpoint", applyPlanCheckpoint);
}

async function applyPlanReview(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = planReviewPayload(context.proposal.payload_json);
  const result = await context.db.query<{ id: string; plan_id: string; status: string; approval_proposal_id: string | null; definition_json: unknown }>(
    `SELECT id, plan_id, status, approval_proposal_id, definition_json
       FROM plan_versions WHERE id = $1 AND plan_id = $2 AND space_id = $3 FOR UPDATE`,
    [payload.plan_version_id, payload.plan_id, context.proposal.space_id],
  );
  const version = result.rows[0];
  if (!version) throw new HttpError(404, "Plan version not found");
  if (version.status !== "pending_review" || version.approval_proposal_id !== context.proposal.id) throw new HttpError(409, "Plan version is not awaiting this review proposal");
  const atomicity = evaluatePlanAtomicity(await materializePlanGraph(version.definition_json));
  if (!atomicity.valid) throw new HttpError(409, "Plan atomicity requirements are not satisfied", { code: "plan_atomicity_violation", reasons: atomicity.reasons });
  const now = new Date().toISOString();
  await context.db.query(`UPDATE plan_versions SET status = 'approved', updated_at = $4 WHERE id = $1 AND plan_id = $2 AND space_id = $3`, [payload.plan_version_id, payload.plan_id, context.proposal.space_id, now]);
  await context.db.query(`UPDATE plans SET status = 'active', updated_at = $3 WHERE id = $1 AND space_id = $2 AND current_plan_version_id = $4`, [payload.plan_id, context.proposal.space_id, now, payload.plan_version_id]);
  await context.db.query(`UPDATE plan_nodes SET status = 'inbox', blocked_reason = NULL, approval_proposal_id = NULL, updated_at = $4 WHERE space_id = $1 AND plan_version_id = $2 AND approval_proposal_id = $3 AND status = 'blocked'`, [context.proposal.space_id, payload.plan_version_id, context.proposal.id, now]);
  return { result_type: "plan_version", result: { plan_id: payload.plan_id, plan_version_id: payload.plan_version_id, status: "approved" } };
}

async function applyPlanCheckpoint(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = planCheckpointPayload(context.proposal.payload_json);
  const result = await context.db.query<{ id: string; node_kind: string; status: string; approval_proposal_id: string | null }>(
    `SELECT n.id, n.node_kind, n.status, n.approval_proposal_id
       FROM plan_nodes n JOIN plan_versions v ON v.id = n.plan_version_id AND v.space_id = n.space_id
      WHERE n.id = $1 AND n.plan_version_id = $2 AND n.space_id = $3 AND v.plan_id = $4 FOR UPDATE`,
    [payload.node_id, payload.plan_version_id, context.proposal.space_id, payload.plan_id],
  );
  const node = result.rows[0];
  if (!node) throw new HttpError(404, "Plan checkpoint node not found");
  if (node.node_kind !== "approval_checkpoint" || node.status !== "waiting_for_review" || node.approval_proposal_id !== context.proposal.id) throw new HttpError(409, "Plan Node is not awaiting this checkpoint proposal");
  const now = new Date().toISOString();
  await context.db.query(`UPDATE plan_nodes SET status = 'done', blocked_reason = NULL, approval_proposal_id = NULL, updated_at = $4 WHERE id = $1 AND plan_version_id = $2 AND space_id = $3`, [payload.node_id, payload.plan_version_id, context.proposal.space_id, now]);
  await new PlanExecutionService(context.db).reconcile({ spaceId: context.proposal.space_id, userId: context.userId }, payload.plan_id);
  return { result_type: "plan_checkpoint", result: { plan_id: payload.plan_id, plan_version_id: payload.plan_version_id, node_id: payload.node_id, status: "completed" } };
}

function planReviewPayload(value: unknown): PlanReviewPayload {
  const payload = objectValue(value);
  return { plan_id: requiredPayloadString(payload.plan_id, "plan_id"), plan_version_id: requiredPayloadString(payload.plan_version_id, "plan_version_id") };
}

function planCheckpointPayload(value: unknown): PlanCheckpointPayload {
  const payload = objectValue(value);
  return { ...planReviewPayload(value), node_id: requiredPayloadString(payload.node_id, "node_id") };
}

function requiredPayloadString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, `${field} is required`);
  return value.trim();
}
