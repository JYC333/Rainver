import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import type { ServerConfig } from "../../config.js";

export const ALLOWED_DEPLOYER_JOB_TYPES = new Set([
  "rebuild_rainver",
  "restart_rainver",
  "health_check",
]);

export interface DeployerResult {
  job_id: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  output?: unknown;
}

export class DeployerSocketClient {
  constructor(private readonly config: Pick<ServerConfig, "deployerSocketPath">) {}

  async submit(jobType: string, args: Record<string, unknown> = {}): Promise<DeployerResult> {
    if (!ALLOWED_DEPLOYER_JOB_TYPES.has(jobType)) {
      return {
        job_id: null,
        status: "failed",
        error: `Unknown deployer job_type: ${jobType}`,
      };
    }
    if (!existsSync(this.config.deployerSocketPath)) {
      return {
        job_id: null,
        status: "failed",
        error: `Deployer socket not found: ${this.config.deployerSocketPath}`,
      };
    }
    return callSocket(this.config.deployerSocketPath, {
      job_type: jobType,
      args,
    });
  }
}

function callSocket(socketPath: string, payload: Record<string, unknown>): Promise<DeployerResult> {
  return new Promise((resolveResult) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const done = (result: DeployerResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      done({ job_id: null, status: "failed", error: "Deployer socket request timed out." });
    }, 310_000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      done(parseSocketResponse(buffer.slice(0, newline)));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      done({ job_id: null, status: "failed", error: error.message });
    });
    socket.on("end", () => {
      clearTimeout(timer);
      if (!buffer.trim()) {
        done({ job_id: null, status: "failed", error: "Deployer socket closed without a response." });
        return;
      }
      done(parseSocketResponse(buffer.trim()));
    });
  });
}

function parseSocketResponse(text: string): DeployerResult {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      job_id: typeof parsed.job_id === "string" ? parsed.job_id : null,
      status: statusValue(parsed.status),
      error: typeof parsed.error === "string" ? parsed.error : null,
      output: parsed.output,
    };
  } catch (error) {
    return {
      job_id: null,
      status: "failed",
      error: error instanceof Error ? error.message : "Invalid deployer socket response.",
    };
  }
}

function statusValue(value: unknown): DeployerResult["status"] {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed"
    ? value
    : "failed";
}
