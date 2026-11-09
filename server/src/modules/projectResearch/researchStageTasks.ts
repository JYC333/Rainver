import type { Queryable } from "../routeUtils/common.js";
import { objectValue, optionalString, withQueryableTransaction } from "../routeUtils/common.js";
import type { RunContractSnapshotInput } from "../runs/contractSnapshot.js";
import { enqueueProviderTaskRunJob, providerTaskRunPreparers } from "../runs/providerTaskRunHandler.js";
import { publishMaterializedProviderTaskRun } from "../runs/providerTaskRunPublication.js";
import { PgRunRepository } from "../runs/repository.js";
import type { ProviderStructuredOutput } from "../providers/invocation/invocation.js";
import type { ResolvedResearchProvider } from "./executionProfileService.js";
import { RESEARCH_STAGES } from "./researchStages.js";

/**
 * The queued Project Research stages, keyed by their stage identifier, and
 * the ProviderTask/usage task label each one records.
 *
 * Monitoring comparison (workflow and standing), brief synthesis, its one
 * revision and its critique are bounded, single-shot structured generations
 * with no tools and no turns of their own, so each is one `provider_task` Run
 * (ADR 0022 §2/§3) performed by the shared `provider_task_run` worker. The
 * critique shares the synthesis stage identifier; its frozen output contract
 * and `stage_key` are what tell the two apart.
 */
const QUEUED_STAGE_TASKS = {
  [RESEARCH_STAGES.monitor_compare]: "project_research_monitor_compare",
  [RESEARCH_STAGES.brief_synthesize]: "project_research_brief_synthesize",
} as const;

type QueuedResearchStage = keyof typeof QUEUED_STAGE_TASKS;

const RESEARCH_STAGE_SYSTEM_PROMPT =
  "You are a Project Research stage task. Work only on the supplied research corpus, preserve source and "
  + "evidence references in every research output, and answer with the requested JSON object and nothing else.";

/**
 * Admits one queued research stage: a durable `queued` ProviderTask Run and
 * the `provider_task_run` job that performs it, committed together.
 *
 * The provider and model are frozen into the Run's route hints here, at
 * admission, so a Space default changed while the Run waits cannot decide
 * what it runs on. Everything the worker needs — instruction, output
 * contract, provider binding — is on the Run; the job carries only its id.
 */
export async function queueResearchStageTask(
  db: Queryable,
  input: {
    stage: QueuedResearchStage;
    spaceId: string;
    userId: string;
    projectId: string;
    provider: ResolvedResearchProvider;
    prompt: string;
    instruction: string;
    contract: RunContractSnapshotInput & { structured_output_json: ProviderStructuredOutput };
    /** `stage_key` (or the standing marker) recorded in the route hints for readers of the Run. */
    stageKey: string;
  },
): Promise<{ runId: string; runStatus: string; jobId: string; jobStatus: string }> {
  return withQueryableTransaction(db, async (tx) => {
    const run = await new PgRunRepository(tx).createQueuedProviderTaskRun({
      space_id: input.spaceId,
      user_id: input.userId,
      trigger_origin: "system",
      run_type: "agent",
      task: QUEUED_STAGE_TASKS[input.stage],
      prompt: input.prompt,
      instruction: input.instruction,
      project_id: input.projectId,
      capability_id: input.stage,
      contract_snapshot: {
        ...input.contract,
        route_hints_json: {
          owner_domain: "projectResearch",
          stage: input.stageKey,
          provider_id: input.provider.modelProviderId,
          model: input.provider.modelName,
        },
      },
    });
    const job = await enqueueProviderTaskRunJob(tx, {
      run_id: run.id,
      space_id: input.spaceId,
      user_id: input.userId,
      project_id: input.projectId,
    });
    return { runId: run.id, runStatus: run.status, jobId: job.id, jobStatus: job.status };
  });
}

/**
 * How the worker performs a queued research stage Run.
 *
 * Rebuilt from the Run alone: its rendered instruction, frozen output
 * contract and the provider/model admission resolved. The accepted
 * completion is published through the canonical materialization,
 * verification and finalization path, so a synthesis archive becomes an
 * artifact the Run's `materialization` names, and the WorkflowExecution
 * node delegating to the Run settles from its evaluation.
 */
export function registerResearchStageProviderTaskRuns(): void {
  for (const stage of Object.keys(QUEUED_STAGE_TASKS) as QueuedResearchStage[]) {
    providerTaskRunPreparers.register(stage, async ({ db, config, run }) => {
      const contract = objectValue(run.contract_snapshot_json);
      const hints = objectValue(contract.route_hints_json);
      const providerId = optionalString(hints.provider_id);
      const userId = optionalString(run.instructed_by_user_id);
      const outputFormat = objectValue(contract.structured_output_json);
      if (!providerId || !userId || Object.keys(objectValue(outputFormat.schema)).length === 0) {
        throw new Error(`Research stage Run '${run.id}' is missing its provider binding, instructing user or output contract`);
      }
      return {
        completion: "structured",
        outputFormat: outputFormat as unknown as ProviderStructuredOutput,
        spaceId: run.space_id,
        userId,
        projectId: run.project_id ?? null,
        task: QUEUED_STAGE_TASKS[stage],
        capabilityId: stage,
        providerId,
        model: optionalString(hints.model),
        system: RESEARCH_STAGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: run.instruction ?? run.prompt ?? "" }],
        prompt: run.prompt ?? "",
        instruction: run.instruction ?? null,
        runType: run.run_type ?? "agent",
        triggerOrigin: run.trigger_origin ?? "system",
        // The stage is unattended: the Run spends for itself, on the
        // pre-authorization its managed `project_research` policy records.
        spend: { kind: "run", run },
        finalize: (completion, runId) => publishMaterializedProviderTaskRun(db, config, {
          spaceId: run.space_id,
          runId,
          completion,
        }),
      };
    });
  }
}
