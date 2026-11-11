import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {lstat,mkdtemp,readdir,readFile,readlink,rm,stat} from 'node:fs/promises';
import type {HostDaemonFrameOf,HostServerFrameOf} from '@rainver/protocol';
import {runLocationGit} from '@rainver/folder-read';
import {configDir} from './config.js';
import {removeDurable,syncExistingDurable,writeJsonDurable} from './durableFile.js';

type Frame=HostServerFrameOf<'git_branch_align'>;
export type BranchAlignMeaning=Omit<Frame,'request_id'>;
export type BranchAlignReply=Omit<HostDaemonFrameOf<'git_branch_align_result'>,'type'|'request_id'>;
/**
 * `intent` is durable before the one ref transaction that creates the backup,
 * verifies the target and moves the source; the backup ref existing proves
 * that transaction committed. `rollback` is durable before the source is put
 * back by CAS after its checkout could not follow. `done` holds the answer.
 * `common_dir` is the repository's canonical identity, so an unfinished
 * journal isolates its repository even when its Location is gone.
 */
export interface BranchAlignJournal {fingerprint:string;meaning:BranchAlignMeaning;state:'intent'|'rollback'|'done';holder:string|null;common_dir?:string;answer?:BranchAlignReply;
 /**
  * The person's untracked baseline of `holder`, taken before any side effect
  * and recorded durably with the intent, never retaken: the
  * visible untracked files and the ignored paths (an ignored directory as one
  * `dir/` entry), so a target that un-ignores a person's file does not strand
  * it. Settlement, replay, rollback, admission and restart all allow exactly
  * these, and only for the same holder; anything else untracked needs a person.
  */
 untracked?:string[]}

export const branchAlignFail=(error:string):BranchAlignReply=>({ok:false,error,outcome:null,previous_commit:null,aligned_commit:null,backup_ref:null,worktree_updated:false});
export function branchAlignJournalPath(locationId:string,operationId:string){return join(configDir(),'branch-align',locationId,`${operationId}.json`);}
export const BRANCH_ALIGN_IN_PROGRESS=['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','BISECT_LOG','rebase-merge','rebase-apply','sequencer','index.lock'];

/**
 * The journal as something to act on: it is read, then made durable (file,
 * directory and directory chain, `syncExistingDurable`) before any caller may
 * replay its answer, release an isolation or continue from it. A visible
 * record is not proof it survives power loss — a write whose rename landed but
 * whose directory sync failed leaves exactly that — so every read syncs again;
 * a sync failure throws and the repository stays isolated. Null only when the
 * journal does not exist; an unreadable one throws.
 */
export async function loadJournal(path:string):Promise<BranchAlignJournal|null>{
 const text=await readFile(path,'utf8').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
 if(text===null)return null;
 let value:unknown;
 try{value=JSON.parse(text);}catch{throw new Error('workspace_branch_align_journal_unreadable');}
 if(!value||typeof value!=='object')throw new Error('workspace_branch_align_journal_unreadable');
 if(!await syncExistingDurable(path))throw new Error('workspace_branch_align_journal_unreadable');
 return value as BranchAlignJournal;
}

/** The request meaning as journals and quarantine records store it. */
export const fingerprintOf=(meaning:BranchAlignMeaning)=>JSON.stringify(meaning);
export const BRANCH_ALIGN_REPOSITORY_CHANGED='workspace_branch_align_repository_changed';

/**
 * Why a journal is not this operation's record in this repository, or null
 * when it is: its fingerprint and its own meaning are this request's meaning
 * (`request_changed` otherwise), and it names this canonical Git common
 * directory (`repository_changed` otherwise, a missing one included).
 */
export function journalMismatch(journal:BranchAlignJournal,meaning:BranchAlignMeaning,commonDir:string):string|null{
 const fingerprint=fingerprintOf(meaning);
 if(journal.fingerprint!==fingerprint||!journal.meaning||fingerprintOf(journal.meaning)!==fingerprint)return 'workspace_branch_align_request_changed';
 return journal.common_dir===commonDir?null:BRANCH_ALIGN_REPOSITORY_CHANGED;
}

