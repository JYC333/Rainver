import {mkdir,mkdtemp,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {executeWorkspaceCommand as execute} from '../src/executionWorkspace.js';
import {setDurableIoForTest} from '../src/durableFile.js';
import {readJson} from '../src/taskWorktree.js';
import type {ExecutionWorkspaceRef} from '@rainver/protocol';

/**
 * Durability of the records a Host acknowledges for workspace ref work. Power
 * loss cannot be simulated here; these tests observe the fsync/rename/
 * directory-fsync order through an injected I/O layer and inject failures at
 * each step, then check that nothing is acknowledged and that recovery replays.
 */
let configDir:string,repoDir:string,restore:(()=>void)|undefined;
const git=(args:string[],cwd=repoDir)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
beforeEach(async()=>{
 configDir=await realpath(await mkdtemp(join(tmpdir(),'rainver-durable-config-')));
 repoDir=await realpath(await mkdtemp(join(tmpdir(),'rainver-durable-repo-')));
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
/** Records every sync/rename step, in order. */
function observe(fail?:(step:string,path:string)=>boolean){
 const steps:Array<[string,string]>=[];
 const check=(step:string,path:string)=>{steps.push([step,path]);if(fail?.(step,path))throw Object.assign(new Error(`EIO: injected ${step} failure`),{code:'EIO'});};
 restore=setDurableIoForTest({
  async syncFile(handle,path){check('sync_file',path);await handle.sync();},
  async syncDirectory(path){check('sync_dir',path);},
  async rename(from,to){check(`rename:${from}`,to);const {rename}=await import('node:fs/promises');await rename(from,to);},
 });
 return steps;
}

describe('durable ref-operation records',()=>{
 it('fsyncs each record before its rename and its directory after, including a newly created directory\'s parent, before the reply',async()=>{
  const ref={id:randomUUID(),generation:1};
  const head=git(['rev-parse','HEAD']),source=`refs/rainver/sources/${head}`;
  git(['update-ref',source,head]);
  const steps=observe();
  const command=frame(ref,{action:'release_refs',source_fence:true,release_refs:[{ref:source,expected_commit:head}]});
  const journal=join(configDir,'workspace-ref-operations',`${(command as any).operation_id}.json`);
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,inventory:{ref_operation:(command as any).operation_id}});
  // The directory did not exist: its entry in the config directory is synced first.
  expect(steps[0]).toEqual(['sync_dir',configDir]);
  // Two records (running, done), each: file fsync, rename onto the journal, directory fsync.
  const ofJournal=steps.filter(([s,p])=>p===journal||s==='sync_dir'&&p===dirname(journal)||s==='sync_file'&&p.startsWith(`${journal}.`));
  expect(ofJournal.map(([s])=>s.split(':')[0])).toEqual(['sync_file','rename','sync_dir','sync_file','rename','sync_dir']);
  expect((await readJson(journal))?.state).toBe('done');
 });

 it('acknowledges nothing when a write, file fsync, rename or directory fsync fails, leaves no temporary file, and replays once the record is durable',async()=>{
  const ref={id:randomUUID(),generation:1};
  const head=git(['rev-parse','HEAD']),source=`refs/rainver/sources/${head}`;
  git(['update-ref',source,head]);
  const command=frame(ref,{action:'release_refs',source_fence:true,release_refs:[{ref:source,expected_commit:head}]});
  const id=(command as any).operation_id,journal=join(configDir,'workspace-ref-operations',`${id}.json`);
  // The write-ahead record's file fsync fails: nothing ran, nothing acknowledged.
  observe((step,path)=>step==='sync_file'&&path.startsWith(`${journal}.`));
  await expect(executeWorkspaceCommand(repoDir,command)).rejects.toThrow(/EIO/);
  restore!();
  expect(refOf(source)).toBe(head);
  expect(await readJson(journal)).toBeNull();
  expect((await readdir(dirname(journal))).filter(n=>n.endsWith('.tmp'))).toEqual([]);
  // The rename fails: likewise.
  observe((step)=>step.startsWith('rename:'));
  await expect(executeWorkspaceCommand(repoDir,command)).rejects.toThrow(/EIO/);
  restore!();
  expect(refOf(source)).toBe(head);
  expect((await readdir(dirname(journal))).filter(n=>n.endsWith('.tmp'))).toEqual([]);
  // The completion record's directory fsync fails (second sync of the journal directory): the
  // deletion ran but no reply proves it ended, so the server keeps its fence and re-sends the id.
  let dirSyncs=0;
  observe((step,path)=>step==='sync_dir'&&path===dirname(journal)&&++dirSyncs===2);
  await expect(executeWorkspaceCommand(repoDir,command)).rejects.toThrow(/EIO/);
  restore!();
  expect(refOf(source)).toBeNull();
  // The re-delivery replays the visible record only after making it durable, and touches no Git.
  git(['update-ref',source,head]); // a later dependent's pin: a replay must not delete it
  const steps=observe();
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,inventory:{ref_operation:id}});
  expect(steps).toEqual([['sync_file',journal],['sync_dir',dirname(journal)]]);
  expect(refOf(source)).toBe(head);
 });

 it('makes a settle\'s cancellation durable before it is reported, and fails the whole settle when it cannot',async()=>{
  const ref={id:randomUUID(),generation:1};
  const earlier=randomUUID(),settle=randomUUID();
  const earlierPath=join(configDir,'workspace-ref-operations',`${earlier}.json`);
  observe((step,path)=>step==='sync_file'&&path.startsWith(`${earlierPath}.`));
  await expect(executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',operation_id:settle,settle_operations:[earlier]}))).rejects.toThrow(/EIO/);
  restore!();
  expect(await readJson(earlierPath)).toBeNull();
  const steps=observe();
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',operation_id:settle,settle_operations:[earlier]}))).toMatchObject({ok:true,inventory:{settled_operations:[{operation_id:earlier,state:'cancelled'}]}});
  expect(steps.some(([s,p])=>s==='sync_dir'&&p===dirname(earlierPath))).toBe(true);
  expect((await readJson(earlierPath))?.state).toBe('cancelled');
 });
});

