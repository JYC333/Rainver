import {workspacePublicationNeedsReview} from '../src/modules/projectFolders/workspacePublication.js';
import {checkpointWorkspaceRun} from '../src/modules/hosts/executionWorkspaceJobs.js';
import type {HostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedRun, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { conversationWorkspaceChangesForViewer, workspaceChangesForConversation, workspaceChangesForRun } from "../src/modules/projectFolders/workspaceReadModel.js";
import { agentWorkspaceDetail, listAgentWorkspaces } from "../src/modules/projectFolders/workspaceOverview.js";
import { listAgentWorkspaceGroups } from "../src/modules/projectFolders/workspaceOverviewGroups.js";
import { workspaceIntegrationRecoveryHints } from "../src/modules/projectFolders/workspaceRecovery.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { runBodyReadableSql } from "../src/modules/runs/runBodyReadSql.js";
import { authorizedWorkspaceChange } from "../src/modules/projectFolders/workspaceOperations.js";
import { sessionActor } from "../src/modules/systemActions/operations/actor.js";

/**
 * Workspace progress readers on real PostgreSQL: one batch belongs to the Runs
 * bound to it, conversation pending work stays reachable on its own, adoption
 * is read from the parent's recorded lineage, and the Project overview applies
 * Project, Host, conversation and Run visibility before paging.
 */
const SPACE = "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDER = "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "c1c1c1c1-cccc-4ccc-8ccc-cccccccccccc";
const FOLDER = "e1e1e1e1-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "11111111-aaaa-4111-8111-111111111111";
const FOREIGN_LOCATION = "11111111-bbbb-4111-8111-111111111111";
const MACHINE = "22222222-aaaa-4222-8222-222222222222";
const FOREIGN_MACHINE = "22222222-bbbb-4222-8222-222222222222";
const HOST = "33333333-aaaa-4333-8333-333333333333";
const FOREIGN_HOST = "33333333-bbbb-4333-8333-333333333333";
const AGENT = "55555555-aaaa-4555-8555-555555555555";
const VERSION = "66666666-aaaa-4666-8666-666666666666";
const CONVERSATION = "88888888-aaaa-4888-8888-888888888888";
const OTHER_CONVERSATION = "88888888-bbbb-4888-8888-888888888888";

const db = useTestDatabase(import.meta.filename);
let roomId = "";
const identity = { spaceId: SPACE, userId: OWNER };

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["sessions", "workspace_locations", "project_folders", "tasks", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"], { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT, spaceType: "team" });
  await seedSpaceMember(db.pool, { space: SPACE, user: OUTSIDER });
  roomId = (await db.pool.query<{ id: string }>("SELECT id FROM rooms WHERE space_id=$1 AND is_mainline=true LIMIT 1", [SPACE])).rows[0]!.id;
  for (const session of [CONVERSATION, OTHER_CONVERSATION]) {
    await db.pool.query("INSERT INTO sessions(id,space_id,project_id,room_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',$6,$6)", [session, SPACE, PROJECT, roomId, session === CONVERSATION ? "Refactor login" : "Other work", now]);
  }
  await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'repo','code','active',false,false,$4,$4)", [FOLDER, SPACE, PROJECT, now]);
  await db.pool.query("INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'Mine','desktop',$4,$4),($3,$5,'Theirs','desktop',$4,$4)", [MACHINE, OWNER, FOREIGN_MACHINE, now, OUTSIDER]);
  await db.pool.query(`INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,created_at,updated_at)
    VALUES($1,$2,$3,'Laptop','remote','linux_native','online','{}'::jsonb,$7,$7),($4,$5,$6,'Their laptop','remote','linux_native','offline','{}'::jsonb,$7,$7)`, [HOST, OWNER, MACHINE, FOREIGN_HOST, OUTSIDER, FOREIGN_MACHINE, now]);
  await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'remote','/repo',true,'active',$7,$7),($5,$2,$3,$6,'remote','/theirs',true,'stale',$7,$7)`, [LOCATION, SPACE, FOLDER, HOST, FOREIGN_LOCATION, FOREIGN_HOST, now]);
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, name: "Builder", now });
});

/** `hidden`: another person's private Run; `withheld`: shared at summary level only. */
async function run(status = "succeeded", session = CONVERSATION, access: "visible" | "hidden" | "withheld" = "visible") {
  const id = randomUUID(), owner = access === "visible" ? OWNER : OUTSIDER;
  await seedRun(db.pool, { id, space: SPACE, owner, agent: AGENT, version: VERSION, existingAgent: true });
  await db.pool.query("UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,status=$6,visibility=$7,access_level=$8,contract_snapshot_json='{\"execution_workspace_version\":1}' WHERE id=$1",
    [id, PROJECT, session, LOCATION, owner, status, access === "hidden" ? "private" : "space_shared", access === "withheld" ? "summary" : "full"]);
  return id;
}
const decode = (cursor: string) => Buffer.from(cursor, "base64url").toString("utf8");
/** One conversation workspace per generation: each fixture is its own generation. */
let generation = 100;
async function workspace(input: { owner?: "conversation" | "delegation"; session?: string; parent?: string; delegation?: string; host?: string; location?: string; generation?: number; retention?: Record<string, unknown> } = {}) {
  const id = randomUUID(), owner = input.owner ?? "conversation";
  await db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,session_id,delegation_id,parent_workspace_id,generation,state,target_ref,retention_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready','refs/heads/dev',$11::jsonb)`,
  [id, SPACE, PROJECT, input.location ?? LOCATION, input.host ?? HOST, owner, owner === "conversation" ? input.session ?? CONVERSATION : null, input.delegation ?? null, input.parent ?? null, input.generation ?? ++generation, JSON.stringify(input.retention ?? {})]);
  return id;
}
let sequence = 0;
async function batch(workspaceId: string, runIds: string[], state: string, extra: { source?: string | null; verification?: Record<string, unknown>; updatedAt?: string } = {}) {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,state,originating_run_id,root_run_id,source_commit,verification_json,updated_at)
    VALUES($1,$2,$3,1,$4,$5,$6,$6,$7,$8::jsonb,COALESCE($9::timestamptz,now()))`, [id, workspaceId, SPACE, ++sequence, state, runIds[0], extra.source === undefined ? "b".repeat(40) : extra.source, JSON.stringify(extra.verification ?? {}), extra.updatedAt ?? null]);
  for (const runId of runIds) await db.pool.query("INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,checkpoint_state) VALUES($1,$2,$3,$4,'saved')", [runId, workspaceId, SPACE, id]);
  return id;
}
let group: string | null = null;
beforeEach(() => { group = null; });
async function delegation(parentRun: string, childRun: string) {
  const id = randomUUID();
  if (!group) {
    const message = randomUUID();
    group = randomUUID();
    await db.pool.query("INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Do two things',0,'/',now())", [message, SPACE, CONVERSATION, OWNER]);
    await db.pool.query("INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Fan-out','Two','active',now(),now())", [group, SPACE, OWNER, roomId, CONVERSATION, message, PROJECT]);
  }
  await db.pool.query("INSERT INTO run_delegations(id,space_id,group_id,parent_run_id,child_run_id,requesting_agent_id,target_agent_id,status,instruction,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,'succeeded','Change',now(),now())", [id, SPACE, group, parentRun, childRun, AGENT]);
  await db.pool.query("UPDATE runs SET parent_run_id=$2,delegation_id=$3 WHERE id=$1", [childRun, parentRun, id]);
  return id;
}

it('keeps removed branches in history without closing or claiming adoption of their saved work',async ctx=>{
 if(!db.available)return ctx.skip();
 const closed=await workspace({retention:{state:'missing',reason:'missing_acknowledged'}});
 await batch(closed,[await run('succeeded')],'abandoned');
 const stale=await workspace({retention:{state:'retained',reason:'unpublished_changes'}});
 await batch(stale,[await run('succeeded')],'abandoned');
 const unresolved=await workspace({retention:{state:'missing',reason:'branch_missing'}});
 await batch(unresolved,[await run('succeeded')],'open');
 const current=await listAgentWorkspaces(db.pool,identity,PROJECT,{view:'current',limit:50});
 expect(current.items.some(i=>i.workspace_id===closed||i.workspace_id===stale)).toBe(false);
 expect(current.items.some(i=>i.workspace_id===unresolved)).toBe(false);
 const history=await listAgentWorkspaces(db.pool,identity,PROJECT,{view:'history',limit:50});
 expect(history.items.find(i=>i.workspace_id===closed)).toMatchObject({work_state:'missing_closed'});
 expect(history.items.find(i=>i.workspace_id===unresolved)).toMatchObject({work_state:'missing'});
 expect((await agentWorkspaceDetail(db.pool,identity,PROJECT,unresolved)).items[0]?.change.state).toBe('open');
 expect(history.items.find(i=>i.workspace_id===stale)).toMatchObject({work_state:'kept'});
});

it('keeps live work and new saves current despite an older missing-branch assessment',async ctx=>{
 if(!db.available)return ctx.skip();
 const ids:string[]=[];
 for(const [status,state] of [['running','open'],['succeeded','integrating'],['succeeded','blocked']] as const){
  const id=await workspace({retention:{state:'missing',reason:'branch_missing'}});
  await batch(id,[await run(status)],state);ids.push(id);
 }
 const resaved=await workspace({retention:{state:'missing',reason:'branch_missing',assessed_at:'2026-01-01T00:00:00Z'}});
 await batch(resaved,[await run()],'open',{updatedAt:'2026-01-02T00:00:00Z'});ids.push(resaved);
 const current=await listAgentWorkspaces(db.pool,identity,PROJECT,{view:'current',limit:50});
 expect(current.items.map(i=>i.workspace_id).sort()).toEqual(ids.sort());
 expect(current.items.find(i=>i.workspace_id===resaved)).toMatchObject({work_state:'saved',retention:null});
 const history=await listAgentWorkspaces(db.pool,identity,PROJECT,{view:'history',limit:50});
 expect(history.items).toEqual([]);
});

describe("workspace progress ownership", () => {
  it("returns a conversation batch only under the Runs bound to it, and its pending work once per conversation", async ctx => {
    if (!db.available) return ctx.skip();
    const first = await run(), second = await run(), readOnly = await run();
    const w = await workspace();
    const merged = await batch(w, [first], "integrated");
    const pending = await batch(w, [second], "open");
    expect((await workspaceChangesForRun(db.pool, { id: first, space_id: SPACE }, OWNER)).map(c => [c.change_set_id, c.landing])).toEqual([[merged, "target"]]);
    expect((await workspaceChangesForRun(db.pool, { id: second, space_id: SPACE }, OWNER)).map(c => c.change_set_id)).toEqual([pending]);
    // A later read-only turn is not given the earlier pending batch to display.
    expect(await workspaceChangesForRun(db.pool, { id: readOnly, space_id: SPACE }, OWNER)).toEqual([]);
    const conversation = await conversationWorkspaceChangesForViewer(db.pool, SPACE, CONVERSATION, OWNER);
    expect(conversation?.entries.map(entry => [entry.change.change_set_id, entry.run.id])).toEqual([[pending, second]]);
    expect(await conversationWorkspaceChangesForViewer(db.pool, SPACE, OTHER_CONVERSATION, OWNER)).toEqual({ entries: [], next_cursor: null });
    // Outside the Project (team Space, not a member): the conversation is not readable at all.
    expect(await conversationWorkspaceChangesForViewer(db.pool, SPACE, CONVERSATION, OUTSIDER)).toBeNull();
  });

  it("reports parent adoption only from the parent's recorded lineage, and keeps unadopted child work reachable", async ctx => {
    if (!db.available) return ctx.skip();
    const parentRun = await run(), adoptedRun = await run(), lostRun = await run(), blockedRun = await run();
    const parent = await workspace();
    const adopted = await workspace({ owner: "delegation", parent, delegation: await delegation(parentRun, adoptedRun) });
    const lost = await workspace({ owner: "delegation", parent, delegation: await delegation(parentRun, lostRun) });
    const blocked = await workspace({ owner: "delegation", parent, delegation: await delegation(parentRun, blockedRun) });
    const adoptedChange = await batch(adopted, [adoptedRun], "integrated");
    const lostChange = await batch(lost, [lostRun], "integrated");
    const blockedChange = await batch(blocked, [blockedRun], "blocked");
    // A successful parent Run alone proves nothing: only the recorded list does.
    await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1", [parentRun]);
    const parentChange = await batch(parent, [parentRun], "open", { verification: { adopted_child_change_ids: [adoptedChange] } });
    expect((await workspaceChangesForRun(db.pool, { id: adoptedRun, space_id: SPACE }, OWNER))[0]?.landing).toBe("parent");
    expect((await workspaceChangesForRun(db.pool, { id: lostRun, space_id: SPACE }, OWNER))[0]?.landing).toBe("parent_unverified");
    expect((await workspaceChangesForRun(db.pool, { id: blockedRun, space_id: SPACE }, OWNER))[0]?.landing).toBeNull();
    const pending = (await workspaceChangesForConversation(db.pool, { spaceId: SPACE, sessionId: CONVERSATION, projectId: PROJECT }, OWNER)).entries.map(entry => entry.change.change_set_id);
    expect(pending.sort()).toEqual([blockedChange, parentChange].sort());
    expect(pending).not.toContain(lostChange);
  });
});

describe("Project Agent workspace overview", () => {
  it("separates current from history, derives the work state on the server and pages with an opaque cursor", async ctx => {
    if (!db.available) return ctx.skip();
    const done = await workspace({ session: OTHER_CONVERSATION, retention: { state: "reclaimed", reason: "merged", reclaimed_at: new Date().toISOString(), retained_refs: 0, unclaimed_refs: 4 } });
    await batch(done, [await run("succeeded", OTHER_CONVERSATION)], "integrated");
    const attention = await workspace();
    await batch(attention, [await run("failed")], "blocked");
    const running = await workspace({ generation: 2 });
    await batch(running, [await run("running")], "open", { source: null });
    const current = await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "current", limit: 1 });
    expect(current.items).toHaveLength(1);
    expect(current.next_cursor).toEqual(expect.any(String));
    const rest = await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "current", limit: 1, cursor: current.next_cursor! });
    const states = Object.fromEntries([...current.items, ...rest.items].map(item => [item.workspace_id, item.work_state]));
    expect(states).toEqual({ [attention]: "attention", [running]: "running" });
    // The cursor names only the row this reader was just shown.
    expect(JSON.parse(decode(current.next_cursor!))[1]).toBe(current.items[0]!.workspace_id);
    expect(rest.next_cursor).toBeNull();
    const history = await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "history", limit: 20 });
    expect(history.items).toEqual([expect.objectContaining({
      workspace_id: done, work_state: "merged", folder: { id: FOLDER, name: "repo" }, host: { name: "Laptop", online: true },
      conversation: { id: OTHER_CONVERSATION, title: "Other work", room_id: roomId }, agent: { id: AGENT, name: "Builder" },
      retention: expect.objectContaining({ state: "reclaimed", unclaimed_refs: 4 }),
    })]);
    const detail = await agentWorkspaceDetail(db.pool, identity, PROJECT, done);
    expect(detail.items.map(entry => entry.change.state)).toEqual(["integrated"]);
    expect(detail.next_cursor).toBeNull();
    await expect(listAgentWorkspaces(db.pool, identity, PROJECT, { view: "current", limit: 5, cursor: "not-a-cursor" })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("withholds another person's Host, unreadable conversations and the whole Project from outsiders", async ctx => {
    if (!db.available) return ctx.skip();
    const theirs = await workspace({ host: FOREIGN_HOST, location: FOREIGN_LOCATION });
    await batch(theirs, [await run("failed")], "blocked");
    const archived = await workspace({ session: OTHER_CONVERSATION });
    await batch(archived, [await run("failed", OTHER_CONVERSATION)], "blocked");
    await db.pool.query("UPDATE sessions SET status='archived' WHERE id=$1", [OTHER_CONVERSATION]);
    expect((await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "current", limit: 20 })).items).toEqual([]);
    await expect(agentWorkspaceDetail(db.pool, identity, PROJECT, theirs)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listAgentWorkspaces(db.pool, { spaceId: SPACE, userId: OUTSIDER }, PROJECT, { view: "current", limit: 20 })).rejects.toMatchObject({ statusCode: expect.any(Number) });
  });

  it("aggregates only visible batches and bound Runs of a workspace with mixed visibility", async ctx => {
    if (!db.available) return ctx.skip();
    const mixed = await workspace();
    const visibleRun = await run();
    const older = new Date(Date.now() - 3_600_000).toISOString();
    const shown = await batch(mixed, [visibleRun], "open", { updatedAt: older });
    // Another person's private Run blocked a newer batch and is still running in
    // this workspace; a summary-only Run saved another. None of it may surface.
    const hiddenRun = await run("running", CONVERSATION, "hidden");
    await batch(mixed, [hiddenRun], "blocked");
    await batch(mixed, [await run("running", CONVERSATION, "withheld")], "integrated");
    const [item] = (await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "current", limit: 20 })).items;
    expect(item).toMatchObject({ workspace_id: mixed, work_state: "saved", batch_count: 1, run: { id: visibleRun, status: "succeeded" } });
    expect(Date.parse(item!.activity_at)).toBe(Date.parse(older));
    expect((await agentWorkspaceDetail(db.pool, identity, PROJECT, mixed)).items.map(entry => entry.change.change_set_id)).toEqual([shown]);
    // A workspace whose every batch is hidden or withheld does not exist for this reader.
    const hidden = await workspace();
    await batch(hidden, [await run("failed", CONVERSATION, "hidden")], "blocked");
    const withheld = await workspace();
    await batch(withheld, [await run("failed", CONVERSATION, "withheld")], "blocked");
    const all = await Promise.all((["current", "history"] as const).map(view => listAgentWorkspaces(db.pool, identity, PROJECT, { view, limit: 50 })));
    expect(all.flatMap(page => page.items.map(i => i.workspace_id))).toEqual([mixed]);
    for (const id of [hidden, withheld]) await expect(agentWorkspaceDetail(db.pool, identity, PROJECT, id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("fills a page past a window of hidden newer workspaces and never puts them in the cursor", async ctx => {
    if (!db.available) return ctx.skip();
    const visible: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await workspace();
      await batch(id, [await run()], "open", { updatedAt: new Date(Date.now() - (10 - i) * 60_000).toISOString() });
      visible.push(id);
    }
    const hidden = new Set<string>();
    for (let i = 0; i < 160; i += 1) {
      const id = await workspace();
      await batch(id, [await run("failed", CONVERSATION, i % 2 ? "hidden" : "withheld")], "blocked");
      hidden.add(id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "current", limit: 2, cursor });
      seen.push(...page.items.map(item => item.workspace_id));
      if (page.next_cursor) {
        expect(page.items).toHaveLength(2);
        const [, id] = JSON.parse(decode(page.next_cursor));
        expect(hidden.has(id)).toBe(false);
        expect(id).toBe(page.items.at(-1)!.workspace_id);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...visible].reverse());
  });
});

describe("workspace batch pages", () => {
  it("continues pending conversation work past one page, with hidden rows using none of it", async ctx => {
    if (!db.available) return ctx.skip();
    const visible = new Set<string>();
    for (let i = 0; i < 55; i += 1) visible.add(await batch(await workspace(), [await run()], "blocked"));
    // Newer hidden blocked batches sort first; a filter after LIMIT would lose visible ones.
    for (let i = 0; i < 60; i += 1) await batch(await workspace(), [await run("failed", CONVERSATION, i % 2 ? "hidden" : "withheld")], "blocked");
    const first = await conversationWorkspaceChangesForViewer(db.pool, SPACE, CONVERSATION, OWNER, { limit: 50 });
    expect(first?.entries).toHaveLength(50);
    expect(first?.next_cursor).toEqual(expect.any(String));
    const second = await conversationWorkspaceChangesForViewer(db.pool, SPACE, CONVERSATION, OWNER, { limit: 50, cursor: first!.next_cursor });
    expect(second?.entries).toHaveLength(5);
    expect(second?.next_cursor).toBeNull();
    const ids = [...first!.entries, ...second!.entries].map(entry => entry.change.change_set_id);
    expect(new Set(ids)).toEqual(visible);
    await expect(conversationWorkspaceChangesForViewer(db.pool, SPACE, CONVERSATION, OWNER, { cursor: "bad" })).rejects.toMatchObject({ statusCode: 422 });
    // The Project attention list filters before its window too.
    const { projectAttentionRegistry } = await import("../src/modules/projects/attentionRegistry.js");
    const { registerWorkspaceAttention } = await import("../src/modules/projectFolders/workspaceReadModel.js");
    registerWorkspaceAttention();
    const adapter = projectAttentionRegistry.list().find(entry => entry.areaKind === "workspaces")!;
    const attention = await adapter.listAttentionItems(db.pool, identity, PROJECT);
    expect(attention).toHaveLength(55);
    expect(attention.every(item => visible.has(item.blocking_refs[0]!))).toBe(true);
  });

  it("pages one workspace's batches in the detail view", async ctx => {
    if (!db.available) return ctx.skip();
    const w = await workspace();
    for (let i = 0; i < 4; i += 1) await batch(w, [await run(i === 3 ? "succeeded" : "failed", CONVERSATION, i === 1 ? "hidden" : "visible")], i === 3 ? "open" : "abandoned");
    const first = await agentWorkspaceDetail(db.pool, identity, PROJECT, w, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const rest = await agentWorkspaceDetail(db.pool, identity, PROJECT, w, { limit: 2, cursor: first.next_cursor! });
    expect(rest.items).toHaveLength(1);
    expect(rest.next_cursor).toBeNull();
    expect([...first.items, ...rest.items].map(entry => entry.change.state)).toEqual(["open", "abandoned", "abandoned"]);
  });
});

/** A failed integration attempt recorded for a blocked batch. */
async function failedIntegration(workspaceId: string, changeId: string) {
  const id = randomUUID();
  await db.pool.query("UPDATE workspace_change_sets SET base_commit=$2 WHERE id=$1", [changeId, "a".repeat(40)]);
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,detail_json,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/dev','failed',$9,'{"error":"checks_failed"}'::jsonb,now(),now())`, [id, SPACE, workspaceId, changeId, LOCATION, randomUUID(), "b".repeat(40), "a".repeat(40), OWNER]);
  return id;
}

