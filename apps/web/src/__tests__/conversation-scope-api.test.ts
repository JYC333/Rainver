import { beforeEach, describe, expect, it, vi } from 'vitest'
import { knowledgePromotionApi, notesApi, sourceGoalsApi,inquiryApi, sourcesApi, queryOperation,projectsApi,tasksApi,ApiRequestError, agentsApi, authorizationRequestsApi, conversationInputApi, projectFoldersApi, proposalsApi, roomsApi, runsApi, sessionsApi, skillsApi, setSpaceContext } from '../api/client'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
  setSpaceContext('active-space')
})
describe('conversation source Space transport', () => {
  it('loads recipient Skills through the skills namespace with the source Space', async () => {
    await skillsApi.availableSkills({ session_id: 'session', recipient_agent_ids: ['agent-a', 'agent-b'] }, { spaceId: 'source-a' })
    const [url, options] = vi.mocked(fetch).mock.calls[0]!
    expect(String(url)).toBe('/api/v1/skills/available?session_id=session&recipient_agent_ids=agent-a%2Cagent-b')
    expect(new Headers(options?.headers).get('X-Rainver-Space-Id')).toBe('source-a')
  })

  it.each(['source-a', 'source-b'])('keeps all reads and commands in %s while URL context stays elsewhere', async spaceId => {
    const options = { spaceId, signal: new AbortController().signal }
    // Core commands answer with receipts naming their source Space; follow-up reads stay there.
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url === '/api/v1/actions/room.message.send') return reply({ status: 'succeeded', data: { id: 'message', space_id: spaceId, room_id: 'room', session_id: 'session', status: 'sent', message_id: 'message', task_group_ids: ['group'], run_ids: ['run'] } })
      if (url === '/api/v1/authorization-requests/authorization/approve') return reply({status:'succeeded',data:{run_id:'run',request_id:'authorization'}})
      if (url === '/api/v1/runs/run/authorization-requests') return reply([{id:'authorization'}])
      if (url === '/api/v1/proposals/proposal/accept') return reply({status:'succeeded',data:{proposal:{id:'proposal'},result_type:'follow_up_task',result:{task:{id:'task'}}}})
      if (url.startsWith('/api/v1/rooms/room/conversations/session/messages')) return reply({ items: [{ id: 'message' }], conversation: { id: 'session' }, task_group_ids: [], limit: 200, offset: 0 })
      if (url === '/api/v1/actions/room.message.retry') return reply({ status: 'succeeded', data: { space_id: spaceId, room_id: 'room', schema_version: 'conversation_retry.v1', session_id: 'session', run_id: 'run-2', run_ids: ['run-2'], retry_of_run_id: 'run', user_message_id: 'message', status: 'queued', event_stream_url: '/x' } })
      if (url === '/api/v1/actions/run.stop') return reply({ status: 'succeeded', data: { id: 'run', space_id: spaceId, run_id: 'run', status: 'cancelling' } })
      return reply({})
    })
    await roomsApi.get('room', options)
    await roomsApi.messages('room', 'session', { offset: 50 }, options)
    await roomsApi.sendMessage('room', 'session', { content: 'Reply', routing_mode: 'direct', backends: [] }, options)
    await roomsApi.retryMessage('room', 'session', 'run', { ...options, idempotencyKey: 'retry-key' })
    await sessionsApi.executionContext('session', options)
    await agentsApi.conversationBackends('agent', { ...options, sessionId: 'session' })
    await conversationInputApi.searchFiles('session', 'file', undefined, options)
    await projectFoldersApi.file('project', 'folder', 'file.ts', options)
    await runsApi.turn('run', options)
    await runsApi.stop('run', options)
    await authorizationRequestsApi.approve('authorization', options)
    await proposalsApi.get('proposal', options)
    await proposalsApi.accept('proposal', options)
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(init?.headers).get('X-Rainver-Space-Id')).toBe(spaceId)
      expect(init?.signal).toBe(options.signal)
    }
    const retry = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/api/v1/actions/room.message.retry')!
    expect(new Headers(retry[1]?.headers).get('Idempotency-Key')).toBe('retry-key')
    await runsApi.get('active-run')
    expect(new Headers(vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1]![1]?.headers).get('X-Rainver-Space-Id')).toBe('active-space')
  })
})

describe('typed operation transport',()=>{
 it('uses current source Space and a private GET query without automatic retries',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:{actions:[]}}),{status:200,headers:{'Content-Type':'application/json'}}));
  expect(await queryOperation('system.actions.list',{}, {spaceId:'source-a'})).toEqual({status:'succeeded',data:{actions:[]}});
  const [url,options]=vi.mocked(fetch).mock.calls[0]!;
  expect(String(url)).toBe('/api/v1/queries/system.actions.list?input=%7B%7D');expect(options?.method).toBe('GET');
  expect(new Headers(options?.headers).get('X-Rainver-Space-Id')).toBe('source-a');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('preserves the nested operation error code/status and performs no automatic retry',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'idempotency_in_progress',message:'in progress',metadata:{},retryable:true,request_id:'request',domain:'operations'}}),{status:409,headers:{'Content-Type':'application/json'}}));
  try{await queryOperation('system.actions.list',{});throw new Error('expected refusal');}catch(error){expect(error).toBeInstanceOf(ApiRequestError);expect(error).toMatchObject({status:409,code:'idempotency_in_progress',message:'in progress (request id: request)',requestId:'request'});}
  expect(fetch).toHaveBeenCalledTimes(1);
 });
});

