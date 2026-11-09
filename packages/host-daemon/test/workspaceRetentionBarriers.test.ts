import {copyFile,mkdtemp,readFile,realpath,rm,writeFile,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {checkLocationRepository} from '../src/taskWorktree.js';
import {executeWorkspaceCommand as execute,prepareExecutionWorkspace} from '../src/executionWorkspace.js';
import {resetDurableDirectoriesForTest,setDurableIoForTest,syncExistingDurable,writeJsonDurable} from '../src/durableFile.js';
import {admitMaterialization,keepRunHistory,legacyReleaseRequestDigest,recordHistoryKeepers,refOperationDigest,RunHistoryError} from '../src/workspaceRetention.js';
import {readJson} from '../src/taskWorktree.js';
import {workspaceWorktreeKey} from '../src/worktreeIdentity.js';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';

/**
 * Power-loss barriers on every idempotent path (fresh, already present, equal
 * value, partial failure, retry, legacy record) of workspace retention, and
 * explicit missing-vs-fault reads. Power loss itself is not simulated: the
 * tests observe which fsyncs run through the injected I/O layer and fail them,
 * so a path that skipped its barrier fails the assertions.
 */
let configDir:string,repoDir:string,restore:(()=>void)|undefined;
const git=(args:string[],cwd=repoDir)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const author={name:'Agent',email:'agent@example.com'};
beforeEach(async()=>{
 configDir=await realpath(await mkdtemp(join(tmpdir(),'rainver-barrier-config-')));
 repoDir=await realpath(await mkdtemp(join(tmpdir(),'rainver-barrier-repo-')));
 process.env.RAINVER_HOST_CONFIG_DIR=configDir;
 await saveConfig({server_url:'http://127.0.0.1:9',host_id:'host-1',trust:'trusted',token:'t',workspaces:{'folder-1':repoDir}});
 git(['init','-q','-b','main']);git(['config','user.email','p@example.com']);git(['config','user.name','P']);
 await writeFile(join(repoDir,'README.md'),'hello\n');git(['add','.']);git(['commit','-qm','initial']);
});
afterEach(async()=>{
 restore?.();restore=undefined;
 delete process.env.RAINVER_HOST_CONFIG_DIR;
 await rm(configDir,{recursive:true,force:true});await rm(repoDir,{recursive:true,force:true});
});
const executeWorkspaceCommand=async(root:string|null,f:Parameters<typeof execute>[1])=>(await execute(root,f)) as any;
const frame=(ref:ExecutionWorkspaceRef,extra:Record<string,unknown>)=>({type:'execution_workspace_command' as const,request_id:randomUUID(),operation_id:randomUUID(),retain_branch:true,
 workspace:{kind:'location' as const,workspace_location_id:'folder-1',execution_workspace:ref},...extra}) as Parameters<typeof executeWorkspaceCommand>[1];
const refOf=(name:string)=>{try{return git(['rev-parse','--verify','--quiet',name]);}catch{return null;}};
function observe(fail?:(step:string,path:string)=>boolean){
 restore?.();
 const steps:Array<[string,string]>=[];
 const check=(step:string,path:string)=>{steps.push([step,path]);if(fail?.(step,path))throw Object.assign(new Error(`EIO: injected ${step} failure`),{code:'EIO'});};
 restore=setDurableIoForTest({
  async syncFile(handle,path){check('sync_file',path);await handle.sync();},
  async syncDirectory(path){check('sync_dir',path);},
 });
 return steps;
}
const off=()=>{restore?.();restore=undefined;};
const dirs=(steps:Array<[string,string]>)=>steps.filter(([s])=>s==='sync_dir').map(([,p])=>p);
async function savedRun(ref:ExecutionWorkspaceRef,file:string,content:string){
 const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
 const runId=randomUUID(),prepared=await prepareExecutionWorkspace(check.repo,'folder-1',ref,runId);
 await writeFile(join(prepared.root,file),content);
 const saved=await executeWorkspaceCommand(repoDir,frame(ref,{action:'checkpoint',run_id:runId,author,message:'save'}));
 expect(saved.ok).toBe(true);
 return saved.commit as string;
}
function publish(tip:string){
 const merged=git(['commit-tree',`${tip}^{tree}`,'-p','main','-m','published']);
 git(['update-ref','refs/heads/main',merged]);git(['reset','-q','--hard','main']);
 return merged;
}

describe('durable directory chain',()=>{
 it('syncs every ancestor up to the config directory again after a mkdir whose parent sync failed, not only when it creates the directory',async()=>{
  resetDurableDirectoriesForTest();
  const top=join(configDir,'workspace-history-keepers'),dir=join(top,'folder-1'),path=join(dir,'k.json');
  observe((step,p)=>step==='sync_dir'&&p===top);
  await expect(writeJsonDurable(path,{a:1})).rejects.toThrow(/EIO/);
  // mkdir succeeded; the retry sees the directory and must still make it durable.
  expect(existsSync(dir)).toBe(true);
  let steps=observe();
  await writeJsonDurable(path,{a:1});
  expect(dirs(steps)).toEqual([top,configDir,dir]);
  // Once synced in this process, later writes sync only the record's directory.
  steps=observe();
  await writeJsonDurable(path,{a:2});
  expect(dirs(steps)).toEqual([dir]);
  // A replay in a fresh process syncs the file, the whole chain, then its directory.
  resetDurableDirectoriesForTest();
  steps=observe();
  expect(await syncExistingDurable(path)).toBe(true);
  expect(steps).toEqual([['sync_file',path],['sync_dir',top],['sync_dir',configDir],['sync_dir',dir]]);
 });

 it('never writes or syncs outside the config directory',async()=>{
  await expect(writeJsonDurable(join(tmpdir(),`${randomUUID()}.json`),{})).rejects.toThrow('durable_path_outside_config');
 });
});

describe('equal values are made durable, not trusted',()=>{
 it('re-syncs an unchanged Run-history keeper record after a write that failed past its rename',async()=>{
  const path=join(configDir,'workspace-history-keepers','folder-1','key.json'),c='a'.repeat(40);
  observe((step,p)=>step==='sync_dir'&&p===dirname(path));
  await expect(recordHistoryKeepers('folder-1','key',[c],3)).rejects.toThrow(/EIO/);
  expect((await readJson(path))?.commits).toEqual({[c]:3}); // visible, but its rename may not survive
  const steps=observe();
  await recordHistoryKeepers('folder-1','key',[c],3);
  expect(steps).toContainEqual(['sync_file',path]);
  expect(dirs(steps)).toContain(dirname(path));
 });

 it('re-syncs an unchanged materialization admission',async()=>{
  const ref={id:randomUUID(),generation:1,materialization_epoch:2},key=workspaceWorktreeKey(ref);
  const path=join(configDir,'workspace-materializations','folder-1',`${key}.json`);
  observe((step,p)=>step==='sync_dir'&&p===dirname(path));
  await expect(admitMaterialization('folder-1',key,ref)).rejects.toThrow(/EIO/);
  const steps=observe();
  await admitMaterialization('folder-1',key,ref);
  expect(steps).toContainEqual(['sync_file',path]);
  expect(dirs(steps)).toContain(dirname(path));
 });
});

describe('protecting refs that already exist',()=>{
 it('syncs a pre-existing loose keeper ref and its directories before settling, and retries when that sync fails',async()=>{
  const ref={id:randomUUID(),generation:1},head=git(['rev-parse','HEAD']);
  const keeper=`refs/rainver/source-keepers/${ref.id}/g1/${head}`,loose=join(repoDir,'.git',keeper);
  git(['update-ref',keeper,head]); // written by an older Host: same oid, never synced
  const earlier=randomUUID(),command=frame(ref,{action:'release_refs',settle_operations:[earlier],keep_sources:[head]});
  observe((step,p)=>step==='sync_file'&&p===loose);
  const failed=await executeWorkspaceCommand(repoDir,command);
  off();
  expect(failed).toMatchObject({ok:false,cleanup_state:'retry_wait',error:'workspace_source_ref_write_failed'});
  expect(failed.inventory?.ref_operation).toBeUndefined();
  expect(await readJson(join(configDir,'workspace-ref-operations',`${earlier}.json`))).toBeNull();
  const steps=observe();
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,inventory:{settled_operations:[{operation_id:earlier,state:'cancelled'}],kept_sources:[head]}});
  expect(steps).toContainEqual(['sync_file',loose]);
  // The file's directory and each parent up to the common Git directory.
  for(let d=dirname(loose);d.length>=join(repoDir,'.git').length;d=dirname(d))expect(dirs(steps)).toContain(d);
 });

 it('syncs packed-refs when the protecting ref is packed',async()=>{
  const ref={id:randomUUID(),generation:1},head=git(['rev-parse','HEAD']);
  git(['update-ref',`refs/rainver/source-keepers/${ref.id}/g1/${head}`,head]);git(['pack-refs','--all']);
  const steps=observe();
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',keep_sources:[head]}))).toMatchObject({ok:true,inventory:{kept_sources:[head]}});
  expect(steps).toContainEqual(['sync_file',join(repoDir,'.git','packed-refs')]);
  expect(dirs(steps)).toContain(join(repoDir,'.git'));
 });

 it('drops a keeper only after the restored shared name is itself durable',async()=>{
  const ref={id:randomUUID(),generation:1},head=git(['rev-parse','HEAD']);
  const keeper=`refs/rainver/source-keepers/${ref.id}/g1/${head}`,shared=`refs/rainver/sources/${head}`;
  git(['update-ref',keeper,head]);git(['update-ref',shared,head]);
  observe((step,p)=>step==='sync_file'&&p===join(repoDir,'.git',shared));
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_keepers:[head]}))).toMatchObject({ok:false,cleanup_state:'retry_wait',error:'workspace_source_ref_write_failed'});
  off();
  expect(refOf(keeper)).toBe(head);
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_keepers:[head]}))).toMatchObject({ok:true,inventory:{kept_sources:[]}});
  expect(refOf(keeper)).toBeNull();
 });

 it('syncs a Run-history ref that already holds its commit, and throws (retryable) when it cannot',async()=>{
  const ref={id:randomUUID(),generation:1},head=git(['rev-parse','HEAD']);
  const name=`refs/rainver/run-history/${ref.id}/g1/${head}`,loose=join(repoDir,'.git',name);
  git(['update-ref',name,head]);
  observe((step,p)=>step==='sync_file'&&p===loose);
  await expect(keepRunHistory(repoDir,ref,null,[head])).rejects.toBeInstanceOf(RunHistoryError);
  const steps=observe();
  expect(await keepRunHistory(repoDir,ref,null,[head])).toEqual({kept:[head],unavailable:[]});
  expect(steps).toContainEqual(['sync_file',loose]);
 });

 it('keeps the branch when a Run-history ref cannot be made durable, then releases it on retry',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'n.txt','one\n');const second=await savedRun(ref,'n.txt','two\n');
  const merged=publish(second);
  const history=`refs/rainver/run-history/${ref.id}/g1/${first}`;
  git(['update-ref',history,first]); // left by an earlier attempt or an older Host
  const command=frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:second,reclaim_proof:[merged],history_commits:[first,second]});
  observe((step,p)=>step==='sync_file'&&p===join(repoDir,'.git',history));
  const failed=await executeWorkspaceCommand(repoDir,command);
  off();
  expect(failed).toMatchObject({ok:false,cleanup_state:'retry_wait',error:'workspace_run_history_failed'});
  expect(refOf(`refs/heads/rainver/workspace-${ref.id}-g1`)).toBe(second);
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false}});
  expect(refOf(history)).toBe(first);
 });
});

