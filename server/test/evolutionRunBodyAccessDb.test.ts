import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedRun,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {evolutionModule} from '../src/modules/evolution/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {insertInitialNoteRevision} from '../src/modules/knowledge/noteRevisionService.js';
import {markdownToPm} from '../src/modules/knowledge/noteDocument.js';

/**
 * Evolution callers that copy or derive from a Run's body (an evaluation case
 * baseline, a candidate evaluation, a saved workflow) need full read access to
 * that Run in the caller's own right; summary-level visibility releases status
 * but never the body, and oversight reads but never copies out. Child Runs
 * follow the same content, Room and domain gates as a direct read.
 */
const db=useTestDatabase(import.meta.filename);
let current:string,space:string,owner:string,member:string,agent:string,version:string,app:ReturnType<typeof buildModuleServer>;
const as=(userId:string)=>{current=userId;__setAuthIdentityForTests({spaceId:space,userId});};
const rest=(url:string,payload:object)=>app.inject({method:'POST',url,payload,headers:{'idempotency-key':randomUUID()}});
const BODY='RUN_BODY_SECRET';

beforeEach(async()=>{
 space=randomUUID();owner=randomUUID();member=randomUUID();agent=randomUUID();version=randomUUID();
 await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'S','team',now(),now())",[space]);
 await seedSpaceMember(db.pool,{space,user:owner,role:'owner'});
 await seedSpaceMember(db.pool,{space,user:member,role:'member'});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:`/tmp/rainver-evolution-run-body-${process.pid}`}),[evolutionModule,systemActionsModule,runsModule]);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

/** A succeeded, evaluation-passed Run whose prompt and output carry BODY. */
async function sourceRun(opts:{first?:boolean;accessLevel?:'full'|'summary';contract?:object;workflowVersionId?:string|null;output?:object;owner?:string;visibility?:'private'|'space_shared';parent?:string;instructedBy?:string;prompt?:string;project?:string}={}):Promise<string>{
 const id=randomUUID();
 await seedRun(db.pool,{id,space,owner:opts.owner??owner,agent,version,existingAgent:!opts.first});
 await db.pool.query(`UPDATE runs SET prompt=$2,output_json=$3::jsonb,access_level=$4,contract_snapshot_json=$5::jsonb,workflow_version_id=$6,ended_at=now(),
   visibility=$7,parent_run_id=$8,root_run_id=$8,instructed_by_user_id=$9,project_id=$10 WHERE id=$1`,
  [id,opts.prompt??`Summarize ${BODY}`,JSON.stringify(opts.output??{summary:BODY}),opts.accessLevel??'full',JSON.stringify(opts.contract??{source:{kind:'direct',id:null},risk_level:'low'}),opts.workflowVersionId??null,
   opts.visibility??'space_shared',opts.parent??null,opts.instructedBy??opts.owner??owner,opts.project??null]);
 await db.pool.query(`INSERT INTO run_evaluations(id,space_id,run_id,evaluator_type,evaluator_version,outcome_status,trajectory_status,evidence_json,rule_trace_json,evaluated_at)
  VALUES($1,$2,$3,'deterministic_harness','test','passed','acceptable','{}'::jsonb,'[]'::jsonb,now())`,[randomUUID(),space,id]);
 return id;
}

const traceChildren=async(runId:string)=>{
 const res=await app.inject({method:'GET',url:`/api/v1/runs/${runId}/trace`});
 expect(res.statusCode,res.body).toBe(200);
 return (res.json().children as Array<{id:string}>).map(c=>c.id).sort();
};

