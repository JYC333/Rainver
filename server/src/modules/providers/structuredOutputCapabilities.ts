const STRUCTURED_OUTPUT_PROVIDER_TYPES = new Set([
  "openai",
  "openrouter",
  "other",
  "anthropic",
  "ollama",
]);

export function providerSupportsStructuredOutput(providerType: string): boolean {
  return STRUCTURED_OUTPUT_PROVIDER_TYPES.has(providerType);
}

/**
 * Models whose OpenAI-compatible gateway corrupts forced tool-call arguments
 * (MiniMax: XML round-trip stringifies scalars, wraps arrays in `item`, and
 * hoists array-element fragments to the top level). For these, structured
 * output goes through response_format plus prompt constraints only; the text
 * normalization pipeline handles reasoning envelopes and fences.
 */
const STRUCTURED_TOOL_CALL_UNRELIABLE_MODELS: RegExp[] = [/(^|\/)minimax/i];

export function modelStructuredToolCallUnreliable(model: string | null | undefined): boolean {
  if (typeof model !== "string" || !model.trim()) return false;
  const trimmed = model.trim();
  return STRUCTURED_TOOL_CALL_UNRELIABLE_MODELS.some((pattern) => pattern.test(trimmed));
}

export interface StructuredOutputToolStrategy {
  /** Offer the schema as a single forced tool call. False for unreliable models. */
  forceTool: boolean;
  /** Embed the schema in the system prompt instead of forcing a tool call. */
  schemaInstruction: string | null;
}

/**
 * Single decision point every completion path must consult before offering
 * structured output as a forced tool call: unreliable models never see the
 * forced tool (their gateway corrupts its arguments), and instead get the
 * schema embedded in the prompt, answering in prose that the caller must
 * parse from text.
 */
export function structuredOutputToolStrategy(
  model: string | null | undefined,
  schema: Record<string, unknown> | null | undefined,
): StructuredOutputToolStrategy {
  if (!schema) return { forceTool: false, schemaInstruction: null };
  if (modelStructuredToolCallUnreliable(model)) {
    return {
      forceTool: false,
      schemaInstruction: `Reply with exactly one JSON object that validates against this JSON Schema. Match every key name and type exactly; do not add undeclared keys:\n${JSON.stringify(schema)}`,
    };
  }
  return { forceTool: true, schemaInstruction: null };
}
