// A real jobs worker in its own OS process, from the built server (`dist`, as
// `node dist/index.js` runs it; `briefingWorkerHarness.ts` rebuilds it first), for restart and stop tests:
// `startJobsWorker` against the isolated test database, exactly as the server
// starts it, with one synthetic Host connected to this process's
// `sharedHostConnectionRegistry`. The Host speaks the daemon wire frames
// (`launch` → `launched`, stdin JSON-RPC ↔ stdout, `terminate`, `complete`)
// and a minimal ACP agent behind them; it calls no model. The parent drives
// it over IPC and is told every frame the server sent.
import { loadConfig } from "../../dist/config.js";
import { sharedHostConnectionRegistry as registry } from "../../dist/modules/hosts/connectionRegistry.js";
import { startJobsWorker } from "../../dist/modules/jobs/workerRuntime.js";
import { buildRunOrchestration } from "../../dist/modules/runs/orchestrationFactory.js";
import { buildServer } from "../../dist/server.js";

const hostId = process.env.BRIEFING_WORKER_HOST_ID;
const config = loadConfig({
  SERVER_DATABASE_URL: process.env.BRIEFING_WORKER_DATABASE_URL,
  RAINVER_HOME: process.env.BRIEFING_WORKER_HOME,
  JOBS_WORKER_CONCURRENCY: "1",
});
// Optional synthetic adapter-result fields, after real ACP completion and before
// orchestration's actual materializer/status calculation. Never replaces either.
import { RunOrchestrationService } from "../../dist/modules/runs/orchestrationService.js";
let adapterOutput = null;
const originalInvoke = RunOrchestrationService.prototype.invokeAdapter;
RunOrchestrationService.prototype.invokeAdapter = async function (...args) {
  const result = await originalInvoke.apply(this,args);
  return adapterOutput ? {...result,output_json:{...result.output_json,...adapterOutput}} : result;
};
const report = (message) => process.send?.(message);

let promptPolicy = "hold";
let terminatePolicy = "ack";
const launches = new Map();
/** A prompt held by the `hold` policy: answered later on command, against the launch it arrived on. */
const held = new Map();

const out = (runId, launchId, message) =>
  registry.receiveOutput(hostId, runId, `${JSON.stringify(message)}\n`, launchId);

function answer(runId, launchId, id, sessionId, text) {
  out(runId, launchId, { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  out(runId, launchId, { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

const sink = {
  send(frame) {
    const method = frame.type === "stdin" && typeof frame.value === "string" ? JSON.parse(frame.value).method : undefined;
    report({ type: "frame", frame: { type: frame.type, run_id: frame.run_id, launch_id: frame.launch_id, force: frame.force, method } });
    const runId = String(frame.run_id ?? "");
    if (frame.type === "launch") {
      launches.set(runId, String(frame.launch_id));
      queueMicrotask(() => registry.receiveLaunched(hostId, runId, String(frame.launch_id)));
      return;
    }
    const launchId = String(frame.launch_id ?? launches.get(runId) ?? "");
    if (frame.type === "stdin" && typeof frame.value === "string") {
      const request = JSON.parse(frame.value);
      if (request.id === undefined) return;
      queueMicrotask(() => {
        if (request.method === "initialize") return out(runId, launchId, { jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } });
        if (request.method === "session/new") return out(runId, launchId, { jsonrpc: "2.0", id: request.id, result: { sessionId: `synthetic-${runId}` } });
        if (request.method === "session/prompt") {
          const sessionId = request.params?.sessionId ?? `synthetic-${runId}`;
          report({ type: "prompted", runId, launchId, prompt: request.params?.prompt });
          if (promptPolicy === "hold") {
            held.set(runId, { launchId, id: request.id, sessionId });
            return;
          }
          return answer(runId, launchId, request.id, sessionId, promptPolicy.answer);
        }
        out(runId, launchId, { jsonrpc: "2.0", id: request.id, result: {} });
      });
      return;
    }
    if (frame.type === "stdin_close") {
      queueMicrotask(() => registry.receiveComplete(hostId, runId, { exit_code: 0, timed_out: false, error: null }, launchId));
      return;
    }
    if (frame.type === "terminate" && terminatePolicy === "ack") {
      queueMicrotask(() => registry.receiveComplete(hostId, runId, { exit_code: 143, timed_out: false, error: null }, launchId));
    }
  },
  close() {},
};

registry.registerConnection(hostId, sink);
// As `index.ts` does: the server registers every module (Run settlement
// reconcilers included) — it is never told to listen here — and the
// background services start the jobs worker. The rest of the scheduler is
// not started: no briefing path depends on it.
const app = buildServer(config);
await app.ready();
const worker = startJobsWorker(config);
const orchestration = buildRunOrchestration(config).orchestration;

process.on("message", async (message) => {
  if (message.cmd === "policy") {
    if (Object.hasOwn(message,"adapterOutput")) adapterOutput=message.adapterOutput;
    if (message.prompt) promptPolicy = message.prompt;
    if (message.terminate) terminatePolicy = message.terminate;
  } else if (message.cmd === "answer") {
    const pending = held.get(message.runId);
    if (pending) { held.delete(message.runId); answer(message.runId, pending.launchId, pending.id, pending.sessionId, message.text); }
  } else if (message.cmd === "complete") {
    registry.receiveComplete(hostId, message.runId, { exit_code: message.exitCode, timed_out: false, error: null }, message.launchId);
  } else if (message.cmd === "disconnect") {
    registry.unregisterConnection(hostId, sink);
  } else if (message.cmd === "reconnect") {
    registry.registerConnection(hostId, sink);
  } else if (message.cmd === "cancel") {
    const result = await orchestration.cancelRun({ run_id: message.runId, space_id: message.spaceId, requested_by_user_id: message.userId });
    report({ type: "cancelled", result });
  } else if (message.cmd === "ping") {
    // IPC is ordered: every command sent before this one has been handled.
    report({ type: "pong", seq: message.seq });
  } else if (message.cmd === "stop") {
    await worker?.stop();
    await app.close();
    report({ type: "stopped" });
    process.exit(0);
  }
});
report({ type: "ready", pid: process.pid });
