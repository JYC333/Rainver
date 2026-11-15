import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {buildModuleServer} from './support/moduleServer.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {captureModule} from '../src/modules/capture/index.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
// Invalid capture input must remain a client error through the real formal
// adapter, including a paste over the limit; no Activity may be written.
const db=useTestDatabase(import.meta.filename),space=randomUUID(),user=randomUUID();
let app:ReturnType<typeof buildModuleServer>;
beforeEach(async()=>{
 if(!db.available)return;
 await seedSpaceOwnerProject(db.pool,{space,owner:user,project:randomUUID()});
 app=buildModuleServer(loadConfig({...process.env,SERVER_DATABASE_URL:db.connectionUri}),[captureModule]);
 __setAuthIdentityForTests({spaceId:space,userId:user});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('answers 422 for an unknown destination or an over-long paste without writing raw input',async()=>{
 for(const payload of [{text:'hello',destination:'somewhere_else'},{text:'x'.repeat(20001),destination:'personal_inbox'}]){
  const response=await app.inject({method:'POST',url:'/api/v1/captures',headers:{'idempotency-key':randomUUID()},payload});
  expect(response.statusCode,response.body).toBe(422);
 }
 expect((await db.pool.query('SELECT id FROM activity_records')).rows).toHaveLength(0);
});
