import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {goalResponseDiagnostic} from '../src/modules/sources/goals/diagnostics.js';
import {expect,it} from 'vitest';
import {SourceGoalBudgetSchema,SourceGoalPlanSchema,SourceGoalVersionWriteSchema} from '@rainver/protocol';
import {validateGoalSample} from '../src/modules/sources/goals/validation.js';
const options={budget:SourceGoalBudgetSchema.parse({}),includes:['robotics'],excludes:['advert']};
const item={external_id:'one',title:'Robotics update',source_uri:'https://fixture.test/one',published_at:'2026-10-26T00:00:00Z',snapshots:[],evidence:[]};
const output=(items:unknown[])=>({contract_version:'custom_source.handler_output.v1',items});
it('requires meaningful preview data while permitting an empty valid incremental scan',()=>{
 expect(validateGoalSample(output([]),options).ok).toBe(false);
 expect(validateGoalSample(output([]),{...options,allowEmpty:true}).ok).toBe(true);
 expect(validateGoalSample({items:[]},{...options,allowEmpty:true}).ok).toBe(false);
});
it('rejects missing time, duplicate identities, irrelevant data and stable-ID drift',()=>{
 expect(validateGoalSample(output([item,{...item}]),options).errors).toContain('duplicate_stable_id');
 expect(validateGoalSample(output([{...item,published_at:null}]),options).errors).toContain('missing_identity_time_or_link');
 expect(validateGoalSample(output([{...item,title:'Irrelevant'}]),options)).toMatchObject({count:0,filtered_count:1});
 expect(validateGoalSample(output([{...item,title:'Robotics advert'}]),options)).toMatchObject({count:0,filtered_count:1});
 expect(validateGoalSample(output([item]),{...options,baselineIds:['different']}).errors).toContain('stable_identity_drift');
});
it('cannot bind two channels of the same Source as separate contributions',()=>{
 const source={source_connection_id:'one',source_channel_id:'a',reason:'coverage',supports_history:false,implementation:{kind:'connector'}};
 expect(SourceGoalPlanSchema.safeParse({summary:'A plan',sources:[source,{...source,source_channel_id:'b'}],limitations:[]}).success).toBe(false);
});

it('keeps captured real Agent implementations hash-locked without evaluating generated code outside isolation',()=>{
 const captured=JSON.parse(readFileSync(new URL('./fixtures/sourceGoals/observations.real-agent.json',import.meta.url),'utf8'));
 for(const impl of [captured.initial,captured.repaired])expect(createHash('sha256').update(impl.code).digest('hex')).toBe(impl.sha256);
 expect(captured.provenance.handwritten).toBe(false);expect(captured.provenance.repair_publication_status).toBe('published');
});
it('exposes only bounded response schema diagnostics, without JSON values or raw body',()=>{
 const diagnostic=goalResponseDiagnostic({sequence:1,status:200,content_type:'application/json',body_base64:Buffer.from(JSON.stringify({observations:{entries:[{id:'PRIVATE_SOURCE_VALUE'}]}})).toString('base64')});
 expect(diagnostic).toMatchObject({schema_only:true,json_shape:{observations:{entries:{array:'object'}}}});expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_SOURCE_VALUE');expect(diagnostic).not.toHaveProperty('body_base64');
});

import {goalDispatchErrorCode,sourceGoalError} from '../src/modules/sources/goals/dispatchError.js';
import {HttpError} from '../src/modules/routeUtils/common.js';
import {RunBudgetExceededError} from '../src/modules/runs/budgetEnforcement.js';
it('classifies typed admission and stable codes independently of exception prose',()=>{
 expect(goalDispatchErrorCode(new RunBudgetExceededError('run_budget_exceeded','arbitrary localized text'))).toBe('source_goal_exploration_budget_exhausted');
 expect(goalDispatchErrorCode({code:'source_goal_stopped',message:'Budget Profile'})).toBe('source_goal_stopped');
 expect(goalDispatchErrorCode(new HttpError(409,'source_goal_execution_setup_required'))).toBe('source_goal_execution_setup_required');
 expect(goalDispatchErrorCode(new HttpError(403,'Unrelated text'))).toBe('source_goal_access_required');
 expect(goalDispatchErrorCode(new Error('Budget Profile stopped secret'))).toBe('source_goal_dispatch_failed');
});

