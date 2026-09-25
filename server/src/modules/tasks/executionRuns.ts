/**
 * The Runs that do a Task's work: an Agent Run allowed to write, in an
 * execution role. `planning`, `review` and `merge` Runs are not execution
 * (`architecture/PROJECT_WORK.md`): a plan or a review changes nothing on the
 * Task branch, and a `merge` Run — a done Task's conflict resolution — works
 * for the merge, not the Task. A read-only Run holds no lease and leaves
 * nothing behind.
 *
 * Everything that reasons about "the Task's execution Runs on a Location" —
 * which Locations a done Task merges into, whose contract the merge verifies
 * again, which Agent resolves its conflict, who authored the Task commit —
 * joins `task_runs` to `runs` and filters with this, so they never disagree.
 */
export function executionRunSql(taskRuns = "tr", runs = "r"): string {
  return `${taskRuns}.role NOT IN ('planning', 'review', 'merge')
      AND ${runs}.run_type = 'agent'
      AND ${runs}.required_sandbox_level <> 'read_only'`;
}

/**
 * SQL: a Run that started and has not ended — it holds what it works in. A
 * failed Run a supervisor holds for review has ended: it was settled, and the
 * person deciding on it must not hold the Task. Whether a `queued` Run counts
 * is the caller's: one resuming (`started_at` set) has started; one nobody
 * dispatched has not.
 */
export function runInProgressSql(runs = "r"): string {
  return `(${runs}.status IN ('running', 'cancelling', 'waiting_for_dependency')
      OR (${runs}.status = 'waiting_for_review' AND COALESCE(${runs}.error_json->>'supervisor_review', 'false') <> 'true'))`;
}
