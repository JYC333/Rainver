import type { ConversationInputPart, RuntimePromptCapabilities } from "@rainver/protocol";

export class ConversationInputCapabilityError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "ConversationInputCapabilityError";
  }
}
/**
 * Admission is conservative: a missing capability is unknown, never an
 * implicit yes. This is called before the user message is persisted, and Room
 * dispatch calls it for every recipient before it fans out any Run.
 */
export function assertConversationInputCapabilities(
  parts: readonly ConversationInputPart[],
  capabilities: RuntimePromptCapabilities | null | undefined,
): void {
  if (parts.some((part) => part.kind === "image")) {
    if (capabilities?.image !== true) {
      throw new ConversationInputCapabilityError(
        422,
        "The selected Agent/model does not explicitly support image input; choose a compatible backend before sending",
      );
    }
  }
  if (parts.some((part) => part.kind === "file_reference") && capabilities?.resource_link === false) {
    throw new ConversationInputCapabilityError(
      422,
      "The selected Agent does not support authorized file references",
    );
  }
}
