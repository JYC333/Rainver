import pg from 'pg';
import {waitForBlockedBy} from './support/lockWait.js';
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { openAiChatResponse } from "./support/piAiHttp.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { __setNetworkRetryDelayForTests,__setProviderHttpClientForTests } from "../src/modules/providers/invocation/invocation.js";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { dailyReportsModule } from "../src/modules/dailyReports/index.js";
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {jobsModule} from '../src/modules/jobs/index.js';
import {requestDailyReport} from '../src/modules/dailyReports/runOperation.js';
import {registerDailyCaptureReportHandler} from '../src/modules/dailyReports/jobHandler.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import {withQueryableTransaction} from '../src/modules/routeUtils/common.js';
import type {DailyReportResult} from '../src/modules/dailyReports/service.js';
import { PgDailyReportSettingsRepository } from "../src/modules/dailyReports/repository.js";
import { buildDailyReportJobPayload } from "../src/modules/dailyReports/scheduler.js";
import { localDateNow } from "../src/modules/scheduler/localDay.js";

const SPACE = "da11da11-0000-4000-8000-000000000001";
const OWNER = "da11da11-0000-4000-8000-000000000002";
const PROJECT = "da11da11-0000-4000-8000-000000000003";
const PROVIDER = "da11da11-0000-4000-8000-000000000004";

