import type { Queryable } from "../routeUtils/common.js";

export interface ProjectChatActionPreview {
  action_id: string;
  tool_call_id?: string | null;
  status: "proposed" | "auto_applied" | "completed" | "failed" | "rejected";
  /** Set when one named person decides this and nobody else may — see above. */
  decidable_by_user_id?: string | null;
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
  created_by_run_id: string;
}

interface ActionEventRow {
  run_id: string;
  status: string;
  metadata_json: Record<string, unknown> | null;
}

/**
 * The cards a turn's proposals render as.
 *
 * A proposal only one person may decide — an Agent's persona, which is its
 * owner's alone by identity rather than by role
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §5) —
 * carries `decidable_by_user_id`. Shared Room messages never persist those
 * previews: the Room read projection loads them from the proposal authority
 * for the current viewer. This keeps the proposed text out of a shared row
 * while still giving the owner the in-conversation decision card.
 */
export async function loadProjectChatActionPreviews(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<ProjectChatActionPreview[]> {
  return (await loadChatActionPreviewsByRunIds(db, spaceId, [runId])).get(runId) ?? [];
}

/** Two queries for a whole transcript page, rather than two per message. */
export async function loadChatActionPreviewsByRunIds(
  db: Queryable,
  spaceId: string,
  runIds: readonly string[],
): Promise<Map<string, ProjectChatActionPreview[]>> {
  const uniqueRunIds = [...new Set(runIds.filter(Boolean))];
  const byRun = new Map<string, ProjectChatActionPreview[]>(
    uniqueRunIds.map((runId) => [runId, []]),
  );
  if (uniqueRunIds.length === 0) return byRun;
  const [proposalRows, eventRows] = await Promise.all([
    db.query<ProposalPreviewRow>(
      `SELECT id, proposal_type, title, status, risk_level, payload_json,
              action_idempotency_key, created_by_run_id
         FROM proposals
        WHERE space_id = $1 AND created_by_run_id = ANY($2::varchar[])
        ORDER BY created_at`,
      [spaceId, uniqueRunIds],
    ),
    db.query<ActionEventRow>(
      `SELECT run_id, status, metadata_json
         FROM run_events
        WHERE space_id = $1 AND run_id = ANY($2::varchar[]) AND event_type = 'action_completed'
        ORDER BY run_id, event_index`,
      [spaceId, uniqueRunIds],
    ),
  ]);

  const proposalCallIds = new Map<string, Set<string>>();
  for (const row of proposalRows.rows) {
    const callIds = proposalCallIds.get(row.created_by_run_id) ?? new Set<string>();
    if (row.action_idempotency_key) callIds.add(row.action_idempotency_key);
    proposalCallIds.set(row.created_by_run_id, callIds);
    byRun.get(row.created_by_run_id)?.push({
      action_id: typeof row.payload_json?.action_id === "string" ? row.payload_json.action_id : row.proposal_type,
      tool_call_id: row.action_idempotency_key,
      status: row.status === "pending" ? "proposed" : row.status === "accepted" ? "auto_applied" : row.status === "rejected" ? "rejected" : "failed",
      proposal_id: row.id,
      proposal_type: row.proposal_type,
      title: row.title,
      summary: null,
      risk_level: row.risk_level,
      scope: typeof row.payload_json?.project_id === "string" ? { project_id: row.payload_json.project_id } : null,
      decidable_by_user_id: typeof row.payload_json?.required_owner_user_id === "string"
        ? row.payload_json.required_owner_user_id
        : null,
    });
  }
  for (const row of eventRows.rows) {
    const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
    const actionId = typeof metadata.action_id === "string" ? metadata.action_id : null;
    const callId = typeof metadata.tool_call_id === "string" ? metadata.tool_call_id : null;
    if (!actionId || (callId && proposalCallIds.get(row.run_id)?.has(callId))) continue;
    const failed = row.status === "failed" || metadata.ok === false;
    byRun.get(row.run_id)?.push({
      action_id: actionId,
      tool_call_id: callId,
      status: failed ? "failed" : "completed",
      // A completed action never carries this: it is a record of what ran, not
      // a decision anyone is waiting on.
      decidable_by_user_id: null,
      title: actionId,
      // The reason before the code: "No active Question Thread has id …" is
      // something a person can act on; "system_action_failed" is not.
      summary: !failed
        ? null
        : typeof metadata.error_message === "string" && metadata.error_message
          ? metadata.error_message
          : typeof metadata.error_code === "string" ? metadata.error_code : null,
      scope: null,
    });
  }
  return byRun;
}

/** The projection boundary for a preview whose decision authority is personal. */
export function actionPreviewsForViewer(
  previews: readonly ProjectChatActionPreview[],
  viewerUserId: string,
): ProjectChatActionPreview[] {
  return previews.filter((preview) =>
    !preview.decidable_by_user_id || preview.decidable_by_user_id === viewerUserId);
}

/** What is safe to snapshot into a message shared by every Room reader. */
export function sharedActionPreviews(
  previews: readonly ProjectChatActionPreview[],
): ProjectChatActionPreview[] {
  return previews.filter((preview) => !preview.decidable_by_user_id);
}