it('sends Project operation commands through the typed core with explicit keys and no automatic retry',async()=>{
  await projectsApi.createOperation('project',{kind:'source_setup',title:'Draft',initiating_run_id:'run',plan_artifact_id:'artifact'},'create-key');
  await projectsApi.cancelOperation('project','operation','cancel-key');
  const [createUrl,createInit]=vi.mocked(fetch).mock.calls[0]!;
  expect(String(createUrl)).toBe('/api/v1/actions/project.operation.create');
  expect(JSON.parse(createInit!.body as string)).toEqual({project_id:'project',kind:'source_setup',title:'Draft',initiating_run_id:'run',plan_artifact_id:'artifact'});
  const [cancelUrl,cancelInit]=vi.mocked(fetch).mock.calls[1]!;
  expect(String(cancelUrl)).toBe('/api/v1/actions/project.operation.cancel');
  expect(JSON.parse(cancelInit!.body as string)).toEqual({project_id:'project',operation_id:'operation'});
  expect(new Headers(createInit!.headers).get('Idempotency-Key')).toBe('create-key');
  expect(new Headers(cancelInit!.headers).get('Idempotency-Key')).toBe('cancel-key');
  expect(()=>projectsApi.cancelOperation('project','operation','')).toThrow('explicit idempotency key');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('uses explicit keys and Board revision for configuration and exact Task movement',async()=>{
  const columns=[{key:'ready',label:'Ready',status_key:'ready' as const,wip_limit:null}];
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:{columns,columns_revision:'next'}}),{status:200,headers:{'Content-Type':'application/json'}}));
  await projectsApi.configureBoard('project',{revision:'before',columns,moves:{}},'board-key');
  await tasksApi.moveToColumn('task',{column_key:'ready',columns_revision:'next'},'move-key');
  const calls=vi.mocked(fetch).mock.calls;
  expect(String(calls[0]![0])).toBe('/api/v1/actions/board.configure');
  expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe('board-key');
  expect(JSON.parse(calls[0]![1]?.body as string)).toMatchObject({project_id:'project',revision:'before'});
  expect(String(calls[1]![0])).toBe('/api/v1/projects/project/board');
  expect(String(calls[2]![0])).toBe('/api/v1/actions/task.move_to_column');
  expect(JSON.parse(calls[2]![1]?.body as string)).toEqual({task_id:'task',column_key:'ready',columns_revision:'next'});
  expect(new Headers(calls[2]![1]?.headers).get('Idempotency-Key')).toBe('move-key');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('sends Task status and explicit deletion through core with caller-owned keys',async()=>{
 await tasksApi.setStatus('task',{status:'blocked',blocked_reason:'Waiting supplier'},'status-key');
 await tasksApi.delete('task','delete-key');
 for(const [i,name,key] of [[0,'task.set_status','status-key'],[1,'task.delete','delete-key']] as const){
  const [url,options]=vi.mocked(fetch).mock.calls[i]!;
  expect(String(url)).toBe('/api/v1/actions/'+name);expect(options?.method).toBe('POST');
  expect(new Headers(options?.headers).get('Idempotency-Key')).toBe(key);
 }
 expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({task_id:'task',status:'blocked',blocked_reason:'Waiting supplier'});
 expect(()=>tasksApi.delete('task','')).toThrow('explicit idempotency key');
 expect(fetch).toHaveBeenCalledTimes(2);
});

it('saves standalone placement and contract metadata in one core command before refreshing the Task',async()=>{
 const changes={board_id:'board',title:'Renamed',max_runs:3};
 await tasksApi.update('task',changes,'placement-key');
 const calls=vi.mocked(fetch).mock.calls;
 expect(String(calls[0]![0])).toBe('/api/v1/actions/task.place_in_space_board');
 expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({task_id:'task',changes});
 expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe('placement-key');
 expect(String(calls[1]![0])).toBe('/api/v1/tasks/task');
 vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:{task_id:'task',project_id:null,status:'ready'}}),{status:200,headers:{'Content-Type':'application/json'}}));
 await tasksApi.update('task',{title:'Metadata only'},'edit-key');
 // An ordinary edit is the core task.update command on its retained URL, with the caller's key, then a refresh.
 expect(String(vi.mocked(fetch).mock.calls[2]![0])).toBe('/api/v1/tasks/task');
 expect(vi.mocked(fetch).mock.calls[2]![1]?.method).toBe('PATCH');
 expect(new Headers(vi.mocked(fetch).mock.calls[2]![1]?.headers).get('Idempotency-Key')).toBe('edit-key');
 expect(String(vi.mocked(fetch).mock.calls[3]![0])).toBe('/api/v1/tasks/task');
 expect(vi.mocked(fetch).mock.calls[3]![1]?.method??'GET').toBe('GET');
});

it('previews Source history via the core query and creates with separate request/domain keys',async()=>{
  const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  const preview={strategy:{window_unit:'date_window',history_mode:'bounded_range',from:null,to:null,window_size:30,max_items:5,direction:'backward',monitoring_field:'submittedDate'},quota_policy:{window:'minute',limit_count:10},segments:[]};
  vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:preview}));
  expect(await sourcesApi.previewChannelBackfill('channel',{strategy:{max_items:5}})).toEqual(preview);
  const [previewUrl,previewInit]=vi.mocked(fetch).mock.calls[0]!;
  expect(String(previewUrl)).toContain('/api/v1/queries/source.backfill.preview?');
  expect(new Headers(previewInit?.headers).has('Idempotency-Key')).toBe(false);
  const plan={id:'plan',source_channel_id:'channel',status:'draft'};
  vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:{plan_id:'plan',source_channel_id:'channel',status:'draft'}})).mockResolvedValueOnce(reply(plan));
  const body={idempotency_key:'business-key',strategy:{max_items:5}};
  expect(await sourcesApi.createChannelBackfillPlan('channel',body,'request-key')).toEqual(plan);
  const [createUrl,createInit]=vi.mocked(fetch).mock.calls[1]!;
  expect(String(createUrl)).toBe('/api/v1/actions/source.backfill.create_plan');
  expect(new Headers(createInit?.headers).get('Idempotency-Key')).toBe('request-key');
  expect(JSON.parse(createInit?.body as string)).toEqual({...body,source_channel_id:'channel'});
  expect(String(vi.mocked(fetch).mock.calls[2]![0])).toBe('/api/v1/sources/channels/channel/backfill/plans/plan');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('raises a Note selection with one explicit core key then reloads the authorized Thread',async()=>{
  const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  const thread={id:'thread',project_id:'project',kind:'question'};
  vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:{thread_id:'thread',project_id:'project',note_object_id:'note',kind:'question'}})).mockResolvedValueOnce(reply(thread));
  expect(await inquiryApi.raiseFromNote('project',{note_object_id:'note',statement:'A question?'},'question-key')).toEqual(thread);
  const [url,init]=vi.mocked(fetch).mock.calls[0]!;
  expect(url).toBe('/api/v1/actions/note.raise_as_question');
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('question-key');
  expect(JSON.parse(init?.body as string)).toEqual({project_id:'project',note_object_id:'note',statement:'A question?'});
  expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/v1/projects/project/inquiry/threads/thread');expect(fetch).toHaveBeenCalledTimes(2);
});

