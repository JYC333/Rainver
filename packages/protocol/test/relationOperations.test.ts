import {describe,it,expect} from 'vitest';
import {RELATION_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
describe('Relations operation contracts',()=>{
 it('keeps all ten commands human-only, keyed and strict without an approval mapping',()=>{
  expect(Object.keys(RELATION_OPERATION_SCHEMAS)).toHaveLength(10);
  for(const [id,s] of Object.entries(RELATION_OPERATION_SCHEMAS)){
   const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
   expect(d).toMatchObject({allowed_actor_types:['user'],grantable:false,idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
   expect([...d.visibility]).toEqual(['public_api']);
   expect(s.input.safeParse({title:'x',project_id:null,unexpected:true}).success).toBe(false);
  }
 });
 it('requires exactly one source pointer matching the declared source kind',()=>{
  const object_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const schema=RELATION_OPERATION_SCHEMAS['relation.source_link.create'].input;
  expect(schema.safeParse({object_id,link_type:'external',external_ref:'https://example.test'}).success).toBe(true);
  expect(schema.safeParse({object_id,link_type:'source_item',external_ref:'https://example.test'}).success).toBe(false);
  expect(schema.safeParse({object_id,link_type:'external',external_ref:'https://example.test',activity_id:object_id}).success).toBe(false);
 });
});
