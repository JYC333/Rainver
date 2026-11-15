import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {READING_METHOD_FIXTURE} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,OWNER,MEMBER,PROJECT,AGENT,PROFILE} from './support/briefingFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {promptsModule} from '../src/modules/prompts/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {readingWorkspace} from '../src/modules/prompts/reading/workspace.js';
import {RuntimeContextPolicyRepository} from '../src/modules/policy/runtimeContextPolicyRepository.js';
import {registerReadingTrialSettlement} from '../src/modules/prompts/reading/trials.js';

const db=useTestDatabase(import.meta.filename,{max:10});const w=briefingWorld(db);const identity={spaceId:SPACE,userId:OWNER};
const base='/api/v1/prompts/reading-method';let item:string,app:ReturnType<typeof buildModuleServer>;
const post=(path:string,payload:object,key:string|null=randomUUID())=>app.inject({method:'POST',url:base+path,payload,headers:key?{'idempotency-key':key}:{}});
beforeEach(async()=>{
 if(!db.available)return;
 await w.seed();await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`,[SPACE,OWNER]);
 await db.pool.query(`DELETE FROM evolvable_assets WHERE asset_key IN ('reading.project_investigation','prompt.revision.method')`);
 item=await w.material('Synthetic original result');
 await new RuntimeContextPolicyRepository(db.pool).write(identity,'space',SPACE,{base_version_id:null,policy:{constraints:{},preferences:{}},reason:'Synthetic test policy'});
 registerReadingTrialSettlement();
 app=buildModuleServer(w.config(),[promptsModule,systemActionsModule]);
 __setAuthIdentityForTests(identity);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('initializes, drafts, samples and starts a comparison as keyed commands whose receipts carry ids and whose writes stay owner-checked',async()=>{
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});
 expect((await post('/initialize',{})).statusCode).toBe(404);
 __setAuthIdentityForTests(identity);
 const initKey=randomUUID(),init=await post('/initialize',{},initKey);expect(init.statusCode,init.body).toBe(200);expect(init.json().data).toEqual({space_id:SPACE,initialized:true});
 expect((await post('/initialize',{},null)).statusCode).toBe(422);
 const current=await readingWorkspace(db.pool,identity,item,PROJECT);
 const stale=await post('/drafts',{item_id:item,project_id:PROJECT,parent_version_id:randomUUID(),reason:'Stale',method:'x'.repeat(60)});expect(stale.statusCode).toBe(409);
 const draftKey=randomUUID(),draftBody={item_id:item,project_id:PROJECT,parent_version_id:current.effective_version_id,reason:'Homepage was insufficient',method:current.method+'\nGive concrete integration counterexamples.'};
 const draft=await post('/drafts',draftBody,draftKey);expect(draft.statusCode,draft.body).toBe(201);
 const versionId=draft.json().data.version_id;expect(draft.json().data).toEqual({space_id:SPACE,version_id:versionId});
 expect((await post('/drafts',draftBody,draftKey)).json().data).toEqual(draft.json().data);
 expect((await db.pool.query(`SELECT count(*)::int n FROM evolvable_asset_versions WHERE parent_version_id=$1`,[current.effective_version_id])).rows[0].n).toBe(1);
 const sample=await post('/samples',{item_id:item,project_id:PROJECT,sample:READING_METHOD_FIXTURE});expect(sample.statusCode,sample.body).toBe(201);
 const caseId=sample.json().data.case_id;
 expect((await app.inject({method:'GET',url:`${base}/samples/${caseId}`})).json()).toMatchObject({name:READING_METHOD_FIXTURE.name});
 const hash=(await db.pool.query<{content_hash:string}>('SELECT content_hash FROM evolvable_asset_versions WHERE id=$1',[versionId])).rows[0]!.content_hash;
 const request={item_id:item,project_id:PROJECT,candidate_version_id:versionId,candidate_content_hash:hash,case_id:caseId,agent_id:AGENT,runtime_profile_id:PROFILE};
 expect((await post('/trials',{...request,agent_id:undefined})).statusCode).toBe(422);
 const changed=await post('/trials',{...request,candidate_content_hash:'0'.repeat(64)});expect(changed.statusCode).toBe(409);
 const trial=await post('/trials',request);expect(trial.statusCode,trial.body).toBe(202);
 const trialId=trial.json().data.trial_id;
 const runs=(await db.pool.query<{id:string;status:string}>(`SELECT id,status FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'reading_method_trial'->>'evaluation_id'=$1`,[trialId])).rows;
 expect(runs).toHaveLength(2);
 expect((await db.pool.query(`SELECT count(*)::int n FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=ANY($1::varchar[])`,[runs.map(r=>r.id)])).rows[0].n).toBe(2);
 // A comparison that has not passed cannot be judged or promoted; both refusals are the owner's own text.
 const judge=await post(`/trials/${trialId}/judgment`,{judgment:'better',reason:'Concrete'});expect(judge.statusCode).toBe(409);
 expect(judge.json().error.message).toBe('Only a completed, current, authorized comparison can be judged');
 expect((await post(`/trials/${trialId}/judgment`,{judgment:'great',reason:'x'})).statusCode).toBe(422);
 expect((await post('/promote',{version_id:versionId,evaluation_id:trialId,project_id:PROJECT})).statusCode).toBe(409);
 const rollback=await post('/rollback',{item_id:item,project_id:PROJECT,expected_version_id:randomUUID()});expect(rollback.statusCode).toBe(409);
 expect(rollback.json().error.message).toBe('Effective method changed; refresh before rollback');
 // Cancelling records the stop for both Runs in the transaction; the process stop runs after commit.
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});
 expect((await post(`/trials/${trialId}/cancel`,{})).statusCode).toBe(404);
 __setAuthIdentityForTests(identity);
 const cancelled=await post(`/trials/${trialId}/cancel`,{});expect(cancelled.statusCode,cancelled.body).toBe(200);expect(cancelled.json().data).toEqual({space_id:SPACE,trial_id:trialId});
 const after=(await db.pool.query<{status:string}>(`SELECT status FROM runs WHERE id=ANY($1::varchar[])`,[runs.map(r=>r.id)])).rows.map(r=>r.status);
 expect(after.every(status=>['cancelling','cancelled'].includes(status))).toBe(true);
});

it('refuses malformed generation requests before any work and hides another person’s generation',async()=>{
 expect((await post('/generations',{source_kind:'description',parent_version_id:'v',parent_content_hash:'nothex',description:'x'})).statusCode).toBe(422);
 expect((await post('/generations',{source_kind:'logs',parent_version_id:'v',parent_content_hash:'0'.repeat(64),description:'x'})).statusCode).toBe(422);
 expect((await post(`/generations/${randomUUID()}/cancel`,{})).statusCode).toBe(404);
 expect((await db.pool.query(`SELECT count(*)::int n FROM runs WHERE space_id=$1 AND contract_snapshot_json->'workflow_input_json' ? 'reading_method_generation'`,[SPACE])).rows[0].n).toBe(0);
});
