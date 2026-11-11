import {randomUUID} from 'node:crypto';
import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {HostServerFrameOf} from '@rainver/protocol';
import {runLocationGit} from '@rainver/folder-read';
import {configDir} from './config.js';
import {writeJsonDurable} from './durableFile.js';
import {tryGateLocations} from './locationLease.js';
import {workspaceGitDirectory,workspacePathLeaseKeys} from './readOnlyWorkspace.js';
import {repositoryLeaseKey} from './repositoryGate.js';
import {admitRepositories,alignedStateIs,untrackedFiles,branchAlignFail as fail,branchAlignJournalPath as journalPath,checkoutMatches,commitOf,fingerprintOf,gitOperationInProgress,isQuarantined,journalEnvelopeValid,loadJournal,ownJournal,quarantineRecordOf,quarantineRepository,recordedStateIs,releaseQuarantine,submodulePopulated,untrackedBaseline,
 type BranchAlignJournal as Journal,type BranchAlignMeaning,type BranchAlignReply} from './branchAlignState.js';
import {checkLocationRepository,listWorktrees,locationWorktreesInUse,withTaskHeld,WORKTREE_TIMEOUT_MS} from './taskWorktree.js';

type Frame=HostServerFrameOf<'git_branch_align'>;
export type {BranchAlignMeaning,BranchAlignReply} from './branchAlignState.js';
/** The Host's configured Locations, so every Location of one Git directory is gated together. */
export interface BranchAlignContext {workspaces?:Record<string,string>}
type Done=(answer:BranchAlignReply,holder:string|null)=>Promise<BranchAlignReply>;

/** Test seams at the points where another writer could interleave; unset in production. */
export const branchAlignBarriers:{beforeTransaction?:()=>Promise<void>;beforeWorktree?:()=>Promise<void>;afterGate?:()=>Promise<void>}={};

/**
 * Person-authorized alignment of one local branch to another (hosts.md,
 * "Controlled Git publication"). It never pushes and never touches a
 * Rainver-managed branch. From its first check to its durable answer it holds
 * the gate of every Location of the repository and the repository's Git
 * directory and path lease keys, so no Run, worktree operation, publication or
 * host command of the repository starts beside it; it refuses to start while
 * any of them is live. A source checked out more than once, or with any change
 * or unfinished Git operation, is refused. The move is one Git ref
 * transaction (create the backup, verify the target at its expected tip,
 * update the source from its expected tip); Git holds both ref locks until it
 * commits, so a target that moved forward or back fails the whole move.
 */
export async function executeGitBranchAlign(locationRoot:string|null,frame:Frame,context:BranchAlignContext={}):Promise<BranchAlignReply>{
 const {request_id:_,...meaning}=frame;
 return alignUnderGate(locationRoot,meaning,context,false);
}

async function alignUnderGate(locationRoot:string|null,meaning:BranchAlignMeaning,context:BranchAlignContext,startup:boolean):Promise<BranchAlignReply>{
 if(!locationRoot)return fail('workspace_branch_align_location_unavailable');
 const locationId=meaning.workspace.workspace_location_id;
 for(const ref of [meaning.source_ref,meaning.target_ref])if(ref.startsWith('refs/heads/rainver/'))return fail('workspace_branch_align_managed_branch');
 const check=await checkLocationRepository(locationRoot);
 if(check.kind!=='repository')return fail('execution_workspace_repository_unavailable');
 const root=check.repo.root;
 const commonDir=await workspaceGitDirectory(root);
 if(!commonDir)return fail('execution_workspace_repository_unavailable');
 const configured=Object.entries(context.workspaces??{});
 const roots=configured.map(([,path])=>path);
 const locations=[locationId];
 for(const [id,path] of configured)if(id!==locationId&&await workspaceGitDirectory(path)===commonDir)locations.push(id);
 // The repository key is the gate every start path of this repository joins
 // shared, whichever Location (registered now or later) it came through
 // (`repositoryGate.ts`); Location gates and path keys only refine it.
 const keys=[repositoryLeaseKey(commonDir),`workspace-git:${commonDir}`,...(await listWorktrees(root)).flatMap(w=>workspacePathLeaseKeys(w.path,roots))];
 // Busy check, gate and keys in one synchronous step: nothing starts in between.
 const release=tryGateLocations(locations,keys,`branch-align:${randomUUID()}`,()=>locations.some(locationWorktreesInUse));
 if(!release)return fail('location_busy');
 try{
  await branchAlignBarriers.afterGate?.();
  const answer=await withTaskHeld(`branch-align:${locationId}`,()=>alignGated(root,commonDir,meaning,startup))??fail('location_busy');
  // Settled while the gate is still held. A throw anywhere above skips this:
  // the quarantine recorded before the first side effect then stays.
  await settle(commonDir,meaning,answer);
  return answer;
 }finally{release();}
}

