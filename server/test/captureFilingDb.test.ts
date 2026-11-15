import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {randomUUID} from 'node:crypto';
import {waitForBlockedBy} from './support/lockWait.js';
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { captureFilingModule } from "../src/modules/captureFiling/index.js";
import { CaptureFilingService } from "../src/modules/captureFiling/service.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { ContentAccessAuditService } from "../src/modules/contentAccess/audit.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgAnnotationRepository } from "../src/modules/reader/repository.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const CAPTURE = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["content_access_logs", "activity_records", "notes", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Owner', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system'),
            ($2, 'Stranger', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [OWNER, STRANGER],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Personal', 'personal', $3, now(), now()),
            ($2, 'Team', 'team', $3, now(), now())`,
    [PERSONAL, TEAM, OWNER],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('m-personal', $1, $3, 'owner', 'active', now(), now()),
            ('m-team-owner', $2, $3, 'member', 'active', now(), now()),
            ('m-team-stranger', $2, $4, 'member', 'active', now(), now())`,
    [PERSONAL, TEAM, OWNER, STRANGER],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'Team Project', 'active', $3, now(), now())`,
    [PROJECT, TEAM, OWNER],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  await db.pool.query(
    `INSERT INTO activity_records
       (id, space_id, user_id, owner_user_id, activity_type, title, content,
        payload_json, status, visibility, occurred_at, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'note', 'Captured thought', 'The body of the thought.',
             '{}'::jsonb, 'raw', 'private', now(), now(), now())`,
    [CAPTURE, PERSONAL, OWNER],
  );
});

function filing(): CaptureFilingService {
  return new CaptureFilingService(db.pool);
}

afterEach(() => __setAuthIdentityForTests(null));

describe("filing a personal capture into a Project (real Postgres)", () => {
  it("answers a malformed filing request as 422, not as a server error", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests({ spaceId: PERSONAL, userId: OWNER });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [captureFilingModule]);
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/me/filings", payload: { activity_id: CAPTURE } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({error:{code:'operation_invalid_input'}});
    } finally {
      await app.close();
    }
  });

  it("creates a new object in the target Space and leaves the capture as provenance", async () => {
    if (!db.available) return;
    const result = await filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    });

    expect(result.target_space_id).toBe(TEAM);
    expect(result.visibility).toBe("space_shared");

    const object = await db.pool.query(
      `SELECT space_id, primary_project_id, visibility FROM space_objects WHERE id = $1`,
      [result.object_id],
    );
    expect(object.rows[0]).toMatchObject({
      space_id: TEAM,
      primary_project_id: PROJECT,
      visibility: "space_shared",
    });

    // The capture is not copied or moved: it stays in the personal Space and
    // records where it went.
    const capture = await db.pool.query(
      `SELECT space_id, status, payload_json FROM activity_records WHERE id = $1`,
      [CAPTURE],
    );
    expect(capture.rows[0].space_id).toBe(PERSONAL);
    expect(capture.rows[0].status).toBe("processed");
    expect(capture.rows[0].payload_json.filed_into).toMatchObject({
      space_id: TEAM,
      project_id: PROJECT,
      object_id: result.object_id,
    });
  });

  it("refuses to file someone else's capture", async () => {
    if (!db.available) return;
    await expect(filing().file({
      userId: STRANGER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a target Project the caller cannot write", async () => {
    if (!db.available) return;
    // Out of the Space, the Project is not theirs to see either: absent.
    await db.pool.query(`DELETE FROM space_memberships WHERE space_id = $1 AND user_id = $2`, [TEAM, OWNER]);
    await expect(filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to file the same capture twice", async () => {
    if (!db.available) return;
    await filing().file({ userId: OWNER, activityId: CAPTURE, targetProjectId: PROJECT });
    await expect(filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("cross-person detail reads are audited (real Postgres)", () => {
  it("records a stranger's activity read but not the owner's own", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE activity_records SET visibility = 'space_shared', space_id = $2 WHERE id = $1`,
      [CAPTURE, TEAM],
    );
    const repository = new PgActivityRepository(db.pool);

    await repository.get({ spaceId: TEAM, userId: OWNER }, CAPTURE);
    const own = await db.pool.query(`SELECT count(*)::int AS n FROM content_access_logs`);
    expect(own.rows[0].n).toBe(0);

    await repository.get({ spaceId: TEAM, userId: STRANGER }, CAPTURE);
    const logs = await new ContentAccessAuditService(db.pool).listForOwner({
      spaceId: TEAM,
      resourceType: "activity",
      resourceId: CAPTURE,
      ownerUserId: OWNER,
      limit: 10,
      offset: 0,
    });
    expect(logs.items).toHaveLength(1);
    expect(logs.items[0]).toMatchObject({ viewer_user_id: STRANGER, access_type: "detail_read" });
  });
});

