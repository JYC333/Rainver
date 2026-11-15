import {registerActivityUploadJob,ACTIVITY_UPLOAD_JOB} from '../src/modules/activity/uploadOperation.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {jobsModule} from '../src/modules/jobs/index.js';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { activityModule } from "../src/modules/activity/index.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgActivityConsolidationRepository } from "../src/modules/activity/consolidationRepository.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

// Real-Postgres coverage for what a capture may become: one set of proposals
// per record, an archived record staying archived, and an upload the request
// refuses leaving nothing on disk.

const SPACE = "ac11ac11-0000-4000-8000-000000000001";
const OWNER = "ac11ac11-0000-4000-8000-000000000002";
const PROJECT = "ac11ac11-0000-4000-8000-000000000003";
const owner = { spaceId: SPACE, userId: OWNER };

const db = useTestDatabase(import.meta.filename);
let rainverHome: string;

beforeAll(async () => {
  rainverHome = await mkdtemp(join(tmpdir(), "rainver-activity-upload-"));
});
afterAll(async () => {
  await rm(rainverHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(rainverHome, "storage", "uploads"), { recursive: true, force: true });
  if (!db.available) return;
  await resetTables(db.pool, ["proposals", "activity_records", "projects", "space_memberships", "users", "spaces"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

afterEach(() => __setAuthIdentityForTests(null));

async function capture(status: "raw" | "archived" = "raw"): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO activity_records
       (id, space_id, user_id, owner_user_id, activity_type, title, content,
        payload_json, status, visibility, occurred_at, created_at, updated_at, discarded_at)
     VALUES ($1, $2, $3, $3, 'user_capture', 'A thought', 'The body of the thought, worth keeping.',
             '{}'::jsonb, $4::text, 'private', now(), now(), now(), CASE WHEN $4::text = 'archived' THEN now() END)`,
    [id, SPACE, OWNER, status],
  );
  return id;
}

async function proposalCount(): Promise<number> {
  const result = await db.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM proposals WHERE space_id=$1`, [SPACE]);
  return Number(result.rows[0]?.count ?? "0");
}

describe("consolidating a capture (real Postgres)", () => {
  it("still commits a proposal when the derived retrieval index cannot be queried", async () => {
    const id = await capture();
    await db.pool.query(`ALTER TABLE retrieval_aliases RENAME TO unavailable_retrieval_aliases`);
    try {
      expect(await new PgActivityRepository(db.pool).consolidate(owner, id)).toHaveLength(1);
      expect(await proposalCount()).toBe(1);
      const second = await capture();
      const batch = await new PgActivityConsolidationRepository(db.pool).runPending({
        spaceId: SPACE, actingUserId: OWNER, batchLimit: 10, activityIds: [second],
      });
      expect(batch.activities_processed).toEqual([second]);
      expect(await proposalCount()).toBe(2);
      const row = await db.pool.query(`SELECT status FROM activity_records WHERE id=$1`, [id]);
      expect(row.rows[0]?.status).toBe("proposals_generated");
    } finally {
      await db.pool.query(`ALTER TABLE unavailable_retrieval_aliases RENAME TO retrieval_aliases`);
    }
  });
  it("commits at most one proposal across simultaneous direct and batch consolidation", async () => {
    if (!db.available) return;
    const id = await capture();
    const repository = new PgActivityRepository(db.pool);
    const results = await Promise.allSettled([
      repository.consolidate(owner, id),
      repository.consolidate(owner, id),
      new PgActivityConsolidationRepository(db.pool).runPending({ spaceId: SPACE, actingUserId: OWNER, batchLimit: 10, activityIds: [id] }),
    ]);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ statusCode: 409 });
    expect(await proposalCount()).toBe(1);
    const row = await db.pool.query(`SELECT status FROM activity_records WHERE id=$1`, [id]);
    expect(row.rows[0]?.status).toBe("proposals_generated");
  });
  it("generates one set of proposals however often consolidation is requested", async () => {
    if (!db.available) return;
    const activity = new PgActivityRepository(db.pool);
    const id = await capture();
    expect(await activity.consolidate(owner, id)).toHaveLength(1);
    await expect(activity.consolidate(owner, id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await proposalCount()).toBe(1);
  });

  it("leaves an archived capture archived", async () => {
    if (!db.available) return;
    const activity = new PgActivityRepository(db.pool);
    const id = await capture("archived");
    await expect(activity.consolidate(owner, id)).rejects.toMatchObject({ statusCode: 409 });
    const row = await db.pool.query<{ status: string }>(`SELECT status FROM activity_records WHERE id = $1`, [id]);
    expect(row.rows[0]?.status).toBe("archived");
    expect(await proposalCount()).toBe(0);
  });
});

function multipartBody(
  boundary: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; body: Buffer | string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename === undefined
      ? `Content-Disposition: form-data; name="${part.name}"`
      : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`;
    const lines = [`--${boundary}`, disposition];
    if (part.contentType) lines.push(`Content-Type: ${part.contentType}`);
    chunks.push(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`));
    chunks.push(typeof part.body === "string" ? Buffer.from(part.body) : part.body);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function storedUploadFiles(): Promise<string[]> {
  const stored = await readdir(join(rainverHome, "storage", "uploads"), { recursive: true }).catch(() => [] as string[]);
  return stored.filter((entry) => entry.includes("."));
}