/**
 * The one exit of the isolation state machine. The repository's quarantine
 * was made durable before the operation could change a ref or checkout; it is
 * lifted only when the answer is durably recorded and the repository is
 * proven to be what that answer says — untouched (no backup ref, source at
 * its old tip), or source, symbolic HEAD, index, tracked files and submodules
 * exactly at the answered commit with no untracked file outside the recorded
 * baseline. "Durably recorded" is re-established here, not assumed from a
 * visible `done`: `loadJournal` syncs the journal and its directory chain
 * again, and a failure throws with the isolation kept. `recovery_required`
 * always (re)isolates.
 */
async function settle(commonDir:string,meaning:BranchAlignMeaning,answer:BranchAlignReply){
 // Another repository's journal or record: nothing of this repository is
 // isolated or released by it (the old repository keeps its own record).
 const own=await ownJournal(meaning,commonDir);
 if(own.refusal)return;
 const record={common_dir:commonDir,location_id:meaning.workspace.workspace_location_id,operation_id:meaning.operation_id,meaning,reason:answer.error??'settling'};
 if(answer.error==='workspace_branch_align_recovery_required'){await quarantineRepository(record);return;}
 if(!await isQuarantined(meaning.operation_id))return;
 const journal=own.journal;
 if(journal?.state!=='done')return;
 const backup=await commitOf(commonDir,backupRefOf(meaning));
 const untouched=backup===null&&await commitOf(commonDir,meaning.source_ref)===meaning.expected_source_commit;
 const expected=answer.ok?meaning.expected_target_commit:meaning.expected_source_commit;
 if(untouched||await recordedStateIs(commonDir,meaning.source_ref,expected,journal))await releaseQuarantine(meaning.operation_id);
}

const backupRefOf=(meaning:BranchAlignMeaning)=>`refs/rainver/branch-backups/${meaning.operation_id}`;

