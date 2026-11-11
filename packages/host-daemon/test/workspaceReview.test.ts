import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { handleLaunch, launchLeasePlan } from "../src/execution.js";
import { checkLocationRepository } from "../src/taskWorktree.js";
import { executeWorkspaceCommand, prepareExecutionWorkspace } from "../src/executionWorkspace.js";
import { verifyWorkspaceReviewBasis, workspaceReviewCwd, workspaceReviewLeaseKey } from "../src/workspaceReview.js";
import { taskLeaseKey } from "../src/taskWorktree.js";
import { workspaceWorktreeKey } from "../src/worktreeIdentity.js";

/**
 * A read-only delegated review of an existing execution workspace (ADR 0029
 * `review_commit`): only the exact frozen, clean version is reviewed, under
 * the same lease key every writer of that worktree takes exclusively, and
 * never outside a read-only launch.
 */
let configDir: string, workspaceDir: string;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(async () => {
  configDir = await realpath(await mkdtemp(join(tmpdir(), "rainver-review-config-")));
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "rainver-review-location-")));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  await saveConfig({ server_url: "http://127.0.0.1:9", host_id: "host-1", trust: "trusted", token: "t", workspaces: { "folder-1": workspaceDir } });
  git(["init", "-q", "-b", "main"], workspaceDir);
  git(["config", "user.email", "person@example.com"], workspaceDir);
  git(["config", "user.name", "Person"], workspaceDir);
  await writeFile(join(workspaceDir, "README.md"), "hello\n");
  git(["add", "."], workspaceDir);
  git(["commit", "-q", "-m", "initial"], workspaceDir);
});
afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  delete process.env.RAINVER_HOST_BWRAP;
  await rm(configDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

async function savedWorkspace() {
  const check = await checkLocationRepository(workspaceDir);
  if (check.kind !== "repository") throw new Error("fixture");
  const ref = { id: randomUUID(), generation: 1 };
  const prepared = await prepareExecutionWorkspace(check.repo, "folder-1", ref, "coordinator-run");
  await writeFile(join(prepared.root, "result.txt"), "work\n");
  const saved = await executeWorkspaceCommand(workspaceDir, { type: "execution_workspace_command", request_id: randomUUID(), operation_id: randomUUID(), action: "checkpoint", retain_branch: true,
    workspace: { kind: "location", workspace_location_id: "folder-1", execution_workspace: ref }, run_id: "coordinator-run", author: { name: "Agent", email: "agent@example.com" }, message: "save" } as never);
  expect(saved.ok).toBe(true);
  return { ref, commit: saved.commit!, root: prepared.root };
}

describe("workspace review", () => {
  it("accepts only the exact frozen, clean version of the existing worktree", async () => {
    const { ref, commit, root } = await savedWorkspace();
    expect(existsSync(root)).toBe(true);
    const review = { ...ref, review_commit: commit };
    expect(await workspaceReviewCwd(workspaceDir, "folder-1", review)).toBe(root);
    expect(await verifyWorkspaceReviewBasis(workspaceDir, "folder-1", review)).toBeNull();
    expect(await verifyWorkspaceReviewBasis(workspaceDir, "folder-1", { ...review, review_commit: "f".repeat(40) })).toBe("execution_workspace_review_basis_moved");
    await writeFile(join(root, "uncommitted.txt"), "edit\n");
    expect(await verifyWorkspaceReviewBasis(workspaceDir, "folder-1", review)).toBe("execution_workspace_review_basis_moved");
    // Reviewing never creates a worktree that does not exist.
    const absent = { id: randomUUID(), generation: 1, review_commit: commit };
    await expect(workspaceReviewCwd(workspaceDir, "folder-1", absent)).rejects.toThrow("execution_workspace_review_unavailable");
    expect(await verifyWorkspaceReviewBasis(workspaceDir, "folder-1", absent)).toBe("execution_workspace_review_unavailable");
  });

  it("shares the writer's worktree lease key and refuses a launch that is not read-only", async () => {
    const { ref, commit } = await savedWorkspace();
    const review = { ...ref, review_commit: commit };
    expect(workspaceReviewLeaseKey("folder-1", review)).toBe(taskLeaseKey("folder-1", workspaceWorktreeKey(ref)));
    // A writer of the same workspace takes that key exclusively.
    expect(launchLeasePlan({ isolation: undefined, workspace_access: [] }, false, "folder-1", taskLeaseKey("folder-1", workspaceWorktreeKey(ref))).exclusive)
      .toContain(workspaceReviewLeaseKey("folder-1", review));
    const frames: Record<string, unknown>[] = [];
    await handleLaunch({ run_id: "reviewer", launch_id: randomUUID(), argv: [process.execPath, "-e", "require('fs').writeFileSync('bad.txt','bad')"],
      workspace: { kind: "location", workspace_location_id: "folder-1", execution_workspace: review } } as never, frame => { frames.push(frame as Record<string, unknown>); }, () => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(frames.find(f => f.type === "complete")).toMatchObject({ exit_code: 1, error: "execution_workspace_review_requires_read_only" });
    expect(existsSync(join(workspaceDir, "bad.txt"))).toBe(false);
  });
  it("refuses a frozen review without namespace support instead of launching writable", async () => {
    const {ref,commit,root}=await savedWorkspace();
    process.env.RAINVER_HOST_BWRAP='/bin/false';
    const frames:Record<string,unknown>[]=[];
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('no completion')),5000);
      void handleLaunch({run_id:'namespace-review',launch_id:randomUUID(),argv:[process.execPath,'-e',"require('fs').writeFileSync('bad.txt','bad')"],
        isolation:{sandbox_mode:'read_only'},workspace:{kind:'location',workspace_location_id:'folder-1',execution_workspace:{...ref,review_commit:commit}}} as never,
        frame=>{frames.push(frame as Record<string,unknown>);if(frame.type==='complete'){clearTimeout(timer);resolve();}},()=>{});
    });
    expect(frames.find(f=>f.type==='complete')).toMatchObject({exit_code:1,error:'execution_workspace_review_namespace_unavailable'});
    expect(frames.some(f=>f.type==='launched')).toBe(false);
    expect(existsSync(join(root,'bad.txt'))).toBe(false);
  });

});
