import {beforeEach,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,OWNER,PROJECT,AGENT,PROFILE,CONNECTION} from './support/briefingFixture.js';
import {readingWorkspace,readingEntryScope,initializeReading,saveReadingDraft,saveReadingSample} from '../src/modules/prompts/reading/workspace.js';
import {startReadingTrial,readReadingTrial,registerReadingTrialSettlement} from '../src/modules/prompts/reading/trials.js';
import {READING_METHOD_FIXTURE} from '@rainver/protocol';
import {MaterialItemProcessingService} from '../src/modules/sources/materialProcessing/items.js';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
const db=useTestDatabase(import.meta.filename,{max:10});const w=briefingWorld(db);const identity={spaceId:SPACE,userId:OWNER};let item:string;
beforeEach(async()=>{if(!db.available)return;await w.seed();await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);await db.pool.query(`DELETE FROM evolvable_assets WHERE asset_key='reading.project_investigation'`);item=await w.material('Synthetic original result');await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic test policy'});registerReadingTrialSettlement();});
/** A routine Project brief revision: new published version, pointer moved. No permission changes. */
async function reviseBrief(){const id=randomUUID();await db.pool.query(`INSERT INTO project_brief_versions (id,space_id,project_id,version,goal,constraints,project_status,status,created_at) VALUES ($1,$2,$3,'2','Ship a warehouse picking robot by Q4','Budget under 60k; no cloud dependency','active','published',now())`,[id,SPACE,PROJECT]);await db.pool.query(`UPDATE projects SET active_brief_version_id=$2 WHERE id=$1`,[PROJECT,id]);}

it('C1: a completed Project material Run stays visible to its own instructor after a routine brief revision',async ctx=>{
 if(!db.available)return ctx.skip();
 await initializeReading(db.pool,w.config(),identity);
 await db.pool.query(`UPDATE source_items SET project_id=$2 WHERE id=$1`,[item,PROJECT]);
 await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json='{"retention_policy":"full_text"}' WHERE id=$1`,[CONNECTION]);
 const queued=await new MaterialItemProcessingService(db.pool,w.config()).start(identity,item,{agent_id:AGENT,runtime_profile_id:PROFILE});
 await w.finishRun(queued.run_id!,'# Investigation\nDone.');
 expect(await w.runs().getVisibleRun(SPACE,OWNER,queued.run_id!)).not.toBeNull();
 expect((await w.runs().listRuns({space_id:SPACE,user_id:OWNER} as never)).map(r=>r.id)).toContain(queued.run_id);
 await reviseBrief();
 // Correct expectation: the instructor lost no permission; the finished Run and its record remain theirs to see.
 expect(await w.runs().getVisibleRun(SPACE,OWNER,queued.run_id!)).not.toBeNull();
 expect((await w.runs().listRuns({space_id:SPACE,user_id:OWNER} as never)).map(r=>r.id)).toContain(queued.run_id);
});

it('C2: a routine brief revision makes an authorized comparison historical (stale), not withheld',async ctx=>{
 if(!db.available)return ctx.skip();
 await initializeReading(db.pool,w.config(),identity);
 const current=await readingWorkspace(db.pool,identity,item,PROJECT);
 const draft=await saveReadingDraft(db.pool,identity,{item_id:item,project_id:PROJECT,parent_version_id:current.effective_version_id,reason:'Homepage was insufficient',method:current.method+'\nGive concrete integration counterexamples.'});
 const c=await saveReadingSample(db.pool,identity,item,PROJECT,READING_METHOD_FIXTURE,w.config());
 const trial=await startReadingTrial(db.pool,w.config(),identity,{item_id:item,project_id:PROJECT,candidate_version_id:String(draft.id),candidate_content_hash:String(draft.content_hash),case_id:String(c.id),agent_id:AGENT,runtime_profile_id:PROFILE});
 expect(trial.visibility).toBe('visible');
 await reviseBrief();
 const after=await readReadingTrial(db.pool,identity,trial.id);
 // Correct expectation: the owner still holds every permission; the pair is merely historical.
 expect(after.visibility).toBe('visible');
 expect(after.stale).toBe(true);
 expect(after.case_name).toBe(trial.case_name);
 // And the saved sample is still listed for its owner.
 expect((await readingWorkspace(db.pool,identity,item,PROJECT)).cases.map(x=>x.id)).toContain(String(c.id));
});


it('scope entry has bounded queries independent of materials or Project audience',async()=>{await initializeReading(db.pool,w.config(),identity);let count=0;const q={query:(...args:unknown[])=>{count++;return (db.pool.query as Function)(...args)}};expect(await readingEntryScope(q as never,identity,PROJECT)).toMatchObject({can_manage:true});console.log('ENTRY_SCOPE_QUERIES='+count);expect(count).toBeLessThanOrEqual(6)});
it('canonical Reader denies a non-Project member even for space-shared project material',async()=>{
 const {MEMBER}=await import('./support/briefingFixture.js');
 await db.pool.query(`UPDATE source_items SET project_id=$2,visibility='space_shared' WHERE id=$1`,[item,PROJECT]);
 await db.pool.query(`UPDATE source_connections SET project_id=$2,visibility='space_shared',consent_json=consent_json||jsonb_build_object('allowed_reader_user_ids',jsonb_build_array($3::text)) WHERE id=$1`,[CONNECTION,PROJECT,MEMBER]);
 await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[PROJECT,MEMBER]);
 const {PgReaderRepository}=await import('../src/modules/reader/index.js');expect(await new PgReaderRepository(db.pool,w.config()).getDocument(identity,'source_item',item)).not.toBeNull();await expect(new PgReaderRepository(db.pool,w.config()).getDocument({spaceId:SPACE,userId:MEMBER},'source_item',item)).resolves.toBeNull();
});

it('collection keeps broad Source neutral but scoped Source can investigate; canonical WorkContext does not inject omitted Project',async()=>{
 const {collectionReadingContext}=await import('../src/modules/sources/readingMethods/context.js');
 const neutral=await collectionReadingContext(db.pool,identity,PROJECT,null);expect(neutral).toEqual({projectId:null,context:null});
 const queued=await w.runs().createQueuedRunWithBudgetAdmission({execution_kind:'agent',space_id:SPACE,user_id:OWNER,agent_id:AGENT,runtime_profile_id:PROFILE,project_id:neutral.projectId,prompt:'Ordinary evidence-led reading',instruction:'No private Project context',trigger_origin:'manual',mode:'live',run_type:'agent',visibility:'private'});
 const {closeReadingContext}=await import('../src/modules/prompts/reading/closedContext.js');await closeReadingContext(db.pool,identity,queued.id,AGENT,PROFILE);
 expect((await db.pool.query('SELECT project_id,project_brief_version_id,project_instruction_version_id FROM work_context_setups WHERE work_context_scope_id=$1',[queued.id])).rows[0]).toEqual({project_id:null,project_brief_version_id:null,project_instruction_version_id:null});
 const scoped=await collectionReadingContext(db.pool,identity,PROJECT,PROJECT);expect(scoped.projectId).toBe(PROJECT);expect(scoped.context?.goal).toContain('warehouse');
});
