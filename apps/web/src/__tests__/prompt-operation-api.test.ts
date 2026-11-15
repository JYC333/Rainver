// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {promptsApi,readingMethodsApi,setSpaceContext} from '../api/client';
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const body=(call:unknown[])=>JSON.parse(String((call[1] as RequestInit).body));
const urls=()=>vi.mocked(fetch).mock.calls.map(([url])=>String(url));
const key=(i:number)=>new Headers((vi.mocked(fetch).mock.calls[i]![1] as RequestInit).headers).get('Idempotency-Key');
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{vi.unstubAllGlobals();});
it('deploys a prompt label as a keyed command and rereads the ref; render preview is an unkeyed query',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',asset_key:'chat.reply',deployment_id:'d2'}})).mockResolvedValueOnce(response([{id:'d1'},{id:'d2',label:'staging'}]));
 expect(await promptsApi.setDeployment('chat.reply','staging',{version_id:'v1',scope_type:'space',scope_id:'current-space'})).toMatchObject({id:'d2',label:'staging'});
 expect(urls()).toEqual(['/api/v1/actions/prompt.deployment.set','/api/v1/prompts/assets/chat.reply/deployments']);
 expect(body(vi.mocked(fetch).mock.calls[0]!)).toEqual({version_id:'v1',scope_type:'space',scope_id:'current-space',asset_key:'chat.reply',label:'staging'});
 expect(key(0)).toBeTruthy();
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{asset_key:'chat.reply',version_id:null,rendered_text:'Hi',rendered_messages:null,validation_errors:[],validation_warnings:[]}}));
 expect(await promptsApi.renderPreview('chat.reply',{variables:{name:'x'}})).toMatchObject({rendered_text:'Hi'});
 expect(urls()).toEqual(['/api/v1/prompts/assets/chat.reply/render-preview']);expect(key(0)).toBeNull();
});
it('starts and cancels Reading Method work as keyed commands and reads results through the GET readers',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',trial_id:'t1'}},202)).mockResolvedValueOnce(response({id:'t1',status:'queued'}));
 expect(await readingMethodsApi.trial({item_id:'i'})).toMatchObject({id:'t1',status:'queued'});
 expect(urls()).toEqual(['/api/v1/actions/reading_method.trial.start','/api/v1/prompts/reading-method/trials/t1']);
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',generation_id:'g1'}})).mockResolvedValueOnce(response({id:'g1',status:'cancelled'}));
 expect(await readingMethodsApi.cancelGeneration('g1')).toMatchObject({status:'cancelled'});
 expect(urls()).toEqual(['/api/v1/actions/reading_method.generation.cancel','/api/v1/prompts/reading-method/generations/g1']);
 expect(body(vi.mocked(fetch).mock.calls[0]!)).toEqual({generation_id:'g1'});
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',proposal_id:'p1'}},201));
 expect(await readingMethodsApi.promote({version_id:'v',evaluation_id:'e'})).toEqual({id:'p1',proposal_id:'p1'});
});
