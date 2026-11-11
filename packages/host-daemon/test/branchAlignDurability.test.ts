import {mkdtemp,mkdir,writeFile,rm,realpath,readFile,stat,utimes} from 'node:fs/promises';
import {existsSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {branchAlignBarriers,executeGitBranchAlign,resetBranchAlignGitForTest} from '../src/gitBranchAlign.js';
import {checkoutMatches,gitQuotePath,resetQuarantineCacheForTest} from '../src/branchAlignState.js';
import {resetDurableDirectoriesForTest,setDurableIoForTest} from '../src/durableFile.js';
import {holdRepositories} from '../src/repositoryGate.js';
import type {HostServerFrameOf} from '@rainver/protocol';

/*
 * Durability of the alignment state machine under injected fsync, rename and
 * directory-sync failures (the real `DurableIo` seam, so the failure lands in
 * the actual window: after a rename made the new value visible, before its
 * directory sync). These prove ordering against the same Host's own I/O
 * errors and restarts; they are not power-loss experiments.
 */
let sandbox:string,root:string,config:string,restoreIo:(()=>void)|null=null;
const LOCATION='folder-align';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const person=(cwd:string)=>{git(cwd,'config','user.name','Person');git(cwd,'config','user.email','person@example.test');};
async function commit(dir:string,file:string,text:string,message:string){await mkdir(dirname(join(dir,file)),{recursive:true});await writeFile(join(dir,file),text);git(dir,'add','--',file);git(dir,'commit','-qm',message);return git(dir,'rev-parse','HEAD');}
/** dev (checked out) holds old work; master gained two reviewed commits. */
async function initRepo(dir:string,extra?:(dir:string)=>Promise<void>){
 await mkdir(dir,{recursive:true});git(dir,'init','-q','-b','master');person(dir);
 await commit(dir,'a.txt','a\n','initial');
 git(dir,'checkout','-q','-b','dev');const old=await commit(dir,'old.txt','old\n','old dev work');
 git(dir,'checkout','-q','master');await commit(dir,'b.txt','b\n','reviewed 1');
 await extra?.(dir);
 const tip=await commit(dir,'c.txt','c\n','reviewed 2');
 git(dir,'checkout','-q','dev');
 return {old,tip};
}
const alignFrame=(old:string,tip:string):HostServerFrameOf<'git_branch_align'>=>({type:'git_branch_align',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION},source_ref:'refs/heads/dev',target_ref:'refs/heads/master',mode:'reset',expected_source_commit:old,expected_target_commit:tip});
const redeliver=(frame:HostServerFrameOf<'git_branch_align'>)=>executeGitBranchAlign(root,{...frame,request_id:randomUUID()});
const journalDir=()=>join(config,'branch-align',LOCATION);
const journalOf=(frame:{operation_id:string})=>join(journalDir(),`${frame.operation_id}.json`);
const quarantineDir=()=>join(config,'branch-align-quarantine');
const quarantined=()=>existsSync(quarantineDir())?readdirSync(quarantineDir()).filter(n=>n.endsWith('.json')):[];
/** The real start-path admission (host commands, launches): admitted or the refusal. */
async function admission(){const held=await holdRepositories([join(root,'.git')]);if('refused' in held)return held.refused;held.release();return 'admitted';}
/** Restores real durable I/O (a function, so the type of `restoreIo` is not narrowed across awaits). */
function undoIo(){restoreIo?.();restoreIo=null;}
const restart=()=>{resetQuarantineCacheForTest();resetDurableDirectoriesForTest();};
const state=async(path:string)=>(JSON.parse(await readFile(path,'utf8')) as {state:string}).state;

/**
 * Fails the directory sync of `dir` once a rename into it delivered a record
 * whose state is `armedBy` (or at once when null); `failing` stays on until cleared.
 */
function failDirectorySync(dir:()=>string,armedBy:string|null){
 const control={failing:true,armed:armedBy===null,synced:[] as string[],fileSynced:[] as string[]};
 restoreIo=setDurableIoForTest({
  async rename(from,to){
   const {rename}=await import('node:fs/promises');
   if(armedBy&&dirname(to)===dir()&&(JSON.parse(await readFile(from,'utf8')) as {state?:string}).state===armedBy)control.armed=true;
   await rename(from,to);
  },
  async syncDirectory(path){
   control.synced.push(path);
   if(control.failing&&control.armed&&path===dir())throw new Error('injected directory fsync failure');
  },
  async syncFile(handle,path){control.fileSynced.push(path);await handle.sync();},
 });
 return control;
}

beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-align-durable-')));
 root=join(sandbox,'repo');config=join(sandbox,'host');await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;
 await saveConfig({server_url:'http://127.0.0.1:1',host_id:'host',trust:'trusted',token:'test',workspaces:{[LOCATION]:root}});
});
afterEach(async()=>{
 undoIo();restart();resetBranchAlignGitForTest();delete process.env.GIT_CONFIG_GLOBAL;
 delete branchAlignBarriers.beforeTransaction;delete branchAlignBarriers.beforeWorktree;
 delete process.env.RAINVER_HOST_CONFIG_DIR;
 await rm(sandbox,{recursive:true,force:true});
});

it('a visible done whose directory sync failed is never replayed or admitted until it is synced again, in the same process or after a restart',async()=>{
 const {old,tip}=await initRepo(root);
 const frame=alignFrame(old,tip);
 const io=failDirectorySync(journalDir,'done');
 await expect(executeGitBranchAlign(root,frame)).rejects.toThrow('injected directory fsync failure');
 // The window: the answer is visible, its directory entry not durable, the repository still isolated.
 expect(await state(journalOf(frame))).toBe('done');
 expect(git(root,'rev-parse','dev')).toBe(tip);
 expect(quarantined()).toEqual([`${frame.operation_id}.json`]);
 // Same process: a redelivery and an admission both re-sync before trusting it, fail, and keep isolation.
 await expect(redeliver(frame)).rejects.toThrow('injected directory fsync failure');
 expect(await admission()).toBe('workspace_repository_recovery_required');
 expect(quarantined()).toEqual([`${frame.operation_id}.json`]);
 // After a restart (fresh caches) the same: the record is reloaded and still not released.
 restart();
 await expect(redeliver(frame)).rejects.toThrow('injected directory fsync failure');
 expect(await admission()).toBe('workspace_repository_recovery_required');
 expect(quarantined()).toEqual([`${frame.operation_id}.json`]);
 // A failing file fsync of the existing answer is not trusted either.
 undoIo();
 restoreIo=setDurableIoForTest({async syncFile(_handle,path){if(path===journalOf(frame))throw new Error('injected file fsync failure');}});
 await expect(redeliver(frame)).rejects.toThrow('injected file fsync failure');
 expect(await admission()).toBe('workspace_repository_recovery_required');
 undoIo();
 // Synced again: the replay answers, the isolation is lifted durably, work is admitted.
 const synced=failDirectorySync(journalDir,null);synced.failing=false;restart();
 expect(await redeliver(frame)).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(synced.fileSynced).toContain(journalOf(frame));expect(synced.synced).toContain(journalDir());
 expect(quarantined()).toEqual([]);
 expect(await admission()).toBe('admitted');
 void io;
});

it('admission is the other release path: it syncs the visible done (and its directory chain) before lifting the isolation',async()=>{
 const {old,tip}=await initRepo(root);
 const frame=alignFrame(old,tip);
 const io=failDirectorySync(journalDir,'done');
 await expect(executeGitBranchAlign(root,frame)).rejects.toThrow('injected directory fsync failure');
 restart();io.synced.length=0;
 expect(await admission()).toBe('workspace_repository_recovery_required');
 // After the restart the journal directory's chain up to the config directory is synced again before its own sync is tried.
 expect(io.synced).toEqual([join(config,'branch-align'),config,journalDir()]);
 io.failing=false;io.synced.length=0;io.fileSynced.length=0;
 expect(await admission()).toBe('admitted');
 // The answer file and its directory were synced again before the release.
 expect(io.fileSynced).toContain(journalOf(frame));
 expect(io.synced).toEqual(expect.arrayContaining([journalDir(),quarantineDir()]));
 expect(io.synced.indexOf(journalDir())).toBeLessThan(io.synced.lastIndexOf(quarantineDir()));
 expect(quarantined()).toEqual([]);
 expect(await redeliver(frame)).toMatchObject({ok:true,outcome:'aligned'});
});

