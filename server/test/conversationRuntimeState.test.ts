import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareConversationRuntimeState,
  sweepConversationRuntimeState,
} from "../src/modules/runs/conversationRuntimeState.js";

const roots: string[] = [];
const STATE_KEY = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

describe("conversation runtime state", () => {
  it("reuses state only when both the isolated HOME and stable cwd exist", async () => {
    const agentSpaceHome = await root("aspace-conversation-home-");
    const sandboxRoot = await root("aspace-conversation-sandbox-");
    const initial = await prepareConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      state_key: STATE_KEY,
      resume_requested: false,
    });
    await writeFile(join(initial.home_dir, "session.db"), "vendor state", "utf8");
    await writeFile(join(initial.cwd, "turn.txt"), "workspace state", "utf8");

    const resumed = await prepareConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      state_key: STATE_KEY,
      resume_requested: true,
    });
    expect(resumed).toEqual({ ...initial, resume: true });
    await expect(readFile(join(resumed.home_dir, "session.db"), "utf8"))
      .resolves.toBe("vendor state");
  });

  it("clears partial state and forces replay when one state directory is missing", async () => {
    const agentSpaceHome = await root("aspace-conversation-home-");
    const sandboxRoot = await root("aspace-conversation-sandbox-");
    const home = join(
      agentSpaceHome,
      "cache",
      "conversation-runtime-homes",
      STATE_KEY,
    );
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "stale.db"), "stale", "utf8");

    const prepared = await prepareConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      state_key: STATE_KEY,
      resume_requested: true,
    });
    expect(prepared.resume).toBe(false);
    await expect(readFile(join(prepared.home_dir, "stale.db"), "utf8")).rejects.toThrow();
  });

  it("does not resume through a symlinked state directory", async () => {
    const agentSpaceHome = await root("aspace-conversation-home-");
    const sandboxRoot = await root("aspace-conversation-sandbox-");
    const outside = await root("aspace-conversation-outside-");
    const home = join(
      agentSpaceHome,
      "cache",
      "conversation-runtime-homes",
      STATE_KEY,
    );
    const cwd = join(
      sandboxRoot,
      "conversation-sessions",
      STATE_KEY,
      "workspace",
    );
    await mkdir(join(agentSpaceHome, "cache", "conversation-runtime-homes"), {
      recursive: true,
    });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(outside, "sentinel"), "outside", "utf8");
    await symlink(outside, home);

    const prepared = await prepareConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      state_key: STATE_KEY,
      resume_requested: true,
    });
    expect(prepared.resume).toBe(false);
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside");
  });

  it("rejects a symlinked HOME state ancestor without touching its target", async () => {
    const agentSpaceHome = await root("aspace-conversation-home-");
    const sandboxRoot = await root("aspace-conversation-sandbox-");
    const outside = await root("aspace-conversation-outside-");
    await mkdir(join(agentSpaceHome, "cache"), { recursive: true });
    await writeFile(join(outside, "sentinel"), "outside", "utf8");
    await symlink(outside, join(agentSpaceHome, "cache", "conversation-runtime-homes"));

    await expect(prepareConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      state_key: STATE_KEY,
      resume_requested: false,
    })).rejects.toThrow("contains a symlink");
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside");
  });

  it("rejects a symlinked cwd state ancestor without touching its target", async () => {
    const agentSpaceHome = await root("aspace-conversation-home-");
    const sandboxRoot = await root("aspace-conversation-sandbox-");
    const outside = await root("aspace-conversation-outside-");
    await writeFile(join(outside, "sentinel"), "outside", "utf8");
    await symlink(outside, join(sandboxRoot, "conversation-sessions"));

    await expect(prepareConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      state_key: STATE_KEY,
      resume_requested: false,
    })).rejects.toThrow("contains a symlink");
    await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe("outside");
  });

  it("sweeps expired orphan state while retaining recent state", async () => {
    const agentSpaceHome = await root("aspace-conversation-home-");
    const sandboxRoot = await root("aspace-conversation-sandbox-");
    const prepared = await prepareConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      state_key: STATE_KEY,
      resume_requested: false,
    });

    await expect(sweepConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      protected_state_keys: new Set(),
      retention_ms: 60_000,
      now: new Date(),
    })).resolves.toBe(0);
    await expect(sweepConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      protected_state_keys: new Set([STATE_KEY]),
      retention_ms: 1,
      now: new Date(Date.now() + 1_000),
    })).resolves.toBe(0);
    await expect(sweepConversationRuntimeState({
      agent_space_home: agentSpaceHome,
      sandbox_root: sandboxRoot,
      protected_state_keys: new Set(),
      retention_ms: 1,
      now: new Date(Date.now() + 1_000),
    })).resolves.toBe(1);
    await expect(readFile(join(prepared.home_dir, "missing"), "utf8")).rejects.toThrow();
  });

  it("rejects non-UUID state keys before constructing filesystem paths", async () => {
    await expect(prepareConversationRuntimeState({
      agent_space_home: await root("aspace-conversation-home-"),
      sandbox_root: await root("aspace-conversation-sandbox-"),
      state_key: "../../escape",
      resume_requested: false,
    })).rejects.toThrow("conversation runtime state key must be a UUID");
  });
});