async function alignGated(root:string,commonDir:string,meaning:BranchAlignMeaning,startup:boolean):Promise<BranchAlignReply>{
 for(const ref of [meaning.source_ref,meaning.target_ref])
  if((await runLocationGit(['check-ref-format',ref],root)).code!==0)return fail('workspace_branch_align_invalid_ref');
 if(meaning.source_ref===meaning.target_ref)return fail('workspace_branch_align_same_branch');
 const path=journalPath(meaning.workspace.workspace_location_id,meaning.operation_id);
 const fingerprint=fingerprintOf(meaning);
 // Every journal read is the one trust check (`ownJournal`): durable again
 // before use, and this meaning's record in this repository. A `done` is
 // replayed, and an intent continued, only then; a Location that now resolves
 // to another repository acts on neither.
 let own=await ownJournal(meaning,commonDir);
 if(own.refusal)return fail(own.refusal);
 let journal=own.journal;
 if(journal?.state==='done'&&journal.answer)return journal.answer;
 // A repository quarantined by another operation takes no new alignment
 // until it is proven consistent; this operation's own record is what this
 // run settles. Admission may close this journal from facts: read it again.
 if(!startup){
  const refused=await admitRepositories([commonDir],meaning.operation_id);if(refused)return fail(refused);
  own=await ownJournal(meaning,commonDir);if(own.refusal)return fail(own.refusal);
  journal=own.journal;
  if(journal?.state==='done'&&journal.answer)return journal.answer;
 }
 const previous=meaning.expected_source_commit,target=meaning.expected_target_commit;
 const backupRef=backupRefOf(meaning);
 const tip=(ref:string)=>commitOf(root,ref);
 // The recorded untracked baseline, carried into every later journal state
 // (including a `done` written before the checkout step of a redelivery).
 let snapshot:string[]|undefined=journal?.untracked;
 const done:Done=async(answer,holder)=>{await writeJsonDurable(path,{fingerprint,meaning,state:'done',holder,common_dir:commonDir,answer,...(snapshot?{untracked:snapshot}:{})} satisfies Journal);return answer;};
 const holders=(await listWorktrees(root)).filter(w=>w.branch===meaning.source_ref);
 if(holders.length>1)return journal?done(fail('workspace_branch_align_recovery_required'),journal.holder):fail('workspace_branch_align_checked_out_multiple');
 const holder=holders[0]?.path??null;
 if(journal?.state==='rollback'){snapshot=journal.untracked??[];return rollback(root,meaning,journal.holder,snapshot,done);}
 let committed=await tip(backupRef);
 if(journal&&committed&&committed!==previous)return done(fail('workspace_branch_align_recovery_required'),journal.holder);
 if(!journal||!committed){
  // No transaction of this operation committed. At Host start an unfinished
  // intent is closed without acting: the control plane may have given up on it.
  if(startup)return done(fail('workspace_branch_align_interrupted'),journal?.holder??holder);
  const source=await tip(meaning.source_ref),targetNow=await tip(meaning.target_ref);
  if(!source)return fail('workspace_branch_align_source_missing');
  if(!targetNow)return fail('workspace_branch_align_target_missing');
  if(targetNow!==target)return fail('workspace_branch_align_target_moved');
  if(!journal&&source===target&&source===previous)
   return done({ok:true,error:null,outcome:'already_aligned',previous_commit:source,aligned_commit:source,backup_ref:null,worktree_updated:false},holder);
  if(source!==previous)return fail('workspace_branch_align_source_moved');
  if(meaning.mode==='fast_forward'&&(await runLocationGit(['merge-base','--is-ancestor',source,target],root)).code!==0)return fail('workspace_branch_align_not_fast_forward');
  if(holder){const refused=await holderRefusal(holder,meaning.source_ref,source)??await submoduleRefusal(holder,previous,target)??await overwriteRefusal(holder,previous,target);if(refused)return fail(refused);}
  // The person's untracked baseline, taken before any side effect and
  // recorded with the intent; it is reused, never retaken, by every later
  // attempt (a retake after a partial checkout would adopt its leftovers).
  const baseline=holder?await untrackedBaseline(holder):[];
  if(baseline===null)return fail('workspace_branch_align_status_failed');
  snapshot=baseline;
  // Isolation first, then intent, then the only side effects: from here any
  // throw, lost Git result or crash leaves the repository refusing new work.
  await quarantineRepository({common_dir:commonDir,location_id:meaning.workspace.workspace_location_id,operation_id:meaning.operation_id,meaning,reason:'in_progress'});
  await writeJsonDurable(path,{fingerprint,meaning,state:'intent',holder,common_dir:commonDir,untracked:baseline} satisfies Journal);
  await branchAlignBarriers.beforeTransaction?.();
  const moved=await branchAlignGit.updateRef(root,`start\ncreate ${backupRef} ${previous}\nverify ${meaning.target_ref} ${target}\nupdate ${meaning.source_ref} ${target} ${previous}\nprepare\ncommit\n`,
   `rainver: align ${meaning.source_ref.slice(11)} to ${meaning.target_ref.slice(11)}`);
  // An exit code is not proof: the transaction may have committed and its
  // result been lost. The backup ref, created only by that transaction, is.
  committed=await tip(backupRef);
  if(!committed){
   // Nothing moved. The answer is final, so a redelivery cannot move it later.
   const why=await tip(meaning.target_ref)!==target?'workspace_branch_align_target_moved'
    :await tip(meaning.source_ref)!==previous?'workspace_branch_align_source_moved':'workspace_branch_align_backup_failed';
   return done(fail(moved.code===0?'workspace_branch_align_backup_failed':why),holder);
  }
  if(committed!==previous)return done(fail('workspace_branch_align_recovery_required'),holder);
 }
 if(await tip(meaning.source_ref)!==target||(journal?.holder??holder)!==holder){
  // Committed, then the branch or its checkout changed outside Rainver.
  return done(fail('workspace_branch_align_recovery_required'),journal?.holder??holder);
 }
 const aligned=(updated:boolean)=>done({ok:true,error:null,outcome:'aligned',previous_commit:previous,aligned_commit:target,backup_ref:backupRef,worktree_updated:updated},holder);
 if(!holder)return aligned(false);
 await branchAlignBarriers.beforeWorktree?.();
 // Bring the checkout from the old tree to the new one, judged by its actual
 // files. Already exactly the new tree: done. Exactly the old tree (person's
 // untracked files aside): one read-tree, verified afterwards. Anything else —
 // partial, edited, mid-operation — needs a person; nothing is overwritten.
 const head=await runLocationGit(['symbolic-ref','-q','HEAD'],holder);
 if(head.code!==0||head.stdout.trim()!==meaning.source_ref)return done(fail('workspace_branch_align_recovery_required'),holder);
 // Only the recorded baseline is allowed; a journal without one allows none.
 const untracked=snapshot??=[];
 // The checkout could not follow: the branch is put back by CAS so HEAD never
 // names a commit whose files are not checked out.
 const putBack=async()=>{
  await writeJsonDurable(path,{fingerprint,meaning,state:'rollback',holder,common_dir:commonDir,untracked} satisfies Journal);
  return rollback(root,meaning,holder,untracked,done);
 };
 if(await checkoutMatches(holder,target,untracked))return aligned(true);
 if(!await checkoutMatches(holder,previous,untracked)){
  // Tracked files still exactly old, but untracked files outside the
  // baseline appeared: never read-tree over them, never adopt them. The ref
  // goes back; the answer needs a person until they are moved (kept as is).
  const extra=await untrackedFiles(holder);
  if(extra!==null&&await checkoutMatches(holder,previous,[...untracked,...extra]))return putBack();
  return done(fail('workspace_branch_align_recovery_required'),holder);
 }
 // Checked again at the last moment: a file placed since (ignored ones too) is never overwritten.
 if(await overwriteRefusal(holder,previous,target))return putBack();
 const update=await branchAlignGit.readTree(holder,previous,target);
 if(update.code===0){
  await runLocationGit(['update-index','-q','--refresh'],holder);
  return await checkoutMatches(holder,target,untracked)?aligned(true):done(fail('workspace_branch_align_recovery_required'),holder);
 }
 return putBack();
}