it('an intent whose directory sync failed stops before any side effect, and its redelivery re-syncs it before the ref transaction',async()=>{
 const {old,tip}=await initRepo(root);
 const frame=alignFrame(old,tip);
 let transactions=0;branchAlignBarriers.beforeTransaction=async()=>{transactions++;};
 const io=failDirectorySync(journalDir,'intent');
 await expect(executeGitBranchAlign(root,frame)).rejects.toThrow('injected directory fsync failure');
 expect(await state(journalOf(frame))).toBe('intent');
 expect(transactions).toBe(0);expect(git(root,'rev-parse','dev')).toBe(old);expect(git(root,'for-each-ref','refs/rainver/')).toBe('');
 // The visible intent is not continued from while it cannot be synced.
 await expect(redeliver(frame)).rejects.toThrow('injected directory fsync failure');
 expect(transactions).toBe(0);expect(git(root,'rev-parse','dev')).toBe(old);
 io.failing=false;
 expect(await redeliver(frame)).toMatchObject({ok:true,outcome:'aligned'});
 expect(transactions).toBe(1);expect(quarantined()).toEqual([]);
 // A file fsync failure (before the rename) and a rename failure leave no visible intent and no side effect.
 git(root,'update-ref','refs/heads/dev',old,tip);git(root,'reset','-q','--hard','dev');
 undoIo();
 for(const step of ['syncFile','rename'] as const){
  const next=alignFrame(old,tip);
  // Only the journal's own temporary file and rename fail; the isolation record before it is written normally.
  restoreIo=setDurableIoForTest(step==='syncFile'
   ?{async syncFile(handle,path){if(dirname(path)===journalDir())throw new Error('injected syncFile failure');await handle.sync();}}
   :{async rename(from,to){if(dirname(to)===journalDir())throw new Error('injected rename failure');const {rename}=await import('node:fs/promises');await rename(from,to);}});
  await expect(executeGitBranchAlign(root,next)).rejects.toThrow(`injected ${step} failure`);
  undoIo();
  expect(existsSync(journalOf(next))).toBe(false);expect(git(root,'rev-parse','dev')).toBe(old);
  expect(git(root,'for-each-ref','refs/rainver/')).toBe(`${old} commit\trefs/rainver/branch-backups/${frame.operation_id}`);
 }
});

it('a release whose directory sync fails after the unlink keeps the repository isolated and a retry syncs the directory again',async()=>{
 const {old,tip}=await initRepo(root);
 const frame=alignFrame(old,tip);
 branchAlignBarriers.beforeWorktree=async()=>{throw new Error('daemon interrupted');};
 await expect(executeGitBranchAlign(root,frame)).rejects.toThrow('daemon interrupted');
 delete branchAlignBarriers.beforeWorktree;
 expect(quarantined()).toEqual([`${frame.operation_id}.json`]);
 const io=failDirectorySync(quarantineDir,null);
 // The redelivery finishes and answers durably, but lifting the isolation cannot be made durable: the error surfaces.
 await expect(redeliver(frame)).rejects.toThrow('injected directory fsync failure');
 expect(quarantined()).toEqual([]);
 // The unlink is visible, the isolation is not dropped in memory: nothing new starts.
 expect(await admission()).toBe('workspace_repository_recovery_required');
 expect(await admission()).toBe('workspace_repository_recovery_required');
 // Retried with a working sync: the already-absent record's directory is synced again, then admitted.
 io.failing=false;io.synced.length=0;
 expect(await admission()).toBe('admitted');
 expect(io.synced).toContain(quarantineDir());
 expect(await admission()).toBe('admitted');
 expect(await redeliver(frame)).toMatchObject({ok:true,outcome:'aligned'});
});

