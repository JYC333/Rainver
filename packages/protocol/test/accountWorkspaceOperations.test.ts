import {describe,expect,it} from 'vitest';
import {ACCOUNT_OPERATION_SCHEMAS,DAEMON_WORKSPACE_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';

describe('account and daemon workspace operation contracts',()=>{
 it('registers four strict keyed public commands with distinct trusted actor types',()=>{
  for(const [id,schema] of Object.entries({...ACCOUNT_OPERATION_SCHEMAS,...DAEMON_WORKSPACE_OPERATION_SCHEMAS})){
   const registration=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
   expect(registration.execution).toEqual({kind:'command',tx:'core_owned'});
   expect(registration.idempotency_required).toBe(true);expect(registration.grantable).toBe(false);
   expect([...registration.visibility]).toEqual(['public_api']);
   expect(registration.allowed_actor_types).toEqual([id.startsWith('auth.')?'user':'system']);
   const input=id.startsWith('auth.')?{user_id:'u'}:id.endsWith('remove')?{location_id:'l'}:{project_id:'p',name:' Repo '};
   expect(schema.input.safeParse(input).success).toBe(true);
   expect(schema.input.safeParse({...input,space_id:'untrusted'}).success).toBe(false);
   expect(schema.output.safeParse({ok:true}).success).toBe(false);
  }
 });
 it('refuses an empty workspace name and host-local root paths',()=>{
  const schema=DAEMON_WORKSPACE_OPERATION_SCHEMAS['host.workspace.create'].input;
  expect(schema.safeParse({project_id:'p',name:'   '}).success).toBe(false);
  expect(schema.safeParse({project_id:'p',name:'Repo',root_path:'/private'}).success).toBe(false);
 });
});