describe('Run-history reads tell missing from failed',()=>{
 it('aborts the release on an unreadable object, and reports a cleanly missing one as unavailable',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const first=await savedRun(ref,'n.txt','one\n');const second=await savedRun(ref,'n.txt','two\n');
  const merged=publish(second),gone='2'.repeat(40);
  const object=join(repoDir,'.git','objects',first.slice(0,2),first.slice(2)),backup=join(configDir,'object.bak');
  expect(existsSync(object)).toBe(true);
  await copyFile(object,backup);await chmod(object,0o644);
  await writeFile(object,(await readFile(backup)).subarray(0,5)); // a corrupt loose object: Git reports a fault
  const command=frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:second,reclaim_proof:[merged],history_commits:[first,second,gone]});
  const failed=await executeWorkspaceCommand(repoDir,command);
  expect(failed).toMatchObject({ok:false,cleanup_state:'retry_wait',error:'workspace_run_history_failed'});
  expect(refOf(`refs/heads/rainver/workspace-${ref.id}-g1`)).toBe(second);
  await copyFile(backup,object);
  const done=await executeWorkspaceCommand(repoDir,command);
  expect(done).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false,history_unavailable:[gone]}});
  expect([...done.inventory.history_refs].sort()).toEqual([first,second].sort());
  expect((await readJson(join(configDir,'workspace-cleanup',`${(command as any).operation_id}.json`)))?.history_unavailable).toEqual([gone]);
 });
});

