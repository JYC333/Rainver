/**
 * Canonical model contracts — provider-agnostic shapes for LLM invocation and
 * **streaming events**. Contracts only: this package provides no model client,
 * no transport, no agent loop, no authority. Provider/runtime code maps to and
 * from these shapes so streaming and runtime-host surfaces speak one event
 * vocabulary across providers.
 *
 * Field names stay lockstep with what the provider API emits:
 * usage is `input_tokens`/`output_tokens`/`total_tokens`, streamed text is a
 * `delta`, and termination carries a `finish_reason`. Coded string fields
 * (roles, finish reasons) stay permissive per `common.ts` philosophy.
 *
 * Depends only on `./common` and `zod`.
 */

import { z } from "zod";
import { ISODateTimeSchema } from "./common.js";

// ---------------------------------------------------------------------------
// Messages, tools, usage
// ---------------------------------------------------------------------------

/** Documented role values. Message `role` stays a permissive string. */
export const MODEL_ROLE_VALUES = ["system", "user", "assistant", "tool"] as const;
export type ModelRoleValue = (typeof MODEL_ROLE_VALUES)[number];
export function isModelRole(value: string): value is ModelRoleValue {
  return (MODEL_ROLE_VALUES as readonly string[]).includes(value);
}

/** A tool invocation requested by the model (arguments kept as raw JSON text). */
export const CanonicalToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** JSON-encoded arguments exactly as the provider produced them. */
  arguments_json: z.string(),
});
export type CanonicalToolCall = z.infer<typeof CanonicalToolCallSchema>;

export const CanonicalMessageSchema = z.object({
  role: z.string().min(1),
  /** Text content; `null` for assistant messages that only carry tool calls. */
  content: z.string().nullable(),
  tool_calls: z.array(CanonicalToolCallSchema).optional(),
  /** For `role: "tool"` result messages — the tool call being answered. */
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});
export type CanonicalMessage = z.infer<typeof CanonicalMessageSchema>;

/** A tool offered to the model. `input_schema` is a JSON Schema document. */
export const CanonicalToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
});
export type CanonicalToolDefinition = z.infer<typeof CanonicalToolDefinitionSchema>;

/** Token usage as serialised by the provider facade. */
export const CanonicalUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
});
export type CanonicalUsage = z.infer<typeof CanonicalUsageSchema>;

/** Provider-reported usage for one concrete model within a generation. */
export const CanonicalModelUsageSchema = z.object({
  model: z.string().min(1),
  usage: CanonicalUsageSchema,
});
export type CanonicalModelUsage = z.infer<typeof CanonicalModelUsageSchema>;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const CanonicalModelRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(CanonicalMessageSchema).min(1),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(CanonicalToolDefinitionSchema).optional(),
  stream: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

/**
 * Model stream event discriminators. Dot-namespaced like the domain
 * `EventType` values in `events.ts`, under the `model.` prefix.
 */
export const ModelEventType = {
  MessageStart: "model.message_start",
  TextDelta: "model.text_delta",
  ToolCallDelta: "model.tool_call_delta",
  Usage: "model.usage",
  MessageStop: "model.message_stop",
  Error: "model.error",
} as const;

export const ModelMessageStartEventSchema = z.object({
  type: z.literal(ModelEventType.MessageStart),
  /** Resolved model id, when the provider reports it. */
  model: z.string().optional(),
  occurred_at: ISODateTimeSchema.optional(),
});

export const ModelTextDeltaEventSchema = z.object({
  type: z.literal(ModelEventType.TextDelta),
  delta: z.string(),
});

/** Incremental tool-call assembly; `index` correlates deltas of one call. */
export const ModelToolCallDeltaEventSchema = z.object({
  type: z.literal(ModelEventType.ToolCallDelta),
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments_delta: z.string().optional(),
});

export const ModelUsageEventSchema = z.object({
  type: z.literal(ModelEventType.Usage),
  usage: CanonicalUsageSchema,
});

export const ModelMessageStopEventSchema = z.object({
  type: z.literal(ModelEventType.MessageStop),
  /** Provider finish reason (e.g. `stop`, `length`, `tool_calls`); permissive. */
  finish_reason: z.string().nullable().optional(),
});

export const ModelErrorEventSchema = z.object({
  type: z.literal(ModelEventType.Error),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/** Any canonical model stream event, discriminated on `type`. */
export const CanonicalModelEventSchema = z.discriminatedUnion("type", [
  ModelMessageStartEventSchema,
  ModelTextDeltaEventSchema,
  ModelToolCallDeltaEventSchema,
  ModelUsageEventSchema,
  ModelMessageStopEventSchema,
  ModelErrorEventSchema,
]);
export type CanonicalModelEvent = z.infer<typeof CanonicalModelEventSchema>;
