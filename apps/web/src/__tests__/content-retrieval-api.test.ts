// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {knowledgeApi,memoryApi,setSpaceContext} from '../api/client';
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const receipt={status:'succeeded',data:{id:'job',job_id:'job',space_id:'original-space',status:'pending'}};
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('submits one keyed Knowledge request then polls only the current-access reader in the original Space',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt,202)).mockResolvedValueOnce(response({status:'running',result:null,withheld:0})).mockResolvedValueOnce(response({status:'completed',result:{items:[]},withheld:0}));
 const done=knowledgeApi.search({query:'Quantum'});await vi.runAllTimersAsync();expect(await done).toEqual({items:[]});
 const calls=vi.mocked(fetch).mock.calls;
 expect(calls.map(([url])=>String(url))).toEqual(['/api/v1/actions/knowledge.retrieval.search.request','/api/v1/knowledge/retrieval/requests/job','/api/v1/knowledge/retrieval/requests/job']);
 expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBeTruthy();expect(new Headers(calls[1][1]?.headers).get('X-Rainver-Space-Id')).toBe('original-space');
});
it('refuses a withdrawn old synthesis without resubmitting',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt,202)).mockResolvedValueOnce(response({status:'completed',result:null,withheld:1}));
 const done=memoryApi.retrievalBrief({query:'Quantum'}).catch((error:unknown)=>error);await vi.runAllTimersAsync();expect(await done).toMatchObject({status:404,code:'operation_not_found'});expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps ordinary Memory search result shape while using its dedicated result reader',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt,202)).mockResolvedValueOnce(response({status:'completed',result:[{id:'memory',content:'Visible'}],withheld:0}));
 expect(await memoryApi.search({query:'Quantum'})).toEqual([{id:'memory',content:'Visible'}]);expect(String(vi.mocked(fetch).mock.calls[1][0])).toBe('/api/v1/memory/retrieval/requests/job');
});
it('submits report scans and owned Job pages once and polls in the receipt Space',async()=>{
 for(const [run,id] of [
  [()=>knowledgeApi.maintenanceScan({}),'knowledge.maintenance.scan'],
  [()=>knowledgeApi.contradictionScan({}),'knowledge.claim.contradictions.scan'],
  [()=>memoryApi.maintenanceScan({}),'memory.maintenance.scan'],
  [()=>memoryApi.runMaintenanceJob('maintenance'),'memory.maintenance.job.run'],
 ] as const){
  vi.mocked(fetch).mockClear();vi.mocked(fetch).mockResolvedValueOnce(response(receipt,202)).mockResolvedValueOnce(response({status:'completed',result:{findings:[]},withheld:0}));
  expect(await run()).toEqual({findings:[]});const calls=vi.mocked(fetch).mock.calls;expect(String(calls[0][0])).toBe('/api/v1/actions/'+id);expect(new Headers(calls[1][1]?.headers).get('X-Rainver-Space-Id')).toBe('original-space');expect(calls).toHaveLength(2);
 }
});
