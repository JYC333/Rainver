import {sourceNodeLibraries} from "./sourceLibraries.js";
import { sourceOwner, sourceUnitPrefix, stopSourceCgroup } from "./sourceOwnership.js";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, access, realpath, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { SourceFrameDecoder } from "./sourceFraming.js";
import { promisify } from "node:util";
import { SourceExecutionSchema, SourceResponseSchema, SourceRequestSchema, type SourceExecution, type SourceResponse } from "@rainver/protocol";
import { helperProcessEnv } from "./providerBinding.js";

const exec = promisify(execFile);
const BWRAP = "/usr/bin/bwrap";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
/** No host path is accepted over the wire. root and node are daemon-owned configuration. */
export interface SourceExecutionHost {
  root: string;
  node: string;
  maxConcurrent: number;
  /** Daemon-owned binary override for capability verification; never a frame field. */
  bwrap?: string;
  /** Administrator-delegated cgroup v2 subtree; never supplied by the server. */
  cgroupRoot?: string;
  enabled?: boolean;
  libraries?:readonly {source:string;target:string}[];
}
export interface SourceExecutionResult {
  status: "succeeded" | "refused" | "failed" | "cancelled" | "timed_out";
  output_json: string | null;
  /** Fixed error codes only. Child logs and raw exception messages are never returned. */
  error: string | null;
  retry_at?: string;
}
/** Trusted adapter payload, never accepted as a wire/public input field. */
export interface SourceCollectionInput {
  url:string;response:SourceResponse;links:string[];
  link_coverage:{discovered_links:number;provided_links:number;truncated_pages:number};
}
export function sourceCpuWithinLimit(quota:number,period:number,percent:number):boolean {
  return [quota,period,percent].every(Number.isSafeInteger) && quota>0 && period>=1000 && period<=1000000
    && percent>=1 && percent<=100 && BigInt(quota)*100n<=BigInt(period)*BigInt(percent);
}
const active = new Map<string, number>();

/** systemd owns the cgroup before bwrap or untrusted code starts. CPU/memory/swap,
 * process and runtime ceilings apply to the whole subtree. Missing facilities fail closed.
 * Unlike command_run, trusted-host mode never relaxes this execution boundary. */
export function sourceSandboxCommand(host: SourceExecutionHost, request: SourceExecution, codeDir: string, unit: string): { command: string; args: string[] } {
  const limits = request.limits;
  const command = { command: SYSTEMD_RUN, args: ["--user", "--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    "--service-type=exec", "--property=NoNewPrivileges=yes", "--property=KillMode=control-group", "--property=TimeoutStopSec=1", "--property=KillSignal=SIGKILL",
    `--property=MemoryMax=${limits.memory_bytes}`, "--property=MemorySwapMax=0", "--property=OOMPolicy=kill",
    `--property=CPUQuota=${limits.cpu_quota_percent}%`, `--property=TasksMax=${limits.processes}`,
    `--property=RuntimeMaxSec=${limits.wall_ms / 1000}`, "--property=LimitCORE=0",
    `--property=LimitFSIZE=${limits.output_bytes}`, "--property=UMask=0077",
    host.bwrap ?? BWRAP, "--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL",
    "--size", "1048576", "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev",
    ...(host.libraries??[]).flatMap(lib=>["--ro-bind",lib.source,lib.target]),
    "--dir", "/runtime", "--ro-bind", host.node, "/runtime/node", "--ro-bind", codeDir, "/code",
    "--size", String(limits.output_bytes + 1024 * 1024), "--tmpfs", "/output",
    "--remount-ro", "/", "--chdir", "/output", "--clearenv",
    "--setenv", "LANG", "C.UTF-8", "--setenv", "HOME", "/output",
    // Stdio is the sole request channel. stdout is framed; stderr is discarded.
    "--", "/runtime/node", "--disable-proto=throw", "/code/bootstrap.mjs"] };
  const start = command.args.indexOf(host.bwrap ?? BWRAP);
  const bwrapArgs = command.args.splice(start);
  // A trusted supervisor verifies actual kernel controllers before loading any code.
  // systemd can accept a setting on a machine whose user manager lacks delegation.
  if(host.cgroupRoot) {
    return {command:"/usr/bin/prlimit",args:["--core=0:0",`--fsize=${limits.output_bytes}:${limits.output_bytes}`,"--",host.node,"--input-type=module","--eval",SOURCE_SUPERVISOR,
      JSON.stringify({command:bwrapArgs[0],args:bwrapArgs.slice(1),limits,direct:join(host.cgroupRoot,unit)})]};
  }
  command.args.push(host.node, "--input-type=module", "--eval", SOURCE_SUPERVISOR,
    JSON.stringify({ command: bwrapArgs[0], args: bwrapArgs.slice(1), limits }));
  return command;
}

