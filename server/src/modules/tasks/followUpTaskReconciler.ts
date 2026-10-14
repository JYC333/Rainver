import type { ServerConfig } from "../../config.js";
import { ATTENDED_TRIGGER_ORIGINS } from "../policy/decisionCore.js";
import { PgProposalApplyService } from "../proposals/applyService.js";
import { runFinalizationReconcilerRegistry } from "../runs/finalizationReconcilerRegistry.js";
import { effectiveRunTrigger } from "../systemActions/effectiveRunTrigger.js";
import type { Queryable, RunRecord } from "../runs/runRepositoryTypes.js";
import { withDedicatedSessionAdvisoryLock } from "../../db/advisoryLock.js";
import { countTasksCreatedInTurn, TASK_FAN_OUT_PER_TURN, turnFanOutLockKey } from "./turnFanOut.js";

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
 * fails verification has them rejected. Do not create the Task before the
 * run succeeds. That would put work on the Board for a run the system has
 * already decided never happened. The proposal is always drafted — carrying
 * the run's context taint, its egress requirement and its preview flag — and
 * this applies it once the run has actually succeeded, through the same
 * accept path a person's click uses.
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
 * where it was. Do not drop it or move it when the accept refuses.
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
  const { origin } = await effectiveRunTrigger(db, run);
  if (!ATTENDED_TRIGGER_ORIGINS.has(origin)) return;

  // Only into the Run's own Project. An output may name any Project in the
  // Space, and `task.create` refuses exactly that — "a Task can only be
  // created in this Run's own Project" — because otherwise an Agent writes
  // into a Project the person it acts for is not working in. Here the
  // foreign-Project follow-up is not refused, it is left as a card: the
  // person decides. Do not turn the card into a refusal.
  // The turn's one fan-out ceiling covers these too: a follow-up is a Task
  // the turn asked for. Held for the whole pass, the lock `task.create` takes
  // as well, so a repeated or concurrent settlement cannot count the same
  // room twice. What does not fit stays a pending card for the person — not
  // dropped, and not queued to apply itself later.
  await withDedicatedSessionAdvisoryLock(db, turnFanOutLockKey(run.id), async (locked) => {
    const pending = await locked.query<{ id: string }>(
      `SELECT id FROM proposals
        WHERE space_id = $1 AND created_by_run_id = $2
          AND proposal_type = 'follow_up_task' AND status = 'pending' AND preview = false
          AND (project_id IS NULL OR project_id IS NOT DISTINCT FROM $3)
        ORDER BY created_at ASC, id ASC`,
      [run.space_id, run.id, run.project_id],
    );
    const allowance = Math.max(0, TASK_FAN_OUT_PER_TURN - await countTasksCreatedInTurn(locked, run.space_id, run.id));
    await acceptFollowUps(config, run, pending.rows.slice(0, allowance));
  });
}

async function acceptFollowUps(config: ServerConfig, run: RunRecord, pending: Array<{ id: string }>): Promise<void> {
  if (pending.length === 0 || !run.instructed_by_user_id) return;

  const service = PgProposalApplyService.fromConfig(config);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id };
  for (const row of pending) {
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
