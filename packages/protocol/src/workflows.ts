/**
 * Workflow framework contracts.
 *
 * Workflow templates compose capabilities. Project workflow profiles are saved
 * project-scoped presets; callers may also build run drafts directly from a
 * template without saving a preset.
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema } from "./common.js";
import { JsonObjectSchema } from "./capabilities.js";

export const WorkflowTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    capability_ids: z.array(z.string().min(1)),
    input_schema_json: JsonObjectSchema,
    default_config_json: JsonObjectSchema,
    output_artifact_types: z.array(z.string().min(1)),
    proposal_policy: JsonObjectSchema,
    recommended_runtime_adapters: z.array(z.string().min(1)),
    execution_shape: z.enum([
      "conversational",
      "structured_generation",
      "agentic_files",
      "code_execution",
    ]).default("structured_generation"),
    required_capabilities: z.array(z.string().min(1)).default([]),
    required_tools: z.array(z.string().min(1)).default([]),
    prompt_asset_keys: z.array(z.string().min(1)).default([]),
  })
  .passthrough();
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

export const WorkflowNodeInputBindingSchema = z
  .object({
    name: z.string().min(1),
    from_node: z.string().min(1),
    source: z.enum(["output_text", "output_json", "artifact"]),
    json_pointer: z.string().startsWith("/").optional(),
    artifact_type: z.string().min(1).optional(),
    required: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === "output_json" && !value.json_pointer) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "output_json bindings require json_pointer", path: ["json_pointer"] });
    }
    if (value.source !== "output_json" && value.json_pointer !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "json_pointer is only valid for output_json bindings", path: ["json_pointer"] });
    }
    if (value.source === "artifact" && !value.artifact_type) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifact bindings require artifact_type", path: ["artifact_type"] });
    }
    if (value.source !== "artifact" && value.artifact_type !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifact_type is only valid for artifact bindings", path: ["artifact_type"] });
    }
  });
export type WorkflowNodeInputBinding = z.infer<typeof WorkflowNodeInputBindingSchema>;

export const WorkflowNodeSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    depends_on: z.array(z.string().min(1)).default([]),
    input_bindings: z.array(WorkflowNodeInputBindingSchema).default([]),
    capability_id: z.string().min(1).nullish(),
    prompt_asset_key: z.string().min(1).nullish(),
    agent_id: IdSchema.nullish(),
    runtime_profile_id: IdSchema.nullish(),
    verification_recipe_refs: z.array(z.string().min(1)).default([]),
    approval_checkpoint: z
      .object({
        required: z.boolean().default(false),
        proposal_type: z.string().min(1).nullish(),
      })
      .default({ required: false }),
    contract_json: JsonObjectSchema.default({}),
    metadata_json: JsonObjectSchema.default({}),
  })
  .passthrough();
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

/** Versioned content stored in evolvable_asset_versions for workflow assets. */
export const WorkflowDefinitionSchema = z
  .object({
    schema_version: z.literal("workflow_definition.v1"),
    workflow_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    input_schema_json: JsonObjectSchema,
    output_artifact_types: z.array(z.string().min(1)),
    nodes: z.array(WorkflowNodeSchema).min(1).max(30),
    metadata_json: JsonObjectSchema.default({}),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const node of value.nodes) {
      if (ids.has(node.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate workflow node id '${node.id}'`, path: ["nodes"] });
      }
      ids.add(node.id);
    }
    for (const node of value.nodes) {
      for (const dependency of node.depends_on) {
        if (dependency === node.id || !ids.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workflow node '${node.id}' depends on unknown or itself: '${dependency}'`,
            path: ["nodes"],
          });
        }
      }
      const bindingNames = new Set<string>();
      for (const binding of node.input_bindings) {
        if (!node.depends_on.includes(binding.from_node)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workflow node '${node.id}' input '${binding.name}' must reference a direct dependency`,
            path: ["nodes"],
          });
        }
        if (bindingNames.has(binding.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate input binding '${binding.name}' on node '${node.id}'`, path: ["nodes"] });
        }
        bindingNames.add(binding.name);
      }
    }
    const byId = new Map(value.nodes.map((node) => [node.id, node]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      if (visiting.has(nodeId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `workflow definition contains a dependency cycle at '${nodeId}'`, path: ["nodes"] });
        return;
      }
      visiting.add(nodeId);
      for (const dependency of byId.get(nodeId)?.depends_on ?? []) visit(dependency);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    for (const node of value.nodes) visit(node.id);
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const ProjectWorkflowProfileSchema = z
  .object({
    id: IdSchema,
    space_id: IdSchema,
    project_id: IdSchema,
    workflow_template_id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    config_json: JsonObjectSchema,
    created_by_user_id: IdSchema.nullish(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .passthrough();
export type ProjectWorkflowProfile = z.infer<
  typeof ProjectWorkflowProfileSchema
>;

export const WorkflowRunDraftRequestSchema = z
  .object({
    // The agent that will own the run. A workflow preset does not bind an
    // agent, so the caller chooses one; when omitted the draft is not directly
    // executable and emits the `agent_required_to_execute_run_draft` warning.
    agent_id: IdSchema.nullish(),
    runtime_profile_id: IdSchema.nullish(),
    prompt: z.string().nullish(),
    instruction: z.string().nullish(),
    project_folder_id: IdSchema.nullish(),
    session_id: IdSchema.nullish(),
    config_json: JsonObjectSchema.optional(),
  })
  .strict();
export type WorkflowRunDraftRequest = z.infer<
  typeof WorkflowRunDraftRequestSchema
>;

export const WorkflowRunCreateBodyDraftSchema = z
  .object({
    mode: z.literal("live"),
    run_type: z.literal("agent"),
    trigger_origin: z.literal("manual"),
    project_id: IdSchema,
    workflow_template_id: z.string().min(1),
    workflow_config_json: JsonObjectSchema,
    // Target agent for `POST /api/v1/agents/:agentId/runs`; null until the
    // caller selects one.
    agent_id: IdSchema.nullable(),
    runtime_profile_id: IdSchema.nullish(),
    project_folder_id: IdSchema.nullish(),
    session_id: IdSchema.nullish(),
    prompt: z.string().min(1),
    instruction: z.string().nullish(),
    capability_id: z.string().min(1).nullish(),
    capabilities_json: z.array(z.string().min(1)).default([]),
    prompt_asset_key: z.string().min(1).nullish(),
    prompt_version_id: IdSchema.nullish(),
    prompt_content_hash: z.string().nullish(),
  })
  .passthrough();
export type WorkflowRunCreateBodyDraft = z.infer<
  typeof WorkflowRunCreateBodyDraftSchema
>;

export const WorkflowRunDraftResponseSchema = z
  .object({
    workflow_template: WorkflowTemplateSchema,
    workflow_profile: ProjectWorkflowProfileSchema.nullable(),
    capability_ids: z.array(z.string().min(1)),
    output_artifact_types: z.array(z.string().min(1)),
    config_json: JsonObjectSchema,
    run_create_body: WorkflowRunCreateBodyDraftSchema,
    warnings: z.array(z.string().min(1)),
  })
  .passthrough();
export type WorkflowRunDraftResponse = z.infer<
  typeof WorkflowRunDraftResponseSchema
>;