it('creates a human Thread with a typed core command and authorized detail read',async()=>{
  const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  const thread={id:'thread',project_id:'project',kind:'hypothesis'};
  vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:{thread_id:'thread',project_id:'project',kind:'hypothesis'}})).mockResolvedValueOnce(reply(thread));
  expect(await inquiryApi.createThread('project',{kind:'hypothesis',statement:'Depth explains the gain'},'human-key')).toEqual(thread);
  const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/inquiry.thread.create');
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('human-key');
  expect(JSON.parse(init?.body as string)).toEqual({project_id:'project',kind:'hypothesis',statement:'Depth explains the gain'});
  expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/v1/projects/project/inquiry/threads/thread');expect(fetch).toHaveBeenCalledTimes(2);
});

it('shares Source binding commands across both typed API facades without legacy writes',async()=>{
  const reply=(data:unknown)=>new Response(JSON.stringify({status:'succeeded',data}),{status:200,headers:{'Content-Type':'application/json'}});
  const binding={id:'binding',status:'active'};vi.mocked(fetch).mockImplementation(async()=>reply(binding));
  await sourcesApi.createProjectSourceBinding({project_id:'project',source_channel_id:'channel'},'bind-key');
  await projectsApi.updateSourceBinding('project','binding',{status:'paused'},'update-key');
  await sourcesApi.deleteProjectSourceBinding('project','binding','unbind-key');
  await projectsApi.backfillSourceBinding('project','binding','backfill-key');
  const calls=vi.mocked(fetch).mock.calls;
  for(const [i,id] of ['bind','update','unbind','backfill'].entries()){
    expect(calls[i]![0]).toBe('/api/v1/actions/project.source.'+id);expect(calls[i]![1]?.method).toBe('POST');
    expect(new Headers(calls[i]![1]?.headers).get('Idempotency-Key')).toBe(id==='bind'?'bind-key':id==='update'?'update-key':id==='unbind'?'unbind-key':'backfill-key');
  }
  expect(JSON.parse(calls[1]![1]?.body as string)).toEqual({project_id:'project',binding_id:'binding',changes:{status:'paused'}});expect(fetch).toHaveBeenCalledTimes(4);
});

it('sends personal subscription/recommendation decisions once through typed core commands',async()=>{
  vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data:{source_channel_id:'channel',status:'muted',updated_at:'2026-11-06T00:00:00.000Z'}}),{status:200,headers:{'Content-Type':'application/json'}}));
  await sourcesApi.setChannelSubscription('channel','muted','subscription-key');await sourcesApi.decideRecommendation('channel','muted','recommendation-key');
  const calls=vi.mocked(fetch).mock.calls;expect(calls.map(c=>c[0])).toEqual(['/api/v1/actions/source.channel.set_subscription','/api/v1/actions/source.recommendation.decide']);
  expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({source_channel_id:'channel',status:'muted'});expect(JSON.parse(calls[1]![1]?.body as string)).toEqual({source_channel_id:'channel',decision:'muted'});
  expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe('subscription-key');expect(new Headers(calls[1]![1]?.headers).get('Idempotency-Key')).toBe('recommendation-key');expect(fetch).toHaveBeenCalledTimes(2);
});

it('creates a Source recipe draft through one typed command without copying the browsed Space into content authority',async()=>{
  const data={connection:{id:'source',source_channel_id:'channel',space_id:'personal',status:'paused',handler_kind:'recipe'},recipe_version:{id:'version'}};
  vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data}),{status:201,headers:{'Content-Type':'application/json'}}));
  const body={name:'Feed',endpoint_url:'https://example.test/rss',source_type:'rss' as const};
  expect(await sourcesApi.createSourceRecipe(body,'draft-key')).toEqual(data);
  const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/source.recipe.create');expect(JSON.parse(init?.body as string)).toEqual(body);expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('draft-key');expect(fetch).toHaveBeenCalledTimes(1);
});

it('saves a Monitor and queues its scan via one keyed core call each, retaining explicit source-Space transport',async()=>{
  vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data:{id:'receipt'}}),{status:200,headers:{'Content-Type':'application/json'}}));
  await sourcesApi.updateChannel('channel',{name:'Morning'},'save-key');await sourcesApi.scanChannel('channel',{spaceId:'source-space'},'scan-key');
  const calls=vi.mocked(fetch).mock.calls;expect(calls.map(c=>c[0])).toEqual(['/api/v1/actions/source.channel.update','/api/v1/actions/source.channel.scan']);
  expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({source_channel_id:'channel',changes:{name:'Morning'}});expect(JSON.parse(calls[1]![1]?.body as string)).toEqual({source_channel_id:'channel'});
  expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe('save-key');expect(new Headers(calls[1]![1]?.headers).get('Idempotency-Key')).toBe('scan-key');expect(new Headers(calls[1]![1]?.headers).get('X-Rainver-Space-Id')).toBe('source-space');expect(fetch).toHaveBeenCalledTimes(2);
});

