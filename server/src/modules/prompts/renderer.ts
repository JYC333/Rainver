import type { PromptMessage } from "@rainver/protocol";

// The only rendering engine prompt manifests declare today (content.rendering.engine
// is always "plain" — see the M0 inventory). `{variable_name}` placeholders are
// substituted from the caller-supplied variables map; anything else is left as-is
// so a missing variable is visible in the rendered output rather than silently
// dropped.
const VARIABLE_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export interface RenderedTemplate {
  rendered: string;
  missingVariables: string[];
}

export function renderPromptTemplate(input: string, variables: Record<string, unknown>): RenderedTemplate {
  const missing = new Set<string>();
  const rendered = input.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (!Object.hasOwn(variables, name)) {
      missing.add(name);
      return match;
    }
    return renderVariableValue(variables[name]);
  });
  return { rendered, missingVariables: [...missing] };
}

export interface RenderedMessages {
  messages: PromptMessage[];
  missingVariables: string[];
}

export function renderPromptMessages(
  messages: readonly PromptMessage[],
  variables: Record<string, unknown>,
): RenderedMessages {
  const missing = new Set<string>();
  const rendered = messages.map((message) => {
    const result = renderPromptTemplate(message.content, variables);
    for (const name of result.missingVariables) missing.add(name);
    return { role: message.role, content: result.rendered };
  });
  return { messages: rendered, missingVariables: [...missing] };
}

/** Only checks that variables_schema.required fields are present — not a full JSON Schema validator. */
export function missingRequiredVariables(
  variablesSchema: Record<string, unknown>,
  variables: Record<string, unknown>,
): string[] {
  const required = Array.isArray(variablesSchema.required)
    ? variablesSchema.required.filter((name): name is string => typeof name === "string")
    : [];
  return required.filter((name) => !Object.hasOwn(variables, name));
}

function renderVariableValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
