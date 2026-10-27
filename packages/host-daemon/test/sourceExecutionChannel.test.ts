import {createHash,randomUUID} from "node:crypto";
import {mkdtemp,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";
import type {HostDaemonFrame,SourceExecution} from "@rainver/protocol";
import {SourceExecutionChannel} from "../src/sourceExecutionChannel.js";
describe.skipIf(process.env.SOURCE_EXECUTION_OS_SMOKE!=="1")("source channel identity",()=>{
 it("refuses duplicate dispatch explicitly without cancelling the original execution",async()=>{
 const root=await mkdtemp(join(tmpdir(),"source-channel-test-"));
 const code="export default async({request})=>({status:(await request('https://fixture.test')).status})";
 const execution:SourceExecution={execution_id:randomUUID(),code,version_sha256:createHash('sha256').update(code).digest('hex'),input_json:'{}',limits:{wall_ms:5000,memory_bytes:268435456,cpu_quota_percent:50,processes:32,requests:2,output_bytes:4096}};
 const frames:HostDaemonFrame[]=[];let finished!:(f:HostDaemonFrame)=>void;const done=new Promise<HostDaemonFrame>(r=>finished=r);
 const channel=new SourceExecutionChannel({root,node:process.execPath,maxConcurrent:1,bwrap:process.env.SOURCE_EXECUTION_BWRAP,cgroupRoot:process.env.SOURCE_EXECUTION_CGROUP_ROOT},frame=>{
 frames.push(frame);
 if(frame.type==='source_request'){
   channel.handle({type:'source_execute',execution});
   channel.handle({type:'source_response',execution_id:execution.execution_id,response:{sequence:frame.request.sequence,status:200,body_base64:'',content_type:''}});
 }
 if(frame.type==='source_result')finished(frame);
 });
 try{
 channel.handle({type:'source_execute',execution});const final=await done;
 expect(frames.some(f=>f.type==='source_rejected')).toBe(true);
 if(final.type!=='source_result')throw new Error('result');expect(final.result.status).toBe('succeeded');
 expect((await readdir(root)).filter(f=>f.startsWith('source-'))).toEqual([]);
 }finally{channel.disconnect();await rm(root,{recursive:true,force:true})}
 });
});