it('restores/trashes a Note once through core then reloads its current authorized body in the receipt Space',async()=>{
  const reply=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  vi.mocked(fetch).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'note',space_id:'source-space',version:3}})).mockImplementationOnce(async()=>reply({id:'note',version:3})).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'note',space_id:'source-space',version:3}})).mockImplementationOnce(async()=>reply({id:'note',version:3,status:'deleted'}));
  expect(await notesApi.rollback('note',1,2,'restore-key')).toEqual({id:'note',version:3});expect(await notesApi.delete('note','trash-key')).toEqual({id:'note',version:3,status:'deleted'});
  const calls=vi.mocked(fetch).mock.calls;expect(calls.map(c=>c[0])).toEqual(['/api/v1/actions/knowledge.note.rollback','/api/v1/knowledge/notes/note','/api/v1/actions/knowledge.note.delete','/api/v1/knowledge/notes/note']);
  expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({note_id:'note',to_version:1,expect_version:2});expect(JSON.parse(calls[2]![1]?.body as string)).toEqual({note_id:'note'});expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe('restore-key');expect(new Headers(calls[2]![1]?.headers).get('Idempotency-Key')).toBe('trash-key');
  for(const i of [1,3])expect(new Headers(calls[i]![1]?.headers).get('X-Rainver-Space-Id')).toBe('source-space');expect(fetch).toHaveBeenCalledTimes(4);
});

it('creates a Monitor through the named core with the explicit key and caller request scope',async()=>{
 const channel={id:'monitor',space_id:'personal',source_connection_id:'source'};
 vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data:channel}),{status:201}));
 const body={provider_key:'arxiv',query:{search_query:'cat:cs.AI'}};
 expect(await sourcesApi.createChannel(body,{spaceId:'request-space'},'monitor-key')).toEqual(channel);
 const [url,options]=vi.mocked(fetch).mock.calls[0]!;expect(String(url)).toBe('/api/v1/actions/source.channel.create');
 expect(new Headers(options?.headers).get('Idempotency-Key')).toBe('monitor-key');expect(new Headers(options?.headers).get('X-Rainver-Space-Id')).toBe('request-space');
 expect(JSON.parse(String(options?.body))).toEqual(body);
 expect(await sourcesApi.createChannel(body,{spaceId:'request-space'},'monitor-key')).toEqual(channel);
 expect(fetch).toHaveBeenCalledTimes(2);expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]?.headers).get('Idempotency-Key')).toBe('monitor-key');
});

it('uses canonical keyed Source processing/extraction commands and keeps enqueue receipts',async()=>{
 const receipt={job_id:'queued',status:'pending',source_channel_id:'channel',extraction_job_id:null,extraction_status:null};
 vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data:receipt}),{status:202}));
 await sourcesApi.createPostProcessingRule('channel',{name:'Rule'},'create-key');
 await sourcesApi.updatePostProcessingRule('channel','rule',{status:'paused'},'update-key');
 expect(await sourcesApi.runPostProcessingRule('channel','rule','run-key')).toEqual(receipt);
 await sourcesApi.drainPostProcessingRule('channel','rule','drain-key');
 await sourcesApi.runJob('extraction',{spaceId:'source-space'},'job-key');
 expect(vi.mocked(fetch).mock.calls.map(x=>x[0])).toEqual(['/api/v1/actions/source.processing.rule.create','/api/v1/actions/source.processing.rule.update','/api/v1/actions/source.processing.rule.dispatch','/api/v1/actions/source.processing.rule.dispatch','/api/v1/actions/source.extraction.dispatch']);
 expect(vi.mocked(fetch).mock.calls.map(x=>new Headers(x[1]?.headers).get('Idempotency-Key'))).toEqual(['create-key','update-key','run-key','drain-key','job-key']);
 expect(new Headers(vi.mocked(fetch).mock.calls[4]![1]?.headers).get('X-Rainver-Space-Id')).toBe('source-space');
});

it('edits and creates Notes through explicit core keys and reloads only in the receipt Space',async()=>{
 const reply=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})
 vi.mocked(fetch).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'n',space_id:'source',version:1,project_ids:[]}})).mockImplementationOnce(async()=>reply({id:'n',version:1})).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'n',space_id:'source',version:2,project_ids:[]}})).mockImplementationOnce(async()=>reply({id:'n',version:2}))
 await notesApi.create({title:'Draft'},'create-key');await notesApi.update('n',{title:'Edited'},'edit-key')
 const calls=vi.mocked(fetch).mock.calls;expect(calls.map(c=>c[0])).toEqual(['/api/v1/actions/knowledge.note.create','/api/v1/knowledge/notes/n','/api/v1/actions/knowledge.note.update','/api/v1/knowledge/notes/n'])
 expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBe('create-key');expect(new Headers(calls[2][1]?.headers).get('Idempotency-Key')).toBe('edit-key');expect(JSON.parse(String(calls[2][1]?.body))).toEqual({note_id:'n',changes:{title:'Edited'}})
 for(const index of [1,3])expect(new Headers(calls[index][1]?.headers).get('X-Rainver-Space-Id')).toBe('source')
})

it('retains the Note sharing decision metadata instead of replacing it with generic conflict prose',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'operation_conflict',domain:'knowledge',message:'operation conflict',retryable:false,request_id:'r',metadata:{code:'note_cross_project_share_required',owner_project_id:'project-a'}}}),{status:409,headers:{'Content-Type':'application/json'}}))
 await expect(notesApi.addPlacement('n','folder-b',false,'placement-key')).rejects.toMatchObject({status:409,code:'note_cross_project_share_required',payload:{owner_project_id:'project-a'}})
 expect(fetch).toHaveBeenCalledTimes(1)
});

