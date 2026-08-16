/**
 * Capability framework contracts.
 *
 * Schemas only. Runtime execution, persistence, and import authority live in the
 * server modules that register routes.
 */

import { z } from "zod";
import { IdSchema } from "./common.js";

export const JsonObjectSchema = z.record(z.unknown());

export const CapabilitySourceKindSchema = z.enum([
  "builtin",
  "imported_skill",
  "generated",
  "official",
]);
export type CapabilitySourceKind = z.infer<typeof CapabilitySourceKindSchema>;

export const CapabilityStatusSchema = z.enum([
  "draft",
  "proposed",
  "testing",
  "available",
  "enabled",
  "disabled",
  "archived",
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const RuntimeRenderModeSchema = z.enum([
  "render_skill",
  "inline_prompt",
  "native_executor",
  "mcp_tool",
]);
export type RuntimeRenderMode = z.infer<typeof RuntimeRenderModeSchema>;

export const CapabilityRuntimeBindingSchema = z
  .object({
    id: IdSchema,
    capability_id: z.string().min(1),
    runtime_adapter_type: z.string().min(1),
    render_mode: RuntimeRenderModeSchema,
    binding_json: JsonObjectSchema,
    enabled: z.boolean(),
  })
  .passthrough();
export type CapabilityRuntimeBinding = z.infer<
  typeof CapabilityRuntimeBindingSchema
>;

export const CapabilityDefinitionSchema = z
  .object({
    id: z.string().min(1),
    namespace: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    version: z.string().min(1),
    source_kind: CapabilitySourceKindSchema,
    input_schema_json: JsonObjectSchema,
    output_artifact_types: z.array(z.string().min(1)),
    permissions: JsonObjectSchema,
    supported_execution_modes: z.array(z.string().min(1)),
    default_runtime_bindings: z.array(CapabilityRuntimeBindingSchema),
    status: CapabilityStatusSchema,
  })
  .passthrough();
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;

export const CapabilityPackDescriptorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    version: z.string().min(1),
    capability_ids: z.array(z.string().min(1)),
    artifact_types: z.array(z.string().min(1)),
    source_kind: CapabilitySourceKindSchema,
    status: CapabilityStatusSchema,
  })
  .passthrough();
export type CapabilityPackDescriptor = z.infer<
  typeof CapabilityPackDescriptorSchema
>;

