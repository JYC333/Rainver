import type { HostTaskWorkspace, LaunchWorkspace } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";
import { sharedHostConnectionRegistry, type HostConnectionRegistry } from "../hosts/connectionRegistry.js";
import { enqueueTaskRunSettleRetry } from "../hosts/taskBranchJobs.js";
import { taskBranchRequestRetryable } from "../hosts/taskBranchRequests.js";
import { agentGitIdentity } from "./agentGitIdentity.js";
import { enqueueLateTaskMerge } from "../hosts/taskMerges.js";
import { redactEvidenceText } from "./evidenceRedaction.js";

/**
 * Ends a host Task Run on its Task branch (ADR 0016 §11).
 *
 * After the Run's verification — which reads the Task worktree — the daemon
 * is asked to commit everything the Run left since its start commit as one
 * system-written commit on `rainver/task-<task_id>` and remove the worktree.
 * The commit is the Agent's (author and committer), unsigned, and its message
 * says which Task and Run it is and who asked for the work, so `git log` on
 * the branch reads as the Task's history without Rainver open.
 *
 * A settle that fails is recorded, never a Run failure. One the host did not
 * answer is retried by a durable `task_run_settle` job (`hosts/taskBranchJobs.ts`),
 * which the Task's next Run waits for; one the host refused leaves the change
 * in the worktree, where the next Run starts from it and the daemon's sweep
 * commits it if no Run comes.
 */
export interface TaskRunSettlementInput {
  run: {
    id: string;
    space_id: string;
    agent_id: string | null;
    /** Who asked for the work: the instructing person, else the Run's owner. */
    instructed_by_user_id?: string | null;
    owner_user_id?: string | null;
  };
  taskId: string;
  hostId: string;
  workspace: HostTaskWorkspace;
  /** The Run's terminal outcome as it will be published; a failed Run's partial work is settled too. */
  outcome: "succeeded" | "failed" | "degraded" | "cancelled" | "orphaned";
  /** What the Agent said last; its head is the commit body. */
  summary: string;
}

/** What the Run records as `output_json.result.task_branch`. */
export interface TaskBranchRecord {
  branch: string | null;
  /** Null when the Run changed nothing, or the settle failed. */
  commit: string | null;
  error: string | null;
  /** The host did not answer; a `task_run_settle` job retries and rewrites this record. */
  retrying?: boolean;
}

export interface TaskRunSettlerPort {
  settle(input: TaskRunSettlementInput): Promise<TaskBranchRecord>;
}

const SUMMARY_MAX_LINES = 20;
const SUMMARY_MAX_CHARS = 2000;

export class PgTaskRunSettler implements TaskRunSettlerPort {
  constructor(
    private readonly db: Queryable,
    private readonly registry: HostConnectionRegistry = sharedHostConnectionRegistry,
  ) {}

  static fromConfig(config: ServerConfig): PgTaskRunSettler | undefined {
    return config.databaseUrl ? new PgTaskRunSettler(getDbPool(config.databaseUrl)) : undefined;
  }

  async settle(input: TaskRunSettlementInput): Promise<TaskBranchRecord> {
    const names = await this.db.query<{ task_title: string | null; agent_name: string | null; requester: string | null }>(
      `SELECT (SELECT title FROM tasks WHERE id = $1 AND space_id = $2) AS task_title,
              (SELECT name FROM agents WHERE id = $3) AS agent_name,
              (SELECT display_name FROM users WHERE id = $4) AS requester`,
      [input.taskId, input.run.space_id, input.run.agent_id, input.run.instructed_by_user_id ?? input.run.owner_user_id ?? null],
    );
    const row = names.rows[0];
    const frame = {
      workspace: input.workspace,
      run_id: input.run.id,
      author: agentGitIdentity(input.run.agent_id, row?.agent_name ?? null),
      message: taskRunCommitMessage({
        taskTitle: row?.task_title ?? null,
        taskId: input.taskId,
        runId: input.run.id,
        outcome: input.outcome,
        requester: row?.requester ?? null,
        // A commit may be pushed; it gets no more of what the Agent said than
        // the Run's own stored summary does.
        summary: redactEvidenceText(input.summary) ?? "",
      }),
    };
    const reply = await this.registry.requestTaskBranch(input.hostId, "task_run_settle", frame);
    if (reply.ok) {
      if (reply.commit) await this.mergeIfAlreadyDone(input);
      return { branch: reply.branch, commit: reply.commit, error: null };
    }
    const error = reply.error ?? "task_run_settle_failed";
    if (!taskBranchRequestRetryable(reply.error)) return { branch: reply.branch, commit: null, error };
    await enqueueTaskRunSettleRetry(this.db, {
      spaceId: input.run.space_id,
      userId: input.run.instructed_by_user_id ?? input.run.owner_user_id ?? null,
      runId: input.run.id,
      taskId: input.taskId,
      hostId: input.hostId,
      frame,
    });
    return { branch: reply.branch, commit: null, error, retrying: true };
  }

  /**
   * A Run of a Task already `done` (queued before it closed, or resumed after)
   * is merged too. Its commit is on the branch whatever happens here, so a
   * failure to ask is logged, never reported as a failed settle.
   */
  private async mergeIfAlreadyDone(input: TaskRunSettlementInput): Promise<void> {
    try {
      await enqueueLateTaskMerge(this.db, {
        spaceId: input.run.space_id,
        taskId: input.taskId,
        runId: input.run.id,
        workspaceLocationId: input.workspace.workspace_location_id,
        requestedByUserId: input.run.instructed_by_user_id ?? input.run.owner_user_id ?? null,
      });
    } catch (error) {
      console.warn(`[task-merge] could not ask to merge run ${input.run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function taskRunCommitMessage(input: {
  taskTitle: string | null;
  taskId: string;
  runId: string;
  outcome: TaskRunSettlementInput["outcome"];
  requester: string | null;
  summary: string;
}): string {
  const subject = oneLine(input.taskTitle ?? "") || `Task ${input.taskId}`;
  const lines = [input.outcome === "succeeded" ? subject : `${subject} (${input.outcome} Run)`];
  const body = summaryHead(input.summary);
  if (body) lines.push("", body);
  lines.push("", `Rainver-Task: ${input.taskId}`, `Rainver-Run: ${input.runId}`);
  const requester = oneLine(input.requester ?? "");
  if (requester) lines.push(`Requested-by: ${requester}`);
  return lines.join("\n").slice(0, 16_000);
}

/** The first lines of what the Agent said, trimmed to a commit body's size. */
function summaryHead(summary: string): string {
  const lines = summary.replace(/\r\n?/g, "\n").trim().split("\n").slice(0, SUMMARY_MAX_LINES);
  const head = lines.join("\n").trimEnd();
  return head.length > SUMMARY_MAX_CHARS ? `${head.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : head;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The Task workspace a settle names, from the workspace the Run was dispatched with. */
export function taskWorkspaceFor(workspace: LaunchWorkspace | null | undefined): HostTaskWorkspace | null {
  return workspace?.kind === "location" && workspace.worktree ? { ...workspace, worktree: workspace.worktree } : null;
}
