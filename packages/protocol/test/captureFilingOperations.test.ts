import {expect,it} from 'vitest';
import {CAPTURE_FILING_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
it('binds filing to a strict, human-only, ungrantable keyed command',()=>{
 const schema=CAPTURE_FILING_OPERATION_SCHEMAS['capture.file'].input;
 expect(schema.parse({activity_id:'capture',target_project_id:'project'})).toEqual({activity_id:'capture',target_project_id:'project'});
 for(const input of [{activity_id:'capture'},{activity_id:1,target_project_id:'project'},{activity_id:'capture',target_project_id:'project',space_id:'injected'}])expect(schema.safeParse(input).success).toBe(false);
 const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='capture.file')!;
 expect(d.allowed_actor_types).toEqual(['user']);expect(d.grantable).toBe(false);expect(d.idempotency_required).toBe(true);expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
});
