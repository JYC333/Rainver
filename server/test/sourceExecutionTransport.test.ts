import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { HostServerFrame, SourceExecution } from "@rainver/protocol";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
const request = (): SourceExecution => ({ execution_id: randomUUID(), version_sha256: "a".repeat(64), code: "export default()=>({})", input_json: "{}",
  limits: { wall_ms: 1000, memory_bytes: 128 * 1024 * 1024, cpu_quota_percent: 50, processes: 32, output_bytes: 100, requests: 2 } });
function world() {
  const frames: HostServerFrame[] = []; const registry = new HostConnectionRegistry();
  const sink = { send: (frame: HostServerFrame) => frames.push(frame), close: () => {} };
  registry.registerConnection("host", sink,true);
  return { frames, registry, sink };
}
it("binds request identity to the authenticated Host and rejects replays", async () => {
  const { frames, registry } = world(); const execution = request(); let calls = 0;
  const done = registry.executeSource("host", execution, async r => { calls++; return {sequence:r.sequence,status:200,body_base64:"",content_type:""}; }, new AbortController().signal);
  const dispatched=frames[0];if(dispatched.type!=="source_execute")throw new Error("missing frame");
  expect(dispatched.execution.execution_id).not.toBe(execution.execution_id);
  execution.execution_id=dispatched.execution.execution_id;
  registry.receiveSourceRequest("other", execution.execution_id, { sequence: 1, url: "https://example.test", method: "GET" });
  expect(calls).toBe(0);
  registry.receiveSourceRequest("host", execution.execution_id, { sequence: 1, url: "https://example.test", method: "GET" });
  await Promise.resolve(); expect(calls).toBe(1);
  registry.receiveSourceRequest("host", execution.execution_id, { sequence: 1, url: "https://example.test", method: "GET" });
  expect(await done).toMatchObject({ status: "failed", error: "source_channel_refused" });
  expect(frames.at(-1)?.type).toBe("source_cancel");
});
it("aborts pending HTTP on disconnect and ignores late completion", async () => {
  const { registry, sink,frames } = world(); const execution = request(); let aborted = false;
  const done = registry.executeSource("host", execution, async (_r, signal) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); }, new AbortController().signal);
  const dispatched=frames[0];if(dispatched.type!=="source_execute")throw new Error("missing frame");execution.execution_id=dispatched.execution.execution_id;
  registry.receiveSourceRequest("host", execution.execution_id, { sequence: 1, url: "https://example.test", method: "GET" });
  registry.unregisterConnection("host", sink,true);
  expect(await done).toMatchObject({ status: "failed" }); expect(aborted).toBe(true);
  registry.receiveSourceResult("host", execution.execution_id, { status: "succeeded", output_json: "{}", error: null });
});
it("cancels and bounds output without accepting a partial success", async () => {
  const { registry, frames } = world(); const execution = request(); const signal = new AbortController();
  const done = registry.executeSource("host", execution, async () => { throw new Error("unused"); }, signal.signal);
  signal.abort(); expect(await done).toMatchObject({ status: "cancelled" }); expect(frames.at(-1)?.type).toBe("source_cancel");
  const next = request(); const oversized = registry.executeSource("host", next, async () => { throw new Error("unused"); }, new AbortController().signal);
  const dispatch=[...frames].reverse().find(f=>f.type==="source_execute");if(dispatch?.type!=="source_execute")throw new Error("missing frame");
  registry.receiveSourceResult("host", dispatch.execution.execution_id, { status: "succeeded", output_json: "x".repeat(101), error: null });
  expect(await oversized).toMatchObject({ status: "failed", error: "source_output_refused" });
});

it("revokes the request grant when a new connection replaces the Host", async () => {
  const {registry} = world(); const execution=request();
  const done=registry.executeSource("host",execution,async()=>{throw new Error("unused")},new AbortController().signal);
  registry.registerConnection("host",{send:()=>{},close:()=>{}});
  expect(await done).toMatchObject({status:"failed",error:"source_host_disconnected"});
});
it("does not dispatch to Hosts that did not opt into the Sources contract",async()=>{
 const registry=new HostConnectionRegistry();const frames:HostServerFrame[]=[];
 registry.registerConnection("host",{send:f=>frames.push(f),close:()=>{}});
 expect(await registry.executeSource("host",request(),async()=>{throw new Error("unused")},new AbortController().signal)).toMatchObject({status:"refused"});expect(frames).toEqual([]);
});
