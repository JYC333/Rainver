import {describe,expect,it} from 'vitest';
import {SOURCE_GOAL_OPERATION_IDS,SOURCE_GOAL_SCHEMAS,SYSTEM_ACTION_REGISTRY,OPERATION_SCHEMA_TABLE} from '../src/index.js';

describe('Source Goal family operations',()=>{
  it('registers 21 human-only, ungrantable core commands under source.goal.manage',()=>{
    expect(SOURCE_GOAL_OPERATION_IDS).toHaveLength(21);
    for(const id of SOURCE_GOAL_OPERATION_IDS){
      const d=SYSTEM_ACTION_REGISTRY.find(a=>a.id===id)!;
      expect(d,id).toBeDefined();
      expect(d).toMatchObject({policy_action:'source.goal.manage',allowed_actor_types:['user'],grantable:false,execution:{kind:'command',tx:'core_owned'}});
      expect(OPERATION_SCHEMA_TABLE[id as keyof typeof OPERATION_SCHEMA_TABLE]).toBe(SOURCE_GOAL_SCHEMAS[id]);
    }
  });
  it('accepts the retained bodies plus URL targets and nothing else',()=>{
    expect(SOURCE_GOAL_SCHEMAS['source.goal.follow'].input.safeParse({goal_id:'g',idempotency_key:'k',version_id:'v'}).success).toBe(true);
    expect(SOURCE_GOAL_SCHEMAS['source.goal.follow'].input.safeParse({goal_id:'g',idempotency_key:'k',extra:1}).success).toBe(false);
    expect(SOURCE_GOAL_SCHEMAS['source.goal.feedback'].input.safeParse({goal_id:'g',kind:'exclude_term',idempotency_key:'k',term:'ads'}).success).toBe(true);
    expect(SOURCE_GOAL_SCHEMAS['source.goal.feedback'].input.safeParse({kind:'exclude_term',idempotency_key:'k',term:'ads'}).success).toBe(false);
    expect(SOURCE_GOAL_SCHEMAS['source.goal.resume'].input.safeParse({goal_id:'g',version_id:null}).success).toBe(true);
    expect(SOURCE_GOAL_SCHEMAS['source.goal.theme.configure'].input.safeParse({goal_id:'g',expected_version_id:'v',enabled:true}).success).toBe(false);
    expect(SOURCE_GOAL_SCHEMAS['source.goal.setup.message'].input.safeParse({goal_id:'g',content:'x',idempotency_key:'k',agent_id:'a'}).success).toBe(false);
  });
  it('keeps receipts identity-only: a preview receipt carries no result',()=>{
    const receipt=SOURCE_GOAL_SCHEMAS['source.goal.preview.request'].output;
    expect(receipt.safeParse({id:'g',space_id:'s',preview_id:'p',job_id:'j',status:'pending'}).success).toBe(true);
    expect(receipt.safeParse({id:'g',space_id:'s',preview_id:'p',job_id:'j',status:'pending',contributions:[]}).success).toBe(false);
  });
});