/**
 * The one way a journal is trusted (replay, continuation, settlement,
 * admission, Host-start recovery). Its path is derived from the meaning,
 * never read from a record; it is made durable before use (`loadJournal`);
 * its content must be this meaning in this repository (`journalMismatch`);
 * and a quarantine record of the same operation must name the same
 * repository and meaning. A Location that now resolves to another repository
 * therefore neither replays an answer recorded in the old one nor continues
 * its intent: the refusal touches no repository, and the old one stays
 * isolated by its own record.
 */
export async function ownJournal(meaning:BranchAlignMeaning,commonDir:string):Promise<{journal:BranchAlignJournal|null;refusal:null}|{journal:null;refusal:string}>{
 const record=(await quarantine()).get(meaning.operation_id);
 if(record){
  if(fingerprintOf(record.meaning)!==fingerprintOf(meaning))return {journal:null,refusal:'workspace_branch_align_request_changed'};
  if(record.common_dir!==commonDir)return {journal:null,refusal:BRANCH_ALIGN_REPOSITORY_CHANGED};
 }
 const journal=await loadJournal(branchAlignJournalPath(meaning.workspace.workspace_location_id,meaning.operation_id));
 const refusal=journal&&journalMismatch(journal,meaning,commonDir);
 return refusal?{journal:null,refusal}:{journal,refusal:null};
}

/**
 * A journal found by the Host-start scan, trusted only through its envelope:
 * the directory it sits in is its meaning's Location, its file name is its
 * operation, its fingerprint is its meaning and it names a repository. What it
 * says about itself is never taken over the path it was found at, so a copied
 * or edited journal is not acted on and isolates nothing.
 */
export function journalEnvelopeValid(journal:BranchAlignJournal,locationDir:string,fileName:string):journal is BranchAlignJournal&{common_dir:string}{
 const meaning=journal.meaning;
 return Boolean(meaning&&typeof meaning==='object'&&typeof journal.common_dir==='string'&&journal.common_dir
  &&meaning.workspace?.workspace_location_id===locationDir&&`${meaning.operation_id}.json`===fileName
  &&journalMismatch(journal,meaning,journal.common_dir)===null);
}

/** The quarantine record of one operation, if any. */
export async function quarantineRecordOf(operationId:string){return (await quarantine()).get(operationId)??null;}

async function readRecord<T>(path:string):Promise<T|null>{
 const text=await readFile(path,'utf8').catch(()=>null);
 if(!text)return null;
 try{const value:unknown=JSON.parse(text);return value&&typeof value==='object'?value as T:null;}catch{return null;}
}

/**
 * Repository quarantine (hosts.md, "Controlled Git publication"). An
 * alignment whose recovery did not finish, or that ended needing a person,
 * leaves its repository — by canonical Git common directory, not by Location
 * — isolated: one durable record per operation, written before recovery is
 * attempted and removed only once the ref, index and checkout are proven
 * consistent. Every start path of that repository (Runs, host commands,
 * worktree maintenance, alignments) asks `admitRepository` first; other
 * repositories are never affected. Records survive a restart.
 */
interface QuarantineRecord {common_dir:string;location_id:string;operation_id:string;meaning:BranchAlignMeaning;reason:string;at:string}
const quarantineDir=()=>join(configDir(),'branch-align-quarantine');
const quarantinePath=(operationId:string)=>join(quarantineDir(),`${operationId}.json`);
let records:Map<string,QuarantineRecord>|null=null;
let loading:Promise<Map<string,QuarantineRecord>>|null=null;

async function quarantine():Promise<Map<string,QuarantineRecord>>{
 if(records)return records;
 loading??=(async()=>{
  const found=new Map<string,QuarantineRecord>();
  for(const name of await readdir(quarantineDir()).catch(()=>[] as string[])){
   if(!name.endsWith('.json'))continue;
   const record=await readRecord<QuarantineRecord>(join(quarantineDir(),name));
   // Only a record at its own operation's name (as `quarantineRepository`
   // writes it, and as `releaseQuarantine` removes it) is one.
   if(record?.common_dir&&record.operation_id&&record.meaning&&name===`${record.operation_id}.json`
    &&record.meaning.operation_id===record.operation_id&&record.meaning.workspace?.workspace_location_id===record.location_id)found.set(record.operation_id,record);
  }
  records=found;loading=null;return found;
 })();
 return loading;
}

/** Tests only: forget the in-memory copy, as a restart does. */
export function resetQuarantineCacheForTest(){records=null;loading=null;}

