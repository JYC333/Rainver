import type { RuntimePromptCapabilities } from "@rainver/protocol";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/index.js";

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
  parts: readonly { kind: "image" | "file_reference" | "input_resource" }[],
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

/** New immutable resources require the same governed Run tool surface used by
 * managed API and CLI adapters; an arbitrary custom executor cannot receive
 * the descriptor or call the canonical dispatcher safely. */
export function assertConversationInputResourceTools(
  parts: readonly { kind: "image" | "file_reference" | "input_resource" }[],
  runtimeKey: string | null | undefined,
): void {
  if (!parts.some((part) => part.kind === "input_resource")) return;
  const executorFamily = getRuntimeAdapterSpec(runtimeKey ?? "")?.executor_family;
  if (executorFamily !== "local_cli") {
    throw new ConversationInputCapabilityError(
      422,
      "This Agent runtime cannot lazily read attached resources; choose a supported ACP runtime before sending",
    );
  }
}
