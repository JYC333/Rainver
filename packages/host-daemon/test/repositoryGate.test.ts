import {mkdtemp,mkdir,writeFile,rm,realpath,readFile,symlink,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {loadConfig,saveConfig} from '../src/config.js';
import {branchAlignBarriers,executeGitBranchAlign,recoverBranchAlignments} from '../src/gitBranchAlign.js';
import {resetQuarantineCacheForTest} from '../src/branchAlignState.js';
import {writeJsonDurable} from '../src/durableFile.js';
import {handleLaunch,type LaunchFrame} from '../src/execution.js';
import {runHostCommand} from '../src/commandRun.js';
import {registerWorkspace} from '../src/remoteWorkspaceOps.js';
import {taskLeaseKey,withTaskHeld} from '../src/taskWorktree.js';
import type {HostServerFrameOf} from '@rainver/protocol';

let sandbox:string,root:string,other:string,config:string,server:Server;
const LOCATION='folder-align',OTHER='folder-other';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
async function commit(dir:string,file:string,text:string,message:string){await writeFile(join(dir,file),text);git(dir,'add',file);git(dir,'commit','-qm',message);return git(dir,'rev-parse','HEAD');}
async function initRepo(dir:string){
 await mkdir(dir,{recursive:true});
 git(dir,'init','-q','-b','master');git(dir,'config','user.name','Person');git(dir,'config','user.email','person@example.test');
 await commit(dir,'a.txt','a\n','initial');
 git(dir,'checkout','-q','-b','dev');const old=await commit(dir,'old.txt','old\n','old dev work');
 git(dir,'checkout','-q','master');await commit(dir,'b.txt','b\n','reviewed 1');const tip=await commit(dir,'c.txt','c\n','reviewed 2');
 return {old,tip};
}
function alignFrame(location:string,extra:Partial<HostServerFrameOf<'git_branch_align'>>):HostServerFrameOf<'git_branch_align'>{
 return {type:'git_branch_align',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:location},source_ref:'refs/heads/dev',target_ref:'refs/heads/master',mode:'reset',expected_source_commit:'0'.repeat(40),expected_target_commit:'0'.repeat(40),...extra};
}
function collect(){
 const frames:Record<string,unknown>[]=[];
 return {frames,send:(f:Record<string,unknown>)=>{frames.push(f);},complete:()=>new Promise<Record<string,unknown>>(resolve=>{const check=()=>{const f=frames.find(x=>x.type==='complete');if(f)resolve(f);else setTimeout(check,10);};check();})};
}
const taskLaunch=(location:string,run:string,task:string,script:string):LaunchFrame=>({run_id:run,launch_id:`launch-${run}`,workspace:{kind:'location',workspace_location_id:location,worktree:{task_id:task}},argv:['sh','-c',script]});
const refs=(dir:string)=>git(dir,'for-each-ref','--format=%(refname) %(objectname)','refs/heads');
const journalOf=(location:string,id:string)=>join(config,'branch-align',location,`${id}.json`);
async function register(id:string,path:string){const current=(await loadConfig())!;await saveConfig({...current,workspaces:{...current.workspaces,[id]:path}});}

beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-repo-gate-')));root=join(sandbox,'repo');other=join(sandbox,'other');config=join(sandbox,'host');await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;
 server=createServer((request,response)=>{request.resume();request.on('end',()=>{response.writeHead(201,{'content-type':'application/json'});response.end(JSON.stringify({id:'folder-registered',name:'Registered',display_path:'/x',project_id:'p'}));});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('no address');
 await saveConfig({server_url:`http://127.0.0.1:${address.port}`,host_id:'host',trust:'trusted',token:'test',workspaces:{[LOCATION]:root,[OTHER]:other}});
});
afterEach(async()=>{
 delete branchAlignBarriers.beforeTransaction;delete branchAlignBarriers.beforeWorktree;delete branchAlignBarriers.afterGate;
 resetQuarantineCacheForTest();server.close();delete process.env.RAINVER_HOST_CONFIG_DIR;
 await rm(sandbox,{recursive:true,force:true});
});

