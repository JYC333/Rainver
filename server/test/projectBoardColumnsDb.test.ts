import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedSpaceMember } from './support/domainSeeds.js';
import { configureProjectBoard } from '../src/modules/projectWork/boardConfiguration.js';
import { getProjectBoard } from '../src/modules/projectWork/boardReadModel.js';
import { PgTaskRepository } from '../src/modules/tasks/repository.js';

const db=useTestDatabase(import.meta.filename);
const space=randomUUID(),owner=randomUUID(),project=randomUUID();
const identity={spaceId:space,userId:owner};
const repo=()=>new PgTaskRepository(db.pool);
const read=()=>getProjectBoard(db.pool,identity,project);
const payload=(board:Awaited<ReturnType<typeof read>>)=>({revision:board.columns_revision,columns:board.columns.filter(c=>c.status_key).map(({key,label,status_key,wip_limit})=>({key,label,status_key,wip_limit})),moves:{} as Record<string,string>});
beforeEach(async()=>{await resetTables(db.pool,['spaces','users'],{cascade:true});await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});});

it('persists Project-specific column names and order, and two columns with the same lifecycle',async()=>{
  const task=await repo().createTask(identity,{title:'Design',project_id:project,status:'ready'});
  const before=await read(),body=payload(before);
  body.columns=[{key:'new:design',label:'Design',status_key:'in_progress',wip_limit:2},...body.columns.map(c=>({...c,label:`Local ${c.label}`}))];
  await configureProjectBoard(db.pool,identity,project,body);
  const after=await read();expect(after.columns[0].label).toBe('Design');expect(after.cards.find(c=>c.id===task.id)?.column_key).toBe(after.columns.find(c=>c.status_key==='ready')?.key);
  const design=after.columns[0];
  await repo().updateTask(identity,task.id,{column_id:design.key});
  const moved=await read();expect(moved.cards[0]).toMatchObject({status:'in_progress',column_key:design.key});
  const elsewhere=randomUUID();await db.pool.query(`INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Other','active',$3,now(),now())`,[elsewhere,space,owner]);
  expect((await getProjectBoard(db.pool,identity,elsewhere)).columns[0].label).toBe('Inbox');
  await expect(repo().createTask(identity,{title:'Invalid',project_id:elsewhere,column_id:design.key})).rejects.toMatchObject({statusCode:404});
  await expect(configureProjectBoard(db.pool,identity,project,body)).rejects.toMatchObject({statusCode:409});
});

it('deleting a populated column relocates Tasks through normal status gates and is atomic',async()=>{
  const task=await repo().createTask(identity,{title:'Not accepted',project_id:project,status:'ready',required_outputs_json:['report']});
  const original=await read(),body=payload(original);
  body.columns=body.columns.filter(c=>c.key!=='ready');body.moves.ready='done';
  await expect(configureProjectBoard(db.pool,identity,project,body)).rejects.toMatchObject({statusCode:422});
  expect((await read()).columns_revision).toBe(original.columns_revision);
  expect((await repo().getTask(identity,task.id))?.status).toBe('ready');
  body.moves.ready='in_progress';await configureProjectBoard(db.pool,identity,project,body);
  const after=await read();expect(after.columns.some(c=>c.status_key==='ready')).toBe(false);expect(after.cards[0].status).toBe('in_progress');
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_work_events WHERE subject_id=$1 AND event_kind='task.flow_changed'`,[task.id])).rows[0].n).toBe(1);
});

it('an Agent status update leaves a custom lane when its lifecycle changes; an unconfigured status stays visible',async()=>{
  await configureProjectBoard(db.pool,identity,project,{revision:(await read()).columns_revision,columns:[{key:'new:work',label:'Build',status_key:'in_progress',wip_limit:null}]});
  const column=(await read()).columns[0];const task=await repo().createTask(identity,{title:'Build',project_id:project,column_id:column.key});
  await repo().updateTask(identity,task.id,{status:'waiting_for_review'});
  const after=await read();expect(after.cards[0].column_key).toBe('unassigned');expect(after.columns.find(c=>c.key==='unassigned')?.count).toBe(1);
});

it('rejects duplicate keys, empty configuration and foreign destinations without partial changes',async()=>{
  const initial=await read(),body=payload(initial);
  await expect(configureProjectBoard(db.pool,identity,project,{...body,columns:[]})).rejects.toMatchObject({statusCode:422});
  await expect(configureProjectBoard(db.pool,identity,project,{...body,columns:[body.columns[0],body.columns[0]]})).rejects.toMatchObject({statusCode:422});
  const task=await repo().createTask(identity,{title:'Kept',project_id:project,status:'ready'});
  const foreign=randomUUID();await expect(repo().updateTask(identity,task.id,{column_id:foreign})).rejects.toMatchObject({statusCode:404});
  expect((await read()).columns_revision).toBe(initial.columns_revision);
});

it('serializes competing editors and refuses to relocate another member private Task',async()=>{
  const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())",[randomUUID(),space,project,other]);
  const initial=await read(),body=payload(initial);
  await expect(configureProjectBoard(db.pool,{spaceId:space,userId:other},project,body)).rejects.toMatchObject({statusCode:403});
  await db.pool.query("UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",[project,other]);
  await repo().createTask(identity,{title:'Private',project_id:project,status:'ready',visibility:'private'});
  const deletion={...body,columns:body.columns.filter(c=>c.key!=='ready'),moves:{ready:'in_progress'}};
  await expect(configureProjectBoard(db.pool,{spaceId:space,userId:other},project,deletion)).rejects.toMatchObject({statusCode:404});
  expect((await read()).columns_revision).toBe(initial.columns_revision);
  const [a,b]=await Promise.allSettled([configureProjectBoard(db.pool,identity,project,{...body,columns:body.columns.map(c=>({...c,label:'Editor A '+c.label}))}),configureProjectBoard(db.pool,identity,project,{...body,columns:body.columns.map(c=>({...c,label:'Editor B '+c.label}))})]);
  expect([a,b].filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect([a,b].filter(x=>x.status==='rejected')).toHaveLength(1);
});
