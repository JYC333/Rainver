import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {prepareExecutionWorkspace,executionWorkspacePath} from '../src/executionWorkspace.js';
import {executeWorkspaceIntegration} from '../src/workspaceIntegration.js';
import {checkLocationRepository,taskLeaseKey} from '../src/taskWorktree.js';
import {workspaceWorktreeKey} from '../src/worktreeIdentity.js';
import {acquireLocationLeases,releaseLocationLeases} from '../src/locationLease.js';
import type {HostServerFrameOf} from '@rainver/protocol';

/**
 * Rebase publication over a real repository: the Agent's own commits after the
 * batch base are replayed onto the target in its worktree, one at a time, a
 * conflict stopping at its commit, and the target is fast-forwarded.
 */
let sandbox:string,root:string,cwd:string,base:string,lease:string;
let ref:{id:string;generation:number},runId:string,mergeId:string;
const author={name:'Agent',email:'agent@example.test'},location='folder-rebase',launch='rebase-test-launch';
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const workGit=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
async function init(snapshot=false){
 git('init','-q','-b','dev');git('config','user.name','Person');git('config','user.email','person@example.test');
 await writeFile(join(root,'file.txt'),'base\n');await writeFile(join(root,'.gitignore'),'node_modules/\n');git('add','.');git('commit','-qm','initial');
 if(snapshot)await writeFile(join(root,'private.txt'),'the person\'s uncommitted note\n');
 const repo=await checkLocationRepository(root);if(repo.kind!=='repository')throw new Error('fixture repo');
 base=(await prepareExecutionWorkspace(repo.repo,location,{...ref,baseline_mode:snapshot?'snapshot':'committed'},runId)).startCommit;
 cwd=await executionWorkspacePath(root,location,ref);lease=taskLeaseKey(location,workspaceWorktreeKey(ref));
 await acquireLocationLeases([lease],{runId,launchId:launch},()=>{throw new Error('unexpected queue');});
 await mkdir(join(cwd,'node_modules'),{recursive:true});await writeFile(join(cwd,'node_modules','prepared'),'keep');
 workGit('config','user.name','Writer');workGit('config','user.email','writer@example.test');
}
function frame(action:'native_prepare'|'native_checkpoint'|'native_publish',extra:Partial<HostServerFrameOf<'workspace_integration'>>={}):HostServerFrameOf<'workspace_integration'>{
 return {type:'workspace_integration',request_id:randomUUID(),operation_id:randomUUID(),run_id:runId,workspace:{kind:'location',workspace_location_id:location,execution_workspace:{...ref,integration_id:mergeId}},source_commit:base,base_commit:base,target_ref:'refs/heads/dev',action,author,message:'Rebase summary',publication_strategy:'rebase',...extra};
}
const call=(action:Parameters<typeof frame>[0],extra:Parameters<typeof frame>[1]={})=>executeWorkspaceIntegration(root,frame(action,extra));
async function commit(file:string,text:string,message:string){await writeFile(join(cwd,file),text);workGit('add','.');workGit('commit','-qm',message);return workGit('rev-parse','HEAD');}
async function target(file:string,text:string,message:string){await writeFile(join(root,file),text);git('add',file);git('commit','-qm',message);return git('rev-parse','dev');}
async function publish(){const prepared=await call('native_prepare');expect(prepared,JSON.stringify(prepared)).toMatchObject({ok:true,outcome:'rebased'});return call('native_publish',{verified_commit:workGit('rev-parse','HEAD'),publication_chain_tip:prepared.candidate_commit!});}
const subjects=(range:string)=>git('log','--reverse','--format=%s|%an',range).split('\n');
beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-rebase-')));root=join(sandbox,'repo');const config=join(sandbox,'host');await mkdir(root);await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;ref={id:randomUUID(),generation:1};runId=randomUUID();mergeId=randomUUID();
 await saveConfig({server_url:'http://localhost:1',host_id:'host',trust:'trusted',token:'test',workspaces:{[location]:root}});
});
afterEach(async()=>{if(lease)releaseLocationLeases([lease],launch);lease='';delete process.env.RAINVER_HOST_CONFIG_DIR;await rm(sandbox,{recursive:true,force:true});});

it('replays each own commit onto the moved target, keeping authors and messages, never the private baseline',async()=>{
 await init(true);await commit('a.txt','a\n','feat: first');await commit('b.txt','b\n','feat: second');
 const moved=await target('t.txt','t\n','target moved');
 expect(await publish()).toMatchObject({ok:true,outcome:'merged'});
 expect(git('rev-list','--count',`${moved}..dev`)).toBe('2');
 expect(subjects(`${moved}..dev`)).toEqual(['feat: first|Writer','feat: second|Writer']);
 expect(git('log','-1','--format=%cn','dev')).toBe('Agent');
 expect(git('rev-list','--min-parents=2','--count',`${moved}..dev`)).toBe('0');
 expect(git('show','dev:a.txt')).toBe('a');expect(git('show','dev:t.txt')).toBe('t');
 expect(()=>git('show','dev:private.txt')).toThrow();
 expect(workGit('rev-parse','HEAD')).toBe(git('rev-parse','dev'));
 expect(await readFile(join(cwd,'node_modules','prepared'),'utf8')).toBe('keep');
 // The pre-rebase history is retained.
 expect(git('for-each-ref','--format=%(refname)',`refs/rainver/native-preimages/${ref.id}/`)).not.toBe('');
});