it('gates by canonical repository: a Location registered through a symlink during an alignment cannot launch, maintain or run a command beside it',async()=>{
 const {old,tip}=await initRepo(root);await initRepo(other);
 const alias=join(sandbox,'alias');await symlink(root,alias);
 const request=alignFrame(LOCATION,{expected_source_commit:old,expected_target_commit:tip});
 const order:string[]=[];let registration:Promise<unknown>|null=null,launched:Promise<Record<string,unknown>>|null=null,command:Promise<unknown>|null=null,unrelated:Promise<Record<string,unknown>>|null=null;
 const run=collect(),free=collect();
 branchAlignBarriers.beforeTransaction=async()=>{
  // Registered after the alignment took its gate: its configuration snapshot never named it.
  await register('folder-late',alias);
  const before=refs(root);
  // Not awaited: the launch itself waits at the repository gate.
  const pending=handleLaunch(taskLaunch('folder-late','run-late','task-late',`git -C "${root}" rev-parse dev > seen.txt`),run.send as never,()=>{});
  launched=pending.then(()=>run.complete());
  command=runHostCommand({request_id:'cmd-late',command:['git','rev-parse','dev'],timeout_seconds:30,workspace:{kind:'location',workspace_location_id:'folder-late'}} as never).then(r=>{order.push(`command:${(r as {stdout:string}).stdout.trim()}`);});
  expect(await withTaskHeld(taskLeaseKey('folder-late','task-maint'),async()=>'ran')).toBeNull();
  // A registration of the same repository (through yet another path) waits for the answer too.
  registration=registerWorkspace({path:join(root,'.'),project_id:'p',name:'Registered'}).then(r=>{order.push(`registered:${r.ok}`);return r;});
  // Another repository is not held up.
  await handleLaunch(taskLaunch(OTHER,'run-free','task-free','true'),free.send as never,()=>{});
  unrelated=free.complete();
  expect(await unrelated).toMatchObject({exit_code:0});
  await new Promise(r=>setTimeout(r,200));
  // Nothing of the repository started: no Task branch, no command, the launch waits.
  expect(refs(root)).toBe(before);
  expect(order).toEqual([]);
  expect((await loadConfig())!.workspaces['folder-registered']).toBeUndefined();
  expect(run.frames.some(f=>f.type==='waiting_for_workspace')).toBe(true);
  expect(run.frames.some(f=>f.type==='complete')).toBe(false);
  order.push('aligning');
 };
 expect(await executeGitBranchAlign(root,request,{workspaces:{[LOCATION]:root,[OTHER]:other}})).toMatchObject({ok:true,outcome:'aligned'});
 expect(await launched).toMatchObject({exit_code:0});await command;await registration;
 expect(order.slice(0,1)).toEqual(['aligning']);expect(order.slice(1).sort()).toEqual([`command:${tip}`,'registered:true']);
 expect((await loadConfig())!.workspaces['folder-registered']).toBe(root);
 expect((await readFile(join(config,'task-worktrees','folder-late','task-late','seen.txt'),'utf8')).trim()).toBe(tip);
 expect(JSON.parse(await readFile(journalOf(LOCATION,request.operation_id),'utf8')).state).toBe('done');
 // While a Run of the repository runs through any Location, no alignment starts.
 const busy=collect();
 await handleLaunch(taskLaunch('folder-late','run-busy','task-busy','sleep 0.4'),busy.send as never,()=>{});
 expect(await executeGitBranchAlign(root,alignFrame(LOCATION,{expected_source_commit:tip,expected_target_commit:old}))).toMatchObject({ok:false,error:'location_busy'});
 await busy.complete();
});

/** HEAD names the aligned commit but the checkout still has the old files: the state a crash between ref move and checkout leaves. */
async function inconsistentAlignment(){
 const {old,tip}=await initRepo(root);git(root,'checkout','-q','dev');
 const request=alignFrame(LOCATION,{expected_source_commit:old,expected_target_commit:tip});
 const {request_id:_,...meaning}=request;
 git(root,'update-ref',`refs/rainver/branch-backups/${request.operation_id}`,old);git(root,'update-ref','refs/heads/dev',tip,old);
 await writeJsonDurable(journalOf(LOCATION,request.operation_id),{fingerprint:JSON.stringify(meaning),meaning,state:'intent',holder:root,common_dir:join(root,'.git')});
 return {old,tip,request};
}
async function launch(location:string,run:string,script='true'){const c=collect();await handleLaunch(taskLaunch(location,run,`task-${run}`,script),c.send as never,()=>{});return c.complete();}

