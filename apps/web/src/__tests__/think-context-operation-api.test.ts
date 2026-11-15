// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {askSpaceApi,contextOpsApi} from '../api/client';
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));afterEach(()=>vi.unstubAllGlobals());
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
it('Think sends one keyed admission and reads the result without repeating the command',async()=>{
 const receipt={id:'job',job_id:'job',space_id:'space',status:'pending'},result={query:'Question',canonical_write_performed:false};
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:receipt})).mockResolvedValueOnce(response({job_id:'job',status:'completed',result,withheld:0}));
 expect(await askSpaceApi.think({query:'Question'},'think-key')).toEqual(result);
 expect(vi.mocked(fetch).mock.calls.map(([url])=>url)).toEqual(['/api/v1/ask-space/think','/api/v1/ask-space/requests/job']);
 expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('think-key');
});
it('Think withholds a withdrawn result without resending',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'job',job_id:'job',space_id:'space',status:'pending'}})).mockResolvedValueOnce(response({job_id:'job',status:'completed',result:null,withheld:1}));
 await expect(askSpaceApi.think({query:'Question'},'same')).rejects.toThrow('content access changed');expect(fetch).toHaveBeenCalledTimes(2);
});
it('retains keyed ContextOps routes and unwraps their formal outcomes',async()=>{
 const value={artifact_id:'report',canonical_write_performed:false};vi.mocked(fetch).mockImplementation(async()=>response({status:'succeeded',data:value}));
 expect(await contextOpsApi.reviewCycleRun({create_packets:false},'review')).toEqual(value);
 expect(await contextOpsApi.contextObservationScan({persist_report:false},'observations')).toEqual(value);
 expect(vi.mocked(fetch).mock.calls.map(([url])=>url)).toEqual(['/api/v1/context-ops/review-cycle/run','/api/v1/context-ops/context-observations/scan']);
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['review','observations']);
});