describe("uploading a capture (real Postgres)", () => {
  it("writes nothing to disk for an upload it refuses", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const boundary = "----rainver-upload-test";
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "idempotency-key":randomUUID(), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { name: "kind", body: "photo" },
          { name: "file", filename: "a.bin", contentType: "application/octet-stream", body: "hello" },
        ]),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({error:{code:"operation_invalid_input"}});
      expect(await storedUploadFiles()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("stores a file capture with its own 25 MB budget, not the conversation image limit", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const boundary = "----rainver-upload-ok";
      const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "idempotency-key":randomUUID(), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { name: "kind", body: "file" },
          { name: "title", body: "Field notes" },
          { name: "note", body: "Taken on the ridge" },
          { name: "project_id", body: PROJECT },
          { name: "file", filename: "nested/../ridge.bin", contentType: "application/octet-stream", body: bytes },
        ]),
      });
      expect(response.statusCode,response.body).toBe(202);
      const receipt=response.json().data;
      expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(0);
      expect(await uploadWorker()).toEqual({status:'completed',job_id:receipt.job_id});
      const read=await app.inject({method:'GET',url:`/api/v1/activity/${receipt.activity_id}`});
      expect(read.statusCode,read.body).toBe(200);
      const body = read.json() as { title: string; content: string; source_type: string; project_id: string; metadata_json: Record<string, unknown> };
      expect(body.title).toBe("Field notes");
      expect(body.content).toBe("Taken on the ridge");
      expect(body.source_type).toBe("file_import");
      expect(body.project_id).toBe(PROJECT);
      expect(body.metadata_json).toMatchObject({
        capture_kind: "file",
        filename: "ridge.bin",
        mime_type: "application/octet-stream",
        size_bytes: bytes.length,
      });
      const stored = await storedUploadFiles();
      expect(stored).toHaveLength(1);
      expect(await readFile(join(rainverHome, "storage", "uploads", stored[0]!))).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  it("accepts a capture larger than the conversation image limit and refuses one past 25 MB", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const aboveImageLimit = Buffer.alloc(11 * 1024 * 1024, 7);
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "idempotency-key":randomUUID(), "content-type": "multipart/form-data; boundary=----rainver-11mb" },
        payload: multipartBody("----rainver-11mb", [
          { name: "kind", body: "file" },
          { name: "file", filename: "large.bin", contentType: "application/octet-stream", body: aboveImageLimit },
        ]),
      });
      expect(accepted.statusCode,accepted.body).toBe(202);
      const processed=await uploadWorker();expect(processed,JSON.stringify(processed)).toMatchObject({status:'completed'});
      const read=await app.inject({method:'GET',url:`/api/v1/activity/${accepted.json().data.activity_id}`});
      expect(read.json()).toMatchObject({ metadata_json: { size_bytes: aboveImageLimit.length } });

      const pastActivityLimit = Buffer.alloc(25 * 1024 * 1024 + 1, 9);
      const refused = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "idempotency-key":randomUUID(), "content-type": "multipart/form-data; boundary=----rainver-25mb" },
        payload: multipartBody("----rainver-25mb", [
          { name: "kind", body: "file" },
          { name: "file", filename: "too-big.bin", contentType: "application/octet-stream", body: pastActivityLimit },
        ]),
      });
      expect(refused.statusCode).toBe(413);
      expect(refused.json()).toMatchObject({ detail: "file exceeds 25 MB limit" });
    } finally {
      await app.close();
    }
  });

  it("refuses a body that is not multipart", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "idempotency-key":randomUUID(), "content-type": "application/json" },
        payload: { kind: "file" },
      });
      expect(response.statusCode).toBe(415);
      expect(await storedUploadFiles()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

async function uploadWorker(){
 const registry=new JobHandlerRegistry();registerActivityUploadJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}));
 return new JobWorker(new PgJobQueueRepository(db.pool),registry,randomUUID(),[ACTIVITY_UPLOAD_JOB]).processOne();
}
const uploadInput={kind:'file',filename:'a.bin',content_type:'application/octet-stream',content_base64:Buffer.from('private capture').toString('base64'),project_id:PROJECT};
it('keys formal multipart and generic upload identically, hides bytes in Jobs and refuses revoked replay',async()=>{
 __setAuthIdentityForTests(owner);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}),[activityModule,systemActionsModule,jobsModule]);
 const key=randomUUID(),boundary='upload-replay';
 const multipart=()=>app.inject({method:'POST',url:'/api/v1/activity/upload',headers:{'idempotency-key':key,'content-type':`multipart/form-data; boundary=${boundary}`},payload:multipartBody(boundary,[{name:'kind',body:'file'},{name:'project_id',body:PROJECT},{name:'file',filename:'a.bin',contentType:'application/octet-stream',body:'private capture'}])});
 try{
  const first=await multipart();expect(first.statusCode,first.body).toBe(202);
  const replay=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',headers:{'idempotency-key':key},payload:uploadInput});
  expect(replay.statusCode,replay.body).toBe(202);expect(replay.json()).toEqual(first.json());
  expect((await db.pool.query("SELECT id FROM jobs WHERE job_type=$1",[ACTIVITY_UPLOAD_JOB])).rows).toHaveLength(1);
  const jobRead=await app.inject({method:'GET',url:`/api/v1/jobs/${first.json().data.job_id}`});
  expect(jobRead.statusCode,jobRead.body).toBe(200);expect(jobRead.body).not.toContain(uploadInput.content_base64);
  expect(await uploadWorker()).toMatchObject({status:'completed'});
  expect((await multipart()).json()).toEqual(first.json());
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT payload_json FROM jobs WHERE id=$1',[first.json().data.job_id])).rows[0].payload_json.input).toBeUndefined();
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[PROJECT]);
  expect((await multipart()).statusCode).toBe(404);
 }finally{await app.close();}
});
it('requires an upload key, strict fields and canonical bytes before admitting work',async()=>{
 __setAuthIdentityForTests(owner);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}),[activityModule,systemActionsModule]);
 try{
  for(const payload of [uploadInput,{...uploadInput,stored_path:'forged'},{...uploadInput,content_base64:'Zh=='},{...uploadInput,kind:'photo'}]){
   const response=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',payload,headers:payload===uploadInput?{}:{'idempotency-key':randomUUID()}});
   expect(response.statusCode,response.body).toBe(422);
  }
  expect((await db.pool.query("SELECT id FROM jobs WHERE job_type=$1",[ACTIVITY_UPLOAD_JOB])).rows).toHaveLength(0);
  expect(await storedUploadFiles()).toEqual([]);
 }finally{await app.close();}
});
it('rolls admission and intent receipt back on mandatory upload audit failure',async()=>{
 __setAuthIdentityForTests(owner);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}),[activityModule,systemActionsModule]);
 await db.pool.query("CREATE FUNCTION refuse_upload_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_upload_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_upload_audit()');
 try{
  const response=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',payload:uploadInput,headers:{'idempotency-key':randomUUID()}});
  expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT id FROM jobs')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
  expect(await storedUploadFiles()).toEqual([]);
 }finally{await db.pool.query('DROP TRIGGER refuse_upload_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_upload_audit()');await app.close();}
});
it.each(['archive','membership','audit'])('withholds queued upload after initial %s refusal and clears input',async refusal=>{
 __setAuthIdentityForTests(owner);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}),[activityModule,systemActionsModule]);
 try{
  const first=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',payload:uploadInput,headers:{'idempotency-key':randomUUID()}});
  expect(first.statusCode,first.body).toBe(202);
  if(refusal==='archive')await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[PROJECT]);
  else if(refusal==='membership')await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
  else{
   await db.pool.query("CREATE FUNCTION refuse_upload_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'gate audit unavailable'; END $$");
   await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_upload_gate AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_upload_gate()');
  }
  const queue=new PgJobQueueRepository(db.pool),workerId=randomUUID();
  const job=(await queue.claimNext(workerId,[ACTIVITY_UPLOAD_JOB]))!;
  await queue.startJob(job.id,workerId);
  const registry=new JobHandlerRegistry();registerActivityUploadJob(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}));
  // Inspect handler cleanup before the generic worker's failure settlement.
  await expect(registry.dispatch({job_id:job.id,space_id:job.space_id,user_id:job.user_id,job_type:job.job_type,attempts:job.attempts,max_attempts:job.max_attempts,worker_id:workerId,payload:job.payload_json})).rejects.toThrow();
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(0);
  expect(await storedUploadFiles()).toEqual([]);
  expect((await new PgJobQueueRepository(db.pool).getJob(first.json().data.job_id))!.payload_json.input).toBeUndefined();
 }finally{if(refusal==='audit'){await db.pool.query('DROP TRIGGER IF EXISTS refuse_upload_gate ON policy_decision_records');await db.pool.query('DROP FUNCTION IF EXISTS refuse_upload_gate()');}await app.close();}
});
it('rolls domain Activity and Job completion back on late settlement audit failure and removes proven unreferenced storage',async()=>{
 __setAuthIdentityForTests(owner);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}),[activityModule,systemActionsModule]);
 const first=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',payload:uploadInput,headers:{'idempotency-key':randomUUID()}});
 expect(first.statusCode,first.body).toBe(202);
 // Admission/send checks precede the Activity. Only its settlement audit fails.
 await db.pool.query("CREATE FUNCTION refuse_upload_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM activity_records) THEN RAISE EXCEPTION 'late upload audit unavailable'; END IF; RETURN NEW; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_upload_settlement AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_upload_settlement()');
 try{
  expect(await uploadWorker()).toMatchObject({status:'failed'});
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[first.json().data.job_id])).rows[0].status).toBe('failed');
  expect(await storedUploadFiles()).toEqual([]);
  expect((await new PgJobQueueRepository(db.pool).getJob(first.json().data.job_id))!.payload_json.input).toBeUndefined();
 }finally{await db.pool.query('DROP TRIGGER refuse_upload_settlement ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_upload_settlement()');await app.close();}
});

