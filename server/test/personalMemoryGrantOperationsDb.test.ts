import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { personalMemoryGrantsModule } from "../src/modules/personalMemoryGrants/index.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { waitForBlockedBy } from "./support/lockWait.js";

// Real-Postgres coverage for personal memory grants: a grant whose read
// window has closed is expired, not active; a Run gets a new grant once the
// old one lapsed; and a revoke never undoes a delivery that already used it.

const PERSONAL = "9e11a001-0000-4000-8000-000000000001";
const TEAM = "9e11a001-0000-4000-8000-000000000002";
const OWNER = "9e11a001-0000-4000-8000-000000000003";
const TEAM_PROJECT = "9e11a001-0000-4000-8000-000000000005";
const AGENT = "9e11a001-0000-4000-8000-000000000006";
const VERSION = "9e11a001-0000-4000-8000-000000000007";
const RUN = "9e11a001-0000-4000-8000-000000000008";

const db = useTestDatabase(import.meta.filename,{max:5});
let app: FastifyInstance;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["personal_memory_grant_events", "personal_memory_grants", "runs", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: TEAM, owner: OWNER, project: TEAM_PROJECT, spaceType: "team", spaceName: "Team" });
  // The granting person's own personal Space, where the memory lives.
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Personal','personal',$2,$2)`, [PERSONAL, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), PERSONAL, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: TEAM, owner: OWNER });
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       owner_user_id, instructed_by_user_id, created_at, updated_at, execution_kind)
     VALUES ($1,$2,$3,$4,'agent','manual','queued','live',$5,$5,now(),now(),'agent')`,
    [RUN, TEAM, AGENT, VERSION, OWNER],
  );
  __setAuthIdentityForTests({ spaceId: TEAM, userId: OWNER });
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [personalMemoryGrantsModule]);
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
});

const createBody = { target_space_id: TEAM, target_run_id: RUN, access_mode: "summary_only" };

const headers=(key:string)=>({'idempotency-key':key});
const create=(key:string)=>app.inject({method:'POST',url:'/api/v1/personal-memory-grants',headers:headers(key),payload:createBody});
describe('personal grant core owner (real PG)',()=>{
 it('strict input and explicit key are required',async()=>{
  expect((await app.inject({method:'POST',url:'/api/v1/personal-memory-grants',payload:createBody})).statusCode).toBe(422);
  expect((await app.inject({method:'POST',url:'/api/v1/personal-memory-grants',headers:headers('strict'),payload:{...createBody,extra:true}})).statusCode).toBe(422);
 });
 it('preview has a durable receipt and rechecks target authority',async()=>{
  const req=()=>app.inject({method:'POST',url:'/api/v1/personal-memory-grants/preview',headers:headers('preview'),payload:createBody});
  const first=await req();expect(first.statusCode).toBe(200);
  expect((await req()).json()).toEqual(first.json());
  await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[TEAM,OWNER]);
  expect((await req()).statusCode).toBe(404);
 });
 it('create replay inserts one grant and event, revoke withholds its receipt',async()=>{
  const first=await create('create');expect(first.statusCode).toBe(201);
  const grant=first.json().data;
  expect((await create('create')).json()).toEqual(first.json());
  expect((await db.pool.query('SELECT id FROM personal_memory_grants')).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT id FROM personal_memory_grant_events')).rows).toHaveLength(1);
  const revoke=()=>app.inject({method:'POST',url:`/api/v1/personal-memory-grants/${grant.id}/revoke`,headers:headers('revoke')});
  expect((await revoke()).statusCode).toBe(200);
  expect((await revoke()).statusCode).toBe(200);
  expect((await create('create')).statusCode).toBe(404);
  expect((await db.pool.query('SELECT id FROM personal_memory_grant_events')).rows).toHaveLength(2);
 });
 it('owner may revoke after losing the target audience',async()=>{
  const first=await create('owner-revoke');expect(first.statusCode).toBe(201);
  await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[TEAM,OWNER]);
  const response=await app.inject({method:'POST',url:`/api/v1/personal-memory-grants/${first.json().data.id}/revoke`,headers:headers('revoke-after-exit')});
  expect(response.statusCode).toBe(200);expect(response.json().data.status).toBe('revoked');
 });
 it('active account withdrawal blocks replay',async()=>{
  expect((await create('disabled')).statusCode).toBe(201);
  await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[OWNER]);
  expect((await create('disabled')).statusCode).toBe(404);
 });
 it('late mandatory audit failure rolls back grant and event, same key recovers',async()=>{
  await db.pool.query("CREATE FUNCTION refuse_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
  await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_grant_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_grant_audit()');
  try{
   expect((await create('rollback')).statusCode).toBe(503);
   expect((await db.pool.query('SELECT id FROM personal_memory_grants')).rows).toHaveLength(0);
   expect((await db.pool.query('SELECT id FROM personal_memory_grant_events')).rows).toHaveLength(0);
  }finally{await db.pool.query('DROP TRIGGER refuse_grant_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_grant_audit()');}
  expect((await create('rollback')).statusCode).toBe(201);
 });
 it('canonical create waits for target audience revocation then refuses',async()=>{
  const client=await db.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await client.query('BEGIN');const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await client.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[TEAM,OWNER]);
   const {GrantRepository}=await import('../src/modules/personalMemoryGrants/repository.js');
   const result=new GrantRepository(db.pool).create({spaceId:PERSONAL,userId:OWNER},createBody).then(()=>({ok:true}),error=>({ok:false,status:error.statusCode}));
   pending=result;await waitForBlockedBy(db.pool,pid);
   expect((await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))',[pid])).rows.length).toBeGreaterThan(0);
   await client.query('COMMIT');expect(await result).toMatchObject({ok:false});
   expect((await db.pool.query('SELECT id FROM personal_memory_grants')).rows).toHaveLength(0);
  }finally{await client.query('ROLLBACK');client.release();await pending;}
 });
});