it('submits Note promotion once with the event key and reads the current pending Proposal in receipt Space',async()=>{
 const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 const proposal={id:'proposal',status:'pending',proposal_type:'knowledge_create'};
 vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:{id:'proposal',space_id:'parent-space'}})).mockResolvedValueOnce(reply(proposal));
 expect(await notesApi.promote('note',{content:'Selected'},'promotion-key')).toEqual(proposal);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe('/api/v1/actions/note.promote_to_knowledge');expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('promotion-key');expect(JSON.parse(init?.body as string)).toEqual({note_id:'note',content:'Selected'});
 expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/v1/proposals/proposal');expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]?.headers).get('X-Rainver-Space-Id')).toBe('parent-space');expect(fetch).toHaveBeenCalledTimes(2);
});

it('submits a Candidate decision once with the event key then reads current Candidate content in receipt Space',async()=>{
 const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),candidate={id:'candidate',status:'promoted',created_proposal_id:'proposal'};
 vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:{id:'candidate',space_id:'original',project_id:'project',item_id:null}})).mockResolvedValueOnce(reply(candidate));
 expect(await knowledgePromotionApi.decide('project','candidate',{decision:'promote'},'review-key')).toEqual(candidate);
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/knowledge.candidate.decide');expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('review-key');expect(JSON.parse(init?.body as string)).toEqual({project_id:'project',candidate_id:'candidate',decision:'promote'});expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/v1/projects/project/knowledge-candidates/candidate');expect(new Headers(vi.mocked(fetch).mock.calls[1]![1]?.headers).get('X-Rainver-Space-Id')).toBe('original');expect(fetch).toHaveBeenCalledTimes(2);
});
it('opens a keyed review packet then reads its current members instead of caching private proposal text',async()=>{
 const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),packet={id:'packet',status:'open',candidates:[]};vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:{id:'packet',space_id:'original',project_id:'project',item_id:null}})).mockResolvedValueOnce(reply(packet));expect(await knowledgePromotionApi.openPacket('project',10,'packet-key')).toEqual(packet);expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/v1/actions/knowledge.candidate.packet.open');expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/v1/projects/project/knowledge-candidate-review-packets/packet');expect(fetch).toHaveBeenCalledTimes(2);
});

it('encodes Candidate and packet follow-up GET segments without changing operation inputs or receipt Space',async()=>{
 const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),project='project/a b',candidate='candidate/?x',packet='packet/#x';
 for(const [kind,id] of [['decide',candidate],['reopen',candidate],['openPacket',packet],['closePacket',packet]] as const){
  vi.mocked(fetch).mockClear();const current={id,status:'current',candidates:[]};vi.mocked(fetch).mockResolvedValueOnce(reply({status:'succeeded',data:{id,space_id:'original',project_id:project,item_id:null}})).mockResolvedValueOnce(reply(current));
  if(kind==='decide')expect(await knowledgePromotionApi.decide(project,candidate,{decision:'defer'},'key')).toEqual(current);
  else if(kind==='reopen')expect(await knowledgePromotionApi.reopen(project,candidate,'key')).toEqual(current);
  else if(kind==='openPacket')expect(await knowledgePromotionApi.openPacket(project,10,'key')).toEqual(current);
  else expect(await knowledgePromotionApi.closePacket(project,packet,'key')).toEqual(current);
  const calls=vi.mocked(fetch).mock.calls;expect(JSON.parse(calls[0]![1]?.body as string).project_id).toBe(project);expect(calls[1]![0]).toBe(`/api/v1/projects/${encodeURIComponent(project)}/${kind==='decide'||kind==='reopen'?'knowledge-candidates':'knowledge-candidate-review-packets'}/${encodeURIComponent(id)}`);expect(new Headers(calls[1]![1]?.headers).get('X-Rainver-Space-Id')).toBe('original');expect(fetch).toHaveBeenCalledTimes(2);
 }
});

it('queues extraction with an explicit event key and keeps the receipt as queued, without a second legacy request',async()=>{
 const receipt={run_id:'run',space_id:'original',status:'queued'};vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:receipt}),{status:202,headers:{'Content-Type':'application/json'}}));expect(await knowledgePromotionApi.extract('project',{source_kind:'note',source_id:'note',agent_id:'agent'},'extraction-key')).toEqual(receipt);const [url,init]=vi.mocked(fetch).mock.calls[0]!;expect(url).toBe('/api/v1/actions/knowledge.candidate.extract');expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('extraction-key');expect(JSON.parse(init?.body as string)).toEqual({project_id:'project',source_kind:'note',source_id:'note',agent_id:'agent'});expect(fetch).toHaveBeenCalledTimes(1);
});

