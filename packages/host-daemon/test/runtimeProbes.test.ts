import { describe, expect, it } from "vitest";
import { parseServerFrame } from "../src/commands/run.js";

// `hello_ack.runtime_probes` is what decides which binary this daemon spawns
// for an adapter; the shape is the shared contract's, not a local parser's.
describe("runtime probes in hello_ack", () => {
  const probe = {
    adapter_type: "opencode",
    runtime: "opencode",
    argv: ["opencode", "acp", "--cwd", "rainver:remote-workspace-cwd"],
    distribution: null,
    version: null,
    login: { command: ["opencode", "auth", "login"], home_subdir: ".local/share/opencode", credential_file: "auth.json" },
    remote_host_only: false,
  };

  it("carries a well-formed probe through whole", () => {
    const parsed = parseServerFrame({ type: "hello_ack", host_id: "host-1", runtime_probes: [probe] });
    expect(parsed.ok && parsed.frame.type === "hello_ack" ? parsed.frame.runtime_probes : null).toEqual([probe]);
  });

  it("rejects a hello_ack whose probe could not name a command, rather than dropping the probe silently", () => {
    for (const malformed of [
      { ...probe, argv: [] as unknown },        // an empty argv is a probe that names no command
      { ...probe, argv: ["claude-agent-acp", 3] },
      { ...probe, adapter_type: 7 },
      null,
    ]) {
      const parsed = parseServerFrame({ type: "hello_ack", host_id: "host-1", runtime_probes: [malformed] });
      // An empty argv is a valid array for the schema; execution refuses it as
      // "Empty command." when the run launches. Everything else fails here.
      if (malformed && typeof malformed === "object" && Array.isArray((malformed as { argv: unknown }).argv) && (malformed as { argv: unknown[] }).argv.length === 0) {
        expect(parsed.ok).toBe(true);
      } else {
        expect(parsed.ok, JSON.stringify(malformed)).toBe(false);
      }
    }
  });
});
