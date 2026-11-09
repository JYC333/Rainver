import type { RunAdapterResultEnvelope } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { BoundedProviderTaskError } from "./boundedProviderTaskRun.js";
import { RunMaterializationService } from "./materializationService.js";
import {
  canonicalRunOutput,
  materializationEventStatus,
  outputJsonWithVerification,
  recordValue,
} from "./orchestrationResults.js";
import { finalizedForPostRun } from "./finalizationOutcome.js";
import { PgRunRepository } from "./repository.js";
import { PgVerificationEngine } from "./verification/index.js";

/** Recorded on artifacts and adapter-shaped evidence a ProviderTask Run produces. */
const PROVIDER_TASK_RUNTIME_KEY = "provider_task";

/**
 * Publishes a bounded ProviderTask Run whose contract declares outputs.
 *
 * Used as a `runBoundedProviderTask` `finalize` step (it returns `null`
 * because it writes the terminal row itself). It is the provider-task side of
 * what `RunOrchestrationService` does for an Agent Run after its adapter
 * answers, through the same authorities rather than a copy of them:
 *
 * - `RunMaterializationService.materializeAdapterResult` persists the
 *   declared `artifacts[]` (and proposals) behind their policy gates;
 * - `PgVerificationEngine` evaluates whatever the contract declares;
 * - the terminal output carries `materialization` / `verification_results`
 *   in the canonical envelope, `degraded` when a declared output could not be
 *   persisted, `failed` when verification failed;
 * - `RunMaterializationService.finalizeRun` then records the evaluation and
 *   runs settlement, so a Workflow node waiting on this Run as its delegated
 *   Run completes exactly as it does for an Agent Run.
 *
 * The Run must still be `running`: a Run cancelled while the provider was
 * answering keeps its cancellation and publishes nothing. Publication locks
 * the Run and commits its outputs and terminal state in one transaction.
 */
export async function publishMaterializedProviderTaskRun(
  db: Queryable,
  config: ServerConfig,
  input: {
    spaceId: string;
    runId: string;
    completion: { text: string; output: Record<string, unknown> | null };
  },
): Promise<null> {
  const terminal = await withQueryableTransaction(db, async (db) => {
    const runs = new PgRunRepository(db);
    await db.query(
      "SELECT id FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE",
      [input.spaceId, input.runId],
    );
    const run = await runs.getRun(input.spaceId, input.runId);
    if (!run || run.status !== "running") {
      throw new BoundedProviderTaskError(
        "run_not_running",
        `ProviderTask Run '${input.runId}' is '${run?.status ?? "missing"}', not running; its output is not published.`,
      );
    }
    const output = input.completion.output ?? {};
    const completedAt = new Date().toISOString();
    const materializer = new RunMaterializationService(config, db);
    const materialization = await materializer.materializeAdapterResult({
      run,
      adapterResult: {
        runtime_key: PROVIDER_TASK_RUNTIME_KEY,
        adapter_kind: "managed_api",
        success: true,
        output_text: input.completion.text,
        // A validated structured object: JSON by construction.
        output_json: output as RunAdapterResultEnvelope["output_json"],
        exit_code: 0,
        started_at: run.started_at ?? null,
        completed_at: completedAt,
      },
    }, { proposal_status: "staged" });
    // No workspace and no Host: a declared command check cannot run here and
    // reports itself as such; artifact/proposal checks read what was persisted.
    const verification = await new PgVerificationEngine(db).verify({
      run,
      execution_target: null,
      base_commit_sha: null,
      output_json: output,
      materialization_items: materialization.items,
    });
    const verificationFailed = verification.some((result) => result.status === "failed" || result.status === "error");
    for (const item of materialization.items) {
      if (item.kind !== "artifact") continue;
      await appendEventBestEffort(runs, {
        run_id: run.id,
        space_id: run.space_id,
        event_type: "artifact_ingested",
        status: materializationEventStatus(item),
        artifact_id: item.artifact_id ?? null,
        error_code: item.error_code ?? null,
        error_message: item.error_message ?? null,
        metadata_json: { source: "provider_task_output", ...recordValue(item.metadata_json) },
      });
    }
    const status = verificationFailed
      ? "failed"
      : materialization.errors.length > 0 ? "degraded" : "succeeded";
    const terminal = await runs.markRunTerminal({
      run_id: run.id,
      space_id: run.space_id,
      status,
      exit_code: verificationFailed ? 1 : 0,
      output_json: canonicalRunOutput({
        success: !verificationFailed,
        outputText: input.completion.text,
        outputJson: outputJsonWithVerification(output, materialization.items, materialization.errors, verification),
      }),
      error_json: verificationFailed
        ? { error_code: "verification_failed", error_text: "A verification the Run contract declares failed." }
        : {},
      completed_at: completedAt,
    });
    if (!terminal) {
      throw new BoundedProviderTaskError("run_not_running", "ProviderTask publication could not settle its Run.");
    }
    return terminal;
  });
  const runs = new PgRunRepository(db);
  const materializer = new RunMaterializationService(config, db);
  const finalization = await materializer.finalizeRun(terminal);
  if (!finalizedForPostRun(finalization)) {
    // The terminal Run is durable; the recovery sweep resumes an unsettled
    // finalization. Leave the reason on the Run for whoever reads it.
    await appendEventBestEffort(runs, {
      run_id: terminal.id,
      space_id: terminal.space_id,
      event_type: "run_finalized",
      status: materializationEventStatus(finalization),
      error_code: finalization.error_code ?? null,
      error_message: finalization.error_message ?? null,
      summary: "Run finalization failed.",
      metadata_json: recordValue(finalization.metadata_json),
    });
  }
  return null;
}

async function appendEventBestEffort(
  runs: PgRunRepository,
  event: Parameters<PgRunRepository["appendRunEvent"]>[0],
): Promise<void> {
  try {
    await runs.appendRunEvent(event);
  } catch {
    // RunEvent is an append-only audit log; a missed event does not change
    // the Run's published result.
  }
}
