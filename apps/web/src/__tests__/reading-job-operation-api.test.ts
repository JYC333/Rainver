// @vitest-environment node
import {afterEach,it,expect,vi} from 'vitest';
import {projectReadingApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
it('sends a keyed exact operation cancellation and returns its durable intent receipt',async()=>{
 setSpaceContext('space');const data={id:'operation',operation_id:'operation',run_id:'run',status:'cancelling',space_id:'space',project_id:'project',user_id:'person'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:200,headers:{'Content-Type':'application/json'}})));
 expect(await projectReadingApi.cancel('space','project','operation','key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe('/api/v1/actions/reading.deep_read.cancel');
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('key');
 expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',project_id:'project',operation_id:'operation'});
 expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['start','composition','annotation'] as const)('sends one typed keyed %s command without automatic replay',async kind=>{
 const {informationDigestsApi}=await import('../api/client');
 setSpaceContext('space');const data=kind==='annotation'?{reopened:1}:kind==='composition'?{status:'queued',round_ids:['round']}:{status:'queued',processing_id:'operation',run_id:'run'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:200,headers:{'Content-Type':'application/json'}})));
 const result=kind==='start'?await projectReadingApi.start('space','project','item',{agent_id:'agent',runtime_profile_id:'profile',retry_of:'previous'},'key'):kind==='composition'?await projectReadingApi.retryComposition('space','project','key'):await informationDigestsApi.retryAnnotation('space',{episode_id:'episode',connection_id:'connection'},'key');
 expect(result).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe(`/api/v1/actions/reading.${kind==='start'?'deep_read.start':kind==='composition'?'composition.retry':'annotation.retry'}`);
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('key');
 expect(JSON.parse(String(init!.body))).toEqual(kind==='start'?{space_id:'space',project_id:'project',item_id:'item',agent_id:'agent',runtime_profile_id:'profile',retry_of:'previous'}:kind==='composition'?{space_id:'space',project_id:'project'}:{space_id:'space',episode_id:'episode',connection_id:'connection'});
 expect(fetch).toHaveBeenCalledTimes(1);
});