const SOURCE_SUPERVISOR = `
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const {command,args,limits,direct}=JSON.parse(process.argv[1]);
try {
if(direct) {
  mkdirSync(direct,{mode:0o700});
  writeFileSync(direct+'/memory.max',String(limits.memory_bytes));
  writeFileSync(direct+'/memory.swap.max','0');
  writeFileSync(direct+'/memory.oom.group','1');
  writeFileSync(direct+'/pids.max',String(limits.processes));
  writeFileSync(direct+'/cpu.max',Math.floor(limits.cpu_quota_percent*1000)+' 100000');
  writeFileSync(direct+'/cgroup.procs',String(process.pid));
}
const group=readFileSync('/proc/self/cgroup','utf8').trim().split('\\n').find(x=>x.startsWith('0::'))?.slice(3);
if(!group || group.includes('..')) process.exit(120);
const root=direct ? realpathSync(direct) : '/sys/fs/cgroup'+group;
if(!root.startsWith('/sys/fs/cgroup/')) process.exit(120);
const value=name=>readFileSync(root+'/'+name,'utf8').trim();
const cpuWithinLimit=${sourceCpuWithinLimit.toString()};
const [quota,period]=value('cpu.max').split(' ').map(Number);
if(!(Number(value('memory.max'))<=limits.memory_bytes) || value('memory.swap.max')!=='0'
  || !(Number(value('pids.max'))<=limits.processes) || !cpuWithinLimit(quota,period,limits.cpu_quota_percent)) process.exit(121);
const child=spawnSync(command,args,{stdio:'inherit',timeout:limits.wall_ms,killSignal:'SIGKILL',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
process.exit(child.status ?? 122);
} catch {process.exit(121);}
`;

const BOOTSTRAP = `import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
const send = value => new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\\n',error=>error?reject(error):resolve()));
const lines = createInterface({input: process.stdin});
let resolveResponse; let seq = 0;
lines.on('line', line => { if (resolveResponse) { const done = resolveResponse; resolveResponse = null; done(JSON.parse(line)); } });
const request = async (url, method = 'GET', headers) => {
  if (resolveResponse) throw new Error('Concurrent request refused');
  const response = new Promise(resolve => { resolveResponse = resolve; });
  await send({sequence: ++seq, url, method,...headers?{headers}:{}});
  return response;
};
const starting = new Promise(resolve => {resolveResponse=resolve;});
await send({ready:true});
const start=await starting;
if(start?.start!==true) process.exit(123);
let input = JSON.parse(await readFile('/code/input.json', 'utf8'));
try{const payload=JSON.parse(await readFile('/code/collection.json','utf8'));input={context:input,...payload};}catch(error){if(error.code!=='ENOENT')throw error;}
const {default: collect} = await import('/code/handler.mjs');
const output = await collect({input, request});
await writeFile('/output/output.json', JSON.stringify(output), {flag: 'wx'});
await send({output_json: await readFile('/output/output.json', 'utf8')});
lines.close(); process.stdin.destroy();
`;

