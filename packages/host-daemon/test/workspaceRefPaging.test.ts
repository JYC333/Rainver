import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {listRainverRefs,ownedWorkspaceRefs} from '../src/workspaceRetention.js';

/**
 * Ref inventories page by streaming Git's sorted output (Git 2.43 has no
 * `for-each-ref --start-after`): bounded however many refs exist, exact at
 * page boundaries, in Git's byte order, never skipping, repeating or looping.
 */
let repoDir:string,head:string;
const gitAt=(dir:string,args:string[],input?:string)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',maxBuffer:64*1024*1024,...(input!==undefined?{input}:{})}).trim();
const git=(args:string[],input?:string)=>gitAt(repoDir,args,input);
const createAt=(dir:string,commit:string,names:string[])=>gitAt(dir,['update-ref','--stdin'],names.map(n=>`create ${n} ${commit}\n`).join(''));
const create=(names:string[])=>createAt(repoDir,head,names);
const hex=(i:number)=>i.toString(16).padStart(40,'0');
/** A fresh repository with one commit; returns its directory and HEAD. */
async function initRepo(){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'rainver-paging-repo-')));
 gitAt(dir,['init','-q','-b','main']);gitAt(dir,['config','user.email','p@example.com']);gitAt(dir,['config','user.name','P']);
 await writeFile(join(dir,'README.md'),'x\n');gitAt(dir,['add','.']);gitAt(dir,['commit','-qm','initial']);
 return {dir,commit:gitAt(dir,['rev-parse','HEAD'])};
}
beforeAll(async()=>{({dir:repoDir,commit:head}=await initRepo());});
afterAll(async()=>{await rm(repoDir,{recursive:true,force:true});});

/** Every page from the start, following the cursor; fails on a repeat or a runaway. */
async function walk<T>(page:(after?:string)=>Promise<{items:T[];next:string|null}>,key:(t:T)=>string){
 const seen:string[]=[];let after:string|undefined;
 for(let round=0;round<1000;round++){
  const p=await page(after);
  seen.push(...p.items.map(key));
  if(p.next===null)return {seen,pages:round+1};
  expect(p.next).not.toBe(after);
  after=p.next;
 }
 throw new Error('pager did not terminate');
}

describe('owned-ref pages at exact boundaries',()=>{
 for(const count of [200,201,400,401]){
  it(`${count} refs`,async()=>{
   const ref={id:randomUUID(),generation:1};
   const names=Array.from({length:count},(_,i)=>`refs/rainver/recovery/${ref.id}/${hex(i)}`);
   create(names);
   const {seen,pages}=await walk(async after=>{const p=await ownedWorkspaceRefs(repoDir,ref,after);expect(p.owned_refs.length).toBeLessThanOrEqual(200);return {items:p.owned_refs,next:p.owned_refs_next};},r=>r.ref);
   expect(seen).toEqual(names); // sorted, nothing skipped or repeated
   expect(pages).toBe(Math.ceil(count/200));
  });
 }
});

describe('Location inventory beyond any output budget',()=>{
 it('pages 70,000 refs (more than 8 MiB of for-each-ref output) from the start, a deep cursor and the end',async()=>{
  // The lowest version-4 UUID sorts before every randomUUID() group the other
  // tests created, so the deep cursor below is never on the last page.
  const id='00000000-0000-4000-8000-000000000000',names=Array.from({length:70_000},(_,i)=>`refs/rainver/recovery/${id}/${hex(i)}`);
  create(names);git(['pack-refs','--all']);
  expect(git(['for-each-ref','refs/rainver/']).length).toBeGreaterThan(8*1024*1024);
  const before=await listRainverRefs(repoDir);
  const all=git(['for-each-ref','--format=%(refname)','refs/rainver/']).split('\n');
  expect(before.refs.map(r=>r.ref)).toEqual(all.slice(0,500));
  expect(before.next).toBe(all[499]);
  const at=all.indexOf(names[69_700]!),rest=all.slice(at+1);
  expect(rest.length).toBeGreaterThan(500); // a deep cursor that is not on the last page
  const deep=await listRainverRefs(repoDir,names[69_700]);
  expect(deep.refs.map(r=>r.ref)).toEqual(rest.slice(0,500));
  expect(deep.next).toBe(rest.length>500?rest[499]:null); // strict limit+1: a cursor only when more remain
  // Following the deep cursor reaches the end with nothing skipped or repeated.
  const tail=await walk(async after=>{const p=await listRainverRefs(repoDir,after??names[69_700]);return {items:p.refs,next:p.next};},r=>r.ref);
  expect(tail.seen).toEqual(rest);
  expect(tail.pages).toBe(Math.ceil(rest.length/500));
  const last=await listRainverRefs(repoDir,all.at(-301));
  expect(last.refs.map(r=>r.ref)).toEqual(all.slice(-300));
  expect(last.next).toBeNull();
  const end=await listRainverRefs(repoDir,all.at(-1));
  expect(end).toEqual({refs:[],next:null});
 },120_000);
});

describe('Location inventory at exact page boundaries',()=>{
 // An isolated repository: every ref here is known, so each remainder is exact.
 let dir:string,names:string[];
 beforeAll(async()=>{
  const repo=await initRepo();dir=repo.dir;
  names=Array.from({length:1001},(_,i)=>`refs/rainver/recovery/${randomUUID()}/${hex(i)}`);
  createAt(dir,repo.commit,names);
  names=gitAt(dir,['for-each-ref','--format=%(refname)','refs/rainver/']).split('\n'); // Git's order
  expect(names).toHaveLength(1001);
 });
 afterAll(async()=>{await rm(dir,{recursive:true,force:true});});
 for(const remaining of [499,500,501]){
  it(`${remaining} refs after a deep cursor`,async()=>{
   const rest=names.slice(-remaining),cursor=names.at(-remaining-1)!;
   const page=await listRainverRefs(dir,cursor);
   expect(page.refs.map(r=>r.ref)).toEqual(rest.slice(0,500));
   expect(page.next).toBe(remaining>500?rest[499]:null);
   if(page.next!==null)expect(await listRainverRefs(dir,page.next)).toEqual({refs:[expect.objectContaining({ref:rest[500]})],next:null});
  });
 }
 it('walks 1001 refs from the start in three pages',async()=>{
  const {seen,pages}=await walk(async after=>{const p=await listRainverRefs(dir,after);return {items:p.refs,next:p.next};},r=>r.ref);
  expect(seen).toEqual(names);
  expect(pages).toBe(3);
 });
});

describe('cursor order is Git\'s byte order',()=>{
 it('continues after a name whose UTF-16 order differs from its UTF-8 byte order',async()=>{
  const ref={id:randomUUID(),generation:1};
  const replacement=`refs/rainver/recovery/${ref.id}/a�`,emoji=`refs/rainver/recovery/${ref.id}/a\u{1F600}`;
  create([replacement,emoji]);
  // Git sorts EF BF BD before F0 9F 98 80; a UTF-16 comparison would drop the emoji name after the cursor.
  expect((await ownedWorkspaceRefs(repoDir,ref)).owned_refs.map(r=>r.ref)).toEqual([replacement,emoji]);
  expect((await ownedWorkspaceRefs(repoDir,ref,replacement)).owned_refs.map(r=>r.ref)).toEqual([emoji]);
 });
});