export async function quarantineRepository(record:Omit<QuarantineRecord,'at'>):Promise<void>{
 const full={...record,at:new Date().toISOString()};
 // In memory first: a record that cannot be made durable still isolates the
 // repository for this process's life (and its write failure is thrown).
 (await quarantine()).set(record.operation_id,full);
 await writeJsonDurable(quarantinePath(record.operation_id),full);
}

export async function isQuarantined(operationId:string):Promise<boolean>{return (await quarantine()).has(operationId);}

/**
 * Lifts one isolation durably: the record is unlinked and its directory
 * synced (`removeDurable`) before the in-memory copy is dropped. A failure is
 * thrown and the repository stays isolated in this process; a retry (an
 * admission or a redelivery that proves the state again) syncs the directory
 * again even though the file is already gone.
 */
export async function releaseQuarantine(operationId:string):Promise<void>{
 const map=await quarantine();
 await removeDurable(quarantinePath(operationId));
 map.delete(operationId);
}

export async function quarantinedRepositories():Promise<string[]>{
 return [...new Set([...(await quarantine()).values()].map(r=>r.common_dir))];
}

const admissions=new Map<string,Promise<unknown>>();
/** One admission check per repository at a time; a later caller sees its result. */
function serialized<T>(commonDir:string,work:()=>Promise<T>):Promise<T>{
 const next=(admissions.get(commonDir)??Promise.resolve()).then(work,work);
 admissions.set(commonDir,next.catch(()=>undefined));
 return next;
}

export const REPOSITORY_RECOVERY_REQUIRED='workspace_repository_recovery_required';

/**
 * Null when none of these repositories is quarantined, or each quarantined one
 * is now proven consistent (its record is then released and an unfinished
 * journal answered from the facts). Otherwise the refusal to report.
 */
export async function admitRepositories(commonDirs:readonly (string|null|undefined)[],exceptOperation?:string):Promise<string|null>{
 const map=await quarantine();
 if(!map.size)return null;
 for(const dir of new Set(commonDirs.filter((d):d is string=>!!d))){
  if(![...map.values()].some(r=>r.common_dir===dir&&r.operation_id!==exceptOperation))continue;
  const refused=await serialized(dir,()=>admitOne(dir,exceptOperation));
  if(refused)return refused;
 }
 return null;
}

async function admitOne(commonDir:string,exceptOperation?:string):Promise<string|null>{
 for(const record of [...(await quarantine()).values()].filter(r=>r.common_dir===commonDir&&r.operation_id!==exceptOperation)){
  const m=record.meaning,backupRef=`refs/rainver/branch-backups/${m.operation_id}`;
  // Durable before it is trusted (a sync failure throws: still isolated), and
  // only this operation's own journal for this repository supplies a baseline.
  const path=branchAlignJournalPath(m.workspace.workspace_location_id,m.operation_id);
  const own=await ownJournal(m,commonDir);
  if(own.refusal)return REPOSITORY_RECOVERY_REQUIRED;
  const journal=own.journal;
  // The backup ref is created by the operation's one ref transaction: absent,
  // with the source still at its old tip, nothing of the operation happened.
  const untouched=await commitOf(commonDir,backupRef)===null&&await commitOf(commonDir,m.source_ref)===m.expected_source_commit;
  const consistent=untouched?null:await consistentAlignment(commonDir,m,journal);
  if(!untouched&&!consistent)return REPOSITORY_RECOVERY_REQUIRED;
  if(journal&&journal.state!=='done'){
   // Proven consistent now: the unfinished journal is closed from these facts,
   // never acted on later (a restart must not move a branch work continued on).
   const committed=!untouched&&await commitOf(commonDir,backupRef)===m.expected_source_commit;
   const answer:BranchAlignReply=consistent?.tip===m.expected_target_commit&&committed
    ?{ok:true,error:null,outcome:'aligned',previous_commit:m.expected_source_commit,aligned_commit:m.expected_target_commit,backup_ref:`refs/rainver/branch-backups/${m.operation_id}`,worktree_updated:Boolean(consistent.holder)}
    :committed?{...branchAlignFail('workspace_branch_align_worktree_update_failed'),backup_ref:`refs/rainver/branch-backups/${m.operation_id}`}:branchAlignFail('workspace_branch_align_interrupted');
   await writeJsonDurable(path,{...journal,state:'done',answer} satisfies BranchAlignJournal);
  }
  await releaseQuarantine(record.operation_id);
 }
 return null;
}

