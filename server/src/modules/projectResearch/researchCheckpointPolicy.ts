import type { Queryable } from "../routeUtils/common.js";

/**
 * Which research checkpoints still stop the workflow, and why.
 *
 * User dogfooding verdict (2026-08-20): research checkpoints never changed a
 * decision — they were rubber-stamp approved every time — so as blocking gates
 * they only interrupted. The reform makes them informational by
 * default: the checkpoint row is still written, because it is the durable
 * record of what the machine concluded at that point, but the workflow
 * continues and the Room gets a report instead of a permission request.
 *
 * Two exceptions survive, for reasons that are not "a human might want to
 * look":
 *
 * - `manuscript_gate` blocks because its output is external-facing and
 *   high-stakes. Nothing downstream can un-send a manuscript.
 * - `screening_gate` blocks *conditionally* — see `screeningExceedsAutoBudget`.
 *   Auto-continuing is safe for an ordinary corpus and unsafe for an enormous
 *   one, so the condition is size, not type.
 *
 * `idea_review`, `integrity_gate`, and `review_gate` are records only.
 */
export const BLOCKING_CHECKPOINT_TYPES: ReadonlySet<string> = new Set(["manuscript_gate"]);

/**
 * How large a screened corpus may be and still flow into synthesis with no
 * human in the loop.
 *
 * This is the budget half of the reform. Removing the gate removes the only
 * place a user saw "N papers matched" before paying for a synthesis over all
 * of them, so the protection has to move from a prompt to a limit: under it,
 * the operation continues unattended; over it, the operation stops and says
 * why, which is a report the user acts on rather than a question they answer
 * on every ordinary run.
 *
 * It is deliberately not the acquisition limit (`history.max_items`, default
 * 10_000): that caps how much material is *collected*, which is cheap, while
 * this caps how much reaches a synthesis model, which is not.
 */
export const SCREENING_AUTO_CONTINUE_CORPUS_LIMIT = 200;

export function screeningExceedsAutoBudget(counts: { relevant: number; maybe: number }): boolean {
  return counts.relevant + counts.maybe > SCREENING_AUTO_CONTINUE_CORPUS_LIMIT;
}

/**
 * Whether a checkpoint type blocks *unconditionally*. This deliberately does
 * not answer the screening question: `screening_gate` blocks on corpus size,
 * and an earlier signature that took the counts as an optional context bag
 * failed open — a caller that forgot to thread the counts through got "does
 * not block" and disabled the budget guard silently. The screening call site
 * must combine this with `screeningExceedsAutoBudget(counts)` explicitly, so
 * forgetting the counts is a visible omission rather than a quiet false.
 */
export function checkpointBlocks(checkpointType: string): boolean {
  return BLOCKING_CHECKPOINT_TYPES.has(checkpointType);
}

/**
 * Records an `idea_review` checkpoint outcome for both synthesis paths
 * (`SynthesisCoordinator.persistCompleted` and `synthesisOnlyExecution`):
 * when the type does not gate — the current policy — the checkpoint is waived
 * in place, and `reconcileIdeaReviewStage` carries the operation onward on
 * its next tick. One implementation so the two paths cannot drift.
 * Returns whether the checkpoint gates, for the caller's state projection.
 */
export async function recordInformationalIdeaReview(
  db: Queryable,
  spaceId: string,
  checkpointId: string,
): Promise<boolean> {
  const gated = checkpointBlocks("idea_review");
  if (!gated) {
    await waiveCheckpointAutomatically(
      db,
      spaceId,
      checkpointId,
      "Idea review is informational; the operation continued without waiting for a decision.",
    );
  }
  return gated;
}

/**
 * Records that a checkpoint was passed without a human decision.
 *
 * `waived` already means "this gate did not stop the work" and needs no
 * migration; leaving `user_decision` NULL is what separates an automatic
 * waiver from one a person granted, so an audit of the row can still tell
 * whether anybody looked. `decided_by_user_id` stays NULL for the same
 * reason — attributing an automatic advance to the project writer whose
 * identity the pass happens to run under would be a false record.
 */
export async function waiveCheckpointAutomatically(
  db: Queryable,
  spaceId: string,
  checkpointId: string,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `UPDATE project_research_checkpoints
        SET status='waived', decision_reason=$3, decided_at=$4, updated_at=$4
      WHERE id=$1 AND space_id=$2 AND status='pending'`,
    [checkpointId, spaceId, reason, now],
  );
}
