import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceExecution } from "@rainver/protocol";
import { runSourceExecution, sourceSandboxCommand } from "../src/sourceExecution.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function execution(code: string, overrides: Partial<SourceExecution["limits"]> = {}): SourceExecution {
  return { execution_id: randomUUID(), version_sha256: createHash("sha256").update(code).digest("hex"), code, input_json: "{}",
    limits: { wall_ms: 5000, memory_bytes: 256 * 1024 * 1024, cpu_quota_percent: 50, processes: 32, output_bytes: 4096, requests: 10, ...overrides } };
}
async function host() {
  const root = await mkdtemp(join(tmpdir(), "source-execution-test-")); roots.push(root);
  return { root, node: process.execPath, maxConcurrent: 1, bwrap: process.env.SOURCE_EXECUTION_BWRAP,cgroupRoot:process.env.SOURCE_EXECUTION_CGROUP_ROOT };
}
const broker = async (raw: unknown) => ({ sequence: (raw as {sequence: number}).sequence, status: 200, body_base64: "e30=", content_type: "application/json" });

it("refuses changed code and caller-supplied host paths before execution", async () => {
  const h = await host(); const request = execution("export default () => ({ok:true})");
  expect(await runSourceExecution(h, { ...request, code: request.code + " " }, broker, new AbortController().signal)).toMatchObject({ status: "refused", error: "source_version_mismatch" });
  expect(await runSourceExecution(h, { ...request, cwd: "/" }, broker, new AbortController().signal)).toMatchObject({ status: "refused", error: "source_contract_invalid" });
});
it("never relaxes isolation or resource enforcement for a source execution", async () => {
  const h = await host(); const command = sourceSandboxCommand(h, execution("export default()=>({})"), "/tmp/code", "test-unit");
  if(h.cgroupRoot) {
    expect(command.command).toBe("/usr/bin/prlimit");expect(command.args).toContain("--core=0:0");expect(command.args.at(-1)).toContain('"direct":');
  }else{
    expect(command.command).toBe("/usr/bin/systemd-run");
    expect(command.args).toContain("--property=MemorySwapMax=0");
    expect(command.args).toContain("--property=KillMode=control-group");
  }
  // Bwrap is passed to the trusted controller-verifying supervisor, never shell-expanded.
  expect(command.args.at(-1)).toContain('"--unshare-all"');
  expect(command.args.at(-1)).toContain('"--remount-ro"');
});
it("refuses unavailable isolation without attempting a request", async () => {
  let requests = 0;
  const h = await host();
  const result = await runSourceExecution({ ...h, bwrap: "/does-not-exist" }, execution("export default()=>({})"), async r => { requests++; return broker(r); }, new AbortController().signal);
  expect(result.status).toBe("refused"); expect(requests).toBe(0);
});

