import { describe, expect, it } from "vitest";
import { parseRuntimeProbes } from "../src/api.js";

describe("parseRuntimeProbes", () => {
  it("keeps only well-formed probes from hello_ack and tolerates a server that sends none", () => {
    expect(parseRuntimeProbes(undefined)).toEqual([]);
    expect(parseRuntimeProbes([
      { adapter_type: "opencode", runtime: "opencode", argv: ["opencode", "acp", "--cwd", "rainver:remote-workspace-cwd"], login: { command: ["opencode", "auth", "login"], home_subdir: ".local/share/opencode", credential_file: "auth.json" } },
      { adapter_type: "acp_goose", runtime: null, argv: ["acp_goose"], remote_host_only: true, version: "1.2.3" },
      { adapter_type: "codex_cli", runtime: "codex", argv: [] },
      { adapter_type: 7, argv: ["x"] },
      { runtime: "claude", argv: ["claude-agent-acp", 3] },
      null,
    ])).toEqual([
      {
        adapter_type: "opencode", runtime: "opencode", argv: ["opencode", "acp", "--cwd", "rainver:remote-workspace-cwd"],
        distribution: null, version: null, remote_host_only: false,
        login: { command: ["opencode", "auth", "login"], home_subdir: ".local/share/opencode", credential_file: "auth.json" },
      },
      { adapter_type: "acp_goose", runtime: null, argv: ["acp_goose"], distribution: null, version: "1.2.3", remote_host_only: true, login: null },
    ]);
  });
});
