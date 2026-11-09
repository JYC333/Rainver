import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTION_REGISTRY, OPERATION_SCHEMA_TABLE, OperationErrorSchema, OperationActorSchema } from '../src/index.js';
it('keeps standalone placement human-only and excludes lifecycle bypasses from its strict contract',()=>{
  const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='task.place_in_space_board')!;
  expect(definition.allowed_actor_types).toEqual(['user']);
  expect(definition.visibility.has('agent_tool')).toBe(false);
  const schema=OPERATION_SCHEMA_TABLE['task.place_in_space_board'].input;
  expect(schema.parse({task_id:'task',changes:{board_id:null,title:'Contract save'}})).toMatchObject({changes:{board_id:null,title:'Contract save'}});
  for(const changes of [{title:'No placement'},{board_id:null,status:'done'},{board_id:null,deleted_at:'now'},{board_id:null,project_id:'project'}])expect(schema.safeParse({task_id:'task',changes}).success).toBe(false);
});
describe('operation public contracts', () => {
  it('uses the same input/output Zod authority for typed callers and the migrated registry', () => {
    const def = SYSTEM_ACTION_REGISTRY.find(d => d.id === 'system.actions.list')!;
    expect(def.input_schema).toBe(OPERATION_SCHEMA_TABLE['system.actions.list'].input);
    expect(def.output_schema).toBe(OPERATION_SCHEMA_TABLE['system.actions.list'].output);
    expect(def.execution).toEqual({
      kind: 'query',
      tx: 'core_owned'
    });
    expect(def.idempotency_required).toBe(false);
  });
  it('keeps retryable conflicts distinct from pending approval and rejects unregistered error codes', () => {
    const error = {
      error: {
        code: 'idempotency_in_progress',
        domain: 'operations',
        message: 'in progress',
        metadata: {},
        retryable: true,
        request_id: 'current'
      }
    };
    expect(OperationErrorSchema.parse(error)).toEqual(error);
    expect(OperationErrorSchema.safeParse({
      error: {
        ...error.error,
        code: 'arbitrary_exception'
      }
    }).success).toBe(false);
    expect(OperationErrorSchema.safeParse({
      status: 'pending_approval',
      proposal_id: 'p'
    }).success).toBe(false);
  });
  it('rejects unknown actor origin and caller-controlled extra authority fields', () => {
    const actor = {
      principal: {
        kind: 'user',
        id: 'u'
      },
      on_behalf_of_user_id: 'u',
      agent_id: null,
      run_id: null,
      origin: 'manual',
      effective_origin: 'manual',
      root_run_id: null,
      continuation_hops: 0,
      surface: 'public_api',
      space_id: 's'
    };
    expect(OperationActorSchema.parse(actor)).toEqual(actor);
    expect(OperationActorSchema.safeParse({
      ...actor,
      origin: 'unknown'
    }).success).toBe(false);
    expect(OperationActorSchema.safeParse({
      ...actor,
      approved_by_user: true
    }).success).toBe(false);
  });
});

it('keeps grant commands human-only with strict shared schemas and nullable defaults', () => {
  for (const id of ['policy.action_grant.create','policy.action_grant.revoke'] as const) {
    const definition = SYSTEM_ACTION_REGISTRY.find(d => d.id === id)!;
    expect(definition.allowed_actor_types).toEqual(['user']);
    expect(definition.visibility.has('agent_tool')).toBe(false);
    expect(definition.grantable).toBe(false);
    expect(definition.input_schema).toBe(OPERATION_SCHEMA_TABLE[id].input);
    expect(definition.output_schema).toBe(OPERATION_SCHEMA_TABLE[id].output);
  }
  const schema = OPERATION_SCHEMA_TABLE['policy.action_grant.create'].input;
  const input = {agent_id:'agent',action_id:'project.source.propose_bind'};
  expect(schema.parse(input)).toEqual({...input,project_id:null,target_run_id:null,resource_kind:null,resource_id:null,max_uses:null,expires_at:null});
  for (const extra of [{max_uses:'1'},{max_uses:0},{max_uses:2147483648},{approved_by_user:true},{expires_at:'tomorrow'}]) {
    expect(schema.safeParse({...input,...extra}).success).toBe(false);
  }
});

