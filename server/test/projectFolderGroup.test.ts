import {createHash, randomUUID} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { seedServerHost, seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { projectFolderExecutionConfigsModule } from "../src/modules/projectFolderExecutionConfigs/index.js";
import { projectFoldersModule } from "../src/modules/projectFolders/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { waitForLockWaiter } from "./support/lockWait.js";
import { projectsModule } from "../src/modules/projects/index.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

describe("projectFolderExecutionConfigsDb", () => {
  // Real-Postgres coverage for the Project Folder Execution Config routes:
  // CRUD against the real table, Folder existence gating, and space isolation.

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PROJECT = "33333333-3333-4333-8333-333333333333";
  const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";
  const FOLDER = "44444444-4444-4444-8444-444444444444";
  const HOST = "66666666-6666-4666-8666-666666666666";

  let app: FastifyInstance | undefined;
  afterAll(async()=>{await app?.close();});

  const db = useTestDatabase(`${import.meta.filename}#projectFolderExecutionConfigsDb`);

  beforeAll(async () => {
    if (!db.available) return;
    app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [projectFolderExecutionConfigsModule, projectFoldersModule, projectsModule, systemActionsModule]);
  });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["project_folder_execution_configs", "workspace_locations", "project_folders", "projects", "users", "spaces", "hosts", "machines"],
      { cascade: true },
    );
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1, 'User', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system'),
              ($2, 'Viewer', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
      [USER, VIEWER],
    );
    await seedServerHost(db.pool, { id: HOST });
    for (const spaceId of [SPACE, OTHER_SPACE]) {
      await db.pool.query(
        `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
         VALUES ($1, 'Space', 'household', $2, now(), now())`,
        [spaceId, USER],
      );
      await db.pool.query(
        `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
         VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
        [spaceId, USER],
      );
    }
    await db.pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
       VALUES ($1,$2,$3,'Project','active',now(),now()),
              ($4,$2,$3,'Other Project','active',now(),now())`,
      [PROJECT, SPACE, USER, OTHER_PROJECT],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status, kind, is_primary, protected, system_managed, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Folder','active','code',true,false,false,now(),now())`,
      [FOLDER, SPACE, PROJECT, USER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         execution_ready, status, created_at, updated_at
       ) VALUES (gen_random_uuid()::varchar,$1,$2,$3,'server',true,'active',now(),now())`,
      [SPACE, FOLDER, HOST],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, 'member', 'active', now(), now())`,
      [SPACE, VIEWER],
    );
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'viewer', 'active', now(), now())`,
      [SPACE, PROJECT, VIEWER],
    );
  });

  describe("project folder execution config routes", () => {
    it("404s before creation, then creates/reads/updates in real Postgres", async (ctx) => {
      if (!db.available || !db.pool || !app) return ctx.skip();
      __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });

      const missing = await app!.inject({
        method: "GET",
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      });
      expect(missing.statusCode).toBe(404);

      const created = await app!.inject({
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
        payload: { repo_type: "node", test_commands_json: ["npm test"] },
      });
      expect(created.statusCode).toBe(201);
      const createdBody = created.json();
      expect(createdBody.data.folder_id).toBe(FOLDER);
      expect(created.body).not.toContain('npm test');

      const fetched = await app!.inject({
        method: "GET",
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().repo_type).toBe("node");

      const updated = await app!.inject({
        method: "PATCH",
        headers: { "idempotency-key": randomUUID() },
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
        payload: { repo_type: "python" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data.folder_id).toBe(FOLDER);
      const current=await app!.inject({method:'GET',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`});
      expect(current.json()).toMatchObject({repo_type:'python',test_commands_json:['npm test']});

      const row = await db.pool.query(
        `SELECT space_id, project_folder_id FROM project_folder_execution_configs WHERE project_folder_id = $1`,
        [FOLDER],
      );
      expect(row.rows[0]).toEqual({ space_id: SPACE, project_folder_id: FOLDER });
    });

    it("rejects creation against a Folder outside the caller's space", async (ctx) => {
      if (!db.available || !db.pool || !app) return ctx.skip();
      __setAuthIdentityForTests({ spaceId: OTHER_SPACE, userId: USER });
      const response = await app!.inject({
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    });

    it("isolates reads across spaces", async (ctx) => {
      if (!db.available || !db.pool || !app) return ctx.skip();
      __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
      await app!.inject({
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
        payload: {},
      });

      __setAuthIdentityForTests({ spaceId: OTHER_SPACE, userId: USER });
      const crossSpace = await app!.inject({
        method: "GET",
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      });
      expect(crossSpace.statusCode).toBe(404);
    });

    it("allows Project viewers to read but not mutate execution config", async (ctx) => {
      if (!db.available || !app) return ctx.skip();
      __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
      await app.inject({
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
        payload: {},
      });

      __setAuthIdentityForTests({ spaceId: SPACE, userId: VIEWER });
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      });
      expect(read.statusCode).toBe(200);

      const update = await app.inject({
        method: "PATCH",
        headers: { "idempotency-key": randomUUID() },
        url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
        payload: { repo_type: "python" },
      });
      expect(update.statusCode).toBe(404);
    });

    it("rejects a Folder that belongs to another Project in the route", async (ctx) => {
      if (!db.available || !app) return ctx.skip();
      __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
      const response = await app.inject({
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        url: `/api/v1/projects/${OTHER_PROJECT}/folders/${FOLDER}/execution-config`,
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    });
  });
  describe('Project Folder operation authority',()=>{
    const call=(id:string,input:object,key=randomUUID())=>app!.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
    beforeEach(()=>{__setAuthIdentityForTests({spaceId:SPACE,userId:USER});});
    it('replays metadata changes across entries, preserves archived cleanup and does not repeat primary changes',async()=>{
      if(!db.available)return;
      const other=randomUUID();await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,status,kind,is_primary,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'Other','active','code',false,false,false,now(),now())",[other,SPACE,PROJECT]);
      const key=randomUUID(),body={project_id:PROJECT,folder_id:other,is_primary:true,name:'Current Folder'};
      const first=await call('project.folder.update',body,key);expect(first.statusCode,first.body).toBe(200);expect(first.body).not.toContain('Current Folder');
      const replay=await app!.inject({method:'PATCH',url:`/api/v1/projects/${PROJECT}/folders/${other}`,payload:{is_primary:true,name:'Current Folder'},headers:{'idempotency-key':key}});expect(replay.json()).toEqual(first.json());
      expect((await call('project.folder.update',{project_id:PROJECT,folder_id:FOLDER,is_primary:true})).statusCode).toBe(200);
      expect((await call('project.folder.update',body,key)).json()).toEqual(first.json());
      expect((await db.pool.query('SELECT id FROM project_folders WHERE project_id=$1 AND is_primary=true',[PROJECT])).rows).toEqual([{id:FOLDER}]);
      await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[PROJECT]);
      expect((await call('project.folder.archive',{project_id:PROJECT,folder_id:other})).statusCode).toBe(200);
      expect((await call('project.folder.update',{project_id:PROJECT,folder_id:other,description:'Archived cleanup'})).statusCode).toBe(200);
      expect((await call('project.folder.execution_config.create',{project_id:PROJECT,folder_id:other})).statusCode).toBe(409);
    });
    it('shares execution configuration keys, rejects duplicate new intents and rolls updates back on required audit failure',async()=>{
      if(!db.available)return;
      const key=randomUUID(),body={project_id:PROJECT,folder_id:FOLDER,repo_type:'node',test_commands_json:['npm test']};
      const created=await call('project.folder.execution_config.create',body,key);expect(created.statusCode,created.body).toBe(201);
      const replay=await app!.inject({method:'POST',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,payload:{repo_type:'node',test_commands_json:['npm test']},headers:{'idempotency-key':key}});expect(replay.json()).toEqual(created.json());
      expect((await call('project.folder.execution_config.create',body)).statusCode).toBe(409);
      await db.pool.query("CREATE FUNCTION refuse_folder_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE audit failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_folder_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_folder_audit()');
      try{const failed=await call('project.folder.execution_config.update',{project_id:PROJECT,folder_id:FOLDER,repo_type:'python'});expect(failed.statusCode,failed.body).toBe(503);expect(failed.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT repo_type FROM project_folder_execution_configs WHERE project_folder_id=$1',[FOLDER])).rows).toEqual([{repo_type:'node'}]);}
      finally{await db.pool.query('DROP TRIGGER refuse_folder_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_folder_audit()');}
    });
    it('activates the exact candidate once and replays after it is no longer stale',async()=>{
      if(!db.available)return;
      const location=randomUUID();await db.pool.query("INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'server',true,'stale',now(),now())",[location,SPACE,FOLDER,HOST]);
      const key=randomUUID(),body={project_id:PROJECT,folder_id:FOLDER,location_id:location},activated=await call('project.folder.location.activate',body,key);expect(activated.statusCode,activated.body).toBe(200);
      expect((await call('project.folder.location.activate',body,key)).json()).toEqual(activated.json());
      expect((await call('project.folder.location.activate',body)).statusCode).toBe(409);
      expect((await db.pool.query("SELECT id FROM workspace_locations WHERE project_folder_id=$1 AND status='active'",[FOLDER])).rows).toEqual([{id:location}]);
    });
    it('revalidates writer membership after waiting and atomically rolls archive back on receipt failure',async()=>{
      if(!db.available)return;
      await db.pool.query("UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",[PROJECT,VIEWER]);__setAuthIdentityForTests({spaceId:SPACE,userId:VIEWER});
      const holder=await db.pool.connect();try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[PROJECT]);let settled=false;const pending=call('project.folder.archive',{project_id:PROJECT,folder_id:FOLDER}).finally(()=>{settled=true;});await waitForLockWaiter(db.pool,{settled:()=>settled});await holder.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[PROJECT,VIEWER]);await holder.query('COMMIT');expect((await pending).statusCode).toBe(404);}finally{await holder.query('ROLLBACK');holder.release();}
      __setAuthIdentityForTests({spaceId:SPACE,userId:USER});
      await db.pool.query("CREATE FUNCTION refuse_folder_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE receipt failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_folder_receipt BEFORE INSERT OR UPDATE ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_folder_receipt()');
      try{const failed=await call('project.folder.archive',{project_id:PROJECT,folder_id:FOLDER});expect(failed.statusCode,failed.body).toBe(500);expect((await db.pool.query('SELECT status FROM project_folders WHERE id=$1',[FOLDER])).rows).toEqual([{status:'active'}]);}
      finally{await db.pool.query('DROP TRIGGER refuse_folder_receipt ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_folder_receipt()');}
    });
  });

  describe('private draft and unregister commands',()=>{
    const call=(id:string,input:object,key=randomUUID())=>app!.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
    const target={project_id:PROJECT,folder_id:FOLDER};
    const body=(content='PRIVATE recovery text',expected_version:number|null=null)=>({target_kind:'new',relative_path:'private.txt',base_exists:false,base_sha256:null,content,content_sha256:createHash('sha256').update(content).digest('hex'),byte_size:Buffer.byteLength(content,'utf8'),source_encoding:'utf8',preserve_bom:false,line_ending_mode:'none',expected_version});
    const upsert=(content='PRIVATE recovery text',expected:number|null=null,key=randomUUID())=>call('project.folder.draft.upsert',{...target,...body(content,expected)},key);
    it('shares all four Folder IO adapters with core receipts and keeps source bodies outside readable channels',async()=>{
      if(!db.available)return;
      const draft=(await upsert()).json().data.id,location=(await db.pool.query<{id:string}>('SELECT id FROM workspace_locations WHERE project_folder_id=$1',[FOLDER])).rows[0]!.id,revision=randomUUID();
      await db.pool.query("INSERT INTO project_file_revisions(id,space_id,project_id,project_folder_id,workspace_location_id,path,before_exists,before_content,after_exists,after_sha256,created_by_user_id,created_at,expires_at,status) VALUES($1,$2,$3,$4,$5,'other.txt',true,'PRIVATE revision body',true,NULL,$6,now(),now()+interval '1 day','available')",[revision,SPACE,PROJECT,FOLDER,location,USER]);
      const cases=[
        {operation:'project.folder.create',url:`/api/v1/projects/${PROJECT}/folders`,payload:{name:'Queued Folder'},input:{project_id:PROJECT,name:'Queued Folder'}},
        {operation:'project.folder.scan',url:`/api/v1/projects/${PROJECT}/folders/scan`,payload:{},input:{project_id:PROJECT}},
        {operation:'project.folder.draft.save',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/file/draft/save`,payload:{draft_id:draft,draft_version:1},input:{...target,draft_id:draft,draft_version:1}},
        {operation:'project.folder.revision.restore',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/file/revisions/restore-as-draft`,payload:{revision_id:revision},input:{...target,revision_id:revision}},
      ];
      for(const test of cases){
        const key=randomUUID(),accepted=await app!.inject({method:'POST',url:test.url,payload:test.payload,headers:{'idempotency-key':key}});
        expect(accepted.statusCode,accepted.body).toBe(202);expect(accepted.body).not.toContain('PRIVATE');
        expect((await call(test.operation,test.input,key)).json()).toEqual(accepted.json());
        expect((await app!.inject({method:'POST',url:test.url,payload:{...test.payload,project_id:PROJECT},headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(422);
        const statusUrl=`/api/v1/projects/${PROJECT}/folder-io/${accepted.json().data.id}`,status=await app!.inject({method:'GET',url:statusUrl});
        expect(status.statusCode,status.body).toBe(200);expect(status.json()).toMatchObject({status:'pending',result:null});expect(status.body).not.toContain('PRIVATE');
        __setAuthIdentityForTests({spaceId:SPACE,userId:VIEWER});expect((await app!.inject({method:'GET',url:statusUrl})).statusCode).toBe(404);__setAuthIdentityForTests({spaceId:SPACE,userId:USER});
      }
      const jobs=(await db.pool.query("SELECT payload_json FROM jobs WHERE job_type='project_folder_io'")).rows;expect(jobs).toHaveLength(4);for(const job of jobs)expect(Object.keys(job.payload_json)).toEqual(['intent_id']);
      expect(JSON.stringify((await db.pool.query('SELECT result_json,frozen_json FROM operation_idempotency')).rows)).not.toContain('PRIVATE');
      expect((await db.pool.query('SELECT id FROM project_folders')).rows).toEqual([{id:FOLDER}]);
    });
    it.each(['project_folder_io_intents','jobs','policy_decision_records'])('rolls IO intent, required Job and receipt back on %s failure',async table=>{
      if(!db.available)return;
      await db.pool.query("CREATE FUNCTION refuse_folder_io() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE IO failure'; END $$");await db.pool.query(`CREATE TRIGGER refuse_folder_io BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_folder_io()`);
      try{
        const failed=await call('project.folder.create',{project_id:PROJECT,name:'Queued'});expect(failed.statusCode,failed.body).toBe(table==='policy_decision_records'?503:500);expect(failed.body).not.toContain('PRIVATE');
        for(const name of ['project_folder_io_intents','jobs','operation_idempotency'])expect((await db.pool.query(`SELECT id FROM ${name}`)).rows).toEqual([]);
      }finally{await db.pool.query(`DROP TRIGGER refuse_folder_io ON ${table}`);await db.pool.query('DROP FUNCTION refuse_folder_io()');}
    });
    beforeEach(()=>{__setAuthIdentityForTests({spaceId:SPACE,userId:USER});});
    it('shares upsert and rebase keys without caching content, and reads only the owning private draft',async()=>{
      if(!db.available)return;
      const key=randomUUID(),first=await app!.inject({method:'PUT',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/file/draft`,payload:body(),headers:{'idempotency-key':key}});
      expect(first.statusCode,first.body).toBe(200);expect(first.body).not.toContain('PRIVATE');
      const id=first.json().data.id;expect(first.json().data.version).toBe(1);
      expect((await upsert('PRIVATE recovery text',null,key)).json()).toEqual(first.json());
      expect((await upsert('Changed input',null,key)).statusCode).toBe(422);
      const rebaseKey=randomUUID(),rebased=await app!.inject({method:'POST',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/file/draft/rebase`,payload:body('PRIVATE current text',1),headers:{'idempotency-key':rebaseKey}});
      expect(rebased.statusCode,rebased.body).toBe(200);expect(rebased.json().data.version).toBe(2);
      expect((await upsert('PRIVATE current text',1,rebaseKey)).json()).toEqual(rebased.json());
      expect((await upsert('PRIVATE recovery text',null,key)).json()).toEqual(first.json());
      const read=await app!.inject({method:'GET',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/file/drafts/${id}`});expect(read.statusCode,read.body).toBe(200);expect(read.json()).toMatchObject({content:'PRIVATE current text',version:2});
      expect(JSON.stringify((await db.pool.query('SELECT result_json,frozen_json FROM operation_idempotency')).rows)).not.toContain('PRIVATE');
      await db.pool.query("UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",[PROJECT,VIEWER]);__setAuthIdentityForTests({spaceId:SPACE,userId:VIEWER});
      expect((await app!.inject({method:'GET',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/file/drafts/${id}`})).statusCode).toBe(404);
      expect((await call('project.folder.draft.discard',{...target,draft_id:id,draft_version:2})).statusCode).toBe(404);
    });
    it('returns safe conflict metadata, supports exact discard replay, and preserves a later new-file draft',async()=>{
      if(!db.available)return;
      const created=await upsert(),id=created.json().data.id,key=randomUUID();
      const conflict=await upsert('Another private text',null,key);expect(conflict.statusCode,conflict.body).toBe(409);expect(conflict.body).not.toContain('PRIVATE');expect(conflict.json().error.metadata).toEqual({code:'draft_version_conflict',current_draft_id:id,current_version:1});
      expect((await upsert('Another private text',null,key)).json().error.metadata).toEqual(conflict.json().error.metadata);
      const discardKey=randomUUID(),input={...target,draft_id:id,draft_version:1},discarded=await call('project.folder.draft.discard',input,discardKey);expect(discarded.statusCode,discarded.body).toBe(200);
      const next=await upsert('Next private text'),nextId=next.json().data.id;expect(nextId).not.toBe(id);
      const replay=await app!.inject({method:'POST',url:`/api/v1/projects/${PROJECT}/folders/${FOLDER}/file/draft/discard`,payload:{draft_id:id,draft_version:1},headers:{'idempotency-key':discardKey}});expect(replay.json()).toEqual(discarded.json());
      expect((await db.pool.query('SELECT id FROM project_file_drafts')).rows).toEqual([{id:nextId}]);
    });
    it('enforces byte/hash honesty and the existing per-person aggregate quota with canonical metadata',async()=>{
      if(!db.available)return;
      for(const invalid of [{byte_size:1},{content_sha256:'0'.repeat(64)}]){
        const result=await call('project.folder.draft.upsert',{...target,...body(),...invalid});expect(result.statusCode,result.body).toBe(422);expect(result.body).not.toContain('PRIVATE');
      }
      const location=(await db.pool.query<{id:string}>("SELECT id FROM workspace_locations WHERE project_folder_id=$1 AND status='active'",[FOLDER])).rows[0]!.id;
      const content='x'.repeat(1048576),hash=createHash('sha256').update(content).digest('hex');
      await db.pool.query(`INSERT INTO project_file_drafts(id,space_id,project_id,project_folder_id,workspace_location_id,owner_user_id,target_kind,relative_path,base_exists,base_sha256,content,content_sha256,byte_size,version,source_encoding,preserve_bom,line_ending_mode,created_at,updated_at,expires_at)
        SELECT gen_random_uuid()::varchar,$1,$2,$3,$4,$5,'existing','quota/'||n||'.txt',true,$6,repeat('x',1048576),$7,1048576,1,'utf8',false,'none',now(),now(),now()+interval '1 day' FROM generate_series(1,50) AS n`,[SPACE,PROJECT,FOLDER,location,USER,'b'.repeat(64),hash]);
      const refused=await upsert();expect(refused.statusCode,refused.body).toBe(422);expect(refused.json().error.metadata).toEqual({code:'draft_quota_exceeded',used_bytes:52428800,requested_bytes:Buffer.byteLength('PRIVATE recovery text'),limit_bytes:52428800});
      expect((await db.pool.query("SELECT id FROM project_file_drafts WHERE target_kind='new'")).rows).toEqual([]);
    });
    it.each(['project_file_drafts','operation_idempotency','policy_decision_records'])('rolls the private draft and receipt back on %s storage failure',async table=>{
      if(!db.available)return;
      await db.pool.query("CREATE FUNCTION refuse_private_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE storage failure'; END $$");await db.pool.query(`CREATE TRIGGER refuse_private_draft BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_private_draft()`);
      try{const result=await upsert();expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(result.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM project_file_drafts')).rows).toEqual([]);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual([]);}
      finally{await db.pool.query(`DROP TRIGGER refuse_private_draft ON ${table}`);await db.pool.query('DROP FUNCTION refuse_private_draft()');}
    });
    it('does not redirect a waiting or replayed draft event into a newly active Location',async()=>{
      if(!db.available)return;
      const key=randomUUID(),created=await upsert('PRIVATE recovery text',null,key);expect(created.statusCode,created.body).toBe(200);
      const old=created.json().data.workspace_location_id,newLocation=randomUUID(),holder=await db.pool.connect();
      try{await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[PROJECT]);let settled=false;const pending=upsert('Waiting',1).finally(()=>{settled=true;});await waitForLockWaiter(db.pool,{settled:()=>settled});
        await holder.query("UPDATE workspace_locations SET status='stale' WHERE id=$1",[old]);await holder.query("INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'server',true,'active',now(),now())",[newLocation,SPACE,FOLDER,HOST]);await holder.query('COMMIT');
        const result=await pending;expect(result.statusCode,result.body).toBe(409);
      }finally{await holder.query('ROLLBACK');holder.release();}
      expect((await upsert('PRIVATE recovery text',null,key)).statusCode).toBe(422);
      expect((await db.pool.query('SELECT workspace_location_id,version FROM project_file_drafts')).rows).toEqual([{workspace_location_id:old,version:1}]);
    });
    it('requires explicit confirmation before removing multiple private drafts and replays the removed registration safely',async()=>{
      if(!db.available)return;
      expect((await upsert()).statusCode).toBe(200);
      await db.pool.query("UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",[PROJECT,VIEWER]);__setAuthIdentityForTests({spaceId:SPACE,userId:VIEWER});expect((await upsert('Other PRIVATE draft')).statusCode).toBe(200);__setAuthIdentityForTests({spaceId:SPACE,userId:USER});
      const refused=await call('project.folder.unregister',target);expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.metadata).toEqual({code:'active_drafts_require_confirmation',active_draft_count:2,affected_user_count:2});expect(refused.body).not.toContain('PRIVATE');
      const key=randomUUID(),input={...target,confirm:true},removed=await call('project.folder.unregister',input,key);expect(removed.statusCode,removed.body).toBe(200);
      expect((await call('project.folder.unregister',input,key)).json()).toEqual(removed.json());expect((await call('project.folder.unregister',input)).statusCode).toBe(404);
      for(const table of ['project_folders','project_file_drafts','workspace_locations'])expect((await db.pool.query(`SELECT id FROM ${table}`)).rows).toEqual([]);
    });
    it('preserves the registration and drafts when history refuses unregistering',async()=>{
      if(!db.available)return;
      const draft=(await upsert()).json().data.id;
      await db.pool.query("INSERT INTO activity_records(id,space_id,user_id,project_folder_id,activity_type,title,content,payload_json,occurred_at,created_at,status,updated_at,source_kind,source_trust,visibility,owner_user_id) VALUES($1,$2,$3,$4,'note','Used','Used Folder','{}'::jsonb,now(),now(),'processed',now(),'project_folder_event','internal_system','private',$3)",[randomUUID(),SPACE,USER,FOLDER]);
      const refused=await call('project.folder.unregister',{...target,confirm:true});expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.metadata).toEqual({code:'project_folder_in_use'});
      expect((await db.pool.query('SELECT id FROM project_file_drafts')).rows).toEqual([{id:draft}]);expect((await db.pool.query('SELECT id FROM project_folders')).rows).toEqual([{id:FOLDER}]);
    });
    async function remoteCandidate(){const host=randomUUID(),location=randomUUID();await db.pool.query("INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'Remote','desktop',now(),now())",[host,USER]);await db.pool.query("INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,last_heartbeat_at,created_at,updated_at) VALUES($1,$2,$1,'Remote','remote','linux_native','online',now(),now(),now())",[host,USER]);await db.pool.query("INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote',true,'stale',now(),now())",[location,SPACE,FOLDER,host]);return{host,location};}
    it('stores remote cleanup in the unregister transaction and defers the actual worker without consuming an attempt',async()=>{
      if(!db.available)return;
      const {host,location}=await remoteCandidate(),key=randomUUID(),removed=await call('project.folder.unregister',target,key);expect(removed.statusCode,removed.body).toBe(200);expect((await call('project.folder.unregister',target,key)).json()).toEqual(removed.json());
      const {PROJECT_FOLDER_FORGET_JOB,registerProjectFolderForgetHandler}=await import('../src/modules/projectFolders/forgetWorkspaceJob.js'),{JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js'),{JobWorker}=await import('../src/modules/jobs/worker.js'),{PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
      const jobs=(await db.pool.query('SELECT * FROM jobs WHERE job_type=$1',[PROJECT_FOLDER_FORGET_JOB])).rows;expect(jobs).toHaveLength(1);expect(jobs[0].payload_json).toEqual({project_id:PROJECT,folder_id:FOLDER,workspace_location_id:location,host_id:host});
      let offline=true;const calls:string[][]=[],registry=new JobHandlerRegistry();registerProjectFolderForgetHandler(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),{async forgetHostWorkspace(h,l){calls.push([h,l]);return{ok:!offline,error:offline?'host_offline':null};}});
      const worker=new JobWorker(new PgJobQueueRepository(db.pool),registry,'folder-cleanup-worker',[PROJECT_FOLDER_FORGET_JOB]);expect((await worker.processOne()).status).toBe('deferred');expect((await db.pool.query('SELECT attempts FROM jobs WHERE id=$1',[jobs[0].id])).rows).toEqual([{attempts:0}]);
      offline=false;await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[jobs[0].id]);expect((await worker.processOne()).status).toBe('completed');expect(calls).toEqual([[host,location],[host,location]]);
    });
    it('rolls registration and Location deletion back when the required cleanup Job cannot be stored',async()=>{
      if(!db.available)return;
      await remoteCandidate();await db.pool.query("CREATE FUNCTION refuse_folder_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE cleanup failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_folder_cleanup BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_folder_cleanup()');
      try{const result=await call('project.folder.unregister',target);expect(result.statusCode,result.body).toBe(500);expect(result.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM project_folders')).rows).toEqual([{id:FOLDER}]);expect((await db.pool.query('SELECT id FROM workspace_locations')).rows).toHaveLength(2);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual([]);}
      finally{await db.pool.query('DROP TRIGGER refuse_folder_cleanup ON jobs');await db.pool.query('DROP FUNCTION refuse_folder_cleanup()');}
    });
  });

});
