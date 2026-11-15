import {access,utimes,chmod,mkdir,mkdtemp,readFile,readdir,readlink,symlink,rename,realpath,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,beforeEach,beforeAll,describe,expect,it} from 'vitest';
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

// Restart acceptance loads this checkout's compiled Host module.
beforeAll(()=>{execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p','tsconfig.build.json']);});
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
 it.for(['preserved','missing_backup','moved_backup','wrong_epoch','rebuilt'] as const)('finishes recovery-ref pages only against a completed preserved release: %s',async mode=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const first=await savedRun(ref,'early.txt','earlier private bytes');
  git(['reset','--hard','main'],first.prepared.root);
  const last=await savedRun(ref,'last.txt','later private bytes');
  expect(git(['merge-base',first.tip,last.tip])).not.toBe(first.tip);
  const pin=`refs/rainver/recovery/${ref.id}/${first.tip}`,history=`refs/rainver/run-history/${ref.id}/g1/${first.tip}`;
  git(['update-ref',pin,first.tip]);git(['update-ref',history,first.tip]);
  // A backup alone, while the source still exists, cannot relax target proof.
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_refs:[{ref:pin,expected_commit:first.tip}]})))
   .toMatchObject({inventory:{retained_refs:[{ref:pin,reason:'checkpoint_not_in_target'}]}});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:last.tip,discard_commit:last.tip,history_commits:[first.tip,last.tip],release_refs:[{ref:pin,expected_commit:first.tip}]})))
   .toMatchObject({ok:true,inventory:{branch:false,worktree:false,registration:false}});
  if(mode==='missing_backup')git(['update-ref','-d',history]);
  if(mode==='moved_backup')git(['update-ref',history,last.tip]);
  if(mode==='rebuilt'){
   const repo=await checkLocationRepository(repoDir);if(repo.kind!=='repository')throw new Error('fixture');
   await prepareExecutionWorkspace(repo.repo,'folder-1',{...ref,materialization_epoch:2},randomUUID());
  }
  const request=frame({...ref,...(mode==='wrong_epoch'?{materialization_epoch:0}:{})},{action:'release_refs',release_refs:[{ref:pin,expected_commit:first.tip}]});
  const result=await executeWorkspaceCommand(repoDir,request);
  if(mode==='preserved'){
   expect(result).toMatchObject({ok:true,inventory:{retained_refs:[]}});
   expect(git(['for-each-ref','--format=%(refname)',pin])).toBe('');
   git(['reflog','expire','--expire=now','--all']);git(['gc','--prune=now']);
   expect(git(['show',`${history}:early.txt`])).toBe('earlier private bytes');
   // A lost reply replays its original effect without touching the backup.
   expect(await executeWorkspaceCommand(repoDir,{...request,request_id:randomUUID()})).toMatchObject({inventory:{ref_operation:request.operation_id,retained_refs:[]}});
   expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'release_refs',release_refs:[{ref:history,expected_commit:first.tip,kept_epoch:1}]})))
    .toMatchObject({ok:true,inventory:{retained_refs:[]}});
   expect(git(['for-each-ref','--format=%(refname)',history])).toBe('');
  }else{
   expect(result.inventory.retained_refs).toContainEqual(expect.objectContaining({ref:pin}));
   expect(git(['show',`${pin}:early.txt`])).toBe('earlier private bytes');
  }
 });

 it('uses the exact publication version after later edits and refuses a rewritten-away adoption',async()=>{
  const base=git(['rev-parse','main']),ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const {tip}=await savedRun(ref,'feature.txt','adopted\n');
  await writeFile(join(repoDir,'other.txt'),'target only');git(['add','.']);git(['commit','-qm','target advance']);
  // Publish the child delta while retaining target-only content: trees differ.
  await writeFile(join(repoDir,'feature.txt'),'adopted\n');git(['add','.']);git(['commit','-qm','manual adoption']);const adopted=git(['rev-parse','main']);
  await writeFile(join(repoDir,'feature.txt'),'newer target content\n');git(['commit','-qam','later edit']);
  const {verifyBranchReclaim}=await import('../src/workspaceRetention.js');
  expect(await verifyBranchReclaim(repoDir,tip,'refs/heads/main',[adopted],[base])).toBeNull();
  git(['reset','--hard',base]);
  expect(await verifyBranchReclaim(repoDir,tip,'refs/heads/main',[adopted],[base])).toBe('workspace_reclaim_unproven');
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[adopted],reclaim_bases:[base]}))).toMatchObject({ok:true,inventory:{branch:true}});
 });

 it('pins an unpublished adopting checkpoint, recovers it after child release and releases it only after target adoption',async()=>{
  const base=git(['rev-parse','main']),parent={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const child={id:randomUUID(),generation:1,target_ref:`refs/heads/rainver/workspace-${parent.id}-g1`,materialization_epoch:1};
  const {tip}=await savedRun({...child,target_ref:'refs/heads/main'},'child.txt','child');
  await savedRun(parent,'child.txt','child');
  const {tip:checkpoint}=await savedRun(parent,'parent.txt','unpublished parent');
  const keep=`refs/rainver/recovery/${parent.id}/${checkpoint}`;
  const command=frame(child,{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_checkpoint:{workspace_id:parent.id,generation:1,commit:checkpoint,base_commit:base}});
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,inventory:{branch:false}});
  expect(git(['show',`${keep}:parent.txt`])).toBe('unpublished parent');
  const {releaseRefs}=await import('../src/workspaceRetention.js');
  expect(await releaseRefs(repoDir,parent,[{ref:keep,expected_commit:checkpoint}])).toContainEqual({ref:keep,reason:'checkpoint_not_in_target'});
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,inventory:{branch:false}});
  expect(await executeWorkspaceCommand(repoDir,{...command,reclaim_checkpoint:{...command.reclaim_checkpoint!,commit:base}})).toMatchObject({ok:false});
  const published=publishLikeNative(checkpoint);
  await writeFile(join(repoDir,'child.txt'),'later edit');git(['commit','-qam','later target']);
  expect(await executeWorkspaceCommand(repoDir,frame(parent,{action:'cleanup',retain_branch:false,expected_commit:checkpoint,reclaim_proof:[published],release_refs:[{ref:keep,expected_commit:checkpoint}]}))).toMatchObject({ok:true,inventory:{branch:false,owned_refs:[]}});
  expect(git(['for-each-ref','--format=%(refname)',keep])).toBe('');
 });

 it('releases an empty child only after pinning its inherited unpublished baseline in the parent recovery owner',async()=>{
  const parent={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const {tip:baseline}=await savedRun(parent,'private.txt','only private baseline');
  const child={id:randomUUID(),generation:1,target_ref:`refs/heads/rainver/workspace-${parent.id}-g1`,base_commit:baseline,materialization_epoch:1};
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  const reviewRun=randomUUID(),prepared=await prepareExecutionWorkspace(check.repo,'folder-1',child,reviewRun);
  expect(await executeWorkspaceCommand(repoDir,frame(child,{action:'checkpoint',run_id:reviewRun,author,message:'empty review'}))).toMatchObject({ok:true,commit:baseline});
  const targetBefore=git(['rev-parse','main']);
  const release=frame(child,{action:'cleanup',retain_branch:false,expected_commit:baseline,reclaim_checkpoint:{workspace_id:parent.id,generation:1,commit:baseline,base_commit:baseline}});
  const released=await executeWorkspaceCommand(repoDir,release);
  expect(released,JSON.stringify(released)).toMatchObject({ok:true,inventory:{branch:false,worktree:false,registration:false}});
  expect(git(['worktree','list','--porcelain'])).not.toContain(prepared.root);
  expect(git(['show',`refs/rainver/recovery/${parent.id}/${baseline}:private.txt`])).toBe('only private baseline');
  expect(git(['rev-parse','main'])).toBe(targetBefore);
  // Replayed deletion neither republishes the empty work nor loses its keeper.
  expect(await executeWorkspaceCommand(repoDir,release)).toMatchObject({ok:true,inventory:{branch:false}});
 });

 it('preserves ignored build output and unique assets outside the tree while releasing a proven branch',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const {tip,prepared}=await savedRun(ref,'.gitignore','dist/\n__pycache__/\n*.tsbuildinfo\n.env\nassets/\nnode_modules/\n');
  const published=publishLikeNative(tip);
  for(const dir of ['dist','__pycache__','assets','node_modules'])await mkdir(join(prepared.root,dir));
  const files={'dist/result.js':'build','__pycache__/x.pyc':'cache','app.tsbuildinfo':'ts cache','.env':'private','assets/family.txt':'unique'};
  for(const [path,bytes] of Object.entries(files))await writeFile(join(prepared.root,path),bytes);
  await writeFile(join(prepared.root,'node_modules/rebuildable'),'dependency');
  const command=frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[published]});
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,inventory:{worktree:false,branch:false,quarantined_whole:0,retained_quarantine:1}});
  const base=join(configDir,'task-worktrees-quarantine','folder-1');
  const name=(await readdir(base)).find(n=>n.endsWith('-preserved-ignored'))!;
  expect(JSON.parse(await readFile(join(base,name,'manifest.json'),'utf8'))).toMatchObject({state:'preserved',retention:'owner_review'});
  for(const [path,bytes] of Object.entries(files))expect(await readFile(join(base,name,'files',path),'utf8')).toBe(bytes);
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true});
 });

 it('cleans folded ignored ancestors with nested dependencies while preserving unknown siblings and symlinks',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip,prepared}=await savedRun(ref,'.gitignore','server/server/\n');
  const folded=join(prepared.root,'server/server');
  await mkdir(join(folded,'node_modules'),{recursive:true});
  await writeFile(join(folded,'node_modules','dependency'),'rebuildable');
  await mkdir(join(folded,'assets'));
  await writeFile(join(folded,'assets','unique.txt'),'must survive');
  const external=join(repoDir,'outside');await writeFile(external,'external');
  await symlink(external,join(folded,'outside-link'));
  const command=frame(ref,{action:'cleanup',expected_commit:tip});
  const answer=await executeWorkspaceCommand(repoDir,command);
  expect(answer,JSON.stringify(answer)).toMatchObject({ok:true,inventory:{worktree:false}});
  const dir=join(configDir,'task-worktrees-quarantine','folder-1');
  const name=(await readdir(dir)).find(n=>n.endsWith('-preserved-ignored'))!;
  const files=join(dir,name,'files');
  expect(await readFile(join(files,'server/server/assets/unique.txt'),'utf8')).toBe('must survive');
  expect(await readlink(join(files,'server/server/outside-link'))).toBe(external);
  expect(await readFile(external,'utf8')).toBe('external');
  await expect(access(join(files,'server/server/node_modules'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true});
 });

 it('preserves 2100 real ignored build files and symlinks without following them',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip,prepared}=await savedRun(ref,'.gitignore','secret-link\ncache/\nnode_modules/\n');
  const external=join(repoDir,'external-private');await writeFile(external,'outside bytes');
  await symlink(external,join(prepared.root,'secret-link'));await mkdir(join(prepared.root,'cache'));
  await mkdir(join(prepared.root,'node_modules'));await chmod(join(prepared.root,'node_modules'),0);
  for(let i=0;i<2100;i++)await writeFile(join(prepared.root,'cache',`${i}.js`),'cache');
  const scale=await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',expected_commit:tip}));expect(scale).toMatchObject({ok:true,inventory:{worktree:false}});
  expect(await readFile(external,'utf8')).toBe('outside bytes');
  const base=join(configDir,'task-worktrees-quarantine','folder-1');
  const name=(await readdir(base)).find(n=>n.endsWith('-preserved-ignored'))!;
  expect(await readlink(join(base,name,'files','secret-link'))).toBe(external);
  expect(await readdir(join(base,name,'files','cache'))).toHaveLength(2100);
 });

 it('captures an index matching working bytes, but blocks and preserves both partial-staging versions',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip,prepared}=await savedRun(ref,'file.txt','saved');
  await writeFile(join(prepared.root,'file.txt'),'index only');git(['add','file.txt'],prepared.root);
  await writeFile(join(prepared.root,'file.txt'),'working version');
  const blocked=frame(ref,{action:'cleanup',retain_branch:true,expected_commit:tip});
  expect(await executeWorkspaceCommand(repoDir,blocked)).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_uncaptured_index'});
  expect(git(['show',':file.txt'],prepared.root)).toBe('index only');
  expect(await readFile(join(prepared.root,'file.txt'),'utf8')).toBe('working version');
  git(['add','file.txt'],prepared.root);
  const command=frame(ref,{action:'cleanup',retain_branch:true,expected_commit:tip});
  const captured=await executeWorkspaceCommand(repoDir,command);
  expect(captured).toMatchObject({ok:false,error:'workspace_content_captured'});
  expect(git(['show',`${captured.commit}:file.txt`])).toBe('working version');
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({error:'workspace_content_captured',commit:captured.commit});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:true,expected_commit:captured.commit}))).toMatchObject({ok:true,inventory:{worktree:false,branch:true}});
 });

 it('keeps nested repositories blocked with their bytes intact',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip,prepared}=await savedRun(ref,'file.txt','saved');
  const nested=join(prepared.root,'nested');await mkdir(nested);git(['init','-q'],nested);
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:true,expected_commit:tip}))).toMatchObject({ok:false,cleanup_state:'blocked',error:'workspace_uncaptured_nested'});
  expect(existsSync(join(nested,'.git'))).toBe(true);
 });

 it('releases an old checkpoint using exact publication evidence beyond the 50-commit window, never a private self-pin',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const {tip}=await savedRun(ref,'file.txt','saved');
  const pin=`refs/rainver/recovery/${ref.id}/${tip}`;git(['update-ref',pin,tip]);
  const published=publishLikeNative(tip);
  await writeFile(join(repoDir,'file.txt'),'later edit');git(['commit','-qam','later edit']);
  for(let i=0;i<55;i++)git(['commit','--allow-empty','-qm',`advance ${i}`]);
  const {releaseRefs}=await import('../src/workspaceRetention.js');
  const target=git(['rev-parse','main']),base=git(['rev-list','--max-parents=0','main']);
  git(['update-ref','refs/heads/main',base]);
  expect(await releaseRefs(repoDir,ref,[{ref:pin,expected_commit:tip}],{proofs:[published]})).toContainEqual({ref:pin,reason:'checkpoint_not_in_target'});
  git(['update-ref','refs/heads/main',target]);
  expect(await releaseRefs(repoDir,{...ref,target_ref:pin},[{ref:pin,expected_commit:tip}])).toContainEqual({ref:pin,reason:'checkpoint_not_in_shared_target'});
  expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip,reclaim_proof:[published],release_refs:[{ref:pin,expected_commit:tip}]}))).toMatchObject({ok:true,inventory:{branch:false,owned_refs:[]}});
 });

 it('expires explicitly discarded ancestor pins through Run history, keeping unrelated unpublished pins',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
  const {tip:old}=await savedRun(ref,'old.txt','old private');
  const {tip}=await savedRun(ref,'new.txt','new private');
  const pin=`refs/rainver/recovery/${ref.id}/${old}`;git(['update-ref',pin,old]);
  const other=git(['commit-tree',`${old}^{tree}`,'-m','unrelated']);
  const foreign=`refs/rainver/recovery/${ref.id}/${other}`;git(['update-ref',foreign,other]);
  const result=await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip,discard_commit:tip,release_refs:[{ref:pin,expected_commit:old},{ref:foreign,expected_commit:other}]}));
  expect(result).toMatchObject({ok:true,inventory:{branch:false,retained_refs:[{ref:foreign,reason:'checkpoint_not_in_target'}]}});
  expect(git(['for-each-ref','--format=%(refname)',pin])).toBe('');
  const history=`refs/rainver/run-history/${ref.id}/g1/${tip}`;
  expect(git(['show',`${history}:old.txt`])).toBe('old private');
 });

 it('does not discard any of 22 unproven branches sharing one old tip',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const {tip}=await savedRun(ref,'unique.txt','unproven');
  const names=Array.from({length:22},()=>`refs/heads/rainver/workspace-${randomUUID()}-g1`);
  for(const name of names)git(['update-ref',name,tip]);
  const {verifyBranchReclaim}=await import('../src/workspaceRetention.js');
  expect(await verifyBranchReclaim(repoDir,tip,ref.target_ref,[],[])).toBe('workspace_reclaim_unproven');
  for(const name of names){
   const id=name.slice('refs/heads/rainver/workspace-'.length,-3);
   expect(await executeWorkspaceCommand(repoDir,frame({id,generation:1,target_ref:'refs/heads/main'},{action:'cleanup',retain_branch:false,expected_commit:tip}))).toMatchObject({ok:true,inventory:{branch:true,branch_retained_reason:'workspace_reclaim_unproven'}});
   expect(git(['rev-parse',name])).toBe(tip);
  }
 });

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

 it('preserves an unmerged cancelled source across Host process restart, lost reply and slot rematerialization',async()=>{
  const {helperProcessEnv}=await import('../src/providerBinding.js');
  const {pathToFileURL}=await import('node:url');
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'},saved=await savedRun(ref,'recover.txt','unique failed bytes\n');
  const command=frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:saved.tip,preserve_commit:saved.tip});
  const moduleUrl=pathToFileURL(resolve('dist/executionWorkspace.js')).href;
  const script=`import {readFileSync} from 'node:fs';import {executeWorkspaceCommand} from ${JSON.stringify(moduleUrl)};const i=JSON.parse(readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(await executeWorkspaceCommand(i.root,i.frame)));`;
  const invoke=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({root:repoDir,frame:command}),encoding:'utf8',env:helperProcessEnv(process.env),timeout:15000}));
  invoke(); // Reply deliberately lost; a fresh Host process must replay it.
  expect(invoke()).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false,worktree:false,registration:false}});
  const recovery=`refs/rainver/recovery/${ref.id}/${saved.tip}`;
  expect(git(['show',`${recovery}:recover.txt`])).toBe('unique failed bytes');
  const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
  const rebuilt=await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:2,base_commit:git(['rev-parse','main'])},randomUUID());
  await expect(access(join(rebuilt.root,'recover.txt'))).rejects.toThrow();
  expect(invoke()).toMatchObject({ok:true,cleanup_state:'cleaned'});
  await access(rebuilt.root);expect(git(['show',`${recovery}:recover.txt`])).toBe('unique failed bytes');
 });

 it('refuses preservation of divergent staging before making a recovery pin or deleting any version',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'},saved=await savedRun(ref,'partial.txt','saved\n');
  await writeFile(join(saved.prepared.root,'partial.txt'),'staged\n');git(['add','partial.txt'],saved.prepared.root);
  await writeFile(join(saved.prepared.root,'partial.txt'),'working\n');
  const answer=await executeWorkspaceCommand(repoDir,frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:saved.tip,preserve_commit:saved.tip}));
  expect(answer.ok).toBe(false);await access(saved.prepared.root);
  expect(git(['show',':partial.txt'],saved.prepared.root)).toBe('staged');
  expect(await readFile(join(saved.prepared.root,'partial.txt'),'utf8')).toBe('working\n');
  expect(git(['for-each-ref','--format=%(refname)',`refs/rainver/recovery/${ref.id}/${saved.tip}`])).toBe('');
 });

 it('durably links cleanup to its landing operation and refuses changing the owner on replay',async()=>{
  const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
  const saved=await savedRun(ref,'linked.txt','landing\n'),merged=publishLikeNative(saved.tip),owner=randomUUID();
  const command=frame({...ref,materialization_epoch:1},{action:'cleanup',retain_branch:false,expected_commit:saved.tip,reclaim_proof:[merged],lifecycle_operation_id:owner});
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned',lifecycle_operation_id:owner,inventory:{branch:false,worktree:false,registration:false}});
  expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,lifecycle_operation_id:owner});
  expect(await executeWorkspaceCommand(repoDir,{...command,lifecycle_operation_id:randomUUID()})).toMatchObject({ok:false,error:'workspace_cleanup_owner_changed'});
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

