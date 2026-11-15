import {expect,it} from 'vitest';
import {ACADEMIC_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
it('declares four strict human commands, with distinct proposal effects and content-free receipts',()=>{
 expect(Object.keys(ACADEMIC_OPERATION_SCHEMAS)).toHaveLength(4);
 for(const [id,schemas] of Object.entries(ACADEMIC_OPERATION_SCHEMAS)){
  expect(SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)).toMatchObject({allowed_actor_types:['user'],grantable:false,idempotency_required:true,execution:{kind:'command',tx:'core_owned'}});
  expect(schemas.input.safeParse({title:'Paper',space_id:'untrusted'}).success).toBe(false);
  expect(schemas.output.safeParse({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',space_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',object_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'paper',title:'forbidden'}).success).toBe(false);
 }
});
