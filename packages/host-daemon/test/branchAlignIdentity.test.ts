import {mkdtemp,mkdir,writeFile,rm,realpath,readFile,symlink,unlink,copyFile,lstat,readlink} from 'node:fs/promises';
import {existsSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {saveConfig} from '../src/config.js';
import {branchAlignBarriers,executeGitBranchAlign,recoverBranchAlignments} from '../src/gitBranchAlign.js';
import {checkoutMatches,resetQuarantineCacheForTest} from '../src/branchAlignState.js';
import {resetDurableDirectoriesForTest} from '../src/durableFile.js';
import {holdRepositories} from '../src/repositoryGate.js';
import type {HostServerFrameOf} from '@rainver/protocol';

// Real temporary Git repositories; nothing here touches a real Host or database.
let sandbox:string,config:string;
const LOCATION='folder-align',OTHER_LOCATION='folder-other';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const person=(cwd:string)=>{git(cwd,'config','user.name','Person');git(cwd,'config','user.email','person@example.test');};
async function commit(dir:string,file:string,text:string,message:string){await mkdir(dirname(join(dir,file)),{recursive:true});await writeFile(join(dir,file),text);git(dir,'add','--',file);git(dir,'commit','-qm',message);return git(dir,'rev-parse','HEAD');}
const commonDirOf=(dir:string)=>realpathSync(git(dir,'rev-parse','--path-format=absolute','--git-common-dir'));
const alignFrame=(old:string,tip:string):HostServerFrameOf<'git_branch_align'>=>({type:'git_branch_align',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION},source_ref:'refs/heads/dev',target_ref:'refs/heads/master',mode:'reset',expected_source_commit:old,expected_target_commit:tip});
const again=(frame:HostServerFrameOf<'git_branch_align'>)=>({...frame,request_id:randomUUID()});
const journalOf=(location:string,operation:string)=>join(config,'branch-align',location,`${operation}.json`);
const quarantineDir=()=>join(config,'branch-align-quarantine');
const quarantined=()=>existsSync(quarantineDir())?readdirSync(quarantineDir()).filter(n=>n.endsWith('.json')):[];
const quarantinedRepos=async()=>Promise.all(quarantined().map(async n=>(JSON.parse(await readFile(join(quarantineDir(),n),'utf8')) as {common_dir:string}).common_dir));
const backups=(dir:string)=>git(dir,'for-each-ref','refs/rainver/');
const restart=()=>{resetQuarantineCacheForTest();resetDurableDirectoriesForTest();};
async function admission(dir:string){const held=await holdRepositories([commonDirOf(dir)]);if('refused' in held)return held.refused;held.release();return 'admitted';}
const flags=(dir:string)=>git(dir,'ls-files','-v');

/** dev holds old history (checked out), master a reviewed chain. */
async function initRepo(dir:string){
 await mkdir(dir,{recursive:true});git(dir,'init','-q','-b','master');person(dir);
 await commit(dir,'a.txt','a\n','initial');
 git(dir,'checkout','-q','-b','dev');const old=await commit(dir,'old.txt','old\n','old dev work');
 git(dir,'checkout','-q','master');await commit(dir,'b.txt','b\n','reviewed 1');const tip=await commit(dir,'c.txt','c\n','reviewed 2');
 git(dir,'checkout','-q','dev');
 return {old,tip};
}

beforeEach(async()=>{
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-align-identity-')));
 config=join(sandbox,'host');await mkdir(config);
 process.env.RAINVER_HOST_CONFIG_DIR=config;
 await saveConfig({server_url:'http://127.0.0.1:1',host_id:'host',trust:'trusted',token:'test',workspaces:{}});
});
afterEach(async()=>{
 restart();delete branchAlignBarriers.beforeTransaction;delete branchAlignBarriers.beforeWorktree;
 delete process.env.RAINVER_HOST_CONFIG_DIR;
 await rm(sandbox,{recursive:true,force:true});
});

/** A superproject whose dev and master share the nested submodule `libs/mod` at s1; master also adds c.txt. */
async function withSubmodule(){
 const sub=join(sandbox,'sub');await mkdir(sub);git(sub,'init','-q','-b','main');person(sub);
 const s1=await commit(sub,'s.txt','1\n','s1');const s2=await commit(sub,'s.txt','2\n','s2');git(sub,'checkout','-q',s1);
 const root=join(sandbox,'super');await mkdir(root);git(root,'init','-q','-b','master');person(root);
 await commit(root,'a.txt','a\n','initial');
 git(root,'-c','protocol.file.allow=always','submodule','add','-q',sub,'libs/mod');git(root,'-C','libs/mod','checkout','-q',s1);git(root,'add','libs/mod');git(root,'commit','-qm','add submodule');
 git(root,'checkout','-q','-b','dev');const old=await commit(root,'old.txt','old\n','old');
 git(root,'checkout','-q','master');const tip=await commit(root,'c.txt','c\n','reviewed');
 git(root,'checkout','-q','dev');
 return {root,old,tip,s1,s2};
}

