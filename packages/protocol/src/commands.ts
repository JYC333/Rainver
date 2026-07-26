/**
 * Command envelopes — **contracts only, not handlers.**
 *
 * A command is a request to change state. These schemas define the *shape* of
 * that request on the wire. They do **not** execute anything, route to an
 * implementation, or imply a handler exists. The owning service decides and
 * applies the command; this package only describes the message.
 *
 * Each command is the generic {@link CommandEnvelopeSchema} narrowed to a literal
 * `type` and a concrete `payload`. Payload fields mirror the corresponding API
 * request bodies (snake_case), conservatively.
 *
 * Depends only on `./common` and `zod`.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";

/**
 * Generic command envelope. `payload` is `unknown` here; the per-command schemas
 * below narrow `type` + `payload`. `command_id` is a client-generated
 * idempotency key — it does not grant authority; the server still authenticates
 * and authorizes every command.
 */
export const CommandEnvelopeSchema = z.object({
  command_id: IdSchema,
  type: z.string(),
  issued_at: ISODateTimeSchema,
  space_id: IdSchema.nullish(),
  issued_by_user_id: IdSchema.nullish(),
  payload: z.unknown(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

function commandSchema<TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) {
  return z.object({
    command_id: IdSchema,
    type: z.literal(type),
    issued_at: ISODateTimeSchema,
    space_id: IdSchema.nullish(),
    issued_by_user_id: IdSchema.nullish(),
    payload,
  });
}

// ---------------------------------------------------------------------------
// Command type discriminators
// ---------------------------------------------------------------------------

export const CommandType = {
  CreateCapture: "activity.capture.create",
  ProcessActivity: "activity.process",
  ApproveProposal: "proposal.approve",
  RejectProposal: "proposal.reject",
  StartRun: "run.start",
} as const;
export type CommandTypeValue = (typeof CommandType)[keyof typeof CommandType];

// ---------------------------------------------------------------------------
// Payloads + command envelopes
// ---------------------------------------------------------------------------

/** Create a raw-input capture (mirror of `POST /activity`). */
export const CreateCapturePayloadSchema = z.object({
  space_id: IdSchema,
  activity_type: z.string(),
  title: z.string().nullish(),
  content: z.string().nullish(),
  source_url: z.string().nullish(),
  project_folder_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  occurred_at: ISODateTimeSchema.nullish(),
});
export const CreateCaptureCommandSchema = commandSchema(
  CommandType.CreateCapture,
  CreateCapturePayloadSchema,
);
export type CreateCaptureCommand = z.infer<typeof CreateCaptureCommandSchema>;

/** Request processing/consolidation of an existing activity record. */
export const ProcessActivityPayloadSchema = z.object({
  space_id: IdSchema,
  activity_id: IdSchema,
});
export const ProcessActivityCommandSchema = commandSchema(
  CommandType.ProcessActivity,
  ProcessActivityPayloadSchema,
);
export type ProcessActivityCommand = z.infer<typeof ProcessActivityCommandSchema>;

/** Approve a pending proposal (mirror of the proposals approve gate). */
export const ApproveProposalPayloadSchema = z.object({
  space_id: IdSchema,
  proposal_id: IdSchema,
  comment: z.string().nullish(),
});
export const ApproveProposalCommandSchema = commandSchema(
  CommandType.ApproveProposal,
  ApproveProposalPayloadSchema,
);
export type ApproveProposalCommand = z.infer<typeof ApproveProposalCommandSchema>;

/** Reject a pending proposal. */
export const RejectProposalPayloadSchema = z.object({
  space_id: IdSchema,
  proposal_id: IdSchema,
  reason: z.string().nullish(),
});
export const RejectProposalCommandSchema = commandSchema(
  CommandType.RejectProposal,
  RejectProposalPayloadSchema,
);
export type RejectProposalCommand = z.infer<typeof RejectProposalCommandSchema>;

/** Start an agent run (mirror of `POST /runs`). */
export const StartRunPayloadSchema = z.object({
  space_id: IdSchema,
  agent_id: IdSchema,
  instruction: z.string().nullish(),
  prompt: z.string().nullish(),
  project_folder_id: IdSchema.nullish(),
  session_id: IdSchema.nullish(),
  project_id: IdSchema.nullish(),
  context_artifact_ids: z.array(IdSchema).max(8).default([]),
});
export const StartRunCommandSchema = commandSchema(
  CommandType.StartRun,
  StartRunPayloadSchema,
);
export type StartRunCommand = z.infer<typeof StartRunCommandSchema>;

/** Discriminated union of all known commands, keyed on `type`. */
export const AnyCommandSchema = z.discriminatedUnion("type", [
  CreateCaptureCommandSchema,
  ProcessActivityCommandSchema,
  ApproveProposalCommandSchema,
  RejectProposalCommandSchema,
  StartRunCommandSchema,
]);
export type AnyCommand = z.infer<typeof AnyCommandSchema>;
