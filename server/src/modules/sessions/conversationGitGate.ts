import type { Queryable } from "../routeUtils/common.js";
import type { ExecutionContextRow } from "./executionContextRepository.js";

/**
 * Whether a Primary Location's HEAD that no longer matches the Conversation's
 * Git baseline is exactly where this Conversation's own most recent Run left
 * it (`last_run_git_*`, recorded from the host's `git_after` at that Run's
 * exit). Then the Conversation's own Agent moved it — a commit or a branch
 * switch it was asked to make — and the send gate advances the baseline
 * instead of asking the person to refresh. A HEAD anybody else moved matches
 * nothing and still returns the refresh-required conflict.
 *
 * Only branch and commit: readiness keeps its own comparison, and
 * uncommitted changes are never compared at all.
 */
export function headMovedByConversationRun(
  context: Partial<Pick<ExecutionContextRow, "last_run_git_branch" | "last_run_git_head">>,
  current: { branch: string | null; commit_sha: string | null },
): boolean {
  const head = context.last_run_git_head ?? null;
  return head !== null
    && current.commit_sha === head
    && (current.branch ?? null) === (context.last_run_git_branch ?? null);
}

export interface GitPosition {
  branch: string | null;
  head: string;
}

/**
 * Records a move of a Conversation's Primary Location HEAD as the
 * Conversation's own — `from` to `to`, kept as its last-Run HEAD — so the
 * send gate advances the baseline to `to` instead of refusing. Every
 * condition is about not vouching for a HEAD somebody else moved:
 *
 * - the Conversation is initialized with that Location as its Primary;
 * - it accepts `from` already — its baseline, or where its last Run left it —
 *   so the move started from a HEAD it knows; and,
 * - when the move is a Run's (`byRun`), that Run may write and is still
 *   running: a `read_only` Run holds no lease, and a late report for a
 *   finished Run is not that Run's exit any more.
 *
 * A Conversation Run's `git_after` and a done Task's fast-forward of the
 * checkout both land here. Returns whether the Conversation took the move.
 */
export async function recordConversationHeadMove(
  db: Queryable,
  input: {
    spaceId: string;
    sessionId: string;
    locationId: string;
    from: GitPosition;
    to: GitPosition;
    byRun?: string;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE conversation_execution_contexts context
        SET last_run_git_branch = $4,
            last_run_git_head = $5,
            updated_at = now()
      WHERE context.space_id = $1 AND context.session_id = $2
        AND context.state = 'initialized'
        AND context.primary_workspace_mode = 'location'
        AND context.primary_workspace_location_id = $3
        AND (
          (context.git_head = $7 AND context.git_branch IS NOT DISTINCT FROM $6)
          OR (context.last_run_git_head = $7 AND context.last_run_git_branch IS NOT DISTINCT FROM $6)
        )
        AND ($8::varchar IS NULL OR EXISTS (
          SELECT 1 FROM runs r
           WHERE r.space_id = $1 AND r.id = $8
             AND r.required_sandbox_level <> 'read_only'
             AND r.status NOT IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')
        ))`,
    [input.spaceId, input.sessionId, input.locationId, input.to.branch, input.to.head, input.from.branch, input.from.head, input.byRun ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}
