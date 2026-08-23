import { spawn } from "node:child_process";

/**
 * The daemon discovers whatever the machine already has installed — it
 * never installs or manages a CLI's version tree itself (that would make it
 * a second `runtimeTools` service; ADR 0016 keeps execution-host capability
 * discovery to "what is on PATH right now").
 */
const PROBED_BINARIES = ["claude", "codex", "opencode", "git"] as const;

export type ProbedBinary = (typeof PROBED_BINARIES)[number];

export interface DaemonCapabilities {
  runtimes: ProbedBinary[];
  versions: Partial<Record<ProbedBinary, string>>;
}

function probeVersion(bin: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(null);
    }, timeoutMs);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout.trim().split("\n")[0]!.slice(0, 200) : null);
    });
  });
}

export async function detectCapabilities(): Promise<DaemonCapabilities> {
  const runtimes: ProbedBinary[] = [];
  const versions: Partial<Record<ProbedBinary, string>> = {};
  for (const bin of PROBED_BINARIES) {
    const version = await probeVersion(bin);
    if (version !== null) {
      runtimes.push(bin);
      versions[bin] = version;
    }
  }
  return { runtimes, versions };
}
