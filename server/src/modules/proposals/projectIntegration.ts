import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";
import { PgProposalRepository } from "./repository.js";

/**
 * A pending proposal is a decision waiting on a person, so it belongs in the
 * Project's attention list — on Pulse, in the shell, beside the conversation —
 * and not only in the Space-level Review page it used to be found on.
 *
 * Each row links to where the decision is made: the conversation that
 * produced it, when a Room Run did, since the proposal's card with its
 * Accept/Reject is there; otherwise the Review page filtered to the Project.
 */
const pendingProposalsAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "proposals",
  async listAttentionItems(db, identity, projectId): Promise<ProjectAttentionItem[]> {
    const page = await new PgProposalRepository(db).listVisible(identity.spaceId, identity.userId, {
      projectId,
      status: "pending",
      limit: 50,
      offset: 0,
    });
    if (page.items.length === 0) return [];
    const origins = await db.query<{ id: string; room_id: string | null; session_id: string | null }>(
      `SELECT p.id, s.room_id, s.id AS session_id
         FROM proposals p
         LEFT JOIN runs r ON r.id = p.created_by_run_id AND r.space_id = p.space_id
         LEFT JOIN sessions s ON s.id = r.session_id AND s.space_id = r.space_id
        WHERE p.space_id = $1 AND p.id = ANY ($2::varchar[])`,
      [identity.spaceId, page.items.map((item) => item.id)],
    );
    const originById = new Map(origins.rows.map((row) => [row.id, row]));
    return page.items.map((proposal): ProjectAttentionItem => {
      const origin = originById.get(String(proposal.id));
      const href = origin?.room_id && origin.session_id
        ? `/projects/${projectId}/rooms?room=${origin.room_id}&conversation=${origin.session_id}`
        : `/proposals?project_id=${projectId}`;
      return {
        // A remainder offer is a bounded pipeline asking whether to spend
        // more, not a gate on work already drafted (ADR 0017 §3/§4).
        id: `proposal:${proposal.id}`,
        attention_class: String(proposal.proposal_type) === "research_history_extend" ? "remainder" : "gate",
        project_id: projectId,
        area_kind: "proposals",
        source_type: "proposal",
        source_id: String(proposal.id),
        severity: "normal",
        title: proposal.proposed_title,
        summary: null,
        reason: `${String(proposal.proposal_type).replace(/_/g, " ")} awaiting your decision`,
        due_at: null,
        blocking_refs: [],
        action_descriptors: [{ label: "Decide", href }],
        href,
      };
    });
  },
};

export function registerProposalsProjectIntegration(): void {
  projectAttentionRegistry.replace(pendingProposalsAttentionAdapter);
}
