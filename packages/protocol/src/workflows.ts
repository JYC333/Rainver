/**
 * Workflow framework contracts.
 *
 * A Workflow Definition is a validated node graph with a dependency chain. It
 * is the enforced-process side of the Skill/Workflow boundary.
 */

import { z } from "zod";
import { IdSchema } from "./common.js";
import { JsonObjectSchema } from "./capabilities.js";

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
