import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentAttentionQuerySchema, AgentAttentionPageSchema } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { seedAttentionRun } from "./support/agentAttentionSeeds.js";
import { AgentAttentionRepository } from "../src/modules/agentAttention/repository.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { boundWork } from "../src/modules/agentAttention/readModel.js";
import { changeReadState, findWork, loadWorks, recordViews } from "../src/modules/agentAttention/readStateService.js";
const db = useTestDatabase(import.meta.url);
const space = randomUUID(),
  user = randomUUID(),
  project = randomUUID();
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], {
    cascade: true
  });
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner: user,
    project
  });
});
const run = (status = "succeeded") => seedAttentionRun(db.pool, {
  space,
  owner: user,
  status
});
const repository = () => new AgentAttentionRepository(db.pool);
async function page(query = {}) {
  return repository().page((await loadWorks(db.pool, user)).map(item => boundWork(item)), AgentAttentionQuerySchema.parse(query), new Date().toISOString());
}
async function session(ids: string[]) {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at)
    VALUES($1,$2,$3,'active',now(),now())`, [id, space, user]);
  await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=ANY($1::varchar[])`, [ids, id]);
  return id;
}
async function group(parent: string) {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,root_run_id,manager_user_id,title,goal,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'Group','Work','active',now(),now())`, [id, space, parent, user]);
  return id;
}
async function delegation(parent: string, child: string) {
  const id = randomUUID(),
    groupId = await group(parent);
  await db.pool.query(`INSERT INTO run_delegations(id,space_id,group_id,parent_run_id,child_run_id,
    requesting_agent_id,target_agent_id,status,instruction,created_at,updated_at)
    SELECT $1,$2,$3,p.id,c.id,p.agent_id,c.agent_id,'running','Work',now(),now()
    FROM runs p,runs c WHERE p.id=$4 AND c.id=$5`, [id, space, groupId, parent, child]);
  await db.pool.query(`UPDATE runs SET parent_run_id=$2,delegation_id=$3 WHERE id=$1`, [child, parent, id]);
  return groupId;
}
async function privateRun(id: string) {
  const other = randomUUID();
  await db.pool.query(`INSERT INTO users(id,display_name,email,status,registration_source,created_at,updated_at)
    VALUES($1,'Other',$2,'active','system',now(),now())`, [other, `${other}@test.invalid`]);
  await db.pool.query(`UPDATE space_memberships SET role='member' WHERE user_id=$1`, [user]);
  await db.pool.query(`UPDATE runs SET owner_user_id=$2,visibility='private' WHERE id=$1`, [id, other]);
}
async function task() {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO tasks(id,space_id,project_id,title,status,owner_user_id,created_at,updated_at)
    VALUES($1,$2,$3,'Task','in_progress',$4,now(),now())`, [id, space, project, user]);
  return id;
}
async function plan(ids: string[], root: string | null = null) {
  const taskId = await task(),
    planId = randomUUID(),
    version = randomUUID();
  await db.pool.query(`INSERT INTO plans(id,space_id,source_task_id,root_run_id,name,created_at,updated_at)
    VALUES($1,$2,$3,$4,'Plan',now(),now())`, [planId, space, taskId, root]);
  await db.pool.query(`INSERT INTO plan_versions(id,space_id,plan_id,version,node_count,depth,definition_json,created_at,updated_at)
    VALUES($1,$2,$3,1,$4,1,'{}',now(),now())`, [version, space, planId, ids.length]);
  for (let index = 0; index < ids.length; index++) {
    const node = randomUUID();
    await db.pool.query(`INSERT INTO plan_nodes(id,space_id,plan_version_id,node_key,node_kind,title,content_hash,created_at,updated_at)
      VALUES($1,$2,$3,$4,'agent','Node','hash',now(),now())`, [node, space, version, `node-${index}`]);
    await db.pool.query(`INSERT INTO plan_node_runs(id,space_id,plan_node_id,run_id,created_at)
      VALUES($1,$2,$3,$4,now())`, [randomUUID(), space, node, ids[index]]);
  }
  return {
    taskId,
    planId
  };
}
async function automation(id: string) {
  const automationId = randomUUID();
  await db.pool.query(`INSERT INTO automations(id,space_id,owner_user_id,agent_id,name,created_at,updated_at)
    SELECT $1,space_id,owner_user_id,agent_id,'Automatic work',now(),now() FROM runs WHERE id=$2`, [automationId, id]);
  return automationId;
}
async function supervisor(id: string) {
  await db.pool.query(`UPDATE runs SET status='waiting_for_review',error_json='{"supervisor_review":true}' WHERE id=$1`, [id]);
}
describe("authorized lineage must not drop active work", () => {
  it("keeps a shared running delegate when its parent is private, including counts and scoped detail", async () => {
    const parent = await run(),
      child = await run("running");
    await delegation(parent, child);
    await db.pool.query(`UPDATE runs SET contract_snapshot_json=jsonb_build_object('source',jsonb_build_object('kind','delegation','id',delegation_id)) WHERE id=$1`, [child]);
    await privateRun(parent);
    const result = await page();
    expect(result.counts.working).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.identity).toEqual({
      kind: "run",
      source_id: child
    });
    expect(result.items[0]!.runs[0]).toMatchObject({
      parent_run_id: null,
      delegation_id: null,
      contract_source: {
        kind: "delegation",
        id: null
      }
    });
    const target = {
      space_id: space,
      identity: result.items[0]!.identity
    };
    const detail = findWork(await loadWorks(db.pool, user, undefined, target), space, target.identity);
    expect(detail.group).toBe("working");
    expect(detail.runs.map(run => run.run_id)).not.toContain(parent);
    expect(detail.work_key).toBe(result.items[0]!.work_key);
  });
  it.each(["root", "retry"])("keeps an active Run when its %s predecessor is hidden", async kind => {
    const parent = await run(),
      child = await run("running");
    if (kind === "root") await db.pool.query(`UPDATE runs SET root_run_id=$2 WHERE id=$1`, [child, parent]);else await db.pool.query(`UPDATE runs SET model_override_json=jsonb_build_object('chat_turn',jsonb_build_object('retry_of_run_id',$2::text)) WHERE id=$1`, [child, parent]);
    await privateRun(parent);
    const result = await page();
    expect(result.counts.working).toBe(1);
    expect(result.items[0]!.identity.source_id).toBe(child);
    expect(result.items[0]!.runs[0]).toMatchObject({
      root_run_id: null,
      retry_of_run_id: null
    });
  });
  it("keeps an ambiguously Task-linked Run independently instead of losing it", async () => {
    const id = await run("running");
    for (const taskId of [await task(), await task()]) {
      await db.pool.query(`INSERT INTO task_runs(id,space_id,task_id,run_id,role,created_at) VALUES($1,$2,$3,$4,'primary',now())`, [randomUUID(), space, taskId, id]);
    }
    const result = await page();
    expect(result.counts.working).toBe(1);
    expect(result.items[0]!.identity).toEqual({
      kind: "run",
      source_id: id
    });
  });
});
describe("persisted work mapping and source deduplication", () => {
  it("groups delegated work and puts its parent first when the child needs its person", async () => {
    const parent = await run("running"),
      child = await run();
    await run("running");
    await delegation(parent, child);
    await supervisor(child);
    const result = await page();
    expect(result.items[0]!.identity).toEqual({
      kind: "run",
      source_id: parent
    });
    expect(result.items[0]!.group).toBe("needs_you");
    expect(result.items[0]!.visible_run_count).toBe(2);
    expect(result.items[0]!.reasons).toContainEqual(expect.objectContaining({
      kind: "run_decision",
      run_id: child
    }));
    const subject = result.items[0]!.read_states.find(state => state.subject.kind === "run_decision")!;
    await changeReadState(db.pool, user, {
      identity: result.items[0]!.identity,
      space_id: space,
      subject: subject.subject,
      state_version: 0,
      action: "read"
    });
    expect((await page()).items[0]!.group).toBe("needs_you");
  });
  it.each(["root", "continuation"])("groups %s work and promotes the parent's item for a child decision", async kind => {
    const parent = await run("running"),
      child = await run();
    await run("running");
    if (kind === "root") await db.pool.query(`UPDATE runs SET root_run_id=$2 WHERE id=$1`, [child, parent]);else await db.pool.query(`UPDATE runs SET trigger_origin='continuation',cause_run_id=$2 WHERE id=$1`, [child, parent]);
    await supervisor(child);
    const result = await page();
    expect(result.items[0]!.identity.source_id).toBe(parent);
    expect(result.items[0]!.group).toBe("needs_you");
    expect(result.items[0]!.visible_run_count).toBe(2);
  });
  it("groups a non-Session agent_group and promotes a child's decision", async () => {
    const parent = await run("running"),
      child = await run(),
      groupId = await group(parent);
    await db.pool.query(`UPDATE runs SET run_group_id=$2 WHERE id=ANY($1::varchar[])`, [[parent, child], groupId]);
    await supervisor(child);
    const item = (await page()).items[0]!;
    expect(item.identity).toEqual({
      kind: "agent_group",
      source_id: groupId
    });
    expect(item.group).toBe("needs_you");
    expect(item.visible_run_count).toBe(2);
    expect((await loadWorks(db.pool, user, undefined, {
      space_id: space,
      identity: item.identity
    }))[0]!.visible_run_count).toBe(2);
  });
  it("counts a Run once when two plan nodes link it and a root match also exists", async () => {
    const id = await run(),
      {
        taskId,
        planId
      } = await plan([id, id], id);
    const result = await page(),
      item = result.items[0]!;
    expect(result.items).toHaveLength(1);
    expect(item.identity).toEqual({
      kind: "task",
      source_id: taskId
    });
    expect(item.visible_run_count).toBe(1);
    expect(item.runs).toHaveLength(1);
    expect(item.read_states).toHaveLength(1);
    expect(item.runs[0]!.plan_id).toBe(planId);
    const scoped = await repository().facts(user, {
      space_id: space,
      identity: item.identity
    });
    expect(scoped.runs).toHaveLength(1);
  });
  it("projects Plan child decisions into the source Task and makes it first", async () => {
    const parent = await run("running"),
      child = await run();
    await run("running");
    const {
      taskId
    } = await plan([child], parent);
    await supervisor(child);
    const item = (await page()).items[0]!;
    expect(item.identity).toEqual({
      kind: "task",
      source_id: taskId
    });
    expect(item.group).toBe("needs_you");
    expect(item.visible_run_count).toBe(2);
  });
  it("projects persisted automation provenance without generating another work", async () => {
    const id = await run(),
      automationId = await automation(id);
    await db.pool.query(`INSERT INTO automation_runs(id,automation_id,target_type,run_id,created_at)
      VALUES($1,$2,'agent_run',$3,now())`, [randomUUID(), automationId, id]);
    const item = (await page()).items[0]!;
    expect(item.visible_run_count).toBe(1);
    expect(item.runs[0]!.automation_id).toBe(automationId);
  });
  it("does not revive unread results superseded by a direct retry chain", async () => {
    const old = await run(),
      middle = await run(),
      latest = await run();
    const sessionId = await session([old, middle, latest]);
    for (const [id, predecessor] of [[middle, old], [latest, middle]]) {
      await db.pool.query(`UPDATE runs SET model_override_json=jsonb_build_object('chat_turn',jsonb_build_object('retry_of_run_id',$2::text)) WHERE id=$1`, [id, predecessor]);
    }
    const item = (await page()).items[0]!;
    expect(item.identity.source_id).toBe(sessionId);
    expect(item.read_states).toHaveLength(1);
    expect(item.read_states[0]!.subject).toMatchObject({
      run_id: latest
    });
    await changeReadState(db.pool, user, {
      identity: item.identity,
      space_id: space,
      subject: item.read_states[0]!.subject,
      state_version: 0,
      action: "read"
    });
    const read = (await page()).items[0]!;
    expect(read.unread).toBe(false);
    expect(read.read_states).toHaveLength(1);
    expect(read.runs.filter(run => run.retry_superseded).map(run => run.run_id).sort()).toEqual([old, middle].sort());
  });
});
describe("delegated children in their parent's conversation", () => {
  async function reply(id: string, sessionId: string, metadata = "{}") {
    const message = randomUUID();
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,role,sender_agent_id,content,metadata_json,run_id,path_depth,branch_path,created_at)
      SELECT $1,$2,$3,'assistant',agent_id,'Reply',$5::jsonb,id,1,'/',now() FROM runs WHERE id=$4`, [message, space, sessionId, id, metadata]);
    await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`, [sessionId, message]);
    return message;
  }
  it("reading or answering the parent's reply leaves a delegated child's own earlier result unread", async () => {
    const parent = await run(),
      child = await run();
    await delegation(parent, child);
    const sessionId = await session([parent, child]);
    await db.pool.query(`UPDATE run_attempts SET ended_at=now()-interval '1 minute' WHERE run_id=$1`, [child]);
    const message = await reply(parent, sessionId);
    const unread = async () => (await page()).items[0]!.read_states.filter(state => state.unread).map(state => state.subject.kind);
    expect((await page()).items[0]!.identity).toEqual({ kind: "session", source_id: sessionId });
    expect((await unread()).sort()).toEqual(["message", "run_result"]);
    await recordViews(db.pool, user, { space_id: space, session_id: sessionId, message_ids: [message] });
    expect(await unread()).toEqual(["run_result"]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,metadata_json,path_depth,branch_path,created_at)
      VALUES($1,$2,$3,$4,'user','Thanks','{}',2,'/',now()+interval '1 minute')`, [randomUUID(), space, sessionId, user]);
    expect(await unread()).toEqual(["run_result"]);
  });
  it("a delegated child's own question creates no personal reason", async () => {
    const parent = await run("running"),
      child = await run();
    await delegation(parent, child);
    const sessionId = await session([parent, child]);
    await reply(child, sessionId, '{"awaiting_answer":true}');
    const item = (await page()).items[0]!;
    expect(item.read_states.map(state => state.subject.kind)).toContain("message");
    expect(item.reasons.some(reason => reason.kind === "awaiting_answer")).toBe(false);
    expect(item.group).not.toBe("needs_you");
  });
});
describe("question recipient/branch causality", () => {
  it.each(["another Agent", "another branch"])("does not close a question after dispatch to %s", async scenario => {
    const id = await run(),
      dispatched = await run("queued"),
      sessionId = await session([id, dispatched]);
    const question = randomUUID(),
      reply = randomUUID();
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,role,sender_agent_id,content,metadata_json,run_id,path_depth,branch_path,created_at)
      SELECT $1,$2,$3,'assistant',agent_id,'Question','{"awaiting_answer":true}',id,1,'/',now() FROM runs WHERE id=$4`, [question, space, sessionId, id]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,role,user_id,content,parent_message_id,path_depth,branch_path,created_at)
      VALUES($1,$2,$3,'user',$4,'Reply',$5,2,$6,now())`, [reply, space, sessionId, user, question, scenario === "another branch" ? `/1:${reply}/` : "/"]);
    await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`, [sessionId, scenario === "another branch" ? question : reply]);
    if (scenario === "another branch") {
      await db.pool.query(`UPDATE runs d SET agent_id=q.agent_id,agent_version_id=q.agent_version_id,
        runtime_profile_id=q.runtime_profile_id,runtime_profile_snapshot_json=q.runtime_profile_snapshot_json
        FROM runs q WHERE d.id=$1 AND q.id=$2`, [dispatched, id]);
    }
    await db.pool.query(`UPDATE runs SET model_override_json=jsonb_build_object('chat_turn',jsonb_build_object('user_message_id',$2::text)) WHERE id=$1`, [dispatched, reply]);
    const item = (await page()).items[0]!;
    expect(item.group).toBe("needs_you");
    expect(item.reasons).toContainEqual(expect.objectContaining({
      kind: "awaiting_answer",
      message_id: question
    }));
  });
});
describe("cursor and source identifier isolation", () => {
  it("rejects a cursor after scope, Space, Project, group or history filters change", async () => {
    await run();
    await run();
    const first = await page({
      limit: 1
    });
    for (const changed of [{
      scope: "all_visible"
    }, {
      space_id: space
    }, {
      project_id: project
    }, {
      group: "recently_finished"
    }, {
      view: "history"
    }]) {
      await expect(page({
        ...changed,
        limit: 1,
        cursor: first.next_cursor
      })).rejects.toMatchObject({
        statusCode: 422
      });
    }
  });
  it("keeps a visible Run while hiding identifiers of its unreadable direct Session", async () => {
    const id = await run("running"),
      sessionId = await session([id]);
    const other = randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,email,status,registration_source,created_at,updated_at)
      VALUES($1,'Other',$2,'active','system',now(),now())`, [other, `${other}@test.invalid`]);
    await db.pool.query(`UPDATE sessions SET user_id=$2 WHERE id=$1`, [sessionId, other]);
    const result = await page();
    expect(result.counts.working).toBe(1);
    expect(result.items[0]!.identity).toEqual({
      kind: "run",
      source_id: id
    });
    expect(result.items[0]!.runs[0]).toMatchObject({
      session_id: null,
      room_id: null,
      delegation_id: null,
      run_group_id: null
    });
  });
});
describe("ten thousand persisted Runs", () => {
  it("measures SQL + projection + JSON end to end, while item/PATCH load only their work", async () => {
    const id = await run();
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      created_at,updated_at,execution_kind,ended_at)
      SELECT gen_random_uuid(),space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      created_at,updated_at,execution_kind,ended_at FROM runs CROSS JOIN generate_series(1,9999) WHERE id=$1`, [id]);
    const totals: number[] = [],
      itemTimes: number[] = [],
      patchTimes: number[] = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      const start = performance.now();
      const facts = await loadWorks(db.pool, user);
      const projectedAt = performance.now();
      const serializedCandidates = JSON.stringify(facts.map(item => boundWork(item)));
      const listed = await repository().page(facts.map(item => boundWork(item)), AgentAttentionQuerySchema.parse({
        view: "history"
      }), new Date().toISOString());
      const response = JSON.stringify(listed);
      totals.push(performance.now() - start);
      expect(Object.values(listed.counts).reduce((a, b) => a + b, 0)).toBe(10000);
      expect(AgentAttentionPageSchema.safeParse(JSON.parse(response)).success).toBe(true);
      const target = {
        space_id: space,
        identity: {
          kind: "run" as const,
          source_id: id
        }
      };
      const scopedFacts = await repository().facts(user, target);
      expect(scopedFacts.runs).toHaveLength(1);
      const itemStart = performance.now();
      const selected = findWork(await loadWorks(db.pool, user, undefined, target), space, target.identity);
      JSON.stringify(boundWork(selected));
      itemTimes.push(performance.now() - itemStart);
      const state = selected.read_states[0]!;
      const patchStart = performance.now();
      JSON.stringify(await changeReadState(db.pool, user, {
        ...target,
        subject: state.subject,
        state_version: state.state_version,
        action: iteration % 2 ? "unread" : "read"
      }));
      patchTimes.push(performance.now() - patchStart);
      console.info("Agent attention 10k sample", JSON.stringify({
        iteration,
        runs: facts.length,
        load_project_ms: projectedAt - start,
        list_sql_project_json_ms: totals.at(-1),
        candidate_json_bytes: Buffer.byteLength(serializedCandidates),
        response_bytes: Buffer.byteLength(response),
        target_loaded_runs: scopedFacts.runs.length,
        item_ms: itemTimes.at(-1),
        patch_ms: patchTimes.at(-1)
      }));
    }
    // Budget evidence is recorded, not a machine-speed-dependent pass criterion.
    expect(totals).toHaveLength(3);
  }, 60000);
});
describe("delegation into a visible conversation", () => {
  it("keeps a Session-less child under its visible parent's Session and promotes its decision", async () => {
    const parent = await run("running"),
      child = await run(),
      sessionId = await session([parent]);
    await delegation(parent, child);
    await supervisor(child);
    const item = (await page()).items[0]!;
    expect(item.identity).toEqual({
      kind: "session",
      source_id: sessionId
    });
    expect(item.group).toBe("needs_you");
    expect(item.visible_run_count).toBe(2);
    expect((await loadWorks(db.pool, user, undefined, {
      space_id: space,
      identity: item.identity
    }))[0]!.visible_run_count).toBe(2);
  });
});
describe("workflow and autonomy origin joins", () => {
  it("projects workflow execution/node provenance and a child decision without a duplicate work", async () => {
    const parent = await run("running"),
      child = await run(),
      automationId = await automation(parent);
    const asset = randomUUID(),
      version = randomUUID(),
      execution = randomUUID(),
      node = randomUUID();
    await db.pool.query(`INSERT INTO evolvable_assets(id,asset_type,asset_key,display_name,owner_scope_type,status,metadata_json,created_at,updated_at)
      VALUES($1,'workflow_template',$2,'Workflow','system','active','{}',now(),now())`, [asset, asset]);
    await db.pool.query(`INSERT INTO evolvable_asset_versions(id,asset_id,scope_type,version,status,source,content_hash,content_json,created_at,updated_at)
      VALUES($1,$2,'system',1,'approved','built_in','hash','{}',now(),now())`, [version, asset]);
    await db.pool.query(`INSERT INTO workflow_executions(id,space_id,automation_id,workflow_version_id,root_run_id,trigger_type,definition_json,responsible_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'manual','{}',$6,now(),now())`, [execution, space, automationId, version, parent, user]);
    await db.pool.query(`INSERT INTO workflow_execution_nodes(id,space_id,execution_id,node_key,node_kind,title,created_at,updated_at)
      VALUES($1,$2,$3,'child','agent','Child',now(),now())`, [node, space, execution]);
    await db.pool.query(`INSERT INTO workflow_execution_node_runs(id,space_id,node_id,run_id,created_at)
      VALUES($1,$2,$3,$4,now())`, [randomUUID(), space, node, child]);
    await db.pool.query(`UPDATE runs SET root_run_id=$2 WHERE id=$1`, [child, parent]);
    await supervisor(child);
    const item = (await page()).items[0]!;
    expect(item.identity.source_id).toBe(parent);
    expect(item.visible_run_count).toBe(2);
    expect(item.group).toBe("needs_you");
    expect(item.runs.every(run => run.workflow_execution_id === execution && run.automation_id === automationId)).toBe(true);
  });
  it("deduplicates two autonomy candidates pointing at one Run", async () => {
    const id = await run(),
      automationId = await automation(id),
      tick = randomUUID();
    await db.pool.query(`INSERT INTO autonomy_ticks(id,space_id,automation_id,coordinator_run_id,owner_user_id,mode,status,started_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'launch','succeeded',now(),now(),now())`, [tick, space, automationId, id, user]);
    const candidates = [randomUUID(), randomUUID()].sort();
    for (const candidate of candidates) {
      await db.pool.query(`INSERT INTO autonomy_candidates(id,space_id,owner_user_id,candidate_kind,candidate_key,status,first_seen_tick_id,last_seen_tick_id,launch_tick_id,run_id,discovered_at,created_at,updated_at)
        VALUES($1,$2,$3,'task',$1,'launched',$4,$4,$4,$5,now(),now(),now())`, [candidate, space, user, tick, id]);
    }
    const item = (await page()).items[0]!;
    expect(item.visible_run_count).toBe(1);
    expect(item.read_states).toHaveLength(1);
    expect(item.runs[0]!.autonomy_candidate_id).toBe(candidates[0]);
    expect(item.runs[0]!.autonomy_tick_id).toBe(tick);
  });
});

