import {
  HOST_RUN_TOOL_REQUEST_LIMIT, HOST_RUN_TOOL_RESPONSE_LIMIT,
  type HostRunToolCancelFrame, type HostRunToolRequestFrame, type HostRunToolResultAckFrame, type HostRunToolResultFrame,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { dispatchRunTool, resolveRunToolScope } from "../runs/runToolService.js";

type Correlation = { request_id: string; run_id: string; launch_id: string };
type Pending = Correlation & { abort: AbortController; timer: ReturnType<typeof setTimeout>; afterReply?: () => void };

/** One channel per authenticated socket. Tool requests are never replayed on reconnect. */
export class HostRunToolChannel {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly config: ServerConfig,
    private readonly accepts: (frame: Correlation) => boolean,
    private readonly send: (frame: HostRunToolResultFrame) => void,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  request(frame: HostRunToolRequestFrame): void {
    const { request_id, run_id, launch_id, token, request } = frame;
    const ref = { request_id, run_id, launch_id };
    if (this.pending.has(request_id)) return;
    if (!this.accepts(ref)) {
      this.reply(ref, 403, { detail: "Run tool request is outside this Host's current launch" });
      return;
    }
    if (this.pending.size >= 64) {
      this.reply(ref, 429, { detail: "Too many Run tool requests on this Host" });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(request)) > HOST_RUN_TOOL_REQUEST_LIMIT) {
      this.reply(ref, 413, { detail: "Run tool request is too large" });
      return;
    }
    const timer = setTimeout(() => this.finish(ref, pending), 75_000);
    timer.unref();
    const pending: Pending = { ...ref, abort: new AbortController(), timer };
    this.pending.set(request_id, pending);
    void (async () => {
      const scope = await resolveRunToolScope(this.config, run_id, token);
      if (pending.abort.signal.aborted) return;
      const result = !("run" in scope) ? scope
        : scope.launchId !== launch_id || !this.accepts(ref)
          ? { status: 403, body: { detail: "Run tool identity does not belong to this Host launch" } }
          : await dispatchRunTool(scope, request.kind === "list" ? request
            : request.kind === "describe" ? { kind: "describe", actionId: request.action_id }
            : { kind: "call", actionId: request.action_id, idempotencyKey: request.idempotency_key, arguments: () => request.arguments },
          pending.abort.signal);
      if (pending.abort.signal.aborted || !this.accepts(ref)) return;
      // Wait for the Host to publish the durable wait receipt to the local bridge before yielding the Run.
      pending.afterReply = "afterReply" in result ? result.afterReply : undefined;
      if (!this.reply(ref, result.status, result.body, Boolean(pending.afterReply))) pending.afterReply = undefined;
    })().catch((error) => {
      if (pending.abort.signal.aborted) return;
      pending.afterReply = undefined;
      this.reportFailure(error);
      this.reply(ref, 503, { detail: "Run tool service is unavailable" });
    }).finally(() => {
      if (!pending.afterReply) this.finish(ref, pending);
    });
  }

  cancel(frame: HostRunToolCancelFrame): void { this.finish(frame); }

  acknowledge(frame: HostRunToolResultAckFrame): void {
    const pending = this.match(frame);
    if (!pending?.afterReply || !this.accepts(frame)) return;
    this.finish(frame);
    try { pending.afterReply(); }
    catch (error) { this.reportFailure(error); }
  }

  close(): void {
    for (const pending of this.pending.values()) this.finish(pending);
  }

  private match(ref: Correlation): Pending | undefined {
    const pending = this.pending.get(ref.request_id);
    return pending?.run_id === ref.run_id && pending.launch_id === ref.launch_id ? pending : undefined;
  }

  private finish(ref: Correlation, expected?: Pending): void {
    const pending = this.match(ref);
    if (!pending || (expected && pending !== expected)) return;
    this.pending.delete(ref.request_id);
    clearTimeout(pending.timer);
    pending.abort.abort();
  }

  private reply(ref: Correlation, status: number, body: unknown, acknowledge = false): boolean {
    const text = JSON.stringify(body ?? null);
    try {
      if (Buffer.byteLength(text) > HOST_RUN_TOOL_RESPONSE_LIMIT) {
        this.send({ type: "run_tool_result", ...ref, status: 502, text: '{"detail":"Run tool response is too large"}' });
        return false;
      }
      this.send({ type: "run_tool_result", ...ref, status, text, ...(acknowledge ? { acknowledge: true } : {}) });
      return true;
    } catch {
      return false;
    }
  }
}
