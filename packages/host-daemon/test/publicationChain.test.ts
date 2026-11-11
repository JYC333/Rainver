import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
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

let sandbox:string,root:string,cwd:string,base:string,lease:string;
let ref:{id:string;generation:number},runId:string,mergeId:string;
const author={name:'Agent',email:'agent@example.test'},location='folder-chain',launch='chain-test-launch';
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const workGit=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
async function init(snapshot=false){
 git('init','-q','-b','dev');git('config','user.name','Person');git('config','user.email','person@example.test');
 await writeFile(join(root,'file.txt'),'base\n');git('add','.');git('commit','-qm','initial');
 git('branch','release');
 if(snapshot)await writeFile(join(root,'file.txt'),'user uncommitted\n');
 const repo=await checkLocationRepository(root);if(repo.kind!=='repository')throw new Error('fixture repo');
 base=(await prepareExecutionWorkspace(repo.repo,location,{...ref,baseline_mode:snapshot?'snapshot':'committed'},runId)).startCommit;
 cwd=await executionWorkspacePath(root,location,ref);lease=taskLeaseKey(location,workspaceWorktreeKey(ref));
 workGit('config','user.name','Agent');workGit('config','user.email','agent@example.test');
 await acquireLocationLeases([lease],{runId,launchId:launch},()=>{throw new Error('unexpected queue');});
}
/** Nine reviewed feature commits, like the manually merged master chain. */
async function nineCommits(){
 const commits:string[]=[];
 for(let i=1;i<=9;i++){await writeFile(join(cwd,`feature-${i}.txt`),`feature ${i}\n`);workGit('add','.');workGit('commit','-qm',`feat ${i}`);commits.push(workGit('rev-parse','HEAD'));}
 return commits;
}
function frame(action:'native_prepare'|'native_checkpoint'|'native_publish',extra:Partial<HostServerFrameOf<'workspace_integration'>>={}):HostServerFrameOf<'workspace_integration'>{
 return {type:'workspace_integration',request_id:randomUUID(),operation_id:randomUUID(),run_id:runId,workspace:{kind:'location',workspace_location_id:location,execution_workspace:{...ref,integration_id:mergeId}},source_commit:base,base_commit:base,target_ref:'refs/heads/dev',action,author,message:'Publish reviewed chain',...extra};
}
const call=(action:Parameters<typeof frame>[0],extra:Parameters<typeof frame>[1]={})=>executeWorkspaceIntegration(root,frame(action,extra));
beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-chain-')));root=join(sandbox,'repo');const config=join(sandbox,'host');await mkdir(root);await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;ref={id:randomUUID(),generation:1};runId=randomUUID();mergeId=randomUUID();
 await saveConfig({server_url:'http://localhost:1',host_id:'host',trust:'trusted',token:'test',workspaces:{[location]:root}});
});
afterEach(async()=>{if(lease)releaseLocationLeases([lease],launch);lease='';delete process.env.RAINVER_HOST_CONFIG_DIR;await rm(sandbox,{recursive:true,force:true});});

it('fast-forwards the target to the frozen nine-commit chain with every commit identity preserved',async()=>{
 await init();const commits=await nineCommits();
 const prepared=await call('native_prepare',{publication_strategy:'fast_forward'});
 expect(prepared,JSON.stringify(prepared)).toMatchObject({ok:true,outcome:'rebased',candidate_commit:commits[8],publication:{strategy:'fast_forward',chain_tip:commits[8],chain_length:9}});
 // Publish names the chain the control plane recorded at prepare; without it, or with another, nothing moves.
 for(const tip of [undefined,commits[7]])expect(await call('native_publish',{publication_strategy:'fast_forward',...(tip?{publication_chain_tip:tip}:{}),verified_commit:commits[8]})).toMatchObject({ok:false,error:'native_publication_chain_changed'});
 expect(git('rev-parse','dev')).toBe(base);
 const published=await call('native_publish',{publication_strategy:'fast_forward',publication_chain_tip:commits[8],verified_commit:commits[8]});
 expect(published,JSON.stringify(published)).toMatchObject({ok:true,outcome:'merged',candidate_commit:commits[8]});
 expect(git('rev-parse','dev')).toBe(commits[8]);
 expect(git('rev-list','--reverse',`${base}..dev`).split('\n')).toEqual(commits);
 expect(git('log','--format=%an','-1','dev')).toBe('Agent');
});

