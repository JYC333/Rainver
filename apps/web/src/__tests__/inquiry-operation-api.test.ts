import {beforeEach,expect,it,vi} from 'vitest';
import {inquiryApi,setSpaceContext} from '../api/client';
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{setSpaceContext('other-space');vi.stubGlobal('fetch',vi.fn());});
it('uses one caller-keyed command and never retries a failed write',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'thread',thread_id:'thread',project_id:'project',space_id:'source-space'}}));
 await inquiryApi.updateWork('project','thread',{priority:3},'work-key');expect(fetch).toHaveBeenCalledTimes(1);const [url,options]=vi.mocked(fetch).mock.calls[0]!;expect(String(url)).toBe('/api/v1/actions/inquiry.work.update');expect(new Headers(options!.headers).get('Idempotency-Key')).toBe('work-key');expect(JSON.parse(options!.body as string)).toEqual({project_id:'project',thread_id:'thread',priority:3});
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'operation_conflict',message:'conflict'}}),{status:409}));await expect(inquiryApi.transitionLifecycle('project','thread','archived',undefined,'archive-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('fetches the exact packet and delta brief in their receipt Space',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'packet/one',project_id:'project/one',space_id:'source-space'}})).mockResolvedValueOnce(response({id:'packet/one',candidates:[]}));await inquiryApi.openReviewPacket('project/one',5,'packet-key');expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/project%2Fone/inquiry/review-packets/packet%2Fone');expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('source-space');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response({status:'succeeded',data:{id:'brief/one',project_id:'project',space_id:'source-space'}})).mockResolvedValueOnce(response({id:'brief/one',content:{}}));await inquiryApi.generateDeltaBrief('project',null,'brief-key');expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/project/inquiry/delta-briefs/brief%2Fone');
});
it('preserves separate problem-domain keys and explicit transport keys and then reads current authorized projection',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'thread',thread_id:'thread',project_id:'project',space_id:'source-space'}})).mockResolvedValueOnce(response({revision:2}));
 const result=await inquiryApi.recordProblemWork('project','thread',{method_version:'problem_solving.v1',expected_version:1,expected_revision:0,idempotency_key:'domain-key',stage:'act',work_kind:'record_work',reason:'Work',input_refs:[],output_refs:[],skipped_stages:[]},'event-key');expect(result).toEqual({revision:2});const options=vi.mocked(fetch).mock.calls[0]![1]!;expect(JSON.parse(options.body as string).idempotency_key).toBe('domain-key');expect(new Headers(options.headers).get('Idempotency-Key')).toBe('event-key');expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('source-space');
});
