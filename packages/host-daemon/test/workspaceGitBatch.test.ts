import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,realpath,chmod,symlink,stat,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as folder from '@rainver/folder-read';
import {checkLocationRepository} from '../src/taskWorktree.js';
import {assertWorkspaceCheckoutAllowed,captureSourceBaseline} from '../src/workspaceBaseline.js';
vi.mock('node:child_process',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:child_process')>();
 return {...actual,spawn:vi.fn(actual.spawn)};
});
import {spawn} from 'node:child_process';
let scratch:string,root:string;
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).replace(/\n$/,'');
beforeEach(async()=>{
 scratch=await realpath(await mkdtemp(join(tmpdir(),'rainver-git-batch-')));root=join(scratch,'repo\nwith newline ');await mkdir(root);
 git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
});
afterEach(async()=>{vi.restoreAllMocks();await rm(scratch,{recursive:true,force:true});});
async function initial(){await writeFile(join(root,'base'),'base');git('add','.');git('commit','-qm','initial');}
it('combines repository fields at a newline root, preserves unborn semantics, and rejects linked/nested roots before parsing',async()=>{
 expect(await checkLocationRepository(root)).toEqual({kind:'no_commit'});await initial();
 vi.mocked(spawn).mockClear();
 expect(await checkLocationRepository(root)).toMatchObject({kind:'repository',repo:{root,gitCommonDir:join(root,'.git')}});
 const probes=vi.mocked(spawn).mock.calls.filter(c=>(c[1] as string[]).includes('--is-inside-work-tree'));
 expect(probes).toHaveLength(1);expect(probes[0]![1]).toEqual(expect.arrayContaining(['--show-prefix','--git-common-dir']));
 // Linked and nested roots fail filesystem preconditions; these are not parser negative controls.
 const linked=join(scratch,'linked');git('worktree','add','-qb','linked',linked);
 expect(await checkLocationRepository(linked)).toEqual({kind:'not_git'});
 const nested=join(root,'nested');await mkdir(nested);expect(await checkLocationRepository(nested)).toEqual({kind:'not_git'});
 git('config','core.worktree',scratch);expect(await checkLocationRepository(root)).toMatchObject({kind:'unusable'});
});
it('matches a real Git tree for NUL-sensitive paths, deletions, executable bits, and leaves the source index intact',async()=>{
 await initial();await writeFile(join(root,'deleted'),'remove');git('add','.');git('commit','-qm','deleted baseline');await rm(join(root,'deleted'));
 for(const path of ['-dash','tab\tname','line\nname','trailing ','base'])await writeFile(join(root,path),`bytes:${path}`);
 await chmod(join(root,'base'),0o755);
 const index=await readFile(join(root,'.git','index'));
 const expectedIndex=join(scratch,'expected-index');
 execFileSync('git',['read-tree','HEAD'],{cwd:root,env:{...process.env,GIT_INDEX_FILE:expectedIndex}});
 execFileSync('git',['add','-A'],{cwd:root,env:{...process.env,GIT_INDEX_FILE:expectedIndex}});
 const expected=execFileSync('git',['write-tree'],{cwd:root,env:{...process.env,GIT_INDEX_FILE:expectedIndex},encoding:'utf8'}).trim();
 const checked=await checkLocationRepository(root);if(checked.kind!=='repository')throw Error('fixture');
 vi.mocked(spawn).mockClear();const result=await captureSourceBaseline(checked.repo);
 expect(result.tree).toBe(expected);expect(await readFile(join(root,'.git','index'))).toEqual(index);
 expect(vi.mocked(spawn).mock.calls.filter(c=>(c[1] as string[]).includes('--index-info'))).toHaveLength(2);
 await writeFile(join(root,'base'),'different');expect((await captureSourceBaseline(checked.repo)).tree).not.toBe(expected);
});
it('cleans scratch on a denied symlink and rejects Git after core.worktree changes',async()=>{
 await initial();const checked=await checkLocationRepository(root);if(checked.kind!=='repository')throw Error('fixture');
 vi.mocked(spawn).mockClear();
 await symlink('base',join(root,'link'));
 await expect(captureSourceBaseline(checked.repo)).rejects.toThrow('workspace_checkout_symlink_unsupported');
 const indices=vi.mocked(spawn).mock.calls.map(c=>(c[2] as {env?:NodeJS.ProcessEnv}|undefined)?.env?.GIT_INDEX_FILE).filter((p):p is string=>Boolean(p));
 expect(indices.length).toBeGreaterThan(0);
 for(const index of new Set(indices))await expect(stat(dirname(index))).rejects.toMatchObject({code:'ENOENT'});
 await rm(join(root,'link'));git('config','core.worktree',scratch);
 expect((await folder.runLocationGit(['status','--porcelain'],root)).code).not.toBe(0);
});

