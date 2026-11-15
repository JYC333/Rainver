// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {personalBriefingsApi,projectBriefingHighlightsApi,setSpaceContext} from '../api/client';
afterEach(()=>vi.unstubAllGlobals());
for(const project of [false,true]){
 for(const preview of [false,true])it(`unwraps the ${project?'Project':'personal'} ${preview?'adoption':'follow-up'} query without a command receipt`,async()=>{
  setSpaceContext('space');const data={title:'Preview',preview_hash:'a'.repeat(64)};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{headers:{'Content-Type':'application/json'}})));
  const value=project?(preview?projectBriefingHighlightsApi.previewAdoption('space','project','briefing',0):projectBriefingHighlightsApi.followUp('space','project','briefing',0)):(preview?personalBriefingsApi.previewAdoption('space','briefing',0):personalBriefingsApi.followUp('space','briefing',0));
  expect(await value).toEqual(data);
  const [url,init]=vi.mocked(fetch).mock.calls[0]!;
  expect(url).toContain(`/highlights/0/${preview?'adoption/preview':'follow-up'}`);expect(init!.method).toBe('POST');
  expect(new Headers(init!.headers).has('Idempotency-Key')).toBe(false);expect(JSON.parse(String(init!.body))).toEqual({});
 });
 it(`keys the ${project?'Project':'personal'} adoption confirmation and unwraps the Task receipt`,async()=>{
  setSpaceContext('space');const data={created:true,task:{id:'task',title:'Adopted',project_id:project?'project':null}},hash='a'.repeat(64);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:201,headers:{'Content-Type':'application/json'}})));
  expect(await (project?projectBriefingHighlightsApi.adopt('space','project','briefing',0,hash,'adopt-key'):personalBriefingsApi.adopt('space','briefing',0,hash,'adopt-key'))).toEqual(data);
  const [url,init]=vi.mocked(fetch).mock.calls[0]!;
  expect(url).toBe(`/api/v1/actions/briefing.${project?'project':'personal'}.adoption.confirm`);
  expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('adopt-key');
  expect(JSON.parse(String(init!.body))).toEqual({space_id:'space',briefing_id:'briefing',index:0,preview_hash:hash,...(project?{project_id:'project'}:{})});
 });
}
