import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { captureWorkspaceDiff } from "../src/gitDiff.js";
import {
  archiveAgentProfiles,
  archiveLegacyProfileTree,
  archiveManagedWorkspace,
  ensureManagedWorkspace,
  listManagedWorkspaces,
  managedWorkspacePath,
  restoreManagedWorkspace,
  runtimeProfileContainerPath,
  sweepManagedWorkspaceArchives,
} from "../src/managedWorkspaces.js";
import { handleLaunch } from "../src/execution.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "rainver-managed-workspaces-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
  await saveConfig({ server_url: "http://127.0.0.1:1", host_id: "host-1", token: "token", trust: "trusted", workspaces: {} });
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("managed workspaces", () => {
  it("derives a private per-container cwd and keeps it after a run", async () => {
    const frames: Record<string, unknown>[] = [];
    await handleLaunch({
      run_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      launch_id: "launch-managed",
      workspace: { kind: "managed", agent_id: AGENT_ID, container: { kind: "direct", id: USER_ID } },
      argv: ["sh", "-c", "pwd; printf managed > marker.txt"],
    }, (frame) => frames.push(frame), () => {});
    await new Promise<void>((resolve) => {
      const poll = () => frames.some((frame) => frame.type === "complete") ? resolve() : setTimeout(poll, 10);
      poll();
    });
    const path = managedWorkspacePath(AGENT_ID, { kind: "direct", id: USER_ID });
    expect(frames.filter((frame) => frame.type === "output").map((frame) => frame.chunk).join("" )).toContain(path);
    expect(existsSync(join(path, "marker.txt"))).toBe(true);
  });

  it("archives, restores, reports and sweeps a container without exposing paths", async () => {
    const container = { kind: "direct" as const, id: USER_ID };
    const path = await ensureManagedWorkspace(AGENT_ID, container);
    await writeFile(join(path, "work.txt"), "keep");
    expect(await archiveManagedWorkspace(AGENT_ID, container, true)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await listManagedWorkspaces()).toEqual([{
      agent_id: AGENT_ID,
      container_kind: "direct",
      container_id: USER_ID,
      archived_available: true,
    }]);
    expect(await restoreManagedWorkspace(AGENT_ID, container, true)).toBe(true);
    expect(existsSync(join(path, "work.txt"))).toBe(true);
    await expect(restoreManagedWorkspace(AGENT_ID, container, true)).rejects.toThrow(/Already exists/);
    await archiveManagedWorkspace(AGENT_ID, container, true);
    const archive = (await import("node:fs/promises")).readdir(join(stateDir, "agents", AGENT_ID, "direct"));
    const archivePath = join(stateDir, "agents", AGENT_ID, "direct", (await archive)[0]!);
    expect(await sweepManagedWorkspaceArchives(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(1);
    expect(existsSync(archivePath)).toBe(false);
  });

  it("rejects path-like identifiers before joining them", async () => {
    await expect(ensureManagedWorkspace("../escape", { kind: "direct", id: USER_ID })).rejects.toThrow(/UUID-like/);
    await expect(ensureManagedWorkspace(AGENT_ID, { kind: "direct", id: "../../escape" })).rejects.toThrow(/UUID-like/);
  });

  it("archives an Agent's profile without the Conversation cwd another Agent still uses", async () => {
    // A Room the Agent was removed from while others stayed. Its own CLI state
    // — login, vendor sessions, auto-memory — has to go, or it walks into the
    // next Room; the shared cwd belongs to the Agents still in the Room.
    const container = { kind: "conversation" as const, id: CONVERSATION_ID };
    const cwd = await ensureManagedWorkspace(AGENT_ID, container);
    await writeFile(join(cwd, "shared.txt"), "still in use");
    const profile = runtimeProfileContainerPath(AGENT_ID, "conversation", CONVERSATION_ID);
    await mkdir(join(profile, "claude_code", "ambient", ".claude"), { recursive: true });
    await writeFile(join(profile, "claude_code", "ambient", ".claude", "memory.md"), "what I learned here");

    expect(await archiveManagedWorkspace(AGENT_ID, container, false)).toBe(true);

    expect(existsSync(profile)).toBe(false);
    expect(existsSync(join(cwd, "shared.txt"))).toBe(true);
  });

  it("clears every profile of one Agent and leaves the other Agent's and the workspaces alone", async () => {
    // `POST /agents/:id/host-state/reset` — "clear this Agent's CLI memory on
    // this host". Archived, not deleted: a person who ran it by mistake still
    // has what was there until the 30-day sweep.
    const cwd = await ensureManagedWorkspace(AGENT_ID, { kind: "direct", id: USER_ID });
    const mine = runtimeProfileContainerPath(AGENT_ID, "conversation", CONVERSATION_ID);
    const alsoMine = runtimeProfileContainerPath(AGENT_ID, "direct", USER_ID);
    const theirs = runtimeProfileContainerPath(OTHER_AGENT_ID, "conversation", CONVERSATION_ID);
    for (const path of [mine, alsoMine, theirs]) await mkdir(path, { recursive: true });

    expect(await archiveAgentProfiles(AGENT_ID)).toBe(true);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(alsoMine)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(cwd)).toBe(true);
    // Nothing to clear reports so, rather than failing.
    expect(await archiveAgentProfiles(AGENT_ID)).toBe(false);
  });

  it("sweeps an archived profile on the same 30-day clock as a workspace", async () => {
    const profile = runtimeProfileContainerPath(AGENT_ID, "location", CONVERSATION_ID);
    await mkdir(profile, { recursive: true });
    await archiveAgentProfiles(AGENT_ID);
    const base = join(stateDir, "agents", AGENT_ID, "profiles", "location");
    const archived = join(base, (await readdir(base))[0]!);

    expect(await sweepManagedWorkspaceArchives(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(1);
    expect(existsSync(archived)).toBe(false);
  });

  it("keeps a just-archived profile whose directory was last changed long ago", async () => {
    // A profile used for months keeps the mtime of its first dispatch; a
    // rename does not touch it. The archive's age is when it was archived.
    const profile = runtimeProfileContainerPath(AGENT_ID, "conversation", CONVERSATION_ID);
    await mkdir(profile, { recursive: true });
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(profile, old, old);
    await archiveAgentProfiles(AGENT_ID);
    const base = join(stateDir, "agents", AGENT_ID, "profiles", "conversation");
    const archived = join(base, (await readdir(base))[0]!);

    expect(await sweepManagedWorkspaceArchives()).toBe(0);
    expect(existsSync(archived)).toBe(true);
    // And it does go once the window has passed.
    expect(await sweepManagedWorkspaceArchives(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(1);
    expect(existsSync(archived)).toBe(false);
  });

  it("stores an ordinary Agent runtime profile under a stable Agent scope", () => {
    expect(runtimeProfileContainerPath(AGENT_ID, "agent", AGENT_ID))
      .toBe(join(stateDir, "agents", AGENT_ID, "profiles", "agent", AGENT_ID));
  });

  it("archives the pre-Agent-keyed profiles tree and sweeps it on the same clock", async () => {
    // `<configDir>/profiles/<adapter>/<provider>` holds one login shared by
    // every Agent on the machine, plus dead lease tokens. Nothing reads it.
    // Archive it under the marker. Do not delete it outright, and do not
    // share one login across every Agent.
    const legacy = join(stateDir, "profiles", "claude_code", "provider-1");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "config.toml"), "dead lease token");

    expect(await archiveLegacyProfileTree()).toBe(true);
    expect(existsSync(join(stateDir, "profiles"))).toBe(false);
    const archived = (await readdir(stateDir)).filter((name) => name.startsWith("profiles.removed-"));
    expect(archived).toHaveLength(1);
    // Nothing to move the second time.
    expect(await archiveLegacyProfileTree()).toBe(false);

    expect(await sweepManagedWorkspaceArchives(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(1);
    expect(existsSync(join(stateDir, archived[0]!))).toBe(false);
  });

  it("uses one shared managed cwd for a Conversation across Agents", async () => {
    const container = { kind: "conversation" as const, id: CONVERSATION_ID };
    const first = await ensureManagedWorkspace(AGENT_ID, container);
    const second = managedWorkspacePath(OTHER_AGENT_ID, container);
    expect(second).toBe(first);
    await writeFile(join(second, "shared.txt"), "same conversation");
    expect(existsSync(join(first, "shared.txt"))).toBe(true);
    expect(await listManagedWorkspaces()).toEqual([{
      container_kind: "conversation",
      container_id: CONVERSATION_ID,
      archived_available: false,
    }]);
  });
});

/**
 * ADR 0016 section 11 rests undo on git. A managed workspace is a repository.
 * A plain directory captures no diff, so nothing can be reverted and nothing
 * records what was written.
 */
describe("a managed workspace is a repository", () => {
  it("initialises one on first use, so its Runs have a diff and an undo", async () => {
    const path = await ensureManagedWorkspace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", { kind: "conversation", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01" });
    await writeFile(join(path, "note.txt"), "written by a Run\n", "utf8");

    expect(await captureWorkspaceDiff(path)).toContain("note.txt");
  });

  it("leaves a workspace that is already a repository alone", async () => {
    const path = await ensureManagedWorkspace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", { kind: "conversation", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02" });
    await writeFile(join(path, "kept.txt"), "first\n", "utf8");
    const gitDir = join(path, ".git");
    const before = await stat(gitDir);

    // A second Run in the same Conversation reaches the same directory.
    await ensureManagedWorkspace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", { kind: "conversation", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02" });

    expect((await stat(gitDir)).birthtimeMs).toBe(before.birthtimeMs);
    expect(await readFile(join(path, "kept.txt"), "utf8")).toBe("first\n");
  });
})

