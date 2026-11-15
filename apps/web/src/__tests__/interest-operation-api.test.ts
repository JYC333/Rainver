// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {informationDigestsApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('sends the canonical typed interest command with the caller key and unwraps its topic',async()=>{
 const topic={id:'topic',topic_key:'reliability',label:'Reliability',domain_key:'software_engineering',weight:2,origin:'user',status:'active',aliases:[]};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{space_id:'space',user_id:'person',topic}}),{status:200,headers:{'Content-Type':'application/json'}}));
 expect(await informationDigestsApi.createTopic('space',{label:'Reliability',domain_key:'software_engineering',weight:2},'same-key')).toEqual(topic);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/interest.topic.create');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('same-key');
 expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',label:'Reliability',domain_key:'software_engineering',weight:2});
});
it('keeps the bounded history input and hides authority refs from the UI result',async()=>{
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{space_id:'space',user_id:'person',limit:7,queued:3,source_refs:[]}}),{status:200,headers:{'Content-Type':'application/json'}}));
 expect(await informationDigestsApi.backfillProfileHistory('space',7,'same-key')).toEqual({limit:7,queued:3});
 expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body))).toEqual({space_id:'space',limit:7});
});
it('does not automatically retry an unknown failure',async()=>{
 vi.mocked(fetch).mockResolvedValue(new Response('{}',{status:500,headers:{'Content-Type':'application/json'}}));
 await expect(informationDigestsApi.applyStarterPack('space','technology','same-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
