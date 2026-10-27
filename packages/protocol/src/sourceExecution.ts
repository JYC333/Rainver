/** Sources-only execution contract. No host paths, shell, environment or credentials. */
import { z } from "zod";
import { IdSchema } from "./common.js";

export const SourceExecutionLimitsSchema = z.object({
  wall_ms: z.number().int().min(100).max(300_000),
  memory_bytes: z.number().int().min(64 * 1024 * 1024).max(1024 * 1024 * 1024),
  cpu_quota_percent: z.number().int().min(1).max(100),
  processes: z.number().int().min(32).max(32),
  output_bytes: z.number().int().min(1).max(8 * 1024 * 1024),
  requests: z.number().int().min(1).max(1000),
}).strict();
export const SourceExecutionSchema = z.object({
  execution_id: IdSchema,
  version_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  code: z.string().min(1).max(256 * 1024),
  input_json: z.string().max(1024 * 1024).refine(s=>new TextEncoder().encode(s).byteLength<=1024*1024,"Input exceeds 1MiB"),
  limits: SourceExecutionLimitsSchema,
  collection: z.object({
    collection_id: z.string().uuid(),
    authorization_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    seeds: z.array(z.string().url().max(8192)).min(1).max(100),
    max_items: z.number().int().min(1).max(1000),
  }).strict().optional(),
}).strict();
/** Identity is bound to the parent channel, never supplied by the child. */
export const SourceRequestSchema = z.object({
  sequence: z.number().int().min(1).max(1000),
  url: z.string().url().max(8192),
  method: z.enum(["GET", "HEAD"]),
  headers: z.object({"if-none-match":z.string().max(1024).optional(),"if-modified-since":z.string().max(128).optional(),accept:z.string().max(256).optional()}).strict().optional(),
}).strict();
export const SourceResponseSchema = z.object({
  sequence: z.number().int().positive(),
  status: z.number().int().min(100).max(599),
  body_base64: z.string().max(12 * 1024 * 1024)
    .refine(s=>s.length%4===0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s),"Invalid base64")
    .refine(s=>s.length/4*3-(s.endsWith("==")?2:s.endsWith("=")?1:0)<=8*1024*1024,"Body exceeds 8MiB"),
  content_type: z.string().max(256),
  final_url: z.string().max(8192).optional(),
  retry_at:z.string().datetime().optional(),
  headers: z.record(z.enum(["etag","last-modified","link"]),z.string().max(4096)).optional(),
}).strict();
export type SourceExecution = z.infer<typeof SourceExecutionSchema>;
export type SourceRequest = z.infer<typeof SourceRequestSchema>;
export type SourceResponse = z.infer<typeof SourceResponseSchema>;

export const SourceExecutionResultSchema = z.object({
  status: z.enum(["succeeded", "refused", "failed", "cancelled", "timed_out"]),
  output_json: z.string().max(8 * 1024 * 1024).nullable(),
  error: z.string().max(128).nullable(),
  retry_at: z.string().datetime().optional(),
}).strict();
export const HostSourceExecuteFrameSchema = z.object({ type: z.literal("source_execute"), execution: SourceExecutionSchema }).strict();
export const HostSourceCancelFrameSchema = z.object({ type: z.literal("source_cancel"), execution_id: IdSchema }).strict();
export const HostSourceResponseFrameSchema = z.object({ type: z.literal("source_response"), execution_id: IdSchema, response: SourceResponseSchema }).strict();
export const HostSourceRequestFrameSchema = z.object({ type: z.literal("source_request"), execution_id: IdSchema, request: SourceRequestSchema }).strict();
export const HostSourceResultFrameSchema = z.object({ type: z.literal("source_result"), execution_id: IdSchema, result: SourceExecutionResultSchema }).strict();
export type SourceExecutionResult = z.infer<typeof SourceExecutionResultSchema>;

export const HostSourceRejectedFrameSchema=z.object({type:z.literal("source_rejected"),execution_id:IdSchema,error:z.literal("source_duplicate_execution")}).strict();
