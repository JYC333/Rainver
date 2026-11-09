import {seedResearchOperation} from './support/researchSeeds.js';
import {createResearchWorkflow} from '../src/modules/projectResearch/workflowOntology.js';
import {createBoundResearchOperation} from '../src/modules/projectResearch/researchProblemCalls.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SystemActionId } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceMember, seedRun, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { registerInquirySystemActionExecutors } from "../src/modules/inquiry/inquirySystemActionExecutors.js";
import { registerProjectResearchSystemActionExecutors } from "../src/modules/projectResearch/projectResearchSystemActionExecutors.js";
import type { SystemActionExecutor } from "../src/modules/systemActions/gateway.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

// An object's id reaches an Agent by being read from a tool result, never by
// being composed from a title: `inquiry.list_threads` and
// `research.list_operations` are those reads, and the actions they feed answer
// an invented id with the real ones. (`task.list` is covered in
// projectWorkActionsDb.test.ts, `proposal.list_pending` in roomsDb.suite.ts,
// each beside the actions they feed.)

const SPACE = "55555555-5555-4555-8555-555555555555";
// A real Agent row: the Project's account attributes an advancement to the
// Agent that made it, so the actor FK needs an Agent that exists.
const AGENT = "5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION = "5ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type ExecutorResult = { modelResult: Record<string, unknown>; summary: Record<string, unknown> };

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_work_events", "actors", "jobs", "agent_versions", "agents", "project_operation_links", "project_operation_steps", "project_operations", "inquiry_question_states", "inquiry_threads", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source) VALUES ($1, 'Owner', 'active', $2, $2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
});

const identity = () => ({ spaceId: SPACE, userId: OWNER });

async function executorsFor(projectId: string, instructedBy = OWNER): Promise<Map<SystemActionId, SystemActionExecutor>> {
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: await mkdtemp(join(tmpdir(), "rainver-list-threads-")) });
  const run = {
    id: randomUUID(), space_id: SPACE, agent_id: AGENT, project_id: projectId, run_group_id: null,
    instructed_by_user_id: instructedBy, trigger_origin: "manual", status: "running", visibility: "space_shared",
  } as unknown as RunRecord;
  const executors = new Map<SystemActionId, SystemActionExecutor>();
  registerInquirySystemActionExecutors(executors, config, run);
  registerProjectResearchSystemActionExecutors(executors, config, run);
  return executors;
}

