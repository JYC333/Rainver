import {describe,it,expect} from 'vitest';
import {KNOWLEDGE_PROPOSAL_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
const uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('Knowledge proposal entry contracts',()=>{
 it('requires keys and explicit contracts on all eight existing human proposal surfaces',()=>{
  expect(Object.keys(KNOWLEDGE_PROPOSAL_SCHEMAS)).toHaveLength(8);
  for(const id of Object.keys(KNOWLEDGE_PROPOSAL_SCHEMAS)){
   const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
   expect(d).toMatchObject({allowed_actor_types:['user'],grantable:false,idempotency_required:true,side_effects:'proposal',gate_class:'exposure',execution:{kind:'command',tx:'core_owned'}});
   expect([...d.visibility]).toEqual(['public_api']);
  }
 });
 it('rejects attributed/system fields and malformed source refs while retaining explicit external provenance',()=>{
  const s=KNOWLEDGE_PROPOSAL_SCHEMAS['knowledge.item.propose_create'].input;
  expect(s.safeParse({title:'Concept',content:'Reviewed',source_refs:[{source_type:'external_source',source_id:'https://example.test'}]}).success).toBe(true);
  for(const extra of [{created_by_user_id:uuid},{operation:'create'},{source_refs:[{source_type:'note'}]},{source_refs:[{source_type:'note',source_id:uuid,script:'x'}]}])expect(s.safeParse({title:'Concept',content:'Reviewed',...extra}).success).toBe(false);
 });
 it('preserves a claim subject, explicit mutation target, and forbids reach changes in updates',()=>{
  const s=KNOWLEDGE_PROPOSAL_SCHEMAS['knowledge.claim.propose_create'].input;
  expect(s.safeParse({claim_text:'A fact',subject_text:'Subject'}).success).toBe(true);
  expect(s.safeParse({claim_text:'No subject'}).success).toBe(false);
  const u=KNOWLEDGE_PROPOSAL_SCHEMAS['knowledge.claim.propose_update'].input;
  expect(u.safeParse({claim_id:uuid,claim_text:'Revision'}).success).toBe(true);
  expect(u.safeParse({claim_id:uuid,visibility:'space_shared'}).success).toBe(false);
 });
});
