// @vitest-environment node
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {informationDigestsApi,projectReadingApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it.each(['favorite','project','personal'])('sends one keyed %s command and unwraps private state',async kind=>{
 const data=kind==='favorite'?{item_id:'item',favorite:true}:{updated:2};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:200,headers:{'Content-Type':'application/json'}}));
 const result=kind==='favorite'?await projectReadingApi.favorite('space','project','item',true,'key'):await informationDigestsApi.readingState('space','item',{read_status:'read'},kind==='project'?'project':undefined,'key');
 expect(result).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe(`/api/v1/actions/reading.${kind==='favorite'?'favorite':`${kind}_state`}.set`);
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('key');
 expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',item_id:'item',...(kind==='personal'?{}:{project_id:'project'}),...(kind==='favorite'?{favorite:true}:{read_status:'read'})});
 expect(fetch).toHaveBeenCalledTimes(1);
});
