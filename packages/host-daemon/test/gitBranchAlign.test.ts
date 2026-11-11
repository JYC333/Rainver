import {mkdtemp,mkdir,writeFile,rm,realpath,readFile} from 'node:fs/promises';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {branchAlignBarriers,executeGitBranchAlign,recoverBranchAlignments} from '../src/gitBranchAlign.js';
import {writeJsonDurable} from '../src/durableFile.js';
import {resetQuarantineCacheForTest} from '../src/branchAlignState.js';
import {acquireLocationLeases,enterLocations,releaseLocationLeases,tryAcquireLease} from '../src/locationLease.js';
import {taskLeaseKey} from '../src/taskWorktree.js';
import type {HostServerFrameOf} from '@rainver/protocol';

let sandbox:string,root:string,config:string;
const location='folder-align';
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
/** The repository's canonical Git common directory, as the Host's journals name it. */
const commonDir=()=>realpathSync(git('rev-parse','--path-format=absolute','--git-common-dir'));
async function commit(file:string,text:string,message:string){await writeFile(join(root,file),text);git('add',file);git('commit','-qm',message);return git('rev-parse','HEAD');}
/** master gained a reviewed chain; dev still holds the old, rewritten history. */
async function init(){
 git('init','-q','-b','master');git('config','user.name','Person');git('config','user.email','person@example.test');
 const first=await commit('a.txt','a\n','initial');
 git('checkout','-q','-b','dev');const old=await commit('old.txt','old\n','old dev work');
 git('checkout','-q','master');await commit('b.txt','b\n','reviewed 1');const tip=await commit('c.txt','c\n','reviewed 2');
 return {first,old,tip};
}
function frame(extra:Partial<HostServerFrameOf<'git_branch_align'>>):HostServerFrameOf<'git_branch_align'>{
 return {type:'git_branch_align',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:location},source_ref:'refs/heads/dev',target_ref:'refs/heads/master',mode:'reset',expected_source_commit:'0'.repeat(40),expected_target_commit:'0'.repeat(40),...extra};
}
beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-align-')));root=join(sandbox,'repo');config=join(sandbox,'host');await mkdir(root);await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;
 await saveConfig({server_url:'http://localhost:1',host_id:'host',trust:'trusted',token:'test',workspaces:{[location]:root}});
});
afterEach(async()=>{resetQuarantineCacheForTest();delete branchAlignBarriers.beforeTransaction;delete branchAlignBarriers.beforeWorktree;delete process.env.RAINVER_HOST_CONFIG_DIR;await rm(sandbox,{recursive:true,force:true});});

it('resets an unchecked-out source by CAS, keeps a recovery ref and replays the same operation',async()=>{
 const {old,tip}=await init();
 const request=frame({expected_source_commit:old,expected_target_commit:tip});
 const done=await executeGitBranchAlign(root,request);
 expect(done).toMatchObject({ok:true,outcome:'aligned',previous_commit:old,aligned_commit:tip,backup_ref:`refs/rainver/branch-backups/${request.operation_id}`,worktree_updated:false});
 expect(git('rev-parse','dev')).toBe(tip);expect(git('rev-parse',done.backup_ref!)).toBe(old);
 // A lost reply is answered from the durable journal without moving anything again.
 git('update-ref','refs/heads/dev',old,tip);
 expect(await executeGitBranchAlign(root,{...request,request_id:randomUUID()})).toEqual(done);
 expect(git('rev-parse','dev')).toBe(old);
 expect(await executeGitBranchAlign(root,{...request,mode:'fast_forward'})).toMatchObject({ok:false,error:'workspace_branch_align_request_changed'});
});