describe('request digests bind every field that changes execution',()=>{
 it('refuses the same ref operation id for another workspace identity or epoch',async()=>{
  const ref={id:randomUUID(),generation:1,materialization_epoch:1},head=git(['rev-parse','HEAD']);
  const op=randomUUID(),body={action:'release_refs',operation_id:op,keep_sources:[head]};
  expect(await executeWorkspaceCommand(repoDir,frame(ref,body))).toMatchObject({ok:true,inventory:{ref_operation:op}});
  for(const other of [{...ref,materialization_epoch:2},{...ref,generation:2},{...ref,id:randomUUID()}])
   expect(await executeWorkspaceCommand(repoDir,frame(other,body))).toMatchObject({ok:false,error:'workspace_ref_operation_conflict'});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,body))).toMatchObject({ok:true,inventory:{ref_operation:op}});
 });

 it('replays a legacy (v1) ref-operation journal for the same content, then binds it to the full digest',async()=>{
  const ref={id:randomUUID(),generation:1,materialization_epoch:1},head=git(['rev-parse','HEAD']);
  const op=randomUUID(),path=join(configDir,'workspace-ref-operations',`${op}.json`);
  const legacy=refOperationDigest(undefined,undefined,undefined,{keep:[head]}).legacy;
  await writeJsonDurable(path,{fingerprint:legacy,state:'done',result:{retained:[],pinned:[],kept:[head]}});
  const body={action:'release_refs',operation_id:op,keep_sources:[head]};
  expect(await executeWorkspaceCommand(repoDir,frame(ref,body))).toMatchObject({ok:true,inventory:{ref_operation:op,kept_sources:[head]}});
  expect(refOf(`refs/rainver/source-keepers/${ref.id}/g1/${head}`)).toBeNull(); // replayed, Git untouched
  expect((await readJson(path))?.digest_version).toBe(2);
  expect(await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:2},body))).toMatchObject({ok:false,error:'workspace_ref_operation_conflict'});
  // A legacy running journal of the same content runs (a legacy settle or later page continues).
  const running=randomUUID();
  await writeJsonDurable(join(configDir,'workspace-ref-operations',`${running}.json`),{fingerprint:legacy,state:'running'});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{...body,operation_id:running}))).toMatchObject({ok:true,inventory:{ref_operation:running,kept_sources:[head]}});
 });

 it('refuses a cleanup under the same id whose ref list differs only by kept_epoch, and resumes a legacy (v1) cleanup journal',async()=>{
  const ref={id:randomUUID(),generation:1},head=git(['rev-parse','HEAD']);
  const name=`refs/rainver/run-history/${ref.id}/g1/${head}`;
  const op=randomUUID(),body={action:'cleanup',operation_id:op,retain_branch:true,release_refs:[{ref:name,expected_commit:head,kept_epoch:1}]};
  expect(await executeWorkspaceCommand(repoDir,frame(ref,body))).toMatchObject({cleanup_state:'cleaned'});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{...body,release_refs:[{ref:name,expected_commit:head,kept_epoch:2}]}))).toMatchObject({ok:false,error:'workspace_cleanup_identity_conflict'});
  const legacyOp=randomUUID(),path=join(configDir,'workspace-cleanup',`${legacyOp}.json`);
  const fingerprint=legacyReleaseRequestDigest({id:ref.id,generation:ref.generation,locationId:'folder-1',retain:true,target:null,refs:body.release_refs});
  await writeJsonDurable(path,{fingerprint,state:'running'});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{...body,operation_id:legacyOp}))).toMatchObject({cleanup_state:'cleaned'});
  expect((await readJson(path))?.digest_version).toBe(2);
 });
});

