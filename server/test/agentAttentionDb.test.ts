import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentAttentionQuerySchema, AgentAttentionPageSchema, AgentAttentionViewResultSchema } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedAttentionRun } from "./support/agentAttentionSeeds.js";
import { seedSpaceOwnerProject, seedRun } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { AgentAttentionRepository } from "../src/modules/agentAttention/repository.js";
import { loadWorks, changeReadState, recordViews } from "../src/modules/agentAttention/readStateService.js";
import { boundWork } from "../src/modules/agentAttention/readModel.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { agentAttentionModule } from "../src/modules/agentAttention/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
afterEach(()=>__setAuthIdentityForTests(null));
const db = useTestDatabase(import.meta.url);
const user = randomUUID(), space = randomUUID(), project = randomUUID();
const now = new Date().toISOString();
beforeEach(async()=>{
  if (!db.available) return;
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  await seedSpaceOwnerProject(db.pool,{space,owner:user,project});
});
async function run(status='succeeded',time=now) {
  return seedAttentionRun(db.pool,{space,owner:user,status,now:time});
}
async function page(query={}) {
  return new AgentAttentionRepository(db.pool).page((await loadWorks(db.pool,user)).map(i=>boundWork(i)),AgentAttentionQuerySchema.parse(query),now);
}
async function request() {
  await run(); const item=(await page()).items[0]!;
  return {identity:item.identity,space_id:space,subject:item.read_states[0]!.subject,state_version:0,action:'read' as const};
}
describe('Agent attention durable read model',()=>{
  it('returns an empty collection and immutable concurrent enablement baseline',async()=>{
    expect((await page()).items).toEqual([]);
    const repo=new AgentAttentionRepository(db.pool);
    const baselines=await Promise.all([repo.baseline(user),repo.baseline(user)]);
    expect(baselines[0]).toBe(baselines[1]);
  });
  it('projects terminal results and active work into protocol DTOs',async()=>{
    await run(); await run('running'); const result=await page();
    expect(result.counts.recently_finished).toBe(1); expect(result.counts.working).toBe(1);
    expect(AgentAttentionPageSchema.safeParse(result).success).toBe(true);
    const member = result.items[0]!.runs[0]!;
    expect(member.agent_name).toEqual(expect.any(String));
    expect(member.runtime_key).toEqual(expect.any(String));
    expect(member).toHaveProperty('started_at');
  });
  it('serializes version zero races and returns conflict for stale writes',async()=>{
    const input=await request();
    const writes=await Promise.allSettled([changeReadState(db.pool,user,input),changeReadState(db.pool,user,input)]);
    expect(writes.filter(w=>w.status==='fulfilled')).toHaveLength(1);
    expect((writes.find(w=>w.status==='rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
    expect((await page()).items[0]!.unread).toBe(false);
  });
  it('preserves manual unread against an old effect until a new read decision',async()=>{
    const base=await request(); const read=await changeReadState(db.pool,user,base);
    const unread=await changeReadState(db.pool,user,{...base,state_version:read.state_version,action:'unread'});
    await expect(changeReadState(db.pool,user,{...base,state_version:read.state_version})).rejects.toMatchObject({statusCode:409});
    expect(unread.manual_unread).toBe(true);
    expect((await changeReadState(db.pool,user,{...base,state_version:unread.state_version})).unread).toBe(false);
  });
  it('cannot consume a new attempt with an older callback or an older read',async()=>{
    const base=await request();
    await changeReadState(db.pool,user,base);expect((await page()).items[0]!.unread).toBe(false);
    base.state_version=1;
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,ended_at,created_at,updated_at)
      VALUES($1,$2,$3,2,'succeeded',now(),now(),now())`,[randomUUID(),space,base.identity.source_id]);
    await expect(changeReadState(db.pool,user,base)).rejects.toMatchObject({statusCode:409});
    expect((await page()).items[0]!.unread).toBe(true);
  });
  it('keeps an old active Run among large history, with full counts and disjoint cursor pages',async()=>{
    const old=new Date(Date.parse(now)-10*86400000).toISOString();const active=await run('running',old);
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,ended_at)
      SELECT gen_random_uuid(),space_id,agent_id,agent_version_id,run_type,trigger_origin,'succeeded',mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,created_at
      FROM runs CROSS JOIN generate_series(1,130) WHERE id=$1`,[active]);
    expect((await page()).items.map(i=>i.identity.source_id)).toEqual([active]);
    const first=await page({view:'history',limit:50});expect(first.counts.idle).toBe(130);expect(first.items).toHaveLength(50);
    const second=await page({view:'history',limit:50,cursor:first.next_cursor});expect(second.counts).toEqual(first.counts);
    expect(second.items.some(i=>first.items.some(j=>j.work_key===i.work_key))).toBe(false);
    expect((await page({view:'history',group:'working'})).counts.idle).toBe(130);
  });
  it('read does not extend retention, while manual unread brings history back',async()=>{
    const old=new Date(Date.parse(now)-2*86400000).toISOString();await run('succeeded',old);
    expect((await page()).items).toHaveLength(0);const item=(await page({view:'history'})).items[0]!;
    const base={identity:item.identity,space_id:space,subject:item.read_states[0]!.subject,state_version:0,action:'unread' as const};
    await changeReadState(db.pool,user,base);expect((await page()).items).toHaveLength(1);
    await changeReadState(db.pool,user,{...base,state_version:1,action:'read'});expect((await page()).items).toHaveLength(0);
    expect((await page({view:'history'})).items[0]!.last_activity_at).toBe(old);
  });
  it('never resurrects removed sources or revoked memberships from read state',async()=>{
    const base=await request();await changeReadState(db.pool,user,base);
    await db.pool.query(`UPDATE space_memberships SET status='revoked' WHERE user_id=$1`,[user]);
    expect((await page()).items).toHaveLength(0);
    await expect(changeReadState(db.pool,user,{...base,state_version:1})).rejects.toMatchObject({statusCode:404});
    await db.pool.query(`UPDATE space_memberships SET status='active' WHERE user_id=$1`,[user]);
    await db.pool.query(`DELETE FROM runs WHERE id=$1`,[base.identity.source_id]);expect((await page()).items).toHaveLength(0);
  });
  it('distinguishes mine from all_visible and rejects a forged Space',async()=>{
    const base=await request(); const other=randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at)
      VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
    await db.pool.query(`UPDATE runs SET owner_user_id=$1`,[other]);expect((await page()).items).toHaveLength(0);
    expect((await page({scope:'all_visible'})).items[0]!.mine).toBe(false);
    await expect(changeReadState(db.pool,user,{...base,space_id:randomUUID()})).rejects.toMatchObject({statusCode:404});
  });
});

