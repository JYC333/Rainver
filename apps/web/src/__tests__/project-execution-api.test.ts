// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiRequestError, experimentsApi, projectFoldersApi, setSpaceContext } from '../api/client';
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const receipt=(id='item')=>({status:'succeeded',data:{id,space_id:'original-space',project_id:'project/one',definition_id:'definition/one',folder_id:'folder/one'}});
beforeEach(()=>{setSpaceContext('current-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{vi.unstubAllGlobals();});
it('creates an Experiment with its explicit event key and reads current content in the receipt Space',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(receipt('definition/one'))).mockResolvedValueOnce(response({id:'definition/one',name:'Current Experiment',versions:[]}));
  expect(await experimentsApi.createDefinition('project/one',{name:'Input'},'event-key')).toMatchObject({name:'Current Experiment'});
  const calls=vi.mocked(fetch).mock.calls;expect(calls).toHaveLength(2);
  expect(String(calls[0]![0])).toBe('/api/v1/actions/experiment.definition.create');
  expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({project_id:'project/one',name:'Input'});
  expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('event-key');
  expect(String(calls[1]![0])).toBe('/api/v1/projects/project%2Fone/experiments/definitions/definition%2Fone');
  expect(new Headers(calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
});
it('follows the receipt Version, Run and reviewed Interpretation rather than returning cached mutation content',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(receipt('version'))).mockResolvedValueOnce(response({versions:[{id:'version',status:'approved'}]}));
  expect(await experimentsApi.approveVersion('project/one','definition/one','version','approve-key')).toEqual({id:'version',status:'approved'});
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt('run'))).mockResolvedValueOnce(response([{id:'run',status:'queued'}]));
  expect(await experimentsApi.launchRun('project/one','definition/one','version',{agent_id:'agent'},'launch-key')).toEqual({id:'run',status:'queued'});
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/experiment.run.launch');
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt('interpretation'))).mockResolvedValueOnce(response([{id:'interpretation',status:'converted'}]));
  expect(await experimentsApi.convertInterpretation('project/one','interpretation',0.9,'convert-key')).toEqual({id:'interpretation',status:'converted'});
  expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/project%2Fone/experiments/definitions/definition%2Fone/interpretations');
});
it('reads current observations after completing a Run and does not automatically retry a failed command',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(receipt('run/one'))).mockResolvedValueOnce(response([{id:'run/one',status:'completed'}])).mockResolvedValueOnce(response([{id:'observation'}]));
  expect(await experimentsApi.completeRun('project/one','definition/one','run/one',{status:'completed'},'complete-key')).toEqual({id:'run/one',status:'completed',observations:[{id:'observation'}]});
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'operation_conflict',message:'conflict'}}),{status:409}));
  await expect(experimentsApi.createRun('project/one','definition/one','version',{},'same-key')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('uses Folder operation keys and current metadata/Location reads while archive consumes only its receipt',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(receipt('folder/one'))).mockResolvedValueOnce(response({id:'folder/one',name:'Current Folder'}));
  expect(await projectFoldersApi.update('project/one','folder/one',{name:'Input'},'folder-key')).toEqual({id:'folder/one',name:'Current Folder'});
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.folder.update');
  expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt('location'))).mockResolvedValueOnce(response([{id:'location',status:'active'}]));
  expect(await projectFoldersApi.activateLocation('project/one','folder/one','location','activate-key')).toEqual({id:'location',status:'active'});
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt('folder/one')));
  await expect(projectFoldersApi.archive('project/one','folder/one','archive-key')).resolves.toBeNull();expect(fetch).toHaveBeenCalledTimes(1);
});
const draftInput={target_kind:'new' as const,relative_path:'private.txt',base_exists:false,base_sha256:null,content:'PRIVATE text',content_sha256:'a'.repeat(64),byte_size:12,source_encoding:'utf8' as const,preserve_bom:false,line_ending_mode:'none' as const};
const draftReceipt=(version=1)=>({status:'succeeded',data:{id:'draft',space_id:'original-space',project_id:'project/one',folder_id:'folder/one',workspace_location_id:'location',version}});
it('saves and rebases through the same caller-keyed command and reads the exact private receipt row',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(draftReceipt())).mockResolvedValueOnce(response({id:'draft',version:1,content:'PRIVATE text'}));
  expect(await projectFoldersApi.upsertDraft('project/one','folder/one',draftInput,'draft-key')).toMatchObject({id:'draft',version:1});
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.folder.draft.upsert');
  expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('draft-key');
  expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('/api/v1/projects/project%2Fone/folders/folder%2Fone/file/drafts/draft');
  expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(draftReceipt(2))).mockResolvedValueOnce(response({id:'draft',version:2,content:'PRIVATE text'}));
  await projectFoldersApi.rebaseDraft('project/one','folder/one',{...draftInput,expected_version:1},'rebase-key');
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('/api/v1/actions/project.folder.draft.upsert');
  expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('rebase-key');
});
it('hydrates a canonical conflict through a supplementary private read in the original Space without translating or retrying it',async()=>{
  const failure={error:{code:'operation_conflict',message:'The draft changed',metadata:{code:'draft_version_conflict',current_draft_id:'current',current_version:2}}};
  vi.mocked(fetch).mockImplementationOnce(async()=>{setSpaceContext('another-space');return new Response(JSON.stringify(failure),{status:409});}).mockResolvedValueOnce(response({id:'current',version:3,content:'Current private body'}));
  let caught:unknown;try{await projectFoldersApi.upsertDraft('project/one','folder/one',draftInput,'conflict-key');}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(ApiRequestError);expect(caught).toMatchObject({code:'operation_conflict',payload:failure,currentDraft:{id:'current',version:3,content:'Current private body'}});
  expect(fetch).toHaveBeenCalledTimes(2);expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]!.headers).get('X-Rainver-Space-Id')).toBe('current-space');
});
it('refuses to acknowledge a superseded draft read and discards exact versions without a write retry',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(draftReceipt(1))).mockResolvedValueOnce(response({id:'draft',version:2,content:'Other tab'}));
  await expect(projectFoldersApi.upsertDraft('project/one','folder/one',draftInput,'draft-key')).rejects.toMatchObject({code:'operation_conflict',currentDraft:{version:2}});expect(fetch).toHaveBeenCalledTimes(2);
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'operation_conflict',metadata:{code:'draft_version_conflict',current_draft_id:null,current_version:null}}}),{status:409}));
  await expect(projectFoldersApi.discardDraft('project/one','folder/one','draft',1,'discard-key')).rejects.toMatchObject({code:'operation_conflict',currentDraft:null});expect(fetch).toHaveBeenCalledTimes(1);
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(receipt('draft')));await expect(projectFoldersApi.discardDraft('project/one','folder/one','draft',1,'discard-key')).resolves.toEqual({discarded:true});
});
it('unregisters with an explicit event key and keeps canonical confirmation metadata intact',async()=>{
  const failure={error:{code:'operation_conflict',message:'Confirm live drafts',metadata:{code:'active_drafts_require_confirmation',active_draft_count:2,affected_user_count:1}}};
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(failure),{status:409}));
  await expect(projectFoldersApi.unregister('project/one','folder/one',false,'unregister-key')).rejects.toMatchObject({code:'operation_conflict',payload:failure});expect(fetch).toHaveBeenCalledTimes(1);
  expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('unregister-key');
});
const ioReceipt=()=>({status:'succeeded',data:{id:'intent',space_id:'original-space',project_id:'project/one',folder_id:'folder/one',job_id:'job'}});
const ioStatus=(result:unknown,status='succeeded',error:unknown=null)=>({id:'intent',space_id:'original-space',project_id:'project/one',folder_id:'folder/one',job_id:'job',kind:'save_draft',status,error,result});
it('waits on one Folder intent without resubmitting and follows current metadata after create',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(ioReceipt())).mockResolvedValueOnce(response(ioStatus(null,'prepared'))).mockResolvedValueOnce(response(ioStatus({kind:'create',folder_id:'created'}))).mockResolvedValueOnce(response({id:'created',name:'Current Folder'}));
  expect(await projectFoldersApi.create('project/one',{name:'New Folder'},'create-event')).toMatchObject({id:'created'});
  const calls=vi.mocked(fetch).mock.calls;expect(calls).toHaveLength(4);
  expect(String(calls[0]![0])).toBe('/api/v1/actions/project.folder.create');
  expect(new Headers(calls[0]![1]!.headers).get('Idempotency-Key')).toBe('create-event');
  expect(String(calls[1]![0])).toBe('/api/v1/projects/project%2Fone/folder-io/intent');
  expect(calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
  expect(new Headers(calls[3]![1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');
});
it('reads saved bytes and the newer private draft from the frozen Location in the receipt Space',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(ioReceipt())).mockResolvedValueOnce(response(ioStatus({kind:'save_draft',folder_id:'folder/one',workspace_location_id:'frozen/location',path:'a b.txt',revision:{id:'revision'},draft_deleted:false,newer_draft_retained:true,after_sha256:'a'.repeat(64)}))).mockResolvedValueOnce(response({path:'a b.txt',content:'Bytes on disk'})).mockResolvedValueOnce(response({id:'draft',version:2,content:'Newer unsaved edit'}));
  expect(await projectFoldersApi.saveDraft('project/one','folder/one','draft',1,false,'save-event')).toMatchObject({file:{content:'Bytes on disk'},newer_draft_retained:true,current_draft:{version:2}});
  const calls=vi.mocked(fetch).mock.calls;
  expect(String(calls[0]![0])).toBe('/api/v1/actions/project.folder.draft.save');
  for(const call of calls.slice(2)){expect(String(call[0])).toContain('workspace_location_id=frozen%2Flocation');expect(new Headers(call[1]!.headers).get('X-Rainver-Space-Id')).toBe('original-space');}
});
it('surfaces terminal Folder refusal with private conflict hydration and never retries a write',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(ioReceipt())).mockResolvedValueOnce(response(ioStatus(null,'failed',{code:'draft_version_conflict',metadata:{current_draft_id:'current',current_version:3}}))).mockResolvedValueOnce(response({id:'current',version:3,content:'Private current edit'}));
  await expect(projectFoldersApi.restoreRevisionAsDraft('project/one','folder/one','revision','restore-event')).rejects.toMatchObject({code:'operation_conflict',currentDraft:{version:3},payload:{error:{metadata:{code:'draft_version_conflict',intent_id:'intent',job_id:'job'}}}});
  expect(vi.mocked(fetch).mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it('returns durable scan candidates and refuses unknown outcomes without another command',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response(ioReceipt())).mockResolvedValueOnce(response(ioStatus({kind:'scan',items:[{name:'Candidate',path:'/private/workspace'}]})));
  await expect(projectFoldersApi.scan('project/one','scan-event')).resolves.toEqual({items:[{name:'Candidate',path:'/private/workspace'}]});
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(response(ioReceipt())).mockResolvedValueOnce(response(ioStatus(null,'needs_attention',{code:'folder_file_needs_attention',metadata:{}})));
  await expect(projectFoldersApi.saveDraft('project/one','folder/one','draft',1,false,'same-event')).rejects.toMatchObject({code:'operation_conflict',payload:{error:{metadata:{code:'folder_file_needs_attention'}}}});
  expect(fetch).toHaveBeenCalledTimes(2);
});
