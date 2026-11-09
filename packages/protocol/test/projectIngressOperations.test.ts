import {it,expect} from 'vitest';
import {PROJECT_INGRESS_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
it('keeps confirmed monitoring controls human-only with strict CAS inputs and body-free receipts',()=>{
 for(const id of Object.keys(PROJECT_INGRESS_SCHEMAS) as (keyof typeof PROJECT_INGRESS_SCHEMAS)[]){
  const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;
  expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.grantable).toBe(false);expect(definition.visibility.has('agent_tool')).toBe(false);expect(definition.policy_action).toBe('project.monitoring.configure');expect(definition.execution).toEqual({kind:'command',tx:'core_owned'});
  expect(PROJECT_INGRESS_SCHEMAS[id].output.safeParse({id:'v',project_id:'p',space_id:'s',config:{objective:'private'}}).success).toBe(false);
 }
 expect(PROJECT_INGRESS_SCHEMAS['project.monitoring.state.update'].input.safeParse({project_id:'p',paused:true}).success).toBe(false);
 expect(PROJECT_INGRESS_SCHEMAS['project.monitoring.details.update'].input.safeParse({project_id:'p',expected_version_id:'v',source_channel_id:'another-source'}).success).toBe(false);
});
