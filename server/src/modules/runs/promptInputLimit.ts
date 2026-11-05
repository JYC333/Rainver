import type { ContentBlock } from "./cliConversationProtocol.js";

/** A turn whose prompt is longer than its runtime accepts; it was not sent. Not retried: the same prompt fails again. */
export const RUNTIME_INPUT_TOO_LARGE = "runtime_input_too_large";

/**
 * The text characters of the largest prompt a Run would send, counted the way
 * the ACP controller sends them: prompt `i` is `promptBlocks[i]` when there is
 * one, otherwise the plain `prompts[i]`. Text blocks and embedded text
 * resources count; images and links do not. UTF-16 length, which can only
 * overcount a runtime's character count.
 */
export function largestPromptChars(
  prompts: readonly string[],
  promptBlocks?: readonly (readonly ContentBlock[])[],
): number {
  let largest = 0;
  const count = Math.max(prompts.length, promptBlocks?.length ?? 0);
  for (let index = 0; index < count; index += 1) {
    const blocks = promptBlocks?.[index];
    const size = blocks ? blocks.reduce((sum, block) => sum + blockTextChars(block), 0) : prompts[index]?.length ?? 0;
    largest = Math.max(largest, size);
  }
  return largest;
}

/** The refusal for a prompt over `limit`, or null when it fits or the runtime states no limit. */
export function promptInputLimitFailure(input: {
  runtimeName: string;
  limit: number | undefined;
  prompts: readonly string[];
  promptBlocks?: readonly (readonly ContentBlock[])[];
}): string | null {
  if (!input.limit) return null;
  const size = largestPromptChars(input.prompts, input.promptBlocks);
  if (size <= input.limit) return null;
  return `This turn's prompt is ${size.toLocaleString("en-US")} characters; ${input.runtimeName} accepts at most `
    + `${input.limit.toLocaleString("en-US")}, so it was not sent. Hand the Agent file paths or references instead of `
    + `pasted content, or continue in a new conversation.`;
}

function blockTextChars(block: ContentBlock): number {
  if (block.type === "text") return block.text.length;
  if (block.type === "resource" && "text" in block.resource && typeof block.resource.text === "string") {
    return block.resource.text.length;
  }
  return 0;
}
