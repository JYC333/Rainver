import {z} from "zod";
import {BoardColumnSelectionSchema} from "./projectWork.js";
export const TaskCreateInputSchema = z.object({
  /**
   * Optional, and only ever the Run's own Project. It is accepted so a model
   * can state what it believes it is doing and be told when that disagrees,
   * rather than silently writing somewhere else.
   */
  project_id: z.string().min(1).optional(),
  board_column: BoardColumnSelectionSchema.optional(),
  title: z.string().trim().min(1).max(512),
  description: z.string().trim().max(20_000).nullable().optional(),
  acceptance_criteria_json: z.record(z.string(), z.unknown()).nullable().optional(),
  definition_of_done: z.string().trim().max(4_000).nullable().optional(),
  required_outputs: z.array(z.string().trim().min(1).max(64)).max(20).optional().describe("Only concrete file Artifact type labels that must be collected as deliverables. Do not use for a reply, report, check result, workspace edit, or filename; omit it for those Tasks."),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  risk_level: z.enum(["low", "medium", "high", "critical"]).optional(),
  /** The scheduling fields; timing the person gave belongs here, not in the description. */
  due_at: z.string().trim().min(1).max(64).nullable().optional().describe("When the Task is due, as an ISO 8601 date or datetime."),
  start_after: z.string().trim().min(1).max(64).nullable().optional().describe("The earliest the Task should start, as an ISO 8601 date or datetime."),
  links: z.array(z.object({
    entity_type: z.string().trim().min(1).max(32),
    entity_id: z.string().min(1),
    role: z.enum(["executes", "investigates", "prepares", "references"]),
  })).max(20).optional(),
}).strict();

export const ProblemTaskLinkFieldsSchema=z.object({
 idempotency_key:z.string().min(1).max(100),reason:z.string().trim().min(1).max(4000),
 role:z.enum(["executes","investigates","prepares","references"]),
 task_id:z.string().min(1).optional(),task:TaskCreateInputSchema.optional(),
}).strict();
export const ProblemTaskLinkRequestSchema=ProblemTaskLinkFieldsSchema.refine(v=>Boolean(v.task_id)!==Boolean(v.task),"Supply exactly one existing task_id or new task");
