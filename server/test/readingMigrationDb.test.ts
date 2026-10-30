import { retainReaderBody } from './support/readingMaterial.js';
import { randomUUID } from 'node:crypto';
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