export async function runSourceExecution(host: SourceExecutionHost, raw: unknown,
  broker: (request: unknown, signal: AbortSignal) => Promise<SourceResponse>, signal: AbortSignal, collectionInput?:SourceCollectionInput): Promise<SourceExecutionResult> {
  if(host.enabled===false) return {status:"refused",output_json:null,error:"source_host_not_enabled"};
  const parsed = SourceExecutionSchema.safeParse(raw);
  if (!parsed.success) return { status: "refused", output_json: null, error: "source_contract_invalid" };
  const request = parsed.data;
  let collectionJson:string|undefined;
  if(collectionInput){
    try{
      // Separate transport budget: response <=8MiB raw plus bounded URL/link
      // metadata. Public input retains its independent 1MiB byte boundary.
      SourceResponseSchema.parse(collectionInput.response);
      const {url,links,link_coverage:c}=collectionInput;
      if(typeof url!=="string" || url.length>8192 || !Array.isArray(links) || links.length>100
        || links.some(link=>typeof link!=="string" || link.length>8192)
        || !c || !Object.values(c).every(n=>Number.isSafeInteger(n)&&n>=0)
        || c.provided_links!==links.length || c.discovered_links<c.provided_links || c.truncated_pages>1)throw new Error();
      collectionJson=JSON.stringify({url,response:collectionInput.response,links,link_coverage:c});
      if(Buffer.byteLength(collectionJson)>16*1024*1024)throw new Error();
    }catch{return {status:"refused",output_json:null,error:"source_collection_input_limit"};}
  }

  if (createHash("sha256").update(request.code).digest("hex") !== request.version_sha256) return { status: "refused", output_json: null, error: "source_version_mismatch" };
  if (signal.aborted) return { status: "cancelled", output_json: null, error: "source_cancelled" };
  try{
    if(!isAbsolute(host.root))throw new Error("source_root_invalid");
    await mkdir(host.root,{recursive:true,mode:0o700});
    host={...host,root:await realpath(host.root)};
  }catch{return {status:"refused",output_json:null,error:"source_isolation_unavailable"};}
  if (!Number.isInteger(host.maxConcurrent) || host.maxConcurrent < 1 || (active.get(host.root) ?? 0) >= host.maxConcurrent) {
    return { status: "refused", output_json: null, error: "source_capacity_unavailable" };
  }
  active.set(host.root, (active.get(host.root) ?? 0) + 1);
  let directory: string | undefined;
  let cleanupSafe=true;
  const env = helperProcessEnv({ PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });
  try {
    host={...host,node:await realpath(host.node)};
    host.libraries=await sourceNodeLibraries(host.node);
    await Promise.all([access(host.bwrap ?? BWRAP),...host.cgroupRoot?[]:[access(SYSTEMD_RUN)],access(host.node)]);
    if(host.cgroupRoot) {
      await access("/usr/bin/prlimit");
      host.cgroupRoot=await realpath(host.cgroupRoot);
      if(!host.cgroupRoot.startsWith("/sys/fs/cgroup/")) throw new Error("source_cgroup_invalid");
    }
    await mkdir(host.root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(host.root, "source-"));
    const codeDir = join(directory, "code");
    await mkdir(codeDir);
    if(collectionJson!==undefined)await writeFile(join(codeDir,"collection.json"),collectionJson,{mode:0o400});
    await writeFile(join(codeDir, "handler.mjs"), request.code, { mode: 0o400 });
    await writeFile(join(codeDir, "input.json"), request.input_json, { mode: 0o400 });
    await writeFile(join(codeDir, "bootstrap.mjs"), BOOTSTRAP, { mode: 0o400 });
    const unit = `${sourceUnitPrefix(host.root)}${randomUUID()}`;
    await writeFile(join(directory,"owner.json"),JSON.stringify({unit,...await sourceOwner(),cgroupRoot:host.cgroupRoot??null}),{mode:0o600});
    const command = sourceSandboxCommand(host, request, codeDir, unit);
    cleanupSafe=false;
    const child = spawn(command.command, command.args, { env, stdio: ["pipe", "pipe", "ignore"] });
    let reason: string | null = null;
    const requestAbort = new AbortController();
    const executionSignal = AbortSignal.any([signal, requestAbort.signal]);  let sequence = 0; let pending = false; let output: string | null = null; let ready = false;

    // systemd-run's connection dying is insufficient: explicitly stop the entire cgroup.
    const stop = () => {
      requestAbort.abort();
      if(host.cgroupRoot) void writeFile(join(host.cgroupRoot,unit,"cgroup.kill"),"1").catch(()=>{});
      else void exec(SYSTEMCTL, ["--user", "stop", `${unit}.service`], { env, timeout: 5000 }).catch(() => {});
      child.stdin.destroy();
    };
    const abort = () => { reason = "source_cancelled"; stop(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => { reason = "source_timeout"; stop(); }, request.limits.wall_ms);
    const fail = () => { reason ??= "source_channel_refused"; stop(); };
    child.stdin.on("error", () => { if (!reason) fail(); });
    const decoder = new SourceFrameDecoder(request.limits.requests*65536+request.limits.output_bytes*6+1024, rawMessage=>{
      if(pending || output!==null) {fail();return;}
      try {
        if (!ready && rawMessage && typeof rawMessage === "object" && Object.keys(rawMessage).length === 1 && "ready" in rawMessage && rawMessage.ready === true) {
          if (reason || signal.aborted) { stop(); return; }
          ready = true; child.stdin.write('{"start":true}\n'); return;
        }
        if (!ready) { fail(); return; }
        if (rawMessage && typeof rawMessage === "object" && Object.keys(rawMessage).length === 1 && "output_json" in rawMessage) {
          if (typeof rawMessage.output_json !== "string" || Buffer.byteLength(rawMessage.output_json) > request.limits.output_bytes) { fail(); return; }
          JSON.parse(rawMessage.output_json); output = rawMessage.output_json; return;
        }
        const message = SourceRequestSchema.parse(rawMessage);
        if (message.sequence !== ++sequence || sequence > request.limits.requests) { fail(); return; }
        pending = true;
        void broker(message, executionSignal).then(rawResponse => {
          const response = SourceResponseSchema.parse(rawResponse);
          if (response.sequence !== sequence || signal.aborted || reason) throw new Error("channel closed");
          child.stdin.write(JSON.stringify(response) + "\n",error=>{
            if(error)fail();else pending=false;
          });
        }).catch(fail);
      } catch { fail(); }
    },Math.max(65536,request.limits.output_bytes*6+128));
    child.stdout.on("data",(chunk:Buffer)=>{try{decoder.push(chunk)}catch{fail()}});
    const exit = await new Promise<number | null>(resolve => {
      child.once("error", () => resolve(null)); child.once("close", resolve);
    });
    requestAbort.abort();
    clearTimeout(timer); signal.removeEventListener("abort", abort);
    // Always stop even after successful code exit, before output inspection.
    let memoryLimited=false;
    if(host.cgroupRoot) {
      const events=await readFile(join(host.cgroupRoot,unit,"memory.events"),"utf8").catch(()=>"");
      memoryLimited=events.split("\n").some(line=>/^oom_kill [1-9]/.test(line));
      await stopSourceCgroup(join(host.cgroupRoot,unit));
    } else {
      await exec(SYSTEMCTL, ["--user", "show-environment"], {env,timeout:5000});
      await exec(SYSTEMCTL, ["--user", "stop", `${unit}.service`], { env, timeout: 5000 }).catch(async()=>{
        const {stdout}=await exec(SYSTEMCTL,["--user","show",`${unit}.service`,"--property=LoadState","--value"],{env,timeout:5000});
        if(stdout.trim()!=="not-found")throw new Error("source_cleanup_refused");
      });
    }
    cleanupSafe=true;
    try{decoder.finish()}catch{reason??="source_channel_refused";}
    if (reason) return { status: reason === "source_cancelled" ? "cancelled" : reason === "source_timeout" ? "timed_out" : "failed", output_json: null, error: reason };
    if(memoryLimited) return {status:"failed",output_json:null,error:"source_memory_limit"};
    if(!ready && exit!==0) return {status:"refused",output_json:null,error:"source_isolation_unavailable"};
    if (exit !== 0 || pending || output === null) return { status: "failed", output_json: null, error: "source_execution_failed" };
    return { status: "succeeded", output_json: output, error: null };
  } catch {
    return { status: "refused", output_json: null, error: "source_isolation_or_output_unavailable" };
  } finally {
    if (directory && cleanupSafe) await rm(directory, { recursive: true, force: true });
    if(cleanupSafe)active.set(host.root, (active.get(host.root) ?? 1) - 1);
  }
}