describe("integration recovery hints", () => {
  it("reaches visible failed batches behind more than one window of hidden ones, capped at five", async ctx => {
    if (!db.available) return ctx.skip();
    const w = await workspace();
    const current = await run("running");
    await batch(w, [current], "open");
    const recoverable = async (access: "visible" | "hidden" | "withheld") => {
      const id = await batch(w, [await run("failed", CONVERSATION, access)], "blocked");
      await failedIntegration(w, id);
      return id;
    };
    // The first five candidates are hidden or withheld; visible failures follow.
    for (let i = 0; i < 6; i += 1) await recoverable(i % 2 ? "hidden" : "withheld");
    const visible = [await recoverable("visible"), await recoverable("visible")];
    const subject = { id: current, space_id: SPACE };
    expect((await workspaceIntegrationRecoveryHints(db.pool, subject, OWNER, w)).map(h => h.change_set_id).sort()).toEqual([...visible].sort());
    // More hidden rows than one page of a hundred, between visible ones.
    for (let i = 0; i < 110; i += 1) await recoverable(i % 2 ? "hidden" : "withheld");
    for (let i = 0; i < 5; i += 1) visible.push(await recoverable("visible"));
    for (let i = 0; i < 3; i += 1) await recoverable("hidden");
    const capped = await workspaceIntegrationRecoveryHints(db.pool, subject, OWNER, w);
    expect(capped).toHaveLength(5);
    // Newest visible first; nothing hidden or withheld is ever a hint.
    expect(capped.map(h => h.change_set_id)).toEqual(visible.slice(-5).reverse());
    // A reader of the conversation without Project write gets none.
    await db.pool.query("UPDATE runs SET owner_user_id=$2,instructed_by_user_id=$2,visibility='space_shared',access_level='full' WHERE id=$1", [current, OUTSIDER]);
    expect(await workspaceIntegrationRecoveryHints(db.pool, subject, OUTSIDER, w)).toEqual([]);
  });
});

