import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import type { CredentialSpendBasis } from "../policy/credentialSpend.js";
import { resolveProviderCommandStore } from "../providers/commands/store.js";
import {
  completeProviderMessages,
  type ProviderStructuredOutput,
} from "../providers/invocation/invocation.js";
import { PgRunRepository } from "./repository.js";
import type { RunContractSnapshotInput } from "./contractSnapshot.js";
import { canonicalRunOutput } from "./orchestrationResults.js";

/**
 * One bounded ProviderTask, one Run.
 *
 * ADR 0022 §2/§3 and plan decision 14: bounded work that needs Run lifecycle,
 * retry, artifacts or verification records a `provider_task` Run — no Agent,
 * no AgentVersion, no manufactured Runtime Profile — while incidental calls
 * (title generation, query rewriting, reranking) use the ProviderTask ledger
 * alone and create no Run.
 *
 * The lifecycle rule this owns is the one
 * [`RUNS_AND_OUTPUTS.md`](../../../../.agent/architecture/RUNS_AND_OUTPUTS.md)
 * states: *one bounded task is one Run however many provider attempts its key
 * pool makes*. Every attempt links itself to the same Run, and the Run's
 * terminal state is decided once, when the task itself succeeds or fails.
 * There were two hand-rolled copies of this wrapper with opposite semantics —
 * Project Research kept one Run across retries, Daily Reports created a new
 * Run per attempt and failed each one — which is how the same concept came to
 * mean two different things in the Run list. This is the only implementation.
 */

export class BoundedProviderTaskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BoundedProviderTaskError";
  }
}

export interface BoundedProviderTaskCompletion {
  /** The provider's raw reply text. Empty for most structured contracts. */
  text: string;
  /** The validated structured output; always present for `structured`. */
  output: Record<string, unknown> | null;
  /** The ModelProvider row that answered, after every fallback. */
  providerId: string;
  model: string;
}

/**
 * Turns the accepted completion into the Run's durable result.
 *
 * Runs exactly once, before the Run is marked terminal, so a crash can only
 * ever leave work *un*published — never a succeeded Run whose output was never
 * applied. Return an envelope to have this module write the terminal row, or
 * `null` when the callback already wrote it because its durable writes and the
 * Run's terminal status have to commit together. Throwing a
 * `BoundedProviderTaskError` fails the Run once with that code.
 */
export type BoundedProviderTaskFinalize = (
  completion: BoundedProviderTaskCompletion,
  runId: string,
) => Promise<{ outputText: string; outputJson: Record<string, unknown> } | null>;

interface BoundedProviderTaskBase {
  spaceId: string;
  userId: string;
  /** ProviderTask task name; also the usage-ledger task label. */
  task: string;
  /** The bounded task's capability identity, recorded on the Run. */
  capabilityId?: string | null;
  projectId?: string | null;
  providerId: string;
  model: string | null;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Short human-readable task statement stored on the Run. */
  prompt: string;
  /** The full rendered instruction stored on the Run for the logical I/O view. */
  instruction?: string | null;
  runType: string;
  triggerOrigin: string;
  /** Only used when this task creates its own Run; a queued Run froze it. */
  contractSnapshot?: RunContractSnapshotInput;
  spend: CredentialSpendBasis;
  /** Extra usage-ledger dimensions; the task/subject/project are set here. */
  metering?: Record<string, unknown>;
  /**
   * An already-queued `provider_task` Run this task belongs to. Present when a
   * worker performs the task: the Run was admitted and made durable at request
   * time, and the first attempt binds it to its ledger records rather than
   * creating a second Run. Absent for a task performed on the request path.
   */
  runId?: string | null;
  /**
   * Whether a failed task marks the Run failed. A job-driven task hands this
   * to the handler instead, which fails the Run only once the job has no
   * retries left — the same rule `agent_run` applies.
   */
  failRunOnError?: boolean;
  finalize?: BoundedProviderTaskFinalize;
}

export type BoundedProviderTaskInput = BoundedProviderTaskBase & (
  | { completion: "structured"; outputFormat: ProviderStructuredOutput }
  | { completion: "text" }
);

export type BoundedProviderTaskResult =
  | { ok: true; runId: string; output: Record<string, unknown>; text: string }
  | { ok: false; runId: string | null; errorCode: string; error: string };

/**
 * Runs one bounded completion and settles its ProviderTask Run.
 *
 * Never throws for a provider or contract failure: the caller decides how a
 * failed bounded task is surfaced, and the Run is already settled either way.
 */
