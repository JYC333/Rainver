import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {loadMigrations,migrate} from '../src/db/migrator.js';
import {resolveUserActorId} from '../src/db/actorResolver.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
const db=useTestDatabase(import.meta.filename,{empty:true}),recovery=useTestDatabase(import.meta.filename+'-recovery',{empty:true});
const outputRoot=process.env.PROBLEM_ENGINE_EVIDENCE_DIR;if(outputRoot)mkdirSync(outputRoot,{recursive:true});
const root=mkdtempSync(join(outputRoot??tmpdir(),'problem-upgrade-drill-'));
afterAll(()=>{if(!outputRoot)rmSync(root,{recursive:true,force:true});});
function testDatabase(uri:string){const u=new URL(uri),name=u.pathname.slice(1);if(!/^rainver_test_[a-z0-9_]+$/.test(name))throw new Error('Drill refuses non-test databases');return {u,name};}
function backup(uri:string){
 const {u,name}=testDatabase(uri);
 const ids=execFileSync('docker',['ps','--filter','label=org.testcontainers=true','--format','{{.ID}}'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 const matches=ids.map(id=>JSON.parse(execFileSync('docker',['inspect',id],{encoding:'utf8'}))[0]).filter(c=>c.Config.Image==='pgvector/pgvector:pg18'&&c.Config.Labels?.['org.testcontainers']==='true'&&((c.NetworkSettings.Ports?.['5432/tcp']??[]).some((p:{HostPort:string})=>p.HostPort===u.port)||(u.port==='5432'&&Object.values(c.NetworkSettings.Networks??{}).some((n:any)=>n.IPAddress===u.hostname))));
 if(matches.length!==1)throw new Error(`Shared test-container port must match exactly (port ${u.port}, candidates ${ids.length})`);
 const container=matches[0].Id;
 const dump=execFileSync('docker',['exec',container,'pg_dump','-U',decodeURIComponent(u.username),'-Fc','--no-owner','--no-acl',name],{maxBuffer:64*1024*1024});return {dump,container};
}
function restore(uri:string,b:{dump:Buffer;container:string}){const {u,name}=testDatabase(uri);execFileSync('docker',['exec','-i',b.container,'pg_restore','-U',decodeURIComponent(u.username),'-d',name,'--clean','--if-exists','--exit-on-error','--no-owner','--no-acl'],{input:b.dump,maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});}
it('converts schema 0008 once without losing Tasks or normal history and removes retired Loop/event data, then restores its backup',async()=>{
 const prefix=join(root,'prefix');mkdirSync(prefix);const chain=join(import.meta.dirname,'../migrations');
 for(const m of loadMigrations(chain).filter(m=>Number(m.version)<=8))cpSync(m.path,join(prefix,`${m.version}_${m.name}.sql`));
 await migrate(db.pool,prefix);
 const space=randomUUID(),owner=randomUUID(),project=randomUUID(),task=randomUUID(),event=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project});
 const identity={spaceId:space,userId:owner};
 const created=await new PgTaskRepository(db.pool).createTask(identity,{id:task,project_id:project,title:'Retained Task'});
 const taskId=created.id;
 const actor=await resolveUserActorId(db.pool,space,owner);
 await db.pool.query(`INSERT INTO project_work_events(id,space_id,project_id,event_kind,subject_type,subject_id,actor_id,occurred_at,data_json,created_at) VALUES($1,$2,$3,'task.stage_changed','task',$4,$5,now(),'{}',now())`,[event,space,project,taskId,actor]);
 await db.pool.query(`INSERT INTO task_loop_states(task_id,space_id,project_id,loop_instance_id,current_stage_key,stage_entered_at,last_event_id,revision,updated_at) VALUES($1,$2,$3,$4,'verify',now(),$5,2,now())`,[taskId,space,project,randomUUID(),event]);
 const before=(await db.pool.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1',[taskId])).rows[0].value;
 const pre=backup(db.connectionUri);const applied=await migrate(db.pool,chain);expect(applied.applied).toContain('0009');
 expect((await db.pool.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1',[taskId])).rows[0].value).toEqual(before);
 expect((await db.pool.query("SELECT to_regclass('maintenance_model_archives') AS present")).rows[0].present).toBeNull();
 expect((await db.pool.query('SELECT id FROM project_work_events WHERE id=$1',[event])).rows).toEqual([]);
 expect((await db.pool.query(`SELECT to_regclass('task_loop_states') AS present`)).rows[0].present).toBeNull();
 expect((await migrate(db.pool,chain)).applied).toEqual([]);
 await new PgTaskRepository(db.pool).createTask(identity,{project_id:project,title:'Independent after cutover'});
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM inquiry_threads WHERE space_id=$1`,[space])).rows[0].n).toBe(0);
 restore(recovery.connectionUri,pre);expect((await recovery.pool.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1',[taskId])).rows[0].value).toEqual(before);
 await migrate(recovery.pool,chain);expect((await recovery.pool.query("SELECT to_regclass('maintenance_model_archives') AS present")).rows[0].present).toBeNull();
 writeFileSync(join(root,'cutover-evidence.json'),JSON.stringify({backup_sha256:createHash('sha256').update(pre.dump).digest('hex'),applied:applied.applied,task_identity_retained:true,retired_events_remaining:0,restored:true}));
});

const aclDb=useTestDatabase(import.meta.filename+'-acl',{empty:true});
it('retains Run/Room and private-reference gates for normal history after complete offline retirement',async()=>{
 const {seedSpaceMember,seedRun}=await import('./support/domainSeeds.js');
 const {readTaskHistory}=await import('../src/modules/projectWork/taskHistory.js');
 const {getProjectUpdates}=await import('../src/modules/projectWork/updatesReadModel.js');
 const {undoProjectUpdate}=await import('../src/modules/projectWork/updateUndo.js');
 const {appendProjectWorkEvent}=await import('../src/modules/projectWork/eventWriter.js');
 const prefix=join(root,'acl-prefix');mkdirSync(prefix);const chain=join(import.meta.dirname,'../migrations');
 for(const m of loadMigrations(chain).filter(m=>Number(m.version)<=8))cpSync(m.path,join(prefix,`${m.version}_${m.name}.sql`));
 await migrate(aclDb.pool,prefix);
 const space=randomUUID(),owner=randomUUID(),peer=randomUUID(),project=randomUUID(),run=randomUUID();
 await seedSpaceOwnerProject(aclDb.pool,{space,owner,project,spaceType:'household'});await seedSpaceMember(aclDb.pool,{space,user:peer});
 await aclDb.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
 const author={spaceId:space,userId:owner},reader={spaceId:space,userId:peer},repo=new PgTaskRepository(aclDb.pool);
 const task=await repo.createTask(author,{project_id:project,title:'Shared work',visibility:'space_shared'});
 const privateTask=await repo.createTask(author,{project_id:project,title:'Private reference'});
 await seedRun(aclDb.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 const room=(await aclDb.pool.query(`SELECT id FROM rooms WHERE project_id=$1 AND space_id=$2`,[project,space])).rows[0].id;
 const session=randomUUID();await aclDb.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[session,space,project,room]);
 await aclDb.pool.query(`UPDATE runs SET session_id=$2,project_id=$3 WHERE id=$1`,[run,session,project]);
 const actor=await resolveUserActorId(aclDb.pool,space,owner),prior=randomUUID();
 const originals=[{run_id:run,reference_refs:[{type:'task',id:task.id}],reason:'PRIVATE_ROOM_REASON',undo_of_event_id:prior},{reference_refs:[{type:'task',id:privateTask.id}],reason:'PRIVATE_REFERENCE_REASON'},{reason:'PUBLIC_OLD_REASON'}];
 const ids=[] as string[];
 for(const data of originals){const id=randomUUID();ids.push(id);await aclDb.pool.query(`INSERT INTO project_work_events(id,space_id,project_id,event_kind,subject_type,subject_id,actor_id,occurred_at,data_json,created_at) VALUES($1,$2,$3,'task.stage_changed','task',$4,$5,now(),$6::jsonb,now())`,[id,space,project,task.id,actor,JSON.stringify(data)]);}
 await migrate(aclDb.pool,chain);
 expect((await aclDb.pool.query('SELECT id FROM project_work_events WHERE id=ANY($1::varchar[])',[ids])).rows).toEqual([]);
 expect(await readTaskHistory(aclDb.pool,reader,task.id)).not.toMatchObject({items:expect.arrayContaining([expect.objectContaining({id:ids[0]})])});
 const reportIds=[] as string[];
 for(const data of originals){const receipt=await appendProjectWorkEvent(aclDb.pool,{spaceId:space,projectId:project,subjectType:'task',subjectId:task.id,actorId:actor,eventKind:'task.reported',data:{...data,summary:data.reason}});reportIds.push(receipt.id);}
 const history=async(who:typeof author)=>(await readTaskHistory(aclDb.pool,who,task.id)).items;
 expect((await history(author)).map(r=>r.id)).toEqual(expect.arrayContaining(reportIds));
 const peerHistory=(await history(reader)).map(r=>r.id);
 expect(peerHistory).toContain(reportIds[2]);
 for(const id of reportIds.slice(0,2))expect(peerHistory).not.toContain(id);
 for(const id of reportIds.slice(0,2))await expect(undoProjectUpdate(aclDb.pool,reader,project,id)).rejects.toMatchObject({statusCode:404});
 await expect(undoProjectUpdate(aclDb.pool,author,project,reportIds[0]!)).rejects.toMatchObject({statusCode:409});
 const updates=async(who:typeof author)=>JSON.stringify((await getProjectUpdates(aclDb.pool,who,project,null)).items);
 expect(await updates(author)).toContain('PRIVATE_ROOM_REASON');expect(await updates(author)).toContain('PRIVATE_REFERENCE_REASON');expect(await updates(reader)).not.toMatch(/PRIVATE_(ROOM|REFERENCE)_REASON/);expect(await updates(reader)).toContain('PUBLIC_OLD_REASON');
 await aclDb.pool.query(`UPDATE tasks SET visibility='space_shared' WHERE id=$1`,[privateTask.id]);expect((await history(reader)).map(r=>r.id)).toContain(reportIds[1]);
 await aclDb.pool.query(`UPDATE tasks SET visibility='private' WHERE id=$1`,[privateTask.id]);expect((await history(reader)).map(r=>r.id)).not.toContain(reportIds[1]);
 await aclDb.pool.query(`UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2`,[room,owner]);expect((await history(author)).map(r=>r.id)).not.toContain(reportIds[0]);
 expect((await migrate(aclDb.pool,chain)).applied).toEqual([]);
});

const dependencyDb=useTestDatabase(import.meta.filename+'-dependency',{empty:true});
it('refuses to remove a retired event referenced by normal work, rolling back the formal migration',async()=>{
 const chain=join(import.meta.dirname,'../migrations'),prefix=join(root,'dependency-prefix');mkdirSync(prefix);
 for(const m of loadMigrations(chain).filter(m=>Number(m.version)<=8))cpSync(m.path,join(prefix,`${m.version}_${m.name}.sql`));
 await migrate(dependencyDb.pool,prefix);
 const space=randomUUID(),owner=randomUUID(),project=randomUUID();await seedSpaceOwnerProject(dependencyDb.pool,{space,owner,project});
 const identity={spaceId:space,userId:owner},task=await new PgTaskRepository(dependencyDb.pool).createTask(identity,{project_id:project,title:'Preserved work'});
 const actor=await resolveUserActorId(dependencyDb.pool,space,owner),event=randomUUID();
 await dependencyDb.pool.query(`INSERT INTO project_work_events(id,space_id,project_id,event_kind,subject_type,subject_id,actor_id,occurred_at,data_json,created_at) VALUES($1,$2,$3,'task.stage_changed','task',$4,$5,now(),'{}',now())`,[event,space,project,task.id,actor]);
 const {appendProjectWorkEvent}=await import('../src/modules/projectWork/eventWriter.js');
 const normal=await appendProjectWorkEvent(dependencyDb.pool,{spaceId:space,projectId:project,subjectType:'task',subjectId:task.id,actorId:actor,eventKind:'task.reported',causationId:event,data:{summary:'Normal work must stay intact'}});
 await expect(migrate(dependencyDb.pool,chain)).rejects.toThrow(/Normal work references retired events/);
 expect((await dependencyDb.pool.query('SELECT id FROM project_work_events WHERE id=ANY($1::varchar[])',[ [event,normal.id] ])).rows).toHaveLength(2);
 expect((await dependencyDb.pool.query('SELECT max(version) AS version FROM server_schema_migrations')).rows[0].version).toBe('0008');
});
