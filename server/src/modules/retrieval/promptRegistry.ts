import type { Queryable } from "../routeUtils/common.js";
import { resolvePrompt } from "../prompts/resolver.js";

export const RETRIEVAL_QUERY_REWRITE_PROMPT_KEY = "retrieval.query_rewrite";
export const RETRIEVAL_RERANK_PROMPT_KEY = "retrieval.rerank";
export const RETRIEVAL_SYNTHESIS_PROMPT_KEY = "retrieval.synthesis";

export interface ResolvedQueryRewritePrompt {
  system: string;
  user: string;
}

export async function resolveRetrievalQueryRewritePrompt(
  db: Queryable,
  input: { spaceId: string; userId: string; query: string },
): Promise<ResolvedQueryRewritePrompt | null> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    assetKey: RETRIEVAL_QUERY_REWRITE_PROMPT_KEY,
    variables: { query: input.query },
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_messages) return null;
  const system = firstMessageContent(resolved.rendered_messages, "system");
  const user = firstMessageContent(resolved.rendered_messages, "user");
  return system && user ? { system, user } : null;
}

export async function resolveRetrievalRerankSystemPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string },
): Promise<string | null> {
  return resolveRetrievalSystemPrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    assetKey: RETRIEVAL_RERANK_PROMPT_KEY,
  });
}

export async function resolveRetrievalSynthesisSystemPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string },
): Promise<string | null> {
  return resolveRetrievalSystemPrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    assetKey: RETRIEVAL_SYNTHESIS_PROMPT_KEY,
  });
}

async function resolveRetrievalSystemPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string; assetKey: string },
): Promise<string | null> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    assetKey: input.assetKey,
    variables: {},
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_messages) return null;
  return firstMessageContent(resolved.rendered_messages, "system");
}

function firstMessageContent(
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[],
  role: "system" | "user" | "assistant",
): string | null {
  const content = messages.find((message) => message.role === role)?.content.trim();
  return content ? content : null;
}