it('stops at the conflicting commit, continues after the Agent resolves it, and refuses unresolved markers',async()=>{
 await init();await commit('file.txt','agent\n','feat: conflicting');await commit('other.txt','other\n','feat: independent');
 const moved=await target('file.txt','target\n','target edit');
 const stopped=await call('native_prepare');
 expect(stopped,JSON.stringify(stopped)).toMatchObject({ok:true,outcome:'conflict',conflicted_files:['file.txt'],candidate_commit:null});
 // Stopped on the first commit: the branch is the target, the conflict is in the worktree.
 expect(workGit('rev-parse','HEAD')).toBe(moved);expect(await readFile(join(cwd,'file.txt'),'utf8')).toContain('<<<<<<<');
 expect(await call('native_publish',{verified_commit:moved})).toMatchObject({ok:false,error:'native_rebase_unfinished'});
 expect(await call('native_prepare',{publication_strategy:undefined})).toMatchObject({ok:false,error:'native_publication_plan_changed'});
 expect(await call('native_prepare')).toMatchObject({ok:true,outcome:'conflict',conflicted_files:['file.txt']});
 expect(workGit('rev-parse','HEAD')).toBe(moved);
 await writeFile(join(cwd,'file.txt'),'target and agent\n');
 expect(await publish()).toMatchObject({ok:true,outcome:'merged'});
 expect(subjects(`${moved}..dev`)).toEqual(['feat: conflicting|Writer','feat: independent|Writer']);
 expect(git('show','dev:file.txt')).toBe('target and agent');expect(git('show','dev:other.txt')).toBe('other');
});

it('saves uncommitted edits as one commit, and rebases again when the target moves before publication',async()=>{
 await init();await commit('a.txt','a\n','feat: committed');await writeFile(join(cwd,'loose.txt'),'loose\n');
 const prepared=await call('native_prepare');expect(prepared).toMatchObject({ok:true,outcome:'rebased'});
 expect(subjects(`${base}..${prepared.candidate_commit}`)).toEqual(['feat: committed|Writer','Rebase summary|Agent']);
 const moved=await target('t.txt','t\n','concurrent');
 expect(await call('native_publish',{verified_commit:prepared.candidate_commit!,publication_chain_tip:prepared.candidate_commit!})).toMatchObject({ok:true,outcome:'main_moved'});
 expect(git('rev-parse','dev')).toBe(moved);
 expect(await publish()).toMatchObject({ok:true,outcome:'merged'});
 expect(subjects(`${moved}..dev`)).toEqual(['feat: committed|Writer','Rebase summary|Agent']);
 expect(git('show','dev:loose.txt')).toBe('loose');
});

it('keeps commits already on the target tip unchanged and closes a batch the target already holds',async()=>{
 await init();const own=await commit('a.txt','a\n','feat: on the tip');
 const prepared=await call('native_prepare');expect(prepared).toMatchObject({ok:true,outcome:'rebased',candidate_commit:own});
 expect(await call('native_publish',{verified_commit:own,publication_chain_tip:own})).toMatchObject({ok:true,outcome:'merged'});
 expect(git('rev-parse','dev')).toBe(own);
 mergeId=randomUUID();const copied=await commit('b.txt','b\n','feat: copied');git('cherry-pick',copied);
 expect(await call('native_prepare')).toMatchObject({ok:true,outcome:'no_changes'});
});

it('replays a historical batch from its recorded base into a worktree without unsubmitted changes',async()=>{
 await init(true);await commit('a.txt','a\n','feat: historical one');const source=await commit('b.txt','b\n','feat: historical two');
 const moved=await target('t.txt','t\n','target moved');
 // The worktree holds the historical source and nothing else (its bound batch is empty).
 const prepared=await call('native_prepare',{submitted_commit:source,submitted_base:base,base_commit:source});
 expect(prepared,JSON.stringify(prepared)).toMatchObject({ok:true,outcome:'rebased'});
 expect(await call('native_publish',{verified_commit:workGit('rev-parse','HEAD'),publication_chain_tip:prepared.candidate_commit!})).toMatchObject({ok:true,outcome:'merged'});
 expect(subjects(`${moved}..dev`)).toEqual(['feat: historical one|Writer','feat: historical two|Writer']);
 expect(()=>git('show','dev:private.txt')).toThrow();
});