it.for(['throws','unreachable'] as const)('isolates only the repository whose recovery %s, across restarts, until its ref, index and checkout are consistent',async(kind)=>{
 const {tip,request}=await inconsistentAlignment();await initRepo(other);
 const logs:string[]=[];
 await recoverBranchAlignments(async()=>{if(kind==='throws')throw new Error('disk gone');return null;},{},line=>logs.push(line));
 expect(logs.join('\n')).toContain('repository isolated');
 const refused=async()=>{
  expect(await launch(LOCATION,`run-${randomUUID().slice(0,8)}`)).toMatchObject({exit_code:1,error:expect.stringContaining('workspace_repository_recovery_required')});
  expect(await runHostCommand({request_id:`cmd-${randomUUID()}`,command:['true'],timeout_seconds:30,workspace:{kind:'location',workspace_location_id:LOCATION}} as never)).toMatchObject({error:'workspace_repository_recovery_required'});
  expect(await withTaskHeld(taskLeaseKey(LOCATION,'task-maint'),async()=>'ran')).toBeNull();
  expect(await executeGitBranchAlign(root,alignFrame(LOCATION,{expected_source_commit:tip,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_repository_recovery_required'});
 };
 await refused();
 // An unrelated repository keeps working.
 expect(await launch(OTHER,'run-other')).toMatchObject({exit_code:0});
 // A restart keeps the isolation: it is durable, not in memory.
 resetQuarantineCacheForTest();
 await refused();
 expect(await readdir(join(config,'branch-align-quarantine'))).toEqual([`${request.operation_id}.json`]);
 // The person brings the checkout to the aligned commit; the next start proves it and proceeds.
 git(root,'reset','-q','--hard','HEAD');
 expect(await launch(LOCATION,'run-after')).toMatchObject({exit_code:0});
 expect(existsSync(join(config,'branch-align-quarantine',`${request.operation_id}.json`))).toBe(false);
 // The unfinished journal is closed from those facts and is never acted on again.
 expect(JSON.parse(await readFile(journalOf(LOCATION,request.operation_id),'utf8'))).toMatchObject({state:'done',answer:{ok:true,outcome:'aligned',aligned_commit:tip}});
 resetQuarantineCacheForTest();
 await recoverBranchAlignments(async()=>root);
 expect(git(root,'rev-parse','dev')).toBe(tip);
});

it('isolates a repository whose alignment answered recovery_required and releases it once consistent',async()=>{
 const {old,tip}=await initRepo(root);await initRepo(other);git(root,'checkout','-q','dev');
 const raced=alignFrame(LOCATION,{expected_source_commit:old,expected_target_commit:tip});
 let newer='';
 branchAlignBarriers.beforeWorktree=async()=>{
  newer=execFileSync('git',['commit-tree','-p',tip,'-m','newer',`${tip}^{tree}`],{cwd:root,encoding:'utf8'}).trim();
  git(root,'update-ref','refs/heads/dev',newer,tip);
  await writeFile(join(root,'c.txt'),'mine\n');
 };
 expect(await executeGitBranchAlign(root,raced)).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required'});
 delete branchAlignBarriers.beforeWorktree;
 expect(await launch(LOCATION,'run-blocked')).toMatchObject({exit_code:1,error:expect.stringContaining('workspace_repository_recovery_required')});
 expect(await launch(OTHER,'run-other')).toMatchObject({exit_code:0});
 // The branch is at a commit the alignment never knew: still isolated after a restart.
 resetQuarantineCacheForTest();
 expect(await launch(LOCATION,'run-blocked-2')).toMatchObject({exit_code:1});
 // The person restores the aligned commit and a clean checkout.
 await rm(join(root,'c.txt'));git(root,'update-ref','refs/heads/dev',tip,newer);git(root,'reset','-q','--hard','HEAD');
 expect(await launch(LOCATION,'run-released')).toMatchObject({exit_code:0});
 // A redelivery still reads the recorded answer.
 expect(await executeGitBranchAlign(root,{...raced,request_id:randomUUID()})).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required'});
});

it('keeps the isolation of a recovery cut short by a crash and closes it at the next start',async()=>{
 const {tip,request}=await inconsistentAlignment();
 const {request_id:_,...meaning}=request;
 // Crash after the quarantine was recorded, before recovery finished.
 await writeJsonDurable(join(config,'branch-align-quarantine',`${request.operation_id}.json`),{common_dir:join(root,'.git'),location_id:LOCATION,operation_id:request.operation_id,meaning,reason:'recovery_pending',at:new Date().toISOString()});
 expect(await launch(LOCATION,'run-before')).toMatchObject({exit_code:1});
 resetQuarantineCacheForTest();
 await recoverBranchAlignments(async()=>root);
 expect(git(root,'rev-parse','dev')).toBe(tip);expect(git(root,'status','--porcelain')).toBe('');
 expect(existsSync(join(config,'branch-align-quarantine',`${request.operation_id}.json`))).toBe(false);
 expect(await launch(LOCATION,'run-after')).toMatchObject({exit_code:0});
});