/** The Git steps that change refs or files; replaceable in tests to inject failures. */
export const branchAlignGit={
 updateRef:(root:string,input:string,message:string)=>runLocationGit(['update-ref','-m',message,'--stdin'],root,30_000,{input}),
 readTree:(holder:string,from:string,to:string)=>runLocationGit(['read-tree','-m','-u',from,to],holder,WORKTREE_TIMEOUT_MS),
};
const defaultGit={...branchAlignGit};
/** Tests only. */
export function resetBranchAlignGitForTest(){Object.assign(branchAlignGit,defaultGit);}

/**
 * Puts the source back only by CAS from the aligned tip, so a commit made on
 * it since is never overwritten. Restored cleanly — branch, symbolic HEAD,
 * index and tracked files at the old commit, no new untracked leftovers — it
 * is an ordinary refusal; anything else needs a person, with the backup ref kept.
 */
async function rollback(root:string,meaning:BranchAlignMeaning,holder:string|null,untracked:readonly string[],done:Done){
 const previous=meaning.expected_source_commit,target=meaning.expected_target_commit;
 if(await commitOf(root,meaning.source_ref)===target)
  await runLocationGit(['update-ref','-m','rainver: branch alignment restored',meaning.source_ref,previous,target],root);
 const commonDir=await workspaceGitDirectory(root);
 const restored=Boolean(commonDir)&&await commitOf(root,meaning.source_ref)===previous
  &&await alignedStateIs(commonDir!,meaning.source_ref,previous,holder,untracked);
 return done({...fail(restored?'workspace_branch_align_worktree_update_failed':'workspace_branch_align_recovery_required'),backup_ref:backupRefOf(meaning)},holder);
}

