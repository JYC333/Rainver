import { HostServerFrameSchema, type HostLaunchFrame } from "@rainver/protocol";
import { describe, expect, it } from "vitest";
import { parseServerFrame, toLaunchFrame } from "../src/commands/run.js";
import type { LaunchFrame } from "../src/execution.js";

// The daemon used to rebuild the launch frame field by field from untyped
// JSON, so a field the server sent and the rebuild forgot was invisible
// everywhere else: `provider_binding` shipped inert that way once, and then
// `work_surface` did. Now the frame is parsed against the shared contract and
// handed over by spread. `Required<HostLaunchFrame>` is that contract: a
// field added to it is missing from this fixture until it is written down,
// and the round trip below then proves execution receives it.
describe("the launch frame across the wire", () => {
  const wire: Required<HostLaunchFrame> = {
    type: "launch",
    run_id: "run-1",
    launch_id: "launch-1",
    workspace_location_id: "loc-1",
    workspace: { kind: "managed", agent_id: "agent-1", container: { kind: "conversation", conversation_id: "conv-1" } },
    workspace_access: [{ workspace_location_id: "loc-2", access_mode: "write" }],
    argv: ["claude", "-p"],
    stdin: "hello",
    timeout_seconds: 120,
    keep_stdin_open: true,
    installation: "managed:1.2.3",
    adapter_type: "claude_code",
    provider_binding: {
      profile_key: "claude_code/provider-1",
      env: { ANTHROPIC_BASE_URL: "http://control-plane:8021/anthropic/l1" },
      profile_env: { CLAUDE_CONFIG_DIR: "." },
      files: [{ relative_path: ".codex/config.toml", contents: "m", escape: "toml_basic_string" }],
    },
    work_surface: {
      env: { RAINVER_API_URL: "http://control-plane:8021", RAINVER_RUN_ID: "run-1", RAINVER_TOOL_TOKEN: "t" },
      files: [{ relative_path: "skills/rainver/SKILL.md", contents: "# skill" }],
      dir_env: { RAINVER_SKILL_PATH: "skills/rainver/SKILL.md" },
    },
  };
  const overWire = (frame: unknown) => JSON.parse(JSON.stringify(frame)) as unknown;

  it("carries every field the control plane sends into execution", () => {
    const expected: Required<LaunchFrame> = {
      run_id: "run-1",
      launch_id: "launch-1",
      workspace_location_id: "loc-1",
      workspace: { kind: "managed", agent_id: "agent-1", container: { kind: "conversation", id: "conv-1" } },
      workspace_access: [{ workspace_location_id: "loc-2", access_mode: "write" }],
        argv: ["claude", "-p"],
      stdin: "hello",
      timeout_seconds: 120,
      keep_stdin_open: true,
      installation: "managed:1.2.3",
      adapter_type: "claude_code",
      provider_binding: wire.provider_binding,
      work_surface: wire.work_surface,
    };
    const parsed = parseServerFrame(overWire(wire));
    if (!parsed.ok || parsed.frame.type !== "launch") throw new Error("launch frame did not parse");
    expect(toLaunchFrame(parsed.frame)).toEqual(expected);
  });

  it("keeps the work surface and binding out of a run only when the server sent none", () => {
    const { work_surface: _surface, provider_binding: _binding, ...bare } = wire;
    const parsed = parseServerFrame(overWire(bare));
    if (!parsed.ok || parsed.frame.type !== "launch") throw new Error("launch frame did not parse");
    const launch = toLaunchFrame(parsed.frame);
    expect(launch.work_surface).toBeUndefined();
    expect(launch.provider_binding).toBeUndefined();
  });

  it("names the run it rejects, so the server can fail it rather than wait for a timeout", () => {
    for (const malformed of [
      { ...wire, work_surface: { env: {}, files: [] } },                                 // no dir_env
      { ...wire, work_surface: { env: { RAINVER_RUN_ID: 1 }, files: [], dir_env: {} } }, // non-string env
      { ...wire, provider_binding: { env: {}, profile_env: {}, files: [] } },            // no profile key
      { ...wire, provider_binding: { profile_key: "a/b", env: {}, profile_env: {}, files: [{ contents: "x" }] } },
      { ...wire, argv: "claude" },
      { type: "launch", run_id: "run-9", launch_id: "launch-9" },                        // no argv at all
    ]) {
      const parsed = parseServerFrame(overWire(malformed));
      expect(parsed.ok, JSON.stringify(malformed)).toBe(false);
      if (!parsed.ok) expect(parsed).toMatchObject({ type: "launch", run_id: (malformed as { run_id: string }).run_id });
    }
  });

  it("is the same contract the server dispatches against", () => {
    expect(HostServerFrameSchema.safeParse(overWire(wire)).success).toBe(true);
  });
});
