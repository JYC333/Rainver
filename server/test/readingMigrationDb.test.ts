import {projectReadingRecords} from '../src/modules/reader/readingRecords.js';
import { retainReaderBody } from './support/readingMaterial.js';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, it, expect } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject } from './support/domainSeeds.js';
import { seedRelevantCorpusItem } from './support/researchSeeds.js';
import { migrate } from '../src/db/migrator.js';
import { convertMigrationHistory } from '../src/db/migrationConversion.js';
import { loadSquashPlan } from '../src/db/migrationSquash.js';
import { ReadingService } from '../src/modules/informationDigest/readingService.js';
import { ReadingPreferences } from '../src/modules/informationDigest/readingPreferences.js';

const db=useTestDatabase(import.meta.filename,{empty:true});
const prefix=mkdtempSync(join(tmpdir(),'rainver-reading-upgrade-'));
afterAll(()=>rmSync(prefix,{recursive:true,force:true}));
// Reconstruct the exact unpublished source chain from its ordered composition.
// This keeps upgrade tests independent of local archives and Git availability.
const migrations=join(import.meta.dirname,'../migrations');
const branchSource=join(prefix,'branch-source');mkdirSync(branchSource);
for(const f of readdirSync(migrations).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<7))cpSync(join(migrations,f),join(branchSource,f));
const sourceSteps=[
 ['0007_information_briefings','c42f3a61b2f375b62dc7661f9a13bce003b25418eb306ce7005317b6f5e26443'],
 ['0008_source_goal_manual_versions','0e939dab9d27c185fff41576572defb4996ccc7397bde7271ee1a1c4a2e261d1'],
 ['0009_project_reading_analysis','1cd34d422afea975783e0e83468b1c122d988f11828ad1445c65a043c01fa337'],
 ['0010_project_reading_rounds','b061010da8eb5fa8deadae404eff49a27adede33854462030548cd0aacf3066d'],
 ['0011_project_reading_compositions','f2e97834b0dd6d692a9a8105f6957b86c32f5212443597d04792abf1549933a1'],
 ['0012_project_private_deep_reading','7b1f4d204947ecbac7459991395c66af66dc0b8631c0d1de5d0cec37a957d6b5'],
];
const branchSql=readFileSync(join(migrations,'0007_project_reading.sql'),'utf8').split('\n\nRESET search_path;\n');
expect(branchSql.pop()).toBe('');expect(branchSql).toHaveLength(sourceSteps.length);
sourceSteps.forEach(([tag,checksum],i)=>{
 const sql=i===0?branchSql[i]:branchSql[i].slice(1);
 expect(createHash('sha256').update(sql).digest('hex')).toBe(checksum);
 writeFileSync(join(branchSource,`${tag}.sql`),sql);
});
const branchTarget=join(prefix,'branch-target');mkdirSync(branchTarget);
for(const file of readdirSync(migrations).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=7))cpSync(join(migrations,file),join(branchTarget,file));
expect(loadSquashPlan(branchSource,branchTarget).suffix).toHaveLength(6);
const convertBranch=()=>convertMigrationHistory(db.pool,branchSource,branchTarget,{apply:true,offline:true,backupReference:'disposable-test-database'});