describe('visibility, grouping and HTTP contracts',()=>{
  it('withholds a private Room even from a Space owner until current roster membership is present',async()=>{
    const id=await run();const room=randomUUID(),session=randomUUID();
    await db.pool.query(`INSERT INTO rooms(id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'Private','active',now(),now())`,[room,space,project,user]);
    await db.pool.query(`INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'Private thread','active',now(),now())`,[session,space,room,project]);
    await db.pool.query(`UPDATE runs SET session_id=$2,project_id=$3 WHERE id=$1`,[id,session,project]);
    expect((await page({scope:'all_visible'})).items).toHaveLength(0);
    await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'owner','active',now(),now())`,[randomUUID(),space,room,user]);
    const item=(await page()).items[0]!;expect(item.identity).toEqual({kind:'session',source_id:session});
    await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:item.read_states[0]!.subject,state_version:0,action:'unread'});
    await db.pool.query(`UPDATE room_user_members SET status='removed' WHERE room_id=$1`,[room]);
    expect((await page({scope:'all_visible'})).items).toHaveLength(0);
  });
  it('Task execution overrides a direct Session while unrelated Sessions stay independent',async()=>{
    const id=await run();const task=randomUUID(),session=randomUUID();
    const row=(await db.pool.query(`SELECT agent_id FROM runs WHERE id=$1`,[id])).rows[0]!;
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,agent_id,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'active',now(),now())`,[session,space,user,row.agent_id]);
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`,[id,session]);
    await db.pool.query(`INSERT INTO tasks(id,space_id,project_id,title,status,created_by_user_id,owner_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'Review work','waiting_for_review',$4,$4,now(),now())`,[task,space,project,user]);
    await db.pool.query(`INSERT INTO task_runs(id,space_id,task_id,run_id,role,created_at)
      VALUES($1,$2,$3,$4,'review',now())`,[randomUUID(),space,task,id]);
    const item=(await page()).items[0]!;expect(item.identity).toEqual({kind:'task',source_id:task});
    expect(item.group).toBe('needs_you');expect(item.runs[0]!.task_run_role).toBe('review');
    for(const read of item.read_states) await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:read.subject,state_version:0,action:'read'});
    expect((await page()).items[0]!.group).toBe('needs_you');
    expect((await db.pool.query(`SELECT status FROM tasks WHERE id=$1`,[task])).rows[0]!.status).toBe('waiting_for_review');
  });
  it('a summary-only Run cannot leak question, error, or conversation subjects',async()=>{
    const id=await run();const other=randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at)
      VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
    await db.pool.query(`UPDATE space_memberships SET role='member' WHERE user_id=$1`,[user]);
    await db.pool.query(`UPDATE runs SET owner_user_id=$2,access_level='summary',error_json='{"authorization_request_id":"private"}' WHERE id=$1`,[id,other]);
    const item=(await page({scope:'all_visible'})).items[0]!;
    expect(item.access_level).toBe('summary');expect(item.reasons).toEqual([]);
    expect(item.runs[0]!.agent_name).toBeNull();
    expect(item.runs[0]!.turn_state).toBeNull();expect(item.read_states.every(s=>s.subject.kind==='run_result')).toBe(true);
  });
  it('counts only visible children without disclosing hidden member totals',async()=>{
    const a=await run(),b=await run();const session=randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,title,status,created_at,updated_at)
      VALUES($1,$2,$3,'Shared work','active',now(),now())`,[session,space,user]);
    await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=ANY($2::varchar[])`,[session,[a,b]]);
    const other=randomUUID();await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at)
      VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
    await db.pool.query(`UPDATE space_memberships SET role='member' WHERE user_id=$1`,[user]);
    await db.pool.query(`UPDATE runs SET owner_user_id=$2,visibility='private' WHERE id=$1`,[b,other]);
    const result=await page();expect(result.items).toHaveLength(1);expect(result.items[0]!.visible_run_count).toBe(1);
    expect(result.items[0]!.runs.map(r=>r.run_id)).toEqual([a]);
  });
  it('fetches across active Space memberships and filters each source independently',async()=>{
    await run();const space2=randomUUID(),owner2=randomUUID(),project2=randomUUID();
    await seedSpaceOwnerProject(db.pool,{space:space2,owner:owner2,project:project2});
    const id=randomUUID();await seedRun(db.pool,{id,space:space2,owner:owner2,agent:randomUUID(),version:randomUUID()});
    await db.pool.query(`UPDATE runs SET instructed_by_user_id=$2 WHERE id=$1`,[id,user]);
    expect((await page({scope:'all_visible'})).items).toHaveLength(1);
    await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at)
      VALUES($1,$2,$3,'member','active',now(),now())`,[randomUUID(),space2,user]);
    expect((await page()).items).toHaveLength(2);
    expect((await page({space_id:space2})).items[0]!.identity.source_id).toBe(id);
    expect((await page({space_id:space})).items).toHaveLength(1);
  });
  it('keeps queued/resource and authorization waits separate from executing work',async()=>{
    const queued=await run('queued');await run('waiting_for_review');
    await db.pool.query(`UPDATE runs SET output_json='{"waiting_for_quota":{}}' WHERE id=$1`,[queued]);
    const result=await page();expect(result.counts.waiting).toBe(1);expect(result.counts.needs_you).toBe(1);
    expect(result.items.find(i=>i.identity.source_id===queued)!.reasons[0]).toMatchObject({kind:'resource',code:'waiting_for_quota'});
  });
  it('projects a dependency wait without personal responsibility and shows working after the wait clears',async()=>{
    const dependency=await run('running'), id=await run('waiting_for_dependency');
    await db.pool.query(`UPDATE runs SET output_json=jsonb_build_object('waiting_for_results',
      jsonb_build_object('scope','run_ids','depends_on_run_ids',$2::jsonb)) WHERE id=$1`,[id,JSON.stringify([dependency])]);
    const waiting=await page();
    const item=waiting.items.find(work=>work.identity.source_id===id)!;
    expect(item.group).toBe('waiting');
    expect(waiting.counts).toMatchObject({waiting:1,working:1,needs_you:0});
    expect(item.responsible).toEqual({kind:null,id:null,display_name:null});
    expect(item.reasons).toEqual([{kind:'resource',run_id:id,code:'run_ids',dependency_run_ids:[dependency]}]);
    await db.pool.query(`UPDATE runs SET status='running',output_json=NULL WHERE id=$1`,[id]);
    const resumed=await page();
    expect(resumed.items.find(work=>work.identity.source_id===id)).toMatchObject({group:'working',reasons:[],responsible:{kind:null,id:null}});
    expect(resumed.counts).toMatchObject({waiting:0,working:2,needs_you:0});
  });
});

