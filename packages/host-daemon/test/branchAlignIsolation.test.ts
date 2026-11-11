import {mkdtemp,mkdir,writeFile,rm,realpath,readFile,symlink,stat,utimes} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {saveConfig} from '../src/config.js';
import {branchAlignBarriers,branchAlignGit,executeGitBranchAlign,recoverBranchAlignments,resetBranchAlignGitForTest} from '../src/gitBranchAlign.js';
import {resetQuarantineCacheForTest} from '../src/branchAlignState.js';
import {writeJsonDurable} from '../src/durableFile.js';
import {handleLaunch,type LaunchFrame} from '../src/execution.js';
import {runHostCommand} from '../src/commandRun.js';
import type {HostServerFrameOf} from '@rainver/protocol';

// A durable write that renames into place and then fails (as an fsync of the
// directory can): the record is on disk, the caller sees an error.
const durable=vi.hoisted(()=>({failAfter:null as null|((path:string,value:unknown)=>boolean)}));
vi.mock('../src/durableFile.js',async original=>{
 const actual=await original<typeof import('../src/durableFile.js')>();
 return {...actual,writeJsonDurable:async(path:string,value:unknown)=>{
  await actual.writeJsonDurable(path,value);
  if(durable.failAfter?.(path,value)){durable.failAfter=null;throw new Error('fsync failed after rename');}
 }};
});