async function assetWithCandidate():Promise<{asset:string;base:string;candidate:string}>{
 const created=await rest('/api/v1/evolution/assets',{asset_type:'agent_config',asset_key:`config.${randomUUID()}`,display_name:'Flow',owner_scope_type:'user'});
 expect(created.statusCode,created.body).toBe(201);const asset=created.json().data.asset_id as string;
 const version=async(body:object)=>{const res=await rest(`/api/v1/evolution/assets/${asset}/versions`,body);expect(res.statusCode,res.body).toBe(201);return res.json().data.version_id as string;};
 const base=await version({scope_type:'user',scope_id:current,content_json:{instructions:'a'}});
 await db.pool.query("UPDATE evolvable_asset_versions SET status='approved' WHERE id=$1",[base]);
 const candidate=await version({scope_type:'user',scope_id:current,parent_version_id:base,content_json:{instructions:'b'}});
 await db.pool.query("UPDATE evolvable_asset_versions SET status='candidate' WHERE id=$1",[candidate]);
 return {asset,base,candidate};
}
const caseBody=(base:string,source_run_id:string)=>({name:'Case',baseline_version_id:base,source_run_id,verification_recipe_json:{checks:[{type:'non_empty',path:'summary'}]}});
const storedCases=async(asset:string)=>(await db.pool.query<{n:number;body:boolean}>(`SELECT count(*)::int n,bool_or(baseline_output_json::text LIKE '%'||$2||'%') body FROM evaluation_cases WHERE asset_id=$1`,[asset,BODY])).rows[0]!;

it('creates an evaluation case, evaluates and previews a workflow only from a Run whose body the caller may read',async()=>{
 const full=await sourceRun({first:true});
 // Summary for every reader: a monitoring comparison batch Run.
 const comparison=await sourceRun({contract:{source:{kind:'direct',id:null},risk_level:'low',workflow_input_json:{project_research_standing:{batch:1}}}});
 as(owner);
 const {asset,base,candidate}=await assetWithCandidate();

 const made=await rest(`/api/v1/evolution/assets/${asset}/evaluation-cases/from-run`,caseBody(base,full));
 expect(made.statusCode,made.body).toBe(201);
 expect(await storedCases(asset)).toEqual({n:1,body:true});

 const refused=await rest(`/api/v1/evolution/assets/${asset}/evaluation-cases/from-run`,caseBody(base,comparison));
 expect(refused.statusCode,refused.body).toBe(422);
 expect(refused.json().error.message).toContain('needs full read access');
 expect(refused.body).not.toContain(BODY);
 expect(await storedCases(asset)).toEqual({n:1,body:true});

 // Evaluating reads the candidate Run's output: full passes, summary refuses.
 const caseId=made.json().data.case_id as string;
 const candidateFull=await sourceRun({workflowVersionId:candidate});
 const candidateSummary=await sourceRun({workflowVersionId:candidate,contract:{source:{kind:'direct',id:null},risk_level:'low',workflow_input_json:{project_research:{stage_key:'monitor_compare'}}}});
 const execute=(runId:string)=>rest(`/api/v1/evolution/assets/${asset}/versions/${candidate}/evaluation-cases/${caseId}/execute`,{candidate_run_id:runId});
 const blocked=await execute(candidateSummary);
 expect(blocked.statusCode,blocked.body).toBe(422);
 expect(blocked.body).not.toContain(BODY);
 expect((await execute(candidateFull)).statusCode).toBe(202);

 // A workflow is derived from the Run's prompts.
 const preview=(run_id:string)=>rest('/api/v1/evolution/workflows/from-run/preview',{run_id});
 const previewed=await preview(full);
 expect(previewed.statusCode,previewed.body).toBe(200);
 expect(previewed.body).toContain(BODY);
 const hidden=await preview(comparison);
 expect(hidden.statusCode,hidden.body).toBe(422);
 expect(hidden.body).not.toContain(BODY);
});

it('refuses a member who sees another person\'s Run only at summary level, and still allows the owner',async()=>{
 const summary=await sourceRun({first:true,accessLevel:'summary'});
 await db.pool.query("UPDATE runs SET error_message=$2 WHERE id=$1",[summary,BODY]);
 as(member);
 const detail=await app.inject({method:'GET',url:`/api/v1/runs/${summary}`});
 expect(detail.statusCode,detail.body).toBe(200);
 expect(detail.json()).toMatchObject({effective_access_level:'summary',error_message:null});
 const status=await app.inject({method:'GET',url:`/api/v1/runs/${summary}/status`});
 expect(status.statusCode,status.body).toBe(200);
 expect(status.json()).toMatchObject({effective_access_level:'summary',error_message:null});
 const {asset,base}=await assetWithCandidate();
 const refused=await rest(`/api/v1/evolution/assets/${asset}/evaluation-cases/from-run`,caseBody(base,summary));
 expect(refused.statusCode,refused.body).toBe(422);
 expect(refused.body).not.toContain(BODY);
 expect(await storedCases(asset)).toEqual({n:0,body:null});
 const preview=await rest('/api/v1/evolution/workflows/from-run/preview',{run_id:summary});
 expect(preview.statusCode,preview.body).toBe(422);
 expect(preview.body).not.toContain(BODY);

 as(owner);
 const own=await assetWithCandidate();
 const made=await rest(`/api/v1/evolution/assets/${own.asset}/evaluation-cases/from-run`,caseBody(own.base,summary));
 expect(made.statusCode,made.body).toBe(201);
 expect(await storedCases(own.asset)).toEqual({n:1,body:true});
});