async function coreCancelFor(projectId:string,instructedBy=OWNER) {
  const id=randomUUID();
  await seedRun(db.pool,{id,space:SPACE,owner:instructedBy,agent:AGENT,version:AGENT_VERSION,existingAgent:true});
  await db.pool.query("UPDATE runs SET status='running',project_id=$2,instructed_by_user_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1",[id,projectId,instructedBy,JSON.stringify({tool_grants:[{action_id:'research.cancel_acquisition'}]})]);
  const run=(await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1',[id])).rows[0];
  const transport=new CliAgentToolTransport(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  return async (operationId:string,extra:Record<string,unknown>={})=>transport.call(run,{id:randomUUID(),name:'research.cancel_acquisition',arguments:{operation_id:operationId,...extra}}) as Promise<{httpStatus:number;body:{error:{message:string;code:string}}}>;
}
async function researchRow(projectId:string,title:string,status='active') {
  const id=randomUUID();
  await db.pool.query("INSERT INTO project_operations(id,space_id,project_id,kind,title,status,created_by_user_id,progress_json,version,created_at,updated_at) VALUES($1,$2,$3,'research',$4,$5,$6,'{}'::jsonb,1,now(),now())",[id,SPACE,projectId,title,status,OWNER]);
  return id;
}

describe("the reads an Agent gets ids from (real Postgres)", () => {
  it("lists the Project's active Threads with the ids a later action must carry", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const threads = new InquiryThreadService(db.pool);
    const question = await threads.createThread(identity(), project.id as string, { kind: "question", statement: "How should agent memory be classified?" });
    const hypothesis = await threads.createThread(identity(), project.id as string, { kind: "hypothesis", statement: "Episodic/semantic is the useful split" });

    const executors = await executorsFor(project.id as string);
    const list = executors.get("inquiry.list_threads" as SystemActionId)!;
    const all = await list({}, { idempotency_key: "call-1" } as never) as ExecutorResult;
    expect((all.modelResult as { threads: unknown[] }).threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ thread_id: question.id, kind: "question", statement: "How should agent memory be classified?", attention_state: expect.any(String) }),
      expect.objectContaining({ thread_id: hypothesis.id, kind: "hypothesis", statement: "Episodic/semantic is the useful split", attention_state: expect.any(String) }),
    ]));
    expect(all.summary).toMatchObject({ tool_name: "inquiry.list_threads", ok: true, count: 2 });

    const questionsOnly = await list({ kind: "question" }, { idempotency_key: "call-2" } as never) as ExecutorResult;
    expect((questionsOnly.modelResult as { threads: Array<{ thread_id: string }> }).threads.map((t) => t.thread_id)).toEqual([question.id]);
  });

  it("answers an invented thread_id on research.start_acquisition with the ids that exist", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const question = await new InquiryThreadService(db.pool).createThread(identity(), project.id as string, { kind: "question", statement: "How should agent memory be classified?" });

    const start = (await executorsFor(project.id as string)).get("research.start_acquisition" as SystemActionId)!;
    await expect(start({ thread_id: "memory-classification" }, { idempotency_key: "call-3" } as never))
      .rejects.toThrow(`No active Question Thread has id 'memory-classification'. Read inquiry.list_threads for the complete paginated list. First matching ids: ${question.id} — How should agent memory be classified?`);
  });

  it("lists the Project's live research Operations, and answers an invented operation_id with them", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    const running = randomUUID();
    const finished = randomUUID();
    for (const [id, title, status] of [[running, "Acquisition: classification", "active"], [finished, "Earlier sweep", "completed"]]) {
      await db.pool.query(
        `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'research', $4, $5, $6, '{}'::jsonb, 1, now(), now())`,
        [id, SPACE, project.id, title, status, OWNER],
      );
    }
    const executors = await executorsFor(project.id as string);

    const live = await executors.get("research.list_operations" as SystemActionId)!({}, { idempotency_key: "call-4" } as never) as ExecutorResult;
    expect((live.modelResult as { operations: Array<{ operation_id: string; status: string }> }).operations)
      .toEqual([{ operation_id: running, title: "Acquisition: classification", status: "active" }]);

    const all = await executors.get("research.list_operations" as SystemActionId)!({ include_terminal: true }, { idempotency_key: "call-5" } as never) as ExecutorResult;
    expect((all.modelResult as { operations: Array<{ operation_id: string }> }).operations.map((operation) => operation.operation_id).sort())
      .toEqual([running, finished].sort());

    const cancel=await coreCancelFor(project.id as string);
    const missing=await cancel('classification-run');
    expect(missing.httpStatus).toBe(404);
    expect(missing.body.error.message).toBe(`No research Operation has id 'classification-run'. Use one of these ids exactly: ${running} — Acquisition: classification (active)`);
  });

  it("stops listing research Operations once the instructing person's Project membership is gone", async () => {
    if (!db.available) return;
    const MEMBER = "5ddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await seedSpaceMember(db.pool, { space: SPACE, user: MEMBER });
    const project = await new PgProjectRepository(db.pool).create(identity(), { name: "Agent memory" });
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, project.id, MEMBER],
    );
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, version, created_at, updated_at)
       VALUES ($1, $2, $3, 'research', 'Acquisition: classification', 'active', $4, '{}'::jsonb, 1, now(), now())`,
      [randomUUID(), SPACE, project.id, OWNER],
    );
    const executors = await executorsFor(project.id as string, MEMBER);
    const list = () => executors.get("research.list_operations" as SystemActionId)!({}, { idempotency_key: randomUUID() } as never) as Promise<ExecutorResult>;

    expect((await list()).modelResult).toMatchObject({ operations: [expect.objectContaining({ title: "Acquisition: classification" })] });

    // Revoked mid-Run: the Run goes on, this read does not.
    await db.pool.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [project.id, MEMBER]);
    await expect(list()).rejects.toMatchObject({ statusCode: 404 });
  });
});


describe('core cancellation discovery privacy',()=>{
  it('names no running operation when only completed operations exist',async()=>{
    const project=await new PgProjectRepository(db.pool).create(identity(),{name:'Current'});
    const terminal=await researchRow(project.id as string,'Finished','completed');
    const result=await (await coreCancelFor(project.id as string))('unknown');
    expect(result.httpStatus).toBe(404);expect(result.body.error.message).toContain('no research running');
    expect(JSON.stringify(result)).not.toContain(terminal);
  });
  it('never offers ids on cross-Project targets or mismatched caller Project hints',async()=>{
    const current=await new PgProjectRepository(db.pool).create(identity(),{name:'Current'}),other=await new PgProjectRepository(db.pool).create(identity(),{name:'Other'});
    const visible=await researchRow(current.id as string,'Current visible'),foreign=await researchRow(other.id as string,'Secret other');
    const otherSpace=randomUUID(),otherOwner=randomUUID(),otherProject=randomUUID(),foreignSpaceId=randomUUID();
    await seedSpaceOwnerProject(db.pool,{space:otherSpace,owner:otherOwner,project:otherProject});
    await seedResearchOperation(db.pool,{id:foreignSpaceId,space:otherSpace,project:otherProject,owner:otherOwner,progress:{},now:new Date().toISOString()});
    const cancel=await coreCancelFor(current.id as string);
    const outside=await cancel(foreignSpaceId),missing=await cancel(randomUUID());
    expect(outside.httpStatus).toBe(missing.httpStatus);
    expect(outside.body.error.message.replace(foreignSpaceId,'<target>')).toBe(missing.body.error.message.replace(/No research Operation has id '[^']*'/,"No research Operation has id '<target>'"));
    expect(outside.body.error.message).toContain(visible);
    for(const result of [await cancel(foreign),await cancel('unknown',{project_id:other.id}),await cancel(visible,{project_id:other.id})]) {
      expect(result.httpStatus).toBe(404);expect(result.body.error.message).toBe('operation not found');
      expect(JSON.stringify(result)).not.toContain(visible);expect(JSON.stringify(result)).not.toContain('Secret other');
    }
    expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[foreign])).rows[0].status).toBe('active');
  });
  it('withholds discovery after current Project permission or Run grant is revoked',async()=>{
    const member=randomUUID();await seedSpaceMember(db.pool,{space:SPACE,user:member});
    const project=await new PgProjectRepository(db.pool).create(identity(),{name:'Current'});
    await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),SPACE,project.id,member]);
    const visible=await researchRow(project.id as string,'Visible'),cancel=await coreCancelFor(project.id as string,member);
    expect((await cancel('unknown')).body.error.message).toContain(visible);
    await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project.id,member]);
    expect((await cancel('unknown')).body.error.message).toBe('operation not found');
    const ownerCancel=await coreCancelFor(project.id as string);
    await db.pool.query("UPDATE runs SET permission_snapshot_json='{}'::jsonb WHERE project_id=$1",[project.id]);
    expect((await ownerCancel('unknown')).body.error.message).toBe('operation not found');
  });
  it('filters private bound calls from hints and never offers hints for their existing ids',async()=>{
    const member=randomUUID();await seedSpaceMember(db.pool,{space:SPACE,user:member});
    const project=await new PgProjectRepository(db.pool).create(identity(),{name:'Current'});
    await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),SPACE,project.id,member]);
    const thread=await new InquiryThreadService(db.pool).createThread(identity(),project.id as string,{kind:'question',statement:'Private question'});
    await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1",[thread.id]);
    const visible=await researchRow(project.id as string,'Visible');
    const workflow=randomUUID(),key=randomUUID();
    await createResearchWorkflow(db.pool,{id:workflow,spaceId:SPACE,projectId:project.id as string,title:'Private workflow',status:'active',state:{},startedByUserId:OWNER,primaryThreadId:thread.id as string,now:new Date().toISOString()});
    const privateId=(await createBoundResearchOperation(db.pool,identity(),project.id as string,{title:'Private title',intentText:'Private investigation',status:'active',steps:[],progress:{schema_version:'project_research_operation.v1',workflow_id:workflow,thread_scope:[{thread_id:thread.id,version:1,kind:'question',statement:'Private question'}],idempotency:{key,fingerprint:key},history:{max_items:20},channel_ids:[]}})).id;
    const cancel=await coreCancelFor(project.id as string,member),missing=await cancel('unknown');
    expect(missing.body.error.message).toContain(visible);expect(JSON.stringify(missing)).not.toContain(privateId);expect(JSON.stringify(missing)).not.toContain('Private title');
    expect((await cancel(privateId)).body.error.message).toBe('operation not found');
  });
});