let sandbox:string,root:string,main:string,other:string,config:string,server:Server;
const LOCATION='folder-align',MAIN='folder-main',OTHER='folder-other',ALIAS='folder-alias';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
async function commit(dir:string,file:string,text:string,message:string){await writeFile(join(dir,file),text);git(dir,'add',file);git(dir,'commit','-qm',message);return git(dir,'rev-parse','HEAD');}
/** dev holds old history and is checked out; master gained a reviewed chain (b.txt, c.txt). */
async function initRepo(dir:string,checkout='master'){
 await mkdir(dir,{recursive:true});
 git(dir,'init','-q','-b','master');git(dir,'config','user.name','Person');git(dir,'config','user.email','person@example.test');
 await commit(dir,'a.txt','a\n','initial');
 git(dir,'checkout','-q','-b','dev');const old=await commit(dir,'old.txt','old\n','old dev work');
 git(dir,'checkout','-q','master');await commit(dir,'b.txt','b\n','reviewed 1');const tip=await commit(dir,'c.txt','c\n','reviewed 2');
 git(dir,'checkout','-q',checkout);
 return {old,tip};
}
function alignFrame(old:string,tip:string):HostServerFrameOf<'git_branch_align'>{
 return {type:'git_branch_align',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION},source_ref:'refs/heads/dev',target_ref:'refs/heads/master',mode:'reset',expected_source_commit:old,expected_target_commit:tip};
}
function collect(){
 const frames:Record<string,unknown>[]=[];
 return {frames,send:(f:Record<string,unknown>)=>{frames.push(f);},complete:()=>new Promise<Record<string,unknown>>(resolve=>{const check=()=>{const f=frames.find(x=>x.type==='complete');if(f)resolve(f);else setTimeout(check,10);};check();})};
}
async function run(frame:LaunchFrame){const c=collect();await handleLaunch(frame,c.send as never,()=>{});return {...await c.complete(),frames:c.frames};}
const taskLaunch=(location:string,id=randomUUID()):LaunchFrame=>({run_id:id,launch_id:`launch-${id}`,workspace:{kind:'location',workspace_location_id:location,worktree:{task_id:`task-${id}`}},argv:['true']});
/** The primary in its own isolated workspace, each attachment an isolated execution workspace too. */
const attachedLaunch=(primary:string,attached:string[],marker:string):LaunchFrame=>{
 const id=randomUUID();
 return {run_id:id,launch_id:`launch-${id}`,workspace:{kind:'location',workspace_location_id:primary,execution_workspace:{id:randomUUID(),generation:1}},
  workspace_access:attached.map(location=>({workspace_location_id:location,access_mode:'write' as const,execution_workspace:{id:randomUUID(),generation:1}})),
  argv:['sh','-c',`touch "${marker}"`]};
};
const quarantineFiles=()=>existsSync(join(config,'branch-align-quarantine'))?execFileSync('ls',[join(config,'branch-align-quarantine')],{encoding:'utf8'}).split('\n').filter(Boolean):[];
const worktreesOf=(dir:string)=>git(dir,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length;
const refused={exit_code:1,error:expect.stringContaining('workspace_repository_recovery_required')};

beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-align-iso-')));
 root=join(sandbox,'repo');main=join(sandbox,'main');other=join(sandbox,'other');config=join(sandbox,'host');await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;
 server=createServer((request,response)=>{request.resume();request.on('end',()=>{response.writeHead(200,{'content-type':'application/json'});response.end('{}');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('no address');
 await initRepo(main);await initRepo(other);
 await symlink(root,join(sandbox,'alias'));
 await saveConfig({server_url:`http://127.0.0.1:${address.port}`,host_id:'host',trust:'trusted',token:'test',workspaces:{[LOCATION]:root,[MAIN]:main,[OTHER]:other,[ALIAS]:join(sandbox,'alias')}});
});
afterEach(async()=>{
 delete branchAlignBarriers.beforeTransaction;delete branchAlignBarriers.beforeWorktree;delete branchAlignBarriers.afterGate;
 durable.failAfter=null;resetBranchAlignGitForTest();resetQuarantineCacheForTest();server.close();delete process.env.RAINVER_HOST_CONFIG_DIR;
 await rm(sandbox,{recursive:true,force:true});
});

/** read-tree "succeeds" but leaves the index new and some files old: the state the stat cache can hide. */
async function quarantineByStaleFiles(){
 const {old,tip}=await initRepo(root,'dev');
 const frame=alignFrame(old,tip);
 branchAlignGit.readTree=async(holder,from,to)=>{
  execFileSync('git',['read-tree','-m','-u',from,to],{cwd:holder});
  // Same size, same mtime: only the content differs from what the index believes.
  const before=await stat(join(holder,'c.txt'));await writeFile(join(holder,'c.txt'),'X\n');await utimes(join(holder,'c.txt'),before.atime,before.mtime);
  return {code:0,stdout:'',stderr:''};
 };
 expect(await executeGitBranchAlign(root,frame)).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required'});
 resetBranchAlignGitForTest();
 return {old,tip,frame};
}

it('refuses a Run whose isolated attachment is a quarantined repository before preparing or mounting anything, through any alias, and lets an unrelated repository run',async()=>{
 const {tip}=await quarantineByStaleFiles();
 // Primary repository healthy, attachment repository isolated (also through an alias, also twice).
 for(const attached of [[LOCATION],[ALIAS],[LOCATION,ALIAS]]){
  const marker=join(sandbox,`ran-${randomUUID()}`);
  const before={root:worktreesOf(root),main:worktreesOf(main),refs:git(root,'for-each-ref')};
  expect(await run(attachedLaunch(MAIN,attached,marker))).toMatchObject(refused);
  expect(existsSync(marker)).toBe(false);
  // Nothing was prepared before the refusal: no worktree, branch or record in either repository.
  expect({root:worktreesOf(root),main:worktreesOf(main),refs:git(root,'for-each-ref')}).toEqual(before);
  expect(existsSync(join(config,'task-worktrees',LOCATION))).toBe(false);
  expect(existsSync(join(config,'task-worktrees',ALIAS))).toBe(false);
  expect(existsSync(join(config,'task-worktrees',MAIN))).toBe(false);
 }
 // A host command with the isolated attachment is refused too.
 expect(await runHostCommand({request_id:`cmd-${randomUUID()}`,command:['true'],timeout_seconds:30,workspace:{kind:'location',workspace_location_id:MAIN},workspace_access:[{workspace_location_id:ALIAS,access_mode:'write',execution_workspace:{id:randomUUID(),generation:1}}]} as never)).toMatchObject({error:'workspace_repository_recovery_required'});
 // An unrelated attachment repository is not affected.
 const marker=join(sandbox,'ran-unrelated');
 expect(await run(attachedLaunch(MAIN,[OTHER],marker))).toMatchObject({exit_code:0});
 expect(existsSync(marker)).toBe(true);
 // The person repairs the checkout; the same attachment launch is admitted.
 await writeFile(join(root,'c.txt'),'c\n');git(root,'reset','-q','--hard','HEAD');expect(git(root,'rev-parse','dev')).toBe(tip);
 const after=join(sandbox,'ran-after');
 expect(await run(attachedLaunch(MAIN,[LOCATION],after))).toMatchObject({exit_code:0});
 expect(existsSync(after)).toBe(true);expect(quarantineFiles()).toEqual([]);
});

it('makes an isolated attachment wait for an alignment of its repository and prepares nothing meanwhile',async()=>{
 const {old,tip}=await initRepo(root,'dev');
 let launched:Promise<Record<string,unknown>>|null=null;const marker=join(sandbox,'ran-waited');
 branchAlignBarriers.beforeTransaction=async()=>{
  const before=worktreesOf(root);
  launched=run(attachedLaunch(MAIN,[ALIAS],marker));
  await new Promise(r=>setTimeout(r,300));
  expect(worktreesOf(root)).toBe(before);expect(worktreesOf(main)).toBe(1);
  expect(existsSync(join(config,'task-worktrees',ALIAS))).toBe(false);
  expect(existsSync(marker)).toBe(false);
 };
 expect(await executeGitBranchAlign(root,alignFrame(old,tip),{workspaces:{[LOCATION]:root,[ALIAS]:join(sandbox,'alias')}})).toMatchObject({ok:true,outcome:'aligned'});
 expect(await launched).toMatchObject({exit_code:0});expect(existsSync(marker)).toBe(true);
});

it('isolates before the ref transaction: a lost update-ref result, a throw after it and a journal whose fsync fails after rename never let a Run into an unfinished repository',async()=>{
 const {old,tip}=await initRepo(root,'dev');
 // 1. The transaction commits but its result is lost: finished from the backup ref, not answered "source moved".
 branchAlignGit.updateRef=async(cwd,input,message)=>{execFileSync('git',['update-ref','-m',message,'--stdin'],{cwd,input});return {code:128,stdout:'',stderr:'lost'};};
 const lost=alignFrame(old,tip);
 expect(await executeGitBranchAlign(root,lost)).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await readFile(join(root,'c.txt'),'utf8')).toBe('c\n');expect(quarantineFiles()).toEqual([]);
 resetBranchAlignGitForTest();
 // 2. A throw after the transaction, before the checkout followed: still isolated, durably.
 git(root,'update-ref','refs/heads/dev',old,tip);git(root,'reset','-q','--hard','dev');
 const thrown=alignFrame(old,tip);
 branchAlignBarriers.beforeWorktree=async()=>{throw new Error('daemon interrupted');};
 await expect(executeGitBranchAlign(root,thrown)).rejects.toThrow('daemon interrupted');
 delete branchAlignBarriers.beforeWorktree;
 expect(quarantineFiles()).toEqual([`${thrown.operation_id}.json`]);
 expect(await run(taskLaunch(MAIN))).toMatchObject({exit_code:0});
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 resetQuarantineCacheForTest();
 expect(await run(taskLaunch(ALIAS))).toMatchObject(refused);
 // Its redelivery finishes the same operation (its own record does not refuse it) and lifts the isolation.
 expect(await executeGitBranchAlign(root,{...thrown,request_id:randomUUID()})).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(quarantineFiles()).toEqual([]);
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
 // 3. The final journal is renamed into place but its fsync fails: the error surfaces, isolation stays until proven.
 git(root,'update-ref','refs/heads/dev',old,tip);git(root,'reset','-q','--hard','dev');
 const unsynced=alignFrame(old,tip);
 durable.failAfter=(path,value)=>path.endsWith(`${unsynced.operation_id}.json`)&&(value as {state?:string}).state==='done';
 await expect(executeGitBranchAlign(root,unsynced)).rejects.toThrow('fsync failed');
 expect(quarantineFiles()).toEqual([`${unsynced.operation_id}.json`]);
 // After a restart the repository is proven consistent at its first start and works again.
 resetQuarantineCacheForTest();
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
 expect(quarantineFiles()).toEqual([]);
});

it('judges the checkout by its files: index new but a file old under a trusted stat cache, a file missing, or a merge in progress stay isolated',async()=>{
 // Content changed with size and mtime kept: `git diff` trusts the stat cache, the content check does not.
 const {tip}=await quarantineByStaleFiles();
 expect(git(root,'rev-parse','dev')).toBe(tip);expect(git(root,'write-tree')).toBe(git(root,'rev-parse',`${tip}^{tree}`));
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 resetQuarantineCacheForTest();
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 // A missing tracked file is not consistent either.
 await writeFile(join(root,'c.txt'),'c\n');await rm(join(root,'b.txt'));
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 // A merge in progress over otherwise correct files is not consistent.
 git(root,'checkout','-q','--','b.txt');
 await writeFile(join(root,'.git','MERGE_HEAD'),`${tip}\n`);
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 await rm(join(root,'.git','MERGE_HEAD'));
 // Exactly at the aligned commit: admitted, and launches really run again.
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
});

it('a partial read-tree is rolled back by CAS but stays isolated while its leftovers remain; a moved HEAD is never checked out over',async()=>{
 const {old,tip}=await initRepo(root,'dev');
 // Writes one file of the new tree, then fails.
 branchAlignGit.readTree=async holder=>{await writeFile(join(holder,'b.txt'),'b\n');return {code:128,stdout:'',stderr:'disk full'};};
 const partial=alignFrame(old,tip);
 expect(await executeGitBranchAlign(root,partial)).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required',backup_ref:`refs/rainver/branch-backups/${partial.operation_id}`});
 resetBranchAlignGitForTest();
 expect(git(root,'rev-parse','dev')).toBe(old);
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 await rm(join(root,'b.txt'));
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
 // A failed read-tree whose checkout is untouched (the person's ignored file, part of the recorded baseline, kept) is an ordinary refusal, not isolation.
 await writeFile(join(root,'.git','info','exclude'),'notes.txt\n');await writeFile(join(root,'notes.txt'),'mine\n');
 branchAlignGit.readTree=async()=>({code:128,stdout:'',stderr:'refused'});
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_worktree_update_failed'});
 resetBranchAlignGitForTest();
 expect(await readFile(join(root,'notes.txt'),'utf8')).toBe('mine\n');expect(quarantineFiles()).toEqual([]);
 await rm(join(root,'notes.txt'));await writeFile(join(root,'.git','info','exclude'),'');
 // An untracked file that appeared after the baseline was recorded is not adopted: isolated, the file kept, admitted once the person moves it.
 branchAlignGit.readTree=async()=>({code:128,stdout:'',stderr:'refused'});
 branchAlignBarriers.beforeWorktree=async()=>{await writeFile(join(root,'notes.txt'),'mine\n');};
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required'});
 resetBranchAlignGitForTest();delete branchAlignBarriers.beforeWorktree;
 expect(git(root,'rev-parse','dev')).toBe(old);expect(await readFile(join(root,'notes.txt'),'utf8')).toBe('mine\n');
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 await rm(join(root,'notes.txt'));
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});expect(quarantineFiles()).toEqual([]);
 // HEAD switched to another branch after the checks: nothing is checked out over it.
 git(root,'branch','side',old);
 const switched=alignFrame(old,tip);
 branchAlignBarriers.beforeWorktree=async()=>{git(root,'symbolic-ref','HEAD','refs/heads/side');};
 expect(await executeGitBranchAlign(root,switched)).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required'});
 expect(git(root,'rev-parse','HEAD')).toBe(old);expect(existsSync(join(root,'c.txt'))).toBe(false);
 // Isolated until proven: the source is now checked out nowhere and every checkout is clean, so the next start admits it.
 expect(quarantineFiles()).toEqual([`${switched.operation_id}.json`]);
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
 expect(quarantineFiles()).toEqual([]);
});

