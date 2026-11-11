import {z} from 'zod';
/** A content-free invalidation. The route supplies scope; normal readers still
 * enforce every content gate. There is no per-keystroke payload or revision log. */
export const ProjectUpdateFrameSchema=z.object({type:z.enum(['ready','changed','denied'])}).strict();
export type ProjectUpdateFrame=z.infer<typeof ProjectUpdateFrameSchema>;
