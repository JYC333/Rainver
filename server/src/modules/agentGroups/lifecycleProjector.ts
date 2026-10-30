import { contractWorkspaceAccess } from "../runs/contractSnapshot.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { withDbTransaction } from "../routeUtils/common.js";
import { PgRunRepository, type RunRecord } from "../runs/repository.js";
import { runOutputResult } from "../runs/orchestrationResults.js";
import { RoomService } from "../rooms/service.js";
import { agentOriginContinuation } from "../rooms/discussionService.js";
import { isRetryableRoomPostError } from "../rooms/messageQueue.js";
import { PgAgentGroupRepository, type RunDelegationRecord } from "./repository.js";
import { ROOM_DELEGATION_COMPLETION_RETRY_JOB } from "./delegationCompletionRetryJob.js";
import { runAssignedTask } from "../runs/runAssignedTask.js";
import { CONVERSATION_SERIALIZATION_WAIT_SCOPE } from "./waitScopes.js";
import { handoffTurnOf } from "./sessionHandoff.js";
import { admitAgentOriginRun, enqueueWhenTurnFree, isAgentOriginGroup } from "../rooms/quotaGate.js";
import { liveQuotaSource, type QuotaSource } from "../rooms/subscriptionLogins.js";
import {
  containsRunChangeLink,
  grantRunChangeReadTools,
  loadRunChanges,
  renderRunChangeBlock,
  type RunChange,
} from "./runChangeBlock.js";

type DelegationTerminalStatus = "succeeded" | "failed" | "cancelled";

export class AgentGroupRunLifecycleProjector {
  constructor(
    private readonly pool: Pool,
    private readonly config: ServerConfig,
    /** What the subscription quota gate reads for Agent-triggered admissions (`rooms/quotaGate.ts`). */
    private readonly quotaSource: QuotaSource = liveQuotaSource(pool),
  ) {}

  static fromConfig(config: ServerConfig): AgentGroupRunLifecycleProjector | null {
    if (!config.databaseUrl) return null;
    return new AgentGroupRunLifecycleProjector(getDbPool(config.databaseUrl), config);
  }

  async markDelegatedRunRunning(run: RunRecord): Promise<void> {
    const ids = delegationIds(run);
    if (!ids) return;
    await withDbTransaction(this.pool, async (client) => {
      const groups = new PgAgentGroupRepository(client);
      const runs = new PgRunRepository(client);
      const result = await groups.markDelegationRunning({
        space_id: run.space_id,
        delegation_id: ids.delegation_id,
        child_run_id: run.id,
      });
      if (!result.changed || !result.delegation) return;
      await appendDelegationLifecycleEvent({
        runs,
        run,
        delegation: result.delegation,
        event_type: "delegation_started",
        status: "running",
        summary: "Child run delegation started.",
      });
    });
  }

  /** Enqueue children only after their parent yields or reaches a terminal state. */
  async queueDelegatedChildren(run: RunRecord): Promise<void> {
    if (!run.run_group_id) return;
    await withDbTransaction(this.pool, async (client) => {
      const groups = new PgAgentGroupRepository(client);
      const runs = new PgRunRepository(client);
      await this.queueDelegatedChildrenInTransaction({ client, groups, runs, parent: run });
    });
  }