describe("dense Session target cost", () => {
  it.each([{ total: 10000, members: 200 }, { total: 2000, members: 2000 }])(
    "measures item/PATCH three times for $members Session members among $total Runs", async ({ total, members }) => {
      const id = await run();
      await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
        runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
        created_at,updated_at,execution_kind,ended_at)
        SELECT gen_random_uuid(),space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
        runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
        created_at,updated_at,execution_kind,ended_at FROM runs CROSS JOIN generate_series(1,$2::int) WHERE id=$1`, [id, total - 1]);
      const others = await db.pool.query<{ id: string }>(`SELECT id FROM runs WHERE space_id=$1 AND id<>$2 ORDER BY id LIMIT $3`, [space, id, members - 1]);
      const sessionId = await session([id, ...others.rows.map(row => row.id)]);
      const target = { space_id: space, identity: { kind: "session" as const, source_id: sessionId } };
      expect((await repository().facts(user, target)).runs).toHaveLength(members);
      for (let iteration = 0; iteration < 3; iteration++) {
        const start = performance.now();
        const selected = findWork(await loadWorks(db.pool, user, undefined, target), space, target.identity);
        JSON.stringify(boundWork(selected));
        const itemMs = performance.now() - start;
        const state = selected.read_states.find(state => state.subject.kind === "run_result" && state.subject.run_id === id)!;
        const patchStart = performance.now();
        JSON.stringify(await changeReadState(db.pool, user, { ...target, subject: state.subject,
          state_version: state.state_version, action: iteration % 2 ? "unread" : "read" }));
        console.info("Agent attention dense sample", JSON.stringify({ total, members, iteration, item_ms: itemMs, patch_ms: performance.now() - patchStart }));
      }
      // Diagnose the actual seed/frontier SQL, outside the pipeline timing.
      const traced: Queryable = { query: async <Row,>(sql: string, params?: readonly unknown[]) => {
        const result = await db.pool.query(sql, params as unknown[]);
        const explain = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params as unknown[]);
        const plan = explain.rows[0]["QUERY PLAN"][0];
        console.info("Agent attention frontier explain", JSON.stringify({ total, members,
          query: sql.includes("WITH candidates") ? "frontier" : "seed", plan }));
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      } };
      expect(await new AgentAttentionRepository(traced).targetRunIds(user, target)).toHaveLength(members);
      for (const [label, query, keys] of [
        ["session", "session_id=ANY($2::varchar[])", [sessionId]],
        ["retry", "model_override_json->'chat_turn'->>'retry_of_run_id'=ANY($2::text[])", [id]]
      ] as const) {
        const explain = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM runs WHERE space_id=$1 AND ${query}`, [space, keys]);
        console.info("Agent attention dense explain", JSON.stringify({ total, members, label, plan: explain.rows }));
      }
    }, 60000);
  it("keeps readable dependencies outside the target lineage and hides private dependencies", async () => {
    const id = await run("running"), dependency = await run(), hidden = await run();
    await privateRun(hidden);
    await db.pool.query(`UPDATE runs SET output_json=jsonb_build_object('waiting_for_results',jsonb_build_object('scope','runs','depends_on_run_ids',$2::jsonb)) WHERE id=$1`, [id, JSON.stringify([dependency, hidden])]);
    const target = { space_id: space, identity: { kind: "run" as const, source_id: id } };
    const all = (await repository().facts(user)).runs.find(run => run.id === id)!;
    const scoped = (await repository().facts(user, target)).runs[0]!;
    expect(scoped.dependency_run_ids).toEqual([dependency]);
    expect(scoped.dependency_run_ids).toEqual(all.dependency_run_ids);
  });
});
