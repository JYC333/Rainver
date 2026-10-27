/** Explicit fixture worker: consumes daemon-owned test config on stdin, never a
 * product wire handler. Two invocations prove checkpoint recovery across processes. */
import {runSourceCollection} from '../../packages/host-daemon/dist/sourceCollection.js';
import {guardedFetch,undiciPinnedFetch} from '../../packages/outbound-guard/dist/index.js';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const {host,execution}=JSON.parse(Buffer.concat(chunks));
const result=await runSourceCollection(host,execution,async request=>{
 const response=await guardedFetch({url:request.url,maxDownloadBytes:8192,deadlineMs:2000,readErrorBody:true},
  {guard:{pin:async()=>[{address:'127.0.0.1',family:4}]},fetch:undiciPinnedFetch});
 return {sequence:request.sequence,status:response.status,body_base64:Buffer.from(response.bytes).toString('base64'),content_type:response.headers.get('content-type')??'',final_url:response.url};
},new AbortController().signal);
await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(result),error=>error?reject(error):resolve()));
