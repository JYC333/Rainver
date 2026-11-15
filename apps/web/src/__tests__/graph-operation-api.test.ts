// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {graphApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('saves typed navigation state with a caller key and unwraps owner metadata',async()=>{
 const state={scope_key:'core:graph',state_json:{zoom:3},updated_at:'2026-11-13T00:00:00.000Z'};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{space_id:'space',user_id:'person',...state}}),{status:200,headers:{'Content-Type':'application/json'}}));
 expect(await graphApi.saveViewState(state.scope_key,state.state_json,'same-key')).toEqual(state);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/graph.view_state.save');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('same-key');
 expect(JSON.parse(String(init!.body))).toEqual({scope_key:state.scope_key,state_json:state.state_json});
});
it('does not retry an unknown save outcome',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('connection lost'));
 await expect(graphApi.saveViewState('core:graph',{},'same-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
