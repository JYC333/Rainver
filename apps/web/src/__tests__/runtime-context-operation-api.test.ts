// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {runtimeContextApi,setSpaceContext} from '../api/client';
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const body=(call:unknown[])=>JSON.parse(String((call[1] as RequestInit).body));
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{vi.unstubAllGlobals();});
it('sends a keyed switch command for a direct or Room conversation and rereads the switch',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',work_context_scope_id:'w',setup_id:'s',version:2}})).mockResolvedValueOnce(response({work_context_scope_id:'w',enabled:true,preferred_domains:['knowledge'],setup_version:2}));
 expect(await runtimeContextApi.setRetrievalSwitch({scopeId:'w'},{enabled:true})).toMatchObject({setup_version:2});
 let calls=vi.mocked(fetch).mock.calls;
 expect(calls.map(([url])=>String(url))).toEqual(['/api/v1/actions/runtime_context.work_context.retrieval.set','/api/v1/runtime-context/work-contexts/w/retrieval']);
 expect(body(calls[0]!)).toEqual({enabled:true,work_context_scope_id:'w'});
 expect(new Headers((calls[0]![1] as RequestInit).headers).get('Idempotency-Key')).toBeTruthy();
 vi.mocked(fetch).mockClear();
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{space_id:'current-space',session_id:'c'}})).mockResolvedValueOnce(response({work_context_scope_id:null,enabled:false,preferred_domains:[],setup_version:null}));
 await runtimeContextApi.setRetrievalSwitch({sessionId:'c'},{enabled:false});
 calls=vi.mocked(fetch).mock.calls;
 expect(calls.map(([url])=>String(url))).toEqual(['/api/v1/actions/runtime_context.room_conversation.retrieval.set','/api/v1/runtime-context/room-conversations/c/retrieval']);
 expect(body(calls[0]!)).toEqual({enabled:false,session_id:'c'});
});