const db = useTestDatabase(import.meta.filename);
const config = () => loadConfig({
  ...process.env,
  SERVER_DATABASE_URL: db.connectionUri,
  RAINVER_HOME: "/tmp/rainver-daily-reports-test",
  SERVER_DEBUG: "false",
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["source_connectors", "source_providers", "activity_records", "artifacts", "proposals", "model_provider_space_grants", "model_providers", "runs", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

afterEach(() => {
  __setProviderHttpClientForTests(null);
  __setNetworkRetryDelayForTests(null);
  __setAuthIdentityForTests(null);
});

async function request(localDate:string){return withQueryableTransaction(db.pool,tx=>requestDailyReport(tx,SPACE,OWNER,{local_date:localDate}));}
function worker(){const registry=new JobHandlerRegistry();registerDailyCaptureReportHandler(registry,config());return new JobWorker(new PgJobQueueRepository(db.pool),registry,'daily-test-worker',['daily_capture_report']);}
async function report(localDate:string):Promise<DailyReportResult>{
 const intent=await request(localDate);const processed=await worker().processOne();expect(processed).toMatchObject({status:'completed'});
 return (await new PgJobQueueRepository(db.pool).getJob(intent.job_id))!.result_json as unknown as DailyReportResult;
}

/** A default provider with a pool key, so the bounded report task reaches the scripted HTTP fake. */
async function seedProvider(): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`,
    [PROVIDER, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`,
    [randomUUID(), PROVIDER, SPACE, OWNER, now],
  );
  await resolveProviderCommandStore(config()).addPoolCredential(SPACE, OWNER, PROVIDER, { api_key: "test-daily-report-key" });
}

async function seedCapture(occurredAt: string): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO activity_records
       (id, space_id, user_id, owner_user_id, activity_type, title, content,
        payload_json, status, visibility, occurred_at, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'user_capture', 'Captured thought', 'The body of the thought.',
             '{}'::jsonb, 'raw', 'private', $4, $4, $4)`,
    [id, SPACE, OWNER, occurredAt],
  );
  return id;
}

function scriptedReport(body: Record<string, unknown>): void {
  __setProviderHttpClientForTests({
    fetch: async () => openAiChatResponse({
      choices: [{ message: { content: JSON.stringify({ report_title: "Day", overview: "Overview", ...body }) } }],
      model: "test-model",
      usage: {},
    }),
  });
}

async function countRows(table: string, where = ""): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE space_id=$1 ${where}`, [SPACE],
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("daily capture report Run ownership", () => {
  it("records an empty report intent without creating an Agent or calling a provider", async () => {
    if (!db.available) return;
    const first = await report("2026-09-10");
    expect(first).toMatchObject({ status: "skipped", capture_count: 0 });

    expect(await countRows("agents")).toBe(0);
    expect(await countRows("runs")).toBe(1);

    const second = await report("2026-09-11");
    expect(second.run_id).toBeTruthy();
    expect((await db.pool.query('SELECT status FROM runs')).rows).toEqual([{status:'cancelled'},{status:'cancelled'}]);
  });
});

describe("daily capture report persistence", () => {
  it("pays the provider once and keeps one report when a second generation starts while the first is at the provider", async () => {
    if (!db.available) return;
    await seedProvider();
    await seedCapture("2026-09-12T10:00:00.000Z");
    // A second admitted request joins the existing durable day intent while I/O runs.
    let overlapped: Promise<unknown> | null = null;
    let providerCalls = 0;
    __setProviderHttpClientForTests({
      fetch: async () => {
        providerCalls += 1;
        if (!overlapped) {
          overlapped = request("2026-09-12");
          await overlapped;
        }
        return openAiChatResponse({
          choices: [{ message: { content: JSON.stringify({ report_title: "Day", overview: "Overview" }) } }],
          model: "test-model",
          usage: {},
        });
      },
    });

    const first = await report("2026-09-12");
    const second = await overlapped!;
    expect(first).toMatchObject({ status: "succeeded" });
    expect(providerCalls).toBe(1);
    expect(await countRows("artifacts", "AND artifact_type='daily_capture_report'")).toBe(1);
    expect(second).toMatchObject({run_id:first.run_id,status:'running'});
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='daily_capture_report'")).rows).toHaveLength(1);
  });

  it("fills the daily proposal cap from the qualifying candidates, not from the first few", async () => {
    if (!db.available) return;
    await seedProvider();
    const capture = await seedCapture("2026-09-13T10:00:00.000Z");
    const settings = new PgDailyReportSettingsRepository(db.pool);
    await settings.update(SPACE, OWNER, {
      create_memory_proposals: true,
      create_experience_proposals: false,
      max_memory_proposals_per_day: 1,
      memory_confidence_threshold: 0.7,
    });
    const low = (title: string) => ({ title, content: title, memory_type: "preference", confidence: 0.5, source_activity_ids: [capture] });
    scriptedReport({
      memory_candidates: [
        low("Too uncertain"),
        low("Also too uncertain"),
        { title: "Confident", content: "Confident", memory_type: "preference", confidence: 0.95, source_activity_ids: [capture] },
        { title: "Over the cap", content: "Over", memory_type: "preference", confidence: 0.9, source_activity_ids: [capture] },
      ],
    });

    const result = await report("2026-09-13");
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result.memory_proposal_ids).toHaveLength(1);
    const proposals = await db.pool.query<{ title: string }>(
      `SELECT title FROM proposals WHERE space_id=$1 AND proposal_type='memory_create'`, [SPACE],
    );
    expect(proposals.rows.map((row) => row.title)).toEqual(["Confident"]);
  });
});

