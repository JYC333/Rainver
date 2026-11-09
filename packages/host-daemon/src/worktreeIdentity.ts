import { ExecutionWorkspaceRefSchema, type ExecutionWorkspaceRef } from '@rainver/protocol';

const WORKSPACE_KEY = /^workspace:([0-9a-f-]{36}):([1-9][0-9]*)(?::integration:([0-9a-f-]{36}))?$/;
/** Mechanical owner key, never a Task id in the database or wire protocol. */
export function workspaceWorktreeKey(ref: ExecutionWorkspaceRef): string {
  const parsed = ExecutionWorkspaceRefSchema.parse(ref);
  return `workspace:${parsed.id}:${parsed.generation}${parsed.integration_id?`:integration:${parsed.integration_id}`:""}`;
}
export function workspaceIdentity(key:string):ExecutionWorkspaceRef|null {
  const match=WORKSPACE_KEY.exec(key);
  if(!match)return null;
  const parsed=ExecutionWorkspaceRefSchema.safeParse({id:match[1],generation:Number(match[2]),...(match[3]?{integration_id:match[3]}:{})});
  return parsed.success?parsed.data:null;
}
export function ownedBranchName(key:string):string {
  const workspace=workspaceIdentity(key);
  return workspace?`rainver/workspace-${workspace.id}-g${workspace.generation}${workspace.integration_id?`-integration-${workspace.integration_id}`:""}`:`rainver/task-${key}`;
}

/** One Run may touch several repositories; receipts must remain disjoint. */
export const workspaceRunKey=(runId:string,ref:ExecutionWorkspaceRef)=>`${runId}:${ref.id}:g${ref.generation}`;