describe('question causality and exact reading',()=>{
  it.each(['succeeded', 'degraded'])('keeps the same Agent’s two Sessions independent while its %s question still needs an answer',async status=>{
    const asking=await run(status), working=randomUUID(), first=randomUUID(), second=randomUUID(), question=randomUUID();
    const {agent_id}=(await db.pool.query(`SELECT agent_id FROM runs WHERE id=$1`,[asking])).rows[0]!;
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,agent_id,title,status,created_at,updated_at)
      VALUES($1,$3,$4,$5,'Question thread','active',now(),now()),($2,$3,$4,$5,'Working thread','active',now(),now())`,[first,second,space,user,agent_id]);
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`,[asking,first]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
      VALUES($1,$2,$3,$4,'assistant','Which input should I use?','{"awaiting_answer":true}',1,'/',$5,now())`,[question,space,first,agent_id,asking]);
    await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`,[first,question]);
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      created_at,updated_at,execution_kind,session_id)
      SELECT $1,space_id,agent_id,agent_version_id,run_type,trigger_origin,'running',mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      now(),now(),execution_kind,$2 FROM runs WHERE id=$3`,[working,second,asking]);
    const result=await page();
    expect(result.items).toHaveLength(2);
    expect(result.counts).toMatchObject({needs_you:1,working:1});
    expect(result.items.find(item=>item.identity.source_id===first)).toMatchObject({identity:{kind:'session',source_id:first},group:'needs_you',
      reasons:[expect.objectContaining({kind:'awaiting_answer',message_id:question,agent_id})]});
    expect(result.items.find(item=>item.identity.source_id===second)).toMatchObject({identity:{kind:'session',source_id:second},group:'working',
      runs:[expect.objectContaining({run_id:working,agent_id})]});
  });
  it('reading a question or a failed send cannot close it; a durable dispatch on the visible branch does',async()=>{
    const id=await run();const session=randomUUID(),question=randomUUID(),reply=randomUUID();
    const row=(await db.pool.query(`SELECT agent_id FROM runs WHERE id=$1`,[id])).rows[0]!;
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,agent_id,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'active',now(),now())`,[session,space,user,row.agent_id]);
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`,[id,session]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
      VALUES($1,$2,$3,$4,'assistant','Question','{"awaiting_answer":true}',1,'/',$5,now())`,[question,space,session,row.agent_id,id]);
    await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`,[session,question]);
    const item=(await page()).items[0]!;expect(item.group).toBe('needs_you');
    await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:item.read_states[0]!.subject,state_version:0,action:'read'});
    expect((await page()).items[0]!.group).toBe('needs_you');
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,parent_message_id,path_depth,branch_path,created_at)
      VALUES($1,$2,$3,$4,'user','Answer',$5,2,'/',now())`,[reply,space,session,user,question]);
    await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`,[session,reply]);
    expect((await page()).items[0]!.group).toBe('needs_you');
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      created_at,updated_at,execution_kind,session_id,model_override_json)
      SELECT $1,space_id,agent_id,agent_version_id,run_type,trigger_origin,'queued',mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      now(),now(),execution_kind,session_id,jsonb_build_object('chat_turn',jsonb_build_object('user_message_id',$2::text))
      FROM runs WHERE id=$3`,[randomUUID(),reply,id]);
    expect((await page()).items[0]!.reasons.some(r=>r.kind==='awaiting_answer')).toBe(false);
  });
  it('reading an older result leaves a newer result of the same work unread',async()=>{
    const earlier=new Date(Date.parse(now)-60_000).toISOString();
    const a=await run('succeeded',earlier),b=await run(),session=randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())`,[session,space,user]);
    await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=ANY($2::varchar[])`,[session,[a,b]]);
    const item=(await page()).items[0]!;expect(item.read_states).toHaveLength(2);
    const older=item.read_states.find(r=>r.subject.kind==='run_result'&&r.subject.run_id===a)!;
    await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:older.subject,state_version:0,action:'read'});
    const next=(await page()).items[0]!;expect(next.unread).toBe(true);
    expect(next.read_states.filter(r=>r.unread).map(r=>r.subject.kind==='run_result'&&r.subject.run_id)).toEqual([b]);
  });
  it('reading the newest result reads earlier results of the same work, while manual unread and later results keep their own state',async()=>{
    const earlier=new Date(Date.parse(now)-60_000).toISOString(),later=new Date(Date.parse(now)+60_000).toISOString();
    const a=await run('succeeded',earlier),b=await run(),session=randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())`,[session,space,user]);
    await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=ANY($2::varchar[])`,[session,[a,b]]);
    const item=(await page()).items[0]!;
    const subjectOf=(work:typeof item,id:string)=>work.read_states.find(r=>r.subject.kind==='run_result'&&r.subject.run_id===id)!;
    // Reading only the newest reply is enough: the older one was never written, yet it is no longer unread.
    await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:subjectOf(item,b).subject,state_version:0,action:'read'});
    let next=(await page()).items[0]!;expect(next.unread).toBe(false);expect(next.group).toBe('idle');
    expect(subjectOf(next,a)).toMatchObject({unread:false,read_at:null,state_version:0});
    // A manual unread on the older subject is an explicit decision the watermark does not override.
    await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:subjectOf(item,a).subject,state_version:0,action:'unread'});
    next=(await page()).items[0]!;expect(next.unread).toBe(true);expect(subjectOf(next,a)).toMatchObject({unread:true,manual_unread:true});
    // A result newer than the latest confirmed read stays unread.
    const c=await run('succeeded',later);await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=$2`,[session,c]);
    next=(await page()).items[0]!;expect(subjectOf(next,c).unread).toBe(true);expect(subjectOf(next,b).unread).toBe(false);
  });
});

describe('read cursor across surfaces',()=>{
  const minute=60_000;
  async function sessionWith(...runIds:string[]) {
    const session=randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())`,[session,space,user]);
    await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=ANY($2::varchar[])`,[session,runIds]);
    return session;
  }
  let depth=0;
  const ownReply=(session:string,at:string,who=user)=>db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,metadata_json,path_depth,branch_path,created_at)
    VALUES($1,$2,$3,$4,'user','Thanks','{}',$6,'/',$5)`,[randomUUID(),space,session,who,at,++depth]);
  const resultOf=(item:Awaited<ReturnType<typeof page>>['items'][number],id:string)=>item.read_states.find(r=>r.subject.kind==='run_result'&&r.subject.run_id===id)!;
  it('the person’s own reply reads the results before it on any surface, not the ones after',async()=>{
    const earlier=new Date(Date.parse(now)-minute).toISOString(),later=new Date(Date.parse(now)+minute).toISOString(),latest=new Date(Date.parse(now)+2*minute).toISOString();
    const a=await run('succeeded',earlier),b=await run(),session=await sessionWith(a,b);
    expect((await page()).items[0]!.unread).toBe(true);
    await ownReply(session,later);
    let item=(await page()).items[0]!;expect(item.unread).toBe(false);expect(item.group).toBe('idle');
    expect(resultOf(item,a)).toMatchObject({unread:false,read_at:null,state_version:0});
    const c=await run('succeeded',latest);await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=$2`,[session,c]);
    item=(await page()).items[0]!;expect(item.unread).toBe(true);expect(resultOf(item,c).unread).toBe(true);expect(resultOf(item,b).unread).toBe(false);
  });
  it('another person’s reply and a reply before the result read nothing',async()=>{
    const other=randomUUID();await seedSpaceOwnerProject(db.pool,{space:randomUUID(),owner:other,project:randomUUID()});
    const a=await run(),session=await sessionWith(a);
    await ownReply(session,new Date(Date.parse(now)+minute).toISOString(),other);
    await ownReply(session,new Date(Date.parse(now)-minute).toISOString());
    expect((await page()).items[0]!.unread).toBe(true);
  });
  it('a manual unread survives an earlier own reply and yields to a later one',async()=>{
    const a=await run('succeeded',new Date(Date.parse(now)-2*minute).toISOString()),session=await sessionWith(a);
    const item=(await page()).items[0]!;
    await ownReply(session,new Date(Date.parse(now)-minute).toISOString());
    expect((await page()).items[0]!.unread).toBe(false);
    await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:resultOf(item,a).subject,state_version:0,action:'unread'});
    expect((await page()).items[0]!).toMatchObject({unread:true});
    await ownReply(session,new Date(Date.now()+minute).toISOString());
    expect((await page()).items[0]!).toMatchObject({unread:false});
    expect(resultOf((await page()).items[0]!,a).manual_unread).toBe(false);
  });
  it('reading or replying in one Session of a Task work leaves another Session\'s reply unread',async()=>{
    const task=randomUUID(),earlier=new Date(Date.parse(now)-minute).toISOString(),later=new Date(Date.parse(now)+minute).toISOString();
    await db.pool.query(`INSERT INTO tasks(id,space_id,project_id,title,status,created_by_user_id,owner_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'Two conversations','in_progress',$4,$4,now(),now())`,[task,space,project,user]);
    const replies:string[]=[],sessions:string[]=[];
    for(const at of [earlier,now]) {
      const id=await run('succeeded',at),session=await sessionWith(id),message=randomUUID();
      await db.pool.query(`INSERT INTO task_runs(id,space_id,task_id,run_id,role,created_at) VALUES($1,$2,$3,$4,'executes',now())`,[randomUUID(),space,task,id]);
      await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
        SELECT $1,$2,$3,agent_id,'assistant','Reply','{}',1,'/',id,$5 FROM runs WHERE id=$4`,[message,space,session,id,at]);
      await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`,[session,message]);
      replies.push(message);sessions.push(session);
    }
    const unread=async()=>(await page()).items[0]!.read_states.filter(r=>r.unread).map(r=>r.subject.kind==='message'&&r.subject.message_id);
    expect((await page()).items[0]!.identity).toEqual({kind:'task',source_id:task});
    expect((await unread()).sort()).toEqual([...replies].sort());
    await recordViews(db.pool,user,{space_id:space,session_id:sessions[1]!,message_ids:[replies[1]!]});
    expect(await unread()).toEqual([replies[0]]);
    await ownReply(sessions[1]!,later);
    expect(await unread()).toEqual([replies[0]]);
    await ownReply(sessions[0]!,later);
    expect(await unread()).toEqual([]);
  });
  it.each([false,true])('view reports return only their committed versions for ordered manual unread, including Task-owned conversations (task=%s)',async taskOwned=>{
    const asking=await run(),session=await sessionWith(asking),message=randomUUID();
    const {agent_id}=(await db.pool.query(`SELECT agent_id FROM runs WHERE id=$1`,[asking])).rows[0]!;
    await db.pool.query(`UPDATE sessions SET agent_id=$2 WHERE id=$1`,[session,agent_id]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
      VALUES($1,$2,$3,$4,'assistant','The report is ready.','{}',1,'/',$5,$6)`,[message,space,session,agent_id,asking,now]);
    await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`,[session,message]);
    if(taskOwned) {
      const task=randomUUID();
      await db.pool.query(`INSERT INTO tasks(id,space_id,project_id,title,status,created_by_user_id,owner_user_id,created_at,updated_at)
        VALUES($1,$2,$3,'Conversation task','in_progress',$4,$4,now(),now())`,[task,space,project,user]);
      await db.pool.query(`INSERT INTO task_runs(id,space_id,task_id,run_id,role,created_at)
        VALUES($1,$2,$3,$4,'executes',now())`,[randomUUID(),space,task,asking]);
    }
    let item=(await page()).items[0]!;
    expect(item.read_states.map(r=>r.subject.kind)).toEqual(['message']);expect(item.unread).toBe(true);
    expect(await recordViews(db.pool,user,{space_id:space,session_id:session,message_ids:[randomUUID()]})).toEqual({read_count:0,read_states:[]});
    expect((await page()).items[0]!.unread).toBe(true);
    const viewed=await recordViews(db.pool,user,{space_id:space,session_id:session,message_ids:[message,randomUUID()]});
    expect(AgentAttentionViewResultSchema.parse(viewed)).toEqual({read_count:1,read_states:[{
      ...item.read_states[0]!,unread:false,state_version:1,read_at:expect.any(String)
    }]});
    item=(await page()).items[0]!;expect(item.unread).toBe(false);expect(item.read_states[0]).toMatchObject({unread:false,state_version:1});
    expect(await recordViews(db.pool,user,{space_id:space,session_id:session,message_ids:[message]})).toEqual({read_count:0,read_states:[]});
    const decision={identity:item.identity,space_id:space,subject:viewed.read_states[0]!.subject,state_version:viewed.read_states[0]!.state_version,action:'unread' as const};
    await changeReadState(db.pool,user,decision);
    expect((await page()).items[0]!.unread).toBe(true);
    // The earlier report's response cannot silently overwrite a later decision.
    await expect(changeReadState(db.pool,user,decision)).rejects.toMatchObject({statusCode:409});
    expect((await page()).items[0]!.unread).toBe(true);
    const reopened=await recordViews(db.pool,user,{space_id:space,session_id:session,message_ids:[message]});
    expect(reopened).toMatchObject({read_count:1,read_states:[{subject:viewed.read_states[0]!.subject,state_version:3,unread:false,manual_unread:false}]});
    expect((await page()).items[0]!).toMatchObject({unread:false});
    expect(await recordViews(db.pool,user,{space_id:randomUUID(),session_id:session,message_ids:[message]})).toEqual({read_count:0,read_states:[]});
  });
});

describe('Agent attention HTTP boundary',()=>{
  it('validates inputs, uses session user and keeps item/read scopes exact',async()=>{
    await run();
    __setAuthIdentityForTests({spaceId:space,userId:user});
    const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[agentAttentionModule]);
    try {
      const result=await app.inject({method:'GET',url:'/api/v1/me/agent-attention'});
      expect(result.statusCode).toBe(200);expect(AgentAttentionPageSchema.safeParse(result.json()).success).toBe(true);
      const item=result.json().items[0];
      expect((await app.inject({method:'GET',url:`/api/v1/me/agent-attention/item?space_id=${space}&kind=run&source_id=${item.identity.source_id}`})).statusCode).toBe(200);
      expect((await app.inject({method:'GET',url:`/api/v1/me/agent-attention/item?space_id=${randomUUID()}&kind=run&source_id=${item.identity.source_id}`})).statusCode).toBe(404);
      const input={identity:item.identity,space_id:space,subject:item.read_states[0].subject,state_version:0,action:'read'};
      expect((await app.inject({method:'PATCH',url:'/api/v1/me/agent-attention/read-state',payload:{...input,user_id:user}})).statusCode).toBe(422);
      const patched=await app.inject({method:'PATCH',url:'/api/v1/me/agent-attention/read-state',payload:input});
      expect(patched.statusCode,patched.body).toBe(200);
      const conflict=await app.inject({method:'PATCH',url:'/api/v1/me/agent-attention/read-state',payload:input});
      expect(conflict.statusCode).toBe(409);expect(conflict.json().current.state_version).toBe(1);
      const view={space_id:space,session_id:randomUUID(),message_ids:[randomUUID()]};
      expect((await app.inject({method:'POST',url:'/api/v1/me/agent-attention/views',payload:{...view,user_id:user}})).statusCode).toBe(422);
      expect((await app.inject({method:'POST',url:'/api/v1/me/agent-attention/views',payload:{...view,message_ids:[]}})).statusCode).toBe(422);
      const viewed=await app.inject({method:'POST',url:'/api/v1/me/agent-attention/views',payload:view});
      expect(viewed.statusCode,viewed.body).toBe(200);expect(viewed.json()).toEqual({read_count:0,read_states:[]});
      for(const suffix of ['?limit=101','?user_id=x','?cursor=bad','?since=2026-01-01T00:00:00Z']) {
        expect((await app.inject({method:'GET',url:'/api/v1/me/agent-attention'+suffix})).statusCode).toBe(422);
      }
      expect((await app.inject({method:'GET',url:'/api/v1/me/agent-attention/stream'})).statusCode).toBe(404);
    } finally {await app.close();}
  });
});

describe('retention boundaries and query plans',()=>{
  it('retains exactly 24h read results and uses the result date for old Runs with new results',async()=>{
    const boundary=new Date(Date.parse(now)-86400000).toISOString();const older=new Date(Date.parse(boundary)-1).toISOString();
    const a=await run('succeeded',boundary);const b=await run('succeeded',older);
    await db.pool.query(`INSERT INTO agent_attention_baselines(user_id,enabled_at) VALUES($1,$2)`,[user,now]);
    expect((await page()).items.map(i=>i.identity.source_id)).toContain(a);
    expect((await page()).items.map(i=>i.identity.source_id)).not.toContain(b);
    for(const item of (await page({view:'history'})).items) {
      await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:item.read_states[0]!.subject,state_version:0,action:'read'});
    }
    expect((await page()).items.map(i=>i.identity.source_id)).toEqual([a]);
    await db.pool.query(`UPDATE run_attempts SET ended_at=$2 WHERE run_id=$1`,[b,now]);
    expect((await page()).items.find(i=>i.identity.source_id===b)!.unread).toBe(true);
  });
  it('records real source and complete eligible/count/page EXPLAIN plans on a thousand-row history',async()=>{
    const id=await run('running',new Date(Date.parse(now)-3*86400000).toISOString());
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,ended_at)
      SELECT gen_random_uuid(),space_id,agent_id,agent_version_id,run_type,trigger_origin,'succeeded',mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,created_at
      FROM runs CROSS JOIN generate_series(1,1000) WHERE id=$1`,[id]);
    const plans: Array<{name:string;rows:number;planning_ms:number;execution_ms:number;shared_hits:number}> = [];
    // Observes real PostgreSQL calls; no query result or database behavior is faked.
    const measured: import('../src/modules/routeUtils/common.js').Queryable={
      async query<Row>(sql:string,params?:readonly unknown[]) {
        if(sql.includes('WITH readable') || sql.includes('WITH candidates')) {
          const explained=await db.pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,[...(params??[])]);
          const plan=explained.rows[0]['QUERY PLAN'][0];
          plans.push({name:sql.includes('WITH readable')?'authorized source':'eligible/count/page',rows:plan.Plan['Actual Rows'],
            planning_ms:plan['Planning Time'],execution_ms:plan['Execution Time'],shared_hits:plan.Plan['Shared Hit Blocks']});
        }
        const result=await db.pool.query(sql,[...(params??[])]);
        return {rows:result.rows as Row[],rowCount:result.rowCount};
      },
    };
    const repo=new AgentAttentionRepository(measured);
    const items=await loadWorks(measured,user);
    const result=await repo.page(items.map(i=>boundWork(i)),AgentAttentionQuerySchema.parse({view:'history'}),now);
    expect(result.counts.idle).toBe(1000);expect(result.counts.working).toBe(1);expect(plans).toHaveLength(2);
    console.info('Agent attention EXPLAIN',JSON.stringify(plans));
  });
});

