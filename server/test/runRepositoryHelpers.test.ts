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
    // Was `read_only`, which only made sense while the server mounted the
    // Folder read-only and provisioned a separate worktree for the writes.
    // On a host daemon the registered Location is the working copy, so a
    // low-risk run that cannot write it cannot do its work at all — and the
    // levels came out inverted, since a *higher*-risk run could write.
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
      // The invariant that was broken: only `read_only` narrows the bind, so
      // leaving the low/medium floor there meant the safer a run was, the less
      // it could do — a low-risk run could not write while a critical one
      // could. Risk may decide how a run is contained; it must not decide
      // whether the run can work at all.
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