it('keeps Project operation drafts strict and leaves managed orchestration state internal',()=>{
  const create=OPERATION_SCHEMA_TABLE['project.operation.create'].input;
  const input={project_id:'project',kind:'custom',title:' Draft ',steps:[{title:' Prepare '}]};
  expect(create.parse(input)).toEqual({...input,title:'Draft',intent_text:null,initiating_run_id:null,plan_artifact_id:null,steps:[{title:'Prepare',detail:{}}]});
  for(const kind of ['custom','source_setup','source_backfill']) expect(create.parse({...input,kind}).kind).toBe(kind);
  expect(create.parse({...input,initiating_run_id:'run',plan_artifact_id:'artifact'})).toMatchObject({initiating_run_id:'run',plan_artifact_id:'artifact'});
  for(const extra of [{kind:'research'},{progress:{projection_mode:'managed'}},{space_id:'other'}])
    expect(create.safeParse({...input,...extra}).success).toBe(false);
  for(const id of ['project.operation.create','project.operation.cancel'] as const) {
    const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
    expect(definition.input_schema).toBe(OPERATION_SCHEMA_TABLE[id].input);
    expect(definition.output_schema).toBe(OPERATION_SCHEMA_TABLE[id].output);
    expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.visibility.has('agent_tool')).toBe(false);
  }
  expect(OPERATION_SCHEMA_TABLE['project.operation.cancel'].input.safeParse({project_id:'p',operation_id:'o',reason:'override'}).success).toBe(false);
});

it('shares strict Board operation schemas with Agent metadata and typed callers',()=>{
 for(const id of ['board.configure','task.move_to_column'] as const){
  const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
  expect(definition.input_schema).toBe(OPERATION_SCHEMA_TABLE[id].input);expect(definition.output_schema).toBe(OPERATION_SCHEMA_TABLE[id].output);
  expect(definition.allowed_actor_types).toEqual(['user','agent']);expect(definition.visibility.has('agent_tool')).toBe(true);
 }
 const move=OPERATION_SCHEMA_TABLE['task.move_to_column'].input;
 expect(move.parse({task_id:'task',column_key:'column',columns_revision:'revision'})).toMatchObject({reason:null,override_completion:null});
 expect(move.safeParse({task_id:'task',column_key:'column',columns_revision:'revision',actor_id:'pretend-owner'}).success).toBe(false);
 expect(move.safeParse({task_id:'task',column_key:'column'}).success).toBe(false);
});

it('keeps Task lifecycle inputs strict and command semantics distinct',()=>{
 const input=(id:keyof typeof OPERATION_SCHEMA_TABLE)=>OPERATION_SCHEMA_TABLE[id].input;
 expect(input('task.set_status').parse({task_id:'task',status:'done'})).toMatchObject({reason:null,override_completion:null});
 expect(input('task.set_status').safeParse({task_id:'task',status:'act'}).success).toBe(false);
 expect(input('task.delete').parse({task_id:'task'})).toEqual({task_id:'task',reason:null});
 expect(input('task.report').parse({task_id:'task',summary:'Progress'})).toMatchObject({outcome:'progress',refs:[]});
 expect(input('task.report').safeParse({task_id:'task',summary:'Progress',refs:[{type:'note',id:'n',secret:true}]}).success).toBe(false);
 expect(input('task.handoff').safeParse({task_id:'task',to:null}).success).toBe(true);
 expect(input('task.complete').safeParse({task_id:'task',summary:'Done',override_completion:{acknowledged:['file']}}).success).toBe(false);
});