/** A commit id; null only when the ref does not exist. Any other Git failure throws, so it is never read as "absent". */
export async function commitOf(cwd:string,ref:string):Promise<string|null>{
 const r=await runLocationGit(['rev-parse','--verify','--quiet',`${ref}^{commit}`],cwd);
 if(r.code===0)return r.stdout.trim();
 if(r.code===1)return null;
 throw new Error(`git rev-parse ${ref} failed (${r.code})`);
}

async function gitText(args:string[],cwd:string):Promise<string|null>{
 const r=await runLocationGit(args,cwd,120_000);
 return r.code===0?r.stdout:null;
}

/** True when an unfinished Git operation (merge, rebase, cherry-pick, a held index lock...) is visible in this checkout. */
export async function gitOperationInProgress(holder:string):Promise<boolean>{
 for(const name of BRANCH_ALIGN_IN_PROGRESS){
  const at=(await runLocationGit(['rev-parse','--git-path',name],holder)).stdout.trim();
  if(at&&await stat(join(holder,at)).then(()=>true,()=>stat(at).then(()=>true,()=>false)))return true;
 }
 return false;
}

/**
 * Git's C-style quoting of one path for `--stdin-paths`: a line that starts
 * with `"` is unquoted by Git, so every path is quoted — `"` and `\`
 * escaped, every byte outside printable ASCII (newline, UTF-8 bytes...) as
 * an octal escape — and no legal file name is misread.
 */
export function gitQuotePath(path:string):string{
 let quoted='"';
 for(const byte of Buffer.from(path,'utf8')){
  if(byte===0x22||byte===0x5c)quoted+=`\\${String.fromCharCode(byte)}`;
  else if(byte>=0x20&&byte<0x7f)quoted+=String.fromCharCode(byte);
  else quoted+=`\\${byte.toString(8).padStart(3,'0')}`;
 }
 return `${quoted}"`;
}

/** Whether `path` is one of the recorded baseline entries (exact, or below a recorded `dir/`). */
function inBaseline(baseline:readonly string[]){
 const exact=new Set(baseline),dirs=baseline.filter(entry=>entry.endsWith('/'));
 return (path:string)=>exact.has(path)||dirs.some(dir=>path.startsWith(dir));
}

/**
 * Every gitlink of `commit` against its submodule's actual state, never the
 * holder's index: a missing path or one that is not a directory fails; an
 * unpopulated submodule (no `.git`) must be an empty directory, as Git leaves
 * it; a populated one's HEAD must be the recorded commit. The comparison is
 * Git's own (`diff-files --ignore-submodules=dirty`, which resolves the
 * submodule's HEAD from the superproject without running Git inside it) but on
 * a fresh index of `commit` in a temporary file, so the holder's
 * assume-unchanged, skip-worktree (sparse) or stat-cache bits cannot hide a
 * moved submodule, and the person's index is never changed. Git counts a HEAD
 * it cannot resolve as unchanged, so the match is also proven positively:
 * with every recorded commit replaced by a different id, each populated
 * submodule must differ. Edits inside a submodule are its own checkout and are
 * not judged (Rainver never runs Git under a nested repository's own
 * configuration). Nothing is updated, initialized or cleaned.
 */