it('saves URLs and acts on Source items through keyed core commands, rereading only in the receipt Space',async()=>{
  const reply=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  const receipt=reply.bind(null,{status:'succeeded',data:{id:'item',space_id:'personal'}}),item=()=>reply({id:'item',space_id:'personal',title:'Current'});
  vi.mocked(fetch).mockImplementationOnce(async()=>receipt()).mockImplementationOnce(async()=>item()).mockImplementationOnce(async()=>receipt()).mockImplementationOnce(async()=>item()).mockImplementationOnce(async()=>receipt()).mockImplementationOnce(async()=>item()).mockImplementationOnce(async()=>receipt()).mockImplementationOnce(async()=>item());
  expect(await sourcesApi.createManualUrl({url:'https://example.test',queue_content:false},{spaceId:'active-space'},'save-key')).toEqual({id:'item',space_id:'personal',title:'Current'});
  await sourcesApi.itemAction('item','queue_content',{},'queue-key');await sourcesApi.itemAction('item','mark_selected',{},'triage-key');await sourcesApi.updateItem('item',{connection_id:null},'move-key');
  const calls=vi.mocked(fetch).mock.calls;
  expect(calls.map(c=>c[0])).toEqual(['/api/v1/actions/source.item.save_url','/api/v1/sources/items/item','/api/v1/actions/source.item.queue','/api/v1/sources/items/item','/api/v1/actions/source.item.triage','/api/v1/sources/items/item','/api/v1/actions/source.item.update','/api/v1/sources/items/item']);
  expect(calls.filter((_,i)=>i%2===0).map(c=>new Headers(c[1]?.headers).get('Idempotency-Key'))).toEqual(['save-key','queue-key','triage-key','move-key']);
  for(const i of [1,3,5,7])expect(new Headers(calls[i]![1]?.headers).get('X-Rainver-Space-Id')).toBe('personal');
  expect(JSON.parse(calls[6]![1]?.body as string)).toEqual({source_item_id:'item',connection_id:null});expect(fetch).toHaveBeenCalledTimes(8);
});
it('reviews and links evidence, links Notes and jots once through core without a legacy write',async()=>{
  const reply=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  vi.mocked(fetch).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'ev',space_id:'s'}})).mockImplementationOnce(async()=>reply({id:'ev',status:'rejected'})).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'link',space_id:'s',evidence_id:'ev'}})).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'nl',space_id:'s',note_id:'note'}})).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'nl',space_id:'s',note_id:'note'}})).mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'note',space_id:'s'}})).mockImplementationOnce(async()=>reply({id:'note',title:'Note on Paper'}));
  expect(await sourcesApi.updateEvidence('ev',{status:'rejected'},'review-key')).toEqual({id:'ev',status:'rejected'});
  expect(await sourcesApi.createEvidenceLink({evidence_id:'ev',target_type:'project',target_id:'p'},'link-key')).toEqual({id:'link',space_id:'s',evidence_id:'ev'});
  await notesApi.createLink('note',{target_type:'source',target_id:'src'},'note-link-key');await notesApi.deleteLink('note','nl','unlink-key');
  expect(await notesApi.jot({target_id:'src',text:'Thought',project_id:'p'},'jot-key')).toEqual({id:'note',title:'Note on Paper'});
  const calls=vi.mocked(fetch).mock.calls;
  expect(calls.map(c=>c[0])).toEqual(['/api/v1/actions/source.evidence.update','/api/v1/sources/evidence/ev','/api/v1/actions/source.evidence.link','/api/v1/actions/knowledge.note.link.create','/api/v1/actions/knowledge.note.link.delete','/api/v1/actions/knowledge.note.jot','/api/v1/knowledge/notes/note']);
  expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({evidence_id:'ev',status:'rejected'});expect(JSON.parse(calls[4]![1]?.body as string)).toEqual({note_id:'note',link_id:'nl'});
  expect([0,2,3,4,5].map(i=>new Headers(calls[i]![1]?.headers).get('Idempotency-Key'))).toEqual(['review-key','link-key','note-link-key','unlink-key','jot-key']);
  expect(new Headers(calls[6]![1]?.headers).get('X-Rainver-Space-Id')).toBe('s');expect(fetch).toHaveBeenCalledTimes(7);
});
it('material, credential, preview and purge helpers send one keyed core command and surface structured refusal codes',async()=>{
  const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  vi.mocked(fetch)
    .mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'item',space_id:'s',status:'queued',run_id:'run'}}))
    .mockImplementationOnce(async()=>reply({error:{code:'operation_conflict',domain:'sources',message:'The text was updated; look at it again before choosing',metadata:{code:'reading_version_changed'},retryable:false,request_id:'r'}},409))
    .mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'cred',space_id:'s',name:'Access'}},201))
    .mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'job',space_id:'s',job_id:'job',status:'pending'}},202))
    .mockImplementationOnce(async()=>reply({job_id:'job',kind:'query_preview',status:'completed',result:{provider_key:'arxiv',samples:[]},withheld:0}))
    .mockImplementationOnce(async()=>reply({status:'succeeded',data:{id:'s',space_id:'s',deleted:2,retention_days:30,project_ids:[]}}));
  expect(await sourcesApi.prepareMaterial('item',{investigation:true},{spaceId:'s'},'start-key')).toEqual({status:'queued',run_id:'run'});
  await expect(sourcesApi.showAgentTextAsMarkdown('item',{artifact_id:'a',source_snapshot_id:null},{spaceId:'s'},'md-key')).rejects.toMatchObject({status:409,code:'reading_version_changed'});
  expect(await sourceGoalsApi.storeCredential({name:'Access',secret:'s3cret'},{spaceId:'s'},'cred-key')).toEqual({id:'cred',space_id:'s',name:'Access'});
  expect(await sourcesApi.previewQuery({provider_key:'arxiv',query:{q:'x'}},'preview-key')).toEqual({provider_key:'arxiv',samples:[]});
  expect(await notesApi.purgeDeleted('purge-key')).toEqual({deleted:2,retention_days:30});
  const calls=vi.mocked(fetch).mock.calls;
  expect(calls.map(c=>c[0])).toEqual(['/api/v1/actions/source.material.start','/api/v1/actions/source.material.show_markdown','/api/v1/actions/source.custom.credential.create','/api/v1/actions/source.query.preview','/api/v1/sources/retrieval/requests/job','/api/v1/actions/knowledge.note.trash.purge']);
  expect([0,1,2,3,5].map(i=>new Headers(calls[i]![1]?.headers).get('Idempotency-Key'))).toEqual(['start-key','md-key','cred-key','preview-key','purge-key']);
  expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({investigation:true,source_item_id:'item'});
  expect(calls[4]![1]?.method??'GET').toBe('GET');expect(fetch).toHaveBeenCalledTimes(6);
});
describe('exact receipt read-backs', () => {
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  it('reads the receipt\'s own invitation and message by id, however many newer ones exist', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url === '/api/v1/actions/room.invitation.decide') return reply({ status: 'succeeded', data: { id: 'old-invitation', space_id: 'source-a', room_id: 'room', invitation_id: 'old-invitation' } })
      if (url.startsWith('/api/v1/rooms/room/invitations?')) return reply({ items: [{ id: 'old-invitation', status: 'active' }], total: 1, limit: 1, offset: 0 })
      if (url === '/api/v1/actions/room.message.send') return reply({ status: 'succeeded', data: { id: 'old-message', space_id: 'source-a', room_id: 'room', session_id: 'session', status: 'sent', message_id: 'old-message', task_group_ids: ['group'], run_ids: ['run'] } })
      if (url.startsWith('/api/v1/rooms/room/conversations/session/messages?')) return reply({ items: [{ id: 'old-message' }], conversation: { id: 'session' }, task_group_ids: [], limit: 1, offset: 0 })
      return reply({})
    })
    await expect(roomsApi.decideInvitation('room', 'old-invitation', { agent_id: 'agent', decision: 'approved' })).resolves.toMatchObject({ id: 'old-invitation' })
    await expect(roomsApi.sendMessage('room', 'session', { content: 'Reply', routing_mode: 'direct', backends: [] }, { spaceId: 'source-a' })).resolves.toMatchObject({ message: { id: 'old-message' } })
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls).toContain('/api/v1/rooms/room/invitations?limit=1&invitation_id=old-invitation')
    expect(urls).toContain('/api/v1/rooms/room/conversations/session/messages?limit=1&message_id=old-message')
    expect(urls.some(url => url.includes('limit=200'))).toBe(false)
  })

  it('tracks a successful Proposal continuation whose internal message is hidden from the transcript', async () => {
    const commandUrl = '/api/v1/actions/room.message.continue_after_proposal'
    const receipt = {
      id: 'internal-message', space_id: 'source-a', room_id: 'room', session_id: 'session',
      message_id: 'internal-message', task_group_ids: ['continuation-group'], run_ids: ['continuation-run'],
    }
    vi.mocked(fetch).mockImplementation(async input => String(input) === commandUrl
      ? reply({ status: 'succeeded', data: receipt })
      : reply({ items: [], conversation: { id: 'session' }, task_group_ids: [], limit: 1, offset: 0 }))

    await expect(roomsApi.continueAfterProposal('room', 'session', { proposal_id: 'proposal', backends: [] }, { spaceId: 'source-a' }))
      .resolves.toMatchObject({ run_ids: ['continuation-run'] })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([commandUrl])
  })

  it('keeps a live input pending while its delivery is still owed, instead of reporting it undelivered', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetch).mockImplementation(async input => {
        const url = String(input)
        if (url === '/api/v1/actions/run.live_input.submit') return reply({ status: 'succeeded', data: { id: 'message', space_id: 'source-a', run_id: 'run', message_id: 'message', binding_id: 'binding' } })
        if (url.startsWith('/api/v1/runs/run/live-input?message_id=message')) return reply({ available: true, binding_id: 'binding', delivery_state: 'pending' })
        return reply({})
      })
      const sent = runsApi.sendLiveInput('run', { binding_id: '00000000-0000-4000-8000-000000000001', content: 'More' })
      await vi.runAllTimersAsync()
      await expect(sent).resolves.toMatchObject({ state: 'pending', message_id: 'message' })
      // A recorded outcome, once read, is reported as it is.
      vi.mocked(fetch).mockImplementation(async input => String(input).startsWith('/api/v1/runs/run/live-input')
        ? reply({ available: true, binding_id: 'binding', delivery_state: 'unconfirmed' })
        : reply({ status: 'succeeded', data: { id: 'message', space_id: 'source-a', run_id: 'run', message_id: 'message', binding_id: 'binding' } }))
      const later = runsApi.sendLiveInput('run', { binding_id: '00000000-0000-4000-8000-000000000001', content: 'More' })
      await vi.runAllTimersAsync()
      await expect(later).resolves.toMatchObject({ state: 'unconfirmed' })
    } finally { vi.useRealTimers() }
  })

  it('returns an ordinary send added to an active Run with its message, and promotes a choice among several Runs', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url === '/api/v1/actions/room.message.send') return reply({ status: 'succeeded', data: { id: 'message', space_id: 'source-a', room_id: 'room', session_id: 'session', status: 'live_input', run_id: 'run', message_id: 'message', binding_id: null, delivery_state: 'deferred' } })
      if (url.startsWith('/api/v1/rooms/room/conversations/session/messages?')) return reply({ items: [{ id: 'message', run_id: 'run' }], conversation: { id: 'session' }, task_group_ids: [], limit: 1, offset: 0 })
      return reply({})
    })
    const sent = await roomsApi.sendMessage('room', 'session', { content: 'Also check it', routing_mode: 'direct', backends: [], live_target: 'auto', queue: true }, { spaceId: 'source-a' })
    expect(sent).toMatchObject({ message: { id: 'message' }, live: { run_id: 'run', message_id: 'message', state: 'deferred' } })
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({ live_target: 'auto', queue: true })
    const candidates = [{ run_id: 'a' }, { run_id: 'b' }]
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'operation_conflict', domain: 'rooms', message: 'choose', metadata: { code: 'live_input_target_choice_required', candidates }, retryable: false, request_id: 'r' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    await expect(roomsApi.sendMessage('room', 'session', { content: 'Also check it', routing_mode: 'direct', backends: [], live_target: 'auto' }, { spaceId: 'source-a' }))
      .rejects.toMatchObject({ status: 409, code: 'live_input_target_choice_required', payload: { candidates } })
  })

  it('accepts a replayed queue receipt after the message has left the queue', async () => {
    const receipt = { id: 'queued-id', queued_id: 'queued-id', space_id: 'source-a', room_id: 'room', session_id: 'session', status: 'queued' }
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply({ status: 'succeeded', data: receipt }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(reply({ status: 'succeeded', data: receipt }))
      .mockResolvedValueOnce(reply({ items: [{ id: 'posted' }], queued: [], limit: 1, offset: 0 }))
    const options = { spaceId: 'source-a', idempotencyKey: 'original-send' }
    const body = { content: 'Send after this turn', queue: true, routing_mode: 'direct' as const, backends: [] }
    await expect(roomsApi.sendMessage('room', 'session', body, options)).rejects.toMatchObject({ cause: expect.objectContaining({ status: 503 }) })
    await expect(roomsApi.sendMessage('room', 'session', body, options)).resolves.toEqual({ queued: null })
    for (const index of [0, 2]) {
      expect(new Headers(vi.mocked(fetch).mock.calls[index]![1]!.headers).get('Idempotency-Key')).toBe('original-send')
    }
  })

  it('keeps a read-back refusal distinct from the accepted Room command', async () => {
    const receipt = { id: 'message', space_id: 'source-a', room_id: 'room', session_id: 'session', status: 'sent', message_id: 'message', run_ids: [], task_group_ids: [] }
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply({ status: 'succeeded', data: receipt }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    const options = { spaceId: 'source-a', idempotencyKey: 'original-send' }
    const body = { content: 'Also check it', live_target: 'auto' as const, routing_mode: 'direct' as const, backends: [] }
    await expect(roomsApi.sendMessage('room', 'session', body, options))
      .rejects.toMatchObject({ cause: expect.objectContaining({ status: 404 }) })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('original-send')
  })
})