describe("daily capture report routes", () => {
  it("refuses a report list limit that is not a positive integer", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    const app = buildModuleServer(config(), [dailyReportsModule]);
    try {
      for (const limit of ["abc", "-1", "1.5", "0"]) {
        const response = await app.inject({ method: "GET", url: `/api/v1/daily-capture-report/reports?limit=${limit}` });
        expect(response.statusCode, limit).toBe(422);
      }
      const ok = await app.inject({ method: "GET", url: "/api/v1/daily-capture-report/reports?limit=5" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("daily capture report days", () => {
  it("reports only a complete day, defaulting to the last one in the configured timezone", async () => {
    if (!db.available) return;
    await new PgDailyReportSettingsRepository(db.pool).update(SPACE, OWNER, { timezone: "Asia/Shanghai" });
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    const app = buildModuleServer(config(), [dailyReportsModule]);
    try {
      const today = localDateNow("Asia/Shanghai");
      const early = await app.inject({ method: "POST", url: "/api/v1/daily-capture-report/run", payload: { local_date: today },headers:{"idempotency-key":randomUUID()} });
      expect(early.statusCode).toBe(422);
      expect(early.json().error.code).toBe("operation_invalid_input");
      // No captures on the default day: the run settles to "skipped" for the last complete day.
      const defaulted = await app.inject({ method: "POST", url: "/api/v1/daily-capture-report/run", payload: {},headers:{"idempotency-key":randomUUID()} });
      expect(defaulted.statusCode,defaulted.body).toBe(202);
      expect(defaulted.json().data).toMatchObject({ status: "queued" });
    } finally {
      await app.close();
    }
  });

  it("schedules the report on the slot's previous local day", () => {
    const setting = { id: "s", space_id: SPACE, user_id: OWNER, timezone: "Asia/Shanghai" } as Parameters<typeof buildDailyReportJobPayload>[0];
    // 09:00 in Shanghai on 2026-09-11 is 01:00 UTC.
    expect(buildDailyReportJobPayload(setting, "2026-09-11T01:00:00.000Z")).toMatchObject({ local_date: "2026-09-10", timezone: "Asia/Shanghai" });
  });
});

describe("daily capture report schedule", () => {
  it("keeps the schedule cursor when a report finishes", async () => {
    if (!db.available) return;
    const settings = new PgDailyReportSettingsRepository(db.pool);
    await settings.getOrCreate(SPACE, OWNER);
    // Enabled while a report that began with the schedule off was running.
    const enabled = await settings.update(SPACE, OWNER, { enabled: true, local_time: "09:00", timezone: "UTC" });
    expect(enabled.next_run_at).not.toBeNull();

    await settings.recordReportCompleted(SPACE, OWNER, "2026-09-10", "2026-09-10T12:00:00.000Z");

    const after = await settings.get(SPACE, OWNER);
    expect(after).toMatchObject({ next_run_at: enabled.next_run_at, last_report_date: "2026-09-10" });
  });
});

async function withReportApp(work:(app:ReturnType<typeof buildModuleServer>)=>Promise<void>){
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});const app=buildModuleServer(config(),[dailyReportsModule,jobsModule]);
 try{await work(app);}finally{await app.close();}
}
const runUrl='/api/v1/daily-capture-report/run';
it('commits the formal keyed Run/Job intent once, executes once, and rechecks withdrawn replay authority',async()=>{
 await seedProvider();await seedCapture('2026-09-12T10:00:00Z');scriptedReport({});
 await withReportApp(async app=>{
  const key=randomUUID(),send=()=>app.inject({method:'POST',url:runUrl,payload:{local_date:'2026-09-12'},headers:{'idempotency-key':key}});
  const first=await send();expect(first.statusCode,first.body).toBe(202);expect((await send()).json()).toEqual(first.json());
  expect(await countRows('runs')).toBe(1);expect(await countRows('jobs')).toBe(1);
  expect(await worker().processOne()).toMatchObject({status:'completed'});
  const run=first.json().data.run_id;
  expect((await db.pool.query('SELECT status,visibility FROM runs WHERE id=$1',[run])).rows[0]).toMatchObject({status:'succeeded',visibility:'private'});
  expect((await db.pool.query('SELECT visibility FROM artifacts WHERE run_id=$1',[run])).rows).toEqual([{visibility:'private'}]);
  expect((await send()).json()).toEqual(first.json());expect(await countRows('jobs')).toBe(1);
  await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
  expect((await send()).statusCode).toBe(404);
 });
});
it('rolls back Run, Job, settings and receipt together when admission audit fails at commit',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_daily_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_daily_admission AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_daily_admission()');
 try{await withReportApp(async app=>{
  const response=await app.inject({method:'POST',url:runUrl,payload:{local_date:'2026-09-12'},headers:{'idempotency-key':randomUUID()}});expect(response.statusCode,response.body).toBe(503);
  for(const table of ['runs','jobs'])expect(await countRows(table)).toBe(0);
  for(const table of ['settings','operation_idempotency'])expect((await db.pool.query(`SELECT id FROM ${table}`)).rows).toHaveLength(0);
 });}finally{await db.pool.query('DROP TRIGGER refuse_daily_admission ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_daily_admission()');}
});
for(const mutation of ['membership','claim','attempt','input'] as const)it(`refuses provider-derived daily results after ${mutation} changes during I/O`,async()=>{
 await seedProvider();const capture=await seedCapture('2026-09-12T10:00:00Z');await request('2026-09-12');
 __setProviderHttpClientForTests({fetch:async()=>{
  if(mutation==='membership')await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
  if(mutation==='claim')await db.pool.query("UPDATE jobs SET attempts=attempts+1,claimed_by='replacement' WHERE space_id=$1 AND job_type='daily_capture_report'",[SPACE]);
  if(mutation==='attempt')await db.pool.query("UPDATE runs SET provider_task_snapshot_id=NULL WHERE space_id=$1",[SPACE]);
  if(mutation==='input')await db.pool.query("UPDATE activity_records SET content='Changed after send' WHERE id=$1",[capture]);
  return openAiChatResponse({choices:[{message:{content:JSON.stringify({report_title:'Day',overview:'Must not persist',memory_candidates:[{title:'Never',content:'Never',memory_type:'semantic',confidence:1,source_activity_ids:[capture]}]})}}],model:'test-model',usage:{}});
 }});
 expect(await worker().processOne()).toMatchObject({status:'failed'});
 expect(await countRows('artifacts')).toBe(0);expect(await countRows('proposals')).toBe(0);expect(await countRows('memory_entries')).toBe(0);
 expect((await db.pool.query("SELECT id FROM runs WHERE space_id=$1 AND status='succeeded'",[SPACE])).rows).toHaveLength(0);
});
it('rolls provider results, proposals, Run terminal and Job settlement back on late execution audit failure',async()=>{
 await seedProvider();await seedCapture('2026-09-12T10:00:00Z');await request('2026-09-12');
 __setProviderHttpClientForTests({fetch:async()=>{
  await db.pool.query("CREATE FUNCTION refuse_daily_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM artifacts WHERE artifact_type='daily_capture_report') THEN RAISE EXCEPTION 'late daily audit unavailable'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_daily_result AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_daily_result()');
  return openAiChatResponse({choices:[{message:{content:JSON.stringify({report_title:'Day',overview:'Must roll back'})}}],model:'test-model',usage:{}});
 }});
 try{
  expect(await worker().processOne()).toMatchObject({status:'failed'});
  expect(await countRows('artifacts')).toBe(0);expect(await countRows('proposals')).toBe(0);
  expect((await db.pool.query("SELECT status FROM jobs WHERE job_type='daily_capture_report'")).rows).toEqual([{status:'failed'}]);
  expect((await db.pool.query('SELECT status FROM runs')).rows).toEqual([{status:'failed'}]);
 }finally{await db.pool.query('DROP TRIGGER IF EXISTS refuse_daily_result ON policy_decision_records');await db.pool.query('DROP FUNCTION IF EXISTS refuse_daily_result()');}
});
it('does not send a report after external egress is withdrawn and never blindly repeats an unknown intent',async()=>{
 await seedProvider();await seedCapture('2026-09-12T10:00:00Z');const intent=await request('2026-09-12');
 const {updateSpaceRetrievalSettings}=await import('../src/modules/retrieval/settings.js');
 await updateSpaceRetrievalSettings(db.pool,SPACE,{external_egress_enabled:false});
 let calls=0;__setProviderHttpClientForTests({fetch:async()=>{calls++;return openAiChatResponse({choices:[],model:'test-model',usage:{}});}});
 expect(await worker().processOne()).toMatchObject({status:'failed'});expect(calls).toBe(0);
 // Even if a queue operator reclaims a claim, an existing started intent cannot send twice.
 await db.pool.query("UPDATE jobs SET status='pending',claimed_by=NULL,attempts=0 WHERE id=$1",[intent.job_id]);
 expect(await worker().processOne()).toMatchObject({status:'failed'});expect(calls).toBe(0);expect(await countRows('artifacts')).toBe(0);
});
for(const stage of ['before_send','before_result'] as const)it(`rechecks Source consent ${stage} and withholds frozen text from generic Job views`,async()=>{
 const source=randomUUID();await seedArxivSourceChain(db.pool,{space:SPACE,owner:OWNER,connector:randomUUID(),connection:source,channel:randomUUID(),now:new Date().toISOString()});
 await db.pool.query("UPDATE source_connections SET policy_json=policy_json||'{\"allowed_import_targets\":[\"source_artifact\",\"memory_proposal\",\"knowledge\"]}'::jsonb WHERE id=$1",[source]);
 await seedProvider();const capture=await seedCapture('2026-09-12T10:00:00Z');
 await db.pool.query('UPDATE activity_records SET payload_json=$2::jsonb WHERE id=$1',[capture,JSON.stringify({source_connection_id:source})]);
 const intent=await request('2026-09-12');
 await withReportApp(async app=>{
  const view=await app.inject({method:'GET',url:`/api/v1/jobs/${intent.job_id}`});expect(view.statusCode,view.body).toBe(200);expect(view.json()).toMatchObject({payload:null,result:null,error:null});expect(view.body).not.toContain('The body of the thought');
 });
 const withdraw=()=>db.pool.query("UPDATE source_connections SET policy_json=policy_json||'{\"derived_write_policy\":\"disabled\"}'::jsonb WHERE id=$1",[source]);
 let calls=0;
 __setProviderHttpClientForTests({fetch:async()=>{calls++;await withdraw();return openAiChatResponse({choices:[{message:{content:JSON.stringify({report_title:'Day',overview:'No authority'})}}],model:'test-model',usage:{}});}});
 if(stage==='before_send')await withdraw();
 expect(await worker().processOne()).toMatchObject({status:'failed'});expect(calls).toBe(stage==='before_send'?0:1);
 expect(await countRows('artifacts')).toBe(0);expect(await countRows('proposals')).toBe(0);
});
it('ends the queued Run on canonical Job cancellation and refuses dispatch without a versioned intent',async()=>{
 const intent=await request('2026-09-12');
 await withReportApp(async app=>{
  const response=await app.inject({method:'POST',url:`/api/v1/jobs/${intent.job_id}/cancel`,payload:{},headers:{'idempotency-key':randomUUID()}});expect(response.statusCode,response.body).toBe(200);
 });
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[intent.run_id])).rows).toEqual([{status:'cancelled'}]);
 await new PgJobQueueRepository(db.pool).enqueue({job_type:'daily_capture_report',space_id:SPACE,user_id:OWNER,payload:{space_id:SPACE,user_id:OWNER,local_date:'2026-09-12'},max_attempts:1});
 expect(await worker().processOne()).toMatchObject({status:'failed'});expect(await countRows('runs')).toBe(1);expect(await countRows('artifacts')).toBe(0);
});
it('refuses a reclaimed unknown start even while its Run is still queued',async()=>{
 await seedProvider();await seedCapture('2026-09-12T10:00:00Z');const intent=await request('2026-09-12');
 await db.pool.query("UPDATE jobs SET result_json='{\"source_dispatch\":\"started\",\"effect_started\":true}'::jsonb WHERE id=$1",[intent.job_id]);
 let calls=0;__setProviderHttpClientForTests({fetch:async()=>{calls++;return openAiChatResponse({choices:[],model:'test-model',usage:{}});}});
 expect(await worker().processOne()).toMatchObject({status:'failed'});expect(calls).toBe(0);expect(await countRows('artifacts')).toBe(0);
});
it('rejects impossible calendar dates and undeclared execution fields before creating work',async()=>{
 await withReportApp(async app=>{
  for(const payload of [{local_date:'2026-02-31'},{run_id:'forged'},{attempts:2}]){
   const response=await app.inject({method:'POST',url:runUrl,payload,headers:{'idempotency-key':randomUUID()}});expect(response.statusCode,response.body).toBe(422);
  }
  expect(await countRows('runs')).toBe(0);expect(await countRows('jobs')).toBe(0);
 });
});
it('uses one canonical scheduled admission and refuses its disabled setting before spend',async()=>{
 const repo=new PgDailyReportSettingsRepository(db.pool);await repo.update(SPACE,OWNER,{enabled:true});
 await db.pool.query("UPDATE scheduler_tasks SET next_run_at=now()-interval '1 minute' WHERE space_id=$1 AND task_type='daily_capture_report'",[SPACE]);
 const {scanDailyReportsAndEnqueue}=await import('../src/modules/dailyReports/scheduler.js');
 expect(await scanDailyReportsAndEnqueue(config())).toBe(1);expect(await scanDailyReportsAndEnqueue(config())).toBe(0);
 expect(await countRows('runs')).toBe(1);expect(await countRows('jobs')).toBe(1);
 await repo.update(SPACE,OWNER,{enabled:false});
 expect(await worker().processOne()).toMatchObject({status:'failed'});expect(await countRows('artifacts')).toBe(0);
});

it('does not send again after a provider connection failure with an unknown outcome',async()=>{
 await seedProvider();await seedCapture('2026-09-12T10:00:00Z');await request('2026-09-12');
 __setNetworkRetryDelayForTests(async()=>undefined);
 let calls=0;__setProviderHttpClientForTests({fetch:async()=>{calls++;throw new TypeError('connection reset after dispatch');}});
 expect(await worker().processOne()).toMatchObject({status:'failed'});expect(calls).toBe(1);
 expect(await countRows('artifacts')).toBe(0);
 expect((await db.pool.query('SELECT status FROM runs')).rows).toEqual([{status:'failed'}]);
});

it('review regression: conflicts on active flags, reuses claimed work, and returns the completed business result',async()=>{
 const first=await request('2026-09-12');
 await expect(withQueryableTransaction(db.pool,tx=>requestDailyReport(tx,SPACE,OWNER,{local_date:'2026-09-12',create_memory_proposals:true}))).rejects.toMatchObject({statusCode:409});
 const queue=new PgJobQueueRepository(db.pool);const claimed=await queue.claimNext('review-claim',['daily_capture_report']);expect(claimed?.id).toBe(first.job_id);
 expect((await request('2026-09-12')).job_id).toBe(first.job_id);
 await db.pool.query("UPDATE jobs SET status='pending',claimed_by=NULL,attempts=0 WHERE id=$1",[first.job_id]);
 expect((await worker().processOne()).status).toBe('completed');
 const again=await request('2026-09-12');expect(again).toMatchObject({job_id:first.job_id,status:'completed',result:{status:'skipped'}});
 expect(await countRows('runs')).toBe(1);
});
it.each(['failed','cancelled'])('review regression: fresh Run after proven pre-send %s, with fresh settings and flags',async status=>{
 const first=await request('2026-09-12');
 await db.pool.query('UPDATE jobs SET status=$2 WHERE id=$1',[first.job_id,status]);
 await db.pool.query("UPDATE runs SET status=$2 WHERE id=$1",[first.run_id,status]);
 await new PgDailyReportSettingsRepository(db.pool).update(SPACE,OWNER,{create_memory_proposals:true});
 const next=await withQueryableTransaction(db.pool,tx=>requestDailyReport(tx,SPACE,OWNER,{local_date:'2026-09-12',create_memory_proposals:false}));
 expect(next.job_id).not.toBe(first.job_id);expect(next.run_id).not.toBe(first.run_id);
 expect((await new PgJobQueueRepository(db.pool).getJob(next.job_id))?.payload_json.snapshot).toMatchObject({input:{create_memory_proposals:false},setting:{create_memory_proposals:true}});
});
it('review regression: owner-proven failure before send can rerun; unknown and admitted sends cannot',async()=>{
 await seedCapture('2026-09-12T10:00:00Z');const first=await request('2026-09-12');
 // No provider: the real owner ends the invocation before its send gate.
 expect((await worker().processOne()).status).toBe('failed');
 expect((await new PgJobQueueRepository(db.pool).getJob(first.job_id))?.result_json).toMatchObject({daily_report_retry_safe:true});
 const second=await request('2026-09-12');expect(second.job_id).not.toBe(first.job_id);
 for(const marker of [{source_dispatch:'started'},{daily_report_send_admitted:true},{effect_started:true}]){
  await db.pool.query("UPDATE jobs SET status='failed',result_json=$2::jsonb WHERE id=$1",[second.job_id,JSON.stringify(marker)]);
  await expect(request('2026-09-12')).rejects.toMatchObject({statusCode:409});
 }
 expect(await countRows('runs')).toBe(2);
});
it.each(['consent','retention','changed_manual'])('review regression: %s refusal advances its schedule slot and the next day still runs',async kind=>{
 const repo=new PgDailyReportSettingsRepository(db.pool);await repo.update(SPACE,OWNER,{enabled:true});
 const capture=await seedCapture('2026-09-12T10:00:00Z');
 if(kind==='changed_manual'){
  await request('2026-09-12');await db.pool.query("UPDATE activity_records SET content='changed',updated_at=now() WHERE id=$1",[capture]);
 }else{
  const source={connectionId:randomUUID()};await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection:source.connectionId,channel:randomUUID(),space:SPACE,owner:OWNER,now:new Date().toISOString()});
  await db.pool.query('UPDATE activity_records SET payload_json=$2::jsonb WHERE id=$1',[capture,JSON.stringify({source_connection_ids:[source.connectionId]})]);
  if(kind==='retention')await db.pool.query("UPDATE source_connections SET policy_json=policy_json||'{\"derived_write_policy\":\"disabled\"}'::jsonb WHERE id=$1",[source.connectionId]);
  else await db.pool.query("UPDATE source_connections SET consent_json='{}'::jsonb WHERE id=$1",[source.connectionId]);
 }
 await db.pool.query("UPDATE scheduler_tasks SET next_run_at='2026-09-13T06:00:00Z' WHERE user_id=$1 AND task_type='daily_capture_report'",[OWNER]);
 const {scanDailyReportsAndEnqueue}=await import('../src/modules/dailyReports/scheduler.js');
 expect(await scanDailyReportsAndEnqueue(config())).toBe(0);
 const task=(await db.pool.query('SELECT next_run_at::text,state_json FROM scheduler_tasks WHERE user_id=$1',[OWNER])).rows[0];
 expect(task.next_run_at).toContain('2026-09-14');expect(task.state_json.last_slot_outcome.status).toBe('refused');
 expect(await scanDailyReportsAndEnqueue(config())).toBe(1);
 if(kind==='changed_manual')expect((await worker().processOne()).status).toBe('failed');
 expect((await worker().processOne()).status).toBe('completed');
});
it('review recovery: scheduler infrastructure failure keeps the same slot for a later retry',async()=>{
 const repo=new PgDailyReportSettingsRepository(db.pool);await repo.update(SPACE,OWNER,{enabled:true});
 await db.pool.query("UPDATE scheduler_tasks SET next_run_at='2026-09-13T06:00:00Z' WHERE space_id=$1 AND task_type='daily_capture_report'",[SPACE]);
 await db.pool.query("CREATE FUNCTION refuse_schedule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_schedule_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_schedule_audit()');
 const {scanDailyReportsAndEnqueue}=await import('../src/modules/dailyReports/scheduler.js');
 try{
  expect(await scanDailyReportsAndEnqueue(config())).toBe(0);expect(await countRows('jobs')).toBe(0);expect(await countRows('runs')).toBe(0);
  expect((await db.pool.query('SELECT next_run_at::text,state_json FROM scheduler_tasks WHERE user_id=$1',[OWNER])).rows[0]).toMatchObject({next_run_at:'2026-09-13 06:00:00+00',state_json:{}});
 }finally{await db.pool.query('DROP TRIGGER refuse_schedule_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_schedule_audit()');}
 expect(await scanDailyReportsAndEnqueue(config())).toBe(1);
});
it('review recovery: failed automation cannot pin old settings or captures on a fresh manual request',async()=>{
 const repo=new PgDailyReportSettingsRepository(db.pool);await repo.update(SPACE,OWNER,{enabled:true});
 const capture=await seedCapture('2026-09-12T10:00:00Z');
 const first=await withQueryableTransaction(db.pool,tx=>requestDailyReport(tx,SPACE,OWNER,{local_date:'2026-09-12'},'automation'));
 expect((await worker().processOne()).status).toBe('failed');
 await repo.update(SPACE,OWNER,{enabled:false});await db.pool.query("UPDATE activity_records SET content='Fresh capture',updated_at=now() WHERE id=$1",[capture]);
 const next=await request('2026-09-12');expect(next.job_id).not.toBe(first.job_id);
 expect((await new PgJobQueueRepository(db.pool).getJob(next.job_id))?.payload_json.snapshot).toMatchObject({triggerOrigin:'manual',setting:{enabled:false},captures:[{content:'Fresh capture'}]});
});

it.each(['gate','settlement','catch'] as const)('canonical cancelJob cannot deadlock daily %s',async stage=>{
 const intent=await request('2026-09-12');
 if(stage==='catch')await new PgDailyReportSettingsRepository(db.pool).update(SPACE,OWNER,{timezone:'Europe/London'});
 let reach!:(pid:number)=>void,release!:()=>void;
 const reached=new Promise<number>(resolve=>{reach=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
 const deadlocks:string[]=[];
 let seen=0,held=false;
 const original=pg.Client.prototype.query;
 // Delay only the result of an executed real PG Run lock. Cancellation still
 // executes the real repository, terminal owner, Job UPDATE and Run writer.
 type Query=(this:pg.Client,...args:unknown[])=>Promise<{rows:Record<string,unknown>[]} >;
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:unknown[]){
  const sql=typeof args[0]==='string'?args[0]:'';
  const result=(original as unknown as Query).apply(this,args);
  if(args.some(arg=>typeof arg==='function'))return result;
  return result.then(async value=>{
   const gate=sql.startsWith('SELECT status,owner_user_id,execution_kind,provider_task_control_id');
   const failure=sql.startsWith('SELECT provider_task_snapshot_id FROM runs');
   if(!held&&((stage==='catch'&&failure)||(stage!=='catch'&&gate&&++seen===(stage==='gate'?1:2)))){
    held=true;
    const pid=await (original as unknown as Query).call(this,'SELECT pg_backend_pid() AS pid');
    reach(pid.rows[0]!.pid as number);await resume;
   }
   return value;
  },error=>{if((error as {code?:string}).code==='40P01')deadlocks.push('40P01');throw error;});
 } as typeof original);
 let running:ReturnType<JobWorker['processOne']>|undefined,cancelling:Promise<boolean>|undefined;
 try{
  running=worker().processOne();
  await vi.waitUntil(()=>held,{timeout:10_000,interval:20});
  const pid=await reached;
  cancelling=new PgJobQueueRepository(db.pool).cancelJob(intent.job_id,null);
  // Old code: cancellation holds Job, waits on Run. Fixed: waits on Job.
  // Release only after PostgreSQL proves the wait against this exact backend.
  await waitForBlockedBy(db.pool,pid);release();
  await Promise.all([running,cancelling]);
  expect(deadlocks).toEqual([]);
  const job=await new PgJobQueueRepository(db.pool).getJob(intent.job_id);
  expect(stage==='gate'?['completed','cancelled']:[stage==='catch'?'failed':'completed']).toContain(job?.status);
  expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[intent.run_id])).rows[0]!.status).toBe(stage==='catch'?'failed':'cancelled');
  expect(await countRows('artifacts')).toBe(0);
 }finally{release();await Promise.allSettled([running,cancelling]);spy.mockRestore();}
});
