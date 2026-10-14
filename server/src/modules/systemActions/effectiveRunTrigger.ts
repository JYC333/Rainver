import type { Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";

/**
 * Who set this Run going, and under what origin: the answer every origin
 * gate asks of a Run — the unattended-write rule (`ruleUnattendedProjectWrite`),
 * ADR 0003 §5's persona rule, credential spend, system-action policy, the
 * update drain, follow-up Task application. They all read it here, so they
 * cannot disagree about the same Run.
 *
 * The answer lives on the Run's root, reached through two kinds of hop:
 *
 * - **parent** — a delegated child (`delegation`), a Room recipient after the
 *   first, a workflow or Plan node, an autonomy candidate: the Run that
 *   spawned it, up to the Run nothing spawned;
 * - **cause** — a `continuation`, the turn the system started to report on
 *   earlier work (a delegated result, a research outcome, a discussion wave):
 *   the Run whose outcome it reports on (`runs.cause_run_id`).
 *
 * Only a verified chain inherits. A continuation the server recorded no cause
 * for — its cause could not be identified, or it ran past the budget its
 * cause's turn was given — is unattended in its own right. A chain that
 * breaks (a missing Run, a cycle, more hops than any real chain has) is
 * unverifiable and never falls back to `manual`. A system event therefore
 * cannot pass itself off as a person's new instruction: only a Run a person
 * started (`manual`, stamped by the server) is an attended root.
 */
export interface EffectiveRunTrigger {
  /** The root's `trigger_origin`; `continuation` or `unverified` when nothing verifiable stands behind it. */
  origin: string;
  /**
   * The person responsible for this Run: who asked in the root turn, or who
   * set the unattended work up (an Automation's owner, an autonomy tick's
   * owner). Null when no verifiable person stands behind it, which ADR 0003
   * §5 reads as "not the Agent's owner".
   */
  instructedByUserId: string | null;
  /** The root Run when the chain verified to one; null otherwise. */
  rootRunId: string | null;
  /** Continuation hops between this Run and its root, kept for audit. */
  continuationHops: number;
}

/** A broken chain: nothing verifiable stands behind the Run. Never attended. */
export const UNVERIFIED_LINEAGE_ORIGIN = "unverified";

/** Far beyond any real chain (delegation depth 1, a handful of waves); a guard, not a budget. */
const MAX_LINEAGE_DEPTH = 32;

type LineageRun = Pick<RunRecord, "id" | "space_id" | "trigger_origin"> & {
  instructed_by_user_id?: string | null;
  parent_run_id?: string | null;
};

interface LineageRow {
  id: string;
  trigger_origin: string;
  instructed_by_user_id: string | null;
  parent_run_id: string | null;
  cause_run_id: string | null;
  depth: number;
}

/**
 * Its own file rather than the dispatcher's, so the memory and policy modules
 * can ask the same question without importing the dispatcher that imports them.
 */
export async function effectiveRunTrigger(db: Queryable, run: LineageRun): Promise<EffectiveRunTrigger> {
  // A delegated child always has the Run that delegated it; one without is
  // not a chain anyone can verify.
  if (run.trigger_origin === "delegation" && !run.parent_run_id) {
    return { origin: UNVERIFIED_LINEAGE_ORIGIN, instructedByUserId: null, rootRunId: null, continuationHops: 0 };
  }
  // A Run nothing spawned and nothing caused is its own root.
  if (run.trigger_origin !== "continuation" && !run.parent_run_id) {
    return {
      origin: run.trigger_origin,
      instructedByUserId: run.instructed_by_user_id ?? null,
      rootRunId: run.id,
      continuationHops: 0,
    };
  }
  // The walk starts at the first hop: the parent the caller already holds,
  // or — for a continuation, whose cause only the stored row records — the
  // Run's own row.
  const start = run.trigger_origin === "continuation" ? run.id : run.parent_run_id!;
  const chain = await db.query<LineageRow>(
    `WITH RECURSIVE chain AS (
       SELECT id, space_id, trigger_origin, instructed_by_user_id, parent_run_id, cause_run_id,
              0 AS depth, ARRAY[id]::varchar[] AS path
         FROM runs
        WHERE space_id = $1 AND id = $2
       UNION ALL
       SELECT next.id, next.space_id, next.trigger_origin, next.instructed_by_user_id,
              next.parent_run_id, next.cause_run_id, chain.depth + 1, chain.path || next.id
         FROM chain
         JOIN runs next
           ON next.space_id = chain.space_id
          AND next.id = CASE WHEN chain.trigger_origin = 'continuation' THEN chain.cause_run_id ELSE chain.parent_run_id END
        WHERE chain.depth < $3 AND NOT next.id = ANY(chain.path)
     )
     SELECT id, trigger_origin, instructed_by_user_id, parent_run_id, cause_run_id, depth
       FROM chain
      ORDER BY depth ASC`,
    [run.space_id, start, MAX_LINEAGE_DEPTH],
  );
  const rows = chain.rows;
  const top = rows.at(-1);
  const continuationHops = rows.filter((row) => row.trigger_origin === "continuation").length;
  if (!top) {
    return { origin: UNVERIFIED_LINEAGE_ORIGIN, instructedByUserId: null, rootRunId: null, continuationHops };
  }
  if (top.trigger_origin === "continuation" && !top.cause_run_id) {
    // Recorded with no cause: a report the system makes on its own account.
    return { origin: "continuation", instructedByUserId: null, rootRunId: null, continuationHops };
  }
  if (top.trigger_origin === "continuation" || top.parent_run_id) {
    // The walk stopped before a root: a Run in the chain is gone, the chain
    // loops, or it is deeper than any real one.
    return { origin: UNVERIFIED_LINEAGE_ORIGIN, instructedByUserId: null, rootRunId: null, continuationHops };
  }
  return {
    origin: top.trigger_origin,
    instructedByUserId: top.instructed_by_user_id ?? null,
    rootRunId: top.id,
    continuationHops,
  };
}