it.each(['journal','moved','preserved'] as const)('restores all files after injected %s failure and retries the same manifest',async stage=>{
 const {preserveIgnoredWorkspaceFiles,setIgnoredFaultForTest}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','dist/\n.env\n');
 await mkdir(join(prepared.root,'dist'));await writeFile(join(prepared.root,'dist','a.js'),'build');await writeFile(join(prepared.root,'.env'),'unique');
 const reset=setIgnoredFaultForTest(async at=>{if(at===stage)throw new Error('injected');});
 try{await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture')).rejects.toThrow('injected');}finally{reset();}
 expect(await readFile(join(prepared.root,'.env'),'utf8')).toBe('unique');expect(await readFile(join(prepared.root,'dist','a.js'),'utf8')).toBe('build');
 const next=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture');await next.rollback();
 expect((await readdir(join(configDir,'task-worktrees-quarantine','folder-1'))).filter(n=>n.endsWith('preserved-ignored'))).toHaveLength(0);
});
it('rolls back a concurrent ignored or dirty write without losing either version',async()=>{
 const {preserveIgnoredWorkspaceFiles,setIgnoredFaultForTest}=await import('../src/workspaceIgnored.js');
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
 const {tip,prepared}=await savedRun(ref,'.gitignore','.env\nnew-ignored\n');await writeFile(join(prepared.root,'.env'),'unique');
 let reset=setIgnoredFaultForTest(async stage=>{if(stage==='preserved')await writeFile(join(prepared.root,'new-ignored'),'concurrent');});
 try{await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture')).rejects.toThrow('workspace_uncaptured_ignored');}finally{reset();}
 expect(await readFile(join(prepared.root,'.env'),'utf8')).toBe('unique');expect(await readFile(join(prepared.root,'new-ignored'),'utf8')).toBe('concurrent');
 reset=setIgnoredFaultForTest(async stage=>{if(stage==='preserved')await writeFile(join(prepared.root,'README.md'),'dirty');});
 try{expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',expected_commit:tip}))).toMatchObject({ok:false,error:'workspace_uncheckpointed'});}finally{reset();}
 expect(await readFile(join(prepared.root,'.env'),'utf8')).toBe('unique');
});
it('detects a malicious intermediate symlink replacement before rename',async()=>{
 const {preserveIgnoredWorkspaceFiles,setIgnoredFaultForTest}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','nested/*.secret\n');
 await mkdir(join(prepared.root,'nested'));await writeFile(join(prepared.root,'nested','a.secret'),'original');await mkdir(join(repoDir,'external'));await writeFile(join(repoDir,'external','a.secret'),'outside');
 const reset=setIgnoredFaultForTest(async stage=>{if(stage==='journal'){await rename(join(prepared.root,'nested'),join(prepared.root,'detached'));await symlink(join(repoDir,'external'),join(prepared.root,'nested'));}});
 try{await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture')).rejects.toThrow('workspace_ignored_path_changed');}finally{reset();}
 expect(await readFile(join(repoDir,'external','a.secret'),'utf8')).toBe('outside');expect(await readFile(join(prepared.root,'detached','a.secret'),'utf8')).toBe('original');
});
it('provides owner list, collision-safe restore, explicit discard and rebuildable expiry',async()=>{
 const {preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');await writeFile(join(prepared.root,'.env'),'unique');
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture');await tx.commit();
 expect(await governIgnored(configDir,'folder-1','list')).toMatchObject({items:[{key:'fixture',retention:'owner_review',state:'preserved'}],next:null});
 await expect(governIgnored(configDir,'folder-1','discard','fixture')).rejects.toThrow('explicit');
 const target=join(repoDir,'recovery');await mkdir(target);await writeFile(join(target,'.env'),'collision');
 await expect(governIgnored(configDir,'folder-1','restore','fixture',false,target)).rejects.toThrow('collision');await rm(join(target,'.env'));
 await governIgnored(configDir,'folder-1','restore','fixture',false,target);expect(await readFile(join(target,'.env'),'utf8')).toBe('unique');
 await governIgnored(configDir,'folder-1','discard','fixture',true);await writeFile(join(prepared.root,'.env'),'owner declares rebuildable');
 const next=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture');await next.commit();
 expect(await governIgnored(configDir,'folder-1','rebuildable','fixture',true)).toEqual({expires_after_days:30});
 expect((await readdir(join(configDir,'task-worktrees-quarantine','folder-1'))).every(p=>p.endsWith('-retired'))).toBe(true);
});
it('replays an interrupted on-disk move before resuming the same workspace',async()=>{
 const {preserveIgnoredWorkspaceFiles,resumeIgnoredWorkspace}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');await writeFile(join(prepared.root,'.env'),'unique');
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture');await tx.commit();
 const manifest=join(configDir,'task-worktrees-quarantine','folder-1','fixture-preserved-ignored','manifest.json');
 const record=JSON.parse(await readFile(manifest,'utf8'));await writeFile(manifest,JSON.stringify({...record,state:'preserving'}));
 await resumeIgnoredWorkspace(configDir,'folder-1','fixture',prepared.root);
 expect(await readFile(join(prepared.root,'.env'),'utf8')).toBe('unique');
});
it('uses the existing 30-day retired sweep only after owner rebuildable authorization',async()=>{
 const {preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const {sweepTaskWorktrees}=await import('../src/taskWorktree.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');
 for(const key of ['rebuild','unknown']){
  await writeFile(join(prepared.root,'.env'),key);const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1',key);await tx.commit();
 }
 await governIgnored(configDir,'folder-1','rebuildable','rebuild',true);
 await sweepTaskWorktrees({workspaces:{},workspacesRoot:null,now:Date.now()+31*86400_000});
 const names=await readdir(join(configDir,'task-worktrees-quarantine','folder-1'));
 expect(names).toEqual(['unknown-preserved-ignored']);expect(await readFile(join(configDir,'task-worktrees-quarantine','folder-1',names[0]!,'files','.env'),'utf8')).toBe('unknown');
});
it('freezes a rollback collision with both versions visible and refuses another launch',async()=>{
 const {preserveIgnoredWorkspaceFiles,setIgnoredFaultForTest,assertIgnoredWorkspaceAvailable}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');await writeFile(join(prepared.root,'.env'),'old unique');
 const reset=setIgnoredFaultForTest(async stage=>{if(stage==='preserved')await writeFile(join(prepared.root,'.env'),'new unique');});
 try{await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture')).rejects.toThrow('restore_collision');}finally{reset();}
 expect(await readFile(join(prepared.root,'.env'),'utf8')).toBe('new unique');
 expect(await readFile(join(configDir,'task-worktrees-quarantine','folder-1','fixture-preserved-ignored','files','.env'),'utf8')).toBe('old unique');
 await expect(assertIgnoredWorkspaceAvailable(configDir,'folder-1','fixture')).rejects.toThrow('owner_review');
 await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture')).rejects.toThrow('owner_review');
});
it('keeps oversized unknown assets in place when preservation admission exceeds quota',async()=>{
 const {preserveIgnoredWorkspaceFiles}=await import('../src/workspaceIgnored.js');
 const {open}=await import('node:fs/promises');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','large-asset\n');
 const h=await open(join(prepared.root,'large-asset'),'w');await h.truncate(1024*1024*1024+1);await h.close();
 await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture')).rejects.toThrow('quota');
 const st=await import('node:fs/promises').then(fs=>fs.stat(join(prepared.root,'large-asset')));expect(st.size).toBe(1024*1024*1024+1);
});

it('governs legacy UUID preservation manifests through keys returned by list',async()=>{
 const {preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');await writeFile(join(prepared.root,'.env'),'legacy unique');
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture');await tx.commit();
 const dir=join(configDir,'task-worktrees-quarantine','folder-1'),key=`fixture-${randomUUID()}`;
 await rename(join(dir,'fixture-preserved-ignored'),join(dir,`${key}-preserved-ignored`));
 const target=join(repoDir,'restored');await mkdir(target);
 expect(await governIgnored(configDir,'folder-1','list')).toMatchObject({items:[{key}]});
 await governIgnored(configDir,'folder-1','restore',key,false,target);
 expect(await readFile(join(target,'.env'),'utf8')).toBe('legacy unique');
 await governIgnored(configDir,'folder-1','discard',key,true);
});

it('continues a Run in the same generation after real idle physical cleanup',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
 const {tip,prepared}=await savedRun(ref,'.gitignore','.env\n');
 await writeFile(join(prepared.root,'.env'),'unique before a day idle');
 // Server's idle cleanup retains the branch/generation, removes only the tree.
 expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',expected_commit:tip,retain_branch:true}))).toMatchObject({ok:true,inventory:{worktree:false,branch:true}});
 const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
 const next=await prepareExecutionWorkspace(check.repo,'folder-1',ref,randomUUID());
 expect(next.root).toBe(prepared.root);
 expect(await readFile(join(next.root,'.env'),'utf8')).toBe('unique before a day idle');
 const {sweepTaskWorktrees}=await import('../src/taskWorktree.js');
 expect(await sweepTaskWorktrees({workspaces:{'folder-1':repoDir},workspacesRoot:null,now:Date.now()+2*86400_000})).toBe(1);
 const afterIdle=await prepareExecutionWorkspace(check.repo,'folder-1',ref,randomUUID());
 expect(afterIdle.root).toBe(prepared.root);
 expect(await readFile(join(afterIdle.root,'.env'),'utf8')).toBe('unique before a day idle');
 await writeFile(join(afterIdle.root,'README.md'),'staged version');git(['add','README.md'],afterIdle.root);
 await writeFile(join(afterIdle.root,'README.md'),'working version');
 expect(await sweepTaskWorktrees({workspaces:{'folder-1':repoDir},workspacesRoot:null,now:Date.now()+4*86400_000})).toBe(0);
 expect(git(['show',':README.md'],afterIdle.root)).toBe('staged version');
 expect(await readFile(join(afterIdle.root,'README.md'),'utf8')).toBe('working version');
 expect(await readdir(join(configDir,'task-worktrees-quarantine','folder-1'))).toEqual([]);
});
it('retries a committed preservation after a crash before worktree deletion',async()=>{
 const {preserveIgnoredWorkspaceFiles}=await import('../src/workspaceIgnored.js');
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main'};
 const {tip,prepared}=await savedRun(ref,'.gitignore','.env\n');await writeFile(join(prepared.root,'.env'),'survives crash');
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1',workspaceWorktreeKey(ref));await tx.commit();
 expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',expected_commit:tip}))).toMatchObject({ok:true,inventory:{worktree:false}});
 const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
 const next=await prepareExecutionWorkspace(check.repo,'folder-1',ref,randomUUID());
 expect(await readFile(join(next.root,'.env'),'utf8')).toBe('survives crash');
});
it('does not charge retired or rolled-back shells to active preservation quota',async()=>{
 const {preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');
 const dir=join(configDir,'task-worktrees-quarantine','folder-1');await mkdir(dir,{recursive:true});
 for(let i=0;i<130;i++){
  await mkdir(join(dir,`old-${i}-retired`));
  const shell=join(dir,`old-${i}-preserved-ignored`);await mkdir(shell);
  await writeFile(join(shell,'manifest.json'),JSON.stringify({version:2,state:'rolled_back',workspace_key:'forged',location_id:'folder-1',original_root:prepared.root,paths:[]}));
 }
 await writeFile(join(prepared.root,'.env'),'unique');
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','fixture');await tx.commit();
 const list=await governIgnored(configDir,'folder-1','list',undefined,false,undefined,{limit:512});
 expect(list).toMatchObject({items:expect.arrayContaining([expect.objectContaining({key:'old-129'})]),next:null});
 expect('items' in list&&list.items?.length).toBe(131);
});
it('retires only explicitly declared exact roots across generations, including a multi-GiB file in a mixed root',async()=>{
 const {declareIgnoredRoot,preserveIgnoredWorkspaceFiles,sweepRetiredIgnored}=await import('../src/workspaceIgnored.js');
 const {open}=await import('node:fs/promises');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','output/\n');
 await mkdir(join(prepared.root,'output','cache'),{recursive:true});
 await writeFile(join(prepared.root,'output','unique.txt'),'family asset');
 await expect(declareIgnoredRoot(configDir,'folder-1',prepared.root,'output/cache',false)).rejects.toThrow('explicit');
 await declareIgnoredRoot(configDir,'folder-1',prepared.root,'output/cache',true);
 for(const key of ['generation-one','generation-two']){
  await mkdir(join(prepared.root,'output','cache'),{recursive:true});
  const h=await open(join(prepared.root,'output','cache','huge'),'w');await h.truncate(2*1024**3);await h.close();
  const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1',key);await tx.commit();
 }
 await sweepRetiredIgnored(configDir,'folder-1',Date.now()+31*86400_000);
 const base=join(configDir,'task-worktrees-quarantine','folder-1','generation-one-preserved-ignored');
 expect(await readFile(join(base,'files','output','unique.txt'),'utf8')).toBe('family asset');
 expect(existsSync(join(base,'files','output','cache'))).toBe(false);
 expect(existsSync(join(configDir,'task-worktrees-quarantine','folder-1','generation-two-preserved-ignored'))).toBe(false);
});
it('rejects traversal, symlinks and sensitive content for continuous root declarations',async()=>{
 const {declareIgnoredRoot,preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','cache/\n');
 await mkdir(join(prepared.root,'cache'));
 for(const path of ['../cache','/cache','.env','cache/../cache'])await expect(declareIgnoredRoot(configDir,'folder-1',prepared.root,path,true)).rejects.toThrow();
 await symlink(join(prepared.root,'cache'),join(prepared.root,'linked'));
 await expect(declareIgnoredRoot(configDir,'folder-1',prepared.root,'linked',true)).rejects.toThrow();
 await declareIgnoredRoot(configDir,'folder-1',prepared.root,'cache',true);
 await writeFile(join(prepared.root,'cache','.env'),'new unknown secret');
 await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','blocked')).rejects.toThrow('sensitive');
 expect(await readFile(join(prepared.root,'cache','.env'),'utf8')).toBe('new unknown secret');
 expect(await governIgnored(configDir,'folder-1','list')).toMatchObject({items:expect.arrayContaining([expect.objectContaining({key:'blocked',blocked_reason:expect.stringContaining('sensitive')})])});
});
it('lists quota-blocked workspaces and admits them after an active snapshot is resolved',async()=>{
 const {preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');
 const dir=join(configDir,'task-worktrees-quarantine','folder-1');await mkdir(dir,{recursive:true});
 for(let i=0;i<128;i++){
  const base=join(dir,`active-${i}-preserved-ignored`);await mkdir(join(base,'files'),{recursive:true});
  await writeFile(join(base,'files','.env'),'unique');
  await writeFile(join(base,'manifest.json'),JSON.stringify({version:2,location_id:'folder-1',workspace_key:`active-${i}`,original_root:prepared.root,paths:['.env'],state:'preserved',retention:'owner_review',bytes:6}));
 }
 await writeFile(join(prepared.root,'.env'),'blocked unique');
 await expect(preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','waiting')).rejects.toThrow('quota');
 expect(await governIgnored(configDir,'folder-1','list')).toMatchObject({items:expect.arrayContaining([expect.objectContaining({key:'waiting',blocked_reason:expect.stringContaining('quota')})])});
 expect(existsSync(join(dir,'waiting-preserved-ignored'))).toBe(false);
 expect(await readFile(join(prepared.root,'.env'),'utf8')).toBe('blocked unique');
 await governIgnored(configDir,'folder-1','discard','active-0',true);
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','waiting');await tx.rollback();
 expect(existsSync(join(dir,'waiting-preserved-ignored'))).toBe(false);
});

it('expires late terminal replies only behind a completed release fence and preserves rematerialized/offline evidence',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip}=await savedRun(ref,'done.txt','landed');publishLikeNative(tip);
 const release=frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip});
 expect(await executeWorkspaceCommand(repoDir,release)).toMatchObject({ok:true,inventory:{branch:false,worktree:false,registration:false}});
 const {sweepTaskWorktrees}=await import('../src/taskWorktree.js');
 const key=workspaceWorktreeKey(ref),suffix=`${randomUUID()}:${ref.id}:g1.json`;
 const run=join(configDir,'task-runs',suffix),launch=join(configDir,'workspace-launches',suffix);
 const makeLate=async()=>{
  for(const [path,value] of [[run,{task_id:key,location_id:'folder-1',settled_by:'settle',start_commit:tip,commit:tip,branch:null,at:new Date().toISOString()}],[launch,{id:ref.id,generation:1,workspace_location_id:'folder-1',start_commit:tip}]] as const){
   await mkdir(join(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value));await utimes(path,new Date(0),new Date(0));
  }
 };
 await makeLate();await sweepTaskWorktrees({workspaces:{'folder-1':repoDir},workspacesRoot:null});
 expect(existsSync(run)).toBe(false);expect(existsSync(launch)).toBe(false);
 const fence=join(configDir,'workspace-materializations','folder-1',`${key}.json`);
 expect(existsSync(fence)).toBe(true);
 const repository=await checkLocationRepository(repoDir);if(repository.kind!=='repository')throw new Error('fixture');
 for(const stale of [ref,{...ref,materialization_epoch:undefined},{...ref,integration_id:randomUUID()}])await expect(prepareExecutionWorkspace(repository.repo,'folder-1',stale,randomUUID())).rejects.toThrow('workspace_materialization_stale');
 expect(await executeWorkspaceCommand(repoDir,release)).toMatchObject({ok:true,inventory:{branch:false}});
 const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
 await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:2,sync_to_target:true},randomUUID());
 await makeLate();await sweepTaskWorktrees({workspaces:{'folder-1':repoDir},workspacesRoot:null});
 expect(existsSync(run)).toBe(true);expect(existsSync(launch)).toBe(true);
 // Age alone never releases an offline owner's retained replay evidence.
 const retained=join(configDir,'task-runs','offline.json');
 await writeFile(retained,JSON.stringify({task_id:workspaceWorktreeKey({...ref,id:randomUUID()}),location_id:'folder-1'}));await utimes(retained,new Date(0),new Date(0));
 await sweepTaskWorktrees({workspaces:{'folder-1':repoDir},workspacesRoot:null});expect(existsSync(retained)).toBe(true);
});
it('expires terminal cleanup and candidate/native replies in pages while retaining replay fences and incomplete evidence',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip}=await savedRun(ref,'result.txt','recoverable result');publishLikeNative(tip);
 const physical=frame(ref,{action:'cleanup',expected_commit:tip});
 expect(await executeWorkspaceCommand(repoDir,physical)).toMatchObject({ok:true,inventory:{branch:true,worktree:false}});
 const released=frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip});
 expect(await executeWorkspaceCommand(repoDir,released)).toMatchObject({ok:true,inventory:{branch:false}});
 const key=workspaceWorktreeKey(ref),integration=randomUUID(),pending=randomUUID();
 const native=join(configDir,'workspace-native','folder-1',key);
 const old=async(path:string,value:unknown)=>{await mkdir(join(path,'..'),{recursive:true});await writeFile(path,typeof value==='string'?value:JSON.stringify(value));await utimes(path,new Date(0),new Date(0));};
 const fingerprint=(id:string)=>JSON.stringify({action:'native_prepare',workspace:{execution_workspace:{...ref,integration_id:id}}});
 await old(join(native,`${integration}.json`),{merged:tip,source:tip,prepared:tip});
 await old(join(native,`${pending}.json`),{publishing_commit:tip,source:tip,prepared:tip});
 const unfinished=join(native,`request-${randomUUID()}.json`);
 await old(unfinished,{fingerprint:fingerprint(pending),answer:{ok:true}});
 for(let i=0;i<4200;i++)await old(join(native,`request-${randomUUID()}.json`),{fingerprint:fingerprint(integration),answer:{ok:true}});
 await old(join(native,'00000000-0000-4000-8000-000000000000.json'),'{');
 const candidateKey=workspaceWorktreeKey({...ref,integration_id:integration});
 const candidate=join(configDir,'task-merges',`${integration}.json`);
 const metadata=['workspace-baselines','workspace-sequences'].map(kind=>join(configDir,kind,'folder-1',`${candidateKey}.json`));
 for(const path of metadata)await old(path,path.includes('workspace-baselines')?{kind:'committed',head:null,tree:null}:{sequence:1});
 await old(candidate,{task_id:candidateKey,location_id:'folder-1',merged_commit:tip});
 const candidateTree=join(configDir,'task-worktrees','folder-1',candidateKey);
 await mkdir(candidateTree,{recursive:true});await writeFile(join(candidateTree,'unique'),'candidate evidence');
 const running=join(configDir,'workspace-cleanup',`${randomUUID()}.json`);
 await old(running,{state:'running',capture_commit:tip,owner:{location_id:'folder-1',key,epoch:1}});
 const noScope=join(configDir,'workspace-cleanup',`${randomUUID()}.json`);
 await old(noScope,{state:'cleaned',capture_commit:tip});
 const journal=join(configDir,'workspace-cleanup',`${physical.operation_id}.json`);
 await utimes(journal,new Date(0),new Date(0));
 const {pruneWorkspaceReceipts}=await import('../src/workspaceReceiptExpiry.js');
 const errors:string[]=[];
 await pruneWorkspaceReceipts(Date.now(),s=>errors.push(s));
 expect(existsSync(candidate)).toBe(true);for(const path of metadata)expect(existsSync(path)).toBe(true);
 expect(await readFile(join(candidateTree,'unique'),'utf8')).toBe('candidate evidence');
 await rm(candidateTree,{recursive:true});
 for(let i=0;i<20;i++)await pruneWorkspaceReceipts(Date.now(),s=>errors.push(s));
 expect(existsSync(candidate)).toBe(false);for(const path of metadata)expect(existsSync(path)).toBe(false);
 expect((await readdir(native)).sort()).toEqual([`${pending}.json`,unfinished.split('/').at(-1)!, '00000000-0000-4000-8000-000000000000.json'].sort());
 expect(errors.join('\n')).toContain('JSON');
 expect(existsSync(journal)).toBe(false);
 expect(existsSync(running)).toBe(true);expect(existsSync(noScope)).toBe(true);expect(errors.join('\n')).toContain('workspace_cleanup_owner_unknown');
 expect(existsSync(join(configDir,'workspace-materializations','folder-1',`${key}.json`))).toBe(true);
 expect(await executeWorkspaceCommand(repoDir,physical)).toMatchObject({ok:false,error:'workspace_materialization_moved'});
 expect(await executeWorkspaceCommand(repoDir,released)).toMatchObject({ok:true,inventory:{branch:false}});
});
it('charges a corrupt manifest one active slot without blocking unrelated capacity',async()=>{
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');
 const dir=join(configDir,'task-worktrees-quarantine','folder-1');await mkdir(dir,{recursive:true});
 for(let i=0;i<4100;i++)await mkdir(join(dir,`old-${i}-retired`));
 const broken=join(dir,'broken-preserved-ignored');await mkdir(broken);await writeFile(join(broken,'manifest.json'),'{');
 await writeFile(join(prepared.root,'.env'),'unique source asset');
 const {preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','tail');await tx.commit();
 expect(await readFile(join(dir,'tail-preserved-ignored','files','.env'),'utf8')).toBe('unique source asset');
 expect(await readFile(join(broken,'manifest.json'),'utf8')).toBe('{');
 expect((await governIgnored(configDir,'folder-1','list','broken')).errors).toMatchObject([{error:'invalid_json'}]);
});

it('starts a conflict-resolution candidate after real release and same-generation rebuild, while fencing the old epoch',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip}=await savedRun(ref,'feature','published');publishLikeNative(tip);
 const release=frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip});
 expect(await executeWorkspaceCommand(repoDir,release)).toMatchObject({ok:true,inventory:{branch:false,worktree:false}});
 const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
 const fresh={...ref,materialization_epoch:2,sync_to_target:true};
 const rebuilt=await savedRun(fresh,'README.md','source conflict\n');
 await writeFile(join(repoDir,'README.md'),'target conflict\n');git(['commit','-qam','target moved']);
 const integration={...fresh,integration_id:randomUUID()};
 const {executeWorkspaceIntegration}=await import('../src/workspaceIntegration.js');
 const mergeFrame={type:'workspace_integration' as const,request_id:randomUUID(),workspace:{kind:'location' as const,workspace_location_id:'folder-1',execution_workspace:integration},action:'prepare' as const,source_commit:rebuilt.tip,base_commit:tip,target_ref:'refs/heads/main',author,message:'integrate rebuilt source'};
 expect(await executeWorkspaceIntegration(repoDir,mergeFrame)).toMatchObject({ok:true,outcome:'conflict'});
 expect(await executeWorkspaceIntegration(repoDir,{...mergeFrame,action:'repair',repair_mode:'agent_resolution'})).toMatchObject({ok:true});
 const {prepareExecutionWorkspaceResolution}=await import('../src/executionWorkspace.js');
 const legacy={...integration,materialization_epoch:undefined};
 const candidate=await prepareExecutionWorkspaceResolution(check.repo,'folder-1',legacy);
 expect(existsSync(candidate.root)).toBe(true);
 await writeFile(join(candidate.root,'README.md'),'conflict repair\n');
 const repair=await executeWorkspaceIntegration(repoDir,{...mergeFrame,action:'continue',workspace:{...mergeFrame.workspace,execution_workspace:legacy}});expect(repair).toMatchObject({ok:true,outcome:'rebased'});
 for(const stale of [ref,{...integration,materialization_epoch:1}])await expect(prepareExecutionWorkspace(check.repo,'folder-1',stale,randomUUID())).rejects.toThrow('workspace_materialization_stale');
 expect(await executeWorkspaceCommand(repoDir,release)).toMatchObject({ok:true,inventory:{branch:false}});
 expect(git(['rev-parse',rebuilt.prepared.branch])).toBe(rebuilt.tip);expect(git(['show',`${repair.candidate_commit}:README.md`])).toBe('conflict repair');
 // A later admitted source cannot upgrade an existing candidate attempt.
 await prepareExecutionWorkspace(check.repo,'folder-1',{...fresh,materialization_epoch:3},randomUUID());
 for(const action of ['prepare','continue','repair'] as const){
  for(const frozen of [integration,legacy,{...integration,materialization_epoch:3}]){
   expect(await executeWorkspaceIntegration(repoDir,{...mergeFrame,action,workspace:{...mergeFrame.workspace,execution_workspace:frozen},repair_mode:'agent_resolution'}).catch(e=>({ok:false,error:(e as Error).message}))).toMatchObject({ok:false,error:'workspace_materialization_stale'});
  }
 }
 expect(await readFile(join(candidate.root,'README.md'),'utf8')).toBe('conflict repair\n');
 const newAttempt={...fresh,materialization_epoch:3,integration_id:randomUUID()};
 const next={...mergeFrame,workspace:{...mergeFrame.workspace,execution_workspace:newAttempt}};
 expect(await executeWorkspaceIntegration(repoDir,next)).toMatchObject({ok:true,outcome:'conflict'});
 expect(await executeWorkspaceIntegration(repoDir,{...next,action:'repair',repair_mode:'agent_resolution'})).toMatchObject({ok:true});

});

it('serializes concurrent quota admission exactly and resumes after terminal capacity release',async()=>{
 const {preserveIgnoredWorkspaceFiles,governIgnored}=await import('../src/workspaceIgnored.js');
 const a=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');
 const b=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');
 const dir=join(configDir,'task-worktrees-quarantine','folder-1');await mkdir(dir,{recursive:true});
 for(let i=0;i<127;i++){
  const key=`active-${i}`,base=join(dir,`${key}-preserved-ignored`);await mkdir(join(base,'files'),{recursive:true});
  await writeFile(join(base,'manifest.json'),JSON.stringify({version:2,state:'preserved',workspace_key:key,location_id:'folder-1',original_root:a.prepared.root,paths:['asset'],retired_paths:[],retention:'owner_review',bytes:0}));
 }
 await writeFile(join(a.prepared.root,'.env'),'first unique');await writeFile(join(b.prepared.root,'.env'),'second unique');
 const first=await preserveIgnoredWorkspaceFiles(a.prepared.root,configDir,'folder-1','first');
 const waiting=preserveIgnoredWorkspaceFiles(b.prepared.root,configDir,'folder-1','second').then(tx=>({tx,error:null}),error=>({tx:null,error}));
 await first.commit();
 const refused=await waiting;expect(refused.error?.message).toBe('workspace_ignored_quota');expect(refused.tx).toBeNull();
 expect(await readFile(join(b.prepared.root,'.env'),'utf8')).toBe('second unique');
 await governIgnored(configDir,'folder-1','discard','active-0',true);
 const second=await preserveIgnoredWorkspaceFiles(b.prepared.root,configDir,'folder-1','second');await second.commit();
 expect(await readFile(join(dir,'second-preserved-ignored','files','.env'),'utf8')).toBe('second unique');
 expect((await readdir(dir)).filter(n=>n.endsWith('-preserved-ignored'))).toHaveLength(128);
});

it('rechecks an aged receipt rewritten after its pre-lock observation',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip}=await savedRun(ref,'done','published');publishLikeNative(tip);
 expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip}))).toMatchObject({ok:true});
 const {pruneWorkspaceReceipts,setReceiptExpiryBeforeLeaseForTest}=await import('../src/workspaceReceiptExpiry.js');
 const receipt=join(configDir,'workspace-launches',`${randomUUID()}:${ref.id}:g1.json`);
 const original={id:ref.id,generation:1,workspace_location_id:'folder-1',start_commit:tip};
 await writeFile(receipt,JSON.stringify(original));await utimes(receipt,new Date(0),new Date(0));
 let changed=false;
 const restore=setReceiptExpiryBeforeLeaseForTest(async path=>{if(path===receipt&&!changed){changed=true;await writeFile(path,JSON.stringify({...original,new_observation:'keep these new bytes'}));}});
 try{await pruneWorkspaceReceipts(Date.now(),()=>{});}finally{restore();}
 expect(changed).toBe(true);expect(JSON.parse(await readFile(receipt,'utf8')).new_observation).toBe('keep these new bytes');
});

it('continues release-owned receipt deletion immediately without thirty-day aging and removes terminal cursors',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip}=await savedRun(ref,'done','published');publishLikeNative(tip);
 const dir=join(configDir,'workspace-launches');await mkdir(dir,{recursive:true});
 for(let i=0;i<4200;i++)await writeFile(join(dir,`${randomUUID()}:${ref.id}:g1.json`),JSON.stringify({id:ref.id,generation:1,workspace_location_id:'folder-1',start_commit:tip}));
 const unknown=join(dir,'000-unknown.json');await writeFile(unknown,'{"unique":"keep"}');
 const release=frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip});
 const {onWorkspaceSweepContinuation}=await import('../src/workspaceFilePages.js');
 let wakes=0;const stopWake=onWorkspaceSweepContinuation(()=>{wakes++;});
 try{expect(await executeWorkspaceCommand(repoDir,release)).toMatchObject({ok:true});}finally{stopWake();}
 expect(wakes).toBeGreaterThan(0);
 const {sweepTaskWorktrees}=await import('../src/taskWorktree.js');
 let passes=0;
 // Each pass has a real two-second I/O budget shared by rotating stages.
 // Under host contention fewer than 256 receipts may fit in a pass; assert
 // eventual physical convergence without assuming a particular disk speed.
 for(;passes<128;passes++){
  await Promise.all([sweepTaskWorktrees({workspaces:{'folder-1':repoDir},workspacesRoot:null}),sweepTaskWorktrees({workspaces:{'folder-1':repoDir},workspacesRoot:null})]);
  if(!(await readdir(dir)).some(n=>n.endsWith(`:${ref.id}:g1.json`)))break;
 }
 expect((await readdir(dir)).filter(n=>n.endsWith(`:${ref.id}:g1.json`))).toHaveLength(0);
 expect(await readFile(unknown,'utf8')).toContain('keep');
 expect(await readdir(join(configDir,'workspace-receipt-reclaims'))).toEqual([]);
 const {createHash}=await import('node:crypto');
 for(const kind of ['workspace-launches','task-runs','task-merges']){
  const cursor=createHash('sha256').update('release-receipts-'+workspaceWorktreeKey(ref)+'\0'+join(configDir,kind)).digest('hex')+'.json';
  expect(existsSync(join(configDir,'workspace-sweeps',cursor))).toBe(false);
 }
 expect(await executeWorkspaceCommand(repoDir,release)).toMatchObject({ok:true});
 console.info(`receipt convergence: 4200 recent replies physically absent in ${passes+1} continuation passes; owner intent and terminal cursors absent`);
});

it('upgrades an exactly replayed legacy cleaned journal to an attributable expiring terminal record',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip}=await savedRun(ref,'done','published');publishLikeNative(tip);
 const physical=frame(ref,{action:'cleanup',expected_commit:tip});expect(await executeWorkspaceCommand(repoDir,physical)).toMatchObject({ok:true});
 const path=join(configDir,'workspace-cleanup',`${physical.operation_id}.json`),record=JSON.parse(await readFile(path,'utf8'));
 delete record.owner;delete record.digest_version;await writeFile(path,JSON.stringify(record));
 expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip}))).toMatchObject({ok:true});
 expect(await executeWorkspaceCommand(repoDir,physical)).toMatchObject({ok:true});
 expect(JSON.parse(await readFile(path,'utf8'))).toMatchObject({digest_version:2,owner:{key:workspaceWorktreeKey(ref)}});
 await utimes(path,new Date(0),new Date(0));
 const {pruneWorkspaceReceipts}=await import('../src/workspaceReceiptExpiry.js');await pruneWorkspaceReceipts(Date.now(),()=>{});
 expect(existsSync(path)).toBe(false);
 expect(await executeWorkspaceCommand(repoDir,physical)).toMatchObject({ok:false,error:'workspace_materialization_moved'});
});


it('migrates over 512 retired manifests without spending the 128 active quota or bypassing corrupt slots',async()=>{
 const {prepared}=await savedRun({id:randomUUID(),generation:1,target_ref:'refs/heads/main'},'.gitignore','.env\n');
 const {preserveIgnoredWorkspaceFiles,governIgnored,sweepRetiredIgnored}=await import('../src/workspaceIgnored.js');
 const dir=join(configDir,'task-worktrees-quarantine','folder-1');await mkdir(dir,{recursive:true});
 const snapshot=async(key:string,retired:boolean)=>{
  const base=join(dir,key+'-preserved-ignored');await mkdir(join(base,'files','build'),{recursive:true});
  await writeFile(join(base,'files','build','output'),key);
  await writeFile(join(base,'manifest.json'),JSON.stringify({version:2,location_id:'folder-1',workspace_key:key,original_root:prepared.root,paths:['build'],state:'preserved',retention:'owner_review',bytes:0,retired_paths:retired?['build']:[],...(retired?{retired_at:new Date().toISOString()}:{} )}));
 };
 for(let i=0;i<600;i++)await snapshot('old-'+i,true);
 for(let i=0;i<127;i++)await snapshot('live-'+i,false);
 await mkdir(join(dir,'corrupt-preserved-ignored'));await writeFile(join(dir,'corrupt-preserved-ignored','manifest.json'),'{');
 await writeFile(join(prepared.root,'.env'),'new unique environment');
 let reason='';for(let i=0;i<4;i++){try{await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','waiting');}catch(e){reason=(e as Error).message;}if(reason!=='workspace_ignored_scan_pending')break;}
 expect(reason).toBe('workspace_ignored_quota');
 expect(await readFile(join(prepared.root,'.env'),'utf8')).toBe('new unique environment');
 expect((await readdir(dir)).filter(n=>n.startsWith('old-'))).toHaveLength(600);
 await governIgnored(configDir,'folder-1','discard','live-0',true);
 const tx=await preserveIgnoredWorkspaceFiles(prepared.root,configDir,'folder-1','waiting');await tx.commit();
 expect((await readdir(dir)).filter(n=>n.endsWith('-retired-ignored'))).toHaveLength(600);
 expect(await readFile(join(dir,'waiting-preserved-ignored','files','.env'),'utf8')).toBe('new unique environment');
 expect(await readFile(join(dir,'corrupt-preserved-ignored','manifest.json'),'utf8')).toBe('{');
 expect((await governIgnored(configDir,'folder-1','list','old-599')).items).toMatchObject([{key:'old-599',retired_paths:['build']}]);
 const restore=join(configDir,'restored');await mkdir(restore);
 await governIgnored(configDir,'folder-1','restore','old-599',false,restore);
 expect(await readFile(join(restore,'build','output'),'utf8')).toBe('old-599');
 // Continue the durable frontier; an I/O time budget may end a page before its item cap.
 for(let i=0;i<600;i++){
  const next=await sweepRetiredIgnored(configDir,'folder-1',Date.now()+31*86400_000);
  if(next===undefined)break;
 }
 expect((await readdir(dir)).filter(n=>n.endsWith('-retired-ignored'))).toHaveLength(0);
 expect(await readFile(join(dir,'live-1-preserved-ignored','files','build','output'),'utf8')).toBe('live-1');
 console.info('quota: 600 retired migrated/expired, restore succeeded; 127 live + corrupt slot refused admission, freed slot admitted unique bytes');
});

it('tombstones a cleaned candidate without releasing its source and expires its journal behind the fence',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip}=await savedRun(ref,'done','published');
 const candidate={...ref,integration_id:randomUUID()};
 const {executeWorkspaceIntegration}=await import('../src/workspaceIntegration.js');
 const prepare={type:'workspace_integration' as const,request_id:randomUUID(),workspace:{kind:'location' as const,workspace_location_id:'folder-1',execution_workspace:candidate},action:'prepare' as const,source_commit:tip,base_commit:git(['rev-parse','main']),target_ref:'refs/heads/main',author,message:'candidate'};
 const prepared=await executeWorkspaceIntegration(repoDir,prepare);expect(prepared).toMatchObject({ok:true});
 const key=workspaceWorktreeKey(candidate),command=frame(candidate,{action:'cleanup',retain_branch:false,expected_commit:prepared.candidate_commit!});
 expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned',inventory:{branch:false,worktree:false,materialization_epoch:2}});
 expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned'});
 const {recordedMaterializationEpoch}=await import('../src/workspaceRetention.js');
 expect(await recordedMaterializationEpoch('folder-1',workspaceWorktreeKey(ref))).toBe(1);
 for(const stale of [candidate,{...candidate,materialization_epoch:undefined},{...candidate,materialization_epoch:2}]){
  expect(await executeWorkspaceIntegration(repoDir,{...prepare,workspace:{...prepare.workspace,execution_workspace:stale}}).catch(e=>({ok:false,error:(e as Error).message}))).toMatchObject({ok:false,error:'workspace_materialization_stale'});
 }
 const journal=join(configDir,'workspace-cleanup',command.operation_id+'.json');await utimes(journal,new Date(0),new Date(0));
 const {pruneWorkspaceReceipts}=await import('../src/workspaceReceiptExpiry.js');
 await pruneWorkspaceReceipts(Date.now(),()=>{});expect(existsSync(journal)).toBe(false);
 expect(await executeWorkspaceCommand(repoDir,command)).toMatchObject({ok:true,cleanup_state:'cleaned'});
 const inspected=await executeWorkspaceCommand(repoDir,frame(candidate,{action:'inspect'}));
 expect(inspected.inventory).toMatchObject({branch:false,worktree:false,registration:false,merge_record:false});
 expect(git(['worktree','list','--porcelain'])).not.toContain(join(configDir,'task-worktrees','folder-1',key));
 expect((await executeWorkspaceCommand(repoDir,frame(ref,{action:'inspect'}))).inventory).toMatchObject({branch:true});
});

it('converges attributable ignored refusals after release while retaining new-source and unknown legacy evidence',async()=>{
 const ref={id:randomUUID(),generation:1,target_ref:'refs/heads/main',materialization_epoch:1};
 const {tip,prepared}=await savedRun(ref,'done','published');publishLikeNative(tip);
 const dir=join(configDir,'task-worktrees-quarantine','folder-1'),key=workspaceWorktreeKey(ref);await mkdir(dir,{recursive:true});
 const blocked=join(dir,key+'-blocked-ignored.json'),legacy=join(dir,'legacy-blocked-ignored.json');
 const receipt={version:2,location_id:'folder-1',workspace_key:key,original_root:prepared.root,paths:[],state:'rolled_back',retention:'owner_review',bytes:0,blocked_reason:'workspace_ignored_quota'};
 await writeFile(blocked,JSON.stringify(receipt));await writeFile(legacy,'{"unknown":"keep"}');
 const {sweepIgnoredBlockedReceipts}=await import('../src/workspaceIgnoredReceipts.js');const logs:string[]=[];
 await sweepIgnoredBlockedReceipts(configDir,'folder-1',x=>logs.push(x));expect(existsSync(blocked)).toBe(true);
 expect(await executeWorkspaceCommand(repoDir,frame(ref,{action:'cleanup',retain_branch:false,expected_commit:tip}))).toMatchObject({ok:true});
 await sweepIgnoredBlockedReceipts(configDir,'folder-1',x=>logs.push(x));expect(existsSync(blocked)).toBe(false);
 expect(await readFile(legacy,'utf8')).toContain('keep');expect(logs.join(' ')).toContain('legacy_owner_unknown');
 const check=await checkLocationRepository(repoDir);if(check.kind!=='repository')throw new Error('fixture');
 await prepareExecutionWorkspace(check.repo,'folder-1',{...ref,materialization_epoch:2},randomUUID());
 await writeFile(blocked,JSON.stringify(receipt));
 await sweepIgnoredBlockedReceipts(configDir,'folder-1',x=>logs.push(x));expect(existsSync(blocked)).toBe(true);
});

it('rotates maintenance stages and Location frontiers when an early Git inspection consumes the whole pass',async()=>{
 const {runWorkspaceSweep,runWorkspaceSweepStages,sweepWorkspaceFilePage}=await import('../src/workspaceFilePages.js');
 const locations=join(configDir,'fair-locations');await mkdir(join(locations,'a-slow'),{recursive:true});await mkdir(join(locations,'z-tail'));
 const receipt=join(configDir,'receipt-marker'),quarantine=join(configDir,'quarantine-marker');
 await writeFile(receipt,'terminal');await writeFile(quarantine,'retired');
 const reached:string[]=[],clock=Date.now;let now=clock();
 Date.now=()=>now;
 try{
  const pass=()=>runWorkspaceSweep(()=>runWorkspaceSweepStages('fault-acceptance',[
   ()=>sweepWorkspaceFilePage(locations,'fault-locations',async location=>{
    expect(git(['rev-parse','--is-inside-work-tree'])).toBe('true');
    reached.push(location);
    if(location==='a-slow')now+=3000;
   },()=>{}),
   ()=>rm(receipt,{force:true}),
   ()=>rm(quarantine,{force:true}),
  ]));
  await pass();expect(reached).toEqual(['a-slow']);expect(existsSync(receipt)).toBe(true);
  await pass();
  expect(reached).toContain('z-tail');expect(existsSync(receipt)).toBe(false);expect(existsSync(quarantine)).toBe(false);
 }finally{Date.now=clock;}
});

it('freezes an initial epoch-less candidate at zero instead of allowing a later epoch upgrade',async()=>{
 const ref={id:randomUUID(),generation:1,integration_id:randomUUID()},key=workspaceWorktreeKey(ref);
 const {admitMaterialization}=await import('../src/workspaceRetention.js');
 await admitMaterialization('folder-1',key,ref);
 expect(JSON.parse(await readFile(join(configDir,'workspace-materializations','folder-1',key+'.json'),'utf8'))).toMatchObject({epoch:0,admitted:0});
 await expect(admitMaterialization('folder-1',key,{...ref,materialization_epoch:1})).rejects.toThrow('workspace_materialization_stale');
});