const preview=(run_id:string)=>rest('/api/v1/evolution/workflows/from-run/preview',{run_id});
const save=(run_id:string)=>rest('/api/v1/evolution/workflows/from-run/save',{run_id,asset_key:`flow.${randomUUID()}`});
const storedText=async(marker:string)=>(await db.pool.query<{n:number}>(`SELECT count(*)::int n FROM evolvable_asset_versions WHERE content_json::text LIKE '%'||$1||'%'`,[marker])).rows[0]!.n;

it('lets Space oversight read another person\'s Run but never copy or derive from it',async()=>{
 await db.pool.query("UPDATE spaces SET oversight_mode='full' WHERE id=$1",[space]);
 // The member's private Run: the Space owner reaches it through oversight alone.
 const theirs=await sourceRun({first:true,owner:member,visibility:'private'});
 as(owner);
 const read=await app.inject({method:'GET',url:`/api/v1/runs/${theirs}`});
 expect(read.statusCode,read.body).toBe(200);
 // Oversight releases the body itself, not only the Run's status.
 expect(read.json()).toMatchObject({id:theirs,output_json:{summary:BODY}});

 const {asset,base,candidate}=await assetWithCandidate();
 const refused=await rest(`/api/v1/evolution/assets/${asset}/evaluation-cases/from-run`,caseBody(base,theirs));
 expect(refused.statusCode,refused.body).toBe(422);
 expect(refused.body).not.toContain(BODY);
 expect(await storedCases(asset)).toEqual({n:0,body:null});

 // A case from the owner's own Run, then a candidate visible only through oversight.
 const own=await sourceRun({prompt:'Own work'});
 const made=await rest(`/api/v1/evolution/assets/${asset}/evaluation-cases/from-run`,caseBody(base,own));
 expect(made.statusCode,made.body).toBe(201);
 const overseen=await sourceRun({owner:member,visibility:'private',workflowVersionId:candidate});
 const blocked=await rest(`/api/v1/evolution/assets/${asset}/versions/${candidate}/evaluation-cases/${made.json().data.case_id}/execute`,{candidate_run_id:overseen});
 expect(blocked.statusCode,blocked.body).toBe(422);
 expect(blocked.body).not.toContain(BODY);

 for(const attempt of [preview,save]){
  const res=await attempt(theirs);
  expect(res.statusCode,res.body).toBe(422);
  expect(res.body).not.toContain(BODY);
 }
 // The owner's own parent whose child the member owns privately: listed through
 // oversight, but its prompt is not the owner's to copy.
 const parent=await sourceRun({prompt:'Parent plan'});
 await sourceRun({owner:member,visibility:'private',parent,prompt:'OVERSEEN_CHILD_STEP'});
 for(const attempt of [preview,save]){
  const res=await attempt(parent);
  expect(res.statusCode,res.body).toBe(422);
  expect(res.body).not.toContain('OVERSEEN_CHILD_STEP');
 }
 expect(await storedText(BODY)+await storedText('OVERSEEN_CHILD_STEP')).toBe(0);
});