it('judges a submodule by its actual HEAD: assume-unchanged and skip-worktree cannot hide a moved one, the person\'s index flags are kept, dirt inside is not judged',async()=>{
 const {root,old,s1,s2}=await withSubmodule();
 expect(await checkoutMatches(root,old)).toBe(true);
 git(root,'-C','libs/mod','checkout','-q',s2);
 expect(await checkoutMatches(root,old)).toBe(false);
 for(const flag of ['--assume-unchanged','--skip-worktree']){
  git(root,'update-index',flag,'libs/mod');
  const before=flags(root);
  // The shortcut the old check relied on: the superproject's own comparison now sees nothing.
  expect(git(root,'diff-files','--name-only','--ignore-submodules=dirty')).toBe('');
  expect(git(root,'status','--porcelain','--ignore-submodules=none')).toBe('');
  expect(await checkoutMatches(root,old)).toBe(false);
  expect(flags(root)).toBe(before);
  git(root,'update-index',flag.replace('--','--no-'),'libs/mod');
 }
 // Back at the recorded commit: matches with either flag, and edits inside the submodule are its own.
 git(root,'-C','libs/mod','checkout','-q',s1);
 await writeFile(join(root,'libs/mod/s.txt'),'edited inside\n');
 git(root,'update-index','--skip-worktree','libs/mod');
 expect(await checkoutMatches(root,old)).toBe(true);
 git(root,'update-index','--no-skip-worktree','libs/mod');
 git(root,'-C','libs/mod','checkout','-q','--','s.txt');
});

it('accepts an unpopulated submodule only as an empty directory, and never a populated one whose HEAD cannot be read',async()=>{
 const {root,old}=await withSubmodule();
 const mod=join(root,'libs/mod'),gitFile=await readFile(join(mod,'.git'),'utf8');
 // A .git file whose repository is gone: Git would call that HEAD unchanged; it is not proven.
 await writeFile(join(mod,'.git'),'gitdir: /nonexistent/modules/mod\n');
 expect(await checkoutMatches(root,old)).toBe(false);
 await writeFile(join(mod,'.git'),gitFile);
 await rm(mod,{recursive:true,force:true});
 expect(await checkoutMatches(root,old)).toBe(false);
 await mkdir(mod);
 expect(await checkoutMatches(root,old)).toBe(true);
 await writeFile(join(mod,'stray.txt'),'not a checkout\n');
 expect(await checkoutMatches(root,old)).toBe(false);
});

it('refuses before any side effect a checkout whose flags hide a moved submodule, an edited file or a sparse path the move changes',async()=>{
 const {root,old,tip,s2}=await withSubmodule();
 const untouched=()=>{expect(git(root,'rev-parse','dev')).toBe(old);expect(backups(root)).toBe('');expect(quarantined()).toEqual([]);};
 git(root,'-C','libs/mod','checkout','-q',s2);git(root,'update-index','--assume-unchanged','libs/mod');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_worktree_dirty'});
 untouched();expect(git(root,'-C','libs/mod','rev-parse','HEAD')).toBe(s2);
 git(root,'update-index','--no-assume-unchanged','libs/mod');git(root,'submodule','-q','update','--checkout');
 await writeFile(join(root,'old.txt'),'edited\n');git(root,'update-index','--assume-unchanged','old.txt');
 expect(git(root,'status','--porcelain')).toBe('');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_worktree_dirty'});
 untouched();expect(await readFile(join(root,'old.txt'),'utf8')).toBe('edited\n');
 git(root,'update-index','--no-assume-unchanged','old.txt');git(root,'checkout','-q','--','old.txt');
 // old.txt changes with the move (reset removes it); skip-worktree would leave no file to verify.
 git(root,'update-index','--skip-worktree','old.txt');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_sparse_unsupported'});
 untouched();
 git(root,'update-index','--no-skip-worktree','old.txt');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await checkoutMatches(root,tip)).toBe(true);expect(quarantined()).toEqual([]);
});