for(const withdrawal of ['membership','claim','cancel'] as const)it(`refuses ${withdrawal} withdrawal after real upload I/O and leaves no domain result`,async()=>{
 __setAuthIdentityForTests(owner);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}),[activityModule,systemActionsModule]);
 const first=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',payload:uploadInput,headers:{'idempotency-key':randomUUID()}});
 expect(first.statusCode,first.body).toBe(202);
 const write=fsPromises.writeFile;let wrote=false;
 fsPromises.writeFile=async(...args:Parameters<typeof write>)=>{
  await write(...args);
  if(String(args[0]).includes('/storage/uploads/')){
   wrote=true;
   if(withdrawal==='membership')await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2",[SPACE,OWNER]);
   else if(withdrawal==='cancel')await new PgJobQueueRepository(db.pool).cancelJob(first.json().data.job_id,null);
   else await db.pool.query("UPDATE jobs SET claimed_by=$2 WHERE id=$1",[first.json().data.job_id,randomUUID()]);
  }
 };
 syncBuiltinESMExports();
 try{
  expect(await uploadWorker()).toMatchObject({status:'failed'});
  expect(wrote).toBe(true);
  const current=(await new PgJobQueueRepository(db.pool).getJob(first.json().data.job_id))!;
  if(withdrawal==='claim')expect(current.payload_json.input).toEqual(uploadInput);
  else expect(current.payload_json.input).toBeUndefined();
  if(withdrawal==='claim'){
   await db.pool.query("UPDATE jobs SET heartbeat_at=now()-interval '1 hour',updated_at=now()-interval '1 hour' WHERE id=$1",[current.id]);
   await new PgJobQueueRepository(db.pool).reclaimStuckJobs();
   expect((await new PgJobQueueRepository(db.pool).getJob(current.id))!.payload_json.input).toBeUndefined();
  }
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[first.json().data.job_id])).rows[0].status).not.toBe('completed');
  expect(await storedUploadFiles()).toEqual([]);
 }finally{fsPromises.writeFile=write;syncBuiltinESMExports();await app.close();}
});

