import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
export const RESEARCH_EXECUTION_SCHEMAS={
 'research.report.snapshot':{input:z.object({project_id:id}).strict(),output:z.object({id,space_id:id,project_id:id}).strict()},
} as const;
export const RESEARCH_EXECUTION_TITLES:Record<keyof typeof RESEARCH_EXECUTION_SCHEMAS,string>={
 'research.report.snapshot':'Queue an immutable Research report snapshot',
};