describe("annotations on a shared document stay personal (real Postgres)", () => {
  async function sharedNotebookId(): Promise<string> {
    const filed = await filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    });
    return filed.object_id;
  }

  function annotate(body: Record<string, unknown>) {
    return new PgAnnotationRepository(db.pool).createAnnotation(
      { spaceId: TEAM, userId: OWNER },
      {
        annotation_type: "comment",
        document_type: "research_notebook",
        quote_text: "the thought",
        anchor_json: {
          schema_version: 1,
          quote_text: "the thought",
          text_range: { start: 0, end: 11, unit: "utf16" },
          before_context: "",
          after_context: "",
        },
        ...body,
      },
    );
  }

  it("defaults a margin note to private even though the document is space_shared", async () => {
    if (!db.available) return;
    const documentId = await sharedNotebookId();

    const annotation = await annotate({ document_id: documentId, label: "I do not buy this" });

    expect(annotation.visibility).toBe("private");
    const stranger = await db.pool.query(
      `SELECT id FROM reader_annotations WHERE id = $1 AND ${"owner_user_id = $2"}`,
      [annotation.id, STRANGER],
    );
    expect(stranger.rows).toHaveLength(0);
  });

  it("lets the author opt in to sharing it", async () => {
    if (!db.available) return;
    const documentId = await sharedNotebookId();

    const annotation = await annotate({ document_id: documentId, visibility: "space_shared" });

    expect(annotation.visibility).toBe("space_shared");
  });

  it("refuses to make an annotation wider than the document it sits on", async () => {
    if (!db.available) return;
    const documentId = await sharedNotebookId();
    await db.pool.query(`UPDATE space_objects SET visibility = 'private' WHERE id = $1`, [documentId]);

    await expect(annotate({ document_id: documentId, visibility: "space_shared" }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
});


describe('keyed person filing admission',()=>{
 const payload={activity_id:CAPTURE,target_project_id:PROJECT};
 async function withApp(work:(app:ReturnType<typeof buildModuleServer>)=>Promise<void>){
  __setAuthIdentityForTests({spaceId:TEAM,userId:OWNER});
  const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[captureFilingModule,systemActionsModule]);
  try{await work(app);}finally{await app.close();}
 }
 const write=(app:ReturnType<typeof buildModuleServer>,key:string,body:object=payload,url='/api/v1/me/filings')=>app.inject({method:'POST',url,payload:body,headers:{'idempotency-key':key}});
 it('files across Spaces with canonical personal receipts and replays across transports',async()=>{
  await withApp(async app=>{
   const key=randomUUID(),first=await write(app,key);expect(first.statusCode,first.body).toBe(200);
   expect(first.json().data).toMatchObject({activity_id:CAPTURE,target_space_id:TEAM});
   const receipts=await db.pool.query('SELECT space_id,result_json FROM operation_idempotency');
   expect(receipts.rows).toHaveLength(1);expect(receipts.rows[0].space_id).toBe(PERSONAL);
   __setAuthIdentityForTests({spaceId:'unrelated-request-space',userId:OWNER});
   const replay=await write(app,key,payload,'/api/v1/actions/capture.file');expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual(first.json());
   expect((await db.pool.query('SELECT object_id FROM notes')).rows).toHaveLength(1);
   expect((await write(app,key,{...payload,title:'Changed'})).statusCode).toBe(422);
  });
 });
 it.each(['membership','account','capture'])('withholds cached output after current %s authority is withdrawn',async kind=>{
  await withApp(async app=>{
   const key=randomUUID();expect((await write(app,key)).statusCode).toBe(200);
   if(kind==='membership')await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[TEAM,OWNER]);
   else if(kind==='account')await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[OWNER]);
   else await db.pool.query('UPDATE activity_records SET owner_user_id=$2 WHERE id=$1',[CAPTURE,STRANGER]);
   expect((await write(app,key)).statusCode).toBe(404);
  });
 });
 it('does not use personal membership to authorize another Space destination',async()=>{
  await db.pool.query('DELETE FROM space_memberships WHERE space_id=$1 AND user_id=$2',[TEAM,OWNER]);
  await withApp(async app=>{
   const r=await write(app,randomUUID());expect(r.statusCode,r.body).toBe(404);
   expect((await db.pool.query('SELECT object_id FROM notes')).rows).toHaveLength(0);
   expect((await db.pool.query('SELECT status FROM activity_records WHERE id=$1',[CAPTURE])).rows[0].status).toBe('raw');
  });
 });
 it('rejects missing keys and unknown authority fields',async()=>{
  await withApp(async app=>{
   expect((await app.inject({method:'POST',url:'/api/v1/me/filings',payload})).statusCode).toBe(422);
   expect((await write(app,randomUUID(),{...payload,user_id:STRANGER})).statusCode).toBe(422);
  });
 });
 it('late mandatory audit failure rolls back Note, capture state and receipt',async()=>{
  await withApp(async app=>{
   await db.pool.query("CREATE FUNCTION refuse_filing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
   await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_filing_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_filing_audit()');
   const key=randomUUID();
   try{
    const r=await write(app,key);expect(r.statusCode,r.body).toBe(503);
    expect((await db.pool.query('SELECT object_id FROM notes')).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT status,payload_json FROM activity_records WHERE id=$1',[CAPTURE])).rows[0]).toMatchObject({status:'raw',payload_json:{}});
   }finally{await db.pool.query('DROP TRIGGER refuse_filing_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_filing_audit()');}
   expect((await write(app,key)).statusCode).toBe(200);
  });
 });
 it('a target membership revocation serializes with the real writer',async()=>{
  await withApp(async app=>{
   const hold=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
   try{
    await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await hold.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[TEAM,OWNER]);
    pending=write(app,randomUUID());await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');
    const r=await pending;expect(r.statusCode,r.body).toBe(404);expect((await db.pool.query('SELECT object_id FROM notes')).rows).toHaveLength(0);
   }finally{await hold.query('ROLLBACK');hold.release();await pending;}
  });
 });
});
