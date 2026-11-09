import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {prepareExecutionWorkspace,executionWorkspacePath,executeWorkspaceCommand} from '../src/executionWorkspace.js';
import {executeWorkspaceIntegration} from '../src/workspaceIntegration.js';
import {checkLocationRepository,taskLeaseKey,deleteTaskBranch,settleTaskRun} from '../src/taskWorktree.js';
import {workspaceWorktreeKey,workspaceRunKey} from '../src/worktreeIdentity.js';
import {acquireLocationLeases,releaseLocationLeases} from '../src/locationLease.js';
import type {HostServerFrameOf} from '@rainver/protocol';
let sandbox:string,root:string,config:string,cwd:string,base:string,lease:string;
let ref:{id:string;generation:number},runId:string,mergeId:string;
const author={name:'Agent',email:'agent@example.test'},location='folder-native',launch='native-test-launch';
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const workGit=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
async function init(snapshot=false){
 git('init','-q','-b','dev');git('config','user.name','Person');git('config','user.email','person@example.test');
 await writeFile(join(root,'file.txt'),'base\n');await writeFile(join(root,'.gitignore'),'node_modules/\n');git('add','.');git('commit','-qm','initial');
 if(snapshot)await writeFile(join(root,'file.txt'),'user uncommitted\n');
 const repo=await checkLocationRepository(root);if(repo.kind!=='repository')throw new Error('fixture repo');
 base=(await prepareExecutionWorkspace(repo.repo,location,{...ref,baseline_mode:snapshot?'snapshot':'committed'},runId)).startCommit;
 cwd=await executionWorkspacePath(root,location,ref);lease=taskLeaseKey(location,workspaceWorktreeKey(ref));
 await acquireLocationLeases([lease],{runId,launchId:launch},()=>{throw new Error('unexpected queue');});
 await mkdir(join(cwd,'node_modules'),{recursive:true});await writeFile(join(cwd,'node_modules','prepared'),'keep');
}
function frame(action:'native_prepare'|'native_checkpoint'|'native_publish',extra:Partial<HostServerFrameOf<'workspace_integration'>>={}):HostServerFrameOf<'workspace_integration'>{
 return {type:'workspace_integration',request_id:randomUUID(),operation_id:randomUUID(),run_id:runId,workspace:{kind:'location',workspace_location_id:location,execution_workspace:{...ref,integration_id:mergeId}},source_commit:base,base_commit:base,target_ref:'refs/heads/dev',action,author,message:'Native integration',...extra};
}
const call=(action:Parameters<typeof frame>[0],extra:Parameters<typeof frame>[1]={})=>executeWorkspaceIntegration(root,frame(action,extra));
async function checkpoint(){const saved=await call('native_checkpoint');expect(saved.ok).toBe(true);return saved.candidate_commit!;}
beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-native-')));root=join(sandbox,'repo');config=join(sandbox,'host');await mkdir(root);await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;ref={id:randomUUID(),generation:1};runId=randomUUID();mergeId=randomUUID();
 await saveConfig({server_url:'http://localhost:1',host_id:'host',trust:'trusted',token:'test',workspaces:{[location]:root}});
});
afterEach(async()=>{if(lease)releaseLocationLeases([lease],launch);lease='';delete process.env.RAINVER_HOST_CONFIG_DIR;await rm(sandbox,{recursive:true,force:true});});
it('keeps the original active worktree, native Git and prepared dependencies through publication',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');expect(await call('native_prepare')).toMatchObject({ok:true,outcome:'rebased'});
 await writeFile(join(cwd,'related.txt'),'related fix\n');workGit('add','.');workGit('commit','-qm','Agent result');
 expect(await call('native_publish',{verified_commit:workGit('rev-parse','HEAD')})).toMatchObject({ok:true,outcome:'merged'});
 expect(git('show','dev:feature.txt')).toBe('feature');expect(git('show','dev:related.txt')).toBe('related fix');
 expect(await executionWorkspacePath(root,location,ref)).toBe(cwd);expect(await readFile(join(cwd,'node_modules','prepared'),'utf8')).toBe('keep');
 expect(git('worktree','list','--porcelain').match(/^worktree /gm)).toHaveLength(2);
});
it('lets the same Agent resolve conflicts and necessary related files without a path allowlist',async()=>{
 await init();await writeFile(join(cwd,'file.txt'),'agent change\n');await writeFile(join(root,'file.txt'),'target change\n');git('add','.');git('commit','-qm','target advanced');
 const prepared=await call('native_prepare');expect(prepared,JSON.stringify(prepared)).toMatchObject({ok:true,outcome:'conflict',conflicted_files:['file.txt']});
 await writeFile(join(cwd,'file.txt'),'both intents\n');await writeFile(join(cwd,'necessary-fix.txt'),'fix\n');
 expect(await call('native_publish',{verified_commit:await checkpoint()})).toMatchObject({ok:true,outcome:'merged'});
 expect(git('show','dev:file.txt')).toBe('both intents');expect(git('show','dev:necessary-fix.txt')).toBe('fix');
});
it('excludes imported user changes and preserves unrelated target staged and unstaged work',async()=>{
 await init(true);await writeFile(join(cwd,'feature.txt'),'agent feature\n');await writeFile(join(root,'staged.txt'),'staged\n');git('add','staged.txt');await writeFile(join(root,'unstaged.txt'),'untracked\n');
 const prepared=await call('native_prepare');expect(prepared,JSON.stringify(prepared)).toMatchObject({ok:true,outcome:'rebased'});
 expect(await call('native_publish',{verified_commit:await checkpoint()})).toMatchObject({ok:true,outcome:'merged'});
 expect(git('show','dev:file.txt')).toBe('base');expect(await readFile(join(root,'file.txt'),'utf8')).toBe('user uncommitted\n');
 expect(git('diff','--cached','--name-only')).toBe('staged.txt');expect(await readFile(join(root,'unstaged.txt'),'utf8')).toBe('untracked\n');
});
it('returns target movement and retains repairs when preparing again',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');await call('native_prepare');const checked=await checkpoint();
 await writeFile(join(root,'concurrent.txt'),'concurrent\n');git('add','.');git('commit','-qm','concurrent task');
 expect(await call('native_publish',{verified_commit:checked})).toMatchObject({ok:true,outcome:'main_moved'});expect(await call('native_prepare')).toMatchObject({ok:true,outcome:'rebased'});
 expect(await readFile(join(cwd,'concurrent.txt'),'utf8')).toBe('concurrent\n');expect(await readFile(join(cwd,'feature.txt'),'utf8')).toBe('feature\n');
 expect(await call('native_publish',{verified_commit:await checkpoint()})).toMatchObject({ok:true,outcome:'merged'});
});
it('rejects changes after checks and unresolved conflict markers without moving dev',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');await call('native_prepare');const checked=await checkpoint(),target=git('rev-parse','dev');
 await writeFile(join(cwd,'feature.txt'),'changed after checking\n');expect(await call('native_publish',{verified_commit:checked})).toMatchObject({ok:false,error:'native_verified_version_changed'});expect(git('rev-parse','dev')).toBe(target);
 await writeFile(join(cwd,'feature.txt'),'<<<<<<< HEAD\na\n=======\nb\n>>>>>>> theirs\n');expect(await call('native_publish',{verified_commit:await checkpoint()})).toMatchObject({ok:false,error:'native_candidate_has_unresolved_changes'});
});
it('replays lost responses without resetting edits made after preparation',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');const request=frame('native_prepare'),first=await executeWorkspaceIntegration(root,request);
 await writeFile(join(cwd,'feature.txt'),'later work\n');expect(await executeWorkspaceIntegration(root,{...request,request_id:randomUUID()})).toEqual(first);expect(await readFile(join(cwd,'feature.txt'),'utf8')).toBe('later work\n');
});
it('requires the live launch owner and prevents premature worktree cleanup',async()=>{
 await init();expect(await call('native_prepare',{run_id:randomUUID()})).toMatchObject({ok:false,error:'native_integration_run_not_active'});
 expect(await deleteTaskBranch({locationRoot:root,locationId:location,taskId:workspaceWorktreeKey(ref)})).toMatchObject({ok:false,error:'task_busy'});
 releaseLocationLeases([lease],launch);expect(await call('native_prepare')).toMatchObject({ok:false,error:'native_integration_run_not_active'});
});
it('adopts matching target local files while preserving divergent edits',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');await call('native_prepare');const checked=await checkpoint();
 await writeFile(join(root,'feature.txt'),'other work\n');expect(await call('native_publish',{verified_commit:checked})).toMatchObject({ok:true,outcome:'waiting_local_changes'});expect(await readFile(join(root,'feature.txt'),'utf8')).toBe('other work\n');
 await writeFile(join(root,'feature.txt'),'feature\n');expect(await call('native_publish',{verified_commit:checked})).toMatchObject({ok:true,outcome:'merged'});
});
it('carries the person\'s clean unstaged and staged edits on overlapping files onto the published content',async()=>{
 await init();await writeFile(join(root,'lines.txt'),'l1\nl2\nl3\nl4\nl5\n');git('add','.');git('commit','-qm','lines');
 await writeFile(join(cwd,'feature.txt'),'feature\n');expect(await call('native_prepare')).toMatchObject({ok:true,outcome:'rebased'});
 await writeFile(join(cwd,'lines.txt'),'L1\nl2\nl3\nl4\nl5\n');const checked=await checkpoint();
 await writeFile(join(root,'lines.txt'),'l1\nl2\nl3\nl4\nL5\n');git('add','lines.txt');await writeFile(join(root,'lines.txt'),'l1\nl2\nl3\nL4\nL5\n');
 expect(await call('native_publish',{verified_commit:checked})).toMatchObject({ok:true,outcome:'merged'});
 expect(git('show','dev:lines.txt')).toBe('L1\nl2\nl3\nl4\nl5');expect(git('show',':lines.txt')).toBe('L1\nl2\nl3\nl4\nL5');
 expect(await readFile(join(root,'lines.txt'),'utf8')).toBe('L1\nl2\nl3\nL4\nL5\n');expect(git('status','--porcelain')).toBe('MM lines.txt');
 const preimage=git('for-each-ref','--format=%(refname)','refs/rainver/local-preimages/').split('\n').sort();expect(preimage).toHaveLength(2);
 expect(git('show',`${preimage[0]}:lines.txt`)).toBe('l1\nl2\nl3\nL4\nL5');expect(git('show',`${preimage[1]}:lines.txt`)).toBe('l1\nl2\nl3\nl4\nL5');
});
it('blocks only the overlapping file whose local edit conflicts, leaving the checkout untouched',async()=>{
 await init();await writeFile(join(root,'lines.txt'),'l1\nl2\nl3\nl4\nl5\n');git('add','.');git('commit','-qm','lines');
 await writeFile(join(cwd,'feature.txt'),'feature\n');await call('native_prepare');await writeFile(join(cwd,'lines.txt'),'L1\nl2\nl3\nl4\nl5\n');const checked=await checkpoint(),target=git('rev-parse','dev');
 await writeFile(join(root,'lines.txt'),'X1\nl2\nl3\nl4\nl5\n');const before=git('ls-files','--stage');
 expect(await call('native_publish',{verified_commit:checked})).toMatchObject({ok:true,outcome:'waiting_local_changes',conflicted_files:['lines.txt']});
 expect(git('rev-parse','dev')).toBe(target);expect(git('ls-files','--stage')).toBe(before);expect(await readFile(join(root,'lines.txt'),'utf8')).toBe('X1\nl2\nl3\nl4\nl5\n');expect(git('for-each-ref','refs/rainver/local-preimages/')).toBe('');
 await writeFile(join(root,'lines.txt'),'l1\nl2\nl3\nl4\nL5\n');expect(await call('native_publish',{verified_commit:checked})).toMatchObject({ok:true,outcome:'merged'});
 expect(await readFile(join(root,'lines.txt'),'utf8')).toBe('L1\nl2\nl3\nl4\nL5\n');expect(git('diff','--name-only')).toBe('lines.txt');expect(git('diff','--cached','--name-only')).toBe('');
});
it('settles and reclaims the physical worktree only after the Agent exits',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');await call('native_prepare');await call('native_publish',{verified_commit:await checkpoint()});releaseLocationLeases([lease],launch);
 const settled=await settleTaskRun({locationRoot:root,locationId:location,taskId:workspaceWorktreeKey(ref),runId:workspaceRunKey(runId,ref),author,message:'Done'});expect(settled.ok).toBe(true);expect(await readFile(join(cwd,'node_modules','prepared'),'utf8')).toBe('keep');
 expect(await executeWorkspaceCommand(root,{type:'execution_workspace_command',request_id:randomUUID(),workspace:{kind:'location',workspace_location_id:location,execution_workspace:ref},action:'cleanup',operation_id:randomUUID(),expected_commit:settled.commit!,retain_branch:true})).toMatchObject({ok:true,cleanup_state:'cleaned'});await expect(readFile(join(cwd,'node_modules','prepared'))).rejects.toThrow();await expect(readFile(join(config,'workspace-native',location,workspaceWorktreeKey(ref),`${mergeId}.json`))).rejects.toThrow();
});
it('publishes an independent commit without importing private branch history',async()=>{
 await init();await writeFile(join(cwd,'independent.txt'),'independent\n');workGit('add','.');workGit('commit','-qm','Independent fix');const submitted=workGit('rev-parse','HEAD');workGit('branch','saved-independent',submitted);workGit('reset','--hard',base);
 expect(await call('native_prepare',{submitted_commit:submitted})).toMatchObject({ok:true,outcome:'rebased'});
 expect(await call('native_publish',{verified_commit:await checkpoint()})).toMatchObject({ok:true,outcome:'merged'});expect(git('show','dev:independent.txt')).toBe('independent');
});
it('closes an already-adopted historical batch without touching newer private work',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');workGit('add','.');workGit('commit','-qm','Feature');const source=workGit('rev-parse','HEAD');git('cherry-pick',source);await writeFile(join(cwd,'newer.txt'),'keep newer work\n');
 expect(await call('native_prepare',{submitted_commit:source,submitted_base:base})).toMatchObject({ok:true,outcome:'no_changes'});expect(await readFile(join(cwd,'newer.txt'),'utf8')).toBe('keep newer work\n');
});
it('prepares a historical batch from its recorded delta only into a worktree without unsubmitted changes',async()=>{
 await init();await writeFile(join(cwd,'earlier.txt'),'earlier\n');workGit('add','.');workGit('commit','-qm','Earlier snapshot');await writeFile(join(cwd,'feature.txt'),'feature\n');workGit('add','.');workGit('commit','-qm','Historical batch');
 const source=workGit('rev-parse','HEAD');workGit('branch','historical',source);workGit('reset','--hard',base);await writeFile(join(cwd,'newer.txt'),'unsubmitted\n');
 // Without the recorded base the parent snapshot is not target history.
 expect(await call('native_prepare',{submitted_commit:source})).toMatchObject({ok:false,error:'workspace_commit_requires_target_history'});
 expect(await call('native_prepare',{submitted_commit:source,submitted_base:base})).toMatchObject({ok:false,error:'workspace_commit_requires_empty_change'});expect(await readFile(join(cwd,'newer.txt'),'utf8')).toBe('unsubmitted\n');
 await rm(join(cwd,'newer.txt'));expect(await call('native_prepare',{submitted_commit:source,submitted_base:base})).toMatchObject({ok:true,outcome:'rebased'});
 expect(await call('native_publish',{verified_commit:await checkpoint()})).toMatchObject({ok:true,outcome:'merged'});expect(git('show','dev:feature.txt')).toBe('feature');expect(git('show','dev:earlier.txt')).toBe('earlier');
 expect(await readFile(join(cwd,'node_modules','prepared'),'utf8')).toBe('keep');
});
it('proves publication after a lost final receipt even when the original Agent has exited',async()=>{
 await init();await writeFile(join(cwd,'feature.txt'),'feature\n');await call('native_prepare');const request=frame('native_publish',{verified_commit:await checkpoint()}),published=await executeWorkspaceIntegration(root,request);expect(published.outcome).toBe('merged');
 const directory=join(config,'workspace-native',location,workspaceWorktreeKey(ref)),file=join(directory,`${mergeId}.json`),journal=JSON.parse(await readFile(file,'utf8'));delete journal.merged;await writeFile(file,JSON.stringify(journal));await rm(join(directory,`request-${request.operation_id}.json`));releaseLocationLeases([lease],launch);
 expect(await call('native_publish',{action:'native_inspect'})).toMatchObject({ok:true,outcome:'merged',candidate_commit:published.candidate_commit});
});
it('integrates a delegated result into the yielded parent worktree without publishing it to dev',async()=>{
 await init();const parent={id:randomUUID(),generation:1},parentRun=randomUUID(),repo=await checkLocationRepository(root);if(repo.kind!=='repository')throw new Error('repo');
 await prepareExecutionWorkspace(repo.repo,location,{...parent,base_commit:base},parentRun);const parentPath=await executionWorkspacePath(root,location,parent),target=`refs/heads/rainver/workspace-${parent.id}-g1`;
 await writeFile(join(cwd,'child.txt'),'child\n');expect(await call('native_prepare',{target_ref:target})).toMatchObject({ok:true,outcome:'rebased'});
 expect(await call('native_publish',{target_ref:target,target_workspace:parent,verified_commit:await checkpoint()})).toMatchObject({ok:true,outcome:'merged'});expect(await readFile(join(parentPath,'child.txt'),'utf8')).toBe('child\n');expect(git('rev-parse','dev')).toBe(base);
});
it('preserves ignored prepared files when an incoming target starts tracking their path',async()=>{
 await init();await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','prepared'),'incoming tracked\n');git('add','-f','node_modules/prepared');git('commit','-qm','Target starts tracking ignored path');await writeFile(join(cwd,'feature.txt'),'feature\n');
 const first=await call('native_prepare');expect(first).toMatchObject({ok:false,error:'native_preparation_preserves_local_files'});expect(await readFile(join(cwd,'node_modules','prepared'),'utf8')).toBe('keep');expect(await call('native_prepare')).toMatchObject({ok:false,error:'native_preparation_preserves_local_files'});
});
it('keeps an Agent private commit identity and saves checkpoints without publication',async()=>{
 await init();await writeFile(join(cwd,'private.txt'),'private\n');workGit('add','.');workGit('commit','-qm','Keep this commit');const commit=workGit('rev-parse','HEAD');
 expect(await checkpoint()).toBe(commit);expect(git('rev-parse','dev')).toBe(base);releaseLocationLeases([lease],launch);
 expect(await settleTaskRun({locationRoot:root,locationId:location,taskId:workspaceWorktreeKey(ref),runId:workspaceRunKey(runId,ref),author,message:'System checkpoint'})).toMatchObject({ok:true,commit});
 expect(workGit('rev-parse','HEAD')).toBe(commit);expect(workGit('log','-1','--format=%s')).toBe('Keep this commit');expect(await readFile(join(cwd,'node_modules','prepared'),'utf8')).toBe('keep');
});
it('runs two native conversations independently and repairs their target race in the same worktrees',async()=>{
 await init();
 const second={id:randomUUID(),generation:1},secondRun=randomUUID(),secondMerge=randomUUID(),secondLaunch='second-native-launch';
 const repository=await checkLocationRepository(root);if(repository.kind!=='repository')throw new Error('fixture repo');
 await prepareExecutionWorkspace(repository.repo,location,{...second,base_commit:base},secondRun);
 const secondCwd=await executionWorkspacePath(root,location,second),secondLease=taskLeaseKey(location,workspaceWorktreeKey(second));
 await acquireLocationLeases([secondLease],{runId:secondRun,launchId:secondLaunch},()=>{throw new Error('independent conversation queued');});
 const secondCall=(action:Parameters<typeof frame>[0],extra:Parameters<typeof frame>[1]={})=>call(action,{run_id:secondRun,workspace:{kind:'location',workspace_location_id:location,execution_workspace:{...second,integration_id:secondMerge}},...extra});
 try{
  await Promise.all([writeFile(join(cwd,'file.txt'),'first intent\n'),writeFile(join(secondCwd,'file.txt'),'second intent\n')]);
  const prepared=await Promise.all([call('native_prepare'),secondCall('native_prepare')]);
  for(const result of prepared)expect(result).toMatchObject({ok:true,outcome:'rebased'});
  expect(await call('native_publish',{verified_commit:await checkpoint()})).toMatchObject({ok:true,outcome:'merged'});
  const secondChecked=(await secondCall('native_checkpoint')).candidate_commit!;
  expect(await secondCall('native_publish',{verified_commit:secondChecked})).toMatchObject({ok:true,outcome:'main_moved'});
  expect(await secondCall('native_prepare')).toMatchObject({ok:true,outcome:'conflict',conflicted_files:['file.txt']});
  await writeFile(join(secondCwd,'file.txt'),'first and second intents\n');
  expect(await secondCall('native_publish',{verified_commit:(await secondCall('native_checkpoint')).candidate_commit!})).toMatchObject({ok:true,outcome:'merged'});
  expect(git('show','dev:file.txt')).toBe('first and second intents');
  expect(await readFile(join(cwd,'file.txt'),'utf8')).toBe('first intent\n');
  expect(await executionWorkspacePath(root,location,second)).toBe(secondCwd);
  expect(await readFile(join(cwd,'node_modules','prepared'),'utf8')).toBe('keep');
 }finally{releaseLocationLeases([secondLease],secondLaunch);}
});
