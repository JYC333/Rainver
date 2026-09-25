import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import type { TaskMergeConflictResolver, TaskMergeRow } from "../hosts/taskMerges.js";
import { executionRunSql } from "./executionRuns.js";
import { PgTaskRepository } from "./repository.js";
import { RunBudgetExceededError } from "../runs/budgetEnforcement.js";
import { RunCreateValidationError } from "../runs/runRepositoryTypes.js";

/**
 * A merge conflict goes to the Task's Agent first (ADR 0016 §11): one
 * resolution Run, by the Agent that did the Task's
 * last execution Run, on the same Location, runtime profile and host thread —
 * so it resumes the session that knows why the Task changed what it changed —
 * working in the Task worktree as the merge left it. The merge continues
 * once the Run ends; a Run that cannot be admitted (the requester no longer
 * writes the Project, the host is not theirs, the Task's budget is spent)
 * leaves the conflict to the person.
 */
export class TaskMergeResolutionDispatcher implements TaskMergeConflictResolver {
  constructor(private readonly config: ServerConfig) {}

  async dispatch(db: Queryable, merge: TaskMergeRow, conflictedFiles: string[]): Promise<string | null> {
    const latest = (await db.query<{ agent_id: string | null; runtime_profile_id: string | null; host_task_thread_id: string | null; title: string; description: string | null; definition_of_done: string | null }>(
      `SELECT r.agent_id,
              -- A Run not routed yet carries the Profile it asked for.
              COALESCE(r.runtime_profile_id, r.requested_runtime_profile_id) AS runtime_profile_id,
              r.host_task_thread_id, t.title, t.description, t.definition_of_done
         FROM task_runs tr
         JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
         JOIN tasks t ON t.id = tr.task_id AND t.space_id = tr.space_id
        WHERE tr.space_id = $1 AND tr.task_id = $2 AND r.workspace_location_id = $3
          AND ${executionRunSql()}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1`,
      [merge.space_id, merge.task_id, merge.workspace_location_id],
    )).rows[0];
    if (!latest?.agent_id) return null;
    // The Task's host thread takes one Run at a time: while another of the
    // Task's Runs is queued on it, the resolution starts a thread of its own
    // rather than being refused.
    const threadBusy = latest.host_task_thread_id
      ? (await db.query(
        `SELECT 1 FROM runs
          WHERE space_id = $1 AND host_task_thread_id = $2
            AND status NOT IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')
          LIMIT 1`,
        [merge.space_id, latest.host_task_thread_id],
      )).rows.length > 0
      : false;
    const pool = getDbPool(this.config.databaseUrl!);
    // Inside the merge's own transaction, so the Run and the merge's move to
    // `resolving` commit together; a refused admission rolls back only itself.
    await db.query("SAVEPOINT merge_resolution");
    try {
      const runId = await new PgTaskRepository(pool).createMergeResolutionRun(
        { spaceId: merge.space_id, userId: merge.requested_by_user_id },
        merge.task_id,
        {
          mergeId: merge.id,
          workspaceLocationId: merge.workspace_location_id,
          agentId: latest.agent_id!,
          runtimeProfileId: latest.runtime_profile_id,
          threadId: threadBusy ? null : latest.host_task_thread_id,
          prompt: resolutionPrompt({
            title: latest.title,
            description: latest.description,
            definitionOfDone: latest.definition_of_done,
            mainBranch: merge.main_branch,
            conflictedFiles,
          }),
        },
        db,
      );
      await db.query("RELEASE SAVEPOINT merge_resolution");
      return runId;
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT merge_resolution");
      // Refused admission — access, the host's owner, the Task's budget, the
      // Run's shape — leaves the conflict to the person; anything else is a
      // fault the job retries.
      if (error instanceof HttpError || error instanceof RunBudgetExceededError || error instanceof RunCreateValidationError) return null;
      throw error;
    }
  }
}

/**
 * What the Agent is asked: both sides' intent and the conflicted files, and
 * the one thing it must not do — commit or move branches itself, which is the
 * merge's to do once it has checked the result.
 */
export function resolutionPrompt(input: {
  title: string;
  description: string | null;
  definitionOfDone: string | null;
  mainBranch: string | null;
  conflictedFiles: string[];
}): string {
  const main = input.mainBranch ?? "the main branch";
  const files = input.conflictedFiles.slice(0, 100);
  return [
    `This Task is done, and merging it into ${main} stopped on a conflict. Resolve it.`,
    "",
    `The Task: ${input.title}`,
    ...(input.description ? ["", input.description.slice(0, 4000)] : []),
    ...(input.definitionOfDone ? ["", `Done means: ${input.definitionOfDone.slice(0, 2000)}`] : []),
    "",
    `You are in the Task's worktree. It holds the Task's change merged onto the latest ${main}, with conflict markers where the two disagree.`,
    `The Task's side is HEAD, its single commit (\`git show HEAD\`); ${main}'s side is \`${main}\` (\`git log --oneline -20 ${main}\` shows what changed there and why).`,
    "",
    `Conflicted files${input.conflictedFiles.length > files.length ? ` (first ${files.length} of ${input.conflictedFiles.length})` : ""}:`,
    ...files.map((file) => `- ${file}`),
    "",
    "Edit each file so it keeps what both sides meant and holds no conflict marker, or delete it when the right resolution is that it goes.",
    "Only the conflicted files listed above are taken from your work; everything else stays as the merge wrote it. Do not commit, reset, stash, check out, or move or create branches: the merge reads those files as you leave them, records the result as the Task's commit, and runs the Task's checks again.",
    "When you are done, say briefly how you resolved each file.",
  ].join("\n");
}
