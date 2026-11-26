import { randomUUID } from "node:crypto";
import type { HostDaemonFrame, HostRunToolRequestFrame, HostRunToolResultFrame } from "@rainver/protocol";
import { toolRequestTimeoutMs, type ToolRequest, type ToolResponse } from "@rainver/agent-cli/tool-request";

type Send = (frame: HostDaemonFrame) => boolean;
type Launch = { run_id: string; launch_id: string; token: string };
type Pending = { launch: Launch; receive(frame: HostRunToolResultFrame): void; disconnected(): void };

/** Active launches share the current authenticated socket. In-flight requests belong to one connection. */
export class RunToolChannel {
  private send: Send | undefined;
  private readonly pending = new Map<string, Pending>();

  bind(send: Send): void {
    if (this.send) this.disconnect(this.send);
    this.send = send;
  }

  disconnect(send: Send): void {
    if (this.send !== send) return;
    this.send = undefined;
    for (const request of this.pending.values()) request.disconnected();
  }

  receive(send: Send, frame: HostRunToolResultFrame): void {
    if (this.send !== send) return;
    const pending = this.pending.get(frame.request_id);
    if (pending?.launch.run_id === frame.run_id && pending.launch.launch_id === frame.launch_id) pending.receive(frame);
  }

  invoke(launch: Launch, input: ToolRequest, signal: AbortSignal): Promise<ToolResponse> {
    const send = this.send;
    if (!send || signal.aborted) return Promise.reject(new Error("The Host connection to Rainver is unavailable; no tool request was sent."));
    const actionId = input.path === "tools" ? null : decodeURIComponent(input.path.slice("tools/".length));
    const request: HostRunToolRequestFrame["request"] = input.method === "POST"
      ? { kind: "call", action_id: actionId!, idempotency_key: input.idempotency_key ?? input.id, arguments: input.body! }
      : actionId === null ? { kind: "list" } : { kind: "describe", action_id: actionId };
    const ref = { request_id: randomUUID(), run_id: launch.run_id, launch_id: launch.launch_id };
    return new Promise((resolve, reject) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(toolRequestTimeoutMs(input))]);
      const settle = () => {
        this.pending.delete(ref.request_id);
        deadline.removeEventListener("abort", cancel);
      };
      const failure = () => {
        settle();
        reject(new Error("The Host tool request was interrupted; the action outcome may be unknown. Check its status before repeating a write."));
      };
      const cancel = () => {
        failure();
        if (this.send === send) {
          try { send({ type: "run_tool_cancel", ...ref }); } catch { /* The connection is gone. */ }
        }
      };
      this.pending.set(ref.request_id, {
        launch,
        disconnected: failure,
        receive: (frame) => {
          settle();
          resolve({
            status: frame.status, text: frame.text,
            ...(frame.acknowledge ? { acknowledge: () => {
              if (this.send === send) {
                try { send({ type: "run_tool_result_ack", ...ref }); } catch { /* The response was published before disconnect. */ }
              }
            } } : {}),
          });
        },
      });
      deadline.addEventListener("abort", cancel, { once: true });
      try {
        if (!send({ type: "run_tool_request", ...ref, token: launch.token, request })) failure();
      } catch {
        failure();
      }
    });
  }
}
