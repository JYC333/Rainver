import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { HttpError, objectValue } from "../routeUtils/common.js";
import { WorkflowExecutionService } from "./workflowExecutionService.js";

export function registerWorkflowExecutionProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("workflow_execution_checkpoint", applyWorkflowExecutionCheckpoint);
}

async function applyWorkflowExecutionCheckpoint(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  const executionId = required(payload.workflow_execution_id, "workflow_execution_id");
  const nodeId = required(payload.node_id, "node_id");
  const result = await context.db.query<{ id: string; status: string; approval_proposal_id: string | null }>(
    `SELECT id, status, approval_proposal_id FROM workflow_execution_nodes
      WHERE id = $1 AND execution_id = $2 AND space_id = $3 FOR UPDATE`,
    [nodeId, executionId, context.proposal.space_id],
  );
  const node = result.rows[0];
  if (!node) throw new HttpError(404, "Workflow Execution checkpoint node not found");
  if (node.status !== "waiting_for_review" || node.approval_proposal_id !== context.proposal.id) throw new HttpError(409, "Workflow Execution node is not awaiting this checkpoint proposal");
  const now = new Date().toISOString();
  // The approver is audit, recorded on the node beside the proposal's own
  // `reviewed_by`. The nodes scheduled next run as the execution's
  // responsible person, not as the approver (plan D10).
  await context.db.query(
    `UPDATE workflow_execution_nodes
        SET status = 'done', blocked_reason = NULL, approval_proposal_id = NULL,
            metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb, updated_at = $4
      WHERE id = $1 AND execution_id = $2 AND space_id = $3`,
    [nodeId, executionId, context.proposal.space_id, now,
      JSON.stringify({ approved_by_user_id: context.userId, approved_at: now, approval_proposal_id: context.proposal.id })],
  );
  await new WorkflowExecutionService(context.config).reconcile(context.db, context.proposal.space_id, executionId);
  return { result_type: "workflow_execution_checkpoint", result: { workflow_execution_id: executionId, node_id: nodeId, status: "completed" } };
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, `${field} is required`);
  return value.trim();
}
