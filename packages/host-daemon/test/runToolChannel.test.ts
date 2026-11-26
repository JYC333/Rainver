import { randomUUID } from "node:crypto";
import type { HostDaemonFrame, HostRunToolResultFrame } from "@rainver/protocol";
import { expect, it } from "vitest";
import { RunToolChannel } from "../src/runToolChannel.js";

const launch = { run_id: randomUUID(), launch_id: randomUUID(), token: "r".repeat(43) };
const write = { id: randomUUID(), method: "POST" as const, path: "tools/task.report", body: {}, idempotency_key: "logical-write" };

it("rejects an interrupted write without replay and uses a new socket for the next call", async () => {
  const tools = new RunToolChannel();
  const firstFrames: HostDaemonFrame[] = [];
  const secondFrames: HostDaemonFrame[] = [];
  const first = (frame: HostDaemonFrame) => { firstFrames.push(frame); return true; };
  const second = (frame: HostDaemonFrame) => { secondFrames.push(frame); return true; };
  tools.bind(first);
  const interrupted = expect(tools.invoke(launch, write, new AbortController().signal)).rejects.toThrow("outcome may be unknown");
  tools.bind(second);
  await interrupted;
  expect(firstFrames).toHaveLength(1);
  expect(secondFrames).toEqual([]);
  tools.disconnect(first);

  const resumed = tools.invoke(launch, write, new AbortController().signal);
  const outbound = secondFrames[0]!;
  if (outbound.type !== "run_tool_request") throw new Error("missing tool request");
  expect(outbound.request).toMatchObject({ kind: "call", idempotency_key: "logical-write" });
  const response: HostRunToolResultFrame = { type: "run_tool_result", request_id: outbound.request_id,
    run_id: launch.run_id, launch_id: launch.launch_id, status: 200, text: '{"ok":true}', acknowledge: true };
  tools.receive(first, response);
  tools.receive(second, { ...response, launch_id: randomUUID() });
  tools.receive(second, response);
  const answer = await resumed;
  expect(answer.text).toBe('{"ok":true}');
  expect(secondFrames).toHaveLength(1);
  answer.acknowledge?.();
  expect(secondFrames[1]).toMatchObject({ type: "run_tool_result_ack", request_id: outbound.request_id, launch_id: launch.launch_id });
});

it("cancels only the in-flight call on the current socket when its local bridge stops", async () => {
  const tools = new RunToolChannel();
  const sent: HostDaemonFrame[] = [];
  tools.bind((frame) => { sent.push(frame); return true; });
  const bridge = new AbortController();
  const settled = expect(tools.invoke(launch, write, bridge.signal)).rejects.toThrow("interrupted");
  bridge.abort();
  await settled;
  expect(sent.map((frame) => frame.type)).toEqual(["run_tool_request", "run_tool_cancel"]);
});
