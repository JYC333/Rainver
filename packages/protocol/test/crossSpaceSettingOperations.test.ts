import {expect,it} from 'vitest';
import {CROSS_SPACE_SETTING_OPERATION_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
it('binds the strict egress notification setting to a human-only durable operation',()=>{
 const schema=CROSS_SPACE_SETTING_OPERATION_SCHEMAS['space.egress_notifications.update'].input;
 expect(schema.parse({space_id:'space',egress_notifications_enabled:false})).toEqual({space_id:'space',egress_notifications_enabled:false});
 for(const input of [{egress_notifications_enabled:false},{space_id:'space',egress_notifications_enabled:'false'},{space_id:'space',egress_notifications_enabled:true,user_id:'person'}])expect(schema.safeParse(input).success).toBe(false);
 const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='space.egress_notifications.update')!;
 expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.execution).toEqual({kind:'command',tx:'core_owned'});
 expect(definition.policy_action).toBe('space.settings.update');
});
