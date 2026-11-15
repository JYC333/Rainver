// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {skillsApi,setSpaceContext} from '../api/client';
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{setSpaceContext('skills-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('uses a retained key once for IO and polls only the authorized source result reader',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{job_id:'job',space_id:'skills-space',status:'pending'}}))
  .mockResolvedValueOnce(response({status:'completed',result:{items:[],truncated:false,warnings:[]}}));
 expect(await skillsApi.scanHostSkills('host',{idempotencyKey:'same-key'})).toEqual({items:[],truncated:false,warnings:[]});
 expect(vi.mocked(fetch).mock.calls.map(([url])=>String(url))).toEqual(['/api/v1/skill-sources/hosts/host/scan','/api/v1/skill-sources/requests/job']);
 expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('same-key');
});
it('reads the created review proposal through its ordinary reader and never reposts a refused command',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{proposal_id:'proposal',space_id:'skills-space',created:true}}))
  .mockResolvedValueOnce(response({id:'proposal',status:'pending'}));
 expect(await skillsApi.createSkillReviewProposal('pkg',{}, {idempotencyKey:'review-key'})).toEqual({id:'proposal',status:'pending'});
 vi.mocked(fetch).mockResolvedValueOnce(new Response('{}',{status:409,headers:{'Content-Type':'application/json'}}));
 await expect(skillsApi.importSkill({source_type:'upload',files:[{path:'SKILL.md',content_base64:'YQ=='}],package_hash:'hash'},{idempotencyKey:'import-key'})).rejects.toThrow();
 expect(vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2);
});
