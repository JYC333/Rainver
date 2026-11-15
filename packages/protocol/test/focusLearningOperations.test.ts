import {expect,it} from 'vitest';
import {FOCUS_OPERATION_SCHEMAS} from '../src/focusOperations.js';
import {LEARNING_OPERATION_SCHEMAS} from '../src/learningOperations.js';
import {SYSTEM_ACTION_REGISTRY} from '../src/systemActions.js';
it('preserves explicit classification clearing and refuses omitted or forged attribution',()=>{
 const schema=FOCUS_OPERATION_SCHEMAS['focus_area.object.set'].input;
 expect(schema.parse({object_id:'object',focus_area_id:null}).focus_area_id).toBeNull();
 for(const input of [{object_id:'object'},{object_id:'object',focus_area_id:null,owner_user_id:'person'}])expect(schema.safeParse(input).success).toBe(false);
 expect(FOCUS_OPERATION_SCHEMAS['focus_area.update'].input.safeParse({focus_area_id:'area'}).success).toBe(false);
});
it('limits learning outcomes and uses server-derived Knowledge version and person',()=>{
 const schema=LEARNING_OPERATION_SCHEMAS['learning.item.create'].input,input={knowledge_item_id:'knowledge',prompt:'Q',answer:'A'};
 expect(schema.parse(input).item_kind).toBe('card');
 expect(schema.safeParse({...input,knowledge_item_version:7}).success).toBe(false);
 expect(LEARNING_OPERATION_SCHEMAS['learning.item.review'].input.safeParse({item_id:'item',outcome:'unknown'}).success).toBe(false);
 for(const id of [...Object.keys(FOCUS_OPERATION_SCHEMAS),...Object.keys(LEARNING_OPERATION_SCHEMAS)]){
  const d=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;expect(d.allowed_actor_types).toEqual(['user']);expect(d.execution).toEqual({kind:'command',tx:'core_owned'});
 }
});
