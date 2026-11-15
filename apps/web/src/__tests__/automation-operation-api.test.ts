// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {automationsApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('unwraps three configuration receipts and preserves explicit retry keys',async()=>{
 vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data:{id:'automation'}}),{status:200,headers:{'Content-Type':'application/json'}}));
 expect(await automationsApi.create({name:'Work',agent_id:'agent'},'create-key')).toEqual({id:'automation'});
 expect(await automationsApi.update('automation',{name:'New'},'update-key')).toEqual({id:'automation'});
 expect(await automationsApi.configureAutonomy({agent_id:'agent'},'autonomy-key')).toEqual({id:'automation'});
 const calls=vi.mocked(fetch).mock.calls;
 expect(calls.map(([url])=>String(url))).toEqual(['/api/v1/spaces/space/automations','/api/v1/spaces/space/automations/automation','/api/v1/spaces/space/automations/autonomy']);
 expect(calls.map(([,init])=>init!.method)).toEqual(['POST','PATCH','PUT']);
 expect(calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['create-key','update-key','autonomy-key']);
});

it('unwraps a keyed fire request and reads its private result before returning to existing consumers',async()=>{
 const receipt={space_id:'space',automation_id:'automation',job_id:'job',status:'pending'};
 vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:receipt}),{status:202}))
  .mockResolvedValueOnce(new Response(JSON.stringify({status:'completed',outcome:'completed',error:null,result:{run_id:'run',trigger_origin:'automation',preflight_executable:true}})));
 expect(await automationsApi.fire('automation',{},'fire-key')).toMatchObject({run_id:'run'});
 const calls=vi.mocked(fetch).mock.calls;
 expect(String(calls[0][0])).toBe('/api/v1/spaces/space/automations/automation/fire');
 expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBe('fire-key');
 expect(String(calls[1][0])).toBe('/api/v1/spaces/space/automations/automation/fire-requests/job');
});
it('surfaces unknown fire outcomes without replaying the POST',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:{space_id:'space',automation_id:'automation',job_id:'job',status:'pending'}}),{status:202}))
  .mockResolvedValueOnce(new Response(JSON.stringify({status:'failed',outcome:'unknown',result:null,error:'Outcome unknown; not repeated'})));
 await expect(automationsApi.fire('automation',{},'fire-key')).rejects.toThrow('Outcome unknown');
 expect(vi.mocked(fetch).mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
});