  async markDelegatedRunTerminal(run: RunRecord): Promise<void> {
    const ids = delegationIds(run);
    if (!ids) {
      await this.projectGroupedRunTerminalMessage(run);
      await this.queueDelegatedChildren(run);
      return;
    }
    await withDbTransaction(this.pool, async (client) => {
      const groups = new PgAgentGroupRepository(client);
      const runs = new PgRunRepository(client);
      const currentRun = await runs.getRun(run.space_id, run.id) ?? run;
      const terminalStatus = delegationStatusForRun(currentRun.status);
      if (!terminalStatus) return;
      // Only a Room turn can follow a change link (its resource tools read
      // within its conversation), so only a Room's result carries one.
      const inRoom = currentRun.run_group_id
        ? Boolean((await groups.getGroup(currentRun.space_id, currentRun.run_group_id))?.room_id)
        : false;
      const change = inRoom
        ? (await loadRunChanges(client, currentRun.space_id, [currentRun.id])).get(currentRun.id) ?? null
        : null;
      const resultSummary = delegationResultSummary(currentRun, change);
      const result = await groups.markDelegationTerminal({
        space_id: run.space_id,
        delegation_id: ids.delegation_id,
        child_run_id: run.id,
        status: terminalStatus,
        result_summary: resultSummary,
      });
      if (!result.changed || !result.delegation) return;
      await groups.createMessage({
        space_id: result.delegation.space_id,
        group_id: result.delegation.group_id,
        run_id: run.id,
        sender_actor_ref_json: {
          actor_type: "agent",
          agent_id: run.agent_id,
          run_id: run.id,
        },
        sender_agent_id: run.agent_id,
        message_type: "delegation_result",
        content: resultSummary,
        mentions_json: [{ agent_id: result.delegation.requesting_agent_id }],
        metadata_json: {
          delegation_id: result.delegation.id,
          child_run_id: run.id,
          status: terminalStatus,
        },
      });
      await appendDelegationLifecycleEvent({
        runs,
        run: currentRun,
        delegation: result.delegation,
        event_type: "delegation_completed",
        status: terminalStatus === "cancelled" ? "cancelled" : terminalStatus,
        summary: resultSummary,
      });
      // Must read before queueWaitingDependencyRunsIfReady, which resumes
      // (and thereby mutates away from waiting_for_dependency) any run
      // waiting on this one — reading after would always see zero waiting
      // runs and fire the Room notification even when a Manager that called
      // agent.wait_for_results is already being resumed for this exact
      // completion, duplicating that path.
      const waitingBeforeResume = await runs.listWaitingDependencyRunsForRun({
        space_id: currentRun.space_id,
        run_group_id: currentRun.run_group_id as string,
        dependency_run_id: currentRun.id,
      });
      await queueWaitingDependencyRunsIfReady({
        db: client,
        groups,
        runs,
        jobs: new PgJobQueueRepository(client),
        completedRun: currentRun,
        quotaSource: this.quotaSource,
      });
      await this.queueDelegatedChildrenInTransaction({ client, groups, runs, parent: currentRun });
      // With every delegated child done, the recipient serialized after the
      // one that delegated them may run.
      await queueSerializedRecipientsIfReady({
        db: client,
        groups,
        runs,
        jobs: new PgJobQueueRepository(client),
        completedRun: currentRun,
        quotaSource: this.quotaSource,
      });
      if (waitingBeforeResume.length === 0) {
        await this.notifyRoomOfDelegationCompletion({
          client,
          groups,
          run: currentRun,
          delegation: result.delegation,
          resultSummary,
          terminalStatus,
        });
      }
    });
  }

