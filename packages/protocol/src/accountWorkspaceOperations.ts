import {z} from 'zod';
const id=z.string().min(1).max(36);
export const DaemonWorkspaceSchema=z.object({
  id,project_id:id,name:z.string(),display_path:z.string().nullable(),host_kind:z.literal('remote'),
  root_path:z.null(),registered_from:z.literal('daemon_registered'),created_at:z.string(),
}).strict();
export const ACCOUNT_OPERATION_SCHEMAS={
  'auth.user.disable':{input:z.object({user_id:id}).strict(),output:z.object({user_id:id,ok:z.literal(true)}).strict()},
  'auth.user.enable':{input:z.object({user_id:id}).strict(),output:z.object({user_id:id,ok:z.literal(true)}).strict()},
} as const;
export const DAEMON_WORKSPACE_OPERATION_SCHEMAS={
  'host.workspace.create':{input:z.object({project_id:id,name:z.string().trim().min(1).max(120),display_path:z.string().max(1024).nullable().optional()}).strict(),output:DaemonWorkspaceSchema.extend({space_id:id,folder_id:id}).strict()},
  'host.workspace.remove':{input:z.object({location_id:id}).strict(),output:z.object({id,space_id:id,project_id:id,folder_id:id,host_id:id,removed:z.literal(true)}).strict()},
} as const;
