import {beforeEach,it,expect,vi} from 'vitest';
import {projectsApi,decisionCasesApi,focusAreasApi,projectReviewApi,projectNotebookChatApi,setSpaceContext} from '../api/client';
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());});
it('creates a Project with the chosen event key and reads current content in its receipt Space',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'p/one',project_id:'p/one',space_id:'original-space'}})).mockResolvedValueOnce(response({id:'p/one',name:'Current'}));
 expect(await projectsApi.create({name:'Draft'},'create-key')).toEqual({id:'p/one',name:'Current'});
 const calls=vi.mocked(fetch).mock.calls;expect(String(calls[0]![0])).toBe('/api/v1/actions/project.create');expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('create-key');expect(String(calls[1]![0])).toBe('/api/v1/projects/p%2Fone');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
});
it('retrieves the exact Brief or Instruction version identified by a safe receipt',async()=>{
 const receipt={status:'succeeded',data:{id:'version',project_id:'project',space_id:'original-space'}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response([{id:'another'},{id:'version',goal:'Current'}]));
 expect(await projectsApi.createBriefVersion('project',{goal:'Draft'},'brief-key')).toEqual({id:'version',goal:'Current'});expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.brief.create');expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response([{id:'version',status:'published'}]));
 expect(await projectsApi.publishInstruction('project','version','publish-key')).toEqual({id:'version',status:'published'});expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.instruction.publish');
});
it('refreshes roster mutations from the receipt Space and removes with an explicit key',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'membership',project_id:'project',space_id:'original-space'}})).mockResolvedValueOnce(response([{id:'membership',role:'viewer'}]));
 expect(await projectsApi.addMember('project',{user_id:'user',role:'viewer'},'member-key')).toEqual({id:'membership',role:'viewer'});expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response({status:'succeeded',data:{id:'user',project_id:'project',space_id:'original-space'}}));await projectsApi.removeMember('project','user','remove-key');expect(fetch).toHaveBeenCalledTimes(1);expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.member.remove');
});
it('keeps Decision children and delivery content out of command receipts and never retries failures',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'task',project_id:'project',space_id:'original-space'}}));
 await decisionCasesApi.createDelivery('project','case','commitment','delivery-key');expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({project_id:'project',case_id:'case',commitment_id:'commitment'});expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('delivery-key');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'operation_conflict'}}),{status:409}));await expect(decisionCasesApi.addOption('project','case',{title:'Input'},'option-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('opens a combined review once and fetches current packet candidates in the receipt Space',async()=>{
 const receipt={status:'succeeded',data:{id:'knowledge',project_id:'p/1',space_id:'original-space',inquiry_packet_id:'inquiry',knowledge_packet_id:'knowledge',created_at:'2026-01-01T00:00:00Z'}};
 vi.mocked(fetch).mockImplementation(async(url)=>String(url).includes('/actions/')?response(receipt):String(url).includes('/inquiry/review-packets/')?response({id:'inquiry',candidates:[]}):response({id:'knowledge',candidates:[{id:'candidate'}]}));
 const result=await projectReviewApi.open('p/1',5,'review-key');expect(result.sections.knowledge.packet.candidates).toEqual([{id:'candidate'}]);expect(fetch).toHaveBeenCalledTimes(3);const calls=vi.mocked(fetch).mock.calls;expect(String(calls[0]![0])).toBe('/api/v1/actions/project.review_session.open');for(const read of calls.slice(1))expect(new Headers(read[1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
});
it('uses explicit event keys for focus assignment, reporting and undo without a second write',async()=>{
 vi.mocked(fetch).mockImplementation(async()=>response({status:'succeeded',data:{id:'event',space_id:'s',project_id:'p'}}));await focusAreasApi.setForProject('p',null,'focus-key');await projectsApi.postUpdate('p',{summary:'Account'},'report-key');await projectsApi.undoUpdate('p','event','undo-key');
 expect(vi.mocked(fetch).mock.calls.map(call=>String(call[0]))).toEqual(['/api/v1/actions/project.focus_area.set','/api/v1/actions/project.update.report','/api/v1/actions/project.update.undo']);expect(vi.mocked(fetch).mock.calls.map(call=>new Headers(call[1]!.headers).get('Idempotency-Key'))).toEqual(['focus-key','report-key','undo-key']);
});
it('waits for a notebook reply using only read requests after its single keyed command',async()=>{
 const receipt={status:'succeeded',data:{id:'run',project_id:'p/1',space_id:'original-space',session_id:'session',run_id:'run',job_id:'job',daily_limit:20,daily_used:1}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({pending:false,ok:true,session_id:'session',run_id:'run',reply:'Answer',daily_limit:20,daily_used:1}));
 expect(await projectNotebookChatApi.send('p/1',{message:'Question',execution:{model_provider_id:'provider'}},'chat-key')).toMatchObject({ok:true,reply:'Answer'});const calls=vi.mocked(fetch).mock.calls;expect(String(calls[0]![0])).toBe('/api/v1/actions/project.notebook.chat');expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('chat-key');expect(String(calls[1]![0])).toBe('/api/v1/projects/p%2F1/notebook-chat/run');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
});
it('reads Project lifecycle commands from the receipt Space without repeating the write',async()=>{
 for(const id of ['update','archive'] as const){
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response({status:'succeeded',data:{id:'p/1',project_id:'p/1',space_id:'original-space'}})).mockResolvedValueOnce(response({id:'p/1',status:'archived'}));
  const result=id==='update'?await projectsApi.update('p/1',{status:'archived'},'lifecycle-key'):await projectsApi.archive('p/1','lifecycle-key');expect(result.status).toBe('archived');const calls=vi.mocked(fetch).mock.calls;expect(calls).toHaveLength(2);expect(String(calls[0]![0])).toBe('/api/v1/actions/project.'+id);expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('lifecycle-key');expect(String(calls[1]![0])).toBe('/api/v1/projects/p%2F1');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
 }
});
it('saves and publishes public summaries with explicit keys and reads current content in the original Space',async()=>{
 const receipt={status:'succeeded',data:{id:'summary',project_id:'p/1',space_id:'original-space'}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({draft:{id:'summary',summary_text:'Current draft'}}));expect(await projectsApi.savePublicSummaryDraft('p/1',{summary_text:'Draft'},'save-key')).toMatchObject({summary_text:'Current draft'});let calls=vi.mocked(fetch).mock.calls;expect(String(calls[0]![0])).toBe('/api/v1/actions/project.public_summary.save');expect(String(calls[1]![0])).toBe('/api/v1/projects/p%2F1/public-summary/editor');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({id:'summary',summary_text:'Reviewed publication'}));expect(await projectsApi.publishPublicSummary('p/1',2,'publish-key')).toMatchObject({summary_text:'Reviewed publication'});calls=vi.mocked(fetch).mock.calls;expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({project_id:'p/1',draft_version:2});expect(String(calls[1]![0])).toBe('/api/v1/projects/p%2F1/public-summary');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt));await projectsApi.revokePublicSummary('p/1','revoke-key');expect(fetch).toHaveBeenCalledTimes(1);expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.public_summary.revoke');expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('revoke-key');
});