it('queued cancellation removes only upload input and preserves replay metadata',async()=>{
 __setAuthIdentityForTests(owner);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome}),[activityModule,systemActionsModule,jobsModule]);
 try{
  const first=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',payload:uploadInput,headers:{'idempotency-key':randomUUID()}});
  expect(first.statusCode,first.body).toBe(202);
  const id=first.json().data.job_id,queue=new PgJobQueueRepository(db.pool),before=(await queue.getJob(id))!.payload_json;
  const cancelled=await app.inject({method:'POST',url:`/api/v1/jobs/${id}/cancel`,headers:{'idempotency-key':randomUUID()}});
  expect(cancelled.statusCode,cancelled.body).toBe(200);
  const {input,...metadata}=before;
  expect((await queue.getJob(id))!.payload_json).toEqual(metadata);
  expect(await uploadWorker()).toEqual({status:'idle'});
  expect((await db.pool.query('SELECT id FROM activity_records')).rows).toEqual([]);
  expect(await storedUploadFiles()).toEqual([]);
 }finally{await app.close();}
});

it.each(['pending','committed'] as const)('stale handler cleanup respects %s durable state',async state=>{
 __setAuthIdentityForTests(owner);
 const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:rainverHome});
 const app=buildModuleServer(config,[activityModule,systemActionsModule]);
 try{
  const first=await app.inject({method:'POST',url:'/api/v1/actions/activity.upload',payload:uploadInput,headers:{'idempotency-key':randomUUID()}});
  expect(first.statusCode,first.body).toBe(202);
  const queue=new PgJobQueueRepository(db.pool),id=first.json().data.job_id;
  const original=(await queue.getJob(id))!;
  if(state==='committed'){
   expect(await uploadWorker()).toMatchObject({status:'completed'});
   // Reproduce an uncertain old cleanup with a committed Activity and a
   // retained byte copy. File retention must not prevent independent scrubbing.
   await db.pool.query('UPDATE jobs SET payload_json=$2::jsonb WHERE id=$1',[id,JSON.stringify(original.payload_json)]);
  }
  const registry=new JobHandlerRegistry();registerActivityUploadJob(registry,config);
  await expect(registry.dispatch({job_id:id,space_id:SPACE,user_id:OWNER,job_type:ACTIVITY_UPLOAD_JOB,attempts:1,max_attempts:1,worker_id:randomUUID(),payload:original.payload_json})).rejects.toThrow();
  const current=(await queue.getJob(id))!;
  if(state==='pending'){
   expect(current.payload_json).toEqual(original.payload_json);
   expect((await db.pool.query('SELECT id FROM activity_records')).rows).toEqual([]);
   expect(await storedUploadFiles()).toEqual([]);
  }else{
   expect(current.payload_json.input).toBeUndefined();
   expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(1);
   const files=await storedUploadFiles();expect(files).toHaveLength(1);
   expect(await readFile(join(rainverHome,'storage','uploads',files[0]!))).toEqual(Buffer.from('private capture'));
  }
 }finally{await app.close();}
});