it('binds Source planning/control to strict human-only contracts without changing proposal grants',()=>{
  for(const id of ['source.backfill.preview','source.backfill.create_plan','source.backfill.pause','source.backfill.resume'] as const){
    const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
    expect(definition.input_schema).toBe(OPERATION_SCHEMA_TABLE[id].input);
    expect(definition.output_schema).toBe(OPERATION_SCHEMA_TABLE[id].output);
    expect(definition.execution).toEqual({kind:id.endsWith('preview')?'query':'command',tx:'core_owned'});
    expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.grantable).toBe(false);
    expect(definition.visibility.has('agent_tool')).toBe(false);
  }
  const create=OPERATION_SCHEMA_TABLE['source.backfill.create_plan'].input;
  expect(create.parse({source_channel_id:'channel',idempotency_key:' domain-key ',strategy:{max_items:'5'}})).toMatchObject({idempotency_key:'domain-key',strategy:{max_items:5,history_mode:'bounded_range',direction:'backward'},project_source_binding_id:null});
  for(const body of [{strategy:{unbounded:true}},{strategy:{direction:'forward'}},{quota_policy:{limit_count:1001}},{idempotency_key:'x'.repeat(257)}])expect(create.safeParse({source_channel_id:'channel',idempotency_key:'domain',...body}).success).toBe(false);
  const proposal=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='source.backfill.propose_start')!;
  expect(proposal.allowed_actor_types).toContain('agent');expect(proposal.execution).toBeUndefined();
});

it('keeps raising a Note as human Inquiry structure with a strict selection and no approval/Agent expansion',()=>{
  const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='note.raise_as_question')!;
  expect(d.allowed_actor_types).toEqual(['user']);expect(d.visibility.has('agent_tool')).toBe(false);
  expect(d.gate_class).toBeNull();expect(d.proposal_type).toBeNull();
  expect(d.input_schema).toBe(OPERATION_SCHEMA_TABLE['note.raise_as_question'].input);
  const input={project_id:'project',note_object_id:'note',statement:'  A question?  '};
  expect(d.input_schema.parse(input)).toMatchObject({statement:'A question?',kind:'question',link_kind:'linked_note',producer_idempotency_key:null});
  for(const extra of [{statement:' '},{kind:'answer'},{visibility:'space_shared'},{run_id:'forged'},{link_kind:'semantic_edge'}])expect(d.input_schema.safeParse({...input,...extra}).success).toBe(false);
});

it('separates human Thread creation from the existing origin-gated Agent tool',()=>{
  const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='inquiry.thread.create')!;
  expect(d.execution).toEqual({kind:'command',tx:'core_owned'});expect(d.allowed_actor_types).toEqual(['user']);
  expect(d.input_schema.safeParse({project_id:'project',kind:'question',statement:'Human question?'}).success).toBe(true);
  expect(d.input_schema.safeParse({project_id:'project',statement:'Missing kind'}).success).toBe(false);
  expect(d.input_schema.safeParse({project_id:'project',kind:'question',statement:'Human question?',created_by_run_id:'forged'}).success).toBe(false);
  const agent=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='inquiry.create_thread')!;expect(agent.allowed_actor_types).toEqual(['agent']);expect(agent.execution).toBeUndefined();
});

it('declares strict human Project Source consumption commands without adding activation authority',()=>{
  for(const id of ['project.source.bind','project.source.update','project.source.unbind','project.source.backfill'] as const){
    const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
    expect(d.allowed_actor_types).toEqual(['user']);expect(d.visibility.has('agent_tool')).toBe(false);expect(d.policy_action).toBe('project.source.bind');
    expect(d.input_schema).toBe(OPERATION_SCHEMA_TABLE[id].input);expect(d.proposal_type).toBeNull();
  }
  expect(OPERATION_SCHEMA_TABLE['project.source.bind'].input.safeParse({project_id:'project',source_channel_id:'channel',standing_comparison_enabled:true}).success).toBe(true);
  expect(OPERATION_SCHEMA_TABLE['project.source.bind'].input.safeParse({project_id:'project',source_channel_id:'channel',status:'active'}).success).toBe(false);
  expect(OPERATION_SCHEMA_TABLE['project.source.update'].input.safeParse({project_id:'project',binding_id:'binding',changes:{project_id:'other'}}).success).toBe(false);
  expect(OPERATION_SCHEMA_TABLE['project.source.update'].input.safeParse({project_id:'project',binding_id:'binding',changes:{status:'paused',extraction_policy:{profile_key:'document'}}}).success).toBe(true);
});

