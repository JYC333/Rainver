// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {researchDiscoveryApi} from '../api/client';
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));afterEach(()=>vi.unstubAllGlobals());
it('uses retained materialize/activate URLs with explicit retry keys and original bodies',async()=>{
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{strategy_id:'strategy'}}),{headers:{'Content-Type':'application/json'}}));
 await researchDiscoveryApi.materialize('strategy',{provider_keys:['openalex']},'materialize');
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{strategy_id:'strategy'}}),{headers:{'Content-Type':'application/json'}}));
 await researchDiscoveryApi.activate('strategy',{reason:'rollback'},'activate');
 expect(vi.mocked(fetch).mock.calls.map(([url])=>url)).toEqual(['/api/v1/research/query-strategies/strategy/materialize','/api/v1/research/query-strategies/strategy/activate']);
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['materialize','activate']);
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>JSON.parse(init!.body as string))).toEqual([{provider_keys:['openalex']},{reason:'rollback'}]);
});
it('does not retry an unknown write outcome',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('lost'));
 await expect(researchDiscoveryApi.activate('strategy',{reason:'manual'},'same')).rejects.toThrow('lost');expect(fetch).toHaveBeenCalledTimes(1);
});
it('queues evaluation and provider retry through keyed formal URLs',async()=>{
 const accepted={job_id:'job',strategy_id:'strategy',run_id:null,status:'queued'};
 vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data:accepted}),{headers:{'Content-Type':'application/json'}}));
 expect(await researchDiscoveryApi.evaluate({project_id:'project',research_context_version_id:'context',providers:['openalex'],candidate_budget:100},'evaluate')).toEqual(accepted);
 expect(await researchDiscoveryApi.retryProvider('strategy','openalex',{project_id:'project'},'retry')).toEqual(accepted);
 expect(vi.mocked(fetch).mock.calls.map(([url])=>url)).toEqual(['/api/v1/research/query-strategies/evaluate','/api/v1/research/query-strategies/strategy/providers/openalex/retry']);
 expect(vi.mocked(fetch).mock.calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['evaluate','retry']);
});
it('reads settled strategy content only from the evaluation result endpoint',async()=>{
 const receipt={job_id:'job',strategy_id:'strategy',run_id:null,status:'queued' as const},result={strategy:{id:'strategy'}};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({...receipt,status:'succeeded',result}),{headers:{'Content-Type':'application/json'}}));
 expect(await researchDiscoveryApi.waitEvaluation(receipt)).toEqual(result);
 expect(fetch).toHaveBeenCalledTimes(1);expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/v1/research/query-evaluations/job');
});
it('never resends evaluation after result access is withdrawn or a send outcome is unknown',async()=>{
 vi.mocked(fetch).mockRejectedValue(new Error('withdrawn'));
 await expect(researchDiscoveryApi.waitEvaluation({job_id:'job',strategy_id:'strategy',run_id:null,status:'queued'})).rejects.toThrow('withdrawn');expect(fetch).toHaveBeenCalledTimes(1);
});