it('recovers at Host start: a crash with the index new and files old, and a crash during rollback with leftovers, isolate until repaired and then launch',async()=>{
 const {old,tip}=await initRepo(root,'dev');
 const crashed=alignFrame(old,tip);const {request_id:_,...meaning}=crashed;
 // The ref transaction committed and read-tree updated the index, then the Host died before the files were written.
 git(root,'update-ref',`refs/rainver/branch-backups/${crashed.operation_id}`,old);git(root,'update-ref','refs/heads/dev',tip,old);git(root,'read-tree',tip);
 await writeJsonDurable(join(config,'branch-align',LOCATION,`${crashed.operation_id}.json`),{fingerprint:JSON.stringify(meaning),meaning,state:'intent',holder:root,common_dir:join(root,'.git')});
 const logs:string[]=[];
 await recoverBranchAlignments(async()=>root,{},line=>logs.push(line));
 expect(logs.join('\n')).toContain('repository isolated');
 expect(git(root,'rev-parse','dev')).toBe(tip);expect(existsSync(join(root,'c.txt'))).toBe(false);
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 resetQuarantineCacheForTest();
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 // Reset alone leaves the old tree's file behind as an untracked leftover: still isolated until it is gone.
 git(root,'reset','-q','--hard','HEAD');
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 git(root,'clean','-fdq');
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
 // A crash during rollback, with a leftover of the new tree in the checkout.
 git(root,'update-ref','refs/heads/dev',old,tip);git(root,'reset','-q','--hard','dev');
 const rolling=alignFrame(old,tip);const {request_id:_r,...rollMeaning}=rolling;
 git(root,'update-ref',`refs/rainver/branch-backups/${rolling.operation_id}`,old);git(root,'update-ref','refs/heads/dev',tip,old);
 await writeFile(join(root,'b.txt'),'b\n');
 await writeJsonDurable(join(config,'branch-align',LOCATION,`${rolling.operation_id}.json`),{fingerprint:JSON.stringify(rollMeaning),meaning:rollMeaning,state:'rollback',holder:root,common_dir:join(root,'.git'),untracked:[]});
 resetQuarantineCacheForTest();
 await recoverBranchAlignments(async()=>root);
 expect(git(root,'rev-parse','dev')).toBe(old);
 expect(await executeGitBranchAlign(root,{...rolling,request_id:randomUUID()})).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required'});
 expect(await run(taskLaunch(LOCATION))).toMatchObject(refused);
 await rm(join(root,'b.txt'));
 expect(await run(taskLaunch(LOCATION))).toMatchObject({exit_code:0});
 expect(quarantineFiles()).toEqual([]);
});
