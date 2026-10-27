import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { publicAddressGuard } from "./support/outboundGuard.js";
import { createSourceRequestBroker, type SourceRequestGrant } from "../src/modules/sources/sourceRequestBroker.js";
import { sourceQuotaGroup, coolDownSourceRequests } from "../src/modules/sources/sourceRequestQuota.js";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import type { HostServerFrame, SourceExecution } from "@rainver/protocol";
const db=useTestDatabase(import.meta.filename);
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function policy():SourceRequestGrant{return {scopeId:randomUUID(),quotaGroup:sourceQuotaGroup(randomUUID(),"all"),quota:[{window:"minute",limit:20}],routes:[{origin:"https://a.test",path_prefix:"/private",methods:["GET"],credentialHeaders:async()=>({authorization:"Bearer fixture-secret/%?"})},{origin:"https://a.test",path_prefix:"/public",methods:["GET"]},{origin:"https://b.test",path_prefix:"/public",methods:["GET"]}],maxBytes:4096,deadlineMs:2000,authorize:async()=>{}};}
const request=(url:string,sequence=1)=>({url,sequence,method:"GET"});
it("C1 binds credentials to exact route on each cross-origin and same-origin redirect",async()=>{
 const seen:{url:string;auth:unknown}[]=[];
 vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{seen.push({url:String(url),auth:(init?.headers as Record<string,string>).authorization});return String(url).endsWith('/private')?new Response(null,{status:302,headers:{location:"https://a.test/public"}}):new Response("ok")});
 const grant=policy();const broker=createSourceRequestBroker(db.pool,grant,new AbortController().signal,publicAddressGuard);
 await broker(request("https://b.test/public"));await broker(request("https://a.test/private",2));
 expect(seen.map(x=>x.auth)).toEqual([undefined,"Bearer fixture-secret/%?",undefined]);
 seen.length=0;
 vi.mocked(globalThis.fetch).mockImplementation(async(url,init)=>{seen.push({url:String(url),auth:(init?.headers as Record<string,string>).authorization});return String(url).endsWith('/private')?new Response(null,{status:302,headers:{location:"https://b.test/public"}}):new Response("ok")});
 await broker(request("https://a.test/private",3));expect(seen.map(x=>x.auth)).toEqual(["Bearer fixture-secret/%?",undefined]);
});
it("C1 refuses HTTP credentials, overlapping grants and lookalike paths before quota",async()=>{
 const grant=policy();grant.routes=[{...grant.routes[0],origin:"http://a.test"}];
 expect(()=>createSourceRequestBroker(db.pool,grant,new AbortController().signal,publicAddressGuard)).toThrow("source_scope_invalid");
 const overlap=policy();overlap.routes=[overlap.routes[0],{...overlap.routes[0],path_prefix:"/private/sub"}];
 const broker=createSourceRequestBroker(db.pool,overlap,new AbortController().signal,publicAddressGuard);
 await expect(broker(request("https://a.test/private/sub"))).rejects.toThrow("scope");
 await expect(broker(request("https://a.test/private-other",2))).rejects.toThrow("scope");
 expect((await db.pool.query(`SELECT * FROM source_request_quota_state WHERE group_key=$1`,[grant.quotaGroup])).rowCount).toBe(0);
});
it("C2 combines registry cancellation, timeout, disconnect and replacement with a real broker",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("ok"));
 for(const mode of ["cancel","disconnect","replace","timeout"]){
  const registry=new HostConnectionRegistry();const frames:HostServerFrame[]=[];const sink={send:(f:HostServerFrame)=>frames.push(f),close:()=>{}};registry.registerConnection("host",sink,true);
  const controller=new AbortController();const grant=policy();let entered!:()=>void,release!:()=>void;
  const inAuth=new Promise<void>(r=>entered=r);const held=new Promise<void>(r=>release=r);
  grant.authorize=async()=>{entered();await held};
  const broker=createSourceRequestBroker(db.pool,grant,new AbortController().signal,publicAddressGuard);
  const execution:SourceExecution={execution_id:randomUUID(),code:"export default()=>({})",version_sha256:"a".repeat(64),input_json:"{}",limits:{wall_ms:100,memory_bytes:134217728,cpu_quota_percent:50,processes:32,output_bytes:100,requests:1}};
  if(mode==="timeout")vi.useFakeTimers();
  const done=registry.executeSource("host",execution,broker,controller.signal);
  const frame=frames.find(f=>f.type==="source_execute");if(frame?.type!=="source_execute")throw new Error("missing dispatch");
  registry.receiveSourceRequest("host",frame.execution.execution_id,request("https://a.test/public") as never);await inAuth;
  if(mode==="cancel")controller.abort();else if(mode==="disconnect")registry.unregisterConnection("host",sink,true);else if(mode==="replace")registry.registerConnection("host",sink,true);else await vi.advanceTimersByTimeAsync(5100);
  await done;release();await held;await new Promise<void>(r=>queueMicrotask(r));vi.useRealTimers();
  expect((await db.pool.query(`SELECT * FROM source_request_quota_state WHERE group_key=$1`,[grant.quotaGroup])).rowCount).toBe(0);
 }
 expect(fetch).not.toHaveBeenCalled();
 const c=new AbortController();c.abort();await expect(createSourceRequestBroker(db.pool,policy(),new AbortController().signal,publicAddressGuard)(request("https://a.test/public"),c.signal)).rejects.toThrow("cancelled");
});
it("C4 preserves binary/GBK bytes and redacts raw and URL-encoded credential bytes",async()=>{
 const original=Buffer.from([0x25,0x50,0x44,0x46,0xff,0x00,0xd6,0xd0,0xce,0xc4]);
 const secret="fixture-secret/%?";const encoded=encodeURIComponent(secret);
 vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(original));
 const broker=createSourceRequestBroker(db.pool,policy(),new AbortController().signal,publicAddressGuard);
 expect(Buffer.from((await broker(request("https://a.test/public"))).body_base64,"base64")).toEqual(original);
 vi.mocked(globalThis.fetch).mockResolvedValue(new Response(Buffer.concat([original,Buffer.from(secret+encoded)])));
 const response=await broker(request("https://a.test/private",2));expect(Buffer.from(response.body_base64,"base64")).toEqual(Buffer.concat([original,Buffer.from("[REDACTED][REDACTED]")]));
});
it("A2 cools shared endpoint groups across different accounts",async()=>{
 const endpoint=sourceQuotaGroup(randomUUID(),"endpoint");const first=policy(),second=policy();for(const p of [first,second])p.endpointQuotas=[{key:endpoint,windows:[{window:"minute",limit:10}]}];
 const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("busy",{status:429,headers:{"retry-after":"120"}}));
 await createSourceRequestBroker(db.pool,first,new AbortController().signal,publicAddressGuard)(request("https://a.test/public"));
 await expect(createSourceRequestBroker(db.pool,second,new AbortController().signal,publicAddressGuard)(request("https://a.test/public"))).rejects.toMatchObject({code:"source_quota_exhausted",retryAt:expect.any(String)});expect(fetch).toHaveBeenCalledTimes(1);
});
it("A3 ignores 200 Retry-After and bounds 429/503 huge, invalid and date cooldowns",async()=>{
 for(const status of [200,429,503]){
 const grant=policy();vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("body",{status,headers:{"retry-after":"9".repeat(1000)}}));
 await createSourceRequestBroker(db.pool,grant,new AbortController().signal,publicAddressGuard)(request("https://a.test/public"));
 const {rows:[row]}=await db.pool.query(`SELECT extract(epoch FROM(cooldown_until-clock_timestamp())) AS seconds FROM source_request_quota_state WHERE group_key=$1`,[grant.quotaGroup]);
 if(status===200)expect(row.seconds).toBeNull();else expect(Number(row.seconds)).toBeGreaterThan(86390);
 vi.restoreAllMocks();
 }
 for(const value of ["-1","Infinity","invalid","Fri, 01 Jan 9999 00:00:00 GMT",null]){
 const key=sourceQuotaGroup(randomUUID(),"test");await coolDownSourceRequests(db.pool,key,value);
 const {rows:[row]}=await db.pool.query(`SELECT extract(epoch FROM(cooldown_until-clock_timestamp())) AS seconds FROM source_request_quota_state WHERE group_key=$1`,[key]);expect(Number(row.seconds)).toBeGreaterThan(0);expect(Number(row.seconds)).toBeLessThanOrEqual(86400);
 }
});
it("P2 preserves bounded error bodies and only incremental metadata/headers/query keys",async()=>{
 const grant=policy();grant.routes=[{origin:"https://a.test",path_prefix:"/public",methods:["GET"],query_keys:["page"]}];
 const bytes=Buffer.from([0xff,0,0x41]);const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(bytes,{status:400,headers:{etag:'"v1"',"last-modified":"Mon, 26 Oct 2026 00:00:00 GMT",link:'</public?page=2>; rel="next"',"set-cookie":"private"}}));
 const broker=createSourceRequestBroker(db.pool,grant,new AbortController().signal,publicAddressGuard);
 const response=await broker({...request("https://a.test/public?page=1"),headers:{"if-none-match":'"old"'}});
 expect(response.final_url).toBe("https://a.test/public?page=1");expect(response.headers?.etag).toBe('"v1"');expect(response.headers?.link).toContain('page=2');expect(response.headers).not.toHaveProperty("set-cookie");expect(Buffer.from(response.body_base64,"base64")).toEqual(bytes);
 expect((fetch.mock.calls[0][1]?.headers as Record<string,string>)["if-none-match"]).toBe('"old"');
 await expect(broker(request("https://a.test/public?api_key=bad",2))).rejects.toThrow("source_scope_refused");
 await expect(broker({...request("https://a.test/public",3),headers:{authorization:"bad"}})).rejects.toThrow("source_request_invalid");
});
it("P2 retains quota retryAt through registry and sanitizes network errors",async()=>{
 const grant=policy();await coolDownSourceRequests(db.pool,grant.quotaGroup,"60");
 const registry=new HostConnectionRegistry();const frames:HostServerFrame[]=[];registry.registerConnection("host",{send:f=>frames.push(f),close:()=>{}},true);
 const execution:SourceExecution={execution_id:randomUUID(),code:"export default()=>({})",version_sha256:"a".repeat(64),input_json:"{}",limits:{wall_ms:1000,memory_bytes:134217728,cpu_quota_percent:50,processes:32,output_bytes:100,requests:1}};
 const done=registry.executeSource("host",execution,createSourceRequestBroker(db.pool,grant,new AbortController().signal,publicAddressGuard),new AbortController().signal);
 const dispatched=frames[0];if(dispatched.type!=="source_execute")throw new Error("dispatch");
 registry.receiveSourceRequest("host",dispatched.execution.execution_id,{url:"https://a.test/public",method:"GET",sequence:1});
 expect(await done).toMatchObject({error:"source_quota_exhausted",retry_at:expect.any(String)});
 vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("secret upstream message"));
 await expect(createSourceRequestBroker(db.pool,policy(),new AbortController().signal,publicAddressGuard)(request("https://a.test/public"))).rejects.toMatchObject({code:"source_network_failed",message:"source_network_failed"});
});
it("C3 binds checkpoints to the broker scope and reauthorizes cached final output",async()=>{
 const grant=policy();let allowed=true;grant.authorize=async()=>{if(!allowed)throw new Error("revoked")};
 const broker=createSourceRequestBroker(db.pool,grant,new AbortController().signal,publicAddressGuard);
 const changed=createSourceRequestBroker(db.pool,{...grant,scopeId:randomUUID()},new AbortController().signal,publicAddressGuard);expect(changed.scopeSha256).not.toBe(broker.scopeSha256);
 const registry=new HostConnectionRegistry();let sent!:(f:HostServerFrame)=>void;const dispatched=new Promise<HostServerFrame>(r=>sent=r);
 registry.registerConnection("host",{send:frame=>{if(frame.type==="source_execute")sent(frame)},close:()=>{}},true);
 const execution:SourceExecution={execution_id:randomUUID(),code:"export default()=>({})",version_sha256:"a".repeat(64),input_json:"{}",limits:{wall_ms:1000,memory_bytes:134217728,cpu_quota_percent:50,processes:32,output_bytes:100,requests:1},collection:{collection_id:randomUUID(),authorization_sha256:"f".repeat(64),seeds:["https://a.test/public"],max_items:1}};
 const done=registry.executeSource("host",execution,broker,new AbortController().signal);const frame=await dispatched;if(frame.type!=="source_execute")throw new Error("dispatch");
 expect(frame.execution.collection?.authorization_sha256).toBe(broker.scopeSha256);expect(frame.execution.execution_id).not.toBe(execution.execution_id);
 allowed=false;registry.receiveSourceResult("host",frame.execution.execution_id,{status:"succeeded",output_json:'{"cached":true}',error:null});
 expect(await done).toMatchObject({status:"failed",output_json:null,error:"source_authority_revoked"});
});
