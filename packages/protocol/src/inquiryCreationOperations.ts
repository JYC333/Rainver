import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
const text=z.string().trim().nullable().default(null);
/** Human selection -> ordinary Inquiry structure, not Wiki promotion. */
export const NoteQuestionInputSchema=z.object({
  project_id:id,note_object_id:id,statement:z.string().trim().min(1),
  kind:z.enum(['question','hypothesis']).default('question'),
  link_kind:z.enum(['linked_note','primary_working_note']).default('linked_note'),
  primary_parent_id:id.nullable().default(null),
  producer_idempotency_key:z.string().trim().min(1).max(128).nullable().default(null),
  answerability:text,resolution_criteria:text,proposed_claim:text,predictions:text,falsification_criteria:text,
}).strict();
export const NoteQuestionReceiptSchema=z.object({thread_id:id,project_id:id,note_object_id:id,kind:z.enum(['question','hypothesis'])}).strict();

/** Ordinary human Thread creation is distinct from the Agent's origin-gated tool. */
export const InquiryThreadCreateInputSchema=NoteQuestionInputSchema.omit({note_object_id:true,link_kind:true}).extend({kind:z.enum(['question','hypothesis'])}).strict();
export const InquiryThreadCreateReceiptSchema=NoteQuestionReceiptSchema.omit({note_object_id:true}).strict();
