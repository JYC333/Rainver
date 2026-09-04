import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";
import { JsonObjectSchema } from "./capabilities.js";

/**
 * One Agent turn, as an ordered list of parts.
 *
 * A turn happens in one of two places and leaves two different traces: a
 * managed Run writes `run_events`, a Run on a paired host writes
 * `host_thread_events`. Both are projected into these parts, so a surface that
 * renders a conversation never has to know which one it is looking at.
 *
 * The two logs do not carry the same amount, and the parts say so rather than
 * pretending otherwise:
 *
 * - **Text.** A host Run persists its assistant text; a managed Run does not
 *   (its deltas are an in-memory stream, and what survives is the final
 *   assistant message). So a replayed managed turn has one `text` part
 *   carrying the reply, while a replayed host turn has the segments as they
 *   arrived. Live, both stream deltas.
 * - **Reasoning, plan, tool input and output.** Only a host Run reports
 *   these. A managed Run's `tool_call` part therefore carries a name and a
 *   status but no input or output, and has no `reasoning` or `plan` parts at
 *   all.
 *
 * A renderer degrades on the missing fields; it must not present their
 * absence as a failure, because it is a capability difference between
 * backends rather than something that went wrong in this turn.
 */

export const TurnPartSourceSchema = z.enum(["run_events", "host_thread_events"]);
export type TurnPartSource = z.infer<typeof TurnPartSourceSchema>;

/**
 * Assistant prose.
 *
 * `streamed` marks the copy that exists only while the turn is running: a
 * managed Run's text is never written to its log, so it reaches a client from
 * the delta bus and is replaced by the persisted reply when the turn ends. It
 * is the one part whose position is not fixed by the projection, so a client
 * keeps it apart from the indexed list rather than at an index the next
 * projected part would claim.
 */
export const TextTurnPartSchema = z.object({
  type: z.literal("text"),
  index: z.number().int().nonnegative(),
  text: z.string(),
  streamed: z.boolean().optional(),
}).strict();

/** The model thinking out loud, where the backend reports it separately. */
export const ReasoningTurnPartSchema = z.object({
  type: z.literal("reasoning"),
  index: z.number().int().nonnegative(),
  text: z.string(),
}).strict();

/** ACP's four tool-call states, projected without collapsing pending into running. */
export const ToolCallStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/**
 * One tool the Agent used. `input` and `output` are null when the backend
 * does not report them, which is the managed case and also codex-acp, whose
 * adapter reports no result content.
 */
export const ToolCallTurnPartSchema = z.object({
  type: z.literal("tool_call"),
  index: z.number().int().nonnegative(),
  call_id: z.string().nullable(),
  name: z.string(),
  kind: z.string().nullable(),
  status: ToolCallStatusSchema,
  input: z.string().nullable(),
  output: z.string().nullable(),
}).strict();

/** The Agent's own checklist for the turn, as its latest snapshot. */
export const PlanTurnPartSchema = z.object({
  type: z.literal("plan"),
  index: z.number().int().nonnegative(),
  entries: z.array(z.object({
    content: z.string(),
    status: z.string(),
    priority: z.string().nullish(),
  }).strict()),
}).strict();

/** Something the runtime said about itself: stderr, a warning, a failure. */
export const DiagnosticTurnPartSchema = z.object({
  type: z.literal("diagnostic"),
  index: z.number().int().nonnegative(),
  level: z.enum(["info", "warning", "error"]),
  text: z.string(),
  error_code: z.string().nullable(),
}).strict();

/**
 * A change the Agent is asking for, and where its decision stands. The turn
 * shows it inline so the person can decide without leaving the conversation.
 */
export const ActionPreviewTurnPartSchema = z.object({
  type: z.literal("action_preview"),
  index: z.number().int().nonnegative(),
  action_id: z.string(),
  tool_call_id: z.string().nullable(),
  status: z.enum(["proposed", "auto_applied", "completed", "failed", "rejected"]),
  proposal_id: IdSchema.nullable(),
  proposal_type: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  risk_level: z.string().nullable(),
  scope: JsonObjectSchema.nullable(),
}).strict();

export const TurnPartSchema = z.discriminatedUnion("type", [
  TextTurnPartSchema,
  ReasoningTurnPartSchema,
  ToolCallTurnPartSchema,
  PlanTurnPartSchema,
  DiagnosticTurnPartSchema,
  ActionPreviewTurnPartSchema,
]);
export type TurnPart = z.infer<typeof TurnPartSchema>;
export type TextTurnPart = z.infer<typeof TextTurnPartSchema>;
export type ToolCallTurnPart = z.infer<typeof ToolCallTurnPartSchema>;
export type PlanTurnPart = z.infer<typeof PlanTurnPartSchema>;
export type DiagnosticTurnPart = z.infer<typeof DiagnosticTurnPartSchema>;
export type ActionPreviewTurnPart = z.infer<typeof ActionPreviewTurnPartSchema>;

/**
 * How far along the turn is, which decides how the bubble renders.
 *
 * `blocked` is a turn that has stopped and is waiting on a person — an
 * authorization it needs, a decision a supervisor owes it. It is not `working`
 * (nothing is happening) and not `failed` (nothing went wrong); saying either
 * would tell the reader the wrong thing about whether to act.
 */
export const TurnStateSchema = z.enum(["working", "blocked", "done", "failed"]);
export type TurnState = z.infer<typeof TurnStateSchema>;

export const RunTurnSchema = z.object({
  schema_version: z.literal("run_turn.v1"),
  run_id: IdSchema,
  state: TurnStateSchema,
  /** Which log this was projected from. For debugging, not for rendering. */
  source: TurnPartSourceSchema,
  parts: z.array(TurnPartSchema),
  /**
   * What the turn is waiting on, when it is `blocked`. `authorization` is a
   * specific request the person can approve; `run_decision` is a supervisor
   * review of the Run itself.
   */
  blocked_on: z.enum(["authorization", "run_decision"]).nullable(),
  /**
   * The highest event index this projection consumed. A stream resumes from
   * here rather than replaying the turn.
   */
  cursor: z.number().int().nonnegative(),
  updated_at: ISODateTimeSchema.nullable(),
}).strict();
export type RunTurn = z.infer<typeof RunTurnSchema>;

/** One frame of the live part stream. */
export const TurnStreamFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turn.snapshot"),
    turn: RunTurnSchema,
  }).strict(),
  z.object({
    type: z.literal("turn.part_appended"),
    run_id: IdSchema,
    cursor: z.number().int().nonnegative(),
    part: TurnPartSchema,
  }).strict(),
  z.object({
    /**
     * A part that replaces the one at its index — a tool call finishing, a
     * plan being revised, text growing as it streams.
     */
    type: z.literal("turn.part_updated"),
    run_id: IdSchema,
    cursor: z.number().int().nonnegative(),
    part: TurnPartSchema,
  }).strict(),
  z.object({
    type: z.literal("turn.state_changed"),
    run_id: IdSchema,
    state: TurnStateSchema,
    /**
     * Carried with the state, not separately: `blocked` on its own does not
     * say what the turn is waiting for, and a client that guessed would send
     * the person to the wrong place.
     */
    blocked_on: RunTurnSchema.shape.blocked_on,
  }).strict(),
]);
export type TurnStreamFrame = z.infer<typeof TurnStreamFrameSchema>;