describe("Run body gate in SQL", () => {
  /** `getVisibleRun` with an unwithheld body, against the SQL gate, for one viewer. */
  async function compare(viewer: string, runIds: string[]) {
    const repository = new PgRunRepository(db.pool);
    const sql = new Set((await db.pool.query<{ id: string }>(`SELECT r.id FROM runs r WHERE r.space_id=$1 AND r.id=ANY($2::varchar[]) AND ${runBodyReadableSql("r", "$3")}`, [SPACE, runIds, viewer])).rows.map(row => row.id));
    const detail = new Set<string>();
    for (const id of runIds) if ((await repository.getVisibleRun(SPACE, viewer, id))?.effective_access_level === "full") detail.add(id);
    return { sql, detail };
  }

  it("matches the detail read for personal, shared, granted and oversight access, and only narrows it", async ctx => {
    if (!db.available) return ctx.skip();
    const own = await run();
    const shared = await run("succeeded", CONVERSATION, "visible");
    await db.pool.query("UPDATE runs SET owner_user_id=$2,instructed_by_user_id=$2 WHERE id=$1", [shared, OUTSIDER]);
    const summary = await run("succeeded", CONVERSATION, "withheld");
    const hidden = await run("succeeded", CONVERSATION, "hidden");
    const granted = await run("succeeded", CONVERSATION, "hidden");
    await db.pool.query("UPDATE runs SET visibility='selected_users' WHERE id=$1", [granted]);
    await db.pool.query("INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,granted_by_user_id,access_level,created_at,updated_at) VALUES($1,$2,'run',$3,$4,$5,'full',now(),now())", [randomUUID(), SPACE, granted, OWNER, OUTSIDER]);
    const matrix = [own, shared, summary, hidden, granted];
    for (const viewer of [OWNER, OUTSIDER]) {
      const { sql, detail } = await compare(viewer, matrix);
      expect([...sql].sort(), viewer).toEqual([...detail].sort());
    }
    expect([...(await compare(OWNER, matrix)).sql].sort()).toEqual([own, shared, granted].sort());
    // Content oversight raises a Space owner to full on shared summary-level
    // Runs; the SQL gate follows the same oversight rule as the detail read.
    await db.pool.query("UPDATE spaces SET oversight_mode='content' WHERE id=$1", [SPACE]);
    const overseen = await compare(OWNER, matrix);
    expect([...overseen.sql].sort()).toEqual([...overseen.detail].sort());
    expect(overseen.sql.has(summary)).toBe(true);
    // Stricter than the detail read, never wider: an unreadable conversation
    // and Reading-domain Runs are excluded even where the detail read admits them.
    const reading = await run();
    await db.pool.query(`UPDATE runs SET contract_snapshot_json='{"execution_workspace_version":1,"workflow_input_json":{"reading_method":{}}}'::jsonb WHERE id=$1`, [reading]);
    const archivedRun = await run("succeeded", OTHER_CONVERSATION);
    await db.pool.query("UPDATE sessions SET status='archived' WHERE id=$1", [OTHER_CONVERSATION]);
    const narrowed = await compare(OWNER, [...matrix, reading, archivedRun]);
    for (const id of narrowed.sql) expect(narrowed.detail.has(id), id).toBe(true);
    expect(narrowed.sql.has(reading)).toBe(false);
    expect(narrowed.sql.has(archivedRun)).toBe(false);
    expect(narrowed.detail.has(archivedRun)).toBe(true);
  });
});

