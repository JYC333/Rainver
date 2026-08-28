import type { ServerConfig } from "../../config.js";
import { ATTENDED_TRIGGER_ORIGINS } from "../policy/decisionCore.js";
import { PgProposalApplyService } from "../proposals/applyService.js";
import { runFinalizationReconcilerRegistry } from "../runs/finalizationReconcilerRegistry.js";
import { effectiveTriggerOrigin } from "../systemActions/systemActionDispatcher.js";
import type { Queryable, RunRecord } from "../runs/runRepositoryTypes.js";

/**
 * The follow-up Task a Run asks for at the end of its work
 * ([ADR 0017](../../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md)
 * §2).
 *
 * Creating a Task inside a Project the person is already working in commits
 * nobody to anything, is on the Board the moment it exists, and is closed in
 * one action — so a person who just asked for the work does not approve it a
 * second time. What they get instead is the Task.
 *
 * It runs here, at finalization, rather than at materialization, because
 * everything that makes the output provisional is decided after the output is
 * read: a run's proposals are `staged` until it terminates, and a run that
 * fails verification has them rejected. Creating the Task earlier put work on
 * the Board that the system had already decided never happened. So the
 * proposal is always drafted — carrying the run's context taint, its egress
 * requirement and its preview flag — and this applies it once the run has
 * actually succeeded, through the same accept path a person's click uses.
 *
 * There is no cap on how many it applies for one Run. The sibling surface
 * bounds itself (`inquiry.create_thread`, five per turn) because a Thread is
 * a question someone must answer; a follow-up Task is a line on a Board that
 * is deleted in one action, and capping here would mean silently leaving some
 * of a Run's own output behind.
 *
 * It applies nothing when a person did not ask (an unattended origin keeps
 * the card, because a Task nobody asked for is a commitment made on the
 * Project's behalf), and nothing when the accept itself refuses — an egress
 * owner has not approved, or the instructing person's role cannot apply a
 * medium-risk proposal. In every one of those cases the card stays exactly
 * where it was, which is the answer this replaces, not a worse one.
 */
export function registerFollowUpTaskFinalizationReconciler(config: ServerConfig): void {
  runFinalizationReconcilerRegistry.register("follow_up_task", {
    reconcile: (db, run) => applyAttendedFollowUpTasks(config, db, run),
  }, "tasks");
}

export async function applyAttendedFollowUpTasks(
  config: ServerConfig,
  db: Queryable,
  run: RunRecord,
): Promise<void> {
  if (!config.databaseUrl || !run.instructed_by_user_id || run.mode === "dry_run") return;
  const origin = await effectiveTriggerOrigin({ databaseUrl: config.databaseUrl }, run);
  if (!ATTENDED_TRIGGER_ORIGINS.has(origin)) return;

  // Only into the Run's own Project. An output may name any Project in the
  // Space, and `task.create` refuses exactly that — "a Task can only be
  // created in this Run's own Project" — because otherwise an Agent writes
  // into a Project the person it acts for is not working in. Here the
  // foreign-Project follow-up is not refused, it is left as a card: the
  // person decides, which is what the card is for.
  const pending = await db.query<{ id: string }>(
    `SELECT id FROM proposals
      WHERE space_id = $1 AND created_by_run_id = $2
        AND proposal_type = 'follow_up_task' AND status = 'pending' AND preview = false
        AND (project_id IS NULL OR project_id IS NOT DISTINCT FROM $3)`,
    [run.space_id, run.id, run.project_id],
  );
  if (pending.rows.length === 0) return;

  const service = PgProposalApplyService.fromConfig(config);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id };
  for (const row of pending.rows) {
    try {
      await service.accept(row.id, identity);
    } catch (error) {
      // A refusal is a card left standing, not a failed Run: the person still
      // has the follow-up in front of them, with the reason recorded in the
      // policy audit the accept wrote.
      process.stderr.write(
        `[tasks] follow-up Task ${row.id} stayed pending: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
}