it('revalidates a full OID when a replace ref changes the selected checkout tree',async()=>{
 await initial();const oid=git('rev-parse','HEAD');
 await assertWorkspaceCheckoutAllowed(root,oid);
 await writeFile(join(root,'.env'),'SYNTHETIC_FIXTURE_ONLY=yes');git('add','-f','.env');git('commit','-qm','forbidden checkout');
 const replacement=git('rev-parse','HEAD');git('replace',oid,replacement);
 await expect(assertWorkspaceCheckoutAllowed(root,oid)).rejects.toThrow('workspace_checkout_forbidden_path');
 git('replace','-d',oid);await assertWorkspaceCheckoutAllowed(root,oid);
});
it('splits large NUL batches without losing paths or changing the output tree',async()=>{
 await initial();const dir=Array.from({length:16},(_,i)=>String.fromCharCode(97+i).repeat(210)).join('/');
 await mkdir(join(root,dir),{recursive:true});
 for(let i=0;i<20;i++)await writeFile(join(root,dir,`file-${i}`),'content');
 const checked=await checkLocationRepository(root);if(checked.kind!=='repository')throw Error('fixture');
 vi.mocked(spawn).mockClear();const result=await captureSourceBaseline(checked.repo);
 expect(vi.mocked(spawn).mock.calls.filter(c=>(c[1] as string[]).includes('--index-info'))).toHaveLength(4);
 const paths=git('ls-tree','-r','--name-only','-z',result.tree).split('\0').filter(Boolean);
 expect(paths).toHaveLength(21);expect(paths).toContain(`${dir}/file-19`);
});

it('retains the special-file refusal when a tracked regular file becomes a directory',async()=>{
 await initial();const checked=await checkLocationRepository(root);if(checked.kind!=='repository')throw Error('fixture');
 const index=await readFile(join(root,'.git','index'));
 await rm(join(root,'base'));await mkdir(join(root,'base'));await writeFile(join(root,'base','child'),'content');
 await expect(captureSourceBaseline(checked.repo)).rejects.toThrow('workspace_snapshot_special_file');
 expect(await readFile(join(root,'.git','index'))).toEqual(index);
});

it('matches git add -A for index-info directory replacement but refuses capture of the obstructed child',async()=>{
 await initial();await mkdir(join(root,'a'));await writeFile(join(root,'a','b'),'tracked child');
 git('add','.');git('commit','-qm','tracked directory');
 const index=await readFile(join(root,'.git','index'));
 await rm(join(root,'a'),{recursive:true});await writeFile(join(root,'a'),'replacement file');
 const expectedIndex=join(scratch,'expected-index'),env={...process.env,GIT_INDEX_FILE:expectedIndex};
 execFileSync('git',['read-tree','HEAD'],{cwd:root,env});
 execFileSync('git',['add','-A'],{cwd:root,env});
 const expected=execFileSync('git',['write-tree'],{cwd:root,env,encoding:'utf8'}).trim();
 const checked=await checkLocationRepository(root);if(checked.kind!=='repository')throw Error('fixture');
 const batchIndex=join(scratch,'batch-index'),batchEnv={...process.env,GIT_INDEX_FILE:batchIndex};
 execFileSync('git',['read-tree','HEAD'],{cwd:root,env:batchEnv});
 const blob=git('hash-object','-w','--no-filters','a');
 execFileSync('git',['update-index','-z','--index-info'],{cwd:root,env:batchEnv,input:`100644 ${blob}\ta\0`});
 const tree=execFileSync('git',['write-tree'],{cwd:root,env:batchEnv,encoding:'utf8'}).trim();
 expect(tree).toBe(expected);
 expect(git('ls-tree','-r','--name-only',tree).split('\n')).toEqual(['a','base']);
 // The complete capture still reads a/b and refuses its non-directory ancestor.
 await expect(captureSourceBaseline(checked.repo)).rejects.toMatchObject({code:'not_directory'});
 expect(await readFile(join(root,'.git','index'))).toEqual(index);
});
