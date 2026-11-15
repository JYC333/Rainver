// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {informationDigestsApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
for(const project of [false,true])it(`queues a keyed ${project?'Project':'personal'} backfill and reads the current digest`,async()=>{
 setSpaceContext('space');const receipt={space_id:'space',user_id:'owner',job_id:'job',date:'2026-01-01',...(project?{project_id:'project'}:{})};
 const result={digest_id:'digest',created:true},digest={id:'digest',items:[]};
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(json({status:'succeeded',data:receipt},202)).mockResolvedValueOnce(json({status:'completed',result})).mockResolvedValueOnce(json({status:'available',digest})));
 expect(await (project?informationDigestsApi.backfillProject('space','project','2026-01-01','backfill-key'):informationDigestsApi.backfillPersonal('space','2026-01-01','backfill-key'))).toEqual({created:true,digest});
 const calls=vi.mocked(fetch).mock.calls;
 expect(calls).toHaveLength(3);
 expect(calls[0]![0]).toBe(`/api/v1/actions/digest.${project?'project':'personal'}.backfill`);
 expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('backfill-key');
 expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({space_id:'space',date:'2026-01-01',...(project?{project_id:'project'}:{})});
 expect(calls[1]![0]).toBe('/api/v1/jobs/job');
 expect(calls[2]![0]).toContain('date=2026-01-01');
});