it('sends Goal commands through the typed core with a fresh transport key, keeping the domain key and promoting refusal codes',async()=>{
  vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({status:'succeeded',data:{id:'goal',space_id:'active-space',session_id:'session',run_id:'run'}}),{status:200,headers:{'Content-Type':'application/json'}}));
  await sourceGoalsApi.message('goal','Follow robotics','message-key',{spaceId:'active-space'},{search_path:'api'});
  await sourceGoalsApi.message('goal','Follow robotics','message-key',{spaceId:'active-space'},{search_path:'api'});
  const [first,second]=vi.mocked(fetch).mock.calls;
  expect(String(first![0])).toBe('/api/v1/actions/source.goal.setup.message');
  expect(JSON.parse(first![1]!.body as string)).toEqual({goal_id:'goal',content:'Follow robotics',idempotency_key:'message-key',search_path:'api'});
  const keys=[first,second].map(call=>new Headers(call![1]!.headers).get('Idempotency-Key'));
  expect(keys[0]).toBeTruthy();expect(keys[0]).not.toBe(keys[1]);
  await sourceGoalsApi.action('goal','preview',{version_id:'v1'},{spaceId:'active-space'});
  expect(String(vi.mocked(fetch).mock.calls[2]![0])).toBe('/api/v1/actions/source.goal.preview.request');
  expect(JSON.parse(vi.mocked(fetch).mock.calls[2]![1]!.body as string)).toEqual({goal_id:'goal',version_id:'v1'});
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'operation_conflict',domain:'sources',message:'source_goal_preview_in_progress',metadata:{code:'source_goal_preview_in_progress'},retryable:false,request_id:'r'}}),{status:409,headers:{'Content-Type':'application/json'}}));
  await expect(sourceGoalsApi.action('goal','preview',{version_id:'v1'},{spaceId:'active-space'})).rejects.toMatchObject({status:409,code:'source_goal_preview_in_progress'});
});