/**
 * At Host start, before any Run is accepted, closes every unfinished alignment
 * from Git facts under the same gate: one whose transaction committed is
 * finished or put back, one that never committed is answered as interrupted.
 * A redelivery then reads the recorded answer. Each repository is isolated on
 * its own: its quarantine is durable *before* recovery is attempted and is
 * lifted only by the same settlement as a live alignment, so a recovery that
 * throws, cannot reach its Location, or ends needing a person (and a crash
 * meanwhile) keeps that repository — and only it — refusing new work across
 * restarts until `admitRepositories` proves it consistent.
 */
export async function recoverBranchAlignments(rootOf:(meaning:BranchAlignMeaning)=>Promise<string|null>,context:BranchAlignContext={},log:(line:string)=>void=()=>{}):Promise<void>{
 const base=join(configDir(),'branch-align');
 for(const location of await readdir(base).catch(()=>[] as string[])){
  for(const name of await readdir(join(base,location)).catch(()=>[] as string[])){
   if(!name.endsWith('.json'))continue;
   try{
    // Durable before it is trusted, like every other journal read.
    const journal=await loadJournal(join(base,location,name));
    if(!journal||journal.state==='done')continue;
    // No frame names this operation: the journal is trusted only through its
    // envelope (the Location directory and operation file name it was found
    // at, its fingerprint, its repository) and the operation's own quarantine
    // record, never through what it says about itself alone.
    if(!journalEnvelopeValid(journal,location,name)){log(`branch align recovery ${location}/${name}: journal identity does not match its path; not acted on`);continue;}
    const meaning=journal.meaning,commonDir=journal.common_dir,record=await quarantineRecordOf(meaning.operation_id);
    if(record&&(record.common_dir!==commonDir||fingerprintOf(record.meaning)!==journal.fingerprint)){log(`branch align recovery ${meaning.operation_id}: journal and quarantine record name different repositories; left isolated`);continue;}
    // The configured Location must still be this repository: one that now
    // resolves elsewhere is never recovered there. The journal's repository
    // stays isolated until admission proves it (also when its Location cannot
    // be reached); only a journal without a record whose Location now names
    // another repository is contradicted by the configuration and isolates
    // nothing.
    const root=await rootOf(meaning).catch(()=>null);
    const current=root?await workspaceGitDirectory(root):null;
    if(!record&&current&&current!==commonDir){log(`branch align recovery ${meaning.operation_id}: journal not corroborated by a quarantine record or the configured Location; not acted on`);continue;}
    await quarantineRepository({common_dir:commonDir,location_id:meaning.workspace.workspace_location_id,operation_id:meaning.operation_id,meaning,reason:'recovery_pending'});
    if(current!==commonDir){log(`branch align recovery ${meaning.operation_id}: Location no longer resolves to the journal's repository; left unfinished (repository isolated)`);continue;}
    const answer=await alignUnderGate(root,meaning,context,true);
    const isolated=await isQuarantined(meaning.operation_id);
    log(`branch align recovery ${meaning.operation_id}: ${answer.ok?answer.outcome:answer.error}${isolated?' (repository isolated)':''}`);
   }catch(error){log(`branch align recovery ${location}/${name} failed: ${error instanceof Error?error.message:String(error)} (repository isolated)`);}
  }
 }
}

/** The paths `from`→`to` changes, with their status and modes (`diff-tree -r`, gitlinks not entered); null when Git cannot list them. */
async function moveEntries(holder:string,from:string,to:string):Promise<Array<{path:string;status:string;oldMode:string;newMode:string}>|null>{
 const diff=await runLocationGit(['diff-tree','-r','-z','--no-renames',from,to],holder);
 if(diff.code!==0)return null;
 const entries=[],fields=diff.stdout.split('\0');
 for(let i=0;i+1<fields.length;i++){
  const meta=fields[i]!;
  if(!meta.startsWith(':'))continue;
  const [oldMode='',newMode='']=meta.slice(1).split(' ');
  entries.push({path:fields[++i]!,status:meta.slice(-1),oldMode,newMode});
 }
 return entries;
}