describe('keeper writes',()=>{
 it('reports a keeper Git could not write (a held ref lock) as retryable without settling anything, then runs the same operation in full',async()=>{
  const ref={id:randomUUID(),generation:1};
  const head=git(['rev-parse','HEAD']);
  const keeper=`refs/rainver/source-keepers/${ref.id}/g1/${head}`;
  const lock=join(repoDir,'.git',`${keeper}.lock`);
  await mkdir(dirname(lock),{recursive:true});await writeFile(lock,'');
  const earlier=randomUUID(),settle=randomUUID();
  const command=frame(ref,{action:'release_refs',operation_id:settle,settle_operations:[earlier],keep_sources:[head],pin_sources:[head],release_keepers:[head]});
  const failed=await executeWorkspaceCommand(repoDir,command);
  expect(failed).toMatchObject({ok:false,cleanup_state:'retry_wait',error:'workspace_source_ref_write_failed'});
  expect(failed.inventory?.ref_operation).toBeUndefined();
  // Nothing after the keeper ran: the earlier operation is not settled, no shared name moved.
  expect(await readJson(join(configDir,'workspace-ref-operations',`${earlier}.json`))).toBeNull();
  expect((await readJson(join(configDir,'workspace-ref-operations',`${settle}.json`)))?.state).toBe('running');
  expect(refOf(keeper)).toBeNull();
  // The lock is released: the same operation id now keeps, settles and restores.
  await rm(lock);
  const done=await executeWorkspaceCommand(repoDir,command);
  expect(done).toMatchObject({ok:true,inventory:{ref_operation:settle,settled_operations:[{operation_id:earlier,state:'cancelled'}],pinned_sources:[head],kept_sources:[]}});
  expect(refOf(`refs/rainver/sources/${head}`)).toBe(head);
  expect(refOf(keeper)).toBeNull();
 });

 it('tells a commit whose object is gone (no keeper, reported) apart from a write failure',async()=>{
  const ref={id:randomUUID(),generation:1};
  const gone='1'.repeat(40);
  const result=await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',keep_sources:[gone]}));
  expect(result).toMatchObject({ok:true,inventory:{kept_sources:[]}});
 });
});
