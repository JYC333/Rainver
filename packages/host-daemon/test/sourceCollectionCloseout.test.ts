import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {SourceExecutionSchema,SourceResponseSchema,type SourceExecution} from '@rainver/protocol';
import {runSourceCollection} from '../src/sourceCollection.js';
import {runSourceExecution,sourceCpuWithinLimit} from '../src/sourceExecution.js';
import {acquireSourceCollectionLease,releaseSourceCollectionLease,recoverSourceExecutions,sourceOwner} from '../src/sourceOwnership.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(code='export default()=>({items:[],next_urls:[]})'){
 const root=await mkdtemp(join(tmpdir(),'source-closeout-'));roots.push(root);
 const host={root,node:process.execPath,maxConcurrent:1,bwrap:process.env.SOURCE_EXECUTION_BWRAP,cgroupRoot:process.env.SOURCE_EXECUTION_CGROUP_ROOT};
 const execution:SourceExecution={execution_id:randomUUID(),code,version_sha256:createHash('sha256').update(code).digest('hex'),input_json:'{}',limits:{wall_ms:10000,memory_bytes:268435456,cpu_quota_percent:29,processes:32,requests:4,output_bytes:65536},collection:{collection_id:randomUUID(),authorization_sha256:'b'.repeat(64),seeds:['https://fixture.test/page'],max_items:10}};
 return {host,execution};
}
const signal=()=>new AbortController().signal;
it('404 is one physical send; deterministic scope, quota and contract errors never retry',async()=>{
 for(const code of ['404','source_scope_refused','source_authority_revoked','source_quota_exhausted','source_request_limit','invalid-response']){
  const {host,execution}=await fixture();let hits=0;
  const result=await runSourceCollection(host,execution,async()=>{hits++;if(code==='404')return {sequence:1,status:404,body_base64:'',content_type:'text/plain'};if(code==='invalid-response')return {sequence:1,status:200,body_base64:'?',content_type:'text/plain'};throw new Error(code);},signal());
  expect(result.status).toBe('failed');expect(hits,code).toBe(1);
 }
});
it.for(['timeout','cancel'])('preserves %s for an in-flight broker, without retry and with reusable lease',async(mode)=>{
 const {host,execution}=await fixture();execution.limits.wall_ms=mode==='timeout'?500:10000;
 const controller=new AbortController();let hits=0;
 const result=await runSourceCollection(host,execution,async(_request,abort)=>{
  hits++;if(mode==='cancel')setTimeout(()=>controller.abort(),30);
  return new Promise((_resolve,reject)=>{
   const stop=()=>reject(abort.reason);if(abort.aborted)stop();else abort.addEventListener('abort',stop,{once:true});
  });
 },controller.signal);
 expect(result).toMatchObject({status:mode==='cancel'?'cancelled':'timed_out',error:mode==='cancel'?'source_cancelled':'source_timeout'});
 expect(hits).toBe(1);
 const dir=join(host.root,'collections',execution.collection!.collection_id);
 expect(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).sends).toBe(1);
 await expect(readFile(join(dir,'lease','owner'))).rejects.toMatchObject({code:'ENOENT'});
 // Same collection/root and fingerprint: a new attempt reaches its broker,
 // rather than remaining busy or retaining the old cancellation signal.
 execution.execution_id=randomUUID();
 const next=await runSourceCollection(host,execution,async()=>{hits++;return {sequence:1,status:404,body_base64:'',content_type:'text/plain'};},signal());
 expect(next).toMatchObject({status:'failed',error:'source_upstream_refused'});expect(hits).toBe(2);
 expect(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).sends).toBe(2);
 await expect(readFile(join(dir,'lease','owner'))).rejects.toMatchObject({code:'ENOENT'});
});
it('classifies unknown broker failures without pretending they are output errors or cancellation',async()=>{
 const {host,execution}=await fixture();let hits=0;
 const result=await runSourceCollection(host,execution,async()=>{hits++;throw new Error('unexpected transport detail');},signal());
 expect(result).toEqual({status:'failed',output_json:null,error:'source_collection_failed'});expect(hits).toBe(1);
});
it('keeps public input at 1MiB bytes and response bodies at 8MiB decoded',async()=>{
 const {host,execution}=await fixture();
 expect(SourceExecutionSchema.safeParse({...execution,input_json:JSON.stringify('界'.repeat(350000))}).success).toBe(false);
 const body=Buffer.alloc(8*1024*1024).toString('base64');
 expect(SourceResponseSchema.safeParse({sequence:1,status:200,body_base64:body,content_type:'x'}).success).toBe(true);
 const response={sequence:1,status:200,body_base64:Buffer.alloc(8*1024*1024+1).toString('base64'),content_type:'x'};
 expect(SourceResponseSchema.safeParse(response).success).toBe(false);
 expect(await runSourceExecution(host,execution,async()=>response,signal(),{url:'https://fixture.test',response,links:[],link_coverage:{discovered_links:0,provided_links:0,truncated_pages:0}})).toMatchObject({status:'refused',error:'source_collection_input_limit'});
});
it('uses exact bounded CPU comparisons, including percentages and extreme kernel values',()=>{
 for(let n=1;n<=100;n++){expect(sourceCpuWithinLimit(n*1000,100000,n)).toBe(true);expect(sourceCpuWithinLimit(n*1000+1,100000,n)).toBe(false);}
 for(const args of [[0,100000,29],[1,0,29],[Infinity,100000,100],[Number.MAX_SAFE_INTEGER+1,100000,100],[1,100000,101],[1,100000,-1],[1,1000001,100]])expect(sourceCpuWithinLimit(...args as [number,number,number])).toBe(false);
 expect(sourceCpuWithinLimit(Number.MAX_SAFE_INTEGER,1000000,100)).toBe(false);
});
it('publishes one complete lease under competing workers and recovers pre/post-publication crashes',async()=>{
 const {host,execution}=await fixture();const dir=join(host.root,'collections',execution.collection!.collection_id);await mkdir(dir,{recursive:true});
 // A real worker is stopped at either side of the atomic link publication.
 for(const published of [false,true]){
  const child=spawn(process.execPath,['--input-type=module','-e',`
   import {readFile,writeFile,link,mkdir} from 'node:fs/promises';import {join} from 'node:path';
   const dir=process.argv[1],published=process.argv[2]==='true';
   const stat=await readFile('/proc/self/stat','utf8');const identity=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
   const name='.lease-'+process.pid+'-'+identity.replace(':','_')+'-00000000-0000-4000-8000-000000000000';
   await writeFile(join(dir,name),published?JSON.stringify({pid:process.pid,identity}):'');
   await mkdir(join(dir,'lease'),{recursive:true});if(published)await link(join(dir,name),join(dir,'lease','owner'));
   process.stdout.write('ready');setInterval(()=>{},1000);`,dir,String(published)],{stdio:['ignore','pipe','pipe']});
  const closed=new Promise<void>(r=>child.once('close',()=>r()));
  try{
   await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>reject(new Error('worker exited '+code)));});
   if(published){await expect(acquireSourceCollectionLease(dir)).rejects.toMatchObject({code:'EEXIST'});await expect(recoverSourceExecutions(host)).rejects.toThrow('source_execution_root_busy');}
   else{await acquireSourceCollectionLease(dir);expect(JSON.parse(await readFile(join(dir,'lease','owner'),'utf8'))).toEqual(await sourceOwner());await releaseSourceCollectionLease(dir);}
  }finally{child.kill('SIGKILL');await closed;}
  await recoverSourceExecutions(host);
  expect(await readdir(dir)).toEqual([]);
 }
 const results=await Promise.allSettled([acquireSourceCollectionLease(dir),acquireSourceCollectionLease(dir)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 await recoverSourceExecutions(host);expect(JSON.parse(await readFile(join(dir,'lease','owner'),'utf8'))).toEqual(await sourceOwner());
 await writeFile(join(dir,'unrelated'),'keep');await recoverSourceExecutions(host);expect(await readFile(join(dir,'unrelated'),'utf8')).toBe('keep');
});
describe.skipIf(process.env.SOURCE_EXECUTION_OS_SMOKE!=='1')('round2 actual isolated adapter',()=>{
 it('truncates 150 links with coverage, once, without adding requests',async()=>{
  const {host,execution}=await fixture('export default({input})=>({items:[{links:input.links.length,coverage:input.link_coverage}],next_urls:[]})');let hits=0;
  const result=await runSourceCollection(host,execution,async()=>{hits++;return {sequence:1,status:200,content_type:'text/html',body_base64:Buffer.from(Array.from({length:150},(_,n)=>`<a href="/item/${n}">item</a>`).join('')).toString('base64')};},signal());
  expect(result.status).toBe('succeeded');expect(hits).toBe(1);expect(JSON.parse(result.output_json!)).toMatchObject({items:[{links:100}],coverage:{discovered_links:150,provided_links:100,truncated_pages:1}});
 });
 it('passes >750KiB multibyte and the full 8MiB declared body without widening user input',async()=>{
  for(const body of [Buffer.from('<p>'+'界'.repeat(300000)+'</p>'),Buffer.alloc(8*1024*1024,97)]){
   const {host,execution}=await fixture('export default({input})=>({items:[{bytes:Buffer.from(input.response.body_base64,"base64").length,context:input.context}],next_urls:[]})');let hits=0;
   execution.input_json='{"user":"bounded"}';
   const result=await runSourceCollection(host,execution,async()=>{hits++;return {sequence:1,status:200,content_type:body.length===900007?'text/html; charset=utf-8':'text/plain',body_base64:body.toString('base64')};},signal());
   expect(result.status).toBe('succeeded');expect(hits).toBe(1);expect(JSON.parse(result.output_json!).items).toEqual([{bytes:body.length,context:{user:'bounded'}}]);
  }
 },20000);
 it('retains one retry for 503, but malformed handler output consumes only one fetch',async()=>{
  for(const invalid of [false,true]){
   const {host,execution}=await fixture(invalid?'export default()=>({items:"bad",next_urls:[]})':undefined);let hits=0;
   const result=await runSourceCollection(host,execution,async()=>({sequence:1,status:++hits===1&&!invalid?503:200,content_type:'text/plain',body_base64:''}),signal());
   expect(result.status).toBe(invalid?'failed':'succeeded');expect(hits).toBe(invalid?1:2);
  }
 });
});
