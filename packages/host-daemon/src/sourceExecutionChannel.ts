import type { HostDaemonFrame, HostServerFrame, SourceResponse } from "@rainver/protocol";
import { type SourceExecutionHost } from "./sourceExecution.js";

/** One channel per authenticated daemon connection. Disconnect cancels all executions;
 * an execution is never resumed by carrying an old request into a new connection. */
export class SourceExecutionChannel {
  private readonly runs = new Map<string, { abort: AbortController; waiting?: { sequence: number; resolve: (r: SourceResponse) => void; reject: () => void } }>();
  constructor(private readonly host: SourceExecutionHost, private readonly send: (frame: HostDaemonFrame) => void) {}
  private sendSafely(frame: HostDaemonFrame): void {
    try { this.send(frame); } catch { this.disconnect(); }
  }
  handle(frame: HostServerFrame): void {
    if (frame.type === "source_execute") {
      const request = frame.execution;
      if (this.runs.has(request.execution_id)) {
        this.sendSafely({type:"source_rejected",execution_id:request.execution_id,error:"source_duplicate_execution"});return;
      }
      if(this.host.enabled===false || this.runs.size>=this.host.maxConcurrent){
        this.sendSafely({type:"source_result",execution_id:request.execution_id,result:{status:"refused",output_json:null,error:this.host.enabled===false?"source_host_not_enabled":"source_capacity_unavailable"}});return;
      }
      const run: { abort: AbortController; waiting?: { sequence: number; resolve: (r: SourceResponse) => void; reject: () => void } } = { abort: new AbortController() };
      this.runs.set(request.execution_id, run);
      const broker = (raw: unknown) => new Promise<SourceResponse>((resolve, reject) => {
        // runSourceExecution has parsed this message already.
        const message = raw as { sequence: number; url: string; method: "GET" | "HEAD" };
        if (run.abort.signal.aborted || run.waiting) { reject(new Error("channel closed")); return; }
        run.waiting = { sequence: message.sequence, resolve, reject: () => reject(new Error("channel closed")) };
        this.sendSafely({ type: "source_request", execution_id: request.execution_id, request: message });
      });
      void import("./sourceCollection.js").then(module=>module.runSourceCollection(this.host,request,broker,run.abort.signal)).then(result => {
        this.runs.delete(request.execution_id);
        run.waiting?.reject();
        this.sendSafely({ type: "source_result", execution_id: request.execution_id, result });
      }).catch(() => {
        this.runs.delete(request.execution_id); run.abort.abort(); run.waiting?.reject();
        this.sendSafely({type:"source_result",execution_id:request.execution_id,result:{status:"failed",output_json:null,error:"source_execution_failed"}});
      });
    } else if (frame.type === "source_response") {
      const run = this.runs.get(frame.execution_id);
      if (!run?.waiting || run.waiting.sequence !== frame.response.sequence) { run?.abort.abort(); return; }
      const waiting = run.waiting; delete run.waiting; waiting.resolve(frame.response);
    } else if (frame.type === "source_cancel") {
      const run = this.runs.get(frame.execution_id);
      run?.abort.abort(); run?.waiting?.reject();
    }
  }
  disconnect(): void {
    for (const run of this.runs.values()) { run.abort.abort(); run.waiting?.reject(); }
  }
}
