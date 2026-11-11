import {z} from 'zod';
import {ResearchResultAdoptionSchema} from './researchCalls.js';
const id=z.string().trim().min(1).max(36);
const receipt={id,space_id:id,project_id:id,thread_id:id};
/** Existing Agent Research tool inputs, unchanged; core-owned receipts replace the legacy echo. */
export const RESEARCH_AGENT_OPERATION_SCHEMAS={
 // Scope is the caller's to set. Do not replace it with a server constant:
 // the caller then has no way to say "only the last year" or "500 is enough"
 // except cancelling and starting over.
 'research.start_acquisition':{input:z.object({
  thread_id:z.string().min(1).describe("The Inquiry Thread id exactly as returned by inquiry.list_threads. Never invent, abbreviate, or derive one from the statement."),
  intent_note:z.string().trim().min(1).max(2000).optional(),
  max_items:z.number().int().min(1).max(2000).optional()
   .describe("How many of the newest matching items this pass reads. Defaults to 200. Raise it only when the user asks for more."),
  since:z.string().trim().min(1)
   .refine((value)=>!Number.isNaN(Date.parse(value)),"since must be an ISO date")
   .optional()
   .describe("ISO date; only material published on or after it is collected. Omit for all available history."),
 }).strict(),output:z.object({...receipt,operation_id:id.nullable(),status:z.enum(['queued','already_starting'])}).strict()},
 'research.adopt_result':{input:ResearchResultAdoptionSchema.extend({operation_id:z.string().min(1)}),output:z.object({...receipt,operation_id:id}).strict()},
} as const;
