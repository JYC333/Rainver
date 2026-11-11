import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
/** Admission only: the claimed batch is extracted and proposed by its Job. */
export const IMPORTED_HISTORY_EXTRACTION_SCHEMAS={
 'project.imported_sessions.extract':{
  input:z.object({project_id:id}).strict(),
  output:z.object({id,project_id:id,space_id:id,job_id:id.nullable(),records_claimed:z.number().int().nonnegative()}).strict(),
 },
} as const;
export const IMPORTED_HISTORY_EXTRACTION_TITLES:Record<keyof typeof IMPORTED_HISTORY_EXTRACTION_SCHEMAS,string>={
 'project.imported_sessions.extract':'Queue extraction of shared imported history into reviewable proposals',
};