it('refuses, before any side effect, a move that changes a populated submodule, verifies submodules by their commit, and follows unpopulated ones',async()=>{
 const sub=join(sandbox,'sub');await mkdir(sub);git(sub,'init','-q','-b','main');person(sub);
 const s1=await commit(sub,'s.txt','1\n','s1');const s2=await commit(sub,'s.txt','2\n','s2');
 git(sub,'checkout','-q',s1);
 const addSub=async(dir:string)=>{git(dir,'-c','protocol.file.allow=always','submodule','add','-q',sub,'mod');git(dir,'-C','mod','checkout','-q',s1);git(dir,'add','mod');git(dir,'commit','-qm','add submodule');};
 // dev and master both have the submodule; master moves it to s2.
 await mkdir(root);git(root,'init','-q','-b','master');person(root);
 await commit(root,'a.txt','a\n','initial');await addSub(root);
 git(root,'checkout','-q','-b','dev');const old=await commit(root,'old.txt','old\n','old dev work');
 git(root,'checkout','-q','master');git(root,'-C','mod','checkout','-q',s2);git(root,'add','mod');git(root,'commit','-qm','move submodule');
 const tip=await commit(root,'c.txt','c\n','reviewed');
 git(root,'checkout','-q','dev');git(root,'-C','mod','checkout','-q',s1);
 expect(git(root,'status','--porcelain','--ignore-submodules=none')).toBe('');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_submodule_unsupported',backup_ref:null});
 expect(git(root,'rev-parse','dev')).toBe(old);expect(git(root,'for-each-ref','refs/rainver/')).toBe('');expect(quarantined()).toEqual([]);
 expect(git(root,'-C','mod','rev-parse','HEAD')).toBe(s1);
 // The verification itself: index at the new tree, submodule still at its old commit, is not the new checkout.
 git(root,'read-tree','-m','-u',old,tip);
 expect(git(root,'write-tree')).toBe(git(root,'rev-parse',`${tip}^{tree}`));
 expect(git(root,'status','--porcelain','--ignore-submodules=none')).toContain('mod');
 expect(await checkoutMatches(root,tip)).toBe(false);
 git(root,'-C','mod','checkout','-q',s2);
 expect(await checkoutMatches(root,tip)).toBe(true);
 await rm(join(root,'mod'),{recursive:true,force:true});
 expect(await checkoutMatches(root,tip)).toBe(false);
 // Back to dev with the submodule not populated (an empty directory): the move follows it as Git leaves it.
 await mkdir(join(root,'mod'),{recursive:true});git(root,'read-tree','-m','-u',tip,old);
 expect(await checkoutMatches(root,old)).toBe(true);
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await checkoutMatches(root,tip)).toBe(true);expect(quarantined()).toEqual([]);
});

it('hashes every tracked path Git-quoted, through filters and attributes: quotes, backslashes, CJK, spaces and newlines align and stale content is still caught',async()=>{
 process.env.GIT_CONFIG_GLOBAL=join(sandbox,'global.gitconfig');
 const names=['"quoted.txt','back\\slash.txt','中文 文件.txt','with space.txt','new\nline.txt','"\n"\\both.txt','dir "x"/内.txt','filtered.flt','windows.crlf'];
 for(const name of names)expect(gitQuotePath(name).startsWith('"')).toBe(true);
 const {old,tip}=await initRepo(root,async dir=>{
  // A clean filter (upper case in the repository, lower case on disk) from trusted global configuration (a checkout's own filter
  // drivers are disabled for every Rainver Git call alike) and an eol attribute: only Git's own content semantics hash these right.
  await writeFile(process.env.GIT_CONFIG_GLOBAL!,'[filter "up"]\n\tclean = tr a-z A-Z\n\tsmudge = tr A-Z a-z\n');
  await commit(dir,'.gitattributes','*.flt filter=up\n*.crlf text eol=crlf\n','attributes');
  for(const name of names)await commit(dir,name,name.endsWith('.crlf')?'one\r\ntwo\r\n':`${name}\n`,`add ${JSON.stringify(name)}`);
 });
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(quarantined()).toEqual([]);
 expect(await readFile(join(root,'filtered.flt'),'utf8')).toBe('filtered.flt\n');
 expect(git(root,'cat-file','-p',`${tip}:filtered.flt`)).toBe('FILTERED.FLT');
 expect(await readFile(join(root,'windows.crlf'),'utf8')).toBe('one\r\ntwo\r\n');expect(git(root,'cat-file','-p',`${tip}:windows.crlf`)).toBe('one\ntwo');
 expect(await checkoutMatches(root,tip)).toBe(true);
 // Same size and mtime, different content, under names Git would otherwise unquote or split.
 for(const name of ['"quoted.txt','new\nline.txt','"\n"\\both.txt','中文 文件.txt']){
  const at=join(root,name),before=await stat(at),text=await readFile(at,'utf8');
  await writeFile(at,text.replace(/.$/su,'')+'#');await utimes(at,before.atime,before.mtime);
  expect(await checkoutMatches(root,tip)).toBe(false);
  await writeFile(at,text);
  expect(await checkoutMatches(root,tip)).toBe(true);
 }
});

