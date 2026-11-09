import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {PgInterestProfileRepository} from '../src/modules/interestProfile/repository.js';
import {SourceChannelService} from '../src/modules/sources/channels/sourceChannelService.js';
import {openSubscriptionWindow} from '../src/modules/sources/channels/subscriptionWindows.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,channel:string,connection:string,profile:string,app:ReturnType<typeof buildModuleServer>;
let config:ReturnType<typeof loadConfig>;
const change=(status:'subscribed'|'muted',key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/sources/channels/${channel}/subscription`,payload:{status},headers:{'idempotency-key':key}});
const decision=(value:'subscribed'|'muted'|'dismissed',key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/sources/recommendations/${channel}/decision`,payload:{decision:value},headers:{'idempotency-key':key}});
const generic=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const state=async()=>({sub:(await db.pool.query('SELECT status,updated_at FROM source_channel_user_subscriptions WHERE space_id=$1 ORDER BY id',[space])).rows,windows:(await db.pool.query('SELECT id,subscribed_at,unsubscribed_at FROM source_channel_subscription_windows WHERE space_id=$1 ORDER BY id',[space])).rows,observations:(await db.pool.query('SELECT id FROM interest_topic_observations WHERE profile_id=$1 ORDER BY id',[profile])).rows,candidates:(await db.pool.query('SELECT phrase_key,status,occurrence_count,read_count FROM interest_topic_candidates WHERE profile_id=$1 ORDER BY id',[profile])).rows});
beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
  space=randomUUID();owner=randomUUID();channel=randomUUID();connection=randomUUID();
  const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID(),spaceType:'team'});
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now});
  await db.pool.query("UPDATE source_connections SET visibility='space_shared' WHERE id=$1",[connection]);
  await db.pool.query("INSERT INTO source_channel_user_subscriptions(id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at) VALUES($1,$2,$3,$4,'subscribed',true,true,$5,$5)",[randomUUID(),space,channel,owner,now]);
  await openSubscriptionWindow(db.pool,{spaceId:space,channelId:channel,userId:owner,at:now});
  const repo=new PgInterestProfileRepository(db.pool);profile=(await repo.ensureProfile(space,owner)).id;
  await repo.upsertTopic({spaceId:space,userId:owner,profileId:profile,label:'History',domainKey:'history',origin:'user'});
  await repo.accumulateCandidates({spaceId:space,userId:owner,profileId:profile,phrases:[{phraseKey:'automatic',display:'Automatic fact',domainKey:'history',wasRead:true,occurrenceIsNew:true},{phraseKey:'dismissed',display:'Dismissed fact',domainKey:'history',wasRead:true,occurrenceIsNew:true}]});
  await repo.dismissCandidate(profile,'dismissed');
  const item=randomUUID();await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared',$4,'external_url','Historical delivery',$5,$5,'excerpt_saved','summary_only',$5,$5)",[item,space,owner,connection,now]);
  await repo.markObserved(space,profile,[{sourceItemId:item,countedAsRead:true}]);
  config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});app=buildModuleServer(config,[sourcesModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('mutes and replays without rewriting windows, preserving accepted and dismissed owner decisions',async()=>{
  const key=randomUUID(),result=await change('muted',key);expect(result.statusCode,result.body).toBe(200);
  const saved=await state();expect(saved.sub[0]?.status).toBe('muted');expect(saved.windows[0]?.unsubscribed_at).not.toBeNull();expect(saved.observations).toEqual([]);
  expect(saved.candidates).toEqual([{phrase_key:'dismissed',status:'dismissed',occurrence_count:0,read_count:0}]);
  expect((await new PgInterestProfileRepository(db.pool).listTopics(profile))).toHaveLength(1);
  expect((await generic('source.channel.set_subscription',{source_channel_id:channel,status:'muted'},key)).json()).toEqual(result.json());expect(await state()).toEqual(saved);
  expect((await change('subscribed',key)).json().error.code).toBe('idempotency_key_reused');
  expect((await change('subscribed')).statusCode).toBe(200);expect((await state()).windows).toHaveLength(2);
});
it.each(['subscribed','dismissed','muted'] as const)('decides a pending recommendation as %s and replays resolved authority',async value=>{
  await db.pool.query("UPDATE source_channel_user_subscriptions SET status='pending' WHERE space_id=$1",[space]);await db.pool.query('DELETE FROM source_channel_subscription_windows WHERE space_id=$1',[space]);
  const key=randomUUID(),result=await decision(value,key);expect(result.statusCode,result.body).toBe(200);expect(result.json().data.status).toBe(value);
  const saved=await state();expect(saved.windows).toHaveLength(value==='subscribed'?1:0);
  expect((await generic('source.recommendation.decide',{source_channel_id:channel,decision:value},key)).json()).toEqual(result.json());expect(await state()).toEqual(saved);
  expect((await decision(value)).statusCode).toBe(404);
});
it('protects other people, revoked membership, unknown fields and withdrawn recommendations',async()=>{
  const key=randomUUID();expect((await change('muted',key)).statusCode).toBe(200);
  const stranger=randomUUID();await seedSpaceMember(db.pool,{space,user:stranger});__setAuthIdentityForTests({spaceId:space,userId:stranger});expect((await change('subscribed')).statusCode).toBe(404);
  __setAuthIdentityForTests({spaceId:space,userId:owner});expect((await generic('source.channel.set_subscription',{source_channel_id:channel,status:'subscribed',user_id:stranger})).statusCode).toBe(422);
  await db.pool.query("UPDATE source_channel_user_subscriptions SET status='pending' WHERE space_id=$1",[space]);await db.pool.query("UPDATE source_connections SET visibility='private' WHERE id=$1",[connection]);
  expect((await decision('subscribed')).statusCode).toBe(404);
  await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);expect((await change('muted',key)).statusCode).toBe(404);
});
it('allows personal opt-out without Source configuration or current content read authority',async()=>{
  const replacement=randomUUID();await seedSpaceMember(db.pool,{space,user:replacement});
  await db.pool.query("UPDATE source_connections SET owner_user_id=$2,visibility='private' WHERE id=$1",[connection,replacement]);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await change('muted')).statusCode).toBe(200);
});
it('refuses a concurrent same-key decision while waiting on the channel row',async()=>{
  const hold=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof change>|undefined;
  try{await hold.query('BEGIN');await hold.query('SELECT id FROM source_channels WHERE id=$1 FOR UPDATE',[channel]);pending=change('muted',key);await waitForLockWaiter(db.pool);
    const conflict=await change('muted',key);expect(conflict.statusCode,conflict.body).toBe(409);expect(conflict.json().error.code).toBe('idempotency_in_progress');
    await hold.query('COMMIT');expect((await pending).statusCode).toBe(200);
  }finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it.each(['interest_topic_candidates','operation_idempotency','policy_decision_records'])('rolls back preferences/windows/facts when %s storage fails',async table=>{
  const before=await state();
  await db.pool.query(`CREATE FUNCTION refuse_subscription_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'subscription storage refused'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_subscription_store BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_subscription_store()`);
  try{const response=await change('muted');expect(response.statusCode,response.body).toBe(table==='policy_decision_records'?503:500);expect(await state()).toEqual(before);}
  finally{await db.pool.query(`DROP TRIGGER refuse_subscription_store ON ${table}`);await db.pool.query('DROP FUNCTION refuse_subscription_store()');}
});
it('also rolls back direct canonical Pool callers if automatic fact cleanup fails',async()=>{
  const before=await state();await db.pool.query(`CREATE FUNCTION refuse_subscription_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup refused'; END $$`);
  await db.pool.query('CREATE TRIGGER refuse_subscription_cleanup BEFORE DELETE ON interest_topic_candidates FOR EACH ROW EXECUTE FUNCTION refuse_subscription_cleanup()');
  try{await expect(new SourceChannelService(db.pool,config).setSubscription({spaceId:space,userId:owner},channel,'muted')).rejects.toThrow();expect(await state()).toEqual(before);}
  finally{await db.pool.query('DROP TRIGGER refuse_subscription_cleanup ON interest_topic_candidates');await db.pool.query('DROP FUNCTION refuse_subscription_cleanup()');}
});

it('hides foreign-Space channel identity and keeps the original personal facts intact',async()=>{
  const before=await state(),foreign={space:randomUUID(),owner:randomUUID(),project:randomUUID(),spaceType:'team' as const};
  await seedSpaceOwnerProject(db.pool,foreign);__setAuthIdentityForTests({spaceId:foreign.space,userId:foreign.owner});
  const a=await change('muted'),b=await generic('source.channel.set_subscription',{source_channel_id:randomUUID(),status:'muted'});
  expect(a.statusCode).toBe(404);expect(b.statusCode).toBe(404);expect(a.json().error.code).toBe(b.json().error.code);expect(await state()).toEqual(before);
});
it.each(['source_channel_subscription_windows','operation_idempotency'])('rolls back a recommendation and its delivery window when %s fails',async table=>{
  await db.pool.query("UPDATE source_channel_user_subscriptions SET status='pending' WHERE space_id=$1",[space]);await db.pool.query('DELETE FROM source_channel_subscription_windows WHERE space_id=$1',[space]);
  const before=await state();await db.pool.query(`CREATE FUNCTION refuse_recommendation_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recommendation storage refused'; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_recommendation_store BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_recommendation_store()`);
  try{expect((await decision('subscribed')).statusCode).toBe(500);expect(await state()).toEqual(before);}
  finally{await db.pool.query(`DROP TRIGGER refuse_recommendation_store ON ${table}`);await db.pool.query('DROP FUNCTION refuse_recommendation_store()');}
});
