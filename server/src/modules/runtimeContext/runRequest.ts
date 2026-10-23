/**
 * Recorded on a Run's `model_override_json` by the server code that assembles
 * its `prompt` with its `instruction` as the final part (a Room delegation:
 * standing context, a handoff, then the task). Acquisition reads this fact
 * instead of guessing it from the prompt's text.
 */
export const RUN_REQUEST_INCLUDES_INSTRUCTION = "run_request_includes_instruction";

/** Whether the Run request already carries its instruction, so it is not delivered twice. */
export function instructionInRunRequest(run: {
  prompt: string | null;
  instruction: string | null;
  model_override_json?: unknown;
}): boolean {
  const prompt = run.prompt?.trim();
  const instruction = run.instruction?.trim();
  if (!prompt || !instruction) return false;
  if (prompt === instruction) return true;
  const override = run.model_override_json;
  return Boolean(override && typeof override === "object" && !Array.isArray(override)
    && (override as Record<string, unknown>)[RUN_REQUEST_INCLUDES_INSTRUCTION] === true);
}

/** Canonical history keeps distinct instructions, but never repeats the delegated task. */
export function historicalRunRequest(run: Parameters<typeof instructionInRunRequest>[0]): string {
  return instructionInRunRequest(run)
    ? run.prompt!.trim()
    : [run.prompt?.trim(), run.instruction?.trim()].filter(Boolean).join("\n\n");
}
