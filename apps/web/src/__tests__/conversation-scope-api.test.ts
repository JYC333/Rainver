import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inquiryApi, sourcesApi, queryOperation,projectsApi,tasksApi,ApiRequestError, agentsApi, authorizationRequestsApi, conversationInputApi, projectFoldersApi, proposalsApi, roomsApi, runsApi, sessionsApi, skillsApi, setSpaceContext } from '../api/client'

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
    expect(new Headers(vi.mocked(fetch).mock.calls[3]![1]?.headers).get('Idempotency-Key')).toBe('retry-key')
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
  try{await queryOperation('system.actions.list',{});throw new Error('expected refusal');}catch(error){expect(error).toBeInstanceOf(ApiRequestError);expect(error).toMatchObject({status:409,code:'idempotency_in_progress',message:'in progress'});}
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
 await tasksApi.update('task',{title:'Metadata only'});
 expect(String(vi.mocked(fetch).mock.calls[2]![0])).toBe('/api/v1/tasks/task');
 expect(vi.mocked(fetch).mock.calls[2]![1]?.method).toBe('PATCH');
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