it('derives a workflow only from the child Runs the caller can discover and read',async()=>{
 const parent=await sourceRun({first:true,prompt:'Parent plan'});
 const ownChild=await sourceRun({parent,prompt:'OWN_CHILD_STEP'});
 // Not discoverable: another member's private child, and a Reading method child
 // whose domain gate admits only the member who started it.
 const hiddenChild=await sourceRun({owner:member,visibility:'private',parent,prompt:'HIDDEN_CHILD_STEP'});
 const gatedChild=await sourceRun({parent,instructedBy:member,prompt:'GATED_CHILD_STEP',contract:{source:{kind:'direct',id:null},risk_level:'low',workflow_input_json:{reading_method:{asset_id:randomUUID()}}}});
 as(owner);

 // Trace children are metadata only, so the gate shows in which ids are listed.
 const children=await traceChildren(parent);
 expect(children).toEqual([ownChild]);
 expect(children).not.toContain(hiddenChild);
 expect(children).not.toContain(gatedChild);

 const previewed=await preview(parent);
 expect(previewed.statusCode,previewed.body).toBe(200);
 expect(previewed.body).toContain('OWN_CHILD_STEP');
 expect(previewed.body).not.toContain('HIDDEN_CHILD_STEP');
 expect(previewed.body).not.toContain('GATED_CHILD_STEP');

 const saved=await save(parent);
 expect(saved.statusCode,saved.body).toBe(201);
 expect(saved.json().data.status).toBe('draft_saved');
 expect(saved.body).not.toContain('HIDDEN_CHILD_STEP');
 expect(saved.body).not.toContain('GATED_CHILD_STEP');
 expect(await storedText('OWN_CHILD_STEP')).toBe(1);
 expect(await storedText('HIDDEN_CHILD_STEP')+await storedText('GATED_CHILD_STEP')).toBe(0);

 // A child the caller sees only at summary level still blocks the derivation.
 await sourceRun({owner:member,parent,accessLevel:'summary',prompt:'SUMMARY_CHILD_STEP'});
 for(const attempt of [preview,save]){
  const res=await attempt(parent);
  expect(res.statusCode,res.body).toBe(422);
  expect(res.body).not.toContain('SUMMARY_CHILD_STEP');
 }
});

/** A Note owned by `by` at revision 1, and the frozen plugin Note draft input that pins it. */
async function draftContract(project:string,by:string){
 const note=randomUUID(),doc=markdownToPm('Draft input');
 await db.pool.query(`INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,primary_project_id,created_at,updated_at) VALUES($1,$2,'note','Input','private',$3,$4,now(),now())`,[note,space,by,project]);
 await db.pool.query(`INSERT INTO notes(object_id,space_id,content_json,content_format,content_schema_version,plain_text) VALUES($1,$2,$3::jsonb,'prosemirror_json',1,'Draft input')`,[note,space,JSON.stringify(doc)]);
 await insertInitialNoteRevision(db.pool,{spaceId:space,noteId:note,doc,at:new Date().toISOString(),userId:by});
 return {source:{kind:'direct',id:null},risk_level:'low',workflow_input_json:{plugin_note_draft:{plugin_id:'phd_application',project_id:project,inputs:[{note_id:note,version:1}],instruction:'Draft'}}};
}

it('lists a plugin Note draft child in the trace and derives from it only for its starter while they still read every input',async()=>{
 const parent=await sourceRun({first:true,prompt:'Parent plan'});
 const project=randomUUID();
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'P','active',now(),now())",[project,space,owner]);
 const ownInput=await draftContract(project,owner);
 // The owner started it and reads the Project and its input: listed and derived from.
 const allowed=await sourceRun({parent,project,contract:ownInput,prompt:'ALLOWED_DRAFT_STEP'});
 // Shared with the Space, but started by the member: the starter gate hides it.
 const otherStarter=await sourceRun({parent,project,instructedBy:member,contract:ownInput,prompt:'OTHER_STARTER_DRAFT_STEP'});
 // The owner's own draft over the member's private Note: the input gate hides it.
 const unreadableInput=await sourceRun({parent,project,contract:await draftContract(project,member),prompt:'UNREADABLE_INPUT_DRAFT_STEP'});
 as(owner);

 const children=await traceChildren(parent);
 expect(children).toEqual([allowed]);
 expect(children).not.toContain(otherStarter);
 expect(children).not.toContain(unreadableInput);
 for(const id of [otherStarter,unreadableInput])
  expect((await app.inject({method:'GET',url:`/api/v1/runs/${id}`})).statusCode).toBe(404);

 const saved=await save(parent);
 expect(saved.statusCode,saved.body).toBe(201);
 expect(await storedText('ALLOWED_DRAFT_STEP')).toBe(1);
 expect(await storedText('OTHER_STARTER_DRAFT_STEP')+await storedText('UNREADABLE_INPUT_DRAFT_STEP')).toBe(0);
});
