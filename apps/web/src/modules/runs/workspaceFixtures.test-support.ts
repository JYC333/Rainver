import type {WorkspaceChangeView} from '@rainver/protocol'

export function workspaceChange(overrides:Partial<WorkspaceChangeView>={}):WorkspaceChangeView{
 return {change_set_id:'change',workspace_id:'workspace',generation:1,revision:2,workspace_location_id:'location',
  parent_workspace_id:null,target_ref:'refs/heads/dev',state:'open',summary:null,base_commit:'a'.repeat(40),
  source_commit:'b'.repeat(40),workspace_state:'ready',baseline_mode:'snapshot',cleanup_state:'pending',cleanup_errors:[],
  can_manage:true,integration_id:null,integration_revision:null,integration_status:null,attempt_id:null,
  onto_commit:null,candidate_commit:null,merged_commit:null,integration_detail:null,...overrides}
}
