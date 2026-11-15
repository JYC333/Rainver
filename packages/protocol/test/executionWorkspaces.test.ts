import {expect,expectTypeOf,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ExecutionWorkspaceRefSchema,HostServerFrameSchema,HostDaemonFrameSchema,WorkspaceChangeCompleteInputSchema,WorkspaceIntegrationRetryInputSchema,WorkspaceIntegrationNoticeSchema} from '../src/index.js';
it('rejects caller paths, unsafe generations and extra authority',()=>{
 const ref={id:randomUUID(),generation:1};
 expect(ExecutionWorkspaceRefSchema.parse(ref)).toEqual(ref);
 for(const extra of [{path:'/tmp/other'},{generation:0},{id:'../../escape'},{generation:1.5}])expect(ExecutionWorkspaceRefSchema.safeParse({...ref,...extra}).success).toBe(false);
 expect(WorkspaceChangeCompleteInputSchema.safeParse({change_set_id:'c',expected_revision:1,summary:'done',space_id:'foreign'}).success).toBe(false);
 const frame={type:'execution_workspace_command',request_id:'r',operation_id:randomUUID(),action:'inspect',workspace:{kind:'location',workspace_location_id:'l',execution_workspace:ref}};
 expect(HostServerFrameSchema.parse(frame)).toMatchObject({action:'inspect',retain_branch:true});
 expect(HostServerFrameSchema.parse({...frame,action:'checkpoint',launch_sequence:3})).toMatchObject({launch_sequence:3});
 expect(HostServerFrameSchema.safeParse({...frame,launch_sequence:0}).success).toBe(false);
 expect(HostDaemonFrameSchema.safeParse({type:'execution_workspace_result',request_id:'r',ok:true,branch:'b',commit:null,error:null,cleanup_state:'cleaned'}).success).toBe(true);
 const proof={type:'execution_workspace_result',request_id:'r',ok:true,branch:'b',commit:'a'.repeat(40),unchanged_commit:'a'.repeat(40),error:null};
 expect(HostDaemonFrameSchema.parse(proof)).toMatchObject({unchanged_commit:'a'.repeat(40)});
 expect(HostDaemonFrameSchema.safeParse({...proof,unchanged_commit:'unknown'}).success).toBe(false);
});
it('keeps integration progress bounded and excludes raw instructions and Host paths from the notice contract',()=>{
 const notice={schema_version:'workspace_integration_notice.v1',run_id:'run',integration_id:'integration',attempt_id:'attempt',change_set_id:'change',target_ref:'refs/heads/dev',outcome:'verification_failed',reason:'verification_unconfigured',repair_status:'succeeded',verification_status:'unconfigured',checks_passed:0,checks_failed:0,candidate_ready:true,preserved:true};
 expect(WorkspaceIntegrationNoticeSchema.safeParse(notice).success).toBe(true);
 for(const extra of [{repair_instruction:'private'},{host_path:'/private/repo'},{checks_passed:-1},{target_ref:'x'.repeat(257)}])expect(WorkspaceIntegrationNoticeSchema.safeParse({...notice,...extra}).success).toBe(false);
});
it('accepts a bounded explicit conflict instruction without caller-supplied decision authority',()=>{
 const retry={integration_id:'integration',expected_revision:2};
 expect(WorkspaceIntegrationRetryInputSchema.parse(retry)).toEqual(retry);
 expect(WorkspaceIntegrationRetryInputSchema.parse({...retry,resolution:' Keep the target version. '})).toMatchObject({resolution:'Keep the target version.'});
 for(const resolution of [' ', 'x'.repeat(4001)])expect(WorkspaceIntegrationRetryInputSchema.safeParse({...retry,resolution}).success).toBe(false);
 expect(WorkspaceIntegrationRetryInputSchema.safeParse({...retry,resolution:'keep',user_id:'other'}).success).toBe(false);
 const frame={type:'workspace_integration',request_id:'repair',action:'repair',repair_mode:'user_resolution',workspace:{kind:'location',workspace_location_id:'location',execution_workspace:{id:randomUUID(),generation:1,integration_id:randomUUID()}},source_commit:'a'.repeat(40),base_commit:'b'.repeat(40),target_ref:'refs/heads/dev',author:{name:'Agent',email:'agent@example.test'},message:'Resolve approved conflict'};
 expect(HostServerFrameSchema.parse(frame)).toMatchObject({repair_mode:'user_resolution'});
 expect(HostServerFrameSchema.parse({...frame,repair_mode:'agent_resolution'})).toMatchObject({repair_mode:'agent_resolution'});
 expect(WorkspaceIntegrationRetryInputSchema.parse({...retry,repair_instruction:' Fix the candidate. '})).toMatchObject({repair_instruction:'Fix the candidate.'});
 for(const repair_instruction of ['', ' ', 'x'.repeat(4001)])expect(WorkspaceIntegrationRetryInputSchema.safeParse({...retry,repair_instruction}).success).toBe(false);
 expect(WorkspaceIntegrationRetryInputSchema.safeParse({...retry,repair_instruction:'fix',resolution:'keep'}).success).toBe(false);
 expect(WorkspaceIntegrationRetryInputSchema.safeParse({...retry,repair_instruction:'fix',run_id:'forged'}).success).toBe(false);
});

