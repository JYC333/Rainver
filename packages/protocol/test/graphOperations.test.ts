import {expect,it} from 'vitest';
import {GRAPH_OPERATION_SCHEMAS} from '../src/graphOperations.js';
import {SYSTEM_ACTION_REGISTRY} from '../src/systemActions.js';
it('keeps graph state human-only and rejects caller attribution at its strict boundary',()=>{
 const schema=GRAPH_OPERATION_SCHEMAS['graph.view_state.save'].input;
 expect(schema.parse({scope_key:'core:graph'})).toEqual({scope_key:'core:graph',state_json:{}});
 for(const input of [{scope_key:''},{scope_key:'core:graph',user_id:'person'},{scope_key:'core:graph',state_json:[]}])expect(schema.safeParse(input).success).toBe(false);
 const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='graph.view_state.save')!;
 expect(d.allowed_actor_types).toEqual(['user']);expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
});