  /**
   * When the Manager replied and ended its turn without calling
   * `agent.wait_for_results`, nothing else notices this delegation finishing.
   * The caller only invokes
   * this when nothing was waiting on the completed run before
   * `queueWaitingDependencyRunsIfReady` ran — the waiting case already
   * resumes through that path and must not also get this duplicate one.
   * Wrapped in a SAVEPOINT: a failure here must never roll back the
   * delegation-terminal bookkeeping already committed above.
   */
  private async notifyRoomOfDelegationCompletion(input: {
    client: PoolClient;
    groups: PgAgentGroupRepository;
    run: RunRecord;
    delegation: RunDelegationRecord;
    resultSummary: string;
    terminalStatus: DelegationTerminalStatus;
  }): Promise<void> {
    const group = await input.groups.getGroup(input.delegation.space_id, input.delegation.group_id);
    if (!group?.room_id || !group.session_id) return;
    await input.client.query("SAVEPOINT room_delegation_continuation");
    try {
      await new RoomService(this.config, this.pool).continueAfterDomainEventInTransaction(
        input.client,
        { spaceId: group.space_id, userId: group.manager_user_id },
        group.room_id,
        group.session_id,
        {
          kind: "agent_delegation_result",
          key: input.delegation.id,
          payload: {
            instruction: input.run.instruction ?? runAssignedTask(input.run) ?? "",
            result_summary: input.resultSummary,
            status: input.terminalStatus,
          },
          // An Agent-origin turn: charged to the container the delegation
          // came from, and delegating only from what it has left.
          ...await agentOriginContinuation(input.client, group.space_id, group.id, input.delegation.id),
        },
      );
      await input.client.query("RELEASE SAVEPOINT room_delegation_continuation");
    } catch (error) {
      await input.client.query("ROLLBACK TO SAVEPOINT room_delegation_continuation").catch(() => undefined);
      await input.client.query("RELEASE SAVEPOINT room_delegation_continuation").catch(() => undefined);
      if (isRetryableRoomPostError(error)) {
        // A Room fanning out to more than one specialist without waiting
        // (within the shared container budget) routinely produces this: the first
        // delegate's notification claims the conversation's turn: the
        // second's loses the race. Losing once is not a reason to drop the
        // second specialist's result — retry it once the turn frees up.
        await new PgJobQueueRepository(input.client).enqueue({
          job_type: ROOM_DELEGATION_COMPLETION_RETRY_JOB,
          space_id: input.delegation.space_id,
          user_id: group.manager_user_id,
          payload: { delegation_id: input.delegation.id, child_run_id: input.run.id },
          scheduled_at: new Date(Date.now() + 2_000),
        });
        return;
      }
      process.stderr.write(
        `[rooms] delegation-completion continuation failed: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }

  async reconcileWaitingRun(run: RunRecord): Promise<void> {
    if (run.status !== "waiting_for_dependency" || !run.run_group_id) return;
    await withDbTransaction(this.pool, async (client) => {
      await queueWaitingDependencyRunIfReady({
        db: client,
        groups: new PgAgentGroupRepository(client),
        runs: new PgRunRepository(client),
        jobs: new PgJobQueueRepository(client),
        completedRun: run,
        waitingRun: run,
        quotaSource: this.quotaSource,
      });
    });
  }

  private async queueDelegatedChildrenInTransaction(input: {
    client: PoolClient;
    groups: PgAgentGroupRepository;
    runs: PgRunRepository;
    parent: RunRecord;
  }): Promise<void> {
    const delegations = await input.groups.listDelegationsForParent({
      space_id: input.parent.space_id,
      parent_run_id: input.parent.id,
    });
    const children = (await Promise.all(delegations
      .filter((delegation) => Boolean(delegation.child_run_id))
      .map(async (delegation) => input.runs.getRun(input.parent.space_id, delegation.child_run_id!))))
      .filter((child): child is RunRecord => Boolean(child));
    // Delegated children share the Conversation's cwd: a writer runs alone,
    // while read-only reviews (`contract.workspace_access = read`) run
    // together. The FIFO admits, in order, either the next writer once no
    // child is active, or every review at its front once no writer is active
    // — a review queued behind a writer waits for it. The terminal projector
    // calls this method again as children complete, which advances it.
    const active = children.filter((child) => ["running", "cancelling", "waiting_for_review", "waiting_for_dependency"]
      .includes(child.status));
    // A queued child that already has its job is admitted. One without — not
    // yet admitted, or held at the quota line or for the turn — is still in
    // this FIFO and is evaluated again (`admitAgentOriginRun`) when reached.
    const queued = [];
    for (const child of children) {
      if (child.status !== "queued") continue;
      if (await childAdmitted(input.client, child)) active.push(child);
      else queued.push(child);
    }
    const reads = (run: RunRecord) => contractWorkspaceAccess(run.contract_snapshot_json) === "read";
    const admit: RunRecord[] = [];
    if (active.length === 0 || active.every(reads)) {
      for (const child of queued) {
        if (!reads(child)) {
          if (active.length === 0 && admit.length === 0) admit.push(child);
          break;
        }
        admit.push(child);
      }
    }
    if (active.length > 0 || admit.length > 0) {
      for (const child of admit) await this.admitDelegatedChild(input.client, input.parent, child);
      return;
    }
    const child = queued[0];
    if (!child) {
      // A completed delegated child may have no descendants of its own. In
      // that case advance the sibling FIFO owned by its parent; descendants
      // take precedence because they still share the same Conversation cwd.
      if (input.parent.parent_run_id) {
        const owner = await input.runs.getRun(input.parent.space_id, input.parent.parent_run_id);
        if (owner) await this.queueDelegatedChildrenInTransaction({ ...input, parent: owner });
      }
      return;
    }
    await this.admitDelegatedChild(input.client, input.parent, child);
  }

  /**
   * A delegated child is an Agent-triggered turn: it waits past the
   * subscription reserve line (`rooms/quotaGate.ts`). A held child stays
   * `queued`, so the FIFO re-evaluates it on the next terminal event and the
   * minute scheduler admits it when the window resets.
   */
  private async admitDelegatedChild(client: PoolClient, parent: RunRecord, child: RunRecord): Promise<void> {
    const input = { client, parent };
    await admitAgentOriginRun(input.client, {
      spaceId: child.space_id,
      runId: child.id,
      job: {
        user_id: child.owner_user_id ?? input.parent.owner_user_id ?? null,
        agent_id: child.agent_id,
        project_folder_id: child.project_folder_id,
        payload: {
          run_id: child.id,
          run_group_id: child.run_group_id,
          delegation_id: child.delegation_id,
          parent_run_id: child.parent_run_id,
          root_run_id: child.root_run_id,
          instructed_by_agent_id: child.instructed_by_agent_id,
          trigger_origin: "delegation",
          // Host thread and resume session come from the child's own
          // `host_thread` override at execution time, not from this payload.
        },
      },
      source: this.quotaSource,
    });
  }

  private async projectGroupedRunTerminalMessage(run: RunRecord): Promise<void> {
    if (!run.run_group_id || run.delegation_id) return;
    if (!isTerminalRunStatus(run.status)) return;
    await withDbTransaction(this.pool, async (client) => {
      const groups = new PgAgentGroupRepository(client);
      const runs = new PgRunRepository(client);
      const currentRun = await runs.getRun(run.space_id, run.id) ?? run;
      if (!isTerminalRunStatus(currentRun.status)) return;
      const currentContent = handoffTurnOf(currentRun) ? null : groupedRunMessageContent(currentRun);
      if (currentContent) {
        const exists = await groups.hasAgentMessageForRun({
          space_id: currentRun.space_id,
          group_id: currentRun.run_group_id as string,
          run_id: currentRun.id,
        });
        if (!exists) {
          const parentMessageId = await groups.findTurnParentMessageIdForRun({
            space_id: currentRun.space_id,
            group_id: currentRun.run_group_id as string,
            run_id: currentRun.id,
          });
          await groups.createMessage({
            space_id: currentRun.space_id,
            group_id: currentRun.run_group_id as string,
            run_id: currentRun.id,
            parent_message_id: parentMessageId,
            sender_actor_ref_json: {
              actor_type: "agent",
              agent_id: currentRun.agent_id,
              run_id: currentRun.id,
            },
            sender_agent_id: currentRun.agent_id,
            message_type: "agent_message",
            content: currentContent,
            metadata_json: {
              projected_from_run_id: currentRun.id,
              parent_run_id: currentRun.parent_run_id,
              root_run_id: currentRun.root_run_id ?? currentRun.id,
            },
          });
        }
      }
      await queueWaitingDependencyRunsIfReady({
        db: client,
        groups,
        runs,
        jobs: new PgJobQueueRepository(client),
        completedRun: currentRun,
        quotaSource: this.quotaSource,
      });
    });
  }
}

function delegationIds(run: RunRecord): {
  delegation_id: string;
  group_id: string;
} | null {
  if (!run.delegation_id || !run.run_group_id) return null;
  return { delegation_id: run.delegation_id, group_id: run.run_group_id };
}

function delegationStatusForRun(status: string): DelegationTerminalStatus | null {
  if (status === "succeeded") return "succeeded";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "degraded" || status === "orphaned") return "failed";
  return null;
}

/**
 * The delegation result, with the child's `[Changes]` block when it changed
 * files: the list and a link, never the patch.
 */
function delegationResultSummary(run: RunRecord, change: RunChange | null = null): string {
  const summary = delegationResultText(run);
  const basis = reviewBasisLine(run);
  const withBasis = basis ? `${summary}\n\n${basis}` : summary;
  return change ? `${withBasis}\n\n${renderRunChangeBlock(change)}` : withBasis;
}

/** The version a read-only review read, so the reader of its result knows what it judged. */
function reviewBasisLine(run: RunRecord): string | null {
  const basis = recordValue(recordValue(run.output_json).review_basis);
  const head = stringValue(basis.head);
  const tree = stringValue(basis.tree);
  if (!head && !tree) return null;
  const at = [
    head ? `commit ${head.slice(0, 12)}${stringValue(basis.branch) ? ` on ${stringValue(basis.branch)}` : ""}` : null,
    tree ? `working tree ${tree.slice(0, 12)}` : null,
  ].filter(Boolean).join(", ");
  const changed = basis.changed_during_review === true
    ? " The workspace changed while it was reviewed; the review may not match the current files."
    : basis.changed_during_review === null ? " Whether the workspace changed during the review is unknown." : "";
  return `[Reviewed read-only at ${at}.${changed}]`;
}

function delegationResultText(run: RunRecord): string {
  const envelope = recordValue(run.output_json);
  const output = runOutputResult(run.output_json);
  const text = stringValue(envelope.summary)
    ?? stringValue(output.output_text)
    ?? stringValue(output.result_summary);
  if (text) return truncateResultSummary(text);

  const error = recordValue(run.error_json);
  const errorText = stringValue(error.error_text)
    ?? stringValue(error.error_message)
    ?? stringValue(run.error_message);
  if (errorText) return truncateResultSummary(errorText);

  if (run.status === "succeeded") return "Delegated run completed successfully.";
  if (run.status === "cancelled") return "Delegated run was cancelled.";
  if (run.status === "degraded") return "Delegated run completed with degraded status.";
  return "Delegated run failed.";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function groupedRunMessageContent(run: RunRecord): string | null {
  if (run.status === "failed" || run.status === "cancelled" || run.status === "orphaned") return null;
  const envelope = recordValue(run.output_json);
  const output = runOutputResult(run.output_json);
  const text = stringValue(envelope.summary)
    ?? stringValue(output.output_text)
    ?? stringValue(output.result_summary);
  return text ? truncateResultSummary(text) : null;
}

function isTerminalRunStatus(status: string): boolean {
  return status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "degraded" ||
    status === "orphaned";
}

function truncateResultSummary(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 1_997)}...`;
}

async function appendDelegationLifecycleEvent(input: {
  runs: PgRunRepository;
  run: RunRecord;
  delegation: RunDelegationRecord;
  event_type: "delegation_started" | "delegation_completed";
  status: "running" | "succeeded" | "failed" | "cancelled";
  summary: string;
}): Promise<void> {
  const metadata = {
    group_id: input.delegation.group_id,
    delegation_id: input.delegation.id,
    parent_run_id: input.delegation.parent_run_id,
    child_run_id: input.run.id,
    requesting_agent_id: input.delegation.requesting_agent_id,
    target_agent_id: input.delegation.target_agent_id,
  };
  await input.runs.appendRunEvent({
    run_id: input.run.id,
    space_id: input.run.space_id,
    event_type: input.event_type,
    status: input.status,
    summary: input.summary,
    project_folder_id: input.run.project_folder_id,
    metadata_json: metadata,
  });
  if (!input.run.root_run_id || input.run.root_run_id === input.run.id) return;
  await input.runs.appendRunEvent({
    run_id: input.run.root_run_id,
    space_id: input.run.space_id,
    event_type: input.event_type,
    status: input.status,
    summary: input.summary,
    project_folder_id: input.run.project_folder_id,
    metadata_json: metadata,
  });
}

async function queueWaitingDependencyRunsIfReady(input: {
  db: PoolClient;
  groups: PgAgentGroupRepository;
  runs: PgRunRepository;
  jobs: PgJobQueueRepository;
  completedRun: RunRecord;
  quotaSource: QuotaSource;
}): Promise<void> {
  if (!input.completedRun.run_group_id) return;
  const waitingRuns = await input.runs.listWaitingDependencyRunsForRun({
    space_id: input.completedRun.space_id,
    run_group_id: input.completedRun.run_group_id,
    dependency_run_id: input.completedRun.id,
  });
  for (const waitingRun of waitingRuns) {
    await queueWaitingDependencyRunIfReady({ ...input, waitingRun });
  }
}

/** Another Run of the group that is running or may be admitted — anything but one parked on a dependency. */
/** Whether a queued Run already has its `agent_run` job. */
async function childAdmitted(db: PoolClient, run: RunRecord): Promise<boolean> {
  const job = await db.query(
    `SELECT 1 FROM jobs
      WHERE space_id = $1 AND job_type = 'agent_run' AND payload_json->>'run_id' = $2
        AND status IN ('pending', 'claimed', 'running')
      LIMIT 1`,
    [run.space_id, run.id],
  );
  return (job.rowCount ?? 0) > 0;
}

async function groupHasRunnableRun(db: PoolClient, spaceId: string, groupId: string, exceptRunId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM runs
      WHERE space_id = $1 AND run_group_id = $2 AND id <> $3
        AND status IN ('queued', 'running', 'cancelling', 'waiting_for_review')
      LIMIT 1`,
    [spaceId, groupId, exceptRunId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Re-evaluate the group's recipients parked for conversation serialization. */
async function queueSerializedRecipientsIfReady(input: {
  db: PoolClient;
  groups: PgAgentGroupRepository;
  runs: PgRunRepository;
  jobs: PgJobQueueRepository;
  completedRun: RunRecord;
  quotaSource: QuotaSource;
}): Promise<void> {
  if (!input.completedRun.run_group_id) return;
  const waiting = await input.db.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE space_id = $1 AND run_group_id = $2 AND status = 'waiting_for_dependency'
        AND output_json->'waiting_for_results'->>'scope' = $3
      ORDER BY created_at, id`,
    [input.completedRun.space_id, input.completedRun.run_group_id, CONVERSATION_SERIALIZATION_WAIT_SCOPE],
  );
  for (const row of waiting.rows) {
    const waitingRun = await input.runs.getRun(input.completedRun.space_id, row.id);
    if (waitingRun) await queueWaitingDependencyRunIfReady({ ...input, waitingRun });
  }
}

function terminalRunResultSummary(run: RunRecord): string {
  const content = groupedRunMessageContent(run);
  if (content) return content;

  const error = recordValue(run.error_json);
  const errorText = stringValue(error.error_text)
    ?? stringValue(error.error_message)
    ?? stringValue(run.error_message);
  if (errorText) return truncateResultSummary(errorText);

  if (run.status === "succeeded") return "Run completed successfully without display output.";
  if (run.status === "cancelled") return "Run was cancelled.";
  if (run.status === "degraded") return "Run completed with degraded status.";
  return "Run failed without display output.";
}

async function queueWaitingDependencyRunIfReady(input: {
  db: PoolClient;
  groups: PgAgentGroupRepository;
  runs: PgRunRepository;
  jobs: PgJobQueueRepository;
  completedRun: RunRecord;
  waitingRun: RunRecord;
  quotaSource: QuotaSource;
}): Promise<void> {
  const waiting = waitingForResultsFromRun(input.waitingRun);
  if (!waiting || waiting.depends_on_run_ids.length === 0) return;
  const dependencyRuns: RunRecord[] = [];
  for (const runId of waiting.depends_on_run_ids) {
    const dependency = await input.runs.getRun(input.waitingRun.space_id, runId);
    if (!dependency || !isTerminalRunStatus(dependency.status)) return;
    dependencyRuns.push(dependency);
  }
  const groupId = input.waitingRun.run_group_id;
  if (!groupId) return;
  const group = await input.groups.getGroup(input.waitingRun.space_id, groupId);
  if (!group || group.status !== "active") return;

  const parentMessageId = await input.groups.findTurnParentMessageIdForRun({
    space_id: group.space_id,
    group_id: group.id,
    run_id: input.waitingRun.id,
  });
  const serialized = waiting.scope === CONVERSATION_SERIALIZATION_WAIT_SCOPE;
  // A group runs one Run at a time in the conversation's one directory: the
  // next recipient waits, too, for what the earlier ones delegated without
  // waiting. The last of those, finishing, admits it
  // (`queueSerializedRecipientsIfReady`).
  if (serialized && await groupHasRunnableRun(input.db, group.space_id, group.id, input.waitingRun.id)) return;
  // A handoff turn is this recipient's own preparation, not a reply to the
  // same message, so it is never shown back as one.
  const replies = dependencyRuns.filter((run) => !handoffTurnOf(run));
  // A handoff turn parked behind earlier recipients is not one of them: it
  // writes for the Agent's next session and is given nobody's replies.
  const handoffTurn = handoffTurnOf(input.waitingRun) !== null;
  // The first round of a debate answers independently: the replies already
  // given are withheld, and from the next round everyone reads everyone.
  const independent = serialized && await debateFirstRound(input.db, group);
  // What each earlier Run changed travels with its reply.
  // Only a Room turn can follow a change link: its resource tools are
  // registered from the turn's message and read within its conversation.
  const changes = handoffTurn || independent || !group.room_id || !group.session_id
    ? new Map<string, RunChange>()
    : await loadRunChanges(input.db, input.waitingRun.space_id, dependencyRuns.map((run) => run.id));
  const prompt = handoffTurn || independent
    ? input.waitingRun.prompt ?? ""
    : serialized
      ? serializedRecipientPrompt(input.waitingRun, replies, changes)
      : waitingContinuationPrompt(input.waitingRun, waiting, dependencyRuns, changes);
  const resumed = await input.runs.requeueWaitingDependencyRun({
    run_id: input.waitingRun.id,
    space_id: input.waitingRun.space_id,
    prompt,
    resumed_at: new Date().toISOString(),
    model_override_json: null,
  });
  if (!resumed) return;
  // A change link is only useful if the Run can follow it: it gains the
  // resource tools the way a turn with attached resources has them.
  // Only for a block this admission rendered: link-shaped text an Agent wrote
  // into a reply is not a handed-over reference.
  if (changes.size > 0 && containsRunChangeLink(prompt)) await grantRunChangeReadTools(input.db, resumed);
  // The group timeline shows the turns a person asked for; a summary turn is
  // the session's own bookkeeping and appears on neither side of it.
  if (!handoffTurn) await input.groups.createMessage({
    space_id: group.space_id,
    group_id: group.id,
    run_id: resumed.id,
    parent_message_id: parentMessageId,
    sender_actor_ref_json: {
      actor_type: "system",
      reason: serialized ? "conversation_serialization_admitted" : "agent_wait_for_results_resumed",
    },
    message_type: "system_event",
    content: serialized
      ? "Recipient run admitted after the preceding recipients of this turn completed."
      : "Agent run resumed after waited results completed.",
    mentions_json: [{ agent_id: resumed.agent_id }],
    metadata_json: {
      wait_for_results_run_id: resumed.id,
      depends_on_run_ids: waiting.depends_on_run_ids,
      completed_run_id:
        dependencyRuns[dependencyRuns.length - 1]?.id ?? input.completedRun.id,
    },
  });
  const job = {
    user_id: group.manager_user_id,
    agent_id: resumed.agent_id,
    project_folder_id: resumed.project_folder_id ?? null,
    payload: {
      run_id: resumed.id,
      run_group_id: resumed.run_group_id,
      root_run_id: resumed.root_run_id,
      parent_run_id: resumed.parent_run_id,
      trigger_origin: "manual",
      resumed_waiting_for_results: true,
    },
  };
  // The next recipient of an Agent-triggered turn (a discussion wave, a
  // delegation result) is itself Agent-triggered: it waits past the
  // subscription reserve line. A person's recipients never do.
  if (serialized && await isAgentOriginGroup(input.db, group.space_id, group.id)) {
    await admitAgentOriginRun(input.db, { spaceId: resumed.space_id, runId: resumed.id, job, source: input.quotaSource });
    return;
  }
  // A group that gave the turn up (for a Run held at the reserve line, since
  // cancelled) waits for the turn another group took meanwhile.
  await enqueueWhenTurnFree(input.db, { spaceId: resumed.space_id, runId: resumed.id, job });
}

interface WaitingForResultsState {
  scope: string | null;
  reason: string | null;
  resume_instruction: string | null;
  depends_on_run_ids: string[];
}

function waitingForResultsFromRun(run: RunRecord): WaitingForResultsState | null {
  const waiting = recordValue(recordValue(run.output_json).waiting_for_results);
  if (waiting.status !== "waiting") return null;
  const dependsOnRunIds = stringArrayValue(waiting.depends_on_run_ids);
  if (dependsOnRunIds.length === 0) return null;
  return {
    scope: stringValue(waiting.scope),
    reason: stringValue(waiting.reason),
    resume_instruction: stringValue(waiting.resume_instruction),
    depends_on_run_ids: dependsOnRunIds,
  };
}

function completedRunResultsBlock(
  dependencyRuns: readonly RunRecord[],
  changes: ReadonlyMap<string, RunChange>,
): string {
  return dependencyRuns.map((run, index) => {
    const agentName = stringValue(run.agent_name) ?? `Agent ${index + 1}`;
    const task = runAssignedTask(run);
    const change = changes.get(run.id);
    return [
      `${index + 1}. ${agentName}`,
      `   status: ${run.status}`,
      task ? `   task: ${task}` : null,
      `   result: ${terminalRunResultSummary(run)}`,
      change ? renderRunChangeBlock(change, "   ") : null,
    ].filter((part): part is string => typeof part === "string").join("\n");
  }).join("\n");
}

/**
 * A recipient parked behind the earlier recipients of the same message never
 * ran: the prompt it was dispatched with — identity block, conversation
 * window, execution rules, assigned task — is still the prompt it needs. That
 * window closes at the person's message, so the replies the earlier
 * recipients produced meanwhile are appended rather than lost. Do not replace
 * the prompt with a "continue" instruction (the `agent.wait_for_results`
 * resume shape). The Agent would work with no identity and no conversation.
 */
function serializedRecipientPrompt(
  waitingRun: RunRecord,
  dependencyRuns: readonly RunRecord[],
  changes: ReadonlyMap<string, RunChange>,
): string {
  const original = waitingRun.prompt ?? runAssignedTask(waitingRun) ?? "";
  if (dependencyRuns.length === 0) return original;
  return [
    original,
    "[Replies already given to this same message]",
    "The Agents below were addressed by the same message as you and have already replied; their replies are not in the conversation history above. Read them as part of this turn.",
    completedRunResultsBlock(dependencyRuns, changes),
  ].filter((part) => part.length > 0).join("\n\n");
}

function waitingContinuationPrompt(
  waitingRun: RunRecord,
  waiting: WaitingForResultsState,
  dependencyRuns: readonly RunRecord[],
  changes: ReadonlyMap<string, RunChange>,
): string {
  const results = completedRunResultsBlock(dependencyRuns, changes);
  const waitingTask = runAssignedTask(waitingRun);
  return [
    "Continue the paused room agent run using the completed agent results below.",
    "Use these results as available room context. Do not say the results are unavailable.",
    "Do not call additional agents unless the completed results clearly require a follow-up.",
    waitingTask ? `Original instruction:\n${waitingTask}` : null,
    waiting.reason ? `Wait reason:\n${waiting.reason}` : null,
    waiting.resume_instruction ? `Resume instruction:\n${waiting.resume_instruction}` : null,
    waiting.scope ? `Wait scope: ${waiting.scope}` : null,
    `Completed agent results:\n${results}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0))];
}

async function debateFirstRound(
  db: PoolClient,
  group: { space_id: string; discussion_id?: string | null; trigger_message_id: string | null },
): Promise<boolean> {
  if (!group.discussion_id || !group.trigger_message_id) return false;
  const result = await db.query<{ shape: string; wave: string | null }>(
    `SELECT discussion.shape, message.metadata_json->>'wave' AS wave
       FROM room_discussions discussion
       JOIN messages message ON message.space_id = discussion.space_id AND message.id = $3
      WHERE discussion.space_id = $1 AND discussion.id = $2`,
    [group.space_id, group.discussion_id, group.trigger_message_id],
  );
  const row = result.rows[0];
  return row?.shape === "debate" && Number(row.wave ?? 0) === 0;
}
