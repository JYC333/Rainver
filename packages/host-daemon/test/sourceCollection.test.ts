import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {mkdtemp,rm,readFile,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import type {SourceExecution,SourceExecutionResult} from "@rainver/protocol";

import {runSourceCollection} from "../src/sourceCollection.js";
import {recoverSourceExecutions,sourceOwner} from "../src/sourceOwnership.js";
const roots:string[]=[];afterEach(async()=>{for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
describe.skipIf(process.env.SOURCE_EXECUTION_OS_SMOKE!=="1")("C3 real isolated collection adapter",()=>{
 it("runs JSON pagination, HTML links, retry and checkpoint resume through isolated code",async()=>{
  const root=await mkdtemp(join(tmpdir(),"source-collection-test-"));roots.push(root);
  const host={root,node:process.execPath,maxConcurrent:1,bwrap:process.env.SOURCE_EXECUTION_BWRAP,cgroupRoot:process.env.SOURCE_EXECUTION_CGROUP_ROOT};
  const code=`export default ({input})=>{const r=input.response;const body=Buffer.from(r.body_base64,'base64').toString();if(r.content_type.includes('html'))return {items:[input.url],next_urls:input.links};const json=JSON.parse(body);return {items:[json.id],next_urls:json.next?[json.next]:[]}}`;
  const hits:Record<string,number>={};let crash=true;
  const server=createServer((req,res)=>{
    const path=req.url!;hits[path]=(hits[path]??0)+1;
    if(path==="/api/1" && crash || path==="/retry" && hits[path]===1){res.writeHead(503);res.end("retry");return;}
    const html=path==="/html";res.setHeader("content-type",html?"text/html":"application/json");
    res.end(html?'<a href="/retry">next</a>':JSON.stringify({id:path,next:path==="/api/0"?base+"/api/1":null}));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const address=server.address();if(!address || typeof address==='string')throw new Error('fixture');
  const base=`http://127.0.0.1:${address.port}`;
  const execution:SourceExecution={execution_id:randomUUID(),code,version_sha256:createHash("sha256").update(code).digest("hex"),input_json:"{}",limits:{wall_ms:10000,memory_bytes:268435456,cpu_quota_percent:50,processes:32,output_bytes:65536,requests:20},collection:{collection_id:randomUUID(),authorization_sha256:"b".repeat(64),seeds:[base+"/api/0",base+"/html"],max_items:10}};
  const run=async(input:SourceExecution)=>new Promise<SourceExecutionResult>((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL("../../../tools/source-engine/isolated-worker.mjs",import.meta.url))],
      {stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin",XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}});
    let output="",error="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>error+=b);
    child.on("error",reject);child.on("exit",code=>{if(code!==0)reject(new Error(error));else try{resolve(JSON.parse(output))}catch(e){reject(e)}});
    child.stdin.end(JSON.stringify({host,execution:input}));
  });
  try{
  const started=performance.now();
  const first=await run(execution);expect(first.status).toBe("failed");
  const before=JSON.parse(await readFile(join(root,"collections",execution.collection!.collection_id,"state.json"),"utf8"));expect(Object.keys(before.outputs).length).toBeGreaterThan(0);
  crash=false;execution.execution_id=randomUUID();const second=await run(execution);
  expect(second.status).toBe("succeeded");expect(JSON.parse(second.output_json!).items.sort()).toEqual(["/api/0","/api/1","/retry",base+"/html"].sort());
  expect(hits["/api/0"]).toBe(1);expect(hits["/html"]).toBe(1);expect(hits["/retry"]).toBe(2);expect(hits["/api/1"]).toBe(3);
  const final=JSON.parse(await readFile(join(root,"collections",execution.collection!.collection_id,"state.json"),"utf8"));expect(final.sends).toBe(Object.values(hits).reduce((a,b)=>a+b,0));expect(final.sends).toBe(7);
  if(process.env.SOURCE_COLLECTION_EVIDENCE)await writeFile(process.env.SOURCE_COLLECTION_EVIDENCE,JSON.stringify({
    node:process.version,backend:host.cgroupRoot?"direct-cgroup-v2":"user-systemd",concurrency:1,worker_processes:2,
    first_status:first.status,checkpoint_outputs:Object.keys(before.outputs).length,second_status:second.status,
    items:JSON.parse(second.output_json!).items,hits,requests:final.sends,elapsed_ms:performance.now()-started,
    note:"Real HTTP fixture and isolated handlers; fixture broker uses guardedFetch, server-PG broker/registry regression is verified separately. Business cursors are not advanced."
  },null,2));
  }finally{await new Promise<void>(r=>server.close(()=>r()))}
 },15000);
});
it("recovery preserves a live lease and removes a dead-owned collection lease",async()=>{
 const root=await mkdtemp(join(tmpdir(),"source-recovery-test-"));roots.push(root);
 const live=join(root,"collections",randomUUID(),"lease"),dead=join(root,"collections",randomUUID(),"lease");
 for(const dir of [live,dead])await mkdir(dir,{recursive:true});
 await writeFile(join(live,"owner"),JSON.stringify(await sourceOwner()));await writeFile(join(dead,"owner"),JSON.stringify({pid:999999999,identity:"dead"}));
 await recoverSourceExecutions({root});expect(await readFile(join(live,"owner"),"utf8")).toContain(String(process.pid));await expect(readFile(join(dead,"owner"))).rejects.toMatchObject({code:"ENOENT"});
});

it("refuses a collection version mismatch before any request or checkpoint write",async()=>{
 const code="export default()=>({})";let calls=0;
 const execution:SourceExecution={execution_id:randomUUID(),code,version_sha256:"0".repeat(64),input_json:"{}",limits:{wall_ms:1000,memory_bytes:134217728,cpu_quota_percent:50,processes:32,requests:1,output_bytes:100},collection:{collection_id:randomUUID(),authorization_sha256:"b".repeat(64),seeds:["https://fixture.test"],max_items:1}};
 const result=await runSourceCollection({root:"/unavailable-root",node:process.execPath,maxConcurrent:1},execution,async()=>{calls++;throw new Error("unexpected")},new AbortController().signal);
 expect(result).toMatchObject({status:"refused",error:"source_version_mismatch"});expect(calls).toBe(0);
});
