import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import { PgProposalApplyService } from "./applyService.js";

/**
 * A person deciding, in words, a proposal this conversation produced.
 *
 * Every write an Agent wants to make to the Project's durable records goes
 * through a proposal, and every proposal is decided by a person (B10). That
 * stays true here: the person decides, in their own turn, and the Agent
 * carries the decision — the same approval as pressing the button beside the
 * proposal, recorded against the same person. Two things make it safe to
 * carry:
 *
 * - **Origin.** The policy rule refuses this action on any trigger origin but
 *   `manual`, so nothing an Agent does on its own initiative — a scheduled
 *   wake-up, a delegation — can reach it.
 * - **Reach.** Only a proposal created by a Run of this same conversation can
 *   be decided from it. The person is looking at the thing they are deciding;
 *   a proposal from elsewhere is decided where it was made.
 */
export function registerProposalDecisionExecutor(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  /** The pending Proposals of *this* conversation, which is the only set
   *  proposal.decide will act on — so the read and the write agree on reach. */
  const listPendingHere = async (): Promise<Array<{ proposal_id: string; proposal_type: string; title: string }>> => {
    if (!run.session_id) return [];
    const pool = getDbPool(config.databaseUrl!);
    const rows = await pool.query<{ id: string; proposal_type: string; title: string }>(
      `SELECT p.id, p.proposal_type, p.title
         FROM proposals p
         JOIN runs r ON r.id = p.created_by_run_id AND r.space_id = p.space_id
        WHERE p.space_id = $1 AND r.session_id = $2 AND p.status = 'pending'
        ORDER BY p.created_at`,
      [run.space_id, run.session_id],
    );
    return rows.rows.map((row) => ({ proposal_id: row.id, proposal_type: row.proposal_type, title: row.title }));
  };

  executors.set("proposal.list_pending" as SystemActionId, async () => {
    if (!run.session_id) throw new HttpError(422, "Only a conversation has proposals of its own");
    const proposals = await listPendingHere();
    return {
      modelResult: { ok: true, tool: "proposal.list_pending", proposals },
      summary: { tool_name: "proposal.list_pending", ok: true, count: proposals.length },
    };
  });

  executors.set("proposal.decide" as SystemActionId, async (input) => {
    const body = input as { proposal_id: string; decision: "accept" | "reject" };
    const userId = run.instructed_by_user_id;
    if (!userId) throw new HttpError(422, "This Run acts for nobody, so it cannot carry a decision");
    if (!run.session_id) throw new HttpError(422, "Only a conversation can decide its own proposals");
    const pool = getDbPool(config.databaseUrl!);

    const origin = await pool.query<{ session_id: string | null; status: string; project_id: string | null }>(
      `SELECT r.session_id, p.status, p.project_id
         FROM proposals p
         LEFT JOIN runs r ON r.id = p.created_by_run_id AND r.space_id = p.space_id
        WHERE p.space_id = $1 AND p.id = $2`,
      [run.space_id, body.proposal_id],
    );
    const row = origin.rows[0];
    if (!row || row.session_id !== run.session_id) {
      // An id this conversation never produced is almost always one the model
      // composed. Answer with the ids it may actually decide.
      const pending = await listPendingHere();
      throw new HttpError(404, pending.length === 0
        ? `No proposal in this conversation has id '${body.proposal_id}', and this conversation has nothing awaiting a decision.`
        : `No proposal in this conversation has id '${body.proposal_id}'. Use one of these ids exactly: ${pending.map((item) => `${item.proposal_id} — ${item.title}`).join("; ")}`);
    }
    if (row.status !== "pending") {
      throw new HttpError(409, `That proposal is already ${row.status}`);
    }

    const apply = PgProposalApplyService.fromConfig(config);
    const identity = { spaceId: run.space_id, userId };
    const result = body.decision === "accept"
      ? await apply.accept(body.proposal_id, identity)
      : await apply.reject(body.proposal_id, identity);
    if (!result) throw new HttpError(409, "That proposal was decided by someone else first");
    return {
      proposal_id: body.proposal_id,
      status: body.decision === "accept" ? "accepted" : "rejected",
      decided_by: userId,
      via: "room_instruction",
    };
  });
}