// Explicit integration gate: normal suite never depends on OS sandboxes or user systemd.
describe.skipIf(process.env.SOURCE_EXECUTION_OS_SMOKE !== "1")("source execution OS containment", () => {
  it("refuses an unavailable supervisor before importing code",async()=>{
    let called=false;const h=await host();
    const result=await runSourceExecution({...h,cgroupRoot:"/sys/fs/cgroup/source-nonexistent"},execution("export default()=>({})"),async r=>{called=true;return broker(r)},new AbortController().signal);
    expect(result.status).toBe("refused");expect(called).toBe(false);
  });
  it("binds only the real Node executable when a symlink sits beside a shell",async()=>{
    const h=await host();const bin=join(h.root,"system-bin");await mkdir(bin);
    await symlink(process.execPath,join(bin,"node"));await writeFile(join(bin,"sh"),"shell-sentinel",{mode:0o700});
    const result=await runSourceExecution({...h,node:join(bin,"node")},execution(`import {access} from 'node:fs/promises';export default async()=>{let shell=false;try{await access('/runtime/sh');shell=true}catch{}return {shell}}`),broker,new AbortController().signal);
    expect(result).toMatchObject({status:"succeeded",output_json:'{"shell":false}'});
  });
  it("inherits zero core and exact file-size hard/soft ceilings",async()=>{
    const code=`import {readFile} from 'node:fs/promises';export default async()=>{const text=await readFile('/proc/self/limits','utf8');return {core:text.split('\\n').find(l=>l.startsWith('Max core file size')),file:text.split('\\n').find(l=>l.startsWith('Max file size'))}}`;
    const result=await runSourceExecution(await host(),execution(code),broker,new AbortController().signal);
    expect(result.status).toBe("succeeded");const limits=JSON.parse(result.output_json!);
    expect(limits.core).toMatch(/Max core file size\s+0\s+0\s+bytes/);
    expect(limits.file).toMatch(/Max file size\s+4096\s+4096\s+bytes/);
  });
  it("collects bounded JSON using the parent-owned request channel", async () => {
    let requests = 0;
    const result = await runSourceExecution(await host(), execution("export default async ({request}) => {await request('https://example.test/api/1');await request('https://example.test/api/2');return {status:(await request('https://example.test/api/3')).status}}"), async raw => { requests++; return broker(raw); }, new AbortController().signal);
    expect(result).toEqual({ status: "succeeded", output_json: '{"status":200}', error: null }); expect(requests).toBe(3);
  });
  it("blocks native sockets and alternative HTTP clients at the OS boundary", async () => {
    let hits = 0;
    const server = createServer((_req, res) => { hits++; res.end("bypass"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture");
    const code = `import net from 'node:net'; import http from 'node:http';
      export default async () => {
        const socket = await new Promise(resolve => { const s=net.connect(${address.port},'127.0.0.1');s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false)); });
        const alternate = await new Promise(resolve => {http.get('http://127.0.0.1:${address.port}',r=>{r.destroy();resolve(true)}).on('error',()=>resolve(false));});
        return {socket,alternate}; };`;
    try {
      expect(await runSourceExecution(await host(), execution(code), broker, new AbortController().signal)).toMatchObject({ status: "succeeded", output_json: '{"socket":false,"alternate":false}' });
      expect(hits).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("rejects writes beyond the output mount and hides host secrets and shell", async () => {
    const code = `import {writeFile,readFile,access} from 'node:fs/promises'; export default async()=>{
      let write=false,secret=false,shell=false;
      try{await writeFile('/code/handler.mjs','changed');write=true}catch{}
      try{await readFile('/host-private-sentinel');secret=true}catch{}
      try{await access('/usr/bin/sh');shell=true}catch{}
      return {write,secret,shell};}`;
    expect(await runSourceExecution(await host(), execution(code), broker, new AbortController().signal)).toMatchObject({ status: "succeeded", output_json: '{"write":false,"secret":false,"shell":false}' });
  });
  it("rejects forged identity and drops raw secret-bearing logs", async () => {
    const result = await runSourceExecution(await host(), execution(`export default()=>{console.log('Bearer fixture-secret');return {}}`), broker, new AbortController().signal);
    expect(result.status).toBe("failed"); expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect((await runSourceExecution(await host(), execution(`export default()=>{process.stdout.write(JSON.stringify({sequence:1,url:'https://example.test',method:'GET',account:'other'})+'\\n');return {}}`), broker, new AbortController().signal)).status).toBe("failed");
  });
  it("fails closed on oversized output and unbounded allocation", async () => {
    expect((await runSourceExecution(await host(), execution(`export default()=>({large:'x'.repeat(10000)})`), broker, new AbortController().signal)).status).not.toBe("succeeded");
    expect((await runSourceExecution(await host(), execution(`export default()=>{const arrays=[];while(true)arrays.push(Buffer.alloc(16*1024*1024,1));}`, { memory_bytes: 128 * 1024 * 1024 }), broker, new AbortController().signal)).status).toBe("failed");
  });
  it("preserves large multibyte output across real pipe chunks", async () => {
    const text="汉字🙂".repeat(20000);
    const result=await runSourceExecution(await host(),execution(`export default()=>({text:'汉字🙂'.repeat(20000)})`,{output_bytes:1024*1024}),broker,new AbortController().signal);
    expect(result.status).toBe("succeeded"); expect(JSON.parse(result.output_json!).text).toBe(text);
  });
  it("bounds output tmpfs and descendant process creation", async () => {
    const disk = `import {writeFile,readdir,rm} from 'node:fs/promises'; export default async()=>{
      try{for(let i=0;i<10000;i++)await writeFile('/output/'+i,Buffer.alloc(4096));return {bounded:false}}
      catch(error){for(const file of await readdir('/output'))await rm('/output/'+file);return {bounded:error.code==='ENOSPC'}}}`;
    expect(await runSourceExecution(await host(), execution(disk), broker, new AbortController().signal)).toMatchObject({status:"succeeded",output_json:'{"bounded":true}'});
    const processes = `import {spawn} from 'node:child_process'; export default async()=>{
      const started=await Promise.all(Array.from({length:20},()=>new Promise(resolve=>{
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        child.once('error',()=>resolve(false));child.once('spawn',()=>resolve(true));child.unref();
      })));return {bounded:started.filter(Boolean).length<20};}`;
    expect(await runSourceExecution(await host(), execution(processes,{wall_ms:2000}), broker, new AbortController().signal)).toMatchObject({status:"succeeded",output_json:'{"bounded":true}'});
  });
  it("terminates CPU loops and cancellation without returning partial output", async () => {
    expect((await runSourceExecution(await host(), execution(`export default()=>{while(true){}}`, { wall_ms: 1000 }), broker, new AbortController().signal)).status).toBe("timed_out");
    const controller = new AbortController();
    const result = runSourceExecution(await host(), execution(`export default async ({request})=>{await request('https://example.test');while(true){}}`), async raw => { controller.abort(); return broker(raw); }, controller.signal);
    expect(await result).toMatchObject({ status: "cancelled", output_json: null });
  });
});
