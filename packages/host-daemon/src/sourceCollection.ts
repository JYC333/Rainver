import { acquireSourceCollectionLease, releaseSourceCollectionLease } from "./sourceOwnership.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BasicCrawler, Configuration, RequestQueue, log, NonRetryableError } from "@crawlee/basic";
import { loadBuffer } from "cheerio";
import { SourceExecutionSchema, SourceRequestSchema, SourceResponseSchema, type SourceExecution, type SourceRequest, type SourceResponse } from "@rainver/protocol";
import { runSourceExecution, type SourceExecutionHost, type SourceExecutionResult } from "./sourceExecution.js";

const held = new Set<string>();
interface State { fingerprint: string; sends: number; outputs: Record<string,{items:unknown[];next_urls:string[];coverage?:{discovered_links:number;provided_links:number;truncated_pages:number}}> }
/** Crawlee owns ONLY execution queue/retries. State/queue are trusted daemon files,
 * never mounted into code. Serial dispatch is intentional: the wire permits one
 * outstanding request. Business cursors/materialization remain server-owned. */
export async function runSourceCollection(host:SourceExecutionHost,execution:SourceExecution,
  broker:(request:SourceRequest,signal:AbortSignal)=>Promise<SourceResponse>,signal:AbortSignal):Promise<SourceExecutionResult> {
  const parsed=SourceExecutionSchema.safeParse(execution);
  if(!parsed.success)return {status:"refused",output_json:null,error:"source_contract_invalid"};
  execution=parsed.data;
  if(createHash("sha256").update(execution.code).digest("hex")!==execution.version_sha256)return {status:"refused",output_json:null,error:"source_version_mismatch"};
  try{JSON.parse(execution.input_json)}catch{return {status:"refused",output_json:null,error:"source_contract_invalid"};}
  if(host.enabled===false)return {status:"refused",output_json:null,error:"source_host_not_enabled"};
  const spec=execution.collection;
  if(!spec)return runSourceExecution(host,execution,(raw,s)=>broker(SourceRequestSchema.parse(raw),s),signal);
  const dir=join(host.root,"collections",spec.collection_id);
  if(held.has(host.root))return {status:"refused",output_json:null,error:"source_collection_busy"};
  held.add(host.root);let queue:RequestQueue|undefined;let leaseOwned=false;
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(execution.limits.wall_ms)]);
  const fingerprint=createHash("sha256").update(JSON.stringify([execution.version_sha256,execution.input_json,spec,execution.limits])).digest("hex");
  let sequence=0;let failure:SourceExecutionResult|null=null;
  try {
    await mkdir(dir,{recursive:true,mode:0o700});
    // Cross-process lease: another daemon cannot run the same checkpoint concurrently.
    try{await acquireSourceCollectionLease(dir);leaseOwned=true;}
    catch{return {status:"refused",output_json:null,error:"source_collection_busy"};}
    let state:State;
    try{state=JSON.parse(await readFile(join(dir,"state.json"),"utf8"));}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;state={fingerprint,sends:0,outputs:{}};}
    if(state.fingerprint!==fingerprint)return {status:"refused",output_json:null,error:"source_checkpoint_mismatch"};
    const persist=async()=>{const text=JSON.stringify(state);if(Buffer.byteLength(text)>execution.limits.output_bytes*2+65536)throw new Error("source_checkpoint_limit");await writeFile(join(dir,"state.tmp"),text,{mode:0o600});await rename(join(dir,"state.tmp"),join(dir,"state.json"));};
    const controlled=async(raw:unknown,s:AbortSignal)=>{
      const request=SourceRequestSchema.parse(raw);deadline.throwIfAborted();s.throwIfAborted();
      if(state.sends>=execution.limits.requests)throw new Error("source_request_limit");
      state.sends++;await persist();const response=SourceResponseSchema.parse(await broker({...request,sequence:++sequence},AbortSignal.any([deadline,s])));
      return {...response,sequence:request.sequence};
    };
    const config=new Configuration({persistStorage:true,purgeOnStart:false,storageClientOptions:{localDataDirectory:join(dir,"queue")}});
    queue=await RequestQueue.open("source",{config});
    await queue.addRequests(spec.seeds.map(url=>({url,uniqueKey:url+"#"+execution.execution_id})));
    for(const output of Object.values(state.outputs))await queue.addRequests(output.next_urls.map(url=>({url,uniqueKey:url+"#"+execution.execution_id})));
    const crawler=new BasicCrawler({requestQueue:queue,minConcurrency:1,maxConcurrency:1,useSessionPool:false,maxRequestRetries:1,
      log:log.child({prefix:"Sources",level:0}),
      requestHandler:async({request})=>{
        try {
        deadline.throwIfAborted();const key=createHash("sha256").update(request.url).digest("hex");
        if(state.outputs[key])return;
        if(Object.values(state.outputs).reduce((n,o)=>n+o.items.length,0)>=spec.max_items)throw new Error("source_item_limit");
        const response=await controlled({url:request.url,method:"GET",sequence:1},deadline);
        if(response.retry_at){failure={status:"refused",output_json:null,error:"source_upstream_cooldown",retry_at:response.retry_at};await crawler.autoscaledPool?.abort();throw new Error("source_upstream_cooldown");}
        if(response.status>=500)throw new Error("source_upstream_retryable");
        if(response.status===429 || response.status>=400)throw new Error("source_upstream_refused");
        const links:string[]=[];let discovered=0;
        if(response.content_type.includes("html")){
          const $=loadBuffer(Buffer.from(response.body_base64,"base64"));
          for(const a of $("a[href]").toArray()) {
            const href=$(a).attr("href");if(!href)continue;
            let url:URL;try{url=new URL(href,response.final_url??request.url)}catch{continue;}
            if(!["http:","https:"].includes(url.protocol) || url.href.length>8192)continue;
            discovered++;if(links.length<100)links.push(url.href);
          }
        }
        const {collection:_collection,...single}=execution;
        const coverage={discovered_links:discovered,provided_links:links.length,truncated_pages:discovered>links.length?1:0};
        const result=await runSourceExecution(host,single,controlled,deadline,{url:request.url,response,links,link_coverage:coverage});
        if(result.status!=="succeeded"){failure=result;await crawler.autoscaledPool?.abort();throw new Error(result.error??"source_handler_failed");}
        const output=JSON.parse(result.output_json!);
        if(!output || !Array.isArray(output.items) || !Array.isArray(output.next_urls) || output.next_urls.length>100
          || output.next_urls.some((url:unknown)=>typeof url!=="string" || !/^https?:/.test(new URL(url).protocol)))throw new Error("source_output_refused");
        if(Object.values(state.outputs).reduce((n,o)=>n+o.items.length,0)+output.items.length>spec.max_items)throw new Error("source_item_limit");
        state.outputs[key]={items:output.items,next_urls:output.next_urls,coverage};await persist();
        await queue!.addRequests(output.next_urls.map((url:string)=>({url,uniqueKey:url+"#"+execution.execution_id})));
        } catch(error) {
          if(deadline.aborted){
            failure={status:signal.aborted?"cancelled":"timed_out",output_json:null,error:signal.aborted?"source_cancelled":"source_timeout"};
            request.noRetry=true;
            throw new NonRetryableError(failure.error!);
          }
          // Only recoverable network/upstream failures consume the finite retry budget.
          const code=error instanceof Error?error.message:"";
          if(code==="source_network_failed" || code==="source_upstream_retryable")throw error;
          request.noRetry=true;
          throw new NonRetryableError(/^source_[a-z_]+$/.test(code)?code:"source_collection_failed");
        }
      },failedRequestHandler:async(_context,error)=>{failure??={status:"failed",output_json:null,
        error:/^source_[a-z_]+$/.test(error.message)?error.message:"source_collection_failed"};},
    },config);
    // Reclaim prefetched execution requests promptly; this lease is not a business cursor.
    queue.requestLockSecs=1;
    const abort=()=>{void crawler.autoscaledPool?.abort();};deadline.addEventListener("abort",abort,{once:true});
    try{await crawler.run();}finally{deadline.removeEventListener("abort",abort);}
    deadline.throwIfAborted();
    if(failure)return failure;
    const coverage=Object.values(state.outputs).reduce((total,o)=>({
      discovered_links:total.discovered_links+(o.coverage?.discovered_links??0),
      provided_links:total.provided_links+(o.coverage?.provided_links??0),
      truncated_pages:total.truncated_pages+(o.coverage?.truncated_pages??0),
    }),{discovered_links:0,provided_links:0,truncated_pages:0});
    const output=JSON.stringify({items:Object.values(state.outputs).flatMap(o=>o.items),coverage});
    if(Buffer.byteLength(output)>execution.limits.output_bytes)throw new Error("source_output_limit");
    return {status:"succeeded",output_json:output,error:null};
  } catch(error) {
    return {status:deadline.aborted?signal.aborted?"cancelled":"timed_out":"failed",output_json:null,error:deadline.aborted?signal.aborted?"source_cancelled":"source_timeout":error instanceof Error && /^source_[a-z_]+$/.test(error.message)?error.message:"source_collection_failed"};
  } finally {
    if(queue)await queue.handledCount().catch(()=>{});
    if(leaseOwned)await releaseSourceCollectionLease(dir);held.delete(host.root);
  }
}
