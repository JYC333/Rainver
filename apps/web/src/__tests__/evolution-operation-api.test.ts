// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {evolutionApi,setSpaceContext} from '../api/client';
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const body=(call:unknown[])=>JSON.parse(String((call[1] as RequestInit).body));
const urls=()=>vi.mocked(fetch).mock.calls.map(([url])=>String(url));
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{vi.unstubAllGlobals();});
it('sends keyed target commands and rereads the target through its reader',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',target_id:'t1'}},201)).mockResolvedValueOnce(response({id:'t1',status:'active'}));
 expect(await evolutionApi.createTarget({target_type:'workflow',risk_level:'low'})).toMatchObject({id:'t1'});
 expect(urls()).toEqual(['/api/v1/actions/evolution.target.create','/api/v1/evolution/targets/t1']);
 expect(new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('Idempotency-Key')).toBeTruthy();
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',target_id:'t1'}})).mockResolvedValueOnce(response({id:'t1',status:'archived'}));
 expect(await evolutionApi.updateTarget('t1',{status:'archived',enabled:false})).toMatchObject({status:'archived'});
 expect(body(vi.mocked(fetch).mock.calls[0]!)).toEqual({status:'archived',enabled:false,target_id:'t1'});
});
it('triages, dismisses and records signals as keyed commands and rereads the signal',async()=>{
 const receipt={status:'succeeded',data:{space_id:'current-space',target_id:'t1',signal_id:'s1'}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({id:'s1',triage_status:'dismissed'}));
 expect(await evolutionApi.dismissSignal('s1')).toMatchObject({triage_status:'dismissed'});
 expect(urls()).toEqual(['/api/v1/actions/evolution.signal.triage','/api/v1/evolution/signals/s1']);
 expect(body(vi.mocked(fetch).mock.calls[0]!)).toEqual({triage_status:'dismissed',signal_id:'s1'});
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt,201)).mockResolvedValueOnce(response({id:'s1'}));
 await evolutionApi.createSignal('t1',{signal_type:'review_requested',source_type:'manual',severity:'medium'});
 expect(urls()).toEqual(['/api/v1/actions/evolution.signal.create','/api/v1/evolution/signals/s1']);
 expect(body(vi.mocked(fetch).mock.calls[0]!)).toMatchObject({target_id:'t1',signal_type:'review_requested'});
});
it('sends asset, evaluation and promotion writes as keyed commands and rereads through the list readers',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',asset_id:'a1',version_id:'v2'}},201)).mockResolvedValueOnce(response([{id:'v1'},{id:'v2',status:'draft'}]));
 expect(await evolutionApi.createAssetVersion('a1',{content_json:{x:1}})).toMatchObject({id:'v2',status:'draft'});
 expect(urls()).toEqual(['/api/v1/actions/evolution.asset.version.create','/api/v1/evolution/assets/a1/versions']);
 expect(body(vi.mocked(fetch).mock.calls[0]!)).toEqual({content_json:{x:1},asset_id:'a1'});
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',proposal_id:'p1',status:'pending',proposal_type:'evolvable_asset_version_promote'}},201));
 expect(await evolutionApi.createAssetPromotionProposal('a1','v2',{target_scope_type:'space'})).toEqual({proposal_id:'p1',status:'pending',proposal_type:'evolvable_asset_version_promote'});
 expect(urls()).toEqual(['/api/v1/actions/evolution.asset.promotion.propose']);
 vi.mocked(fetch).mockClear();
 // A read-only query goes to its retained URL with no key.
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{assetId:'a1',versionId:'v1'}}));
 expect(await evolutionApi.resolveAsset('a1')).toEqual({assetId:'a1',versionId:'v1'});
 expect(urls()).toEqual(['/api/v1/evolution/assets/a1/resolve']);
 expect(new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('Idempotency-Key')).toBeNull();
});
it('queues an Evolution Run and surfaces a recorded not-selected decision as an error',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',status:'queued',target_id:'t1',run_id:'r1',job_id:'j1',selector_decision_id:'d1',selected_strategy_key:'repair.x'}},202));
 expect(await evolutionApi.runTarget('t1',{agent_id:'g1',mode:'dry_run'})).toEqual({run_id:'r1',target_id:'t1',selector_decision_id:'d1',selected_strategy_key:'repair.x',run_status:'queued',proposal_ids:[]});
 expect(urls()).toEqual(['/api/v1/actions/evolution.target.run']);
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',status:'not_selected',target_id:'t1',selector_decision_id:'d2',reason:'No compatible active strategy passed selector policy.'}},202));
 await expect(evolutionApi.runTarget('t1',{agent_id:'g1'})).rejects.toThrow('No compatible active strategy');
});