describe("Agent workspace groups", () => {
  const X = "1".repeat(40), Y = "2".repeat(40), Z = "3".repeat(40);
  const KEY = `c:${CONVERSATION}:${LOCATION}`;
  it("aggregates one conversation × repository, folds delegations into its history and only exact proven duplicates away", async ctx => {
    if (!db.available) return ctx.skip();
    const coordinator = await run();
    const main = await workspace();
    await batch(main, [coordinator], "integrated", { source: X, updatedAt: new Date(Date.now() - 600_000).toISOString() });
    const next = await workspace();
    await batch(next, [await run()], "open", { source: Y, updatedAt: new Date(Date.now() - 500_000).toISOString() });
    const children: string[] = [];
    for (const [source, age] of [[X, 400_000], [Z, 300_000], [Z, 200_000]] as const) {
      const childRun = await run();
      const id = await workspace({ owner: "delegation", parent: main, delegation: await delegation(coordinator, childRun) });
      await batch(id, [childRun], "open", { source, updatedAt: new Date(Date.now() - age).toISOString() });
      children.push(id);
    }
    const other = await workspace({ session: OTHER_CONVERSATION });
    await batch(other, [await run("succeeded", OTHER_CONVERSATION)], "integrated", { source: X });
    const current = await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 20 });
    expect(current.items.map(g => g.group_key)).toEqual([KEY]);
    const [g] = current.items;
    expect(g).toMatchObject({ workspace_count: 5, delegation_count: 3, work_state: "saved", proven_duplicates: 1,
      conversation: { id: CONVERSATION, title: "Refactor login", room_id: roomId }, folder: { id: FOLDER, name: "repo" },
      latest_result: { workspace_id: children[2], state: "open", source_commit: Z } });
    // Z is listed once (same commit), Y stays visible; X folded because that exact commit landed.
    expect(g!.unconfirmed.map(u => [u.source_commit, u.same_commit_count, u.reason])).toEqual([[Z, 1, "saved_not_merged"], [Y, 0, "saved_not_merged"]]);
    expect(g!.issues).toEqual([{ kind: "unconfirmed", count: 2 }]);
    const history = await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "history", limit: 20 });
    expect(history.items.map(h => h.group_key)).toEqual([`c:${OTHER_CONVERSATION}:${LOCATION}`]);
    // The folded execution history returns every generation of the group, delegations included.
    const all = await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "all", group: KEY, limit: 50 });
    expect(all.items.map(i => i.workspace_id).sort()).toEqual([main, next, ...children].sort());
  });

  it("groups and pages only what the reader may see", async ctx => {
    if (!db.available) return ctx.skip();
    const mine = await workspace();
    await batch(mine, [await run()], "open", { source: Y });
    // Another person's private saved work in the same conversation and repository never appears or counts.
    const hidden = await workspace();
    await batch(hidden, [await run("succeeded", CONVERSATION, "hidden")], "open", { source: Z });
    const withheld = await workspace();
    await batch(withheld, [await run("failed", CONVERSATION, "withheld")], "blocked");
    // A conversation with only hidden work is no group at all.
    const foreign = await workspace({ session: OTHER_CONVERSATION });
    await batch(foreign, [await run("failed", OTHER_CONVERSATION, "hidden")], "blocked");
    const [g, ...rest] = (await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 20 })).items;
    expect(rest).toEqual([]);
    expect(g).toMatchObject({ group_key: KEY, workspace_count: 1, batch_count: 1, issues: [{ kind: "unconfirmed", count: 1 }] });
    expect(g!.unconfirmed.map(u => u.source_commit)).toEqual([Y]);
    expect((await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "history", limit: 20 })).items).toEqual([]);
    expect((await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "all", group: KEY, limit: 50 })).items.map(i => i.workspace_id)).toEqual([mine]);
    // Group paging: a cursor names only a group this reader was shown.
    const second = await workspace({ session: OTHER_CONVERSATION });
    await batch(second, [await run("succeeded", OTHER_CONVERSATION)], "open", { source: X });
    const first = await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 1 });
    expect(first.items).toHaveLength(1);
    const page2 = await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 1, cursor: first.next_cursor! });
    expect([...first.items, ...page2.items].map(i => i.group_key).sort()).toEqual([KEY, `c:${OTHER_CONVERSATION}:${LOCATION}`].sort());
    expect(page2.next_cursor).toBeNull();
    await expect(listAgentWorkspaceGroups(db.pool, { spaceId: SPACE, userId: OUTSIDER }, PROJECT, { view: "current", limit: 20 })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    await expect(listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 5, cursor: "bad" })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("Workspace batch contributors", () => {
  const X = "4".repeat(40), Z = "5".repeat(40);
  const KEY = `c:${CONVERSATION}:${LOCATION}`;
  const actor = sessionActor({ spaceId: SPACE, userId: OWNER });
  const everyRead = async () => JSON.stringify([
    await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 20 }),
    await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "history", limit: 20 }),
    await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "current", limit: 50 }),
    await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "history", limit: 50 }),
    await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "all", group: KEY, limit: 50 }),
    await conversationWorkspaceChangesForViewer(db.pool, SPACE, CONVERSATION, OWNER),
  ]);

  it("hides a readable coordinator's batch from every read model and operation once an unreadable shared child checkpointed into it", async ctx => {
    if (!db.available) return ctx.skip();
    const older = await workspace();
    await batch(older, [await run()], "open", { source: X, updatedAt: new Date(Date.now() - 600_000).toISOString() });
    const coordinator = await run("succeeded");
    const shared = await workspace();
    // The child continued in the coordinator's batch: its checkpoint moved the
    // source to Z and the activity time, though the batch origin stays readable.
    const child = await run("succeeded", CONVERSATION, "hidden");
    await delegation(coordinator, child);
    const changed = await batch(shared, [coordinator, child], "open", { source: X });
    await db.pool.query("UPDATE runs SET instructed_by_user_id=$2 WHERE id=$1", [child, OWNER]);
    await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending',start_commit=$2,launch_sequence=2 WHERE run_id=$1", [child, X]);
    await db.pool.query('UPDATE hosts SET capabilities_json=$2::jsonb WHERE id=$1',[HOST,JSON.stringify({execution_workspaces:{version:2}})]);
    const hosts = { requestTaskBranch: async () => ({ok:true,commit:Z}) } as unknown as HostConnectionRegistry;
    await checkpointWorkspaceRun(db.pool, child, SPACE, hosts);
    expect((await db.pool.query('SELECT source_commit,verification_json FROM workspace_change_sets WHERE id=$1',[changed])).rows[0])
      .toMatchObject({source_commit:Z,verification_json:{contributor_run_ids:[child]}});
    expect(await workspaceChangesForRun(db.pool,{id:coordinator,space_id:SPACE},OWNER)).toEqual([]);
    const visiblePage=await listAgentWorkspaces(db.pool,identity,PROJECT,{view:'current',limit:1});
    expect(visiblePage.items.map(i=>i.workspace_id)).toEqual([older]);
    expect(visiblePage.next_cursor).toBeNull();
    const reads = await everyRead();
    expect(reads).not.toContain(Z);
    expect(reads).not.toContain(changed);
    expect(reads).not.toContain(shared);
    const [g] = (await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 20 })).items;
    expect(g).toMatchObject({ workspace_count: 1, current: { workspace_id: older } });
    await expect(agentWorkspaceDetail(db.pool, identity, PROJECT, shared, {})).rejects.toMatchObject({ statusCode: 404 });
    // get, diff, publication and closure all authorize through the same gate.
    await expect(authorizedWorkspaceChange(db.pool, changed, actor)).rejects.toThrow();
    // A withheld (summary-only) child hides it just the same; a readable one shows it.
    const summaryChild = await run("succeeded", CONVERSATION, "withheld");
    const withheld = await batch(await workspace(), [await run(), summaryChild], "open", { source: Z });
    await expect(authorizedWorkspaceChange(db.pool, withheld, actor)).rejects.toThrow();
    const readable = await batch(await workspace(), [await run(), await run()], "open", { source: Z });
    await expect(authorizedWorkspaceChange(db.pool, readable, actor)).resolves.toMatchObject({ id: readable, access: "person" });
    expect(await everyRead()).toContain(readable);
  });

  it("applies recorded native contributors and adopted child batches the same way", async ctx => {
    if (!db.available) return ctx.skip();
    const hiddenRun = await run("succeeded", CONVERSATION, "hidden");
    // A Run that prepared or checkpointed through the native operation without a binding.
    const recorded = await batch(await workspace(), [await run()], "open", { source: Z, verification: { contributor_run_ids: [hiddenRun] } });
    // A parent batch carrying an adopted child batch whose Run is unreadable.
    const parentWorkspace = await workspace(), parentRun = await run();
    const childRun = await run("succeeded", CONVERSATION, "hidden");
    const childBatch = await batch(await workspace({ owner: "delegation", parent: parentWorkspace, delegation: await delegation(parentRun, childRun) }), [childRun], "integrated", { source: Z });
    const adopter = await batch(parentWorkspace, [parentRun], "open", { source: Z, verification: { adopted_child_change_ids: [childBatch] } });
    const reads = await everyRead();
    for (const id of [recorded, adopter, childBatch]) expect(reads).not.toContain(id);
    // A native-only contributor of the adopted batch is inherited recursively.
    const nativeParent=await workspace();
    const nativeChild = await batch(await workspace({owner:'delegation',parent:nativeParent,delegation:await delegation(parentRun,await run())}), [await run()], 'integrated', {source:Z,verification:{contributor_run_ids:[hiddenRun]}});
    const nativeAdopter=await batch(nativeParent,[await run()], 'open', {source:Z,verification:{adopted_child_change_ids:[nativeChild]}});
    expect(await everyRead()).not.toContain(nativeAdopter);
    await db.pool.query("UPDATE runs SET has_context_taint=true,context_taint_json='{}'::jsonb WHERE id=$1",[hiddenRun]);
    for(const id of [recorded,nativeAdopter]) expect(await workspacePublicationNeedsReview(db.pool,{spaceId:SPACE,changeSetId:id,requesterId:OWNER,repairRunId:null})).toBe(true);
    for (const id of [recorded, adopter, nativeAdopter]) await expect(authorizedWorkspaceChange(db.pool, id, actor)).rejects.toThrow();
  });

  it("keeps a parent's unpublished work at the commit a child adopted, and folds only what reached the target", async ctx => {
    if (!db.available) return ctx.skip();
    const coordinator = await run();
    const parent = await workspace();
    // The child forked from the parent's unpublished checkpoint X and its batch was adopted back into the parent.
    const childRun = await run();
    const child = await workspace({ owner: "delegation", parent, delegation: await delegation(coordinator, childRun) });
    const childBatch = await batch(child, [childRun], "integrated", { source: X, updatedAt: new Date(Date.now() - 300_000).toISOString() });
    const open = await batch(parent, [coordinator], "open", { source: X, verification: { adopted_child_change_ids: [childBatch] } });
    let [g] = (await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 20 })).items;
    expect(g!.proven_duplicates).toBe(0);
    expect(g!.unconfirmed.map(u => [u.change_set_id, u.reason])).toEqual([[open, "saved_not_merged"]]);
    // A child's proof against its parent target cannot suppress root work.
    await batch(child, [await run()], "no_changes", {source:X,verification:{adoption_proof:'target_paths_match'}});
    [g] = (await listAgentWorkspaceGroups(db.pool, identity, PROJECT, {view:'current',limit:20})).items;
    expect(g!.unconfirmed.map(u=>u.change_set_id)).toContain(open);
    // Once that exact commit is published from a root workspace, the duplicate folds away.
    await batch(await workspace(), [await run()], "integrated", { source: X, updatedAt: new Date(Date.now() - 900_000).toISOString() });
    [g] = (await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 20 })).items;
    expect(g).toMatchObject({ proven_duplicates: 1, unconfirmed: [] });
  });

  it("shows the session's newest generation as current even when an older generation was updated later", async ctx => {
    if (!db.available) return ctx.skip();
    const old = await workspace();
    const current = await workspace();
    await batch(current, [await run()], "open", { source: Z, updatedAt: new Date(Date.now() - 600_000).toISOString() });
    // The older generation's closure lands after the newer generation's last activity.
    const late = await batch(old, [await run()], "abandoned", { source: X });
    const [g] = (await listAgentWorkspaceGroups(db.pool, identity, PROJECT, { view: "current", limit: 20 })).items;
    // Activity still picks the latest result (the newer generation's saved work here) and orders members.
    expect(g).toMatchObject({ current: { workspace_id: current, generation: expect.any(Number) }, latest_result: { workspace_id: current } });
    expect(g!.current.generation).toBeGreaterThan((await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "all", group: KEY, limit: 50 })).items.find(i => i.workspace_id === old)!.generation);
    expect(g!.unconfirmed.map(u => u.change_set_id)).toContain(late);
    expect((await listAgentWorkspaces(db.pool, identity, PROJECT, { view: "all", group: KEY, limit: 50 })).items.map(i => i.workspace_id)).toEqual([old, current]);
  });
});