/**
 * Alignment does not update, initialize or clean submodules: a gitlink the
 * move would change (added, removed or moved) at a populated submodule of the
 * checkout is refused before any side effect, since read-tree would move the
 * index and leave the submodule at its old commit. Unpopulated submodules (an
 * empty directory) follow as Git leaves them. A changed path the checkout
 * keeps outside its working tree (skip-worktree, a sparse checkout) is refused
 * too: read-tree would move its index entry and leave no file to verify.
 */
async function submoduleRefusal(holder:string,from:string,to:string):Promise<string|null>{
 const entries=await moveEntries(holder,from,to);
 if(!entries)return 'workspace_branch_align_status_failed';
 for(const {path,oldMode,newMode} of entries)
  if((oldMode==='160000'||newMode==='160000')&&await submodulePopulated(holder,path))return 'workspace_branch_align_submodule_unsupported';
 const flags=await runLocationGit(['ls-files','-v','-z'],holder,120_000);
 if(flags.code!==0)return 'workspace_branch_align_status_failed';
 const changed=new Set(entries.map(e=>e.path));
 for(const entry of flags.stdout.split('\0'))
  if((entry.startsWith('S ')||entry.startsWith('s '))&&changed.has(entry.slice(2)))return 'workspace_branch_align_sparse_unsupported';
 return null;
}

/**
 * Git's read-tree treats ignored files as expendable and overwrites them. A
 * path the move adds where the checkout already has something untracked (an
 * ignored file, a symlink, a file standing where the new path needs a
 * directory) is refused, so a person's file is never replaced. A directory
 * standing where the move adds a file is in the way only for what it holds
 * beyond the tracked paths this same move removes: a clean tracked directory
 * becomes the file (Git removes exactly those), while any other file below it
 * — untracked, ignored or a symlink not tracked there — refuses the move.
 * Entries are compared by their exact relative path, never by name prefix.
 */
async function overwriteRefusal(holder:string,from:string,to:string):Promise<string|null>{
 const entries=await moveEntries(holder,from,to);
 if(!entries)return 'workspace_branch_align_status_failed';
 const added=entries.filter(e=>e.status==='A').map(e=>e.path),removed=new Set(entries.filter(e=>e.status==='D').map(e=>e.path));
 // Only what this move removes may be below a directory it replaces.
 const onlyRemoved=async(dir:string):Promise<boolean>=>{
  for(const name of await readdir(join(holder,dir))){
   const path=`${dir}/${name}`,info=await lstat(join(holder,path));
   if(info.isDirectory()){if(!removed.has(path)&&!await onlyRemoved(path))return false;if(removed.has(path)&&(await readdir(join(holder,path))).length)return false;}
   else if(!removed.has(path))return false;
  }
  return true;
 };
 for(const path of added){
  const info=await lstat(join(holder,path)).catch(()=>null);
  if(info&&!(info.isDirectory()&&await onlyRemoved(path)))return 'workspace_branch_align_untracked_in_the_way';
  for(let cut=path.lastIndexOf('/');cut>0;cut=path.lastIndexOf('/',cut-1)){
   const parent=path.slice(0,cut),above=await lstat(join(holder,parent)).catch(()=>null);
   if(above&&!above.isDirectory()&&!removed.has(parent))return 'workspace_branch_align_untracked_in_the_way';
  }
 }
 return null;
}

/**
 * A checked-out source must be exactly its tip, with no change of any kind —
 * judged by its files as well as by `status`, so an assume-unchanged or
 * skip-worktree bit or a stale stat cache cannot hide an edited file or a
 * moved submodule before the first side effect.
 */
async function holderRefusal(holder:string,ref:string,tip:string):Promise<string|null>{
 const head=await runLocationGit(['symbolic-ref','-q','HEAD'],holder);
 if(head.code!==0||head.stdout.trim()!==ref)return 'workspace_branch_align_worktree_changed';
 if((await runLocationGit(['rev-parse','HEAD'],holder)).stdout.trim()!==tip)return 'workspace_branch_align_source_moved';
 if(await gitOperationInProgress(holder))return 'workspace_branch_align_operation_in_progress';
 const status=await runLocationGit(['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none'],holder);
 if(status.code!==0)return 'workspace_branch_align_status_failed';
 if(status.stdout.length||!await checkoutMatches(holder,tip))return 'workspace_branch_align_worktree_dirty';
 return null;
}
