// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {meApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('browsed');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('uses all retained retrieval URLs, original fields and caller retry keys without browsed Space',async()=>{
 const data={artifact_id:'artifact'};
 vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data}),{headers:{'Content-Type':'application/json'}}));
 expect(await meApi.retrievalSearch({query:'quantum',resource_types:['knowledge_item'],max_results:7},'search')).toEqual(data);
 await meApi.resolveRetrievalPointers(['one','two'],'resolve');
 await meApi.storeSourceSummary(['one'],'summary','summary');
 await meApi.discloseFusedStore(['one','two'],'disclose');
 await meApi.storeFusedConclusion('disclosure',['one','two'],'conclusion','fused');
 expect(vi.mocked(fetch).mock.calls.map(([url])=>url)).toEqual(['/api/v1/me/retrieval/search','/api/v1/me/retrieval/pointers/resolve','/api/v1/me/retrieval/summaries','/api/v1/me/retrieval/egress/disclose','/api/v1/me/retrieval/fused-conclusions']);
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['search','resolve','summary','disclose','fused']);
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>JSON.parse(init!.body as string))).toEqual([{query:'quantum',resource_types:['knowledge_item'],max_results:7},{pointer_ids:['one','two']},{pointer_ids:['one'],summary:'summary'},{pointer_ids:['one','two']},{disclosure_id:'disclosure',pointer_ids:['one','two'],conclusion:'conclusion'}]);
 for(const [,init] of vi.mocked(fetch).mock.calls)expect(new Headers(init!.headers).has('X-Rainver-Space-Id')).toBe(false);
});
it('never automatically retries an uncertain content write',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('lost'));
 await expect(meApi.storeFusedConclusion('disclosure',['one','two'],'conclusion','key')).rejects.toThrow('lost');
 expect(fetch).toHaveBeenCalledTimes(1);
});
