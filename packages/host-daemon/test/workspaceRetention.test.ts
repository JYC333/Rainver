import {chmod,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {checkLocationRepository,taskLeaseKey} from '../src/taskWorktree.js';
import {executeWorkspaceCommand as execute,prepareExecutionWorkspace} from '../src/executionWorkspace.js';
import {acquireLocationLeases,isLeaseBusy,releaseLocationLeases} from '../src/locationLease.js';
import {readWorkspaceFile,versionPresence} from '../src/workspaceFileRead.js';
import {workspaceWorktreeKey} from '../src/worktreeIdentity.js';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';

let configDir:string,repoDir:string;
const git=(args:string[],cwd=repoDir)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const author={name:'Agent',email:'agent@example.com'};

beforeEach(async()=>{
 configDir=await realpath(await mkdtemp(join(tmpdir(),'rainver-retention-config-')));
 repoDir=await realpath(await mkdtemp(join(tmpdir(),'rainver-retention-repo-')));
 process.env.RAINVER_HOST_CONFIG_DIR=configDir;
 await saveConfig({server_url:'http://127.0.0.1:9',host_id:'host-1',trust:'trusted',token:'t',workspaces:{'folder-1':repoDir}});
 git(['init','-q','-b','main']);git(['config','user.email','p@example.com']);git(['config','user.name','P']);
 await writeFile(join(repoDir,'README.md'),'hello\n');git(['add','.']);git(['commit','-qm','initial']);
});
afterEach(async()=>{
 delete process.env.RAINVER_HOST_CONFIG_DIR;
 await rm(configDir,{recursive:true,force:true});await rm(repoDir,{recursive:true,force:true});
});

// The command's reply is a union per action; these tests read the cleanup/inventory fields.
const executeWorkspaceCommand=async(root:string|null,f:Parameters<typeof execute>[1])=>(await execute(root,f)) as any;
const frame=(ref:ExecutionWorkspaceRef,extra:Record<string,unknown>)=>({type:'execution_workspace_command' as const,request_id:randomUUID(),operation_id:randomUUID(),retain_branch:true,
 workspace:{kind:'location' as const,workspace_location_id:'folder-1',execution_workspace:ref},...extra}) as Parameters<typeof executeWorkspaceCommand>[1];

/** One Run writes `file`, its checkpoint is saved; returns the branch tip. */
async function savedRun(ref:ExecutionWorkspaceRef,file:string,content:string){
 const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
 const runId=randomUUID(),prepared=await prepareExecutionWorkspace(check.repo,'folder-1',ref,runId);
 await writeFile(join(prepared.root,file),content);
 const saved=await executeWorkspaceCommand(repoDir,frame(ref,{action:'checkpoint',run_id:runId,author,message:'save'}));
 expect(saved.ok).toBe(true);
 return {tip:saved.commit!,prepared};
}
/** A native publication: a new commit with the checked tree on top of main. */
function publishLikeNative(tip:string){
 const merged=git(['commit-tree',`${tip}^{tree}`,'-p','main','-m','published']);
 git(['update-ref','refs/heads/main',merged]);git(['reset','-q','--hard','main']);
 return merged;
}

describe('workspace branch and ref retention',()=>{
 it('releases a merged branch whose tip is not a target ancestor, its owned refs and receipts',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const key=workspaceWorktreeKey(ref);
  const {tip}=await savedRun(ref,'feature.txt','done');
  const merged=publishLikeNative(tip);
  expect(()=>git(['merge-base','--is-ancestor',tip,'main'])).toThrow();
  const owned=`refs/rainver/recovery/${ref.id}/${tip}`,shared=`refs/rainver/sources/${merged}`,foreign=`refs/rainver/recovery/${randomUUID()}/${tip}`;
  for(const name of [owned,shared,foreign])git(['update-ref',name,name===shared?merged:tip]);
  const inspected=await executeWorkspaceCommand(repoDir,frame(ref,{action:'inspect'}));
  expect(inspected.inventory).toMatchObject({branch:true,owned_refs:[{ref:owned,commit:tip}],materialization_epoch:0});
  const command=frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged],
   release_refs:[{ref:owned,expected_commit:tip},{ref:shared},{ref:foreign}]});
  const result=await executeWorkspaceCommand(repoDir,command);
  // A shared source is never deleted by a branch release (only by a fence-marked ref operation).
  expect(result).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false,worktree:false,registration:false,owned_refs:[],retained_refs:[{ref:shared,reason:'ref_release_unfenced'},{ref:foreign,reason:'ref_release_refused'}]}});
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/']).split('\n')).toEqual([foreign,shared]);
  expect(existsSync(join(configDir,'workspace-sequences','folder-1',`${key}.json`))).toBe(false);
  expect(existsSync(join(configDir,'workspace-baselines','folder-1',`${key}.json`))).toBe(false);
  // A replay of the completed operation stays cleaned without repeating work.
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false}});
 });

 it('keeps an unmerged or private-baseline branch while reclaiming only its physical tree',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip}=await savedRun(ref,'unmerged.txt','only copy');
  const own=`refs/rainver/native-preimages/${ref.id}/g1/${randomUUID()}`;git(['update-ref',own,tip]);
  const result=await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[git(['rev-parse','main'])],release_refs:[{ref:own}]}));
  expect(result).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:true,worktree:false,branch_retained_reason:'workspace_reclaim_unproven'}});
  expect(git(['show',`rainver/workspace-${ref.id}-g1:unmerged.txt`])).toBe('only copy');
  // Refs are never released when the branch proof failed.
  expect(git(['rev-parse',own])).toBe(tip);
 });

 it('discards an explicitly reviewed unmerged tip, removes its directory and branch, and retains bounded recovery refs',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const {tip,prepared}=await savedRun(ref,'obsolete.txt','obsolete private work');
  const command=frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip,discard_commit:tip});
  const result=await executeWorkspaceCommand(repoDir,command);
  expect(result).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false,worktree:false,registration:false,history_refs:[tip]}});
  expect(existsSync(prepared.root)).toBe(false);
  expect(git(['show',`refs/rainver/run-history/${ref.id}/g1/${tip}:obsolete.txt`])).toBe('obsolete private work');
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,inventory:{branch:false}});
  expect(await executeWorkspaceCommand(repoDir,{...command,discard_commit:git(['rev-parse','main'])})).toMatchObject({ok:false});
 });

 it('never discards a moved or dirty source or accepts a discard without an epoch',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const {tip,prepared}=await savedRun(ref,'only.txt','keep');
  const raw={action:'cleanup',retain_branch:false,expected_commit:tip,discard_commit:tip};
  expect(await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:undefined},raw))).toMatchObject({ok:false,error:'workspace_discard_invalid'});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{...raw,expected_commit:git(['rev-parse','main']),discard_commit:git(['rev-parse','main'])}))).toMatchObject({ok:false,error:'workspace_generation_moved'});
  await writeFile(join(prepared.root,'only.txt'),'unsaved');
  expect(await executeWorkspaceCommand(repoDir,frame(ref,raw))).toMatchObject({ok:false,error:'workspace_uncheckpointed'});
  expect(git(['rev-parse',`refs/heads/rainver/workspace-${ref.id}-g1`])).toBe(tip);
  expect(await readFile(join(prepared.root,'only.txt'),'utf8')).toBe('unsaved');
 });

 it('rebuilds the same identity from the target with a monotonic sequence and fences the older cleanup',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip,prepared}=await savedRun(ref,'a.txt','a');
  const merged=publishLikeNative(tip);
  const released=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged]}));
  expect(released.inventory?.branch).toBe(false);
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  // A launch admitted before the release carries the older epoch: refused.
  const stale=await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:0,base_commit:tip},randomUUID()).catch(e=>e as Error);
  expect(stale).toBeInstanceOf(Error);expect((stale as Error).message).toBe('workspace_materialization_stale');
  const rebuilt=await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:2,sync_to_target:true,launch_sequence_floor:prepared.launchSequence},randomUUID());
  expect(rebuilt.startCommit).toBe(merged);expect(rebuilt.root).toBe(prepared.root);
  expect(rebuilt.launchSequence).toBe(prepared.launchSequence+1);
  expect(await readFile(join(rebuilt.root,'a.txt'),'utf8')).toBe('a');
  // The older epoch's cleanup at the very same tip cannot remove the rebuild.
  const late=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:merged,reclaim_proof:[merged]}));
  expect(late).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_materialization_moved',inventory:{branch:true,worktree:true}});
 });

 it('resumes a release that failed after the branch went, under a fresh operation id, and finishes refs and receipts',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const key=workspaceWorktreeKey(ref);
  const {tip}=await savedRun(ref,'b.txt','b');const merged=publishLikeNative(tip);
  const owned=`refs/rainver/recovery/${ref.id}/${tip}`;git(['update-ref',owned,tip]);
  // Fault after the branch release: the ref cannot be deleted (a held ref lock).
  const lock=join(repoDir,'.git',`${owned}.lock`);await writeFile(lock,'');
  const release={action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged],release_refs:[{ref:owned,expected_commit:tip}]};
  const failed=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},release));
  expect(failed).toMatchObject({ok:false,cleanup_state:'retry_wait',inventory:{branch:false,retained_refs:[{ref:owned,reason:'ref_release_failed'}]}});
  // Receipts and the fence are not finished while refs remain.
  expect(existsSync(join(configDir,'workspace-sequences','folder-1',`${key}.json`))).toBe(true);
  expect(failed.inventory.materialization_epoch).toBeLessThanOrEqual(1);
  await rm(lock);
  // A retry/reconciliation re-delivers the same release with a new operation id.
  const resumed=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},release));
  expect(resumed).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false,owned_refs:[],materialization_epoch:2}});
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/'])).toBe('');
  expect(existsSync(join(configDir,'workspace-sequences','folder-1',`${key}.json`))).toBe(false);
 });

 it('serializes a release and a newer launch under the Task lease, so the launch rebuilds after the release finished',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const key=workspaceWorktreeKey(ref),lease=taskLeaseKey('folder-1',key);
  const {tip,prepared}=await savedRun(ref,'c.txt','c');const merged=publishLikeNative(tip);
  const cleanup=executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged]}));
  // Barrier: wait until the cleanup is inside its critical section.
  while(!isLeaseBusy(lease))await new Promise(r=>setImmediate(r));
  let queued=false;const launch={runId:randomUUID(),launchId:randomUUID()};
  const acquired=await acquireLocationLeases([lease],launch,()=>{queued=true;});
  expect(acquired).toBe('acquired');expect(queued).toBe(true);
  // The launch prepares as soon as it holds the lease, before anyone awaits the cleanup.
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  let rebuilt:Awaited<ReturnType<typeof prepareExecutionWorkspace>>;
  try{
   rebuilt=await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:2,sync_to_target:true,launch_sequence_floor:prepared.launchSequence},launch.runId);
   expect(rebuilt.startCommit).toBe(merged);
  }finally{releaseLocationLeases([lease],launch.launchId);}
  expect(await cleanup).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false}});
  // Nothing of the older release ran after the launch: its receipts, branch and tree survive.
  expect(JSON.parse(await readFile(join(configDir,'workspace-sequences','folder-1',`${key}.json`),'utf8')).sequence).toBe(rebuilt.launchSequence);
  expect(existsSync(join(configDir,'workspace-baselines','folder-1',`${key}.json`))).toBe(true);
  expect(existsSync(join(rebuilt.root,'c.txt'))).toBe(true);
  // A cleanup still in flight for the older epoch is refused under the lease, at the same tip.
  const late=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:merged,reclaim_proof:[merged]}));
  expect(late).toMatchObject({ok:false,error:'workspace_materialization_moved',inventory:{branch:true,worktree:true}});
  // While a launch holds the lease, a cleanup changes nothing and asks to retry.
  const holder={runId:randomUUID(),launchId:randomUUID()};await acquireLocationLeases([lease],holder,()=>{});
  try{expect(await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:2},{action:'cleanup',retain_branch:false,expected_commit:merged,reclaim_proof:[merged]}))).toMatchObject({ok:false,error:'task_busy'});}
  finally{releaseLocationLeases([lease],holder.launchId);}
  expect(git(['rev-parse',`rainver/workspace-${ref.id}-g1`])).toBe(merged);
 });

 it('proves an unchanged delta applied by another commit even when the target also moved on',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const base=git(['rev-parse','main']);
  const {tip}=await savedRun(ref,'feature.txt','same change\n');
  // The same change reaches main through a different commit, followed by unrelated work.
  await writeFile(join(repoDir,'feature.txt'),'same change\n');git(['add','.']);git(['commit','-qm','cherry-picked']);
  await writeFile(join(repoDir,'README.md'),'hello\nmore\n');git(['add','.']);git(['commit','-qm','extra']);
  expect(()=>git(['merge-base','--is-ancestor',tip,'main'])).toThrow();
  // A hostile or wrong base nomination (the tip itself) is ignored, not trusted.
  const released=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[],reclaim_bases:[tip,base]}));
  expect(released).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false}});
  expect(released.inventory.branch_retained_reason).toBeUndefined();
 });

 it('refuses a delta the target does not contain, whatever bases the server nominates',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip}=await savedRun(ref,'feature.txt','only here\n');
  await writeFile(join(repoDir,'other.txt'),'x\n');git(['add','.']);git(['commit','-qm','unrelated']);
  const refused=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[],reclaim_bases:[tip]}));
  expect(refused).toMatchObject({ok:true,inventory:{branch:true,branch_retained_reason:'workspace_reclaim_unproven'}});
 });

 it('pages owned refs beyond the inventory bound with a cursor',async()=>{
  const ref={id:randomUUID(),generation:1};
  const head=git(['rev-parse','HEAD']);
  const names=Array.from({length:205},(_,i)=>`refs/rainver/native-preimages/${ref.id}/g1/${randomUUID()}`).sort();
  execFileSync('git',['update-ref','--stdin'],{cwd:repoDir,input:names.map(n=>`create ${n} ${head}\n`).join('')});
  const first=await executeWorkspaceCommand(repoDir,frame(ref,{action:'inspect'}));
  expect(first.inventory.owned_refs).toHaveLength(200);
  expect(first.inventory).toMatchObject({owned_refs_truncated:true,owned_refs_next:names[199]});
  const second=await executeWorkspaceCommand(repoDir,frame(ref,{action:'inspect',list_after:first.inventory.owned_refs_next}));
  expect(second.inventory.owned_refs.map((r:{ref:string})=>r.ref)).toEqual(names.slice(200));
  expect(second.inventory).toMatchObject({owned_refs_truncated:false,owned_refs_next:null});
 });

 it('keeps an intermediate Run version readable through an owned run-history ref after the branch is released',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'notes.txt','draft one\n');
  const second=await savedRun(ref,'notes.txt','final\n');
  const merged=publishLikeNative(second.tip);
  const result=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:second.tip,reclaim_proof:[merged],history_commits:[first.tip,second.tip,merged]}));
  expect(result).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false}});
  // Only versions the target cannot reach are kept; the merged commit needs none.
  expect([...result.inventory.history_refs].sort()).toEqual([first.tip,second.tip].sort());
  expect(git(['rev-parse',`refs/rainver/run-history/${ref.id}/g1/${first.tip}`])).toBe(first.tip);
  const file=await readWorkspaceFile(repoDir,'folder-1',ref,first.tip,'notes.txt');
  expect(Buffer.from(file.content_base64,'base64').toString()).toBe('draft one\n');
  // The history refs are released later by exact name and CAS, like other owned refs.
  const released=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_refs:[first.tip,second.tip].map(c=>({ref:`refs/rainver/run-history/${ref.id}/g1/${c}`,expected_commit:c}))}));
  expect(released.inventory.retained_refs).toEqual([]);
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/run-history/'])).toBe('');
 });

 it('deletes shared refs only by CAS and pages the Location ref inventory',async()=>{
  const ref={id:randomUUID(),generation:1};
  const head=git(['rev-parse','HEAD']);
  await writeFile(join(repoDir,'x.txt'),'x');git(['add','.']);git(['commit','-qm','x']);const other=git(['rev-parse','HEAD']);
  const moved=`refs/rainver/sources/${head}`;git(['update-ref',moved,other]);
  const preimage=`refs/rainver/local-preimages/${other}`;git(['update-ref',preimage,other]);git(['update-ref',`${preimage}-index`,other]);
  const released=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',source_fence:true,release_refs:[{ref:moved},{ref:preimage,prefix:true},{ref:'refs/rainver/anything/else'}]}));
  expect(released.inventory?.retained_refs).toEqual([{ref:moved,reason:'ref_moved'},{ref:'refs/rainver/anything/else',reason:'ref_release_refused'}]);
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/'])).toBe(moved);
  for(let i=0;i<3;i++)git(['update-ref',`refs/rainver/recovery/${randomUUID()}`,head]);
  const page=await executeWorkspaceCommand(repoDir,frame(ref,{action:'list_refs'}));
  expect(page.refs).toHaveLength(4);expect(page.refs_next).toBeNull();
  const after=await executeWorkspaceCommand(repoDir,frame(ref,{action:'list_refs',list_after:page.refs![1]!.ref}));
  expect(after.refs).toEqual(page.refs!.slice(2));
 });
 it('runs a ref operation once under the Task lease: busy proves nothing, a re-delivery after it ended replays without touching Git',async()=>{
  const ref={id:randomUUID(),generation:1};
  const key=workspaceWorktreeKey(ref),lease=taskLeaseKey('folder-1',key);
  const head=git(['rev-parse','HEAD']),source=`refs/rainver/sources/${head}`;
  git(['update-ref',source,head]);
  const op=randomUUID(),release={action:'release_refs',operation_id:op,source_fence:true,release_refs:[{ref:source,expected_commit:head}]};
  // While the identity's lease is held (a slow earlier delivery, a launch), nothing runs and nothing is confirmed.
  const holder={runId:randomUUID(),launchId:randomUUID()};await acquireLocationLeases([lease],holder,()=>{});
  try{
   const busy=await executeWorkspaceCommand(repoDir,frame(ref,release));
   expect(busy).toMatchObject({ok:false,error:'task_busy'});
   expect(busy.inventory?.ref_operation).toBeUndefined();
   expect(git(['rev-parse',source])).toBe(head);
  }finally{releaseLocationLeases([lease],holder.launchId);}
  const done=await executeWorkspaceCommand(repoDir,frame(ref,release));
  expect(done).toMatchObject({ok:true,inventory:{ref_operation:op,retained_refs:[]}});
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/sources/'])).toBe('');
  // A dependent re-created the ref after the confirmed deletion: a late re-delivery of the same operation replays only.
  git(['update-ref',source,head]);
  expect(await executeWorkspaceCommand(repoDir,frame(ref,release))).toMatchObject({ok:true,inventory:{ref_operation:op}});
  expect(git(['rev-parse',source])).toBe(head);
  // The same operation id with other content is refused, unconfirmed and without side effects.
  const conflict=await executeWorkspaceCommand(repoDir,frame(ref,{...release,release_refs:[{ref:source,expected_commit:head},{ref:`refs/rainver/recovery/${randomUUID()}`}]}));
  expect(conflict).toMatchObject({ok:false,error:'workspace_ref_operation_conflict'});
  expect(conflict.inventory?.ref_operation).toBeUndefined();
  expect(git(['rev-parse',source])).toBe(head);
 });

 it('settles earlier ref operations under the Task lease: a finished one reports its result, any other is cancelled for good before the settle replies',async()=>{
  const ref={id:randomUUID(),generation:1};
  const key=workspaceWorktreeKey(ref),lease=taskLeaseKey('folder-1',key);
  const head=git(['rev-parse','HEAD']),source=`refs/rainver/sources/${head}`;
  git(['update-ref',source,head]);
  const finished=randomUUID(),pending=randomUUID(),settle=randomUUID();
  const release=(op:string)=>({action:'release_refs',operation_id:op,source_fence:true,release_refs:[{ref:source,expected_commit:head}]});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,release(finished)))).toMatchObject({ok:true,inventory:{ref_operation:finished}});
  git(['update-ref',source,head]); // a dependent re-pinned it after that confirmed deletion
  // While a delivery holds the identity's lease the settle cannot run: busy, nothing settled.
  const holder={runId:randomUUID(),launchId:randomUUID()};await acquireLocationLeases([lease],holder,()=>{});
  try{expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',operation_id:settle,settle_operations:[pending]}))).toMatchObject({ok:false,error:'task_busy'});}
  finally{releaseLocationLeases([lease],holder.launchId);}
  const settled=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',operation_id:settle,settle_operations:[finished,pending]}));
  expect(settled).toMatchObject({ok:true,inventory:{ref_operation:settle,settled_operations:[{operation_id:finished,state:'finished',retained_refs:[]},{operation_id:pending,state:'cancelled'}]}});
  // The cancelled operation, delivered late (a slow or reconnecting copy), deletes nothing and confirms nothing.
  const late=await executeWorkspaceCommand(repoDir,frame(ref,release(pending)));
  expect(late).toMatchObject({ok:false,error:'workspace_ref_operation_cancelled'});
  expect(late.inventory?.ref_operation).toBeUndefined();
  expect(git(['rev-parse',source])).toBe(head);
  // A re-delivery of the settle replays its own result.
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',operation_id:settle,settle_operations:[finished,pending]}))).toMatchObject({inventory:{settled_operations:[{state:'finished'},{state:'cancelled'}]}});
 });

 it('keeps a dependent commit under an independent keeper before settling, and restores its shared name in that same operation, through real GC',async()=>{
  const ref={id:randomUUID(),generation:1},other={id:randomUUID(),generation:1};
  const parent=git(['rev-parse','HEAD']);
  const env={...process.env,GIT_AUTHOR_DATE:'2024-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2024-01-01T00:00:00Z'};
  // Old objects reachable only through their shared ref: GC prunes them at once once unreachable.
  const old=(m:string)=>{const c=execFileSync('git',['commit-tree',`${parent}^{tree}`,'-p',parent,'-m',m],{cwd:repoDir,encoding:'utf8',env}).trim();git(['update-ref',`refs/rainver/sources/${c}`,c]);execFileSync('touch',['-d','2024-01-01T00:00:00Z',join(repoDir,'.git','objects',c.slice(0,2),c.slice(2))]);return c;};
  const kept=old('kept'),shared=old('shared'),lost=old('lost');
  const gc=()=>git(['gc','-q','--prune=2.weeks.ago']);
  const present=(c:string)=>{try{git(['cat-file','-e',`${c}^{commit}`]);return true;}catch{return false;}};
  const refOf=(name:string)=>{try{return git(['rev-parse','--verify','--quiet',name]);}catch{return null;}};
  const keeper=(c:string,r=ref)=>`refs/rainver/source-keepers/${r.id}/g${r.generation}/${c}`;
  // Before this mechanism: an unfenced deletion of `lost` ran on an old Host and GC pruned it.
  git(['update-ref','-d',`refs/rainver/sources/${lost}`]);gc();
  expect(present(lost)).toBe(false);
  const earlier=randomUUID(),otherEarlier=randomUUID(),settle=randomUUID();
  // Earlier unfenced copies on this Host (reclaim 4) delete no shared source, whatever their content.
  const late=await executeWorkspaceCommand(repoDir,frame(other,{action:'release_refs',operation_id:otherEarlier,release_refs:[{ref:`refs/rainver/sources/${shared}`,expected_commit:shared}]}));
  expect(late.inventory?.retained_refs).toEqual([{ref:`refs/rainver/sources/${shared}`,reason:'ref_release_unfenced'}]);
  expect(refOf(`refs/rainver/sources/${shared}`)).toBe(shared);
  // One operation: keepers first, then the settle, then the shared names no other deletion fences, then those keepers go.
  const command={action:'release_refs',operation_id:settle,settle_operations:[earlier],keep_sources:[kept,shared,lost],pin_sources:[kept],release_keepers:[kept]};
  const settled=await executeWorkspaceCommand(repoDir,frame(ref,command));
  expect(settled).toMatchObject({ok:true,inventory:{ref_operation:settle,settled_operations:[{operation_id:earlier,state:'cancelled'}],pinned_sources:[kept]}});
  // `shared` stays under its keeper (another operation still fences its name); `lost` has no object, so neither.
  expect(settled.inventory.kept_sources).toEqual([shared]);
  expect(refOf(keeper(kept))).toBeNull();
  expect(refOf(keeper(shared))).toBe(shared);
  // The cancelled operation arrives late: nothing runs.
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',operation_id:earlier,source_fence:true,release_refs:[{ref:`refs/rainver/sources/${kept}`,expected_commit:kept}]}))).toMatchObject({ok:false,error:'workspace_ref_operation_cancelled'});
  // An old Host's copy had removed the shared name anyway: the keeper alone keeps the object through GC.
  git(['update-ref','-d',`refs/rainver/sources/${shared}`]);gc();
  expect(present(kept)).toBe(true);expect(present(shared)).toBe(true);
  // No release list can name a keeper, fenced or not.
  const refused=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',source_fence:true,release_refs:[{ref:keeper(shared),expected_commit:shared}]}));
  expect(refused.inventory?.retained_refs).toEqual([{ref:keeper(shared),reason:'ref_release_refused'}]);
  // A lost reply: the re-delivered settle replays its result, it does not run again.
  expect((await executeWorkspaceCommand(repoDir,frame(ref,command))).inventory).toMatchObject({kept_sources:[shared],pinned_sources:[kept]});
  // Restoration once no other deletion fences it: the shared name first, then its keeper.
  const restored=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',pin_sources:[shared],release_keepers:[shared]}));
  expect(restored).toMatchObject({ok:true,inventory:{pinned_sources:[shared],kept_sources:[]}});
  expect(refOf(keeper(shared))).toBeNull();
  gc();
  expect(refOf(`refs/rainver/sources/${shared}`)).toBe(shared);expect(refOf(`refs/rainver/sources/${kept}`)).toBe(kept);
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/source-keepers/'])).toBe('');
 });

 it('lets normal Git GC prune an old object right after its only ref is deleted, so a re-pin after the deletion cannot restore it',async()=>{
  // Why the server fences dependents before the deletion instead of re-pinning after it.
  const ref={id:randomUUID(),generation:1};
  const parent=git(['rev-parse','HEAD']);
  const frozen=execFileSync('git',['commit-tree',`${parent}^{tree}`,'-p',parent,'-m','frozen'],{cwd:repoDir,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2024-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2024-01-01T00:00:00Z'}}).trim();
  const source=`refs/rainver/sources/${frozen}`;git(['update-ref',source,frozen]);
  // Object age, not deletion time, is what Git's prune expiry measures.
  const loose=join(repoDir,'.git','objects',frozen.slice(0,2),frozen.slice(2));
  execFileSync('touch',['-d','2024-01-01T00:00:00Z',loose]);
  const released=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',source_fence:true,release_refs:[{ref:source,expected_commit:frozen}]}));
  expect(released).toMatchObject({ok:true,inventory:{retained_refs:[]}});
  git(['gc','-q','--prune=2.weeks.ago']);
  expect(()=>git(['cat-file','-e',`${frozen}^{commit}`])).toThrow();
  const repin=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',pin_sources:[frozen]}));
  // Reported missing, never as pinned: the server keeps such a release unfinished.
  expect(repin).toMatchObject({ok:true,inventory:{pinned_sources:[]}});
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/sources/'])).toBe('');
 });

 it('re-pins a shared source only when it is missing and its commit is present',async()=>{
  const ref={id:randomUUID(),generation:1};
  const head=git(['rev-parse','HEAD']),absent='e'.repeat(40);
  const pinned=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',pin_sources:[head,absent]}));
  expect(pinned).toMatchObject({ok:true,inventory:{pinned_sources:[head]}});
  expect(git(['rev-parse',`refs/rainver/sources/${head}`])).toBe(head);
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/sources/'])).toBe(`refs/rainver/sources/${head}`);
 });

 it('refuses an older Run-history expiry once a newer release kept the commit again, and lets the newer expiry delete it',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'notes.txt','draft\n');
  const second=await savedRun(ref,'notes.txt','final\n');
  const merged=publishLikeNative(second.tip);
  const name=`refs/rainver/run-history/${ref.id}/g1/${first.tip}`;
  // Release epoch 1 keeps the draft version.
  const released=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:second.tip,reclaim_proof:[merged],history_commits:[first.tip]}));
  expect(released).toMatchObject({ok:true,inventory:{history_refs:[first.tip],history_epochs:{[first.tip]:1},history_refs_next:null}});
  // An expiry issued for an older keeper (epoch 0) never removes it.
  const stale=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_refs:[{ref:name,expected_commit:first.tip,kept_epoch:0}]}));
  expect(stale.inventory.retained_refs).toEqual([{ref:name,reason:'ref_renewed'}]);
  expect(git(['rev-parse',name])).toBe(first.tip);
  // The current keeper's own expiry deletes it by CAS.
  const due=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_refs:[{ref:name,expected_commit:first.tip,kept_epoch:1}]}));
  expect(due.inventory.retained_refs).toEqual([]);
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/run-history/'])).toBe('');
 });

 it('pages a generation\'s Run-history inventory past 1000 refs with a cursor',async()=>{
  const ref={id:randomUUID(),generation:1};
  const commits:string[]=[];let parent=git(['rev-parse','HEAD']);
  const tree=git(['rev-parse','HEAD^{tree}']);
  for(let i=0;i<1203;i++){parent=execFileSync('git',['commit-tree',tree,'-p',parent,'-m',`v${i}`],{cwd:repoDir,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'A',GIT_AUTHOR_EMAIL:'a@x',GIT_COMMITTER_NAME:'A',GIT_COMMITTER_EMAIL:'a@x'}}).trim();commits.push(parent);}
  execFileSync('git',['update-ref','--stdin'],{cwd:repoDir,input:commits.map(c=>`create refs/rainver/run-history/${ref.id}/g1/${c} ${c}\n`).join('')});
  const seen:string[]=[];let after:string|undefined;
  for(let round=0;round<3;round++){
   const page=await executeWorkspaceCommand(repoDir,frame(ref,{action:'inspect',...(after?{history_after:after}:{})}));
   seen.push(...page.inventory.history_refs);
   expect(page.inventory.history_refs.length).toBeLessThanOrEqual(1000);
   after=page.inventory.history_refs_next??undefined;
   if(!after)break;
  }
  expect(after).toBeUndefined();
  expect(seen.sort()).toEqual([...commits].sort());
 });

 it('replays a release whose fence was recorded before its completion journal (crash between them)',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'n.txt','one\n');const second=await savedRun(ref,'n.txt','two\n');
  const merged=publishLikeNative(second.tip);
  const release={action:'cleanup',retain_branch:false,expected_commit:second.tip,reclaim_proof:[merged],history_commits:[first.tip,second.tip]};
  const command=frame({...ref,materialization_epoch:1},release);
  const done=await executeWorkspaceCommand(repoDir,command);
  expect(done).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{materialization_epoch:2}});
  // Fault injection: the process died after the atomic fence+result record, before its journal said cleaned.
  const journal=join(configDir,'workspace-cleanup',`${command.operation_id}.json`);
  const stored=JSON.parse(await readFile(journal,'utf8'));
  await writeFile(journal,JSON.stringify({fingerprint:stored.fingerprint,state:'running'}));
  for(const retry of [command,frame({...ref,materialization_epoch:1},release)]){
   const replayed=await executeWorkspaceCommand(repoDir,retry);
   // Not `workspace_materialization_moved`: the same release's result comes back, history included.
   expect(replayed).toMatchObject({ok:true,cleanup_state:'cleaned',error:null,inventory:{branch:false}});
   expect([...replayed.inventory.history_refs].sort()).toEqual([first.tip,second.tip].sort());
  }
  // A launch rebuilds; the release's re-delivery still replays, a different older request is refused.
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:2,sync_to_target:true},randomUUID());
  expect(await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},release))).toMatchObject({ok:true,cleanup_state:'cleaned'});
  expect(git(['rev-parse',`rainver/workspace-${ref.id}-g1`])).toBe(merged);
 });

 it('keeps Run history recoverable when refs fail after the branch went, and for a release with no branch at all',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'h.txt','draft\n');const second=await savedRun(ref,'h.txt','final\n');
  const merged=publishLikeNative(second.tip);
  const owned=`refs/rainver/recovery/${ref.id}/${second.tip}`;git(['update-ref',owned,second.tip]);
  const lock=join(repoDir,'.git',`${owned}.lock`);await writeFile(lock,'');
  const release={action:'cleanup',retain_branch:false,expected_commit:second.tip,reclaim_proof:[merged],history_commits:[first.tip,second.tip],release_refs:[{ref:owned,expected_commit:second.tip}]};
  const failed=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},release));
  expect(failed).toMatchObject({ok:false,cleanup_state:'retry_wait',inventory:{branch:false}});
  expect([...failed.inventory.history_refs].sort()).toEqual([first.tip,second.tip].sort());
  await rm(lock);
  // The retry sees no tip: the history list is recovered from the owned refs, never empty.
  const resumed=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},release));
  expect(resumed).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false}});
  expect([...resumed.inventory.history_refs].sort()).toEqual([first.tip,second.tip].sort());
  // A branch that never existed on this Host: exact evidence only (present, unreachable commits).
  const other={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const missing='0'.repeat(40);
  const none=await executeWorkspaceCommand(repoDir,frame({...other,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:second.tip,reclaim_proof:[],history_commits:[first.tip,missing,merged]}));
  expect(none).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false,history_refs:[first.tip]}});
 });

 it('releases a prefix family exactly, even behind more than a page of unrelated names that sort first',async()=>{
  const ref={id:randomUUID(),generation:1};
  const head=git(['rev-parse','HEAD']);
  const prefix=`refs/rainver/local-preimages/${head}`;
  const foreign=Array.from({length:205},(_,i)=>`${prefix}-${String(i).padStart(3,'0')}`);
  execFileSync('git',['update-ref','--stdin'],{cwd:repoDir,input:[prefix,`${prefix}-index`,...foreign].map(n=>`create ${n} ${head}\n`).join('')});
  // `-000`…`-204` sort before `-index`: a 200-name glob page would have cut the real member off.
  const released=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_refs:[{ref:prefix,prefix:true}]}));
  expect(released).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{retained_refs:[]}});
  const left=git(['for-each-ref','--format=%(refname)','refs/rainver/local-preimages/']).split('\n');
  expect(left).toEqual(foreign);
 });

 it('never releases the branch, refs, receipts or fence beside a whole-tree quarantine',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const key=workspaceWorktreeKey(ref);
  const {tip,prepared}=await savedRun(ref,'q.txt','q');const merged=publishLikeNative(tip);
  const owned=`refs/rainver/recovery/${ref.id}/${tip}`;git(['update-ref',owned,tip]);
  // A directory at the tree path that is not a worktree: the cleanup quarantines it whole.
  if(existsSync(prepared.root))await rm(prepared.root,{recursive:true,force:true});git(['worktree','prune']);
  await mkdir(prepared.root,{recursive:true});await writeFile(join(prepared.root,'unsaved.txt'),'person work');
  const release={action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged],history_commits:[tip],release_refs:[{ref:owned,expected_commit:tip}]};
  const during=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},release));
  expect(during).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_quarantined',inventory:{branch:true}});
  expect(during.inventory.quarantined_whole).toBeGreaterThan(0);
  const intact=()=>{
   expect(git(['rev-parse',`rainver/workspace-${ref.id}-g1`])).toBe(tip);
   expect(git(['rev-parse',owned])).toBe(tip);
   expect(git(['for-each-ref','--format=%(refname)','refs/rainver/run-history/'])).toBe('');
   expect(existsSync(join(configDir,'workspace-sequences','folder-1',`${key}.json`))).toBe(true);
  };
  intact();
  // A retry (fresh operation) with the quarantine already present changes nothing either.
  const retry=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},release));
  expect(retry).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_quarantined',inventory:{branch:true,materialization_epoch:0}});
  intact();
 });

 it('refuses a dirty tree before writing any Run-history evidence',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const key=workspaceWorktreeKey(ref);
  const {tip}=await savedRun(ref,'d.txt','d');const merged=publishLikeNative(tip);
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  const open=await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,base_commit:tip},randomUUID());
  await writeFile(join(open.root,'dirty.txt'),'unsaved');
  await rm(join(configDir,'task-records','folder-1',`${key}.json`),{force:true});
  const refused=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged],history_commits:[tip]}));
  expect(refused).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_uncheckpointed'});
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/run-history/'])).toBe('');
  expect(git(['rev-parse',`rainver/workspace-${ref.id}-g1`])).toBe(tip);
 });

 it('keeps owned-by-name refs from a later page of an older release once a launch rebuilt the identity',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip}=await savedRun(ref,'p.txt','p');const merged=publishLikeNative(tip);
  const released=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged]}));
  expect(released.ok).toBe(true);
  const oldNative=`refs/rainver/native-preimages/${ref.id}/g1/${randomUUID()}`,shared=`refs/rainver/sources/${merged}`;
  git(['update-ref',oldNative,tip]);git(['update-ref',shared,merged]);
  const page=[{ref:oldNative,expected_commit:tip},{ref:shared,expected_commit:merged}];
  // Before any rebuild the page releases both.
  const before=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'release_refs',source_fence:true,release_refs:page}));
  expect(before).toMatchObject({ok:true,inventory:{retained_refs:[]}});
  git(['update-ref',oldNative,tip]);git(['update-ref',shared,merged]);
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:2,sync_to_target:true},randomUUID());
  const after=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'release_refs',source_fence:true,release_refs:page}));
  expect(after).toMatchObject({ok:true,inventory:{retained_refs:[{ref:oldNative,reason:'ref_owner_rebuilt'}]}});
  expect(git(['rev-parse',oldNative])).toBe(tip);
  expect(git(['for-each-ref','--format=%(refname)','refs/rainver/sources/'])).toBe('');
 });

 it('replays only the same release request: changed history, refs or target under the same epoch is a conflict, not a skipped replay',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'c.txt','one\n');const second=await savedRun(ref,'c.txt','two\n');
  const merged=publishLikeNative(second.tip);
  const release={action:'cleanup',retain_branch:false,expected_commit:second.tip,reclaim_proof:[merged],history_commits:[second.tip]};
  const command=frame({...ref,materialization_epoch:1},release);
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned'});
  // Crash retry and a fresh operation id with the same content (order and duplicates aside) replay.
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned'});
  expect(await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{...release,history_commits:[second.tip,second.tip],reclaim_proof:[merged]}))).toMatchObject({ok:true,cleanup_state:'cleaned'});
  // New content under the same identity and epoch is refused, never reported as done.
  for(const changed of [{...release,history_commits:[first.tip,second.tip]},{...release,release_refs:[{ref:`refs/rainver/recovery/${ref.id}/${first.tip}`,expected_commit:first.tip}]}]){
   expect(await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},changed))).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_release_request_conflict'});
   expect(await executeWorkspaceCommand(repoDir,{...command,...changed} as any)).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_cleanup_identity_conflict'});
  }
  expect(await executeWorkspaceCommand(repoDir,frame({...ref,target_ref:'refs/heads/other',materialization_epoch:1},release))).toMatchObject({ok:false,error:'workspace_release_request_conflict'});
  // The skipped history was never created by a replay.
  expect(git(['for-each-ref','--format=%(refname)',`refs/rainver/run-history/${ref.id}/g1/${first.tip}`])).toBe('');
 });

 it('reports every Run-history ref already created when the history step fails part-way, and finishes it on retry',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'p.txt','one\n');const second=await savedRun(ref,'p.txt','two\n');const third=await savedRun(ref,'p.txt','three\n');
  const merged=publishLikeNative(third.tip);
  // Fault injection: the second history ref cannot be written (a stale ref lock).
  const blockedRef=join(repoDir,'.git','refs','rainver','run-history',ref.id,'g1');
  await mkdir(blockedRef,{recursive:true});await writeFile(join(blockedRef,`${second.tip}.lock`),'');
  const command=frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:third.tip,reclaim_proof:[merged],history_commits:[first.tip,second.tip,third.tip]});
  const failed=await executeWorkspaceCommand(repoDir,command);
  expect(failed.ok).toBe(false);
  // The branch is still there (nothing released), and the ref created before the fault is reported.
  expect(failed.inventory).toMatchObject({branch:true,history_refs:[first.tip]});
  const journal=JSON.parse(await readFile(join(configDir,'workspace-cleanup',`${command.operation_id}.json`),'utf8'));
  expect(journal.history_intent).toEqual([first.tip,second.tip,third.tip]);
  await rm(join(blockedRef,`${second.tip}.lock`));
  const done=await executeWorkspaceCommand(repoDir,command);
  expect(done).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false}});
  expect([...done.inventory.history_refs].sort()).toEqual([first.tip,second.tip,third.tip].sort());
 });

 it('tells a version Git cleanly reports missing apart from an object store it cannot read',async()=>{
  const ref={id:randomUUID(),generation:1};
  await writeFile(join(repoDir,'v.txt'),'v\n');git(['add','.']);git(['commit','-qm','v']);
  const commit=git(['rev-parse','HEAD']);
  expect(await versionPresence(repoDir,commit)).toBe('commit');
  expect(await versionPresence(repoDir,'1'.repeat(40))).toBe('missing');
  await expect(readWorkspaceFile(repoDir,'folder-1',ref,'1'.repeat(40),'v.txt')).rejects.toThrow('workspace_file_version_unavailable');
  const loose=join(repoDir,'.git','objects',commit.slice(0,2),commit.slice(2));
  const original=await readFile(loose);
  try{
   // Permission fault: Git still prints `missing`, but with a diagnostic; never expiry.
   await chmod(loose,0o000);
   expect(await versionPresence(repoDir,commit)).toBe('failed');
   await expect(readWorkspaceFile(repoDir,'folder-1',ref,commit,'v.txt')).rejects.toThrow('workspace_file_read_failed');
   // Corruption: likewise a read failure.
   await chmod(loose,0o644);await writeFile(loose,'not a zlib stream');
   expect(await versionPresence(repoDir,commit)).toBe('failed');
   // A tree id is present but is not a version.
   await writeFile(loose,original);
   expect(await versionPresence(repoDir,git(['rev-parse','HEAD^{tree}']))).toBe('other');
  }finally{await chmod(loose,0o644);await writeFile(loose,original);}
 });
});