describe('bounded subjects and durable source revisions',()=>{
  it('paginates children without capping visible counts or acknowledging unseen results',async()=>{
    const id=await run(),session=randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())`,[session,space,user]);
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`,[id,session]);
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,ended_at,session_id)
      SELECT gen_random_uuid(),space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,ended_at-g*interval '1 second',session_id
      FROM runs CROSS JOIN generate_series(1,104) g WHERE id=$1`,[id]);
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,ended_at,created_at,updated_at)
      SELECT gen_random_uuid(),space_id,id,1,status,ended_at,created_at,updated_at FROM runs WHERE session_id=$1 AND id<>$2`,[session,id]);
    const full=(await loadWorks(db.pool,user))[0]!;const first=boundWork(full);expect(first.visible_run_count).toBe(105);
    expect(first.runs).toHaveLength(100);expect(first.read_states).toHaveLength(100);
    const second=boundWork(full,first.runs_next_cursor!);expect(second.runs).toHaveLength(5);expect(second.read_states).toHaveLength(5);
    expect(second.runs_next_cursor).toBeNull();
    // Distinct result times: reading the oldest acknowledges nothing else; the
    // newest is the Session's chat cursor and reads the older replies before it.
    const byTime=(await db.pool.query(`SELECT id FROM runs WHERE session_id=$1 ORDER BY ended_at`,[session])).rows.map(r=>r.id as string);
    const subjectOf=(id:string)=>full.read_states.find(s=>s.subject.kind==='run_result'&&s.subject.run_id===id)!.subject;
    await changeReadState(db.pool,user,{identity:first.identity,space_id:space,subject:subjectOf(byTime[0]!),state_version:0,action:'read'});
    expect((await loadWorks(db.pool,user))[0]!.read_states.filter(s=>s.unread)).toHaveLength(104);
    await changeReadState(db.pool,user,{identity:first.identity,space_id:space,subject:subjectOf(byTime[1]!),state_version:0,action:'read'});
    expect((await loadWorks(db.pool,user))[0]!.read_states.filter(s=>s.unread)).toHaveLength(103);
    await expect(Promise.resolve().then(()=>boundWork(full,Buffer.from('{"offset":100,"key":"forged"}').toString('base64url')))).rejects.toMatchObject({statusCode:422});
  });
  it('splits work-level subjects beyond the wire cap across child pages',async()=>{
    await run();const full=(await loadWorks(db.pool,user))[0]!;
    // Not from projectWorks: everything is work-level, so only the cap bounds a page.
    const states=Array.from({length:250},(_,i)=>({...full.read_states[0]!,subject:{kind:'task' as const,schema_version:1 as const,task_id:`task-${i}`,revision:'r'}}));
    const synthetic={...full,runs:[],read_states:states};
    const sizes:number[]=[];let cursor:string|undefined;
    do { const next=boundWork(synthetic,cursor);sizes.push(next.read_states.length);cursor=next.runs_next_cursor??undefined; } while(cursor);
    expect(sizes).toEqual([100,100,50]);
  });
  it('heartbeat and output-token updates do not invent a new result or business activity',async()=>{
    const base=await request();const before=(await page()).items[0]!;await changeReadState(db.pool,user,base);
    await db.pool.query(`UPDATE runs SET output_json='{"heartbeat":true,"tokens":900}',updated_at=now()+interval '3 hours' WHERE id=$1`,[base.identity.source_id]);
    const item=(await page()).items[0]!;expect(item.unread).toBe(false);expect(item.last_activity_at).toBe(before.last_activity_at);
    expect(item.read_states[0]!.subject).toEqual(base.subject);
  });
  it('pending proposals stay business-pending after their subject is read',async()=>{
    const id=await run(),proposal=randomUUID();
    await db.pool.query(`INSERT INTO proposals(id,space_id,created_by_run_id,proposal_type,status,risk_level,urgency,title,payload_json,owner_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'memory_create','pending','low','normal','Review change','{}',$4,now(),now())`,[proposal,space,id,user]);
    const item=(await page()).items[0]!;expect(item.group).toBe('needs_you');
    const subject=item.read_states.find(s=>s.subject.kind==='proposal')!;
    await changeReadState(db.pool,user,{identity:item.identity,space_id:space,subject:subject.subject,state_version:0,action:'read'});
    expect((await db.pool.query(`SELECT status FROM proposals WHERE id=$1`,[proposal])).rows[0]!.status).toBe('pending');
    expect((await page()).items[0]!.group).toBe('needs_you');
  });
});

