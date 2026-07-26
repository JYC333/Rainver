import type { Queryable } from "../routeUtils/common";

export interface ProjectChatActionPreview {
  action_id: string;
  tool_call_id?: string | null;
  status: "proposed" | "auto_applied" | "completed" | "failed";
  proposal_id?: string | null;
  proposal_type?: string | null;
  title?: string | null;
  summary?: string | null;
  risk_level?: string | null;
  scope?: Record<string, unknown> | null;
}

interface ProposalPreviewRow {
  id: string;
  proposal_type: string;
  title: string;
  status: string;
  risk_level: string;
  payload_json: Record<string, unknown>;
  action_idempotency_key: string | null;
}

interface ActionEventRow {
  status: string;
  metadata_json: Record<string, unknown> | null;
}

export async function loadProjectChatActionPreviews(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<ProjectChatActionPreview[]> {
  const [proposalRows, eventRows] = await Promise.all([
    db.query<ProposalPreviewRow>(
      `SELECT id, proposal_type, title, status, risk_level, payload_json, action_idempotency_key
         FROM proposals
        WHERE space_id = $1 AND created_by_run_id = $2
        ORDER BY created_at`,
      [spaceId, runId],
    ),
    db.query<ActionEventRow>(
      `SELECT status, metadata_json
         FROM run_events
        WHERE space_id = $1 AND run_id = $2 AND event_type = 'action_completed'
        ORDER BY event_index`,
      [spaceId, runId],
    ),
  ]);

  const proposalCallIds = new Set(
    proposalRows.rows.flatMap((row) => row.action_idempotency_key ? [row.action_idempotency_key] : []),
  );
  const proposals: ProjectChatActionPreview[] = proposalRows.rows.map((row) => ({
    action_id: typeof row.payload_json?.action_id === "string" ? row.payload_json.action_id : row.proposal_type,
    tool_call_id: row.action_idempotency_key,
    status: row.status === "pending" ? "proposed" : row.status === "accepted" ? "auto_applied" : "failed",
    proposal_id: row.id,
    proposal_type: row.proposal_type,
    title: row.title,
    summary: null,
    risk_level: row.risk_level,
    scope: typeof row.payload_json?.project_id === "string" ? { project_id: row.payload_json.project_id } : null,
  }));
  const completed: ProjectChatActionPreview[] = eventRows.rows.flatMap((row) => {
    const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
    const actionId = typeof metadata.action_id === "string" ? metadata.action_id : null;
    const callId = typeof metadata.tool_call_id === "string" ? metadata.tool_call_id : null;
    if (!actionId || (callId && proposalCallIds.has(callId))) return [];
    const failed = row.status === "failed" || metadata.ok === false;
    return [{
      action_id: actionId,
      tool_call_id: callId,
      status: failed ? "failed" : "completed",
      title: actionId,
      summary: failed && typeof metadata.error_code === "string" ? metadata.error_code : null,
      scope: null,
    }];
  });
  return [...proposals, ...completed];
}
