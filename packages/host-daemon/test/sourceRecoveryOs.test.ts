import {createHash,randomUUID} from "node:crypto";
import {spawn,execFile} from "node:child_process";
import {mkdir,mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {describe,expect,it} from "vitest";
import {recoverSourceExecutions,sourceUnitPrefix} from "../src/sourceOwnership.js";
import {sourceSandboxCommand} from "../src/sourceExecution.js";
import type {SourceExecution} from "@rainver/protocol";
const exec=promisify(execFile);
describe.skipIf(process.env.SOURCE_EXECUTION_OS_SMOKE!=="1")("source owned OS recovery",()=>{
 it("kills only a recorded orphan worker and removes its owned scratch",async()=>{
  const root=await mkdtemp(join(tmpdir(),"source-orphan-test-"));const unit=sourceUnitPrefix(root)+randomUUID();const scratch=join(root,"source-orphan");await mkdir(scratch);
  const cgroupRoot=process.env.SOURCE_EXECUTION_CGROUP_ROOT;
  try{
   await writeFile(join(scratch,"owner.json"),JSON.stringify({unit,pid:999999999,identity:"dead",cgroupRoot:cgroupRoot??null}));
   if(cgroupRoot){
    const group=join(cgroupRoot,unit);await mkdir(group);
    const child=spawn(process.execPath,["-e",`require('node:fs').writeFileSync(${JSON.stringify(join(group,"cgroup.procs"))},String(process.pid));process.stdout.write('ready');setInterval(()=>{},1000)`],{stdio:["ignore","pipe","ignore"]});
    const exited=new Promise<number|null>(r=>child.once("close",r));await new Promise<void>(r=>child.stdout.once("data",()=>r()));
    await recoverSourceExecutions({root,cgroupRoot});expect(await exited).toBeNull();await expect(readFile(join(group,"cgroup.events"))).rejects.toMatchObject({code:"ENOENT"});
   }else{
    await exec("/usr/bin/systemd-run",["--user","--quiet","--unit="+unit,process.execPath,"-e","setInterval(()=>{},1000)"]);
    await recoverSourceExecutions({root});
    const {stdout}=await exec("/usr/bin/systemctl",["--user","show",unit+".service","--property=ActiveState","--value"]);
    expect(stdout.trim()).not.toBe("active");
   }
   await expect(readFile(join(scratch,"owner.json"))).rejects.toMatchObject({code:"ENOENT"});
  }finally{await rm(root,{recursive:true,force:true})}
 });
 it("supervisor refuses a non-cgroup path before loading any handler",async()=>{
  const root=await mkdtemp(join(tmpdir(),"source-supervisor-test-"));
  const code="export default()=>({})";const execution:SourceExecution={execution_id:randomUUID(),code,version_sha256:createHash('sha256').update(code).digest('hex'),input_json:'{}',limits:{wall_ms:1000,memory_bytes:134217728,cpu_quota_percent:50,processes:32,requests:1,output_bytes:100}};
  try{
   const command=sourceSandboxCommand({root,node:process.execPath,maxConcurrent:1,cgroupRoot:root},execution,"/nonexistent-code","refused-test");
   await expect(exec(command.command,command.args)).rejects.toMatchObject({code:120});
  }finally{await rm(root,{recursive:true,force:true})}
 });
});