export async function runBoundedProviderTask(
  db: Queryable,
  config: ServerConfig,
  input: BoundedProviderTaskInput,
): Promise<BoundedProviderTaskResult> {
  const failRun = input.failRunOnError !== false;
  let runId: string | null = input.runId ?? null;
  try {
    const completion = await completeProviderMessages(resolveProviderCommandStore(config), input.spaceId, {
      provider_id: input.providerId,
      model: input.model,
      system: input.system,
      messages: input.messages,
      task: input.task,
      ...(input.completion === "structured" ? { output_format: input.outputFormat } : {}),
      metering: {
        ...(input.metering ?? {}),
        subject_user_id: input.userId,
        source_type: "local_run",
        execution_channel: "managed_api",
        project_id: input.projectId ?? null,
        task: input.task,
      },
      spend: input.spend,
      providerTaskRunLifecycle: {
        // Every attempt links itself to the same Run. The first one either
        // binds the Run the caller already queued or creates one; the rest
        // find `runId` set and only report it back.
        onAttemptStarted: async (attemptDb, refs) => {
          const attemptRuns = new PgRunRepository(attemptDb);
          if (input.runId) {
            const started = await attemptRuns.startQueuedProviderTaskRun({
              run_id: input.runId,
              space_id: input.spaceId,
              provider_id: refs.provider_id,
              control_id: refs.control_id,
              delivery_id: refs.delivery_id,
              invocation_snapshot_id: refs.invocation_snapshot_id,
            });
            if (!started) {
              // `WHERE status = 'queued'` refused the start. Already `running`
              // is the ordinary case — a job retry, or the next key in the
              // pool taking over the same task — but anything else means the
              // Run left `queued` under another authority (a cancel). Spending
              // the provider anyway produced a Run that finalized its durable
              // writes and then failed 23514 on the queued arm of the terminal
              // update, surfacing a raw constraint name to the person. The
              // throw rolls this attempt's transaction back before the call.
              const current = await attemptRuns.getRun(input.spaceId, input.runId);
              if (current?.status !== "running") {
                throw new BoundedProviderTaskError(
                  "run_not_queued",
                  `The bounded ${input.task} Run is '${current?.status ?? "missing"}', not queued; refusing to start it.`,
                );
              }
            }
            return input.runId;
          }
          if (runId) return runId;
          const run = await attemptRuns.createProviderTaskRun({
            execution_kind: "provider_task",
            space_id: input.spaceId,
            user_id: input.userId,
            trigger_origin: input.triggerOrigin,
            run_type: input.runType,
            task: input.task,
            prompt: input.prompt,
            instruction: input.instruction ?? null,
            project_id: input.projectId ?? null,
            capability_id: input.capabilityId ?? null,
            provider_id: refs.provider_id,
            model: refs.model,
            control_id: refs.control_id,
            delivery_id: refs.delivery_id,
            invocation_snapshot_id: refs.invocation_snapshot_id,
            contract_snapshot: input.contractSnapshot,
          });
          // Deliberately not published here: this runs inside the attempt's
          // transaction, and the ledger link UPDATEs that follow it can still
          // roll the whole attempt back. Publishing the id here left the
          // closure holding a Run that does not exist — `markRunTerminal`
          // matched nothing, the failure settled nowhere, and the caller was
          // handed a `run_id` pointing at no row. `onAttemptCompleted` runs
          // after that transaction has committed, and carries the same id.
          return run.id;
        },
        // A failed attempt is not a failed task while the pool still has
        // candidates left, so the Run's terminal state is decided below.
        onAttemptCompleted: async (refs) => {
          if (refs.run_id) runId = refs.run_id;
        },
      },
    });
    if (!runId) {
      return {
        ok: false,
        runId: null,
        errorCode: "provider_task_run_missing",
        error: `The bounded ${input.task} task completed without a ProviderTask Run.`,
      };
    }
    const output = completion.structured_output ?? null;
    if (input.completion === "structured" && !output) {
      return settleFailure(db, input, runId, failRun, {
        code: "structured_output_missing",
        message: `The bounded ${input.task} task returned no structured output.`,
      });
    }
    const applied = await input.finalize?.({
      text: completion.text,
      output,
      providerId: completion.provider_id,
      model: completion.model,
    }, runId);
    if (applied !== null) {
      await new PgRunRepository(db).markRunTerminal({
        run_id: runId,
        space_id: input.spaceId,
        status: "succeeded",
        output_json: canonicalRunOutput({
          success: true,
          outputText: applied?.outputText ?? "",
          outputJson: applied?.outputJson ?? output ?? {},
        }),
        completed_at: new Date().toISOString(),
      });
    }
    return { ok: true, runId, output: output ?? {}, text: completion.text };
  } catch (error) {
    const code = error instanceof BoundedProviderTaskError
      ? error.code
      : "bounded_provider_task_failed";
    const message = error instanceof Error ? error.message : String(error);
    if (!runId) return { ok: false, runId: null, errorCode: code, error: message };
    // The Run left `queued` under another authority, which owns its terminal
    // state: settling it here would overwrite a cancellation with a failure of
    // a task that was never performed.
    if (code === "run_not_queued") return { ok: false, runId, errorCode: code, error: message };
    return settleFailure(db, input, runId, failRun, { code, message });
  }
}

async function settleFailure(
  db: Queryable,
  input: BoundedProviderTaskInput,
  runId: string,
  failRun: boolean,
  error: { code: string; message: string },
): Promise<BoundedProviderTaskResult> {
  if (failRun) await failBoundedProviderTaskRun(db, input.spaceId, runId, error);
  return { ok: false, runId, errorCode: error.code, error: error.message };
}

/**
 * The one failure terminal for a bounded ProviderTask Run. Exported for the
 * `provider_task_run` job handler, which decides *when* a failed task is final
 * (the job's own retries come first) but not what the record looks like.
 */
export async function failBoundedProviderTaskRun(
  db: Queryable,
  spaceId: string,
  runId: string,
  error: { code: string; message: string },
): Promise<void> {
  await new PgRunRepository(db).markRunTerminal({
    run_id: runId,
    space_id: spaceId,
    status: "failed",
    output_json: canonicalRunOutput({ success: false, outputText: "", outputJson: {} }),
    error_json: { error_code: error.code, error_text: error.message.slice(0, 1000) },
    completed_at: new Date().toISOString(),
  });
}