describe('isolated cache launch and retirement',()=>{
 it('archives retained cache identities after the source directory is removed or unregistered',async()=>{
  const {executeWorkspaceCommand}=await import('../src/executionWorkspace.js');
  const {randomUUID}=await import('node:crypto');const workspaceId=randomUUID(),attemptId=randomUUID();
  const source=join(stateDir,'removed-source');await mkdir(source);await rm(source,{recursive:true});
  const command={type:'execution_workspace_command' as const,request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location' as const,workspace_location_id:randomUUID(),execution_workspace:{id:workspaceId,generation:1}},action:'archive_profiles' as const,profile_agents:[AGENT_ID],retain_branch:true};
  for(const [locationRoot,ref,id] of [[source,command.workspace.execution_workspace,workspaceId],[null,{...command.workspace.execution_workspace,integration_id:attemptId},attemptId]] as const){
   const cache=runtimeProfileContainerPath(AGENT_ID,'workspace',id);await mkdir(cache,{recursive:true});await writeFile(join(cache,'session.json'),'retained vendor state');
   expect(await executeWorkspaceCommand(locationRoot,{...command,workspace:{...command.workspace,execution_workspace:ref}})).toMatchObject({ok:true,error:null});
   expect(existsSync(cache)).toBe(false);
   const archived=(await readdir(join(cache,'..'))).find(name=>name.startsWith(id+'.removed-'))!;
   expect(await readFile(join(cache,'..',archived,'session.json'),'utf8')).toBe('retained vendor state');
  }
 });

 it('launches with a workspace UUID cache and archives exactly that cache',async()=>{
  const {randomUUID}=await import('node:crypto'),{archiveRuntimeProfileContainer}=await import('../src/managedWorkspaces.js');
  const workspaceId=randomUUID(),frames:Record<string,unknown>[]=[];
  await handleLaunch({run_id:randomUUID(),launch_id:randomUUID(),workspace:{kind:'managed',agent_id:AGENT_ID,container:{kind:'conversation',id:CONVERSATION_ID}},
   provider_binding:{profile_key:`agents/${AGENT_ID}/workspace/${workspaceId}/claude_code/native`,env:{},profile_env:{HOME:'.'},files:[],credential_source:'provider_lease',login_link:null},argv:['sh','-c','echo "$HOME"']},frame=>frames.push(frame),()=>{});
  await new Promise<void>((resolve,reject)=>{const start=Date.now();const poll=()=>frames.some(f=>f.type==='complete')?resolve():Date.now()-start>10000?reject(new Error('launch timeout')):setTimeout(poll,10);poll();});
  expect(frames.find(f=>f.type==='complete'),JSON.stringify(frames)).toMatchObject({exit_code:0});
  const path=runtimeProfileContainerPath(AGENT_ID,'workspace',workspaceId);expect(existsSync(path)).toBe(true);
  expect(frames.filter(f=>f.type==='output').map(f=>f.chunk).join('')).toContain(path);
  expect(await archiveRuntimeProfileContainer(AGENT_ID,'workspace',workspaceId)).toBe(true);expect(existsSync(path)).toBe(false);
 });
});


describe("archived CLI cache eviction", () => {
  async function seed(profile: string) {
    const home = join(profile, "codex_cli", "ambient", ".codex");
    for (const cache of ["cache/remote_plugin_catalog", "cache/codex_apps_tools", "plugins/cache/openai-curated-remote"]) {
      await mkdir(join(home, cache), { recursive: true });
      await writeFile(join(home, cache, "download.bin"), "rebuildable");
    }
    for (const file of ["sessions/history.jsonl", "skills/custom/SKILL.md", "plugins/installed.json",
      "plugins/cache/local-only/plugin.js", "cache/custom/keep.txt", "state.sqlite", "state.sqlite-wal", "auth.json"]) {
      await mkdir(join(home, file, ".."), { recursive: true });
      await writeFile(join(home, file), "preserved");
    }
    return home;
  }

  it("evicts downloads on archive and restores history, registration and database bytes", async () => {
    const profile = runtimeProfileContainerPath(AGENT_ID, "direct", USER_ID);
    const home = await seed(profile);
    await archiveAgentProfiles(AGENT_ID);
    await restoreManagedWorkspace(AGENT_ID, { kind: "direct", id: USER_ID }, false);
    expect(existsSync(join(home, "cache/remote_plugin_catalog"))).toBe(false);
    expect(existsSync(join(home, "plugins/cache/openai-curated-remote"))).toBe(false);
    for (const file of ["sessions/history.jsonl", "skills/custom/SKILL.md", "plugins/installed.json",
      "plugins/cache/local-only/plugin.js", "cache/custom/keep.txt", "state.sqlite", "state.sqlite-wal", "auth.json"]) {
      expect(await readFile(join(home, file), "utf8")).toBe("preserved");
    }
  });

  it("backfills recent archives without trimming live profiles or user workspaces", async () => {
    const live = runtimeProfileContainerPath(AGENT_ID, "direct", USER_ID);
    const archived = `${live}.removed-${new Date(Date.now() - 10000).toISOString().replace(/:/g, "-")}`;
    const liveHome = await seed(live), oldHome = await seed(archived);
    const cwd = await ensureManagedWorkspace(AGENT_ID, { kind: "direct", id: USER_ID });
    const fakeCache = join(cwd, "codex_cli/ambient/.codex/cache");
    await mkdir(fakeCache, { recursive: true });
    await writeFile(join(fakeCache, "user.txt"), "user work");
    await archiveManagedWorkspace(AGENT_ID, { kind: "direct", id: USER_ID }, true);
    await seed(live);
    const passes = [sweepManagedWorkspaceArchives(), sweepManagedWorkspaceArchives()];
    expect(passes[0]).toBe(passes[1]);
    expect(await passes[0]).toBe(0);
    expect(existsSync(join(oldHome, "cache/remote_plugin_catalog"))).toBe(false);
    expect(existsSync(join(liveHome, "cache/remote_plugin_catalog/download.bin"))).toBe(true);
    await restoreManagedWorkspace(AGENT_ID, { kind: "direct", id: USER_ID }, true);
    expect(await readFile(join(fakeCache, "user.txt"), "utf8")).toBe("user work");
  });

  it("does not follow cache or HOME symlinks into another profile", async () => {
    const outside = join(stateDir, "live-home");
    await mkdir(join(outside, "plugins/cache"), { recursive: true });
    await writeFile(join(outside, "plugins/cache/keep"), "active");
    const live = runtimeProfileContainerPath(AGENT_ID, "direct", USER_ID);
    const archived = `${live}.removed-${new Date().toISOString().replace(/:/g, "-")}`;
    const runtime = join(archived, "codex_cli");
    await mkdir(join(runtime, "home-link"), { recursive: true });
    await symlink(outside, join(runtime, "home-link/.codex"));
    await mkdir(join(runtime, "cache-link/.codex/plugins"), { recursive: true });
    await symlink(join(outside, "plugins/cache"), join(runtime, "cache-link/.codex/plugins/cache"));
    await sweepManagedWorkspaceArchives();
    expect(await readFile(join(outside, "plugins/cache/keep"), "utf8")).toBe("active");
  });
});