/** Repository A and its clone B have the same commits; the Location reaches A through a symlink. */
async function twoRepositories(){
 const a=join(sandbox,'a'),b=join(sandbox,'b'),alias=join(sandbox,'location');
 const {old,tip}=await initRepo(a);
 git(sandbox,'clone','-q','--no-local',a,b);person(b);git(b,'branch','-q','-f','master','origin/master');git(b,'checkout','-q','dev');
 expect(git(b,'rev-parse','dev')).toBe(old);expect(git(b,'rev-parse','master')).toBe(tip);
 await symlink(a,alias);
 return {a,b,alias,old,tip,repoint:async(to:string)=>{await unlink(alias);await symlink(to,alias);}};
}

it('never replays an answer recorded in another repository: a Location re-pointed to a clone with the same commits is refused, and neither repository is isolated by it',async()=>{
 const {a,b,alias,old,tip,repoint}=await twoRepositories();
 const frame=alignFrame(old,tip);
 expect(await executeGitBranchAlign(alias,frame)).toMatchObject({ok:true,outcome:'aligned'});
 expect(git(a,'rev-parse','dev')).toBe(tip);expect(quarantined()).toEqual([]);
 await repoint(b);
 for(const fresh of [false,true]){
  if(fresh)restart();
  expect(await executeGitBranchAlign(alias,again(frame))).toMatchObject({ok:false,error:'workspace_branch_align_repository_changed',outcome:null});
  expect(git(b,'rev-parse','dev')).toBe(old);expect(backups(b)).toBe('');
  expect(quarantined()).toEqual([]);expect(await admission(b)).toBe('admitted');expect(await admission(a)).toBe('admitted');
 }
 // Back at A, the same redelivery replays its own answer.
 await repoint(a);
 expect(await executeGitBranchAlign(alias,again(frame))).toMatchObject({ok:true,outcome:'aligned',aligned_commit:tip});
});

it('never continues an intent in another repository: a byte copy holding the same commits and backup ref is untouched, the old repository stays isolated by its own record and recovers once the Location names it again',async()=>{
 const {a,b,alias,old,tip,repoint}=await twoRepositories();
 const frame=alignFrame(old,tip);
 // Crash after the ref transaction, before the checkout followed.
 branchAlignBarriers.beforeWorktree=async()=>{throw new Error('crash after transaction');};
 await expect(executeGitBranchAlign(alias,frame)).rejects.toThrow('crash after transaction');
 delete branchAlignBarriers.beforeWorktree;
 expect(git(a,'rev-parse','dev')).toBe(tip);expect(existsSync(join(a,'c.txt'))).toBe(false);
 expect(JSON.parse(await readFile(journalOf(LOCATION,frame.operation_id),'utf8'))).toMatchObject({state:'intent',common_dir:commonDirOf(a)});
 // B becomes an exact copy of A in that state: same commits, same backup ref, same old files.
 await rm(b,{recursive:true,force:true});execFileSync('cp',['-a',a,b]);
 expect(backups(b)).toBe(backups(a));
 await repoint(b);
 const unchanged=async()=>{expect(git(b,'rev-parse','dev')).toBe(tip);expect(existsSync(join(b,'c.txt'))).toBe(false);expect(git(b,'write-tree')).toBe(git(b,'rev-parse',`${old}^{tree}`));};
 expect(await executeGitBranchAlign(alias,again(frame))).toMatchObject({ok:false,error:'workspace_branch_align_repository_changed'});
 await unchanged();
 restart();
 const log:string[]=[];
 await recoverBranchAlignments(async()=>alias,{},line=>log.push(line));
 expect(log.join('\n')).toContain('no longer resolves');
 await unchanged();expect(await admission(b)).toBe('admitted');
 expect(await quarantinedRepos()).toEqual([commonDirOf(a)]);expect(await admission(a)).toBe('workspace_repository_recovery_required');
 // The Location names A again: a restart finishes the checkout in A from its facts and releases it.
 await repoint(a);restart();
 await recoverBranchAlignments(async()=>alias);
 expect(quarantined()).toEqual([]);expect(await readFile(join(a,'c.txt'),'utf8')).toBe('c\n');
 expect(await executeGitBranchAlign(alias,again(frame))).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 await unchanged();
});