it('publishes stable goal codes through the existing HttpError response envelope',()=>{const e=sourceGoalError(409,'source_goal_stopped');expect(e.statusCode).toBe(409);expect(e.responseBody).toEqual({error:'source_goal_stopped',message:'source_goal_stopped'});expect(goalDispatchErrorCode(e)).toBe('source_goal_stopped');});

import {repairInspectionResult,syntheticRepairFixture,validateEphemeralAnchors,repairImplementationHash} from '../src/modules/sources/goals/ephemeralRepair.js';
const responseFixture=(body:unknown,type='application/json')=>({responses:[{sequence:1,status:200,content_type:type,final_url:'https://fixture.test/api?access=PRIVATE_QUERY',headers:{etag:'PRIVATE_HEADER'},body_base64:Buffer.from(typeof body==='string'?body:JSON.stringify(body)).toString('base64')}]});
it('returns only structure and replaced values to a repair Run, including nested fields and response metadata',()=>{
 const fixture=responseFixture({entries:[{id:'PRIVATE_ID',title:'PRIVATE_TITLE',date:'2026-10-26T00:00:00Z',url:'https://PRIVATE_HOST.test/PRIVATE_PATH',nested:{description:'PRIVATE_BODY'}}]});
 const result=repairInspectionResult(fixture);const wire=JSON.stringify(result);const body=Buffer.from(result.synthetic_fixture.responses[0].body_base64,'base64').toString();
 expect(wire).not.toContain('PRIVATE');expect(body).not.toContain('PRIVATE');expect(wire).not.toContain('PRIVATE_HEADER');expect(result.synthetic_fixture.responses[0].final_url).toBe('https://fixture.test/api');
 expect(JSON.parse(body).entries[0]).toHaveProperty('nested.description');expect(syntheticRepairFixture(fixture,'first')).not.toEqual(syntheticRepairFixture(fixture,'second'));
});
it('anchors identities, titles, dates and links in the same record and rejects swapped fields or fabricated output',()=>{
 const row={id:'one',title:'Robotics update',date:item.published_at,url:item.source_uri};const fixture=responseFixture({entries:[row,{id:'two',title:'Robotics other',date:'2026-10-27T00:00:00Z',url:'https://fixture.test/two'}]});
 expect(validateEphemeralAnchors(output([item]),fixture)).toBe(true);
 for(const changed of [{external_id:item.title,title:item.external_id},{title:'Fabrication'},{published_at:'2026-10-27T00:00:00Z'},{source_uri:'https://outside.test/one'}])expect(validateEphemeralAnchors(output([{...item,...changed}]),fixture)).toBe(false);
 expect(validateEphemeralAnchors(output([item]),syntheticRepairFixture(fixture))).toBe(false);expect(validateEphemeralAnchors(output([{...item,title:'Robotics other'}]),responseFixture({left:row,right:{id:'two',title:'Robotics other',date:item.published_at,url:'https://fixture.test/two'}}))).toBe(false);
});
it('supports bounded XML schema synthesis while refusing entities, unsupported media and unrecognizable field semantics',()=>{
 const fixture=responseFixture('<rss><channel><item><guid>one</guid><title>Robotics update</title><link>https://fixture.test/one</link><pubDate>Mon, 26 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>','application/xml');
 expect(validateEphemeralAnchors(output([item]),fixture)).toBe(true);expect(Buffer.from(syntheticRepairFixture(fixture).responses[0].body_base64,'base64').toString()).not.toContain('Robotics update');
 expect(()=>repairInspectionResult(responseFixture('<!DOCTYPE rss [<!ENTITY x "PRIVATE">]><rss/>','application/xml'))).toThrow('source_repair_validation_insufficient');
 expect(()=>repairInspectionResult(responseFixture('PRIVATE_TEXT','text/plain'))).toThrow('source_repair_validation_insufficient');
 expect(validateEphemeralAnchors(output([item]),responseFixture({a:'one',b:item.title,c:item.published_at,d:item.source_uri}))).toBe(false);
});