it('refuses non-fast-forward, moved tips, managed or invalid refs',async()=>{
 const {first,old,tip}=await init();
 expect(await executeGitBranchAlign(root,frame({mode:'fast_forward',expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_not_fast_forward'});
 expect(await executeGitBranchAlign(root,frame({expected_source_commit:first,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_source_moved'});
 expect(await executeGitBranchAlign(root,frame({expected_source_commit:old,expected_target_commit:first}))).toMatchObject({ok:false,error:'workspace_branch_align_target_moved'});
 expect(await executeGitBranchAlign(root,frame({source_ref:'refs/heads/rainver/workspace-x-g1',expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_managed_branch'});
 expect(await executeGitBranchAlign(root,frame({source_ref:'refs/heads/dev.lock',expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_invalid_ref'});
 expect(git('rev-parse','dev')).toBe(old);
 git('branch','behind',first);
 expect(await executeGitBranchAlign(root,frame({source_ref:'refs/heads/behind',mode:'fast_forward',expected_source_commit:first,expected_target_commit:tip}))).toMatchObject({ok:true,outcome:'aligned'});
});

it('updates a clean checked-out source and refuses dirty, untracked or in-progress checkouts',async()=>{
 const {old,tip}=await init();git('checkout','-q','dev');
 await writeFile(join(root,'untracked.txt'),'mine\n');
 expect(await executeGitBranchAlign(root,frame({expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_worktree_dirty'});
 await rm(join(root,'untracked.txt'));await writeFile(join(root,'old.txt'),'edited\n');
 expect(await executeGitBranchAlign(root,frame({expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_worktree_dirty'});
 git('checkout','--','old.txt');
 await writeFile(join(root,'.git','MERGE_HEAD'),`${tip}\n`);
 expect(await executeGitBranchAlign(root,frame({expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_operation_in_progress'});
 await rm(join(root,'.git','MERGE_HEAD'));
 expect(git('rev-parse','dev')).toBe(old);
 const done=await executeGitBranchAlign(root,frame({expected_source_commit:old,expected_target_commit:tip}));
 expect(done).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(git('rev-parse','HEAD')).toBe(tip);expect(git('status','--porcelain')).toBe('');
 expect(await readFile(join(root,'c.txt'),'utf8')).toBe('c\n');
});

it('refuses while a Rainver lease of the Location is held or the source is checked out twice',async()=>{
 const {old,tip}=await init();
 const lease=taskLeaseKey(location,'workspace:00000000-0000-4000-8000-000000000001:1');
 await acquireLocationLeases([lease],{runId:'run-x',launchId:'launch-x'},()=>{throw new Error('unexpected queue');});
 try{expect(await executeGitBranchAlign(root,frame({expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'location_busy'});}
 finally{releaseLocationLeases([lease],'launch-x');}
 git('worktree','add','-q',join(sandbox,'second'),'dev');
 git('checkout','-q','--detach');
 execFileSync('git',['worktree','add','-q','-f',join(sandbox,'third'),'dev'],{cwd:root});
 expect(await executeGitBranchAlign(root,frame({expected_source_commit:old,expected_target_commit:tip}))).toMatchObject({ok:false,error:'workspace_branch_align_checked_out_multiple'});
 expect(git('rev-parse','dev')).toBe(old);
});

it('finishes from Git facts after a crash between the backup and the reply',async()=>{
 const {old,tip}=await init();
 const request=frame({expected_source_commit:old,expected_target_commit:tip});
 const backup=`refs/rainver/branch-backups/${request.operation_id}`;
 const {request_id:_,...meaning}=request;
 // The durable intent and backup exist; the branch already moved; the reply was lost.
 git('update-ref',backup,old);git('update-ref','refs/heads/dev',tip,old);
 await writeJsonDurable(join(config,'branch-align',location,`${request.operation_id}.json`),{fingerprint:JSON.stringify(meaning),meaning,state:'intent',holder:null,common_dir:commonDir()});
 expect(await executeGitBranchAlign(root,request)).toMatchObject({ok:true,outcome:'aligned',previous_commit:old,aligned_commit:tip,backup_ref:backup});
 // Moved by someone else in between: facts changed, nothing is overwritten.
 const other=frame({expected_source_commit:tip,expected_target_commit:tip});
 expect(await executeGitBranchAlign(root,other)).toMatchObject({ok:true,outcome:'already_aligned'});
});

const journalOf=(request:HostServerFrameOf<'git_branch_align'>)=>join(config,'branch-align',location,`${request.operation_id}.json`);
const missing=(ref:string)=>{try{git('rev-parse','--verify','--quiet',ref);return false;}catch{return true;}};

it('verifies the target inside the same ref transaction: a move forward or back after the checks fails the whole move',async()=>{
 const {first,old,tip}=await init();
 for(const moveTo of ['forward','back'] as const){
  const request=frame({expected_source_commit:old,expected_target_commit:tip});
  let next=tip;
  // Exactly between the last read of the target and the transaction.
  branchAlignBarriers.beforeTransaction=async()=>{
   next=moveTo==='forward'?execFileSync('git',['commit-tree','-p',tip,'-m','later',`${tip}^{tree}`],{cwd:root,encoding:'utf8'}).trim():first;
   git('update-ref','refs/heads/master',next,tip);
  };
  expect(await executeGitBranchAlign(root,request)).toMatchObject({ok:false,error:'workspace_branch_align_target_moved'});
  expect(git('rev-parse','dev')).toBe(old);
  expect(missing(`refs/rainver/branch-backups/${request.operation_id}`)).toBe(true);
  // The failure is final for this operation: a redelivery after the target
  // came back does not move the branch.
  delete branchAlignBarriers.beforeTransaction;
  git('update-ref','refs/heads/master',tip,next);
  expect(await executeGitBranchAlign(root,{...request,request_id:randomUUID()})).toMatchObject({ok:false,error:'workspace_branch_align_target_moved'});
  expect(git('rev-parse','dev')).toBe(old);
 }
});

it('holds the Location gate from the checks to the answer: launches, worktree holders and host commands wait or are refused',async()=>{
 const {old,tip}=await init();
 const task=taskLeaseKey(location,'workspace:00000000-0000-4000-8000-000000000002:1');
 const request=frame({expected_source_commit:old,expected_target_commit:tip});
 // What each waiter sees when it is let in: the branch and the durable answer.
 const seen=()=>`${git('rev-parse','dev')}:${JSON.parse(readFileSync(journalOf(request),'utf8')).state}`;
 const order:string[]=[];
 let launches:Promise<unknown>[]=[];
 branchAlignBarriers.beforeTransaction=async()=>{
  expect(tryAcquireLease(task,'maintenance-x')).toBe(false);
  expect(tryAcquireLease(location,'merge-x')).toBe(false);
  let queued=0;
  launches=[
   acquireLocationLeases([location],{runId:'run-a',launchId:'launch-a'},()=>{queued+=1;}).then(o=>{order.push(`root:${o}:${seen()}`);releaseLocationLeases([location],'launch-a');}),
   acquireLocationLeases([task],{runId:'run-b',launchId:'launch-b'},()=>{queued+=1;}).then(o=>{order.push(`task:${o}:${seen()}`);releaseLocationLeases([task],'launch-b');}),
   enterLocations([location]).then(leave=>{order.push(`command:${seen()}`);leave();}),
  ];
  await new Promise(r=>setTimeout(r,50));
  expect(queued).toBe(2);
  order.push('aligning');
 };
 expect(await executeGitBranchAlign(root,request)).toMatchObject({ok:true,outcome:'aligned'});
 await Promise.all(launches);
 expect(order[0]).toBe('aligning');
 expect(order.slice(1).sort()).toEqual([`command:${tip}:done`,`root:acquired:${tip}:done`,`task:acquired:${tip}:done`]);
 // A host command already inside the Location keeps a new alignment out.
 const leave=await enterLocations([location]);
 try{expect(await executeGitBranchAlign(root,frame({expected_source_commit:tip,expected_target_commit:old}))).toMatchObject({ok:false,error:'location_busy'});}
 finally{leave();}
});

it('puts the branch back by CAS when its checkout cannot follow, and never over a newer commit',async()=>{
 const {old,tip}=await init();git('checkout','-q','dev');
 const blocked=frame({expected_source_commit:old,expected_target_commit:tip});
 // The person's ignored file is where the new tree adds a file (read-tree would overwrite it): refused before any side effect.
 await writeFile(join(root,'.git','info','exclude'),'c.txt\n');await writeFile(join(root,'c.txt'),'mine\n');
 expect(await executeGitBranchAlign(root,blocked)).toMatchObject({ok:false,error:'workspace_branch_align_untracked_in_the_way',backup_ref:null});
 expect(git('rev-parse','dev')).toBe(old);expect(git('rev-parse','HEAD')).toBe(old);
 expect(git('for-each-ref','refs/rainver/')).toBe('');
 // The same ignored file placed after the checks: the branch goes back by CAS, the file is untouched, an ordinary refusal.
 await rm(join(root,'c.txt'));
 const placed=frame({expected_source_commit:old,expected_target_commit:tip});
 branchAlignBarriers.beforeWorktree=async()=>{await writeFile(join(root,'c.txt'),'mine\n');};
 expect(await executeGitBranchAlign(root,placed)).toMatchObject({ok:false,error:'workspace_branch_align_worktree_update_failed',backup_ref:`refs/rainver/branch-backups/${placed.operation_id}`});
 expect(git('rev-parse','dev')).toBe(old);expect(git('rev-parse','HEAD')).toBe(old);
 expect(await readFile(join(root,'c.txt'),'utf8')).toBe('mine\n');
 await rm(join(root,'c.txt'));await writeFile(join(root,'.git','info','exclude'),'');
 // An untracked file outside the baseline appears after the checks: the branch goes back by CAS, the file is kept, a person is needed.
 const late=frame({expected_source_commit:old,expected_target_commit:tip});
 branchAlignBarriers.beforeWorktree=async()=>{await writeFile(join(root,'c.txt'),'mine\n');};
 expect(await executeGitBranchAlign(root,late)).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required',backup_ref:`refs/rainver/branch-backups/${late.operation_id}`});
 expect(git('rev-parse','dev')).toBe(old);expect(await readFile(join(root,'c.txt'),'utf8')).toBe('mine\n');
 await rm(join(root,'c.txt'));
 // Someone commits on the moved branch before the checkout step: no rollback overwrites it.
 const raced=frame({expected_source_commit:old,expected_target_commit:tip});
 let newer='';
 branchAlignBarriers.beforeWorktree=async()=>{
  newer=execFileSync('git',['commit-tree','-p',tip,'-m','newer',`${tip}^{tree}`],{cwd:root,encoding:'utf8'}).trim();
  git('update-ref','refs/heads/dev',newer,tip);
  await writeFile(join(root,'c.txt'),'mine\n');
 };
 expect(await executeGitBranchAlign(root,raced)).toMatchObject({ok:false,error:'workspace_branch_align_recovery_required'});
 expect(git('rev-parse','dev')).toBe(newer);
 expect(git('rev-parse',`refs/rainver/branch-backups/${raced.operation_id}`)).toBe(old);
});

it('closes unfinished alignments at Host start from Git facts and answers redeliveries from the journal',async()=>{
 const {old,tip}=await init();git('checkout','-q','dev');
 const committed=frame({expected_source_commit:old,expected_target_commit:tip});
 const {request_id:_a,...meaning}=committed;
 // Crash after the ref transaction, before the checkout followed: HEAD names tip, files are old.
 git('update-ref',`refs/rainver/branch-backups/${committed.operation_id}`,old);git('update-ref','refs/heads/dev',tip,old);
 await writeJsonDurable(journalOf(committed),{fingerprint:JSON.stringify(meaning),meaning,state:'intent',holder:root,common_dir:commonDir()});
 const pending=frame({expected_source_commit:tip,expected_target_commit:old});
 const {request_id:_b,...other}=pending;
 // Crash after the intent, before any transaction: closed without acting.
 await mkdir(join(config,'branch-align',location),{recursive:true});
 await writeJsonDurable(journalOf(pending),{fingerprint:JSON.stringify(other),meaning:other,state:'intent',holder:root,common_dir:commonDir()});
 await recoverBranchAlignments(async()=>root);
 expect(git('rev-parse','dev')).toBe(tip);expect(git('status','--porcelain')).toBe('');
 expect(await readFile(join(root,'c.txt'),'utf8')).toBe('c\n');
 expect(await executeGitBranchAlign(root,committed)).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await executeGitBranchAlign(root,pending)).toMatchObject({ok:false,error:'workspace_branch_align_interrupted'});
 expect(git('rev-parse','dev')).toBe(tip);
 expect(JSON.parse(await readFile(journalOf(pending),'utf8')).state).toBe('done');
});
