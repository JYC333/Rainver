import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";
import { runOutputResult } from "./orchestrationResults.js";

/**
 * A vendor CLI's own interactive question, translated into the turn's reply
 * (`modules/runtime-adapters.md`, "Interactive requests from the runtime").
 *
 * Rainver has no "ask the person and suspend" tool: an Agent asks by ending
 * its turn with the question, and the vendor session keeps its working state
 * for the answer. When the runtime instead opens its own prompt — Claude
 * Code's AskUserQuestion, Codex's request_user_input, both of which arrive as
 * an ACP form elicitation — nobody is there to answer it during a Run. The
 * ACP controller cancels that prompt and the turn, and the question becomes
 * the Agent's reply, marked as waiting for an answer.
 *
 * The run output carries it as `asked_user`; the chat finalizer writes it.
 */
export interface AskedUser {
  question: string;
  /** The answers offered, when the runtime offered a choice for one question. */
  options: string[];
}

/**
 * Interactive methods a client serves only if it advertised the capability.
 * Rainver advertises neither, so one of these is a runtime fault — it refuses
 * and fails as before — not a question for the person.
 */
const CAPABILITY_METHOD_PREFIXES = ["fs/", "terminal/"];

export function isCapabilityGatedMethod(method: string): boolean {
  return CAPABILITY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

/** Whether the controller advertises ACP form elicitation to this runtime. */
export function advertisesFormElicitation(runtimeKey: string): boolean {
  return Boolean(getRuntimeAdapterSpec(runtimeKey)?.interaction?.question_detector.form_elicitation);
}

/**
 * The question a `session/request_permission` actually is, or null for a tool
 * permission — which is every request unless the runtime's detector says a
 * request of this shape is its way of asking the person.
 */
export function permissionRequestQuestion(
  runtimeKey: string,
  params: Record<string, unknown>,
): AskedUser | null {
  const detector = getRuntimeAdapterSpec(runtimeKey)?.interaction?.question_detector;
  if (!detector?.permission_without_tool_call || recordOrNull(params.toolCall)) return null;
  const options = arrayOf(params.options).map(choiceLabel).filter(isString);
  return {
    question: text(params, "message") ?? text(params, "question") ?? text(params, "title")
      ?? "Which of these should I do?",
    options,
  };
}

/**
 * The question behind any other interactive request: an `elicitation/create`
 * form, or a method Rainver does not know. Always a question — the runtime is
 * waiting on an answer either way — even when its text cannot be read.
 */
export function interactiveRequestQuestion(
  runtimeKey: string,
  runtimeLabel: string,
  method: string,
  params: Record<string, unknown>,
): AskedUser {
  const schema = recordOrNull(params.requestedSchema);
  if (schema) return formQuestion(runtimeKey, params, schema);
  const question = text(params, "message") ?? text(params, "question") ?? text(params, "prompt")
    ?? text(params, "title");
  return {
    question: question
      ?? `${runtimeLabel} stopped to ask for input ('${method}') that Rainver cannot show here. What should it do?`,
    options: arrayOf(params.options).map(choiceLabel).filter(isString),
  };
}

function formQuestion(
  runtimeKey: string,
  params: Record<string, unknown>,
  schema: Record<string, unknown>,
): AskedUser {
  const questionText = getRuntimeAdapterSpec(runtimeKey)?.interaction?.question_detector
    .form_elicitation?.question_text;
  const message = text(params, "message");
  const fields = Object.values(recordOrNull(schema.properties) ?? {})
    .map(recordOrNull)
    .filter((field): field is Record<string, unknown> => field !== null && !isCompanionField(field));
  if (fields.length <= 1) {
    const field = fields[0] ?? {};
    const fieldText = questionText === "field_title"
      ? text(field, "title") ?? text(field, "description")
      : text(field, "description") ?? text(field, "title");
    return {
      question: (questionText === "field_title" ? fieldText ?? message : message ?? fieldText)
        ?? "What should I do next?",
      options: fieldChoices(field),
    };
  }
  // Several questions at once: each keeps its own choices, so they are
  // written out in full and no single option list applies.
  const lines = fields.map((field, index) => {
    const fieldText = questionText === "field_title"
      ? text(field, "title") ?? text(field, "description")
      : text(field, "description") ?? text(field, "title");
    const choices = fieldChoices(field).map((choice) => `   - ${choice}`);
    return [`${index + 1}. ${fieldText ?? `Question ${index + 1}`}`, ...choices].join("\n");
  });
  return {
    question: [message, ...lines].filter(isString).join("\n\n"),
    options: [],
  };
}

/**
 * Free-text boxes a runtime puts beside a question ("Other", Codex's note):
 * a way to answer it, not a question of their own.
 */
function isCompanionField(field: Record<string, unknown>): boolean {
  const meta = recordOrNull(field._meta) ?? {};
  return Boolean(recordOrNull(meta._askUserQuestionCustomAnswer))
    || recordOrNull(meta.codex)?.role === "user_note";
}

function fieldChoices(field: Record<string, unknown>): string[] {
  const items = recordOrNull(field.items) ?? {};
  const choices = [field.oneOf, field.anyOf, items.oneOf, items.anyOf, field.enum, items.enum]
    .find((candidate) => Array.isArray(candidate) && candidate.length > 0);
  return arrayOf(choices).map(choiceLabel).filter(isString);
}

function choiceLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const choice = recordOrNull(value);
  if (!choice) return null;
  const label = text(choice, "title") ?? text(choice, "label") ?? text(choice, "name")
    ?? (typeof choice.const === "string" && choice.const.trim() ? choice.const : null);
  if (!label) return null;
  const description = text(choice, "description");
  return description ? `${label} — ${description}` : label;
}

/** The question a finished Run asked, from its canonical output. */
export function askedUserFromRunOutput(outputJson: unknown): AskedUser | null {
  const asked = recordOrNull(runOutputResult(outputJson).asked_user);
  const question = asked ? text(asked, "question") : null;
  if (!asked || !question) return null;
  return { question, options: arrayOf(asked.options).filter(isNonEmptyString) };
}

/**
 * The reply a question turn leaves: whatever the Agent said before it asked,
 * then the question, then its options as a list.
 */
export function awaitingAnswerReply(asked: AskedUser, preamble: string | null): string {
  const question = [asked.question, asked.options.map((option) => `- ${option}`).join("\n")]
    .filter(Boolean)
    .join("\n\n");
  const said = preamble?.trim();
  return said && !said.endsWith(asked.question) ? `${said}\n\n${question}` : question;
}

function text(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isString(value: string | null): value is string {
  return value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