describe('retry reading revision',()=>{
  it('an explicit Room supersession never becomes an unread fallback Run result',async()=>{
    const id=await run(),session=randomUUID(),message=randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())`,[session,space,user]);
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`,[id,session]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
      VALUES($1,$2,$3,'assistant','Replaced','{"retry_superseded":true}',1,'/',$4,now())`,[message,space,session,id]);
    await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`,[session,message]);
    const item=(await page()).items[0]!;expect(item.read_states).toEqual([]);expect(item.unread).toBe(false);
    expect(item.runs[0]!.retry_superseded).toBe(true);
  });
});

describe('summary blocked retention',()=>{
  it('retains an old summary-only blocked member without disclosing its private human reason',async()=>{
    const id=await run('waiting_for_review',new Date(Date.parse(now)-3*86400000).toISOString());
    const other=randomUUID();await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at)
      VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
    await db.pool.query(`UPDATE space_memberships SET role='member' WHERE user_id=$1`,[user]);
    await db.pool.query(`UPDATE runs SET owner_user_id=$2,access_level='summary' WHERE id=$1`,[id,other]);
    const item=(await page({scope:'all_visible'})).items[0]!;expect(item.group).toBe('waiting');expect(item.reasons).toEqual([]);
    expect(item.mine).toBe(false);expect((await page()).items).toHaveLength(0);
  });
});

