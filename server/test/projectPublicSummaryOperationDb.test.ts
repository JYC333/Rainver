import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,user:string,project:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,input:object,key:string=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const body=(text='PRIVATE draft')=>({project_id:project,summary_text:text,topics:[' topic ','TOPIC'],highlights:[' finding ']});
const rows=async(table:string)=>(await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space])).rows;
async function save(text?:string){const r=await call('project.public_summary.save',body(text));expect(r.statusCode,r.body).toBe(200);return r;}
async function publish(version=1,key?:string){return call('project.public_summary.publish',{project_id:project,draft_version:version},key);}
beforeEach(async()=>{await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[projectsModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});});
afterEach(async()=>{__setAuthIdentityForTests(null);await app.close();});
it('saves one draft across formal/generic transports without publishing or exposing content in receipts',async()=>{
 const invalid=await app.inject({method:'PUT',url:`/api/v1/projects/${project}/public-summary`,payload:{topics:['discovery']},headers:{'idempotency-key':randomUUID()}});expect(invalid.statusCode,invalid.body).toBe(422);expect(invalid.json().error.code).toBe('operation_invalid_input');
 const key=randomUUID(),input=body(),{project_id:_,...draft}=input;const r=await app.inject({method:'PUT',url:`/api/v1/projects/${project}/public-summary`,payload:draft,headers:{'idempotency-key':key}});expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('PRIVATE');expect((await call('project.public_summary.save',input,key)).json()).toEqual(r.json());
 expect(await rows('project_public_summaries')).toMatchObject([{draft_version:1,summary_text:'PRIVATE draft',topics_json:['topic'],highlights_json:['finding'],redaction_version:'project_public_summary.v1'}]);expect(await rows('project_public_summary_publications')).toEqual([]);expect(await rows('retrieval_objects')).toEqual([]);
 expect((await call('project.public_summary.save',{...input,summary_text:'Other'},key)).statusCode).toBe(422);expect((await call('project.public_summary.save',{...input,published_by_user_id:user})).statusCode).toBe(422);
});
it('keeps reviewed publication separate from subsequent draft saves and only queues one embedding Job on replay',async()=>{
 await save();const key=randomUUID(),r=await publish(1,key);expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('PRIVATE');expect(await rows('retrieval_objects')).toMatchObject([{object_type:'project_public_summary',object_id:project}]);
 await save('PRIVATE newer draft');expect((await publish(1)).statusCode).toBe(409);expect((await publish(1,key)).json()).toEqual(r.json());expect(await rows('project_public_summary_publications')).toMatchObject([{summary_text:'PRIVATE draft',source_draft_version:1}]);expect(await rows('jobs')).toHaveLength(1);
 const revokeKey=randomUUID(),revoke=await call('project.public_summary.revoke',{project_id:project},revokeKey);expect(revoke.statusCode,revoke.body).toBe(200);expect(await rows('retrieval_objects')).toEqual([]);expect(await rows('project_public_summary_publications')).toEqual([]);expect((await call('project.public_summary.revoke',{project_id:project},revokeKey)).json()).toEqual(revoke.json());expect(await rows('project_public_summaries')).toMatchObject([{draft_version:2}]);
});
it('retains owner-level publication, live writer checks on replay, and owner revoke while archived',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});const key=randomUUID(),input=body(),r=await call('project.public_summary.save',input,key);expect(r.statusCode,r.body).toBe(200);expect((await publish()).statusCode).toBe(404);expect((await call('project.public_summary.revoke',{project_id:project})).statusCode).toBe(404);
 await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,peer]);expect((await call('project.public_summary.save',input,key)).statusCode).toBe(404);__setAuthIdentityForTests({spaceId:space,userId:user});expect((await publish()).statusCode).toBe(200);await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);expect((await call('project.public_summary.revoke',{project_id:project})).statusCode).toBe(200);expect((await call('project.public_summary.save',body())).statusCode).toBe(409);
});
it('validates generated Run provenance without borrowing a foreign Project reference',async()=>{
 const run=randomUUID();await seedRun(db.pool,{id:run,agent:randomUUID(),version:randomUUID(),space,owner:user});expect((await call('project.public_summary.save',{...body(),generated_by_run_id:run})).statusCode).toBe(422);expect(await rows('project_public_summaries')).toEqual([]);await db.pool.query('UPDATE runs SET project_id=$2 WHERE id=$1',[run,project]);const key=randomUUID(),input={...body(),generated_by_run_id:run};expect((await call('project.public_summary.save',input,key)).statusCode).toBe(200);
 const room=(await rows('rooms'))[0]!.id,session=randomUUID();await db.pool.query("INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'Provenance conversation','active',now(),now())",[session,space,room,project]);await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1',[run,session]);await db.pool.query("UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2",[room,user]);expect((await call('project.public_summary.save',input,key)).statusCode).toBe(422);expect((await rows('project_public_summaries'))[0]!.draft_version).toBe(1);
});
it.each(['projection','job','audit'])('rolls the public snapshot, index and receipt back on %s persistence failure',async kind=>{
 await save();const before=await rows('operation_idempotency'),table=kind==='projection'?'retrieval_objects':kind==='job'?'jobs':'policy_decision_records';await db.pool.query("CREATE FUNCTION refuse_summary_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE summary storage failure'; END $$");await db.pool.query(`CREATE TRIGGER refuse_summary_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_summary_write()`);
 try{const r=await publish();expect(r.statusCode,r.body).toBe(kind==='audit'?503:500);expect(r.body).not.toContain('PRIVATE');expect(await rows('project_public_summary_publications')).toEqual([]);expect(await rows('retrieval_objects')).toEqual([]);expect(await rows('jobs')).toEqual([]);expect(await rows('operation_idempotency')).toEqual(before);}finally{await db.pool.query(`DROP TRIGGER refuse_summary_write ON ${table}`);await db.pool.query('DROP FUNCTION refuse_summary_write()');}
});
it('keeps publication and projection together when revocation cannot remove its search projection',async()=>{
 await save();const p=await publish();expect(p.statusCode,p.body).toBe(200);const before=await rows('operation_idempotency');await db.pool.query("CREATE FUNCTION refuse_summary_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE projection removal failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_summary_delete BEFORE DELETE ON retrieval_objects FOR EACH ROW EXECUTE FUNCTION refuse_summary_delete()');
 try{const r=await call('project.public_summary.revoke',{project_id:project});expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');expect(await rows('project_public_summary_publications')).toHaveLength(1);expect(await rows('retrieval_objects')).toHaveLength(1);expect(await rows('operation_idempotency')).toEqual(before);}finally{await db.pool.query('DROP TRIGGER refuse_summary_delete ON retrieval_objects');await db.pool.query('DROP FUNCTION refuse_summary_delete()');}
});