it('requires bounded real commands and an observed configuration version without accepting caller Folder authority',async()=>{
 const {WorkspaceVerificationConfigureInputSchema:s,OPERATION_SCHEMA_TABLE}=await import('../src/index.js');
 const input={integration_id:'integration',expected_config_version:null,test_commands:['pnpm test'],build_commands:[]};
 expect(s.safeParse(input).success).toBe(true);
 for(const extra of [{folder_id:'foreign'},{test_commands:[],build_commands:[]},{test_commands:['']},{test_commands:['pnpm test\npnpm build']},{test_commands:['a'.repeat(4001)]},{expected_config_version:'wrong'},{expected_config_version:undefined}])expect(s.safeParse({...input,...extra}).success).toBe(false);
 expect(OPERATION_SCHEMA_TABLE['workspace.integration.verification.get']).toBeDefined();expect(OPERATION_SCHEMA_TABLE['workspace.integration.verification.configure']).toBeDefined();
});

// Workspace publication recovery acceptance.
it('accepts only explicit complete commit IDs and keeps adoption checks distinct from repair requests',()=>{
 const complete={change_set_id:'change',expected_revision:1,summary:'Publish reviewed commit'};
 expect(WorkspaceChangeCompleteInputSchema.parse({...complete,commit:'d'.repeat(40)})).toHaveProperty('commit','d'.repeat(40));
 for(const commit of ['HEAD','aa45cf74','../escape','a'.repeat(41)])expect(WorkspaceChangeCompleteInputSchema.safeParse({...complete,commit}).success).toBe(false);
 const retry={integration_id:'integration',expected_revision:1,reconcile_only:true};
 expect(WorkspaceIntegrationRetryInputSchema.parse(retry)).toMatchObject({reconcile_only:true});
 expect(WorkspaceIntegrationRetryInputSchema.safeParse({...retry,repair_instruction:'Change target'}).success).toBe(false);
 expect(WorkspaceIntegrationRetryInputSchema.safeParse({...retry,resolution:'Keep source'}).success).toBe(false);
});

// Agent verification setup acceptance.
it('requires an explicit inspected reason for basic checks and distinguishes them in notices',async()=>{
 const {WorkspaceVerificationConfigureInputSchema:s}=await import('../src/index.js');
 const basic={integration_id:'integration',expected_config_version:null,test_commands:[],build_commands:[],no_project_checks:true,note:'Inspected README and manifests; no project checks exist.'};
 expect(s.safeParse(basic).success).toBe(true);
 for(const extra of [{note:undefined},{note:' '},{note:'x'.repeat(2001)},{test_commands:['true']},{no_project_checks:false}])expect(s.safeParse({...basic,...extra}).success).toBe(false);
});