it('trusts a journal at Host start only through its envelope: a copy under another Location or operation, an edited meaning or repository, is not acted on and isolates nothing',async()=>{
 const {a,b,old,tip}=await twoRepositories();
 const frame=alignFrame(old,tip);
 branchAlignBarriers.beforeTransaction=async()=>{throw new Error('crash after intent');};
 await expect(executeGitBranchAlign(a,frame)).rejects.toThrow('crash after intent');
 delete branchAlignBarriers.beforeTransaction;
 const original=journalOf(LOCATION,frame.operation_id),saved=await readFile(original,'utf8');
 const journal=JSON.parse(saved) as {meaning:{expected_target_commit:string};common_dir:string};
 // The genuine journal and its record are moved aside; only the planted copies remain.
 await rm(original);await rm(join(quarantineDir(),`${frame.operation_id}.json`));restart();
 const planted=[journalOf(OTHER_LOCATION,frame.operation_id),journalOf(LOCATION,randomUUID())];
 for(const path of planted){await mkdir(dirname(path),{recursive:true});await writeFile(path,saved);}
 const edited=journalOf(LOCATION,frame.operation_id);
 await writeFile(edited,JSON.stringify({...journal,meaning:{...journal.meaning,expected_target_commit:old}}));
 const log:string[]=[];
 await recoverBranchAlignments(async()=>b,{},line=>log.push(line));
 expect(log.filter(l=>l.includes('does not match its path'))).toHaveLength(3);
 expect(quarantined()).toEqual([]);
 // A consistent envelope naming another repository than the Location's, with no record: not corroborated.
 await writeFile(edited,JSON.stringify({...journal,common_dir:commonDirOf(b)}));
 await recoverBranchAlignments(async()=>a,{},line=>log.push(line));
 expect(log.some(l=>l.includes('not corroborated'))).toBe(true);
 expect(quarantined()).toEqual([]);
 for(const dir of [a,b]){expect(git(dir,'rev-parse','dev')).toBe(old);expect(backups(dir)).toBe('');expect(await admission(dir)).toBe('admitted');}
 // The genuine journal back in place recovers normally.
 await writeFile(original,saved);
 await recoverBranchAlignments(async()=>a);
 expect(await executeGitBranchAlign(a,again(frame))).toMatchObject({ok:false,error:'workspace_branch_align_interrupted'});
 expect(quarantined()).toEqual([]);
});

it('refuses a journal whose record names another repository, and a changed Location root, while keeping the record\'s repository isolated',async()=>{
 const {a,b,old,tip}=await twoRepositories();
 const frame=alignFrame(old,tip);
 branchAlignBarriers.beforeTransaction=async()=>{throw new Error('crash after intent');};
 await expect(executeGitBranchAlign(a,frame)).rejects.toThrow('crash after intent');
 delete branchAlignBarriers.beforeTransaction;
 const path=journalOf(LOCATION,frame.operation_id),journal=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
 // The Location's configured root is now B itself (no symlink involved).
 expect(await executeGitBranchAlign(b,again(frame))).toMatchObject({ok:false,error:'workspace_branch_align_repository_changed'});
 // An edited journal naming B while A's record stands: not acted on at start, A stays isolated, B untouched.
 await writeFile(path,JSON.stringify({...journal,common_dir:commonDirOf(b)}));restart();
 const log:string[]=[];
 await recoverBranchAlignments(async()=>b,{},line=>log.push(line));
 expect(log.some(l=>l.includes('different repositories'))).toBe(true);
 expect(await quarantinedRepos()).toEqual([commonDirOf(a)]);
 expect(git(b,'rev-parse','dev')).toBe(old);expect(await admission(b)).toBe('admitted');
 // Admission of A does not trust the edited journal either.
 expect(await admission(a)).toBe('workspace_repository_recovery_required');
});

/** dev tracks the directory `docs/` (nested file, symlink, special name); master replaces it with a file. Neighbours sort next to it. */
async function dirToFile(){
 const root=join(sandbox,'dirs');await mkdir(root);git(root,'init','-q','-b','master');person(root);
 await commit(root,'.gitignore','*.log\n','ignore logs');
 for(const neighbour of ['docs.txt','docs-x/keep.txt','docs0'])await commit(root,neighbour,`${neighbour}\n`,`add ${neighbour}`);
 git(root,'checkout','-q','-b','dev');
 await commit(root,'docs/a.md','a\n','docs');await commit(root,'docs/sub dir/"q" ü.md','q\n','nested special name');
 await symlink('a.md',join(root,'docs/link'));git(root,'add','docs/link');git(root,'commit','-qm','link');
 const old=git(root,'rev-parse','HEAD');
 git(root,'checkout','-q','master');const tip=await commit(root,'docs','now a file\n','docs becomes a file');
 git(root,'checkout','-q','dev');
 return {root,old,tip};
}

