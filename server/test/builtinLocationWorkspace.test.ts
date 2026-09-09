import { describe, expect, it } from "vitest";
import { launchWorkspaceForTest } from "../src/modules/runs/remoteHostCliAdapter.js";
import { verificationTargetForTest } from "../src/modules/runs/orchestrationService.js";

/**
 * The built-in host's daemon never ran `workspace add`, so a Location id alone
 * resolves to nothing on it and the Run dies with "no local path registered".
 * The path under the shared workspace root is what lets it resolve one
 * (ADR 0016 section 4) — and a Conversation bound to a server Location always
 * arrives with a snapshot workspace, which is the case that used to skip it.
 */
describe("the workspace a Location-bound launch carries", () => {
  const LOC = "loc-1";

  it("fills the relative path into a snapshot workspace that has none", () => {
    expect(launchWorkspaceForTest({ kind: "location", workspace_location_id: LOC }, LOC, "space/ttt"))
      .toEqual({ kind: "location", workspace_location_id: LOC, workspace_relative_path: "space/ttt" });
  });

  it("leaves a snapshot workspace that already names one alone", () => {
    const named = { kind: "location" as const, workspace_location_id: LOC, workspace_relative_path: "kept" };
    expect(launchWorkspaceForTest(named, LOC, "other")).toEqual(named);
  });

  it("does not touch a managed workspace, which resolves without a path", () => {
    const managed = { kind: "managed" as const, agent_id: "a", container: { kind: "conversation" as const, conversation_id: "c" } };
    expect(launchWorkspaceForTest(managed, LOC, "space/ttt")).toEqual(managed);
  });

  it("still builds one when the snapshot named no workspace", () => {
    expect(launchWorkspaceForTest(undefined, LOC, "space/ttt"))
      .toEqual({ kind: "location", workspace_location_id: LOC, workspace_relative_path: "space/ttt" });
  });

  it("carries nothing for a paired host, which resolves the Location from its own registration", () => {
    expect(launchWorkspaceForTest(undefined, LOC, null)).toBeUndefined();
  });
});

/**
 * The same gap, in the other place that names a workspace. A launch carries the
 * built-in host's path because `builtinLocationRelativePath` computes it; the
 * verifier reached for `port.workspace` first and took the snapshot's
 * path-less Location as-is, so every verification on that host came back "no
 * local path registered" — reported, after two relabellings, as a Run that had
 * failed its acceptance checks.
 */
describe("the workspace a verifier runs in", () => {
  const LOC = "loc-1";
  const port = (over: Record<string, unknown>) => ({
    hostKind: "server" as const, hostId: "host-1", workspaceLocationId: LOC,
    workspaceRelativePath: null, ...over,
  } as never);

  it("folds the built-in host's path into a snapshot Location that has none", () => {
    const target = verificationTargetForTest(port({
      workspace: { kind: "location", workspace_location_id: LOC },
      workspaceRelativePath: "space/ttt",
    }));
    expect(target?.workspace).toEqual({
      kind: "location", workspace_location_id: LOC, workspace_relative_path: "space/ttt",
    });
  });

  it("leaves a managed workspace alone, which resolves without a path", () => {
    const managed = { kind: "managed" as const, agent_id: "a", container: { kind: "conversation" as const, conversation_id: "c" } }
    expect(verificationTargetForTest(port({ workspace: managed, workspaceRelativePath: "x" }))?.workspace).toEqual(managed)
  });

  it("carries no workspace for a paired host, which resolves the Location itself", () => {
    expect(verificationTargetForTest(port({ hostKind: "remote" }))?.workspace).toBeUndefined();
  });
})