it('keeps transient proof implementation identity stable across JSONB key reordering',()=>{expect(repairImplementationHash({kind:'isolated',code:'parser',sha256:'sha'})).toBe(repairImplementationHash({code:'parser',sha256:'sha',kind:'isolated'}));expect(repairImplementationHash({kind:'isolated',code:'parser',sha256:'sha'})).not.toBe(repairImplementationHash({kind:'isolated',code:'different',sha256:'sha'}));});

import {trustedSearchMetadataOrigins} from '../src/modules/sources/goals/validation.js';
it('permits undated search metadata only explicitly and never grants generated-code result origins',()=>{
 const raw=output([{...item,published_at:null}]);expect(validateGoalSample(raw,options).ok).toBe(false);expect(validateGoalSample(raw,{...options,allowUndated:true}).ok).toBe(true);expect(validateGoalSample(output([{...item,published_at:'not-a-date'}]),{...options,allowUndated:true}).ok).toBe(false);
 expect(trustedSearchMetadataOrigins('brave_web_search_api',{kind:'connector'},raw)).toEqual(['https://fixture.test']);expect(trustedSearchMetadataOrigins('brave_web_search_api',{kind:'isolated'},raw)).toEqual([]);expect(trustedSearchMetadataOrigins('custom_source',{kind:'connector'},raw)).toEqual([]);
});

import {validateCustomSourceHandlerOutput} from '../src/modules/sources/customSources/customSourceContractValidator.js';
import {sourcePolicyEnvelope} from './support/customSourceFixtures.js';
it('keeps search metadata-link permission separate from network, file and generated output authority',async()=>{
 const base={raw:output([item]),limits:sourcePolicyEnvelope().limits,allowedNetworkOrigins:['https://api.search.test'],sandboxFilesRoot:'/tmp/no-search-files'};expect((await validateCustomSourceHandlerOutput(base)).ok).toBe(false);expect((await validateCustomSourceHandlerOutput({...base,metadataOnlyOrigins:['https://fixture.test']})).ok).toBe(true);
 const snapshot={...item,snapshots:[{snapshot_type:'raw_html',file_path:'missing.txt',mime_type:'text/plain'}]};const checked=await validateCustomSourceHandlerOutput({...base,raw:output([snapshot]),metadataOnlyOrigins:['https://fixture.test']});expect(checked.ok).toBe(false);if(!checked.ok)expect(checked.errors.join(' ')).toContain('source_uri is outside');
});

it('upstream continuation reads only explicit connector contracts',async()=>{
 const {upstreamContinuation}=await import('../src/modules/sources/goals/selection.js');
 expect(upstreamContinuation({cursor:'next'})).toBe('more');expect(upstreamContinuation({cursor:null})).toBe('done');expect(upstreamContinuation({cursor:''})).toBe('done');
 expect(upstreamContinuation({offset:20})).toBe('more');expect(upstreamContinuation({offset:null})).toBe('done');
 expect(upstreamContinuation({more_results_available:true})).toBe('more');expect(upstreamContinuation({more_results_available:false})).toBe('done');
 expect(upstreamContinuation({token:'x',watermark:'2026-10-26T00:00:00Z'})).toBe('unknown');expect(upstreamContinuation({})).toBe('unknown');
});

it('accepts bounded short planning titles and remains compatible with untitled plans',()=>{
 const source={source_connection_id:'one',source_channel_id:'a',reason:'coverage',supports_history:false,implementation:{kind:'connector'}};
 const plan={summary:'A plan',sources:[source],limitations:[]};
 expect(SourceGoalPlanSchema.parse({...plan,title:'  Robotics  '}).title).toBe('Robotics');
 const native={goal_id:'goal',expected_revision:0,plan:{...plan,title:'Robotics',sources:[{reason:'Coverage',supports_history:false,implementation:{kind:'agent_search',query:'robotics research'}}]}};
 expect(SourceGoalVersionWriteSchema.parse(native).plan.title).toBe('Robotics');
 expect(SourceGoalPlanSchema.safeParse(plan).success).toBe(true);
 expect(SourceGoalPlanSchema.safeParse({...plan,title:'x'.repeat(61)}).success).toBe(false);
 expect(SourceGoalPlanSchema.safeParse({...plan,title:'  '}).success).toBe(false);
});
