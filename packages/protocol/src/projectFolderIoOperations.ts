import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
const project={project_id:id};
const folder={...project,folder_id:id};
export const ProjectFolderIoReceiptSchema=z.object({id,space_id:id,project_id:id,folder_id:id.nullable(),job_id:id}).strict();
export const PROJECT_FOLDER_IO_SCHEMAS={
  'project.folder.create':{input:z.object({...project,name:z.string().trim().min(1).max(256),description:z.string().trim().nullable().default(null),kind:z.enum(['code','data','docs']).default('code'),is_primary:z.boolean().default(false),repo_url:z.string().trim().min(1).nullable().default(null),root_path:z.string().trim().min(1).nullable().default(null),default_branch:z.string().trim().max(256).nullable().default(null),metadata_json:z.record(z.unknown()).nullable().default(null)}).strict(),output:ProjectFolderIoReceiptSchema},
  'project.folder.scan':{input:z.object(project).strict(),output:ProjectFolderIoReceiptSchema},
  'project.folder.draft.save':{input:z.object({...folder,draft_id:id,draft_version:z.number().int().positive(),confirm_mixed_line_ending_normalization:z.boolean().default(false)}).strict(),output:ProjectFolderIoReceiptSchema},
  'project.folder.revision.restore':{input:z.object({...folder,revision_id:id}).strict(),output:ProjectFolderIoReceiptSchema},
}as const;
export const PROJECT_FOLDER_IO_TITLES:Record<keyof typeof PROJECT_FOLDER_IO_SCHEMAS,string>={
  'project.folder.create':'Create or connect a Project Folder',
  'project.folder.scan':'Scan the managed Space root for connectable directories',
  'project.folder.draft.save':'Save an exact private draft version to its Folder',
  'project.folder.revision.restore':'Restore a retained file revision as a private draft',
};
const revision=z.object({id,project_folder_id:id,workspace_location_id:id,path:z.string(),before_exists:z.boolean(),after_exists:z.boolean(),after_sha256:z.string().nullable(),created_at:z.string(),expires_at:z.string(),status:z.enum(['available','rolled_back','pruned'])}).strict();
export const ProjectFolderIoStatusSchema=ProjectFolderIoReceiptSchema.extend({
  kind:z.enum(['create','scan','save_draft','restore_revision']),status:z.enum(['pending','prepared','applied','succeeded','failed','needs_attention']),
  error:z.object({code:z.string(),metadata:z.record(z.unknown())}).strict().nullable(),
  result:z.union([
    z.object({kind:z.literal('create'),folder_id:id}).strict(),
    z.object({kind:z.literal('scan'),items:z.array(z.object({name:z.string(),path:z.string()}).strict())}).strict(),
    z.object({kind:z.literal('save_draft'),folder_id:id,workspace_location_id:id,path:z.string(),revision,draft_deleted:z.boolean(),newer_draft_retained:z.boolean(),after_sha256:z.string()}).strict(),
    z.object({kind:z.literal('restore_revision'),draft_id:id,workspace_location_id:id,version:z.number().int().positive()}).strict(),
  ]).nullable(),
}).strict();
export type ProjectFolderIoStatus=z.infer<typeof ProjectFolderIoStatusSchema>;
