import {describe,it,expect} from 'vitest';
import {READER_OPERATION_SCHEMAS,READER_JOB_OPERATIONS,ReaderWriteReceiptSchema,ReaderWriteJobResultSchema,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
const annotation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('Reader operation contracts',()=>{
 it('keeps all thirteen commands human-only, keyed, strict and core-owned without an approval mapping',()=>{
  expect(Object.keys(READER_OPERATION_SCHEMAS)).toHaveLength(13);
  for(const [id,s] of Object.entries(READER_OPERATION_SCHEMAS)){
   const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
   expect(d,id).toMatchObject({owning_module:'reader',allowed_actor_types:['user'],grantable:false,idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
   expect([...d.visibility]).toEqual(['public_api']);
   expect(s.input.safeParse({annotation_id,unexpected:true}).success,id).toBe(false);
  }
 });
 it('registers the two annotation proposal kinds as separate proposal operations',()=>{
  const memory=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='reader.memory.propose')!,knowledge=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='reader.knowledge.propose')!;
  expect(memory).toMatchObject({side_effects:'proposal',policy_action:'proposal.create',proposal_type:'memory_create',gate_class:'belief_reach'});
  expect(knowledge).toMatchObject({side_effects:'proposal',policy_action:'proposal.create',proposal_type:'knowledge_create',gate_class:'exposure'});
  expect(READER_OPERATION_SCHEMAS['reader.memory.propose'].input.safeParse({annotation_id,proposal_type:'knowledge_create'}).success).toBe(false);
  expect(READER_OPERATION_SCHEMAS['reader.knowledge.propose'].input.safeParse({annotation_id,proposal_type:'other'}).success).toBe(false);
  for(const id of Object.keys(READER_OPERATION_SCHEMAS).filter(id=>!id.includes('.propose')))expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)).toMatchObject({policy_action:'reader.write',proposal_type:null,gate_class:null});
 });
 it('returns identity-only receipts and status-only Job results',()=>{
  expect(ReaderWriteReceiptSchema.safeParse({id:'x',space_id:'s',document_type:null,document_id:null,annotation_id:null,kind:'appearance',quote_text:'body'}).success).toBe(false);
  expect(ReaderWriteJobResultSchema.safeParse({outcome:'applied',annotation_id:null,position:{}}).success).toBe(false);
  expect([...READER_JOB_OPERATIONS]).toEqual(['reader.position.write','reader.annotation.range.replace']);
 });
});
