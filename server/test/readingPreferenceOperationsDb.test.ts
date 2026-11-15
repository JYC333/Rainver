import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedSpaceMember } from './support/domainSeeds.js';
import { waitForBlockedBy } from './support/lockWait.js';
import { buildModuleServer } from './support/moduleServer.js';
import { informationDigestModule } from '../src/modules/informationDigest/index.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { ReadingPreferences } from '../src/modules/informationDigest/readingPreferences.js';
import { loadConfig } from '../src/config.js';
const db = useTestDatabase(import.meta.filename, { max: 5 });
let space: string, owner: string, project: string, viewer: string, app: ReturnType<typeof buildModuleServer>;
const set = (enabled: boolean, key = randomUUID(), payload: object = {}) => app.inject({ method: 'PUT', url: `/api/v1/spaces/${space}/projects/${project}/reading-preference`, payload: { show_in_my_reading: enabled, ...payload }, headers: { 'idempotency-key': key } });
const enabled = (userId = owner) => new ReadingPreferences(db.pool).get({ spaceId: space, userId }, project);
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
  space = randomUUID(); owner = randomUUID(); project = randomUUID(); viewer = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: 'team' });
  await seedSpaceMember(db.pool, { space, user: viewer });
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())", [randomUUID(),space,project,viewer]);
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [informationDigestModule, systemActionsModule]);
  __setAuthIdentityForTests({ spaceId: space, userId: owner });
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });
it('sets only the reader’s preference and replays the original result without overwriting a later choice', async () => {
  const key = randomUUID(), first = await set(true, key);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().data).toMatchObject({ space_id: space, project_id: project, user_id: owner, show_in_my_reading: true });
  expect((await set(false)).statusCode).toBe(200);
  expect((await set(true, key)).json().data).toEqual(first.json().data);
  expect(await enabled()).toEqual({ show_in_my_reading: false });
  expect(await enabled(viewer)).toEqual({ show_in_my_reading: false });
  expect((await set(false, key)).statusCode).toBe(422);
});
it('allows a Project viewer to control their own opt-in and refuses replay after Project revocation', async () => {
  __setAuthIdentityForTests({ spaceId: space, userId: viewer });
  const key = randomUUID(), result = await set(true, key);
  expect(result.statusCode, result.body).toBe(200);
  expect(await enabled(viewer)).toEqual({ show_in_my_reading: true });
  expect(await enabled(owner)).toEqual({ show_in_my_reading: false });
  await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2", [project, viewer]);
  expect((await set(true, key)).statusCode).toBe(404);
});
it.each(['inactive', 'disabled'])('refuses same-key replay after %s authority is withdrawn', async kind => {
  const key = randomUUID(); expect((await set(true, key)).statusCode).toBe(200);
  if (kind === 'inactive') await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2", [space, owner]);
  else await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [owner]);
  expect((await set(true, key)).statusCode).toBe(404);
});
it('rejects missing key, unknown fields and path target substitution before any preference is written', async () => {
  const response = await app.inject({ method:'PUT', url:`/api/v1/spaces/${space}/projects/${project}/reading-preference`, payload:{show_in_my_reading:true} });
  expect(response.statusCode).toBe(422);
  expect((await set(true, randomUUID(), { user_id: viewer })).statusCode).toBe(422);
  expect((await set(true, randomUUID(), { project_id: randomUUID() })).statusCode).toBe(422);
  expect(await enabled()).toEqual({ show_in_my_reading: false });
});
it.each(['operation_idempotency', 'policy_decision_records'])('rolls back the preference when %s fails, then recovers with the same key', async table => {
  const key = randomUUID();
  await db.pool.query("CREATE FUNCTION refuse_reading_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reading storage refused'; END $$");
  await db.pool.query(`CREATE TRIGGER refuse_reading_store BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_reading_store()`);
  try { const result=await set(true,key); expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500); expect(await enabled()).toEqual({show_in_my_reading:false}); }
  finally { await db.pool.query(`DROP TRIGGER refuse_reading_store ON ${table}`); await db.pool.query('DROP FUNCTION refuse_reading_store()'); }
  expect((await set(true,key)).statusCode).toBe(200);
  expect(await enabled()).toEqual({show_in_my_reading:true});
});
it('serializes admission behind a real Project revoke and returns no stale success', async () => {
  __setAuthIdentityForTests({spaceId:space,userId:viewer});
  const hold=await db.pool.connect(); let pending:ReturnType<typeof set>|undefined;
  try {
    await hold.query('BEGIN');
    const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await hold.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,viewer]);
    pending=set(true); await waitForBlockedBy(db.pool,pid);
    await hold.query('COMMIT'); expect((await pending).statusCode).toBe(404);
  } finally { await hold.query('ROLLBACK');hold.release();await pending; }
  expect((await new ReadingPreferences(db.pool).enabled({spaceId:space,userId:viewer}))).toEqual([]);
});
it('keeps concurrent updates to different Project opt-ins without losing either', async () => {
  const other=randomUUID();
  await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other','active',now(),now())",[other,space,owner]);
  const hold=await db.pool.connect();let pending:ReturnType<typeof set>|undefined;
  try {
    await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await new ReadingPreferences(hold).set({spaceId:space,userId:owner},other,true);
    pending=set(true);await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');expect((await pending).statusCode).toBe(200);
  } finally {await hold.query('ROLLBACK');hold.release();await pending;}
  expect((await new ReadingPreferences(db.pool).enabled({spaceId:space,userId:owner})).sort()).toEqual([project,other].sort());
});