describe('Proposal decision core transport',()=>{
 it('unwraps formal accept/rollback receipts and preserves the caller key and Space',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:{result_type:'code_patch_pending',result:{id:'intent'}}}),{status:202,headers:{'Content-Type':'application/json'}}));
  expect(await proposalsApi.accept('proposal',{spaceId:'source-a',idempotencyKey:'accept-key',confirmIncompletePatch:true})).toMatchObject({result_type:'code_patch_pending'});
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:{id:'rollback-intent'}}),{status:202,headers:{'Content-Type':'application/json'}}));
  expect(await proposalsApi.rollback('proposal',{spaceId:'source-a',idempotencyKey:'rollback-key'})).toEqual({id:'rollback-intent'});
  const calls=vi.mocked(fetch).mock.calls;
  expect(calls.map(c=>c[0])).toEqual(['/api/v1/proposals/proposal/accept','/api/v1/proposals/proposal/rollback']);
  expect(new Headers(calls[0]![1]?.headers).get('Idempotency-Key')).toBe('accept-key');
  expect(new Headers(calls[1]![1]?.headers).get('Idempotency-Key')).toBe('rollback-key');
  expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({confirm_incomplete_patch:true});
  for(const [,init] of calls)expect(new Headers(init?.headers).get('X-Rainver-Space-Id')).toBe('source-a');
 });
});

it('distinguishes a committed settings write from failed readback without replaying it', async () => {
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  vi.mocked(fetch)
    .mockResolvedValueOnce(response({ status: 'succeeded', data: { id: 'session', session_id: 'session', space_id: 'source-a' } }))
    .mockResolvedValueOnce(response({ detail: 'Catalog unavailable' }, 503))
  await expect(agentsApi.saveConversationSessionConfig('agent', { session_id: 'session', runtime_profile_id: 'runtime', session_config: [] }, { spaceId: 'source-a' }))
    .rejects.toMatchObject({ settingsSaved: true, status: 503 })
  expect(vi.mocked(fetch).mock.calls).toHaveLength(2)
  expect(vi.mocked(fetch).mock.calls.map(([,init]) => init?.method ?? 'GET')).toEqual(['POST','GET'])
})