it('keeps the person\'s recorded untracked baseline across a failed answer: admission, restart and replay accept exactly it, never a file added later',async()=>{
 // dev ignores the person's local.env; master does not, so the move makes it visible.
 await mkdir(root);git(root,'init','-q','-b','master');person(root);
 await commit(root,'a.txt','a\n','initial');
 git(root,'checkout','-q','-b','dev');await commit(root,'.gitignore','local.env\ncache/\n','ignore local');const old=await commit(root,'old.txt','old\n','old');
 git(root,'checkout','-q','master');const tip=await commit(root,'c.txt','c\n','reviewed');
 git(root,'checkout','-q','dev');
 await writeFile(join(root,'local.env'),'secret\n');await mkdir(join(root,'cache'));await writeFile(join(root,'cache','x.bin'),'x');
 const lose=async(frame:{operation_id:string})=>{
  // The final answer's rename fails: the journal stays at its intent, which recorded the baseline.
  restoreIo=setDurableIoForTest({async rename(from,to){
   const {rename}=await import('node:fs/promises');
   if(to===journalOf(frame)&&(JSON.parse(await readFile(from,'utf8')) as {state?:string}).state==='done')throw new Error('injected rename failure');
   await rename(from,to);
  }});
 };
 const frame=alignFrame(old,tip);await lose(frame);
 await expect(executeGitBranchAlign(root,frame)).rejects.toThrow('injected rename failure');
 undoIo();
 expect(JSON.parse(await readFile(journalOf(frame),'utf8'))).toMatchObject({state:'intent',untracked:expect.arrayContaining(['local.env','cache/'])});
 expect(git(root,'ls-files','--others','--exclude-standard')).toBe('cache/x.bin\nlocal.env');
 // Admission proves the checkout from the recorded baseline and closes the journal; the person's files are untouched.
 expect(await admission()).toBe('admitted');
 expect(await state(journalOf(frame))).toBe('done');
 expect(await readFile(join(root,'local.env'),'utf8')).toBe('secret\n');expect(existsSync(join(root,'cache','x.bin'))).toBe(true);
 expect(await redeliver(frame)).toMatchObject({ok:true,outcome:'aligned'});
 // Again, recovered by a redelivery after a restart instead.
 git(root,'update-ref','refs/heads/dev',old,tip);git(root,'reset','-q','--hard','dev');git(root,'clean','-fdq');
 const second=alignFrame(old,tip);await lose(second);
 await expect(executeGitBranchAlign(root,second)).rejects.toThrow('injected rename failure');
 undoIo();restart();
 expect(await redeliver(second)).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(quarantined()).toEqual([]);expect(await readFile(join(root,'local.env'),'utf8')).toBe('secret\n');
 // A file added after the baseline was recorded is not adopted: isolated, kept, admitted once the person moves it.
 git(root,'update-ref','refs/heads/dev',old,tip);git(root,'reset','-q','--hard','dev');git(root,'clean','-fdq');
 const third=alignFrame(old,tip);await lose(third);
 await expect(executeGitBranchAlign(root,third)).rejects.toThrow('injected rename failure');
 undoIo();
 await writeFile(join(root,'later.txt'),'mine\n');
 expect(await admission()).toBe('workspace_repository_recovery_required');
 restart();expect(await admission()).toBe('workspace_repository_recovery_required');
 expect(await readFile(join(root,'later.txt'),'utf8')).toBe('mine\n');
 await rm(join(root,'later.txt'));
 expect(await admission()).toBe('admitted');expect(quarantined()).toEqual([]);
});
