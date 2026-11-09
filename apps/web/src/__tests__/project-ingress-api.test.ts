import {beforeEach,it,expect,vi} from 'vitest';
import {projectMonitoringApi,projectsApi,setSpaceContext} from '../api/client';
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{setSpaceContext('browsed-space');vi.stubGlobal('fetch',vi.fn());});
it('keeps transport and domain keys distinct when proposing a Source history import',async()=>{
 const data={project_id:'p',space_id:'s',binding_id:'b',source_channel_id:'c',operation_id:'o',plan_id:'l',proposal_id:'r'};
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data}));
 expect(await projectsApi.proposeBindingBackfill('p','b',{idempotency_key:'domain-key'},'transport-key')).toEqual(data);
 const [url,request]=vi.mocked(fetch).mock.calls[0]!;
 expect(String(url)).toBe('/api/v1/actions/project.source.propose_backfill');
 expect(new Headers(request!.headers).get('Idempotency-Key')).toBe('transport-key');
 expect(JSON.parse(String(request!.body))).toMatchObject({project_id:'p',binding_id:'b',idempotency_key:'domain-key'});
 expect(fetch).toHaveBeenCalledTimes(1);
});
it('writes Corpus changes with the caller key and returns only the reference while the parent refreshes content',async()=>{
 const receipt={status:'succeeded',data:{id:'corpus',project_id:'project',space_id:'receipt-space'}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt));expect(await projectsApi.addCorpusItem('project',{source_item_id:'source'},'add-key')).toEqual({id:'corpus'});
 expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.corpus.upsert');expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('add-key');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt));expect(await projectsApi.updateCorpusItem('project','corpus',{read_status:'read'},'edit-key')).toEqual({id:'corpus'});expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.corpus.update');expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('edit-key');
});
it('keeps monitoring event keys and reads current settings in the receipt Space',async()=>{
 const receipt={status:'succeeded',data:{id:'v2',project_id:'project/1',space_id:'receipt-space'}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({active:{id:'current',config:{language:'Current'}}}));
 expect(await projectMonitoringApi.details('project/1',{expected_version_id:'v1',recommendation_count:1,language:'Input'},'details-event')).toEqual({id:'current',config:{language:'Current'}});
 const calls=vi.mocked(fetch).mock.calls;expect(String(calls[0]![0])).toBe('/api/v1/actions/project.monitoring.details.update');expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('details-event');expect(String(calls[1]![0])).toBe('/api/v1/projects/project%2F1/information-monitoring');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('receipt-space');
});
it('does not repeat an uncertain monitoring pause write',async()=>{
 vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection closed'));
 await expect(projectMonitoringApi.paused('project','v1',true,'pause-event')).rejects.toThrow('Connection closed');expect(fetch).toHaveBeenCalledTimes(1);expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('pause-event');
});