it('binds reviewed withdrawal to an exact saved commit and keeps caller proof/authority out',async()=>{
 const {WorkspaceChangeAbandonInputSchema:s}=await import('../src/index.js');
 const plain={change_set_id:'change',expected_revision:2,reason:'Obsolete iteration'};
 expect(s.parse(plain)).toEqual(plain);
 const review={source_commit:'a'.repeat(40),user_request_quote:'检查后关闭旧工作区',findings:'Reviewed superseded iteration; retain source.'};
 expect(s.parse({...plain,review})).toEqual({...plain,review});
 for(const extra of [{source_commit:'HEAD'},{user_request_quote:' '},{findings:''},{approved:true},{adoption_proven:true},{user_id:'forged'}])expect(s.safeParse({...plain,review:{...review,...extra}}).success).toBe(false);
});

it('preserves exact lifecycle types and strict validation through the operation registry',async()=>{
 const {WorkspaceLifecycleSchema,WorkspaceChangeReceiptSchema}=await import('../src/index.js');
 type Lifecycle=import('../src/index.js').WorkspaceLifecycle;
 type Output=import('../src/index.js').OperationOutput<'workspace.change.complete'>;
 expectTypeOf<Output['lifecycle']>().toEqualTypeOf<Lifecycle|null|undefined>();
 expectTypeOf<Lifecycle['phase']>().toEqualTypeOf<'awaiting_release'|'cleanup'|'blocked'|'complete'>();
 const lifecycle:Lifecycle={operation_id:'op',phase:'cleanup',workspace_id:'workspace',generation:1,base_commit:null,source_commit:null,target_ref:null,landed_commit:null,publication_status:'merged',cleanup_key:'source-g1'};
 expect(WorkspaceChangeReceiptSchema.parse({change_set_id:'change',revision:1,state:'integrated',integration_id:null,lifecycle}).lifecycle).toEqual(lifecycle);
 expect(WorkspaceLifecycleSchema.safeParse({...lifecycle,phase:'unknown'}).success).toBe(false);
 expect(WorkspaceLifecycleSchema.safeParse({...lifecycle,unexpected:true}).success).toBe(false);
});

it('exposes bounded obligation recovery with revision fencing and path-free diagnostics',async()=>{
 const {SYSTEM_ACTION_REGISTRY,WorkspaceRetentionUpdateInputSchema,WorkspaceChangeStatusSchema}=await import('../src/index.js');
 const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='workspace.retention.update')!;
 expect(definition.visibility.has('agent_tool')).toBe(true);
 expect(definition.allowed_actor_types).toEqual(['user','agent']);
 expect(WorkspaceRetentionUpdateInputSchema.safeParse({change_set_id:'change',action:'recover'}).success).toBe(false);
 expect(WorkspaceRetentionUpdateInputSchema.parse({change_set_id:'change',expected_revision:3,action:'recover'})).toMatchObject({action:'recover',expected_revision:3});
 expect(WorkspaceChangeStatusSchema.safeParse({
  change_set_id:'change',revision:3,state:'abandoned',integration_id:null,can_retry:false,integration_status:null,
  conversation_id:null,room_id:null,agent_id:null,folder_name:'Repo',source_commit:null,
  actions:[{operation:'workspace.retention.update',action:'recover',available:true,blocker:null,guidance:'Recover existing obligations',requirements:[]}],
  diagnostics:[{kind:'checkpoint',state:'pending',reason:'workspace_source_unconfirmed',next_retry_at:null,attempts:0,recovery_action:'workspace.retention.update',guidance:'Preserve unknown content'}],
 }).success).toBe(true);
});