it('turns a clean tracked directory into a file and back, never by name prefix, while ignored neighbours stay',async()=>{
 const {root,old,tip}=await dirToFile();
 // Ignored files beside it (and under a neighbour that sorts next to it) are not in the way.
 await writeFile(join(root,'docs.log'),'beside\n');await writeFile(join(root,'docs-x/run.log'),'neighbour\n');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await readFile(join(root,'docs'),'utf8')).toBe('now a file\n');
 expect(await readFile(join(root,'docs.log'),'utf8')).toBe('beside\n');expect(await readFile(join(root,'docs-x/run.log'),'utf8')).toBe('neighbour\n');
 expect(await checkoutMatches(root,tip,['docs.log','docs-x/run.log'])).toBe(true);expect(quarantined()).toEqual([]);
 // file → directory: the tracked file is replaced by the directory.
 const back={...alignFrame(tip,old),source_ref:'refs/heads/dev',target_ref:'refs/heads/side'};
 git(root,'branch','side',old);
 expect(await executeGitBranchAlign(root,back)).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await readlink(join(root,'docs/link'))).toBe('a.md');expect(await readFile(join(root,'docs/sub dir/"q" ü.md'),'utf8')).toBe('q\n');
 expect(quarantined()).toEqual([]);
});

it('refuses a directory → file move before any side effect while the directory holds anything the move does not remove, and keeps it',async()=>{
 const {root,old,tip}=await dirToFile();
 const extras:Array<[string,(at:string)=>Promise<void>]>=[
  ['docs/notes.log',at=>writeFile(at,'mine\n')],
  ['docs/sub dir/deep/cache.log',async at=>{await mkdir(dirname(at),{recursive:true});await writeFile(at,'deep\n');}],
  ['docs/mine.log',at=>symlink('/etc/hostname',at)],
 ];
 for(const [path,make] of extras){
  const at=join(root,path);await make(at);
  expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_untracked_in_the_way'});
  expect(git(root,'rev-parse','dev')).toBe(old);expect(backups(root)).toBe('');expect(quarantined()).toEqual([]);
  expect(await lstat(at).then(()=>true,()=>false)).toBe(true);expect(await readFile(join(root,'docs/a.md'),'utf8')).toBe('a\n');
  await rm(at,{recursive:true,force:true});
 }
 // A visible untracked file below it is refused as a dirty checkout (nothing moved either).
 await writeFile(join(root,'docs/draft.md'),'draft\n');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_worktree_dirty'});
 expect(await readFile(join(root,'docs/draft.md'),'utf8')).toBe('draft\n');expect(git(root,'rev-parse','dev')).toBe(old);
 await copyFile(join(root,'docs/draft.md'),join(sandbox,'kept.md'));await rm(join(root,'docs/draft.md'));
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:true,outcome:'aligned'});
});

it('judges submodules on its temporary index with core.ignoreStat=false: under the person\'s ignoreStat=true a correct one matches and aligns, a stale or unreadable one does not, their configuration and flags stay',async()=>{
 const {root,old,tip,s2}=await withSubmodule();
 git(root,'config','core.ignoreStat','true');git(root,'update-index','--assume-unchanged','a.txt');
 const before=flags(root),kept=()=>{expect(flags(root)).toBe(before);expect(git(root,'config','core.ignoreStat')).toBe('true');};
 expect(await checkoutMatches(root,old)).toBe(true);kept();
 git(root,'-C','libs/mod','checkout','-q',s2);
 expect(await checkoutMatches(root,old)).toBe(false);kept();
 git(root,'submodule','-q','update','--checkout');
 const mod=join(root,'libs/mod'),gitFile=await readFile(join(mod,'.git'),'utf8');
 await writeFile(join(mod,'.git'),'gitdir: /nonexistent/modules/mod\n');
 expect(await checkoutMatches(root,old)).toBe(false);kept();
 await writeFile(join(mod,'.git'),gitFile);
 // A crash after the ref transaction: Host-start recovery finishes the checkout, proves it and releases the isolation.
 branchAlignBarriers.beforeWorktree=async()=>{throw new Error('crash after transaction');};
 await expect(executeGitBranchAlign(root,alignFrame(old,tip))).rejects.toThrow('crash after transaction');
 delete branchAlignBarriers.beforeWorktree;
 expect(await admission(root)).toBe('workspace_repository_recovery_required');
 restart();await recoverBranchAlignments(async()=>root);
 expect(quarantined()).toEqual([]);expect(await admission(root)).toBe('admitted');
 expect(await readFile(join(root,'c.txt'),'utf8')).toBe('c\n');expect(await checkoutMatches(root,tip)).toBe(true);
 expect(git(root,'config','core.ignoreStat')).toBe('true');
 // And a live alignment back, with the person's flags on, aligns rather than calling the clean submodule dirty.
 git(root,'branch','side',old);
 expect(await executeGitBranchAlign(root,{...alignFrame(tip,old),target_ref:'refs/heads/side'})).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await checkoutMatches(root,old)).toBe(true);expect(quarantined()).toEqual([]);
});