async function submodulesMatch(holder:string,commit:string,gitlinks:ReadonlyArray<{path:string;oid:string}>):Promise<boolean>{
 const populated:Array<{path:string;oid:string}>=[];
 for(const link of gitlinks){
  const at=join(holder,link.path);
  if(!await lstat(at).then(i=>i.isDirectory(),()=>false))return false;
  if(await submodulePopulated(holder,link.path))populated.push(link);
  else if((await readdir(at)).length)return false;
 }
 if(!populated.length)return true;
 const scratch=await mkdtemp(join(tmpdir(),'rainver-align-index-'));
 try{
  const env={GIT_INDEX_FILE:join(scratch,'index'),GIT_LITERAL_PATHSPECS:'1'};
  // `core.ignoreStat=true` makes Git mark each entry it writes assume-unchanged,
  // which diff-files then never compares; every step on the scratch index runs
  // without it. The person's configuration and index are not touched.
  const git=(args:string[],input?:string)=>runLocationGit(['-c','core.ignoreStat=false',...args],holder,120_000,{env,input});
  if((await git(['read-tree','--no-sparse-checkout',commit])).code!==0)return false;
  const differing=async()=>{
   const r=await git(['diff-files','-z','--name-only','--ignore-submodules=dirty','--',...populated.map(l=>l.path)]);
   return r.code===0?new Set(r.stdout.split('\0').filter(Boolean)):null;
  };
  const atRecorded=await differing();
  if(!atRecorded||populated.some(l=>atRecorded.has(l.path)))return false;
  const other=(oid:string)=>oid.slice(0,-1)+(oid.endsWith('0')?'1':'0');
  const replaced=await git(['update-index','-z','--index-info'],populated.map(l=>`160000 ${other(l.oid)}\t${l.path}\0`).join(''));
  if(replaced.code!==0)return false;
  const atOther=await differing();
  return Boolean(atOther)&&populated.every(l=>atOther!.has(l.path));
 }finally{await rm(scratch,{recursive:true,force:true});}
}

/** Whether the checkout at `holder` has `path` as a populated submodule. */
export const submodulePopulated=(holder:string,path:string)=>lstat(join(holder,path,'.git')).then(()=>true,()=>false);

/**
 * The checkout's index and tracked working files are exactly `commit`'s tree,
 * read from the files themselves rather than from the index stat cache: every
 * tracked file exists, has the tree's type and executable bit, and its
 * content hashes (through the repository's own filters and attributes, every
 * path Git-quoted) to the tree's blob; a symlink entry is a real symlink, or —
 * only under an effective `core.symlinks=false` — Git's plain placeholder
 * file, whose raw bytes hash to the blob; every gitlink's submodule is
 * unpopulated or at its commit (`submodulesMatch`). Nothing is
 * unmerged, no untracked non-ignored file is present other than the recorded
 * baseline `allowedUntracked`, and no Git operation is unfinished.
 * Ignored files are not read.
 */
export async function checkoutMatches(holder:string,commit:string,allowedUntracked:readonly string[]=[]):Promise<boolean>{
 if(await gitOperationInProgress(holder))return false;
 const tree=(await gitText(['rev-parse',`${commit}^{tree}`],holder))?.trim();
 const index=await runLocationGit(['write-tree'],holder);
 if(!tree||index.code!==0||index.stdout.trim()!==tree)return false;
 const unmerged=await gitText(['ls-files','-u','-z'],holder);
 if(unmerged===null||unmerged.length)return false;
 const others=await untrackedFiles(holder),allowed=inBaseline(allowedUntracked);
 if(others===null||others.some(path=>!allowed(path)))return false;
 const listing=await gitText(['ls-tree','-r','-z','--full-tree',commit],holder);
 if(listing===null)return false;
 const fileMode=(await gitText(['config','--bool','core.fileMode'],holder))?.trim()!=='false';
 const symlinks=(await gitText(['config','--bool','core.symlinks'],holder))?.trim()!=='false';
 const files:Array<{path:string;blob:string}>=[],gitlinks:Array<{path:string;oid:string}>=[];
 for(const entry of listing.split('\0')){
  if(!entry)continue;
  const tab=entry.indexOf('\t'),[mode,type,blob]=entry.slice(0,tab).split(' '),path=entry.slice(tab+1);
  if(!blob)return false;
  const at=join(holder,path);
  if(type==='commit'){gitlinks.push({path,oid:blob});continue;}
  const info=await lstat(at).catch(()=>null);
  if(!info||type!=='blob')return false;
  if(mode==='120000'){
   // A link is its target's bytes; with `core.symlinks=false` Git checks it
   // out as a plain file holding them. Either form is hashed raw
   // (`--no-filters`), never through the file path's EOL or filter attributes.
   const raw=info.isSymbolicLink()?await readlink(at,{encoding:'buffer'}):!symlinks&&info.isFile()?await readFile(at):null;
   if(!raw)return false;
   const hashed=await runLocationGit(['hash-object','--no-filters','--stdin'],holder,30_000,{input:raw});
   if(hashed.code!==0||hashed.stdout.trim()!==blob)return false;
   continue;
  }
  if(!info.isFile()||fileMode&&((info.mode&0o100)!==0)!==(mode==='100755'))return false;
  files.push({path,blob});
 }
 if(!await submodulesMatch(holder,commit,gitlinks))return false;
 if(!files.length)return true;
 const hashed=await runLocationGit(['hash-object','--stdin-paths'],holder,600_000,{input:files.map(f=>gitQuotePath(f.path)).join('\n')+'\n'});
 if(hashed.code!==0)return false;
 const blobs=hashed.stdout.trim().split('\n');
 return blobs.length===files.length&&files.every((f,i)=>blobs[i]===f.blob);
}

