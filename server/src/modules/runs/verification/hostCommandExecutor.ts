import { sharedHostConnectionRegistry } from "../../hosts/connectionRegistry.js";
import type { CliExecutionResult } from "../localCliExecution.js";
import type { VerificationCommandExecutor } from "./engine.js";
import type { VerificationTarget } from "./types.js";

/** What the daemon reports when a command outran the output cap and was killed. */
const COMMAND_OUTPUT_LIMIT_EXCEEDED = "command_output_limit_exceeded";

/**
 * Verification, asked of the host that holds the workspace.
 *
 * It replaces an executor that spoke a private protocol to a Runner beside the
 * server — which is why verification was a server-host-only capability, and
 * why a paired host's Runs could never be verified at all. The same frame
 * serves both host kinds now: a strict host wraps the command in the same
 * namespace it gives a Run, and a trusted host runs it natively, which is the
 * trust its owner already extends to that machine.
 *
 * The command comes from a server-side verification recipe and nowhere else.
 * That is the boundary — the daemon executes what the control plane hands it
 * — so a recipe is the thing that must be reviewed, not the frame.
 */
export class HostCommandVerificationExecutor implements VerificationCommandExecutor {
  async run(input: {
    runId: string;
    target: VerificationTarget;
    command: string[];
    timeoutSeconds: number;
  }): Promise<CliExecutionResult> {
    const outcome = await sharedHostConnectionRegistry.runHostCommand(input.target.host_id, {
      ...(input.target.workspace ? { workspace: input.target.workspace } : {}),
      ...(input.target.workspace_location_id ? { workspace_location_id: input.target.workspace_location_id } : {}),
      run_id: input.runId,
      command: input.command,
      timeout_seconds: input.timeoutSeconds,
    });
    // A host that never answered is not a verifier that failed: the engine
    // reports the first as `error` (nothing was learned) and the second as
    // `failed` (the recipe's question got a no), and losing that distinction
    // would turn an offline machine into a failing build.
    //
    // An output-cap kill is the *other* case, and reporting it as unreachable
    // was worse than losing a nuance: a recipe could turn its own failure into
    // "inconclusive" by printing 256 KiB. It ran, and it did not pass.
    const unreachable = !outcome.ok && outcome.error !== COMMAND_OUTPUT_LIMIT_EXCEEDED;
    return {
      returncode: outcome.exit_code,
      stdout: outcome.stdout,
      stderr: outcome.stderr || (outcome.error ?? ""),
      timed_out: outcome.timed_out,
      ...(unreachable ? { failure_code: "sandbox_runner_unavailable" as const } : {}),
    };
  }
}