/** dev holds two symlinks (one with a special name, one target holding a newline) under `eol=crlf`; master is dev plus c.txt. */
async function withLinks(){
 const root=join(sandbox,'links');await mkdir(root);git(root,'init','-q','-b','master');person(root);
 await commit(root,'.gitattributes','* text eol=crlf\n','attributes');
 git(root,'checkout','-q','-b','dev');
 const names=['plain','sub/"q" ü\\ é link'];
 await mkdir(join(root,'sub'));await symlink('a.md',join(root,names[0]!));await symlink('tar\nget',join(root,names[1]!));
 git(root,'add','--',...names);git(root,'commit','-qm','links');const old=git(root,'rev-parse','HEAD');
 git(root,'checkout','-q','-B','master');const tip=await commit(root,'c.txt','c\n','reviewed');
 git(root,'checkout','-q','dev');
 const placeholders=async()=>{git(root,'config','core.symlinks','false');for(const n of names)await rm(join(root,n));git(root,'checkout','-q','--',...names);};
 return {root,old,tip,names,placeholders};
}

it('accepts Git\'s symlink placeholders under core.symlinks=false by their raw bytes, never through the path\'s EOL filters, and keeps real symlinks valid',async()=>{
 const {root,old,names,placeholders}=await withLinks();
 const [plain,special]=names.map(n=>join(root,n)) as [string,string];
 expect(await checkoutMatches(root,old)).toBe(true);
 await placeholders();
 expect((await lstat(special)).isFile()).toBe(true);expect(await readFile(special,'utf8')).toBe('tar\nget');
 expect(git(root,'status','--porcelain')).toBe('');
 expect(await checkoutMatches(root,old)).toBe(true);
 // CRLF bytes: the path's eol=crlf clean filter would hash them to the blob; the raw bytes do not.
 await writeFile(special,'tar\r\nget');
 expect(git(root,'hash-object','--',names[1]!)).toBe(git(root,'rev-parse',`${old}:${names[1]!}`));
 expect(await checkoutMatches(root,old)).toBe(false);
 await writeFile(special,'other');expect(await checkoutMatches(root,old)).toBe(false);
 await rm(special);await mkdir(special);expect(await checkoutMatches(root,old)).toBe(false);
 await rm(special,{recursive:true});await symlink('tar\nget',special);
 // A real symlink still counts under core.symlinks=false, with its own target checked.
 expect(await checkoutMatches(root,old)).toBe(true);
 await rm(plain);await symlink('b.md',plain);expect(await checkoutMatches(root,old)).toBe(false);
 await rm(plain);await writeFile(plain,'a.md');expect(await checkoutMatches(root,old)).toBe(true);
 // Switched back to core.symlinks=true, a placeholder is the wrong type; real links still match.
 git(root,'config','core.symlinks','true');
 expect(await checkoutMatches(root,old)).toBe(false);
 await rm(plain);await symlink('a.md',plain);expect(await checkoutMatches(root,old)).toBe(true);
});

it('aligns a checkout holding symlink placeholders under core.symlinks=false and refuses an edited one before any side effect',async()=>{
 const {root,old,tip,names,placeholders}=await withLinks();
 await placeholders();
 await writeFile(join(root,names[0]!),'a.md\r\n');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:false,error:'workspace_branch_align_worktree_dirty'});
 expect(git(root,'rev-parse','dev')).toBe(old);expect(backups(root)).toBe('');expect(quarantined()).toEqual([]);
 await writeFile(join(root,names[0]!),'a.md');
 expect(await executeGitBranchAlign(root,alignFrame(old,tip))).toMatchObject({ok:true,outcome:'aligned',worktree_updated:true});
 expect(await checkoutMatches(root,tip)).toBe(true);expect(quarantined()).toEqual([]);
 expect((await lstat(join(root,names[1]!))).isFile()).toBe(true);
});