it('hides conversation-derived group titles after archival without hiding readable Runs or standalone group titles', async () => {
  const space = randomUUID(), user = randomUUID(), project = randomUUID();
  const room = randomUUID(), session = randomUUID(), group = randomUUID(), message = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner: user, project });
  const run = await seedAttentionRun(db.pool, { space, owner: user, status: 'running' });
  const marker = 'Human message first line used as the group title';
  await db.pool.query(`INSERT INTO rooms(id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'Room','active',now(),now())`, [room,space,project,user]);
  await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'owner','active',now(),now())`, [randomUUID(),space,room,user]);
  await db.pool.query(`INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,NULL,'active',now(),now())`, [session,space,room,project]);
  await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,metadata_json,path_depth,branch_path,created_at)
    VALUES($1,$2,$3,$4,'user',$5,'{}',1,'/',now())`, [message,space,session,user,marker]);
  await db.pool.query(`UPDATE sessions SET head_message_id=$2 WHERE id=$1`, [session,message]);
  await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,root_run_id,manager_user_id,room_id,session_id,title,goal,status,created_at,updated_at,project_id,trigger_message_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Work','active',now(),now(),$8,$9)`, [group,space,run,user,room,session,marker,project,message]);
  await db.pool.query(`UPDATE runs SET session_id=$2,run_group_id=$3,project_id=$4 WHERE id=$1`, [run,session,group,project]);
  __setAuthIdentityForTests({ spaceId: space, userId: user });
  const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [agentAttentionModule]);
  const list = () => app.inject({ method: 'GET', url: '/api/v1/me/agent-attention' });
  const detail = (kind: string, id: string) => app.inject({ method: 'GET', url: `/api/v1/me/agent-attention/item?space_id=${space}&kind=${kind}&source_id=${id}` });
  try {
    const before = await list();
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().items).toHaveLength(1);
    expect(before.json().items[0]).toMatchObject({ title: marker, identity: { kind: 'session', source_id: session } });
    expect((await detail('session', session)).json().title).toBe(marker);

    await db.pool.query(`UPDATE sessions SET status='archived' WHERE id=$1`, [session]);
    const facts = await new AgentAttentionRepository(db.pool).facts(user);
    expect(facts.runs).toHaveLength(1);
    expect(facts.runs[0]).toMatchObject({ session_readable: false, session_title: null, group_title: null });
    const after = await list();
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().items).toHaveLength(1);
    expect(after.json().items[0]).toMatchObject({ title: 'Agent work', identity: { kind: 'run', source_id: run } });
    expect(after.body).not.toContain(marker);
    const item = await detail('run', run);
    expect(item.statusCode, item.body).toBe(200);
    expect(item.json().title).toBe('Agent work');
    expect(item.body).not.toContain(marker);
    expect((await detail('session', session)).statusCode).toBe(404);

    await db.pool.query(`UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2`, [room,user]);
    expect((await list()).json().items).toEqual([]);
    expect((await detail('run', run)).statusCode).toBe(404);

    const standalone = await seedAttentionRun(db.pool, { space, owner: user, status: 'running' });
    const standaloneGroup = randomUUID();
    await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,root_run_id,manager_user_id,title,goal,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'Independent group','Work','active',now(),now())`, [standaloneGroup,space,standalone,user]);
    await db.pool.query(`UPDATE runs SET run_group_id=$2 WHERE id=$1`, [standalone,standaloneGroup]);
    expect((await list()).json().items[0]).toMatchObject({ title: 'Independent group', identity: { kind: 'agent_group', source_id: standaloneGroup } });
    expect((await detail('agent_group', standaloneGroup)).json().title).toBe('Independent group');
  } finally { await app.close(); }
});
