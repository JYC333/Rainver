/** The IPC protocol between a test and `briefingWorkerProcess.mjs`. */
export type Frame = Record<string, unknown> & { type: string; run_id?: string; launch_id?: string };
export type WorkerCommand =
  | { cmd: "policy"; prompt?: { answer: string } | "hold"; terminate?: "ack" | "drop"; adapterOutput?: Record<string,unknown>|null }
  | { cmd: "answer"; runId: string; text: string }
  | { cmd: "complete"; runId: string; launchId: string; exitCode: number }
  | { cmd: "disconnect" }
  | { cmd: "reconnect" }
  | { cmd: "cancel"; runId: string; spaceId: string; userId: string }
  | { cmd: "ping"; seq: number }
  | { cmd: "stop" };
export type WorkerReport =
  | { type: "ready"; pid: number }
  | { type: "frame"; frame: { type: string; run_id?: string; launch_id?: string; force?: boolean; method?: string } }
  | { type: "prompted"; runId: string; launchId: string }
  | { type: "cancelled"; result: unknown }
  | { type: "pong"; seq: number }
  | { type: "stopped" };
