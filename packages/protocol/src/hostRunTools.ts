import { z } from "zod";
import { IdSchema } from "./common.js";

export const HOST_RUN_TOOL_REQUEST_LIMIT = 4 * 1024 * 1024;
export const HOST_RUN_TOOL_RESPONSE_LIMIT = 8 * 1024 * 1024;

const correlation = {
  request_id: z.string().uuid(),
  run_id: IdSchema,
  launch_id: IdSchema,
};
const actionId = z.string().min(1).max(256).refine((value) => !/[\/\\\x00-\x1f\x7f]/.test(value) && value !== "." && value !== "..");

export const HostRunToolRequestFrameSchema = z.object({
  type: z.literal("run_tool_request"),
  ...correlation,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("list") }).strict(),
    z.object({ kind: z.literal("describe"), action_id: actionId }).strict(),
    z.object({
      kind: z.literal("call"), action_id: actionId,
      idempotency_key: z.string().regex(/^[\x21-\x7e]{1,256}$/),
      arguments: z.record(z.unknown()),
    }).strict(),
  ]),
}).strict();

export const HostRunToolResultFrameSchema = z.object({
  type: z.literal("run_tool_result"),
  ...correlation,
  status: z.number().int().min(200).max(599),
  text: z.string().max(HOST_RUN_TOOL_RESPONSE_LIMIT),
  acknowledge: z.literal(true).optional(),
}).strict();

export const HostRunToolCancelFrameSchema = z.object({ type: z.literal("run_tool_cancel"), ...correlation }).strict();
export const HostRunToolResultAckFrameSchema = z.object({ type: z.literal("run_tool_result_ack"), ...correlation }).strict();

export type HostRunToolRequestFrame = z.infer<typeof HostRunToolRequestFrameSchema>;
export type HostRunToolResultFrame = z.infer<typeof HostRunToolResultFrameSchema>;
export type HostRunToolCancelFrame = z.infer<typeof HostRunToolCancelFrameSchema>;
export type HostRunToolResultAckFrame = z.infer<typeof HostRunToolResultAckFrameSchema>;
