import { SourceReadingStateService } from '../src/modules/sources/readingState.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream } from './support/mockUpstream.js';
import { fixtureServerGuard } from './support/outboundGuard.js';
import { SourceExtractionWorker } from '../src/modules/sources/extractionWorker.js';
import { PgSourcesRepository } from '../src/modules/sources/repository.js';
import { projectReaderIds } from '../src/modules/projects/access.js';
import { projectReadingAudienceClause } from '../src/modules/sources/readingMaterial.js';
import { retainReaderBody } from './support/readingMaterial.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject, seedMainlineRoomsForAllProjects } from './support/domainSeeds.js';
import { resetTables } from './support/resetTables.js';
import { ReadingService } from '../src/modules/informationDigest/readingService.js';
import { ReadingPreferences } from '../src/modules/informationDigest/readingPreferences.js';
import { ProjectSourceBindingService } from '../src/modules/projects/projectSourceBindingService.js';
import { PgSourceAnnotationRepository } from '../src/modules/sourceAnnotation/repository.js';
import { InterestProfileService } from '../src/modules/interestProfile/service.js';
import { PgSerendipityRepository } from '../src/modules/informationDigest/serendipityRepository.js';
import { PgInterestProfileRepository } from '../src/modules/interestProfile/repository.js';
import { ProjectCorpusRepository } from '../src/modules/projects/corpusRepository.js';
import { PgReaderRepository } from '../src/modules/reader/repository.js';
import { ReadingRepository } from '../src/modules/informationDigest/readingRepository.js';
import { seedArxivSourceChain } from './support/researchSeeds.js';
import { loadConfig } from '../src/config.js';
import { ReadingPageSchema, ReadingStateResultSchema } from '@rainver/protocol';
import { buildModuleServer } from './support/moduleServer.js';
import { informationDigestModule } from '../src/modules/informationDigest/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID(), other = randomUUID();
const identity = { spaceId: space, userId: owner };
const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
const service = () => new ReadingService(db.pool);
const preferences = () => new ReadingPreferences(db.pool);
const list = (view: 'pending' | 'read' | 'all' = 'pending', limit = 30, cursor?: string, projectId?: string) => service().list(identity, { view, limit, cursor }, projectId);
const past = '2026-01-01T12:00:00Z';
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces','users','source_connectors','source_providers','source_provider_connectors'], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project, spaceType: 'team' });
  await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active',$2,'system',now(),now())`, [other, `${other}@test.invalid`]);
  await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, other]);
  await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), space, project, other]);
});
afterEach(() => __setAuthIdentityForTests(null));
async function item(options: { project?: string; canonical?: string; hash?: string; title?: string; private?: boolean } = {}) {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,canonical_uri,source_uri,content_hash,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$4,$5,'external_url',$6,$7,$7,$8,'metadata_only','metadata_only',$9,$9,$9,$9)`,
  [id,space,options.project ?? null,owner,options.private ? 'private' : 'space_shared',options.title ?? 'Article',options.canonical ?? `https://example.test/${id}`,options.hash ?? 'hash',past]);
  return id;
}
async function digest(ids: string[], projectId?: string, date = '2026-01-01') {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO information_digests(id,space_id,digest_type,owner_user_id,project_id,digest_date,period_start_utc,period_end_utc,generated_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$8)`, [id,space,projectId ? 'project' : 'personal',projectId ? null : owner,projectId ?? null,date,`${date}T00:00:00Z`,`${date}T23:00:00Z`]);
  for (const [position, source] of ids.entries()) {
    await db.pool.query(`INSERT INTO information_digest_items(id,space_id,digest_id,source_item_id,section,position,quota_slot,score,rationale,created_at) VALUES($1,$2,$3,$4,'interest',$5,'interest',1,'Original reason',$6)`, [randomUUID(),space,id,source,position,past]);
  }
  return id;
}

describe('unified reading', () => {
  it.each([
    ['serendipity', 'mark_selected'], ['serendipity', 'read_later'], ['serendipity', 'mark_discussed'],
    ['project', 'mark_selected'], ['project', 'read_later'], ['project', 'mark_discussed'],
  ] as const)('Library %s → %s upgrades origin and enables only the reader’s own interest evidence', async (origin, action) => {
    const source=await item();
    await db.pool.query("UPDATE source_items SET excerpt='Retained body' WHERE id=$1",[source]);
    const annotations=new PgSourceAnnotationRepository(db.pool);
    await annotations.enqueueItems(space,[source],null);
    await annotations.markSucceeded(space,{source_item_id:source,domain_key:'technology.computing',depth:'analysis',genre:'explainer',summary:'s',topic_candidates:[],stance_target:null,stance_target_key:null,stance_polarity:'neutral',stance_confidence:0},null);
    const reader=new PgReaderRepository(db.pool,config());
    await reader.getDocument(identity,'source_item',source,{origin});
    const profile=new PgInterestProfileRepository(db.pool);
    expect(await profile.coverageByDomain(space,owner)).toHaveLength(0);
    await new PgSourcesRepository(db.pool,config()).itemAction(identity,source,{action});
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1 AND user_id=$2',[source,owner])).rows[0].read_origin).toBe('library');
    // A later open/completion through the original entry must retain the
    // reader's explicit Library reach, rather than reclassify it as discovery.
    await reader.getDocument(identity,'source_item',source,{origin});
    await new SourceReadingStateService(db.pool).update(identity,source,{read_status:'read'},origin);
    expect(await profile.coverageByDomain(space,owner)).toHaveLength(1);
    expect(await new InterestProfileService(db.pool).maturityInputs(space,owner)).toEqual({readItemCount:1,coveredDomainCount:1});
    expect(await profile.coverageByDomain(space,other)).toHaveLength(0);
  });
  it.each(['mark_selected','read_later','mark_discussed'] as const)('Library %s explicitly assigns library on a new private state', async action => {
    const source=await item();
    await new PgSourcesRepository(db.pool,config()).itemAction(identity,source,{action});
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1 AND user_id=$2',[source,owner])).rows[0].read_origin).toBe('library');
  });

  it('defaults off, isolates preferences, admits viewer writes and keeps old recommendations across days', async () => {
    const id = await item({ project }); await digest([id],project);
    expect((await list()).items).toHaveLength(0);
    await preferences().set({ spaceId: space,userId: other },project,true);
    expect((await list()).items).toHaveLength(0);
    expect((await preferences().get(identity,project)).show_in_my_reading).toBe(false);
    await preferences().set(identity,project,true);
    const page = ReadingPageSchema.parse(await list());
    expect(page.items[0].source_item_id).toBe(id);
    expect(page.items[0].contributions[0]).toMatchObject({ digest_date:'2026-01-01',timezone:'UTC',rationale:'Original reason' });
    await preferences().set(identity,project,false);
    expect((await list()).items).toHaveLength(0);
    expect((await list('pending',30,undefined,project)).items).toHaveLength(1);
  });
  it('merges equal canonical revisions before pagination, withdraws only one contribution and preserves read state', async () => {
    const a = await item({ canonical:'https://example.test/shared' });
    const b = await item({ canonical:'https://example.test/shared',project });
    const c = await item({ canonical:'https://example.test/third' });
    await digest([a,c]); await digest([b],project);
    await preferences().set(identity,project,true);
    const first = await list('pending',1);
    const second = await list('pending',1,first.next_cursor!);
    expect(first.total).toBe(2); expect(second.items).toHaveLength(1);
    expect(first.items[0].key).not.toBe(second.items[0].key);
    const merged = [...first.items,...second.items].find(i => i.source_item_ids.includes(a))!;
    expect(merged.source_item_ids.sort()).toEqual([a,b].sort());
    expect(merged.contributions).toHaveLength(2);
    await service().state(identity,a,{read_status:'read'});
    expect((await list()).total).toBe(1);
    expect((await list('read')).items[0].source_item_ids).toHaveLength(2);
    const states = await db.pool.query(`SELECT read_status,read_origin,first_opened_at FROM source_item_user_states WHERE space_id=$1 AND user_id=$2`,[space,owner]);
    expect(states.rows).toHaveLength(2);
    expect(states.rows.every(r=>r.read_status==='read' && r.first_opened_at===null)).toBe(true);
    expect(states.rows.map(r=>r.read_origin).sort()).toEqual(['library','project']);
    await preferences().set(identity,project,false);
    expect((await list('read')).items[0].contributions).toHaveLength(1);
    await service().state(identity,a,{read_status:'unread'});
    expect((await list()).total).toBe(2);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM information_digest_items')).rows[0].n).toBe(3);
  });
  it('keeps personal plus Project A/B reasons exact through every inclusion combination without deleting saved material', async () => {
    const second=randomUUID();
    await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Project B','active',now(),now())`,[second,space,owner]);
    await seedMainlineRoomsForAllProjects(db.pool);
    const personal=await item({canonical:'https://example.test/matrix'});
    const a=await item({canonical:'https://example.test/matrix',project});
    const b=await item({canonical:'https://example.test/matrix',project:second});
    const only=await item({project, title:'Project-only recommendation'});
    const editions=[await digest([personal]),await digest([a,only],project),await digest([b],second)];
    for(const [id,reason] of editions.map((id,n)=>[id,['Personal reason','A reason','B reason'][n]])) {
      await db.pool.query('UPDATE information_digest_items SET rationale=$2 WHERE digest_id=$1',[id,reason]);
    }
    await new PgSourcesRepository(db.pool,config()).itemAction(identity,personal,{action:'mark_selected'});
    for(const [includeA,includeB] of [[false,false],[true,false],[false,true],[true,true],[false,false]]) {
      await preferences().set(identity,project,includeA);
      await preferences().set(identity,second,includeB);
      const page=await list();
      expect(page.total).toBe(includeA?2:1);
      const shared=page.items.filter(row=>row.source_item_ids.includes(personal));
      expect(shared).toHaveLength(1);
      expect(shared[0].contributions.map(c=>c.rationale).sort()).toEqual(['Personal reason',...(includeA?['A reason']:[]),...(includeB?['B reason']:[])].sort());
      expect((await list('all')).items.some(row=>row.source_item_ids.includes(personal))).toBe(true);
    }
    expect((await db.pool.query('SELECT library_status FROM source_item_user_states WHERE source_item_id=$1 AND user_id=$2',[personal,owner])).rows[0].library_status).toBe('selected');
    expect((await db.pool.query('SELECT id FROM source_items WHERE id=ANY($1::varchar[])',[[personal,a,b,only]])).rows).toHaveLength(4);
    expect((await db.pool.query('SELECT id FROM information_digest_items WHERE digest_id=ANY($1::varchar[])',[editions])).rows).toHaveLength(4);
  });
  it('withdraws a revoked Project version, labels, reasons and counts while retaining the other version', async () => {
    const second=randomUUID();
    await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Private Project B','active',now(),now())`,[second,space,owner]);
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`,[randomUUID(),space,second,other]);
    await seedMainlineRoomsForAllProjects(db.pool);
    const a=await item({project,canonical:'https://example.test/revised',title:'Public A version'}), b=await item({project:second,canonical:'https://example.test/revised',title:'Private B version'});
    await retainReaderBody(db.pool,{space,owner,item:a,text:'Original published body'});
    await retainReaderBody(db.pool,{space,owner,item:b,text:'Revised published body'});
    await digest([a],project);const editionB=await digest([b],second);
    await db.pool.query("UPDATE information_digest_items SET rationale='Private B reason' WHERE digest_id=$1",[editionB]);
    const reader={spaceId:space,userId:other};
    await preferences().set(reader,project,true);await preferences().set(reader,second,true);
    const before=await service().list(reader,{view:'pending',limit:1});
    expect(before.total).toBe(2);expect(before.next_cursor).toBeTruthy();
    await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[second,other]);
    await expect(service().list(reader,{view:'pending',limit:1,cursor:before.next_cursor!})).rejects.toMatchObject({statusCode:409});
    const after=await service().list(reader,{view:'pending',limit:30});
    expect(after.total).toBe(1);expect(after.items[0].source_item_ids).toEqual([a]);
    expect(after.items[0].title).toBe('Public A version');
    expect(JSON.stringify(after)).not.toMatch(/Private Project B|Private B reason|Private B version/);
    expect(after.items.flatMap(row=>row.contributions).map(c=>c.project_id)).toEqual([project]);
  });
  it('keeps an existing cursor valid while the first unchanged body is retained', async () => {
    const a=await item({canonical:'https://example.test/shared'}),b=await item({canonical:'https://example.test/shared',project}),c=await item();
    await digest([a,c]);await digest([b],project);await preferences().set(identity,project,true);
    const first=await list('pending',1);expect(first.next_cursor).toBeTruthy();
    await retainReaderBody(db.pool,{space,owner,item:a,text:'First retained body'});
    const next=await list('pending',1,first.next_cursor!);
    expect(next.items).toHaveLength(1);expect(next.items[0].key).not.toBe(first.items[0].key);
    expect(next.total).toBe(2);
  });
  it('keeps different revisions apart and new content is not swallowed by a previous read', async () => {
    const a=await item({canonical:'https://example.test/shared',hash:'old'});
    const b=await item({canonical:'https://example.test/shared',hash:'new',project});
    await digest([a]);await digest([b],project);await preferences().set(identity,project,true);
    await service().state(identity,a,{read_status:'read'});
    expect((await list()).items.map(i=>i.source_item_id)).toEqual([b]);
    await retainReaderBody(db.pool,{space,owner,item:a,text:'Original retained body'});
    await retainReaderBody(db.pool,{space,owner,item:a,text:'Revised retained body'});
    expect((await list()).total).toBe(2);
    await service().state(identity,a,{dismissed:true});
    expect((await list()).items.map(i=>i.source_item_id)).toEqual([b]);
  });
  it('rechecks Project membership on a cursor and withholds all revoked contribution metadata', async () => {
    const a=await item();const b=await item({project});await digest([a]);await digest([b],project);
    const reader = { spaceId:space,userId:other };
    await preferences().set(reader,project,true);
    const page=await service().list(reader,{view:'pending',limit:1});
    expect(page.total).toBe(1);
    await db.pool.query(`UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2`,[project,other]);
    const after=await service().list(reader,{view:'pending',limit:1});
    expect(after).toMatchObject({total:0,items:[]});
    await expect(preferences().get(reader,project)).rejects.toThrow('Project not found');
  });
  it('personal dismissal does not change library triage or Project feedback', async () => {
    const a=await item();await digest([a]);
    await service().state(identity,a,{dismissed:true});expect((await list()).total).toBe(0);
    const all=await list('all');expect(all.items[0].dismissed).toBe(true);
    const state=(await db.pool.query('SELECT * FROM source_item_user_states WHERE source_item_id=$1',[a])).rows[0];
    expect(state.library_status).toBe('new');expect(state.progress_json).toEqual({reading_dismissed:true});
    await service().state(identity,a,{dismissed:false});expect((await list()).total).toBe(1);
  });
  it('rolls back every group member when a state write fails', async () => {
    const a=await item({canonical:'https://example.test/shared'}); const b=await item({canonical:'https://example.test/shared',project});
    await db.pool.query(`CREATE FUNCTION reject_reading_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_item_id='${b}' THEN RAISE EXCEPTION 'injected state failure'; END IF; RETURN NEW; END $$`);
    await db.pool.query('CREATE TRIGGER reject_reading_state BEFORE INSERT ON source_item_user_states FOR EACH ROW EXECUTE FUNCTION reject_reading_state()');
    try {
      await expect(service().state(identity,a,{read_status:'read'})).rejects.toThrow('injected state failure');
      expect((await db.pool.query('SELECT * FROM source_item_user_states')).rows).toHaveLength(0);
    } finally {
      await db.pool.query('DROP TRIGGER reject_reading_state ON source_item_user_states');await db.pool.query('DROP FUNCTION reject_reading_state()');
    }
  });
  it('admits only sealed initial recommendations and preserves their frozen reason', async () => {
    const selected=await item({project}); const candidate=await item({project});
    await db.pool.query(`INSERT INTO project_operations(id,space_id,project_id,kind,title,status,progress_json,created_at,updated_at)
      VALUES($1,$2,$3,'custom','Initial','completed',$4::jsonb,$5,$5)`, [randomUUID(),space,project,JSON.stringify({purpose:'information_monitoring',run_kind:'initial',as_of:past,recommendation_ids:[selected],recommendations:[{id:selected,summary:'Frozen summary',reason:'Project reason'},{id:candidate,reason:'Only relevant'}]}),past]);
    await preferences().set(identity,project,true);
    const page=await list();expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({source_item_id:selected,summary:'Frozen summary',reader_origin:'project'});
    expect(page.items[0].contributions[0]).toMatchObject({kind:'project_initial',digest_date:null,rationale:'Project reason'});
  });
  it('finds a personal item filed into Corpus in all Project material and opens the same Reader for a member', async () => {
    const source=await item();
    await db.pool.query(`UPDATE source_items SET excerpt='Readable retained excerpt' WHERE id=$1`,[source]);
    const artifact=await retainReaderBody(db.pool,{space,owner,item:source,text:'Same retained body through personal and Project entry'});
    const corpus=new ProjectCorpusRepository(db.pool);
    await corpus.upsert(identity,project,{source_item_id:source,metadata_json:{origin:'information_digest'}});
    await corpus.upsert(identity,project,{source_item_id:source,metadata_json:{origin:'information_digest'}});
    const projectPage=ReadingPageSchema.parse(await list('all',30,undefined,project));
    expect(projectPage.items.map(i=>i.source_item_id)).toContain(source);
    expect(projectPage.items[0].material_links[0]).toMatchObject({kind:'corpus',source_item_id:source,project_id:project});
    const reader=new PgReaderRepository(db.pool,config());
    const doc=await reader.getDocument({spaceId:space,userId:other},'source_item',source,{origin:'project'});
    expect(doc?.source_item_id).toBe(source);
    expect(doc?.normalized_text).toContain('Same retained body through personal and Project entry');
    expect((await db.pool.query('SELECT extracted_artifact_id FROM source_items WHERE id=$1',[source])).rows[0].extracted_artifact_id).toBe(artifact);
    expect((await db.pool.query('SELECT id FROM project_corpus_items WHERE project_id=$1 AND source_item_id=$2',[project,source])).rows).toHaveLength(1);
    const state=(await db.pool.query('SELECT read_status,read_origin FROM source_item_user_states WHERE user_id=$1',[other])).rows[0];
    expect(state).toEqual({read_status:'skimmed',read_origin:'project'});
    expect((await list('pending',30,undefined,project)).items).toHaveLength(0);
  });
  it('finds binding-linked and directly saved material without turning the Project library into personal backlog', async () => {
    const connection=randomUUID(),channel=randomUUID();
    await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now:past});
    const binding=await new ProjectSourceBindingService(db.pool).createBinding(identity,{project_id:project,source_channel_id:channel,standing_comparison_enabled:false});
    const linked=await item();const saved=await item({project});
    await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[linked,connection]);
    const link=randomUUID();
    await db.pool.query(`INSERT INTO project_source_item_links(id,space_id,project_id,project_source_binding_id,source_channel_id,source_connection_id,source_item_id,matched_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now(),now(),now())`,[link,space,project,binding.id,channel,connection,linked]);
    const page=await list('all',30,undefined,project);
    expect(page.items.map(i=>i.source_item_id).sort()).toEqual([linked,saved].sort());
    expect(page.items.flatMap(i=>i.material_links)).toEqual(expect.arrayContaining([expect.objectContaining({kind:'source_link',reference_id:link}),expect.objectContaining({kind:'saved',source_item_id:saved})]));
    await preferences().set(identity,project,true);expect((await list()).items).toHaveLength(0);
  });
  it('synchronized completion and project-origin opens do not create personal interest coverage', async () => {
    const source=await item({canonical:'https://example.test/isolated-copy'});
    const duplicate=await item({project,canonical:'https://example.test/isolated-copy'});await db.pool.query(`UPDATE source_items SET excerpt='Retained body' WHERE id=$1`,[source]);
    const annotations=new PgSourceAnnotationRepository(db.pool);
    await annotations.enqueueItems(space,[source],null);
    await annotations.markSucceeded(space,{source_item_id:source,domain_key:'technology.computing',depth:'analysis',genre:'explainer',summary:'s',topic_candidates:[],stance_target:null,stance_target_key:null,stance_polarity:'neutral',stance_confidence:0},null);
    await new ProjectCorpusRepository(db.pool).upsert(identity,project,{source_item_id:source});
    expect(await service().state(identity,duplicate,{read_status:'read'},project)).toEqual({updated:2});
    expect((await db.pool.query('SELECT read_status,read_origin FROM source_item_user_states WHERE user_id=$1 ORDER BY source_item_id',[owner])).rows).toEqual([{read_status:'read',read_origin:'project'},{read_status:'read',read_origin:'project'}]);
    expect((await db.pool.query('SELECT id FROM source_item_user_states WHERE user_id=$1',[other])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM information_digest_serendipity_feedback WHERE space_id=$1',[space])).rows).toHaveLength(0);
    const profile=new PgInterestProfileRepository(db.pool);
    expect(await profile.coverageByDomain(space,owner)).toHaveLength(0);
    expect(await new InterestProfileService(db.pool).maturityInputs(space,owner)).toEqual({readItemCount:0,coveredDomainCount:0});
    expect((await new PgSerendipityRepository(db.pool).readingShape(space,owner)).coveredDomains).toHaveLength(0);
    await new PgReaderRepository(db.pool,config()).getDocument(identity,'source_item',source,{origin:'project'});
    expect(await profile.coverageByDomain(space,owner)).toHaveLength(0);
    await new PgReaderRepository(db.pool,config()).getDocument(identity,'source_item',source,{origin:'library'});
    expect(await profile.coverageByDomain(space,owner)).toHaveLength(1);
  });
  it('withdraws a live Source without leaking its old recommendation or count', async () => {
    const connection=randomUUID(),channel=randomUUID();
    await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now:past});
    const source=await item();await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[source,connection]);
    await digest([source]);expect((await list()).total).toBe(1);
    await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`,[connection]);
    expect(await list()).toMatchObject({items:[],total:0});
    await expect(service().state(identity,source,{read_status:'read'})).rejects.toThrow('Source item not found');
  });
  it('walks the complete old backlog with tied times and ignores arrivals after its cursor snapshot', async () => {
    const ids:string[]=[];for(let n=0;n<75;n++) ids.push(await item());
    await digest(ids);
    let page=await list('pending',13);const seen=page.items.map(i=>i.key);
    const fresh=await item();await digest([fresh],undefined,'2026-01-02');
    // A real newly available delivery, rather than another historical fixture.
    await db.pool.query(`UPDATE information_digests SET generated_at=now() WHERE digest_date='2026-01-02'`);
    while(page.next_cursor) {page=await list('pending',13,page.next_cursor);seen.push(...page.items.map(i=>i.key));}
    expect(seen).toHaveLength(75);expect(new Set(seen).size).toBe(75);expect((await list()).total).toBe(76);
    const plans:string[]=[];
    const repository=new ReadingRepository({query:async <Row>(sql: string, values?: readonly unknown[]) => {
      const explain=await db.pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,[...(values ?? [])]);
      plans.push(JSON.stringify(explain.rows[0]));
      const result=await db.pool.query(sql,[...(values ?? [])]);
      return {rows: result.rows as Row[],rowCount:result.rowCount};
    }});
    await repository.rows(identity,[],{view:'pending',limit:13,asOf:new Date().toISOString()});
    const plan=JSON.parse(plans[0])['QUERY PLAN'][0];
    console.info('Reading backlog EXPLAIN', {rows:75, execution_ms:plan['Execution Time'], planning_ms:plan['Planning Time']});
  });
  it('rejects a retained cursor in another Space even for the same user and reads that Space independently', async () => {
    const a=await item(),b=await item();await digest([a,b]);
    const first=await list('pending',1);expect(first.next_cursor).toBeTruthy();
    const secondSpace=randomUUID();
    await db.pool.query(`INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Other Space','personal',now(),now())`,[secondSpace]);
    await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())`,[randomUUID(),secondSpace,owner]);
    const there={spaceId:secondSpace,userId:owner};
    await expect(service().list(there,{view:'pending',limit:1,cursor:first.next_cursor!})).rejects.toMatchObject({statusCode:422});
    expect(await service().list(there,{view:'pending',limit:30})).toMatchObject({total:0,items:[],next_cursor:null});
    expect((await list()).total).toBe(2);
  });
  it('invalidates a cursor on preference withdrawal rather than duplicating shifted groups', async () => {
    const a=await item();const b=await item({project});await digest([a]);await digest([b],project);
    await preferences().set(identity,project,true);const page=await list('pending',1);
    await preferences().set(identity,project,false);
    await expect(list('pending',1,page.next_cursor!)).rejects.toMatchObject({statusCode:409});
    expect((await list()).items[0].source_item_id).toBe(a);
  });
  it('retains completed state when another delivery or Reader open adds a matching record', async () => {
    const a=await item({canonical:'https://example.test/shared'});await digest([a]);
    await service().state(identity,a,{read_status:'read'});
    const b=await item({project,canonical:'https://example.test/shared'});
    await db.pool.query(`UPDATE source_items SET excerpt='Retained body' WHERE id=$1`,[b]);
    await digest([b],project);await preferences().set(identity,project,true);
    await new PgReaderRepository(db.pool,config()).getDocument(identity,'source_item',b,{origin:'project'});
    expect((await list()).total).toBe(0);expect((await list('read')).total).toBe(1);
    await service().state(identity,b,{read_status:'unread'});
    expect((await list()).total).toBe(1);
  });
  it('keeps unknown revisions independent and protects personal summary-only delivery fields', async () => {
    const a=await item({canonical:'https://example.test/shared'});const b=await item({project,canonical:'https://example.test/shared'});
    await db.pool.query('UPDATE source_items SET content_hash=NULL,reading_initial_hash=NULL WHERE id=ANY($1::varchar[])',[[a,b]]);
    await digest([a]);await digest([b],project);await preferences().set(identity,project,true);
    expect((await list()).total).toBe(2);
    await db.pool.query(`UPDATE information_digests SET owner_user_id=$1 WHERE digest_type='personal'`,[other]);
    await db.pool.query(`UPDATE source_items SET access_level='summary' WHERE id=$1`,[a]);
    const page=ReadingPageSchema.parse(await service().list({spaceId:space,userId:other},{view:'pending',limit:30}));
    expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({access_level:'summary',source_uri:null});
    expect((await service().list({spaceId:space,userId:other},{view:'pending',limit:30,q:'https://example.test/shared'})).items).toHaveLength(0);
    expect((await service().list({spaceId:space,userId:other},{view:'pending',limit:30,q:'Article'})).items).toHaveLength(1);
  });
  it('serializes concurrent preference edits and repeated group state changes', async () => {
    const second=randomUUID();await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Second','active',now(),now())`,[second,space,owner]);
    await seedMainlineRoomsForAllProjects(db.pool);
    await Promise.all([preferences().set(identity,project,true),preferences().set(identity,second,true)]);
    expect((await preferences().enabled(identity)).sort()).toEqual([project,second].sort());
    const source=await item();await digest([source]);
    await Promise.all([service().state(identity,source,{read_status:'read'}),service().state(identity,source,{read_status:'read'})]);
    expect((await list('read')).items).toHaveLength(1);
    expect((await db.pool.query('SELECT * FROM source_item_user_states WHERE source_item_id=$1',[source])).rows).toHaveLength(1);
  });
  it('keeps completion and grouping through first extraction, raw snapshots and feed rescans, but invalidates changed retained text', async () => {
    let body='A stable article body with enough content to retain and read.';
    const upstream=await startMockUpstream((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<html><body><article><p>${body}</p></article></body></html>`);});
    const root=await mkdtemp(join(tmpdir(),'reading-version-extraction-'));
    try {
      const a=await item({canonical:'https://example.test/shared'}),b=await item({canonical:'https://example.test/shared',project});
      await db.pool.query('UPDATE source_items SET source_uri=$2 WHERE id=$1',[a,upstream.baseUrl+'/article']);
      await digest([a]);await digest([b],project);await preferences().set(identity,project,true);
      const sources=new PgSourcesRepository(db.pool,config());
      await sources.itemAction(identity,a,{action:'mark_discussed'});
      await service().state(identity,a,{read_status:'discussed'});
      const original=(await list('read')).items[0].key;
      const worker=new SourceExtractionWorker(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri,ARTIFACT_STORAGE_ROOT:root}),fixtureServerGuard);
      for (const jobType of ['extract_text','snapshot','extract_text']) {
        const job=randomUUID();
        await db.pool.query(`INSERT INTO extraction_jobs(id,space_id,source_item_id,job_type,status,created_at) VALUES($1,$2,$3,$4,'pending',now())`,[job,space,a,jobType]);
        expect(await worker.runPendingJob(job,space)).toMatchObject({status:'succeeded'});
        expect((await sources.getItem(identity,a))?.read_status).toBe('discussed');
        expect((await list('read')).items[0]).toMatchObject({key:original,source_item_ids:expect.arrayContaining([a,b])});
        // This is the legacy scan writer's operational metadata hash update.
        await db.pool.query('UPDATE source_items SET content_hash=$2,last_seen_at=now() WHERE id=$1',[a,'feed-rescan-'+jobType]);
        expect((await list()).items).toHaveLength(0);
      }
      body='This is a genuinely changed retained article body.';
      const job=randomUUID();await db.pool.query(`INSERT INTO extraction_jobs(id,space_id,source_item_id,job_type,status,created_at) VALUES($1,$2,$3,'extract_text','pending',now())`,[job,space,a]);
      expect(await worker.runPendingJob(job,space)).toMatchObject({status:'succeeded'});
      expect((await sources.getItem(identity,a))?.read_status).toBe('unread');
      expect((await list()).items.map(row=>row.source_item_id)).toEqual([a]);
      expect((await list('read')).items[0].source_item_ids).toEqual([b]);
    } finally {await upstream.close();await rm(root,{recursive:true,force:true});}
  });
  it('treats NULL-version legacy writes by actual body transition time during rolling upgrade', async () => {
    const a=await item();await digest([a]);
    await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,created_at,updated_at) VALUES($1,$2,$3,$4,'read',now(),now())`,[randomUUID(),space,a,owner]);
    await retainReaderBody(db.pool,{space,owner,item:a,text:'First retained body'});
    expect((await list()).items).toHaveLength(0);
    await retainReaderBody(db.pool,{space,owner,item:a,text:'Actually revised body'});
    expect((await list()).items).toHaveLength(1);
    await db.pool.query(`UPDATE source_item_user_states SET library_status='selected',updated_at=clock_timestamp() WHERE source_item_id=$1`,[a]);
    expect((await list()).items).toHaveLength(1);
    await db.pool.query(`UPDATE source_item_user_states SET read_status='discussed',updated_at=clock_timestamp() WHERE source_item_id=$1`,[a]);
    expect((await list()).items).toHaveLength(0);
    expect((await list('read')).items[0].read_status).toBe('discussed');
  });
  it('separates conflicting retained bodies even when their original feed fingerprints match', async () => {
    const a=await item({canonical:'https://example.test/shared'}),b=await item({canonical:'https://example.test/shared',project});
    await digest([a]);await digest([b],project);await preferences().set(identity,project,true);
    await retainReaderBody(db.pool,{space,owner,item:a,text:'The first retained body'});
    expect((await list()).total).toBe(1);
    await retainReaderBody(db.pool,{space,owner,item:b,text:'Different retained text, same feed teaser'});
    expect((await list()).total).toBe(2);
  });
  it('does not replace the current fallback body with a late historical snapshot', async () => {
    const a=await item();await digest([a]);
    const current=await retainReaderBody(db.pool,{space,owner,item:a,text:'Current retained body'});
    await db.pool.query('UPDATE source_items SET extracted_artifact_id=NULL WHERE id=$1',[a]);
    await db.pool.query(`INSERT INTO source_snapshots(id,space_id,source_item_id,snapshot_type,artifact_id,capture_method,trust_level,visibility,captured_at,created_at,updated_at)
      VALUES($1,$2,$3,'extracted',$4,'full_text','normal','space_shared','2026-02-01T00:00:00Z',now(),now())`,[randomUUID(),space,a,current]);
    await service().state(identity,a,{read_status:'read'});
    const historical=await retainReaderBody(db.pool,{space,owner,item:a,text:'Historical body',attach:false});
    await db.pool.query(`INSERT INTO source_snapshots(id,space_id,source_item_id,snapshot_type,artifact_id,capture_method,trust_level,visibility,captured_at,created_at,updated_at)
      VALUES($1,$2,$3,'extracted',$4,'full_text','normal','space_shared','2026-01-01T00:00:00Z',now(),now())`,[randomUUID(),space,a,historical]);
    expect((await list()).total).toBe(0);
    expect((await db.pool.query('SELECT reading_body_revision FROM source_items WHERE id=$1',[a])).rows[0].reading_body_revision).toBe(0);
  });
  it('merges verified equal bodies captured with different feed fingerprints and resolves the same members for state writes', async () => {
    const a=await item({canonical:'https://example.test/shared',hash:'feed-a'}),b=await item({canonical:'https://example.test/shared',hash:'feed-b',project});
    await digest([a]);await digest([b],project);await preferences().set(identity,project,true);
    expect((await list()).total).toBe(2);
    await retainReaderBody(db.pool,{space,owner,item:a,text:'Verified retained body'});
    await retainReaderBody(db.pool,{space,owner,item:b,text:'Verified   retained body'});
    expect((await list()).total).toBe(1);
    expect(await service().state(identity,a,{read_status:'read'})).toEqual({updated:2});
    expect((await list()).total).toBe(0);
  });
  it('derives anchor origins from personal interest, serendipity or the authorized Project context and preserves copy origins', async () => {
    const a=await item({canonical:'https://example.test/shared'}),b=await item({canonical:'https://example.test/shared',project});
    const id=await digest([a]);await digest([b],project);await preferences().set(identity,project,true);
    await service().state(identity,a,{read_status:'read'});
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1',[a])).rows[0].read_origin).toBe('library');
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1',[b])).rows[0].read_origin).toBe('project');
    await service().state(identity,b,{read_status:'read'},project);
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1',[a])).rows[0].read_origin).toBe('library');
    const c=await item();const seren=await digest([c],undefined,'2026-01-03');
    await new PgSerendipityRepository(db.pool).addPoolItem({spaceId:space,userId:owner,sourceItemId:c,targetDomainKey:'artificial_intelligence',origin:'weekly_probe',probePeriod:'2026-01-03'});
    await db.pool.query(`UPDATE information_digest_items SET section='serendipity',serendipity_pool_item_id=(SELECT id FROM information_digest_serendipity_pool WHERE source_item_id=$2) WHERE digest_id=$1`,[seren,c]);
    await service().state(identity,c,{read_status:'read'});
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1',[c])).rows[0].read_origin).toBe('serendipity');
    const d=await item();await new PgSourcesRepository(db.pool,config()).itemAction(identity,d,{action:'mark_ignored'});
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1',[d])).rows[0].read_origin).toBeNull();
    const e=await item();await service().state(identity,e,{dismissed:true});
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1',[e])).rows[0].read_origin).toBeNull();
    expect((await db.pool.query('SELECT id FROM information_digests WHERE id=$1',[id])).rows).toHaveLength(1);
  });
  it('does not replace an existing legacy NULL origin on a synchronized member', async () => {
    const a=await item({canonical:'https://example.test/shared'}),b=await item({canonical:'https://example.test/shared',project});
    await digest([a]);await digest([b],project);await preferences().set(identity,project,true);
    await db.pool.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,read_status,read_origin,created_at,updated_at) VALUES($1,$2,$3,$4,'unread',NULL,now(),now())`,[randomUUID(),space,b,owner]);
    await service().state(identity,a,{read_status:'read'});
    expect((await db.pool.query('SELECT read_origin FROM source_item_user_states WHERE source_item_id=$1',[b])).rows[0].read_origin).toBeNull();
  });
  it('matches literal percent, underscore and backslash in authorized search fields', async () => {
    const exact=await item({title:String.raw`Growth 50% a_b C:\reading`});
    await item({title:'Growth 500 ab C:reading'});
    for(const q of ['50%','a_b',String.raw`C:\reading`,'%','_','\\']) {
      const page=await service().list(identity,{view:'all',limit:30,q});
      expect(page.items.map(row=>row.source_item_id)).toEqual([exact]);
    }
  });
  it('uses the same active Project audience as projectReaderIds after status and membership changes', async () => {
    const a=await item({private:true});
    const allowed=async()=> (await db.pool.query(`SELECT ${projectReadingAudienceClause('i','$2')} AS allowed FROM source_items i WHERE i.id=$1`,[a,project])).rows[0].allowed;
    expect((await projectReaderIds(db.pool,space,project)).sort()).toEqual([owner,other].sort());expect(await allowed()).toBe(false);
    await db.pool.query(`UPDATE users SET status='disabled' WHERE id=$1`,[other]);
    expect(await projectReaderIds(db.pool,space,project)).toEqual([owner]);expect(await allowed()).toBe(true);
    await db.pool.query(`UPDATE users SET status='active' WHERE id=$1`,[other]);
    await db.pool.query(`UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2`,[project,other]);
    expect(await projectReaderIds(db.pool,space,project)).toEqual([owner]);expect(await allowed()).toBe(true);
  });
  it('exposes typed routes, validates state and rejects cross-Space cursors', async () => {
    const a=await item();await digest([a]);
    __setAuthIdentityForTests({spaceId:space,userId:owner});
    const app=await buildModuleServer(config(),[informationDigestModule]);
    try {
      const response=await app.inject({method:'GET',url:`/api/v1/spaces/${space}/reading`});
      expect(response.statusCode).toBe(200);ReadingPageSchema.parse(response.json());
      const state=await app.inject({method:'PATCH',url:`/api/v1/spaces/${space}/reading/items/${a}/state`,payload:{read_status:'read'}});
      expect(state.statusCode).toBe(200);expect(ReadingStateResultSchema.parse(state.json())).toEqual({updated:1});
      expect((await app.inject({method:'GET',url:`/api/v1/spaces/${space}/reading?cursor=invalid`})).statusCode).toBe(422);
      expect((await app.inject({method:'PATCH',url:`/api/v1/spaces/${space}/reading/items/${a}/state`,payload:{read_status:'bad'}})).statusCode).toBe(422);
      expect((await app.inject({method:'PUT',url:`/api/v1/spaces/${space}/projects/${project}/reading-preference`,payload:{show_in_my_reading:true}})).statusCode).toBe(200);
      expect((await app.inject({method:'GET',url:`/api/v1/spaces/${randomUUID()}/reading`})).statusCode).toBe(404);
      expect((await app.inject({method:'PATCH',url:`/api/v1/spaces/${space}/projects/${project}/reading/items/${a}/state`,payload:{read_status:'read'}})).statusCode).toBe(404);
      await new ProjectCorpusRepository(db.pool).upsert(identity,project,{source_item_id:a});
      expect((await app.inject({method:'PATCH',url:`/api/v1/spaces/${space}/projects/${project}/reading/items/${a}/state`,payload:{read_status:'read'}})).statusCode).toBe(200);
    } finally {await app.close();}
  });
});
