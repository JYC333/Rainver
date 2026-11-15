import {expect,it} from 'vitest';
import {ACTIVITY_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
for(const id of ['activity.review','activity.archive','activity.consolidate','daily_capture.settings.patch','daily_capture.settings.set'] as const)it(`${id} is strict, explicit-keyed and human-only`,()=>{
 const schema=ACTIVITY_OPERATION_SCHEMAS[id].input,input=id.startsWith('activity.')?{activity_id:'record'}:{enabled:true,create_memory_proposals:false};
 expect(schema.parse(input)).toEqual(input);
 expect(()=>schema.parse({...input,user_id:'other'})).toThrow();
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)).toMatchObject({allowed_actor_types:['user'],side_effects:'durable',idempotency_required:true,proposal_type:null,policy_action:id,execution:{kind:'command',tx:'core_owned'}});
});
it('keeps the capture destination explicit and rejects authority fields',()=>{
 const schema=ACTIVITY_OPERATION_SCHEMAS['capture.create'].input;
 expect(schema.parse({text:' hello ',destination:'personal_inbox'})).toEqual({text:'hello',destination:'personal_inbox'});
 expect(()=>schema.parse({text:'hello',destination:'personal_inbox',user_id:'other'})).toThrow();
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='capture.create')).toMatchObject({allowed_actor_types:['user'],side_effects:'durable',idempotency_required:true,proposal_type:null,execution:{kind:'command',tx:'core_owned'}});
});
it('preserves legal user and Agent provenance fields on raw ingest without granting actor authority',()=>{
 const input={source_type:'agent_run',content:'Observation',user_id:'person',agent_id:'agent',source_run_id:'run',source_task_id:'task',source_session_id:'session',project_id:'project',project_folder_id:'folder'};
 expect(ACTIVITY_OPERATION_SCHEMAS['activity.create'].input.parse(input)).toEqual(input);
 expect(()=>ACTIVITY_OPERATION_SCHEMAS['activity.create'].input.parse({...input,origin:'autonomous'})).toThrow();
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='activity.create')).toMatchObject({allowed_actor_types:['user'],idempotency_required:true});
});
it('declares summary as a keyed queued command with only an intent receipt',()=>{
 const input={activity_ids:['activity'],evidence_ids:['evidence'],source_item_ids:['item'],create_memory_proposal:true};
 expect(ACTIVITY_OPERATION_SCHEMAS['activity.summary.request'].input.parse(input)).toEqual(input);
 expect(()=>ACTIVITY_OPERATION_SCHEMAS['activity.summary.request'].input.parse({...input,worker_id:'forged'})).toThrow();
 expect(ACTIVITY_OPERATION_SCHEMAS['activity.summary.request'].output.parse({job_id:'job',user_id:'person'})).toEqual({job_id:'job',user_id:'person'});
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='activity.summary.request')).toMatchObject({allowed_actor_types:['user'],idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
});
it('keeps relocation selection explicit and its host key outside the strict DTO',()=>{
 const input={activity_id:'capture',destination:'personal_inbox',mode:'copy',block_ids:['block']};
 expect(ACTIVITY_OPERATION_SCHEMAS['capture.relocate'].input.parse(input)).toEqual(input);
 expect(()=>ACTIVITY_OPERATION_SCHEMAS['capture.relocate'].input.parse({...input,idempotencyKey:'forged'})).toThrow();
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='capture.relocate')).toMatchObject({allowed_actor_types:['user'],idempotency_required:true,proposal_type:null});
});
it('daily report accepts only business overrides and returns a keyed intent rather than a fabricated result',()=>{
 const schema=ACTIVITY_OPERATION_SCHEMAS['daily_capture.run'];
 expect(schema.input.parse({local_date:'2026-09-12',create_memory_proposals:false})).toEqual({local_date:'2026-09-12',create_memory_proposals:false});
 for(const field of ['worker_id','run_id','snapshot','user_id','attempts'])expect(()=>schema.input.parse({[field]:'forged'})).toThrow();
 expect(schema.output.parse({run_id:'run',job_id:'job',user_id:'person',status:'queued'})).toMatchObject({status:'queued'});
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='daily_capture.run')).toMatchObject({allowed_actor_types:['user'],idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
});
it('bounds upload bytes, refuses client storage authority and returns only a queued intent',()=>{
 const contract=ACTIVITY_OPERATION_SCHEMAS['activity.upload'],input={kind:'voice',filename:'memo.webm',content_type:'audio/webm',content_base64:'aGVsbG8='};
 expect(contract.input.parse(input)).toEqual(input);
 for(const extra of [{stored_path:'forged'},{user_id:'other'},{worker_id:'forged'},{unknown:'field'}])expect(()=>contract.input.parse({...input,...extra})).toThrow();
 expect(()=>contract.input.parse({...input,content_base64:'invalid*'})).toThrow();
 expect(()=>contract.input.parse({...input,content_base64:'A'.repeat(Math.ceil(25*1024*1024/3)*4+4)})).toThrow();
 expect(contract.output.parse({job_id:'job',activity_id:'activity',status:'queued'})).toEqual({job_id:'job',activity_id:'activity',status:'queued'});
 expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id==='activity.upload')).toMatchObject({allowed_actor_types:['user'],idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
});
