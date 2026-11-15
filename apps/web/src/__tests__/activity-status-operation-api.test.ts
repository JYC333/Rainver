// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {activityApi,dailyReportApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
for(const action of ['review','archive','consolidate'] as const)it(`keeps ${action} key and unwraps the status receipt`,async()=>{
 setSpaceContext('space');const data={id:'activity',status:'processed'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{headers:{'Content-Type':'application/json'}})));
 expect(await activityApi[action]('activity','fixed-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe(`/api/v1/actions/activity.${action}`);
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('fixed-key');
 expect(JSON.parse(String(init!.body))).toEqual({activity_id:'activity'});
});
for(const method of ['updateSettings','setSettings'] as const)it(`keeps ${method} legal fields and explicit key`,async()=>{
 setSpaceContext('space');const data={enabled:true,local_time:'08:30',create_memory_proposals:false};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{headers:{'Content-Type':'application/json'}})));
 expect(await dailyReportApi[method](data,'settings-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe(`/api/v1/actions/daily_capture.settings.${method==='updateSettings'?'patch':'set'}`);
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('settings-key');expect(JSON.parse(String(init!.body))).toEqual(data);
});
it('keeps capture destination and key in a typed command receipt',async()=>{
 const {captureApi}=await import('../api/client');setSpaceContext('space');const data={activity_id:'activity',note_id:'note',block_id:'block'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:201,headers:{'Content-Type':'application/json'}})));
 const body={text:'A thought',destination:'project_marginalia' as const,project_id:'project'};
 expect(await captureApi.create(body,'capture-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/capture.create');
 expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('capture-key');expect(JSON.parse(String(init!.body))).toEqual(body);
});
it('keys raw ingest with all legal provenance fields and the requested Space',async()=>{
 setSpaceContext('space');const data={id:'activity',agent_id:'agent',source_run_id:'run'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{headers:{'Content-Type':'application/json'}})));
 const body={source_type:'agent_run',content:'Observation',agent_id:'agent',source_run_id:'run'};
 expect(await activityApi.create(body,{spaceId:'space',key:'ingest-key'})).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/activity');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('ingest-key');expect(JSON.parse(String(init!.body))).toEqual(body);
});
it('unwraps only the queued summary intent and preserves its explicit key',async()=>{
 setSpaceContext('space');const data={job_id:'job',user_id:'person'},body={activity_ids:['activity'],create_memory_proposal:true};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:202,headers:{'Content-Type':'application/json'}})));
 expect(await activityApi.summarize(body,'summary-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/activity.summary.request');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('summary-key');expect(JSON.parse(String(init!.body))).toEqual(body);
});
it('keys relocation with its exact source and block selection',async()=>{
 const {captureApi}=await import('../api/client');setSpaceContext('space');const data={activity_id:'new-capture',note_id:null,block_id:null},body={destination:'personal_inbox' as const,mode:'copy' as const,block_ids:['block']};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{headers:{'Content-Type':'application/json'}})));
 expect(await captureApi.relocate('source',body,'relocate-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/capture.relocate');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('relocate-key');expect(JSON.parse(String(init!.body))).toEqual({...body,activity_id:'source'});
});
it('returns the queued daily report intent with the caller key and legal overrides',async()=>{
 setSpaceContext('space');const data={job_id:'job',run_id:'run',user_id:'person',status:'queued'},body={local_date:'2026-09-12',create_memory_proposals:false};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:202,headers:{'Content-Type':'application/json'}})));
 expect(await dailyReportApi.run(body,'daily-key')).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/daily_capture.run');expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('daily-key');expect(JSON.parse(String(init!.body))).toEqual(body);
});
it('uploads multipart with the exact key and unwraps only the queued capture intent',async()=>{
 const data={job_id:'job',activity_id:'activity',status:'queued'};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:202,headers:{'Content-Type':'application/json'}})));
 const file=new File(['capture'],'memo.webm',{type:'audio/webm'});
 expect(await activityApi.upload(file,{kind:'voice',project_id:'project',spaceId:'space',key:'upload-key'})).toEqual(data);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe('/api/v1/activity/upload');
 const headers=new Headers(init!.headers);
 expect(headers.get('Idempotency-Key')).toBe('upload-key');expect(headers.get('Content-Type')).toBeNull();
 expect(headers.get('X-Rainver-Space-Id')).toBe('space');
 expect(init!.body).toBeInstanceOf(FormData);
 expect((init!.body as FormData).get('project_id')).toBe('project');
});
