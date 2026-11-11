import {beforeEach,it,expect,vi} from 'vitest';
import {projectResearchApi,setSpaceContext} from '../api/client';
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{setSpaceContext('other-space');vi.stubGlobal('fetch',vi.fn());});
const framework={reply:'Current reply',recommended_question:'Question',assessment:{answerable:true,finer:{feasible:4,interesting:4,novel:4,ethical:4,relevant:4},issues:[]},suggested_questions:['Question'],sub_questions:[],scope:{in:[],out:[]},clarifying_questions:[]};
it('submits a single keyed snapshot intent and reads the queued operation through its receipt Space',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'operation/1',space_id:'receipt-space',project_id:'project/1'}})).mockResolvedValueOnce(response({id:'operation/1',status:'active'}));
 expect(await projectResearchApi.generateReportSnapshot('project/1','snapshot-key')).toEqual({id:'operation/1',status:'active'});const calls=vi.mocked(fetch).mock.calls;expect(calls).toHaveLength(2);expect(String(calls[0]![0])).toBe('/api/v1/actions/research.report.snapshot');expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('snapshot-key');expect(String(calls[1]![0])).toBe('/api/v1/projects/project%2F1/operations/operation%2F1');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('receipt-space');
});
it('queues one caller-keyed ad-hoc intent and returns only queued execution metadata without a write retry',async()=>{
 const data={run_id:'run',job_id:'job',note_id:'note',space_id:'receipt-space',project_id:'project',status:'queued',daily_limit:20,daily_used:1};
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data}));
 expect(await projectResearchApi.askAi('project',{prompt:'Compare',section_key:'ideas',source_item_ids:['source'],execution:{model_provider_id:'provider'}},'ask-key')).toEqual({run_id:'run',job_id:'job',status:'queued',daily_limit:20,daily_used:1});
 expect(fetch).toHaveBeenCalledTimes(1);const call=vi.mocked(fetch).mock.calls[0]!;expect(String(call[0])).toBe('/api/v1/actions/research.ask_ai');expect(new Headers(call[1]!.headers).get('Idempotency-Key')).toBe('ask-key');expect(JSON.parse(call[1]!.body as string)).toMatchObject({project_id:'project',source_item_ids:['source']});
 vi.mocked(fetch).mockClear().mockRejectedValueOnce(new Error('Response lost'));
 await expect(projectResearchApi.askAi('project',{prompt:'Compare',section_key:'ideas',execution:{model_provider_id:'provider'}},'ask-key')).rejects.toThrow('Response lost');expect(fetch).toHaveBeenCalledTimes(1);
});
it('confirms one keyed assessment intent and reads the current authorized framework/history in its receipt Space',async()=>{
 const confirmation={id:'context',question:'Question'},current={...framework,research_context_version_id:'context'};
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'context',thread_id:'thread/1',project_id:'project/1',space_id:'receipt-space'}})).mockResolvedValueOnce(response({latest_refinement:current})).mockResolvedValueOnce(response([confirmation]));
 expect(await projectResearchApi.confirmQuestionAssessment('project/1',{thread_id:'thread/1',refinement:framework,manually_adjusted:false},'confirmation-key')).toEqual({...current,confirmation});
 const calls=vi.mocked(fetch).mock.calls;expect(calls).toHaveLength(3);expect(String(calls[0]![0])).toBe('/api/v1/actions/research.question.assessment.confirm');expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('confirmation-key');
 for(const call of calls.slice(1))expect(new Headers(call[1]!.headers).get('X-Rainver-Space-Id')).toBe('receipt-space');
 expect(String(calls[1]![0])).toBe('/api/v1/projects/project%2F1/research/question/assessment?thread_id=thread%2F1');
});
it('does not substitute a newer working framework for an old confirmation receipt or repeat its write',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'old-context',thread_id:'thread',project_id:'project',space_id:'receipt-space'}})).mockResolvedValueOnce(response({latest_refinement:{...framework,research_context_version_id:'new-context'}})).mockResolvedValueOnce(response([{id:'old-context'}]));
 await expect(projectResearchApi.confirmQuestionAssessment('project',{thread_id:'thread',refinement:framework,manually_adjusted:false},'old-key')).rejects.toThrow('Confirmed framework changed');expect(fetch).toHaveBeenCalledTimes(3);
});
it('uses explicit draft and stage event keys then reads the receipt Workflow in its original Space',async()=>{
 const receipt={status:'succeeded',data:{id:'workflow',project_id:'project',space_id:'receipt-space'}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response([{id:'workflow',status:'not_started'}]));
 await projectResearchApi.saveInitialIntakeDraft('project',{thread_id:'thread',research_question:'Question',history_mode:'all_available',max_items:10,monitoring_field:'submittedDate',report_depth:'quick',question_refine_skipped:true,execution:{}},'draft-key');
 expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/research.intake.draft');expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('draft-key');
 expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('receipt-space');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response([{id:'workflow',status:'active'}]));
 await projectResearchApi.runStage('project','workflow','screening',{},'stage-key');expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/research.workflow.stage.record');expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('stage-key');
});
it('submits one caller-keyed checklist command and reads current content in receipt Space, without a write retry',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'item/one',project_id:'project/one',space_id:'source-space'}})).mockResolvedValueOnce(response({id:'item/one',text:'Current'}));
 expect(await projectResearchApi.createChecklistItem('project/one','Draft','event-key')).toEqual({id:'item/one',text:'Current'});
 const calls=vi.mocked(fetch).mock.calls;expect(calls).toHaveLength(2);expect(String(calls[0]![0])).toBe('/api/v1/actions/research.checklist.create');expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({project_id:'project/one',text:'Draft'});expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('event-key');expect(String(calls[1]![0])).toBe('/api/v1/projects/project%2Fone/research/checklist/item%2Fone');expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('source-space');
});
it('refreshes current screening settings after a body-free receipt and does not retry failed commands',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'criteria',project_id:'project',space_id:'source-space'}})).mockResolvedValueOnce(response({include_keywords:['Current']}));
 expect(await projectResearchApi.upsertScreeningCriteria('project',{include_keywords:['Input']},'criteria-key')).toEqual({include_keywords:['Current']});expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/project/research/screening-criteria');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'operation_conflict',message:'conflict'}}),{status:409}));
 await expect(projectResearchApi.deleteChecklistItem('project','item','delete-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('reads the area and evidence card destinations only after their safe receipts',async()=>{
 const receipt={status:'succeeded',data:{id:'id',project_id:'p/1',space_id:'receipt-space'}};
 vi.mocked(fetch).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({notes:[]}));
 await projectResearchApi.initializeArea('p/1','area-key');expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/research.area.initialize');expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/p%2F1/research/area');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({why_md:'Current'}));
 expect(await projectResearchApi.updateEvidenceCard('p/1','source/1',{why_md:'Input',how_md:'',what_md:''},'card-key')).toEqual({why_md:'Current'});expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/research.evidence_card.update');expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/p%2F1/research/reading-list/source%2F1/card');expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('receipt-space');
});
it('queues standing controls with independent event keys and follows the actual created limit Workflow',async()=>{
 const reply={status:'succeeded',data:{id:'workflow',project_id:'project',space_id:'receipt-space'}};
 vi.mocked(fetch).mockImplementation(async()=>response(reply));await projectResearchApi.dismissStandingAdvice('project','advice','dismiss-key');await projectResearchApi.retryStandingBatch('project','batch','retry-key');
 expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/research.standing.dismiss');expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/actions/research.standing.retry');
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(reply)).mockResolvedValueOnce(response([{id:'workflow',status:'not_started'}]));expect(await projectResearchApi.updateInitialItemLimit('project',25,null,'limit-key')).toEqual({id:'workflow',status:'not_started'});expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/project/research/workflow');expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('receipt-space');
});
it('starts intake with one keyed command and rebuilds the response from receipt-Space reads limited to receipt IDs',async()=>{
 const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 const data={id:'op',project_id:'p',space_id:'receipt-space',workflow_id:'w',source_channel_ids:['c1'],source_binding_ids:['b1']};
 vi.mocked(fetch).mockImplementation(async(input)=>{const url=String(input);
  if(url.endsWith('/actions/research.intake.start'))return json({status:'succeeded',data});
  if(url.endsWith('/projects/p/operations/op'))return json({id:'op',status:'active'});
  if(url.endsWith('/projects/p/research/workflow'))return json([{id:'other'},{id:'w'}]);
  if(url.endsWith('/sources/channels'))return json([{id:'c1'},{id:'c2'}]);
  return json([{id:'b1'},{id:'b2'}]);});
 const out=await projectResearchApi.startInitialIntake('p',{query_strategy_id:'00000000-0000-4000-8000-000000000000',research_question:'Q',history_mode:'all_available',report_depth:'quick',question_refine_skipped:true} as never,'intake-event');
 expect(out).toMatchObject({workflow:{id:'w'},operation:{id:'op'},source_channels:[{id:'c1'}],source_bindings:[{id:'b1'}],status:'active'});
 const posts=vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);expect(new Headers(posts[0]![1]!.headers).get('Idempotency-Key')).toBe('intake-event');
 for(const [,init] of vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method!=='POST'))expect(new Headers(init!.headers).get('x-rainver-space-id')).toBe('receipt-space');
});
it('returns the receipt turn\'s own refinement, not the session latest owned by a concurrent turn',async()=>{
 const own={...framework,recommended_question:'Earlier turn answer',research_context_version_id:'context-a'},other={...framework,recommended_question:'Later turn answer',research_context_version_id:'context-b'};
 const message=(id:string,turn_index:number,role:'user'|'assistant',refinement?:unknown)=>({id,turn_index,role,content:'x',status:'complete',created_by_user_id:null,created_at:'2026-01-01T00:00:00Z',...(refinement?{refinement}:{})});
 const session={id:'session',thread_id:'thread',recommended_question:'Later turn answer',latest_refinement:other,assessment_baseline:null,research_context_version_id:'context-b',created_at:'',updated_at:'',
  messages:[message('turn-a',1,'user'),message('answer-a',1,'assistant',own),message('turn-b',2,'user'),message('answer-b',2,'assistant',other)]};
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'turn-a',thread_id:'thread',project_id:'project',space_id:'receipt-space'}})).mockResolvedValueOnce(response(session));
 const result=await projectResearchApi.refineQuestion('project',{thread_id:'thread',research_question:'Q',message:'m',execution:{}},'refine-key');
 expect(result).toMatchObject({recommended_question:'Earlier turn answer',research_context_version_id:'context-a'});
 expect(fetch).toHaveBeenCalledTimes(2);expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/research.question.refine');
});
it('sends scanned items and the business update key in the trigger body, separate from the transport key',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({status:'succeeded',data:{id:'operation/1',space_id:'receipt-space',project_id:'project/1'}})).mockResolvedValueOnce(response({id:'operation/1',status:'active'}));
 expect(await projectResearchApi.triggerIncremental('project/1','workflow/1',{source_item_ids:['item/1'],idempotency_key:'daily-2026-11-10'},'transport-key')).toEqual({id:'operation/1',status:'active'});
 const calls=vi.mocked(fetch).mock.calls;expect(calls).toHaveLength(2);expect(String(calls[0]![0])).toBe('/api/v1/actions/research.workflow.trigger');
 expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('transport-key');
 expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({project_id:'project/1',workflow_id:'workflow/1',source_item_ids:['item/1'],idempotency_key:'daily-2026-11-10'});
 expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('receipt-space');
 // Without a body it remains a plain scan-first update.
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response({status:'succeeded',data:{id:'op',space_id:'s',project_id:'p'}})).mockResolvedValueOnce(response({id:'op'}));
 await projectResearchApi.triggerIncremental('p','w');expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({project_id:'p',workflow_id:'w'});
 // An explicit empty list is the same scan-first update; it is sent as given, not refused client-side.
 vi.mocked(fetch).mockClear().mockResolvedValueOnce(response({status:'succeeded',data:{id:'op',space_id:'s',project_id:'p'}})).mockResolvedValueOnce(response({id:'op'}));
 await projectResearchApi.triggerIncremental('p','w',{source_item_ids:[]});expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({project_id:'p',workflow_id:'w',source_item_ids:[]});
});