it('publishes an ordinary merge commit over a moved target and keeps the chain as its second parent',async()=>{
 await init();const commits=await nineCommits();
 await writeFile(join(root,'other.txt'),'other\n');git('add','other.txt');git('commit','-qm','concurrent');const moved=git('rev-parse','dev');
 expect(await call('native_prepare',{publication_strategy:'fast_forward'})).toMatchObject({ok:false,error:'native_publication_fast_forward_target_moved'});
 // A different strategy cannot reuse a frozen fast-forward plan: a fresh integration identity is needed.
 mergeId=randomUUID();
 const prepared=await call('native_prepare',{publication_strategy:'merge'});
 expect(prepared,JSON.stringify(prepared)).toMatchObject({ok:true,outcome:'rebased',publication:{strategy:'merge',chain_tip:commits[8],chain_length:9}});
 const checked=workGit('rev-parse','HEAD');
 const published=await call('native_publish',{publication_strategy:'merge',publication_chain_tip:commits[8],verified_commit:checked});
 expect(published,JSON.stringify(published)).toMatchObject({ok:true,outcome:'merged'});
 const tip=git('rev-parse','dev');
 expect(git('rev-list','--parents','-n','1',tip).split(' ').slice(1)).toEqual([moved,commits[8]]);
 for(const c of commits)expect(execFileSync('git',['merge-base','--is-ancestor',c,'dev'],{cwd:root}).toString()).toBe('');
 expect(git('show','dev:other.txt')).toBe('other');expect(git('show','dev:feature-9.txt')).toBe('feature 9');
});

it('keeps squash as the default single new commit',async()=>{
 await init();const commits=await nineCommits();
 expect(await call('native_prepare')).toMatchObject({ok:true,outcome:'rebased',publication:{strategy:'squash',chain_tip:null,chain_length:0}});
 const published=await call('native_publish',{verified_commit:workGit('rev-parse','HEAD')});
 expect(published).toMatchObject({ok:true,outcome:'merged'});
 expect(git('rev-list','--count',`${base}..dev`)).toBe('1');
 expect(git('rev-parse','dev')).not.toBe(commits[8]);
 expect(git('show','dev:feature-9.txt')).toBe('feature 9');
});

it('refuses uncommitted work, merges inside the chain and a private snapshot baseline before any target change',async()=>{
 await init();await nineCommits();const target=git('rev-parse','dev');
 await writeFile(join(cwd,'loose.txt'),'loose\n');
 expect(await call('native_prepare',{publication_strategy:'fast_forward'})).toMatchObject({ok:false,error:'native_publication_chain_uncommitted'});
 workGit('add','.');workGit('commit','-qm','loose');
 workGit('checkout','-q','-b','side','HEAD~1');await writeFile(join(cwd,'side.txt'),'side\n');workGit('add','.');workGit('commit','-qm','side');
 const branch=`rainver/workspace-${ref.id}-g${ref.generation}`;
 workGit('checkout','-q',branch);workGit('merge','-q','--no-ff','-m','merge side','side');
 expect(await call('native_prepare',{publication_strategy:'fast_forward'})).toMatchObject({ok:false,error:'native_publication_chain_not_linear'});
 expect(git('rev-parse','dev')).toBe(target);
});

it('never publishes private snapshot history as a chain',async()=>{
 await init(true);await nineCommits();const target=git('rev-parse','dev');
 const refused=await call('native_prepare',{publication_strategy:'fast_forward'});
 expect(refused).toMatchObject({ok:false,error:'native_publication_chain_base_not_target_history'});
 expect(git('rev-parse','dev')).toBe(target);
});

it('fences the frozen chain and target by compare-and-swap',async()=>{
 await init();const commits=await nineCommits();
 expect(await call('native_prepare',{publication_strategy:'fast_forward'})).toMatchObject({ok:true});
 await writeFile(join(cwd,'late.txt'),'late\n');workGit('add','.');workGit('commit','-qm','after review');
 expect(await call('native_publish',{publication_strategy:'fast_forward',publication_chain_tip:commits[8],verified_commit:workGit('rev-parse','HEAD')})).toMatchObject({ok:false,error:'native_publication_chain_changed'});
 workGit('reset','-q','--hard',commits[8]!);
 await writeFile(join(root,'race.txt'),'race\n');git('add','race.txt');git('commit','-qm','race');const raced=git('rev-parse','dev');
 const published=await call('native_publish',{publication_strategy:'fast_forward',publication_chain_tip:commits[8],verified_commit:commits[8]});
 expect(published.ok===false||published.outcome==='main_moved',JSON.stringify(published)).toBe(true);
 expect(git('rev-parse','dev')).toBe(raced);
});

it('publishes to an explicitly selected existing branch and refuses managed or missing targets',async()=>{
 await init();const commits=await nineCommits();
 expect(await call('native_prepare',{publication_strategy:'fast_forward',target_ref:`refs/heads/rainver/workspace-${ref.id}-g1`})).toMatchObject({ok:false,error:'native_publication_target_managed'});
 expect(await call('native_prepare',{publication_strategy:'fast_forward',target_ref:'refs/heads/absent'})).toMatchObject({ok:false,error:'native_publication_target_missing'});
 expect(await call('native_prepare',{publication_strategy:'fast_forward',target_ref:'refs/heads/release'})).toMatchObject({ok:true});
 expect(await call('native_publish',{publication_strategy:'fast_forward',publication_chain_tip:commits[8],target_ref:'refs/heads/release',verified_commit:commits[8]})).toMatchObject({ok:true,outcome:'merged'});
 expect(git('rev-parse','release')).toBe(commits[8]);expect(git('rev-parse','dev')).toBe(base);
});