it('refuses concurrent same-key execution while the first call waits on Project authority', async () => {
  const hold=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof set>|undefined;
  try {
    await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
    pending=set(true,key);await waitForBlockedBy(db.pool,pid);
    const conflict=await set(true,key);expect(conflict.statusCode,conflict.body).toBe(409);expect(conflict.json().error.code).toBe('idempotency_in_progress');
    await hold.query('COMMIT');expect((await pending).statusCode).toBe(200);
  } finally {await hold.query('ROLLBACK');hold.release();await pending;}
  expect(await enabled()).toEqual({show_in_my_reading:true});
});
it('review regression: Project wait does not prelock the active person in either preference entry',async()=>{
 for(const mode of ['operation','service']){
  const hold=await db.pool.connect(),probe=await db.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await hold.query('BEGIN');const pid=(await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await hold.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
   pending=mode==='operation'?Promise.resolve(set(true)):new ReadingPreferences(db.pool).set({spaceId:space,userId:owner},project,true);
   await waitForBlockedBy(db.pool,pid);
   await probe.query('BEGIN');
   // Auth/invitation writers can still lock the account while Reading waits
   // on a Project writer; a reader-first person lock inverted this order.
   await probe.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[owner]);
   await probe.query('ROLLBACK');await hold.query('COMMIT');await pending;
  }finally{await probe.query('ROLLBACK');await hold.query('ROLLBACK');probe.release();hold.release();await pending;}
 }
});
it('review regression: a real invitation writer can finish while Reading waits for its user lock',async()=>{
 const {createInvitation,acceptInvitation}=await import('../src/modules/spaces/writers.js');
 const token=randomUUID(),email=(await db.pool.query('SELECT email FROM users WHERE id=$1',[owner])).rows[0].email;
 await createInvitation(db.pool,owner,space,{email,role:'member',token});
 const writer=await db.pool.connect();let pending:ReturnType<typeof set>|undefined;
 try{
  await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='750ms'");
  // acceptInvitation's first real lock, paused before its membership upsert.
  await writer.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner]);
  const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  pending=set(true);await waitForBlockedBy(db.pool,pid);
  // The old core JOIN locked the membership first, so this real owner query
  // waited for Reading while Reading waited for this account: an actual cycle.
  await expect(acceptInvitation(writer,owner,token)).rejects.toMatchObject({statusCode:409});
  await writer.query('ROLLBACK');expect((await pending).statusCode).toBe(200);
 }finally{await writer.query('ROLLBACK');writer.release();await pending;}
});
