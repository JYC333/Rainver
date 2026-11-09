import {expect,it} from 'vitest';
import {INQUIRY_OPERATION_SCHEMAS} from '../src/inquiryOperations.js';
it('retains personal reader focus while rejecting injected actor/scope and unsupported cognitive definition fields',()=>{
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.personal_focus.set'].input.parse({project_id:'project',thread_id:'thread'}).in_focus).toBe(true);
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.personal_focus.set'].input.safeParse({project_id:'project',thread_id:'thread',user_id:'other'}).success).toBe(false);
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.candidate.decide'].input.safeParse({project_id:'project',candidate_id:'candidate',decision:'accept',edits:{resolution_criteria:'definition change'}}).success).toBe(false);
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.definition.revise'].input.safeParse({project_id:'project',thread_id:'thread',revision_kind:'wording_only',new_statement:'Text',new_scope_boundary:'Widened'}).success).toBe(false);
});
it('uses existing bounded problem/task contracts and explicit candidate decision details',()=>{
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.task.link'].input.safeParse({project_id:'project',thread_id:'thread',task_id:'task',task:{title:'Another'},role:'investigates',reason:'Work',idempotency_key:'domain'}).success).toBe(false);
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.candidate.decide'].input.safeParse({project_id:'project',candidate_id:'candidate',decision:'merge'}).success).toBe(false);
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.problem.record_work'].input.safeParse({project_id:'project',thread_id:'thread',method_version:'problem_solving.v1',expected_version:1,expected_revision:0,idempotency_key:'domain',stage:'frame',work_kind:'select_method',selection_kind:'skip',reason:'Skip'}).success).toBe(false);
 expect(INQUIRY_OPERATION_SCHEMAS['inquiry.review_packet.open'].output.safeParse({project_id:'project',space_id:'space',id:null,candidates:[]}).success).toBe(false);
});
it('retains original Agent IDs while separating model problem keys from host-authored Task call identity',async()=>{
 const {INQUIRY_AGENT_OPERATION_SCHEMAS:agent}=await import('../src/inquiryAgentOperations.js');
 const task={thread_id:'thread',task:{title:'Repair'},role:'investigates',reason:'Requested work'};
 expect(agent['inquiry.link_task'].input.safeParse(task).success).toBe(true);
 expect(agent['inquiry.link_task'].input.safeParse({...task,idempotency_key:'model-chosen'}).success).toBe(false);
 expect(agent['inquiry.link_task'].input.safeParse({...task,project_id:'other-project'}).success).toBe(false);
 const conclusion={thread_id:'thread',method_version:'problem_solving.v1',expected_version:1,expected_revision:0,idempotency_key:'problem-domain-key',round_intent:'close_round',change_summary:'Unchanged evidence'};
 expect(agent['inquiry.record_conclusion'].input.safeParse(conclusion).success).toBe(true);
 expect(agent['inquiry.record_conclusion'].input.safeParse({...conclusion,user_id:'other'}).success).toBe(false);
});
