import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
export const NoteControlTargetSchema=z.object({note_id:id}).strict();
export const NoteRollbackInputSchema=NoteControlTargetSchema.extend({to_version:z.number().int().positive(),expect_version:z.number().int().positive().nullable().default(null)}).strict();
/** A mutation receipt; bodies/history remain behind the canonical Note reader. */
export const NoteControlReceiptSchema=z.object({id,space_id:id,version:z.number().int().positive()}).strict();
