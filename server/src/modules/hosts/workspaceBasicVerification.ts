import type {HostLaunchWorkspaceAccess,LaunchWorkspace} from '@rainver/protocol';
import type {HostConnectionRegistry} from './connectionRegistry.js';
import type {WorkspaceVerificationOutcome} from '../runs/verification/engine.js';
import {workspaceHostFailureIsTemporary} from '../projectFolders/workspacePolicy.js';
import {JobDeferredError} from '../jobs/handlerRegistry.js';
import {redactEvidenceText} from '../runs/evidenceRedaction.js';

/** Used only after the assigned Agent inspected the repository and explicitly
 * reported no applicable project checks. It never represents project tests. */
export async function verifyBasicWorkspaceCandidate(hosts:HostConnectionRegistry,input:{hostId:string;runId:string;workspace:LaunchWorkspace;mounts:HostLaunchWorkspaceAccess[];onto:string;candidate:string}):Promise<WorkspaceVerificationOutcome>{
 const result=await hosts.runHostCommand(input.hostId,{run_id:input.runId,workspace:input.workspace,workspace_access:input.mounts,
  command:['git','diff','--check',input.onto,input.candidate,'--'],timeout_seconds:60});
 if(!result.ok&&workspaceHostFailureIsTemporary(result.error))throw new JobDeferredError(result.error!,30000);
 const passed=result.ok&&result.exit_code===0&&!result.timed_out;
 return {status:passed?'passed':'failed',level:'basic',checks:[{verifier_type:'command',key:'candidate:diff_check',status:passed?'passed':'failed',
  summary:passed?'Exact candidate passed basic Git integrity checks; no project checks were declared.':`Candidate integrity check failed: ${(redactEvidenceText(result.stderr||result.stdout||result.error||'command failed')??'command failed').slice(0,1500)}`} ]};
}
