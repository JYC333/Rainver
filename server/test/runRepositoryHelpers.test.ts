import { describe, expect, it } from "vitest";
import { resolveSandboxLevelForRuntime } from "../src/modules/runs/runRepositoryHelpers.js";

describe("runtime sandbox resolution", () => {
  it("uses an ephemeral run directory for a CLI without a workspace", () => {
    expect(resolveSandboxLevelForRuntime({
      adapterType: "opencode",
      configuredLevel: "none",
      riskLevel: "low",
      projectFolderId: null,
    })).toBe("ephemeral");
  });

  it("uses a worktree when a workspace is bound", () => {
    expect(resolveSandboxLevelForRuntime({
      adapterType: "opencode",
      configuredLevel: "none",
      riskLevel: "high",
      projectFolderId: "workspace-1",
    })).toBe("worktree");
  });

  it("uses the zero-copy read-only Project Folder for low-risk CLI work", () => {
    expect(resolveSandboxLevelForRuntime({
      adapterType: "claude_code",
      configuredLevel: "none",
      riskLevel: "low",
      projectFolderId: "workspace-1",
    })).toBe("read_only");
  });

  it("does not let a configured read-only level downgrade high-risk CLI work", () => {
    expect(resolveSandboxLevelForRuntime({
      adapterType: "codex_cli",
      configuredLevel: "read_only",
      riskLevel: "high",
      projectFolderId: "workspace-1",
    })).toBe("worktree");
  });

  it.each(["dry_run", "ephemeral"])(
    "does not let configured %s bypass a low-risk Folder read barrier",
    (configuredLevel) => {
      expect(resolveSandboxLevelForRuntime({
        adapterType: "claude_code",
        configuredLevel,
        riskLevel: "low",
        projectFolderId: "workspace-1",
      })).toBe("read_only");
    },
  );

  it("preserves a stronger configured sandbox above the read-only baseline", () => {
    expect(resolveSandboxLevelForRuntime({
      adapterType: "opencode",
      configuredLevel: "worktree",
      riskLevel: "medium",
      projectFolderId: "workspace-1",
    })).toBe("worktree");
  });

  it("does not add a workspace requirement to a managed API runtime", () => {
    expect(resolveSandboxLevelForRuntime({
      adapterType: "model_api",
      configuredLevel: "none",
      riskLevel: "low",
      projectFolderId: null,
    })).toBe("none");
  });

  it("forces critical local CLI runs into one-shot Docker", () => {
    expect(resolveSandboxLevelForRuntime({
      adapterType: "opencode",
      configuredLevel: "none",
      riskLevel: "critical",
      projectFolderId: null,
    })).toBe("one_shot_docker");
  });
});
