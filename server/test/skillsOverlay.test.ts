import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSkillOperationHarness} from './support/skillOperationHarness.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
const db=useTestDatabase(import.meta.filename);
let fixture:Awaited<ReturnType<typeof seedSkillOperationHarness>>;
beforeEach(async()=>{
 fixture=await seedSkillOperationHarness(db.pool,db.connectionUri);
 __setAuthIdentityForTests({spaceId:fixture.space,userId:fixture.owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await fixture?.app.close();});
describe('Skill overlays through their real operation',()=>{
 it('updates the library presentation without changing original bytes or trust',async()=>{
  const before=(await fixture.app.inject({method:'GET',url:'/api/v1/skills/index'})).json();
  const original=(await db.pool.query('SELECT content_base64 FROM skill_package_files WHERE skill_package_id=$1',[fixture.pkg])).rows;
  const response=await fixture.app.inject({method:'PUT',url:`/api/v1/skills/${fixture.pkg}/local-overlay`,headers:{'idempotency-key':randomUUID()},payload:{scope_type:'space',overlay_json:{alias:'alias',display_name:'Local name',credential_ref:'credential_profile:skill-runtime'}}});
  expect(response.statusCode,response.body).toBe(200);
  expect(response.json().data.overlay_json).toMatchObject({alias:'alias',credential_ref:'credential_profile:skill-runtime'});
  const after=(await fixture.app.inject({method:'GET',url:'/api/v1/skills/index'})).json();
  expect(after.items[0]).toMatchObject({effective_name:'Local name',effective_alias:'alias'});
  expect(after.items[0].skill_package).toEqual(before.items[0].skill_package);
  expect((await db.pool.query('SELECT content_base64 FROM skill_package_files WHERE skill_package_id=$1',[fixture.pkg])).rows).toEqual(original);
 });
 it.each([{endpoint_defaults:{api_key:'secret'}},{user_preferences:{nested:[{access_token:'secret'}]}}])('refuses embedded credentials before any overlay write',async overlay_json=>{
  const response=await fixture.app.inject({method:'PUT',url:`/api/v1/skills/${fixture.pkg}/local-overlay`,headers:{'idempotency-key':randomUUID()},payload:{scope_type:'space',overlay_json}});
  expect(response.statusCode,response.body).toBe(422);
  expect((await db.pool.query('SELECT id FROM skill_local_overlays')).rows).toHaveLength(0);
 });
});
