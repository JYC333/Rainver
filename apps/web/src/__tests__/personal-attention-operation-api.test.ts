// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {agentAttentionApi,personalMemoryGrantsApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('browsed');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
const respond=(data:unknown)=>vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data}),{headers:{'Content-Type':'application/json'}}));
it('uses the three retained grant URLs with caller retry keys and unwraps receipts',async()=>{
 const body={target_space_id:'target',target_run_id:'run',access_mode:'summary_only' as const,read_expires_in_seconds:60};
 respond({id:'grant'});
 expect(await personalMemoryGrantsApi.createPersonalMemoryGrant(body,'create-key')).toEqual({id:'grant'});
 await personalMemoryGrantsApi.previewPersonalMemoryGrant(body,'preview-key');
 await personalMemoryGrantsApi.revokePersonalMemoryGrant('grant','revoke-key');
 expect(vi.mocked(fetch).mock.calls.map(([url])=>url)).toEqual(['/api/v1/personal-memory-grants','/api/v1/personal-memory-grants/preview','/api/v1/personal-memory-grants/grant/revoke']);
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['create-key','preview-key','revoke-key']);
});
it('preserves attention return shapes, cancellation and explicit retry keys without browsed Space',async()=>{
 const state={subject:{kind:'message' as const,schema_version:1 as const,message_id:'message',revision:'r'},unread:false,manual_unread:false,read_at:null,state_version:1};
 const signal=new AbortController().signal;
 respond({space_id:'target',identity:{kind:'session',source_id:'session'},state});
 expect(await agentAttentionApi.setReadState({space_id:'target',identity:{kind:'session',source_id:'session'},subject:state.subject,state_version:0,action:'read'},{signal,idempotencyKey:'read-key'})).toEqual(state);
 respond({space_id:'target',session_id:'session',read_count:1,read_states:[state]});
 expect(await agentAttentionApi.recordViews({space_id:'target',session_id:'session',message_ids:['message']},{signal,idempotencyKey:'view-key'})).toEqual({read_count:1,read_states:[state]});
 for(const [,init] of vi.mocked(fetch).mock.calls){expect(new Headers(init!.headers).has('X-Rainver-Space-Id')).toBe(false);expect(init!.signal).toBe(signal);}
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['read-key','view-key']);
});
it('does not resubmit an uncertain grant write',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('lost'));
 await expect(personalMemoryGrantsApi.revokePersonalMemoryGrant('grant','key')).rejects.toThrow();
 expect(fetch).toHaveBeenCalledTimes(1);
});