/** Untracked, not ignored paths of the checkout; null when Git cannot list them. */
export async function untrackedFiles(holder:string):Promise<string[]|null>{
 const listed=await gitText(['ls-files','--others','--exclude-standard','-z'],holder);
 return listed===null?null:listed.split('\0').filter(Boolean);
}

/**
 * The holder's untracked baseline (see `BranchAlignJournal.untracked`):
 * visible untracked files plus ignored paths, ignored directories collapsed.
 * Null when Git cannot list them.
 */
export async function untrackedBaseline(holder:string):Promise<string[]|null>{
 const visible=await untrackedFiles(holder);
 const ignored=await gitText(['ls-files','--others','--ignored','--exclude-standard','--directory','-z'],holder);
 return visible===null||ignored===null?null:[...new Set([...visible,...ignored.split('\0').filter(Boolean)])];
}

/** The only checkout of `ref`, or null; undefined when the worktree list cannot be read or names it more than once. */
export async function checkoutsOf(commonDir:string,ref:string):Promise<string|null|undefined>{
 const listed=await runLocationGit(['worktree','list','--porcelain','-z'],commonDir);
 if(listed.code!==0)return undefined;
 const holders:string[]=[];let current:string|null=null;
 for(const field of listed.stdout.split('\0')){
  if(field.startsWith('worktree '))current=field.slice(9);
  else if(field===`branch ${ref}`&&current)holders.push(current);
 }
 return holders.length>1?undefined:holders[0]??null;
}

/**
 * The whole repository state an alignment may leave: `ref` names `commit`,
 * and its checkout (if any) has `ref` as symbolic HEAD at that commit and
 * matches it file by file (`checkoutMatches`).
 */
export async function alignedStateIs(commonDir:string,ref:string,commit:string,holder?:string|null,allowedUntracked:readonly string[]=[]):Promise<boolean>{
 if(await commitOf(commonDir,ref).catch(()=>null)!==commit)return false;
 const found=await checkoutsOf(commonDir,ref);
 if(found===undefined||holder!==undefined&&found!==holder)return false;
 if(!found)return true;
 if(!await stat(found).then(s=>s.isDirectory(),()=>false))return false;
 const head=await runLocationGit(['symbolic-ref','-q','HEAD'],found);
 if(head.code!==0||head.stdout.trim()!==ref||await commitOf(found,'HEAD').catch(()=>null)!==commit)return false;
 return checkoutMatches(found,commit,allowedUntracked).catch(()=>false);
}

/**
 * `alignedStateIs` with the operation's recorded untracked baseline, which
 * applies only to the checkout the journal recorded it for.
 */
export async function recordedStateIs(commonDir:string,ref:string,commit:string,journal:BranchAlignJournal|null):Promise<boolean>{
 const holder=await checkoutsOf(commonDir,ref);
 if(holder===undefined)return false;
 return alignedStateIs(commonDir,ref,commit,holder,journal&&journal.holder===holder?journal.untracked??[]:[]);
}

/**
 * The source names one of the two commits the operation knew, it is checked
 * out at most once, and that checkout's HEAD, index, tracked files and
 * submodules are exactly its commit with no unfinished Git operation and no
 * untracked file outside the recorded baseline. Null otherwise.
 */
export async function consistentAlignment(commonDir:string,meaning:BranchAlignMeaning,journal:BranchAlignJournal|null=null):Promise<{tip:string;holder:string|null}|null>{
 const tip=await commitOf(commonDir,meaning.source_ref).catch(()=>null);
 if(!tip||tip!==meaning.expected_source_commit&&tip!==meaning.expected_target_commit)return null;
 const holder=await checkoutsOf(commonDir,meaning.source_ref);
 if(holder===undefined||!await recordedStateIs(commonDir,meaning.source_ref,tip,journal))return null;
 return {tip,holder};
}
