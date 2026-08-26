import type { PromptResolveResult } from "@agent-space/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { resolvePrompt } from "../prompts/resolver.js";

export const AGENT_DEFAULT_ASSISTANT_SYSTEM_PROMPT_KEY = "agent.default_assistant.system";

export function agentTemplateSystemPromptKey(templateKey: string): string {
  return `agent_template.${templateKey}.system`;
}

export interface ResolvedAgentSystemPrompt {
  system: string;
  resolveResult: PromptResolveResult;
}

export async function resolveAgentSystemPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string; assetKey: string; agentId?: string | null },
): Promise<ResolvedAgentSystemPrompt | null> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    agentId: input.agentId ?? undefined,
    assetKey: input.assetKey,
    variables: {},
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_messages) return null;
  const system = firstMessageContent(resolved.rendered_messages, "system");
  return system ? { system, resolveResult: resolved } : null;
}

function firstMessageContent(
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[],
  role: "system" | "user" | "assistant",
): string | null {
  const content = messages.find((message) => message.role === role)?.content.trim();
  return content ? content : null;
}
