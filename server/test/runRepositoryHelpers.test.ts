import { describe, expect, it } from "vitest";
import { dispatchIsolation } from "../src/modules/runs/remoteHostCliAdapter.js";
import { resolveSandboxLevelForRuntime } from "../src/modules/runs/runRepositoryHelpers.js";

describe("runtime sandbox resolution", () => {
  it("uses an ephemeral run directory for a CLI without a workspace", () => {
    expect(resolveSandboxLevelForRuntime({
      runtimeKey: "opencode",
      configuredLevel: "none",
      riskLevel: "low",
      projectFolderId: null,
    })).toBe("ephemeral");
  });

  it("uses a worktree when a workspace is bound", () => {
    expect(resolveSandboxLevelForRuntime({
      runtimeKey: "opencode",
      configuredLevel: "none",
      riskLevel: "high",
      projectFolderId: "workspace-1",
    })).toBe("worktree");
  });

  it("lets low-risk CLI work write the Folder it was dispatched against", () => {
    // On a host daemon the registered Location is the working copy. A
    // low-risk run has to be able to write it. Do not resolve that level to
    // `read_only`. A higher-risk run would be the one allowed to write.
    expect(resolveSandboxLevelForRuntime({
      runtimeKey: "claude_code",
      configuredLevel: "none",
      riskLevel: "low",
      projectFolderId: "workspace-1",
    })).toBe("worktree");
  });

  it.each(["low", "medium", "high", "critical"])(
    "gives a Folder-bound %s-risk run a workspace it can write",
    (riskLevel) => {
      // Only `read_only` narrows the bind. Risk may decide how a run is
      // contained. It must not decide whether the run can work. Do not leave
      // a low/medium floor that withholds a writable workspace from the
      // safer run while a critical one can write.
      const level = resolveSandboxLevelForRuntime({
        runtimeKey: "claude_code",
        configuredLevel: "none",
        riskLevel,
        projectFolderId: "workspace-1",
      });
      expect(dispatchIsolation({ required_sandbox_level: level }).sandbox_mode).toBe("read_write");
    },
  );

  it("does not let a configured read-only level downgrade high-risk CLI work", () => {
    expect(resolveSandboxLevelForRuntime({
      runtimeKey: "codex_cli",
      configuredLevel: "read_only",
      riskLevel: "high",
      projectFolderId: "workspace-1",
    })).toBe("worktree");
  });

  it.each(["dry_run", "ephemeral"])(
    "does not let configured %s drop a Folder-bound run below its floor",
    (configuredLevel) => {
      expect(resolveSandboxLevelForRuntime({
        runtimeKey: "claude_code",
        configuredLevel,
        riskLevel: "low",
        projectFolderId: "workspace-1",
      })).toBe("worktree");
    },
  );

  it("preserves a stronger configured sandbox above the read-only baseline", () => {
    expect(resolveSandboxLevelForRuntime({
      runtimeKey: "opencode",
      configuredLevel: "worktree",
      riskLevel: "medium",
      projectFolderId: "workspace-1",
    })).toBe("worktree");
  });

  it("does not add a persistent workspace requirement to OpenCode", () => {
    expect(resolveSandboxLevelForRuntime({
      runtimeKey: "opencode",
      configuredLevel: "none",
      riskLevel: "low",
      projectFolderId: null,
    })).toBe("ephemeral");
  });

  it("forces critical local CLI runs into one-shot Docker", () => {
    expect(resolveSandboxLevelForRuntime({
      runtimeKey: "opencode",
      configuredLevel: "none",
      riskLevel: "critical",
      projectFolderId: null,
    })).toBe("one_shot_docker");
  });
});
