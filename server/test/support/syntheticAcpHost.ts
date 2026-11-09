import type { HostConnectionRegistry, HostFrameSink } from "../../src/modules/hosts/connectionRegistry.js";

/** One `session/prompt` the synthetic Host received, exactly as it arrived on the wire. */
export interface SyntheticAcpPrompt {
  runId: string;
  launchId: string;
  /** `session/new`, or `session/resume` naming the vendor session being continued. */
  sessionMethod: "session/new" | "session/resume";
  sessionId: string;
  prompt: Array<Record<string, unknown>>;
}

export type SyntheticAcpAnswer = { text: string } | { error: string };

/**
 * An in-process Host daemon at the connection-registry boundary: it speaks the
 * daemon wire frames (`launch` → `launched`, stdin JSON-RPC ↔ `output`,
 * `stdin_close` → `complete`) and a minimal ACP agent behind them that calls
 * no model. Every `session/prompt` is recorded as sent, so a test can compare
 * the actual ACP prompt with the Delivery and Snapshot of the same invocation.
 *
 * The out-of-process equivalent for worker restart tests is
 * `briefingWorkerProcess.mjs`.
 */
export class SyntheticAcpHost {
  readonly prompts: SyntheticAcpPrompt[] = [];
  private readonly launches = new Map<string, string>();
  private readonly sessionMethods = new Map<string, SyntheticAcpPrompt["sessionMethod"]>();
  private readonly sink: HostFrameSink;
  private nextSession = 1;

  constructor(
    private readonly registry: HostConnectionRegistry,
    private readonly hostId: string,
    /** What the agent does with a prompt: reply with text, or fail the turn with a JSON-RPC error. */
    public answer: (prompt: SyntheticAcpPrompt) => Promise<SyntheticAcpAnswer> | SyntheticAcpAnswer = () => ({ text: "Done." }),
  ) {
    this.sink = { send: (frame) => this.receive(frame), close: () => undefined };
  }

  connect(): this {
    this.registry.registerConnection(this.hostId, this.sink);
    return this;
  }

  disconnect(): void {
    this.registry.unregisterConnection(this.hostId, this.sink);
  }

  /** The prompts one Run received, in order. */
  promptsFor(runId: string): SyntheticAcpPrompt[] {
    return this.prompts.filter((prompt) => prompt.runId === runId);
  }

  private out(runId: string, launchId: string, message: Record<string, unknown>): void {
    this.registry.receiveOutput(this.hostId, runId, `${JSON.stringify(message)}\n`, launchId);
  }

  private receive(frame: Record<string, unknown>): void {
    const runId = String(frame.run_id ?? "");
    if (frame.type === "launch") {
      const launchId = String(frame.launch_id);
      this.launches.set(runId, launchId);
      queueMicrotask(() => this.registry.receiveLaunched(this.hostId, runId, launchId));
      return;
    }
    const launchId = String(frame.launch_id ?? this.launches.get(runId) ?? "");
    if (frame.type === "stdin" && typeof frame.value === "string") {
      const request = JSON.parse(frame.value) as { id?: number | string; method?: string; params?: Record<string, unknown> };
      if (request.id === undefined) return;
      queueMicrotask(() => void this.respond(runId, launchId, request as { id: number | string; method?: string; params?: Record<string, unknown> }));
      return;
    }
    if (frame.type === "stdin_close") {
      queueMicrotask(() => this.registry.receiveComplete(this.hostId, runId, { exit_code: 0, timed_out: false, error: null }, launchId));
      return;
    }
    if (frame.type === "terminate") {
      queueMicrotask(() => this.registry.receiveComplete(this.hostId, runId, { exit_code: 143, timed_out: false, error: null }, launchId));
    }
  }

  private async respond(runId: string, launchId: string, request: { id: number | string; method?: string; params?: Record<string, unknown> }): Promise<void> {
    const reply = (result: Record<string, unknown>) => this.out(runId, launchId, { jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize") return reply({ protocolVersion: 1 });
    if (request.method === "session/new") {
      this.sessionMethods.set(runId, "session/new");
      return reply({ sessionId: `synthetic-session-${this.nextSession++}` });
    }
    if (request.method === "session/resume") {
      this.sessionMethods.set(runId, "session/resume");
      return reply({});
    }
    if (request.method === "session/prompt") {
      const sessionId = String(request.params?.sessionId ?? "");
      const prompt: SyntheticAcpPrompt = {
        runId,
        launchId,
        sessionMethod: this.sessionMethods.get(runId) ?? "session/new",
        sessionId,
        prompt: (request.params?.prompt ?? []) as Array<Record<string, unknown>>,
      };
      this.prompts.push(prompt);
      // A throwing `answer` (a failed assertion inside it) fails the turn
      // rather than leaving the Run waiting on a reply that never comes.
      const answer = await Promise.resolve()
        .then(() => this.answer(prompt))
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      if ("error" in answer) {
        return this.out(runId, launchId, { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: answer.error } });
      }
      this.out(runId, launchId, {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer.text } } },
      });
      return reply({ stopReason: "end_turn" });
    }
    reply({});
  }
}