it('keeps Source recommendation/subscription commands personal and human-only',()=>{
  for(const id of ['source.channel.set_subscription','source.recommendation.decide'] as const){
    const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;expect(d.allowed_actor_types).toEqual(['user']);expect(d.visibility.has('agent_tool')).toBe(false);
    expect(d.execution).toEqual({kind:'command',tx:'core_owned'});expect(d.policy_action).toBe('source.subscription.manage');expect(d.grantable).toBe(false);
  }
  const schema=OPERATION_SCHEMA_TABLE['source.channel.set_subscription'].input;
  expect(schema.safeParse({source_channel_id:'channel',status:'muted'}).success).toBe(true);
  for(const body of [{source_channel_id:'channel',status:'pending'},{source_channel_id:'channel',status:'muted',user_id:'another'},{source_channel_id:'channel',status:'muted',consent:{allow:true}}])expect(schema.safeParse(body).success).toBe(false);
});

it('keeps Source draft creation human-only, strict and distinct from activation',()=>{
  const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='source.recipe.create')!;
  expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.grantable).toBe(false);expect(definition.visibility.has('agent_tool')).toBe(false);expect(definition.side_effects).toBe('draft');
  const schema=OPERATION_SCHEMA_TABLE['source.recipe.create'].input;
  expect(schema.safeParse({name:'Feed',endpoint_url:'https://example.test/feed',project_id:'project',source_type:'web_list'}).success).toBe(true);
  for(const extra of [{space_id:'other'},{owner_user_id:'other'},{status:'active'},{_force_create:true}])expect(schema.safeParse({name:'Feed',endpoint_url:'https://example.test/feed',...extra}).success).toBe(false);
});

it('keeps Monitor commands user-only and separates durable scan enqueue from activation',()=>{
  for(const id of ['source.channel.update','source.channel.scan']){const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;expect(d.allowed_actor_types).toEqual(['user']);expect(d.visibility.has('agent_tool')).toBe(false);expect(d.grantable).toBe(false);expect(d.proposal_type).toBeNull();}
  const schema=OPERATION_SCHEMA_TABLE['source.channel.update'].input;
  expect(schema.safeParse({source_channel_id:'channel',changes:{name:'Morning',status:'paused'}}).success).toBe(true);
  for(const changes of [{},{space_id:'other'},{capture_policy:'archive_original'},{created_by_user_id:'other'}])expect(schema.safeParse({source_channel_id:'channel',changes}).success).toBe(false);
  expect(OPERATION_SCHEMA_TABLE['source.channel.scan'].input.safeParse({source_channel_id:'channel',force:true}).success).toBe(false);
});

it('keeps public Monitor creation strict, user-only and ungrantable',()=>{
 const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='source.channel.create')!;
 expect(d.allowed_actor_types).toEqual(['user']);expect(d.grantable).toBe(false);expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
 expect(d.input_schema.safeParse({provider_key:'arxiv',query:{search_query:'cat:cs.AI'},_force_create:true}).success).toBe(false);
 expect(d.input_schema.safeParse({provider_key:'arxiv',query:{search_query:'cat:cs.AI'},consent:{allow_external_model_egress:false}}).success).toBe(true);
});

it('keeps Source rule/extraction dispatch strictly user-only with explicit enqueue receipts',()=>{
 for(const id of ['source.processing.rule.create','source.processing.rule.update','source.processing.rule.dispatch','source.extraction.dispatch'] as const){
  const d=SYSTEM_ACTION_REGISTRY.find(x=>x.id===id)!;expect(d.allowed_actor_types).toEqual(['user']);expect(d.visibility.has('agent_tool')).toBe(false);expect(d.grantable).toBe(false);expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
 }
 const schema=OPERATION_SCHEMA_TABLE['source.processing.rule.create'].input;
 expect(schema.safeParse({source_channel_id:'c',rule:{_force_create:true}}).success).toBe(false);
 expect(OPERATION_SCHEMA_TABLE['source.extraction.dispatch'].input.safeParse({extraction_job_id:'j',user_id:'forged'}).success).toBe(false);
 expect(OPERATION_SCHEMA_TABLE['source.processing.rule.dispatch'].output.safeParse({job_id:'j',status:'pending',source_channel_id:'c',extraction_job_id:null,extraction_status:null}).success).toBe(true);
});
