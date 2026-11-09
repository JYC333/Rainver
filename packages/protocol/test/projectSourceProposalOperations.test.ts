import {it,expect} from 'vitest';
import {PROJECT_SOURCE_PROPOSAL_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';

it('preserves the domain backfill key and exposes only a human proposal receipt',()=>{
 const schema=PROJECT_SOURCE_PROPOSAL_SCHEMAS['project.source.propose_backfill'];
 expect(schema.input.parse({project_id:'p',binding_id:'b',idempotency_key:'domain-key'})).toMatchObject({idempotency_key:'domain-key',strategy:{},quota_policy:{}});
 expect(schema.input.safeParse({project_id:'p',binding_id:'b'}).success).toBe(false);
 expect(schema.input.safeParse({project_id:'p',binding_id:'b',idempotency_key:'k',owner_user_id:'forged'}).success).toBe(false);
 const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='project.source.propose_backfill')!;
 expect(definition.allowed_actor_types).toEqual(['user']);
 expect(definition.grantable).toBe(false);
 expect(definition.gate_class).toBe('money');
 expect(definition.visibility.has('agent_tool')).toBe(false);
 expect(schema.output.safeParse({project_id:'p',space_id:'s',binding_id:'b',source_channel_id:'c',operation_id:'o',plan_id:'l',proposal_id:'r',title:'PRIVATE'}).success).toBe(false);
});
