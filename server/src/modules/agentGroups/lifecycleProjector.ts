import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import { PgJobQueueRepository } from "../jobs/repository";
import { withDbTransaction } from "../routeUtils/common";
import { PgRunRepository, type RunRecord } from "../runs/repository";
import { runOutputResult } from "../runs/orchestrationResults";
import { PgAgentGroupRepository, type RunDelegationRecord } from "./repository";

type DelegationTerminalStatus = "succeeded" | "failed" | "cancelled";

export class AgentGroupRunLifecycleProjector {
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): AgentGroupRunLifecycleProjector | null {
    if (!config.databaseUrl) return null;
    return new AgentGroupRunLifecycleProjector(getDbPool(config.databaseUrl));
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

  async markDelegatedRunTerminal(run: RunRecord): Promise<void> {
    const ids = delegationIds(run);
    if (!ids) {
      await this.projectGroupedRunTerminalMessage(run);
      return;
    }
    await withDbTransaction(this.pool, async (client) => {
      const groups = new PgAgentGroupRepository(client);
      const runs = new PgRunRepository(client);
      const currentRun = await runs.getRun(run.space_id, run.id) ?? run;
      const terminalStatus = delegationStatusForRun(currentRun.status);
      if (!terminalStatus) return;
      const resultSummary = delegationResultSummary(currentRun);
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
      await queueWaitingDependencyRunsIfReady({
        groups,
        runs,
        jobs: new PgJobQueueRepository(client),
        completedRun: currentRun,
      });
    });
  }

  async reconcileWaitingRun(run: RunRecord): Promise<void> {
    if (run.status !== "waiting_for_dependency" || !run.run_group_id) return;
    await withDbTransaction(this.pool, async (client) => {
      await queueWaitingDependencyRunIfReady({
        groups: new PgAgentGroupRepository(client),
        runs: new PgRunRepository(client),
        jobs: new PgJobQueueRepository(client),
        completedRun: run,
        waitingRun: run,
      });
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
      const currentContent = groupedRunMessageContent(currentRun);
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
        groups,
        runs,
        jobs: new PgJobQueueRepository(client),
        completedRun: currentRun,
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

function delegationResultSummary(run: RunRecord): string {
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
  groups: PgAgentGroupRepository;
  runs: PgRunRepository;
  jobs: PgJobQueueRepository;
  completedRun: RunRecord;
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
  groups: PgAgentGroupRepository;
  runs: PgRunRepository;
  jobs: PgJobQueueRepository;
  completedRun: RunRecord;
  waitingRun: RunRecord;
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
  const resumed = await input.runs.requeueWaitingDependencyRun({
    run_id: input.waitingRun.id,
    space_id: input.waitingRun.space_id,
    prompt: waitingContinuationPrompt(input.waitingRun, waiting, dependencyRuns),
    resumed_at: new Date().toISOString(),
  });
  if (!resumed) return;
  await input.groups.createMessage({
    space_id: group.space_id,
    group_id: group.id,
    run_id: resumed.id,
    parent_message_id: parentMessageId,
    sender_actor_ref_json: {
      actor_type: "system",
      reason: "agent_wait_for_results_resumed",
    },
    message_type: "system_event",
    content: "Agent run resumed after waited results completed.",
    mentions_json: [{ agent_id: resumed.agent_id }],
    metadata_json: {
      wait_for_results_run_id: resumed.id,
      depends_on_run_ids: waiting.depends_on_run_ids,
      completed_run_id:
        dependencyRuns[dependencyRuns.length - 1]?.id ?? input.completedRun.id,
    },
  });
  await input.jobs.enqueue({
    job_type: "agent_run",
    space_id: resumed.space_id,
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
  });
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

function waitingContinuationPrompt(
  waitingRun: RunRecord,
  waiting: WaitingForResultsState,
  dependencyRuns: readonly RunRecord[],
): string {
  const results = dependencyRuns.map((run, index) => {
    const agentName = stringValue(run.agent_name) ?? `Agent ${index + 1}`;
    return [
      `${index + 1}. ${agentName}`,
      `   status: ${run.status}`,
      run.prompt ? `   task: ${run.prompt}` : null,
      `   result: ${terminalRunResultSummary(run)}`,
    ].filter((part): part is string => typeof part === "string").join("\n");
  }).join("\n");
  return [
    "Continue the paused room agent run using the completed agent results below.",
    "Use these results as available room context. Do not say the results are unavailable.",
    "Do not call additional agents unless the completed results clearly require a follow-up.",
    waitingRun.prompt ? `Original instruction:\n${waitingRun.prompt}` : null,
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