it('upgrades retained material, private state, preferences and old daily snapshots without a reset', async () => {
  const migrations=join(import.meta.dirname,'../migrations');
  // Reconstruct the historical pre-reading boundary from the exact composed
  // SQL. The formal chain is exercised below via the real history converter;
  // no external instance archive or private database is a test dependency.
  const source=join(prefix,'historical');mkdirSync(source);
  for(const name of readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0,4))<5)) cpSync(join(migrations,name),join(source,name));
  const formal=readFileSync(join(migrations,'0005_project_reading_and_source_goals.sql'),'utf8');
  const steps=formal.split('\n\nRESET search_path;\n');
  expect(steps.pop()).toBe('');
  expect(steps).toHaveLength(18);
  steps.forEach((sql,i)=>writeFileSync(join(source,`${String(i+5).padStart(4,'0')}_historical_step.sql`),i===0?sql:sql.slice(1)));
  // The squash target is the formal chain through 0005; later migrations
  // append normally and are applied on the converted database below.
  const formalChain=join(prefix,'formal');mkdirSync(formalChain);
  for(const name of readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0,4))<=5)) cpSync(join(migrations,name),join(formalChain,name));
  const later=readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0,4))>5).sort().map(n=>n.slice(0,4));
  expect(loadSquashPlan(source,formalChain).suffix).toHaveLength(18);
  for(const name of readdirSync(source).filter(n=>/^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0,4))<9)) cpSync(join(source,name),join(prefix,name));
  await migrate(db.pool,prefix);
  const space=randomUUID(),owner=randomUUID(),project=randomUUID(),identity={spaceId:space,userId:owner};
  await seedSpaceOwnerProject(db.pool,{space,owner,project});
  const {sourceItemId}=await seedRelevantCorpusItem(db.pool,{space,owner,project});
  await db.pool.query('UPDATE source_items SET content_hash=$2 WHERE id=$1',[sourceItemId,'retained-revision']);
  await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,created_at,updated_at) VALUES($1,$2,$3,$4,'read','library',now(),now())`,[randomUUID(),space,sourceItemId,owner]);
  await retainReaderBody(db.pool,{space,owner,item:sourceItemId,text:'Existing retained body before upgrade'});
  await new ReadingPreferences(db.pool).set(identity,project,true);
  const digest=randomUUID();
  await db.pool.query(`INSERT INTO information_digests(id,space_id,digest_type,owner_user_id,digest_date,period_start_utc,period_end_utc,generated_at,created_at,updated_at) VALUES($1,$2,'personal',$3,'2026-01-01','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','2026-01-02T01:00:00Z',now(),now())`,[digest,space,owner]);
  await db.pool.query(`INSERT INTO information_digest_items(id,space_id,digest_id,source_item_id,section,position,quota_slot,score,rationale,created_at) VALUES($1,$2,$3,$4,'interest',0,'interest',1,'Original retained reason',now())`,[randomUUID(),space,digest,sourceItemId]);
  const before=(await db.pool.query('SELECT row_to_json(d) AS snapshot FROM information_digests d WHERE id=$1',[digest])).rows[0];
  // This pool belongs to an empty, disposable shared-test PostgreSQL database.
  // Production conversion still requires explicit offline/backup authorization.
  const converted=await convertMigrationHistory(db.pool,source,formalChain,{apply:true,offline:true,backupReference:'disposable-test-database'});
  expect(converted.state).toBe('converted');
  expect(converted.pending).toHaveLength(14);
  expect((await migrate(db.pool,migrations)).applied).toEqual(later);
  expect((await db.pool.query('SELECT read_status,read_origin,read_body_revision FROM source_item_user_states WHERE source_item_id=$1',[sourceItemId])).rows[0]).toEqual({read_status:'read',read_origin:'library',read_body_revision:0});
  expect((await db.pool.query('SELECT row_to_json(d) AS snapshot FROM information_digests d WHERE id=$1',[digest])).rows[0]).toEqual(before);
  expect(await new ReadingPreferences(db.pool).get(identity,project)).toEqual({show_in_my_reading:true});
  expect((await db.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='source_item_user_states' AND column_name='read_content_hash'`)).rows).toEqual([]);
  expect((await db.pool.query(`SELECT proname FROM pg_proc WHERE proname LIKE 'source_reading_%' AND prosrc LIKE '%read_content_hash%'`)).rows).toEqual([]);
  const service=new ReadingService(db.pool);
  expect((await service.list(identity,{view:'pending',limit:30})).items).toHaveLength(0);
  expect((await service.list(identity,{view:'read',limit:30})).items[0].contributions[0].rationale).toBe('Original retained reason');
  expect((await db.pool.query('SELECT reading_body_revision,reading_body_hash FROM source_items WHERE id=$1',[sourceItemId])).rows[0]).toMatchObject({reading_body_revision:0,reading_body_hash:expect.stringMatching(/^[a-f0-9]{64}$/)});
  await retainReaderBody(db.pool,{space,owner,item:sourceItemId,text:'A changed retained body after upgrade'});
  expect((await service.list(identity,{view:'pending',limit:30})).items).toHaveLength(1);
  await db.pool.query("UPDATE source_item_user_states SET read_status='discussed',updated_at=now() WHERE source_item_id=$1",[sourceItemId]);
  expect((await service.list(identity,{view:'read',limit:30})).items[0].read_status).toBe('discussed');
  expect((await migrate(db.pool,migrations)).applied).toEqual([]);
  expect((await db.pool.query('SELECT read_origin,read_body_revision FROM source_item_user_states WHERE source_item_id=$1',[sourceItemId])).rows[0]).toEqual({read_origin:'library',read_body_revision:1});
});