describe('a legacy completed-release record is bound to the full digest on first acceptance',()=>{
 it('replays it once under a fresh operation, then refuses a later operation whose ref list differs only by kept_epoch',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'},key=workspaceWorktreeKey(ref);
  const tip=await savedRun(ref,'a.txt','a');const merged=publish(tip);
  const name=`refs/rainver/run-history/${ref.id}/g1/${tip}`;
  const body=(kept:number)=>({action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[merged],release_refs:[{ref:name,expected_commit:tip,kept_epoch:kept}]});
  const epochRef={...ref,materialization_epoch:1};
  expect(await executeWorkspaceCommand(repoDir,frame(epochRef,body(1)))).toMatchObject({ok:true,cleanup_state:'cleaned'});
  // Rewrite the completed release as an older Host left it: a v1 digest, no digest_version.
  const path=join(configDir,'workspace-materializations','folder-1',`${key}.json`);
  const raw=await readJson(path) as any;
  const {digest_version:_,...release}=raw.release;
  await writeJsonDurable(path,{...raw,release:{...release,request:legacyReleaseRequestDigest({id:ref.id,generation:1,locationId:'folder-1',integrationId:null,expected:tip,retain:false,epoch:1,
   target:'refs/heads/main',proof:[merged],refs:body(1).release_refs})}});
  // kept_epoch is outside v1: both bodies match the v1 digest. The first one accepted binds the record.
  expect(await executeWorkspaceCommand(repoDir,frame(epochRef,body(1)))).toMatchObject({ok:true,cleanup_state:'cleaned'});
  const bound=(await readJson(path) as any);
  expect(bound.release).toMatchObject({digest_version:2,epoch:1});
  expect(bound.epoch).toBe(raw.epoch);
  expect(await executeWorkspaceCommand(repoDir,frame(epochRef,body(2)))).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_release_request_conflict'});
  expect(await executeWorkspaceCommand(repoDir,frame(epochRef,body(1)))).toMatchObject({ok:true,cleanup_state:'cleaned'});
 });

 it('binds a legacy cleanup journal under the same operation before any early refusal, so a later kept_epoch change is refused',async()=>{
  const ref={id:randomUUID(),generation:1,materialization_epoch:1},head=git(['rev-parse','HEAD']);
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  await admitMaterialization('folder-1',workspaceWorktreeKey(ref),{...ref,materialization_epoch:3});
  const name=`refs/rainver/run-history/${ref.id}/g1/${head}`;
  const op=randomUUID(),path=join(configDir,'workspace-cleanup',`${op}.json`);
  const body=(kept:number)=>({action:'cleanup',operation_id:op,retain_branch:false,expected_commit:head,release_refs:[{ref:name,expected_commit:head,kept_epoch:kept}]});
  await writeJsonDurable(path,{fingerprint:legacyReleaseRequestDigest({id:ref.id,generation:1,locationId:'folder-1',integrationId:null,expected:head,retain:false,epoch:1,target:null,refs:body(1).release_refs}),state:'running'});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,body(1)))).toMatchObject({ok:false,error:'workspace_materialization_moved'});
  expect((await readJson(path))?.digest_version).toBe(2);
  expect(await executeWorkspaceCommand(repoDir,frame(ref,body(2)))).toMatchObject({ok:false,error:'workspace_cleanup_identity_conflict'});
 });
});
