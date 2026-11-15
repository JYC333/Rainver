import {join} from 'node:path';
import {HostWorkspaceLaunchReportSchema,type ExecutionWorkspaceRef,type HostWorkspaceLaunchReport} from '@rainver/protocol';
import {writeJsonDurable} from './durableFile.js';
import {configDir} from './config.js';
import {readJson,writeJson} from './taskWorktree.js';
import {workspaceRunKey} from './worktreeIdentity.js';

export async function reserveWorkspaceLaunch(locationId:string,key:string,floor=0){
 const path=join(configDir(),'workspace-sequences',locationId,`${key}.json`),counter=await readJson(path);
 const sequence=Math.max(Number(counter?.sequence??0),floor)+1;
 if(!Number.isSafeInteger(sequence)||sequence>2147483647)throw new Error('workspace_sequence_exhausted');
 await writeJson(path,{sequence});return sequence;
}

export async function writeWorkspaceLaunch(runId:string,ref:ExecutionWorkspaceRef,report:HostWorkspaceLaunchReport&{launch_sequence:number}){
 const directory=join(configDir(),'workspace-launches');
 // Immutable per-launch evidence precedes the backwards-compatible latest pointer.
 await writeJsonDurable(join(directory,`${workspaceRunKey(runId,ref,report.launch_sequence)}.json`),report);
 await writeJsonDurable(join(directory,`${workspaceRunKey(runId,ref)}.json`),report);
}

export async function readWorkspaceLaunch(runId:string,ref:ExecutionWorkspaceRef,sequence?:number){
 const directory=join(configDir(),'workspace-launches'),base=workspaceRunKey(runId,ref);
 const latest=await readJson(join(directory,`${base}.json`));
 const number=sequence??(typeof latest?.launch_sequence==='number'?latest.launch_sequence:undefined);
 const versioned=number===undefined?null:await readJson(join(directory,`${workspaceRunKey(runId,ref,number)}.json`));
 const parsed=HostWorkspaceLaunchReportSchema.safeParse(versioned??latest);
 if(!parsed.success||parsed.data.id!==ref.id||parsed.data.generation!==ref.generation||sequence!==undefined&&parsed.data.launch_sequence!==sequence)return null;
 return {report:parsed.data,runKey:versioned?workspaceRunKey(runId,ref,number):base};
}
