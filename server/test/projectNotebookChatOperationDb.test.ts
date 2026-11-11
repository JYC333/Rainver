import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {providerTaskTestConfig,seedTestModelProvider,performQueuedProviderTask} from './support/providerTaskFixture.js';
import {__setProviderHttpClientForTests} from '../src/modules/providers/invocation/invocation.js';
import {openAiChatResponse} from './support/piAiHttp.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectResearchModule} from '../src/modules/projectResearch/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {ProjectResearchAreaService} from '../src/modules/projectResearch/areaService.js';
import {PgKnowledgeRepository} from '../src/modules/knowledge/repository.js';
import {PgProjectRepository} from '../src/modules/projects/repository.js';
import {authorizeNotebookChatAttempt} from '../src/modules/projectResearch/notebookChatAdmission.js';
import {withTransaction} from '../src/db/tx.js';
import type {Queryable} from '../src/modules/routeUtils/common.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,user:string,project:string,provider:string,config:ReturnType<typeof providerTaskTestConfig>,app:ReturnType<typeof buildModuleServer>,fetches:number;
const output=(note:string|null=null)=>({answer:'PRIVATE answer',notebook_update:{note_id:note,new_note_title:'Generated note',ops:note?[{op:'append',index:null,count:null,markdown:'PRIVATE generated paragraph'}]:[],refs:[]}});
function reply(body:object){__setProviderHttpClientForTests({fetch:async()=>{fetches++;return openAiChatResponse({choices:[{message:{content:JSON.stringify(body)}}]});}});}
const call=(input:object,key:string=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/project.notebook.chat',payload:input,headers:{'idempotency-key':key}});
const input=(message='PRIVATE question')=>({project_id:project,message,execution:{model_provider_id:provider}});
async function perform(runId:string){return performQueuedProviderTask(config,{spaceId:space,userId:user,runId});}
async function material(){
 const item=randomUUID(),corpus=randomUUID();await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','feed_entry','PRIVATE source','PRIVATE excerpt',now(),now(),'excerpt_saved','summary_only',now(),now())",[item,space,user]);await db.pool.query("INSERT INTO project_corpus_items(id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at) VALUES($1,$2,$3,$4,'candidate','active','relevant',true,'unread',now(),now())",[corpus,space,project,item]);await db.pool.query('INSERT INTO project_corpus_item_sources(id,corpus_item_id,space_id,project_id,source_item_id,created_at) VALUES($1,$2,$3,$4,$5,now())',[randomUUID(),corpus,space,project,item]);
 return item;
}
beforeEach(async()=>{await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();fetches=0;await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});config=providerTaskTestConfig(db.connectionUri,'/tmp/rainver-notebook-command-tests');provider=await seedTestModelProvider(db.pool,{space,owner:user,config});app=buildModuleServer(config,[projectResearchModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});reply(output());});
afterEach(async()=>{__setProviderHttpClientForTests(null);__setAuthIdentityForTests(null);await app.close();});
it('queues a private ProviderTask Run and one user message without provider IO, and replays across transports',async()=>{
 const key=randomUUID(),body=input(),r=await call(body,key);expect(r.statusCode,r.body).toBe(201);expect(r.body).not.toContain('PRIVATE');expect(fetches).toBe(0);const receipt=r.json().data;
 expect((await app.inject({method:'POST',url:`/api/v1/projects/${project}/notebook-chat`,payload:{message:body.message,execution:body.execution},headers:{'idempotency-key':key}})).json()).toEqual(r.json());
 expect((await call(input('Other question'),key)).statusCode).toBe(422);
 expect((await db.pool.query('SELECT execution_kind,visibility,session_id,status FROM runs WHERE id=$1',[receipt.run_id])).rows).toEqual([{execution_kind:'provider_task',visibility:'private',session_id:receipt.session_id,status:'queued'}]);
 expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='provider_task_run' AND payload_json->>'run_id'=$1",[receipt.run_id])).rows).toHaveLength(1);expect((await db.pool.query('SELECT role FROM messages WHERE session_id=$1',[receipt.session_id])).rows).toEqual([{role:'user'}]);
});
it('rolls the Session, Note scaffolding, Run and user message back if the dispatch Job cannot be stored',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_notebook_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE Job failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_notebook_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_notebook_job()');
 try{const r=await call(input());expect(r.statusCode,r.body).toBe(500);expect(r.body).not.toContain('PRIVATE');expect(fetches).toBe(0);for(const table of ['sessions','messages','notes','runs','operation_idempotency'])expect((await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space])).rows).toEqual([]);}finally{await db.pool.query('DROP TRIGGER refuse_notebook_job ON jobs');await db.pool.query('DROP FUNCTION refuse_notebook_job()');}
});
it('publishes the answer and canonical Note edit once and never calls the provider on terminal Job redelivery',async()=>{
 const service=new ProjectResearchAreaService(db.pool,config),note=(await service.initializeArea({spaceId:space,userId:user},project)).notes[0]!;reply(output(note.id));
 const r=await call(input());expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data;expect((await app.inject({method:'GET',url:`/api/v1/projects/${project}/notebook-chat/${receipt.run_id}`})).json().pending).toBe(true);
 await perform(receipt.run_id);const result=await app.inject({method:'GET',url:`/api/v1/projects/${project}/notebook-chat/${receipt.run_id}`});expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({pending:false,ok:true,reply:'PRIVATE answer',notebook_edit:{note_id:note.id}});
 const fetched=fetches;expect(fetched).toBe(1);await perform(receipt.run_id);await service.reconcileNotebookChat(space,receipt.run_id);expect(fetches).toBe(fetched);expect((await db.pool.query("SELECT id FROM messages WHERE run_id=$1 AND role='assistant'",[receipt.run_id])).rows).toHaveLength(1);expect((await db.pool.query('SELECT id FROM note_revisions WHERE note_id=$1 AND created_by_run_id=$2',[note.id,receipt.run_id])).rows).toHaveLength(1);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows).toEqual([{status:'succeeded'}]);
});
it('refuses revoked Project writers before any provider attempt and suppresses old receipt replay',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);__setAuthIdentityForTests({spaceId:space,userId:peer});
 const key=randomUUID(),body=input(),r=await call(body,key);expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data;await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,peer]);
 await performQueuedProviderTask(config,{spaceId:space,userId:peer,runId:receipt.run_id});expect(fetches).toBe(0);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows).toEqual([{status:'failed'}]);expect((await call(body,key)).statusCode).toBe(404);
});
it('refuses material revoked after queue admission before sending its frozen excerpt to the model',async()=>{
 const item=await material();
 const r=await call({...input(),source_item_ids:[item]});expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data,peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE source_items SET visibility='private',owner_user_id=$2 WHERE id=$1",[item,peer]);await perform(receipt.run_id);expect(fetches).toBe(0);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows).toEqual([{status:'failed'}]);
});
it('keeps the private answer while declining a co-edit that would disclose another context Note to new readers',async()=>{
 const identity={spaceId:space,userId:user},service=new ProjectResearchAreaService(db.pool,config),shared=(await service.initializeArea(identity,project)).notes[0]!;
 const privateNote=await new PgKnowledgeRepository(db.pool).createNote(identity,{title:'PRIVATE context',primary_project_id:project,plain_text:'PRIVATE context words'});await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1",[privateNote.id]);const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);reply(output(shared.id));
 const r=await call(input());expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data;await perform(receipt.run_id);const result=await service.notebookChatResult(identity,project,receipt.run_id);expect(result).toMatchObject({pending:false,ok:true,reply:'PRIVATE answer',notebook_edit:null});expect((await db.pool.query('SELECT version FROM notes WHERE object_id=$1',[shared.id])).rows).toEqual([{version:shared.version}]);
});
it('rolls the generated Note revision back with the answer when final message persistence fails',async()=>{
 const identity={spaceId:space,userId:user},service=new ProjectResearchAreaService(db.pool,config),note=(await service.initializeArea(identity,project)).notes[0]!;reply(output(note.id));const r=await call(input());expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data;
 await db.pool.query("CREATE FUNCTION refuse_notebook_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='assistant' THEN RAISE EXCEPTION 'PRIVATE answer failure'; END IF; RETURN NEW; END $$");await db.pool.query('CREATE TRIGGER refuse_notebook_answer BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION refuse_notebook_answer()');
 try{await perform(receipt.run_id);expect(fetches).toBe(1);expect((await db.pool.query('SELECT version FROM notes WHERE object_id=$1',[note.id])).rows).toEqual([{version:note.version}]);expect((await db.pool.query('SELECT id FROM note_revisions WHERE created_by_run_id=$1',[receipt.run_id])).rows).toEqual([]);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows).toEqual([{status:'failed'}]);}finally{await db.pool.query('DROP TRIGGER refuse_notebook_answer ON messages');await db.pool.query('DROP FUNCTION refuse_notebook_answer()');}
});
it('creates a requested new Note through the canonical writer exactly once',async()=>{
 reply({answer:'Created it',notebook_update:{note_id:null,new_note_title:'Generated',ops:[{op:'append',index:null,count:null,markdown:'New finding'}],refs:[]}});const r=await call(input());expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data;
 await perform(receipt.run_id);await perform(receipt.run_id);expect(fetches).toBe(1);const notes=(await db.pool.query("SELECT so.id,n.version,n.content_json FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id WHERE so.space_id=$1 AND so.primary_project_id=$2 AND so.title='Generated'",[space,project])).rows;expect(notes).toHaveLength(1);expect(JSON.stringify(notes[0]!.content_json)).toContain('New finding');expect((await db.pool.query('SELECT id FROM note_revisions WHERE note_id=$1 AND created_by_run_id=$2',[notes[0]!.id,receipt.run_id])).rows).toHaveLength(1);
});
it('suppresses receipt and result delivery when its personal Session is closed',async()=>{
 const key=randomUUID(),body=input(),r=await call(body,key);expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data;await db.pool.query("UPDATE sessions SET status='archived' WHERE id=$1",[receipt.session_id]);expect((await call(body,key)).statusCode).toBe(404);expect((await app.inject({method:'GET',url:`/api/v1/projects/${project}/notebook-chat/${receipt.run_id}`})).statusCode).toBe(404);await perform(receipt.run_id);expect(fetches).toBe(0);
});
it('revalidates Source provenance carried by a previous answer before sending follow-up history',async()=>{
 const item=await material(),first=await call({...input('First question'),source_item_ids:[item]});expect(first.statusCode,first.body).toBe(201);const original=first.json().data;await perform(original.run_id);expect(fetches).toBe(1);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE source_items SET visibility='private',owner_user_id=$2 WHERE id=$1",[item,peer]);
 const second=await call({...input('Follow-up'),session_id:original.session_id});expect(second.statusCode,second.body).toBe(201);await perform(second.json().data.run_id);expect(fetches).toBe(1);expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[second.json().data.run_id])).rows).toEqual([{status:'failed'}]);
 const fresh=await call(input('A separate discussion'));expect(fresh.statusCode,fresh.body).toBe(201);await perform(fresh.json().data.run_id);expect(fetches).toBe(2);
});
it('declines an unsafe new shared Note without leaving an empty scaffold while retaining the private answer',async()=>{
 const identity={spaceId:space,userId:user},service=new ProjectResearchAreaService(db.pool,config);await service.initializeArea(identity,project);const note=await new PgKnowledgeRepository(db.pool).createNote(identity,{title:'PRIVATE context',primary_project_id:project,plain_text:'PRIVATE context words'});await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1",[note.id]);const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
 reply({answer:'PRIVATE answer',notebook_update:{note_id:null,new_note_title:'Unsafe new Note',ops:[{op:'append',index:null,count:null,markdown:'PRIVATE context words'}],refs:[]}});const r=await call(input());expect(r.statusCode,r.body).toBe(201);const receipt=r.json().data;await perform(receipt.run_id);expect(await service.notebookChatResult(identity,project,receipt.run_id)).toMatchObject({pending:false,ok:true,reply:'PRIVATE answer',notebook_edit:null});expect((await db.pool.query("SELECT id FROM space_objects WHERE space_id=$1 AND title='Unsafe new Note'",[space])).rows).toEqual([]);
});
it('holds the Project owning a context Note\'s Folder: member removal there waits for a checked attempt, then refuses the next one',async()=>{
 const identity={spaceId:space,userId:user},note=(await new ProjectResearchAreaService(db.pool,config).initializeArea(identity,project)).notes[0]!;
 const peer=randomUUID(),third=randomUUID(),folder=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Third','active',now(),now())",[third,space,peer]);
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,third,user]);
 await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,status,kind,protected,system_managed,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'Third folder','active','code',false,false,$4,now(),now())",[folder,space,third,peer]);
 await db.pool.query('UPDATE space_objects SET project_folder_id=$2 WHERE id=$1',[note.id,folder]);
 const contract={source_item_ids:[],note_refs:[{id:note.id}],session_id:null,provider_id:provider,model_name:null};
 const authorize=(client:Queryable)=>authorizeNotebookChatAttempt(client,config,identity,project,contract);
 await expect(withTransaction(db.pool,authorize)).resolves.toBeUndefined();
 let checked!:()=>void,commit!:()=>void;const afterCheck=new Promise<void>(r=>{checked=r;}),mayCommit=new Promise<void>(r=>{commit=r;});
 const attempting=withTransaction(db.pool,async client=>{await authorize(client);checked();await mayCommit;});
 await afterCheck;
 const removing=new PgProjectRepository(db.pool).removeMember({spaceId:space,userId:peer},third,user);
 try{
  for(let i=0;;i++){if(Number((await db.pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n)>=1)break;if(i>300)throw new Error('the member removal never waited');await new Promise(r=>setTimeout(r,10));}
 }finally{commit();}
 await attempting;await removing;
 await expect(withTransaction(db.pool,authorize)).rejects.toMatchObject({statusCode:404});
});