it('applies 0000-0008 to empty PG then upgrades existing legacy material without rewriting body/state/identity',async()=>{
 await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;');
 const migrations=join(import.meta.dirname,'../migrations'),prefix=mkdtempSync(join(tmpdir(),'reading-r1-upgrade-'));
 try{
  for(const file of readdirSync(branchSource).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=8))cpSync(join(branchSource,file),join(prefix,file));
  expect((await migrate(db.pool,prefix)).applied).toHaveLength(9);
  const space=randomUUID(),owner=randomUUID(),project=randomUUID(),item=randomUUID(),artifact=randomUUID(),snapshot=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space,owner,project});
  const content=JSON.stringify({schema_version:1,kind:'reader_document',extraction_method:'agent_provided_v1',plain_text:'Legacy analysis',content_json:{type:'doc',content:[]},image_count:0,image_policy:'none'});
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,content_hash,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at) VALUES($1,$2,$3,$4,$4,'private','external_url','Legacy','oldhash','content_saved','full_text',now(),now(),now(),now())`,[item,space,project,owner]);
  await db.pool.query(`INSERT INTO artifacts(id,space_id,project_id,owner_user_id,visibility,artifact_type,title,content,mime_type,canonical_format,export_formats_json,metadata_json,created_at,updated_at) VALUES($1,$2,$3,$4,'private','source_reader_document','Legacy',$5,'application/json','reader_document_json','[]','{"extraction_method":"agent_provided_v1"}',now(),now())`,[artifact,space,project,owner,content]);
  await db.pool.query(`INSERT INTO source_snapshots(id,space_id,project_id,source_item_id,artifact_id,snapshot_type,capture_method,trust_level,owner_user_id,visibility,captured_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'extracted','full_text','untrusted',$6,'private',now(),now(),now())`,[snapshot,space,project,item,artifact,owner]);
  await db.pool.query('UPDATE source_items SET extracted_artifact_id=$2 WHERE id=$1',[item,artifact]);
  const before=(await db.pool.query('SELECT row_to_json(i) AS value FROM source_items i WHERE id=$1',[item])).rows[0].value;
  const upgrade=await convertBranch();expect(upgrade.state).toBe('converted');expect(upgrade.pending.map(f=>f.slice(0,4))).toEqual(['0009','0010','0011','0012']);
  expect((await db.pool.query('SELECT row_to_json(i) AS value FROM source_items i WHERE id=$1',[item])).rows[0].value).toEqual(before);
  expect((await db.pool.query('SELECT content FROM artifacts WHERE id=$1',[artifact])).rows[0].content).toBe(content);
  // Complete the release schema before invoking its new application readers.
  expect((await migrate(db.pool,migrations)).applied).toEqual(readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&Number(n.slice(0,4))>=8).sort().map(n=>n.slice(0,4)));
  const records=await projectReadingRecords(db.pool,{spaceId:space,userId:owner},item);expect(records.items[0]).toMatchObject({snapshot_id:snapshot,artifact_id:artifact,role:'legacy_analysis',format:'undeclared'});expect(records.original_availability).toBe('unknown');
 }finally{rmSync(prefix,{recursive:true,force:true});}
},120000);

it('upgrades the exact committed R1 chain through 0009 via formal history conversion, preserving existing Goal data',async()=>{
 await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;');
 const migrations=join(import.meta.dirname,'../migrations'),old=mkdtempSync(join(tmpdir(),'reading-r2-upgrade-'));
 try{
  for(const f of readdirSync(branchSource).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=9))cpSync(join(branchSource,f),join(old,f));
  expect((await migrate(db.pool,old)).applied).toHaveLength(10);
  const space=randomUUID(),owner=randomUUID(),project=randomUUID(),goal=randomUUID(),version=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner,project});
  await db.pool.query(`INSERT INTO source_goals(id,space_id,project_id,owner_user_id,intent_json,budget_json,status) VALUES($1,$2,$3,$4,'{"intent":"Original R1 purpose"}','{}','running')`,[goal,space,project,owner]);
  await db.pool.query(`INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_user_id) VALUES($1,$2,$3,1,'{"summary":"Existing purpose"}',$4)`,[version,space,goal,owner]);
  const before=(await db.pool.query('SELECT row_to_json(g) AS value FROM source_goals g WHERE id=$1',[goal])).rows[0].value;
  expect((await convertBranch()).pending.map(f=>f.slice(0,4))).toEqual(['0010','0011','0012']);
  expect((await db.pool.query('SELECT row_to_json(g) AS value FROM source_goals g WHERE id=$1',[goal])).rows[0].value).toEqual(before);
  const values=[randomUUID(),space,project,goal,version];
  await db.pool.query(`INSERT INTO project_reading_rounds(id,space_id,project_id,goal_id,version_id,sequence,slot_key,targets_json,execution_json,deadline_at) VALUES($1,$2,$3,$4,$5,1,'stable-slot','[]','{}',now())`,values);
  await expect(db.pool.query(`INSERT INTO project_reading_rounds(id,space_id,project_id,goal_id,version_id,sequence,slot_key,targets_json,execution_json,deadline_at) VALUES($1,$2,$3,$4,$5,2,'stable-slot','[]','{}',now())`,[randomUUID(),space,project,goal,version])).rejects.toMatchObject({code:'23505'});
  const otherSpace=randomUUID(),otherOwner=randomUUID(),otherProject=randomUUID();await seedSpaceOwnerProject(db.pool,{space:otherSpace,owner:otherOwner,project:otherProject});
  await expect(db.pool.query(`INSERT INTO project_reading_rounds(id,space_id,project_id,goal_id,version_id,sequence,slot_key,targets_json,execution_json,deadline_at) VALUES($1,$2,$3,$4,$5,1,'cross-space','[]','{}',now())`,[randomUUID(),otherSpace,otherProject,goal,version])).rejects.toMatchObject({code:'23503'});
  expect((await migrate(db.pool,migrations)).applied).toEqual(readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&Number(n.slice(0,4))>=8).sort().map(n=>n.slice(0,4)));
 }finally{rmSync(old,{recursive:true,force:true});}
},120000);

it('upgrades exact committed R2 to 0011 without changing existing Project data',async()=>{
 await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;');
 const migrations=join(import.meta.dirname,'../migrations'),old=mkdtempSync(join(tmpdir(),'reading-r3-upgrade-'));
 try{
  for(const f of readdirSync(branchSource).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=10))cpSync(join(branchSource,f),join(old,f));
  expect((await migrate(db.pool,old)).applied).toHaveLength(11);
  const space=randomUUID(),owner=randomUUID(),project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner,project});
  const before=(await db.pool.query('SELECT row_to_json(p) AS value FROM projects p WHERE id=$1',[project])).rows[0].value;
  expect((await convertBranch()).pending.map(f=>f.slice(0,4))).toEqual(['0011','0012']);
  expect((await db.pool.query('SELECT row_to_json(p) AS value FROM projects p WHERE id=$1',[project])).rows[0].value).toEqual(before);
  await db.pool.query("INSERT INTO project_reading_compositions(id,space_id,project_id,revision,sections_json,reason) VALUES($1,$2,$3,1,'[]','theme_terminal')",[randomUUID(),space,project]);
  await expect(db.pool.query("INSERT INTO project_reading_compositions(id,space_id,project_id,revision,sections_json,reason) VALUES($1,$2,$3,1,'[]','theme_terminal')",[randomUUID(),space,project])).rejects.toMatchObject({code:'23505'});
  await expect(db.pool.query("INSERT INTO project_reading_compositions(id,space_id,project_id,revision,sections_json,reason) VALUES($1,$2,$3,1,'[]','theme_terminal')",[randomUUID(),randomUUID(),project])).rejects.toMatchObject({code:'23503'});
  expect((await migrate(db.pool,migrations)).applied).toEqual(readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&Number(n.slice(0,4))>=8).sort().map(n=>n.slice(0,4)));
 }finally{rmSync(old,{recursive:true,force:true});}
},120000);


it('upgrades exact R3 with favorite default false without changing private progress or original identity',async()=>{
 await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;');
 const migrations=join(import.meta.dirname,'../migrations'),old=mkdtempSync(join(tmpdir(),'reading-r4-upgrade-'));
 try{
  for(const f of readdirSync(branchSource).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<=11))cpSync(join(branchSource,f),join(old,f));
  expect((await migrate(db.pool,old)).applied).toHaveLength(12);const space=randomUUID(),owner=randomUUID(),project=randomUUID(),item=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner,project});
  await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,item_type,title,content_state,retention_policy,created_at,updated_at,first_seen_at,last_seen_at) VALUES($1,$2,$3,'external_url','Retained','metadata_only','metadata_only',now(),now(),now(),now())",[item,space,owner]);
  const state=randomUUID();await db.pool.query("INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,progress_json,created_at,updated_at) VALUES($1,$2,$3,$4,'read','{\"fraction\":0.73}',now(),now())",[state,space,item,owner]);
  const before=(await db.pool.query('SELECT row_to_json(s) AS value FROM source_item_user_states s WHERE id=$1',[state])).rows[0].value;
  expect((await convertBranch()).pending.map(f=>f.slice(0,4))).toEqual(['0012']);const after=(await db.pool.query('SELECT row_to_json(s) AS value FROM source_item_user_states s WHERE id=$1',[state])).rows[0].value;expect(after).toEqual({...before,favorite:false});expect((await migrate(db.pool,migrations)).applied).toEqual(readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&Number(n.slice(0,4))>=8).sort().map(n=>n.slice(0,4)));
 }finally{rmSync(old,{recursive:true,force:true});}
},120000);


it('converts both the published prefix and fully applied development chain without resetting data; repetition is a no-op',async()=>{
 for(const count of [7,13]){
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;');
  const old=mkdtempSync(join(tmpdir(),'reading-branch-boundary-'));
  try{
   for(const f of readdirSync(branchSource).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&Number(f.slice(0,4))<count))cpSync(join(branchSource,f),join(old,f));
   expect((await migrate(db.pool,old)).applied).toHaveLength(count);
   const space=randomUUID(),owner=randomUUID(),project=randomUUID();await seedSpaceOwnerProject(db.pool,{space,owner,project});
   const before=(await db.pool.query('SELECT row_to_json(p) AS value FROM projects p WHERE id=$1',[project])).rows[0].value;
   const result=await convertBranch();expect(result.state).toBe('converted');expect(result.pending).toHaveLength(13-count);
   expect((await db.pool.query('SELECT row_to_json(p) AS value FROM projects p WHERE id=$1',[project])).rows[0].value).toEqual(before);
   expect((await migrate(db.pool,migrations)).applied).toEqual(readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&Number(n.slice(0,4))>=8).sort().map(n=>n.slice(0,4)));
   expect((await convertBranch()).state).toBe('beyond_target');
  }finally{rmSync(old,{recursive:true,force:true});}
 }
},120000);

it('adds daily identity without rewriting old overview references or collection audits',async()=>{
 // This is this test file's disposable database, never a running instance.
 await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;');
 await migrate(db.pool,branchTarget);
 const space=randomUUID(),owner=randomUUID(),project=randomUUID(),goal=randomUUID(),audit=randomUUID(),composition=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project});
 await db.pool.query(`INSERT INTO source_goals(id,space_id,project_id,owner_user_id,intent_json,budget_json,status) VALUES($1,$2,$3,$4,'{}','{}','paused')`,[goal,space,project,owner]);
 await db.pool.query("INSERT INTO source_goal_runs(id,space_id,goal_id,version_id,status,result_json) VALUES($1,$2,$3,$4,'insufficient','{}')",[audit,space,goal,randomUUID()]);
 const refs=[{goal_id:goal,briefing_id:randomUUID(),published_at:'2026-10-01T00:00:00Z'}];
 await db.pool.query("INSERT INTO project_reading_compositions(id,space_id,project_id,revision,sections_json,reason) VALUES($1,$2,$3,17,$4,'theme_terminal')",[composition,space,project,JSON.stringify(refs)]);
 expect((await migrate(db.pool,migrations)).applied).toEqual(readdirSync(migrations).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&Number(n.slice(0,4))>=8).sort().map(n=>n.slice(0,4)));
 expect((await db.pool.query('SELECT revision,sections_json,edition_date,timezone,day_revision,rounds_json FROM project_reading_compositions WHERE id=$1',[composition])).rows[0]).toEqual({revision:17,sections_json:refs,edition_date:null,timezone:null,day_revision:null,rounds_json:[]});
 expect((await db.pool.query('SELECT status,result_json,reading_date,reading_timezone FROM source_goal_runs WHERE id=$1',[audit])).rows[0]).toEqual({status:'insufficient',result_json:{},reading_date:null,reading_timezone:null});
 await expect(db.pool.query("UPDATE project_reading_compositions SET edition_date='2026-11-02',timezone='UTC' WHERE id=$1",[composition])).rejects.toMatchObject({code:'23514'});
 await expect(db.pool.query("UPDATE source_goal_runs SET reading_date='2026-11-02' WHERE id=$1",[audit])).rejects.toMatchObject({code:'23514'});
});
