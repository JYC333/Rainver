import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject } from './support/domainSeeds.js';
import { seedAttentionRun } from './support/agentAttentionSeeds.js';
import { AgentAttentionStreamFrameSchema, AgentWorkItemSchema, type AgentWorkItem } from '@rainver/protocol';
import { buildModuleServer } from './support/moduleServer.js';
import { streamingModule } from '../src/modules/streaming/index.js';
import { agentAttentionModule } from '../src/modules/agentAttention/index.js';
import { loadConfig } from '../src/config.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { readAttentionSnapshot } from '../src/modules/agentAttention/snapshot.js';
import { attentionFrame } from '../src/modules/streaming/agentAttentionStream.js';
import { changeReadState, loadWorks, recordViews } from '../src/modules/agentAttention/readStateService.js';
afterEach(() => __setAuthIdentityForTests(null));
const db = useTestDatabase(import.meta.url);
const space = randomUUID(), user = randomUUID(), project = randomUUID();
beforeEach(async () => { if (!db.available) return; await resetTables(db.pool, ['spaces', 'users'], { cascade: true }); await seedSpaceOwnerProject(db.pool, { space, owner: user, project }) });
describe('global Agent Attention snapshot', () => {
  it('counts the complete personal collection beyond its window, preserves old active work and rechecks revoked membership', async () => {
    const id = await seedAttentionRun(db.pool, { space, owner: user, status: 'running', now: '2026-01-01T00:00:00Z' });
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,ended_at)
      SELECT gen_random_uuid(),space_id,agent_id,agent_version_id,run_type,trigger_origin,'succeeded',mode,runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,now(),now(),execution_kind,now()
      FROM runs CROSS JOIN generate_series(1,10000) WHERE id=$1`, [id]);
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,ended_at,created_at,updated_at)
      SELECT gen_random_uuid(),space_id,id,1,'succeeded',ended_at,created_at,updated_at FROM runs WHERE id<>$1`, [id]);
    const snapshot = await readAttentionSnapshot(db.pool, user);
    expect(snapshot.page.items).toHaveLength(50); expect(snapshot.page.counts.working).toBe(1); expect(snapshot.unread_count).toBe(10000);
    expect(snapshot.signals.size).toBeGreaterThanOrEqual(10000);
    await db.pool.query(`UPDATE space_memberships SET status='revoked' WHERE user_id=$1`, [user]);
    const removed = await readAttentionSnapshot(db.pool, user);
    expect(removed.page.items).toEqual([]); expect(removed.unread_count).toBe(0); expect(removed.signals.size).toBe(0);
  });
  it('reads a silent user snapshot through the HTTP boundary without active Space authority', async () => {
    await seedAttentionRun(db.pool, { space, owner: user });
    __setAuthIdentityForTests({ spaceId: randomUUID(), userId: user });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [agentAttentionModule]);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/me/agent-attention/snapshot' });
      expect(response.statusCode).toBe(200);
      const snapshot = AgentAttentionStreamFrameSchema.parse(response.json());
      expect(snapshot.notices).toEqual([]); expect(snapshot.page?.items[0]?.space_id).toBe(space);
      expect(snapshot.unread_count).toBe(1);
    } finally { await app.close() }
  });
  it('classifies message completion, failure, and personally assigned questions from canonical facts', async () => {
    const id = await seedAttentionRun(db.pool, { space, owner: user });
    const session = randomUUID(), message = randomUUID();
    const { agent_id: agent } = (await db.pool.query('SELECT agent_id FROM runs WHERE id=$1', [id])).rows[0]!;
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,agent_id,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'active',now(),now())`, [session,space,user,agent]);
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [id,session]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
      VALUES($1,$2,$3,$4,'assistant','Visible result','{}',1,'/',$5,now())`, [message,space,session,agent,id]);
    await db.pool.query('UPDATE sessions SET head_message_id=$2 WHERE id=$1', [session,message]);
    expect([...((await readAttentionSnapshot(db.pool,user)).signals.values())].map(value=>value.notice.kind)).toEqual(['finished']);
    await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [id]);
    expect([...((await readAttentionSnapshot(db.pool,user)).signals.values())].map(value=>value.notice.kind)).toEqual(['failed']);
    await db.pool.query(`UPDATE messages SET metadata_json='{"awaiting_answer":true}' WHERE id=$1`, [message]);
    expect([...((await readAttentionSnapshot(db.pool,user)).signals.values())].map(value=>value.notice.kind)).toEqual(['answer']);
  });

  it('does not announce a finished revision again when its question is answered outside Agent Work', async () => {
    const id = await seedAttentionRun(db.pool, { space, owner: user });
    const session = randomUUID(), question = randomUUID(), reply = randomUUID();
    const { agent_id: agent } = (await db.pool.query('SELECT agent_id FROM runs WHERE id=$1', [id])).rows[0]!;
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,agent_id,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'active',now(),now())`, [session,space,user,agent]);
    await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1', [id,session]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
      VALUES($1,$2,$3,$4,'assistant','Which input should I use?','{"awaiting_answer":true}',1,'/',$5,now())`, [question,space,session,agent,id]);
    await db.pool.query('UPDATE sessions SET head_message_id=$2 WHERE id=$1', [session,question]);
    const before = await readAttentionSnapshot(db.pool,user);
    expect([...before.signals.values()]).toMatchObject([{ mine: true, notice: { kind: 'answer' } }]);
    const subject = before.page.items[0]!.read_states[0]!.subject;
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,parent_message_id,path_depth,branch_path,created_at)
      VALUES($1,$2,$3,$4,'user','Use the second input.',$5,2,'/',now())`, [reply,space,session,user,question]);
    await db.pool.query('UPDATE sessions SET head_message_id=$2 WHERE id=$1', [session,reply]);
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      created_at,updated_at,execution_kind,session_id,model_override_json)
      SELECT $1,space_id,agent_id,agent_version_id,run_type,trigger_origin,'running',mode,
      runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,
      now(),now(),execution_kind,session_id,jsonb_build_object('chat_turn',jsonb_build_object('user_message_id',$2::text))
      FROM runs WHERE id=$3`, [randomUUID(),reply,id]);
    const after = await readAttentionSnapshot(db.pool,user);
    expect(after.page.items[0]!.reasons).not.toContainEqual(expect.objectContaining({ kind: 'awaiting_answer' }));
    // Answering is reading: the person's own reply reads the question it answers.
    expect(after.page.items[0]!.read_states).toContainEqual(expect.objectContaining({ subject, unread: false, read_at: null }));
    expect(attentionFrame(after,2,before)).toMatchObject({ type: 'attention.invalidation', notices: [] });
    expect([...after.signals.keys()]).toEqual([...before.signals.keys()]);
    expect((await db.pool.query('SELECT count(*)::int AS count FROM agent_attention_read_states WHERE user_id=$1', [user])).rows[0]!.count).toBe(0);
  });

  it('streams a current window and removes a revoked membership on the next bounded read', async () => {
    await seedAttentionRun(db.pool, { space, owner: user, status: 'running' });
    __setAuthIdentityForTests({ spaceId: space, userId: user });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [streamingModule]);
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${url}/api/v1/me/agent-attention/stream`, { signal: controller.signal });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-store');
      reader = response.body!.getReader();
      const decoder = new TextDecoder(); let pending = '';
      const nextFrame = async () => {
        while (!pending.includes('\n\n')) pending += decoder.decode((await reader!.read()).value, { stream: true });
        const boundary = pending.indexOf('\n\n'); const raw = pending.slice(0,boundary); pending = pending.slice(boundary+2);
        return AgentAttentionStreamFrameSchema.parse(JSON.parse(raw.split('data: ')[1]!));
      };
      const initial = await nextFrame(); expect(initial.type).toBe('attention.snapshot'); expect(initial.page?.items).toHaveLength(1); expect(initial.notices).toEqual([]);
      await db.pool.query(`UPDATE space_memberships SET status='revoked' WHERE user_id=$1`, [user]);
      const removed = await nextFrame(); expect(removed.type).toBe('attention.invalidation'); expect(removed.seq).toBe(2);
      expect(removed.page?.items).toEqual([]); expect(removed.unread_count).toBe(0);
    } finally { controller.abort(); await reader?.cancel().catch(() => {}); await app.close() }
  });

  it('keeps personal decision reminders separate from merely visible review responsibility', async () => {
    const id = await seedAttentionRun(db.pool, { space, owner: user, status: 'waiting_for_review' });
    await db.pool.query(`UPDATE runs SET error_json='{"supervisor_review":true}' WHERE id=$1`, [id]);
    const mine = await readAttentionSnapshot(db.pool,user);
    expect([...mine.signals.values()].map(value => value.notice.kind)).toEqual(['decision']);
    const other = randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at)
      VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
    await db.pool.query(`UPDATE runs SET instructed_by_user_id=$2 WHERE id=$1`, [id,other]);
    const visible = await readAttentionSnapshot(db.pool,user);
    expect(visible.page.items).toHaveLength(1); expect(visible.page.counts.needs_you).toBe(0);
    expect([...visible.signals.values()].map(value=>value.notice.kind)).toEqual([]);
  });
  it('detects a result beyond a collapsed work child window and removes it when its Run is hidden', async () => {
    const session = randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,title,status,created_at,updated_at)
      VALUES($1,$2,$3,'Dense work','active',now(),now())`,[session,space,user]);
    const ids = [];
    for (let index=0;index<101;index++) ids.push(await seedAttentionRun(db.pool,{space,owner:user}));
    await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=ANY($2::varchar[])`,[session,ids]);
    const initial = await readAttentionSnapshot(db.pool,user);
    expect(initial.page.items).toHaveLength(1); expect(initial.page.items[0]!.runs).toHaveLength(100);
    expect(initial.page.items[0]!.visible_run_count).toBe(101); expect(initial.signals.size).toBe(101);
    const hidden = initial.page.items[0]!.runs[0]!.run_id;
    const other = randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at)
      VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
    await db.pool.query(`UPDATE space_memberships SET role='member' WHERE user_id=$1`,[user]);
    await db.pool.query(`UPDATE runs SET owner_user_id=$2,visibility='private' WHERE id=$1`,[hidden,other]);
    const next = await readAttentionSnapshot(db.pool,user);
    expect(next.page.items[0]!.visible_run_count).toBe(100); expect(next.signals.size).toBe(100);
    expect(next.version).not.toBe(initial.version);
  });

  it('keeps a large HTTP SSE window connected through snapshot, heartbeat and invalidation', async () => {
    for (let index=0;index<51;index++) await seedAttentionRun(db.pool,{space,owner:user});
    __setAuthIdentityForTests({spaceId:space,userId:user});
    const app = buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[streamingModule]);
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = await app.listen({host:'127.0.0.1',port:0});
      const response = await fetch(`${url}/api/v1/me/agent-attention/stream`,{signal:controller.signal});
      reader = response.body!.getReader();
      let pending=''; const decoder=new TextDecoder();
      const nextFrame=async()=>{
        while (!pending.includes('\n\n')) {
          const chunk=await reader!.read(); expect(chunk.done,'healthy pressured stream must stay open').toBe(false);
          pending+=decoder.decode(chunk.value,{stream:true});
        }
        const end=pending.indexOf('\n\n'), wire=pending.slice(0,end); pending=pending.slice(end+2);
        return {wire,frame:AgentAttentionStreamFrameSchema.parse(JSON.parse(wire.split('data: ')[1]!))};
      };
      const first=await nextFrame(); expect(first.frame.type).toBe('attention.snapshot');
      expect(first.frame.page?.items).toHaveLength(50); expect(Buffer.byteLength(first.wire)).toBeGreaterThan(70000);
      const heartbeat=await nextFrame(); expect(heartbeat.frame.type).toBe('attention.heartbeat');
      await seedAttentionRun(db.pool,{space,owner:user,status:'running'});
      const changed=await nextFrame(); expect(changed.frame.type).toBe('attention.invalidation'); expect(changed.frame.seq).toBe(3);
      expect(changed.frame.counts?.working).toBe(1); expect(changed.frame.page).toBeNull();
    } finally {controller.abort(); await reader?.cancel().catch(()=>{}); await app.close()}
  },15000);

  const directSession = async (runIds: string[]) => {
    const session = randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())`, [session,space,user]);
    await db.pool.query(`UPDATE runs SET session_id=$1 WHERE id=ANY($2::varchar[])`, [session,runIds]);
    return session;
  };

  it('keeps every frame and child page within the wire caps and pages through every subject', async () => {
    // 120 Runs, each with its own result and pending proposal: 240 subjects, 120 reasons.
    const id = await seedAttentionRun(db.pool, { space, owner: user });
    const session = await directSession([id]);
    await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,ended_at,session_id)
      SELECT gen_random_uuid(),space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,owner_user_id,visibility,created_at,updated_at,execution_kind,ended_at-g*interval '1 second',session_id
      FROM runs CROSS JOIN generate_series(1,119) g WHERE id=$1`, [id]);
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,ended_at,created_at,updated_at)
      SELECT gen_random_uuid(),space_id,id,1,status,ended_at,created_at,updated_at FROM runs WHERE session_id=$1 AND id<>$2`, [session,id]);
    await db.pool.query(`INSERT INTO proposals(id,space_id,created_by_run_id,proposal_type,status,risk_level,urgency,title,payload_json,owner_user_id,created_at,updated_at)
      SELECT gen_random_uuid(),space_id,id,'memory_create','pending','low','normal','Review change','{}',owner_user_id,now(),now() FROM runs WHERE session_id=$1`, [session]);
    __setAuthIdentityForTests({ spaceId: space, userId: user });
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [agentAttentionModule]);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/me/agent-attention/snapshot' });
      expect(response.statusCode, response.body).toBe(200);
      const frame = AgentAttentionStreamFrameSchema.parse(response.json());
      expect(frame.page!.items[0]!.visible_run_count).toBe(120);
      AgentAttentionStreamFrameSchema.parse(attentionFrame(await readAttentionSnapshot(db.pool, user), 1));
      const runs = new Set<string>(), subjects = new Set<string>(), reasons = new Set<string>();
      let cursor: string | null = '', pages = 0;
      while (cursor !== null) {
        const page = await app.inject({ method: 'GET', url: `/api/v1/me/agent-attention/item?space_id=${space}&kind=session&source_id=${session}${cursor ? `&runs_cursor=${cursor}` : ''}` });
        expect(page.statusCode, page.body).toBe(200);
        const item: AgentWorkItem = AgentWorkItemSchema.parse(page.json());
        for (const run of item.runs) runs.add(run.run_id);
        for (const reason of item.reasons) reasons.add(JSON.stringify(reason));
        for (const state of item.read_states) {
          subjects.add(JSON.stringify(state.subject));
          // A subject never arrives before its Run.
          if (state.subject.kind === 'run_result') expect(runs.has(state.subject.run_id)).toBe(true);
        }
        cursor = item.runs_next_cursor; pages++;
      }
      expect(pages).toBeGreaterThan(2);
      expect([runs.size, subjects.size, reasons.size]).toEqual([120, 240, 120]);
    } finally { await app.close() }
  });

  it('announces only genuinely new revisions when old work re-enters the personal window', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const first = await seedAttentionRun(db.pool, { space, owner: user, now: old });
    const second = await seedAttentionRun(db.pool, { space, owner: user, now: old });
    const sessionA = await directSession([first]), sessionB = await directSession([second]);
    const before = await readAttentionSnapshot(db.pool, user);
    // Both ended and read (older than the enablement baseline) and expired from the window.
    expect(before.page.items).toEqual([]); expect(before.signals.size).toBe(2);
    const next = await seedAttentionRun(db.pool, { space, owner: user });
    await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1', [next,sessionA]);
    const resumed = await readAttentionSnapshot(db.pool, user);
    expect(resumed.page.items.map(item => item.identity.source_id)).toEqual([sessionA]);
    const announced = attentionFrame(resumed, 2, before);
    expect(announced.notices).toEqual([expect.objectContaining({ kind: 'finished', work_key: resumed.page.items[0]!.work_key })]);
    // Manual unread from History restores reading state without manufacturing an event.
    const history = (await loadWorks(db.pool, user)).find(item => item.identity.source_id === sessionB)!;
    await changeReadState(db.pool, user, { identity: history.identity, space_id: space, subject: history.read_states[0]!.subject, state_version: 0, action: 'unread' });
    const unread = await readAttentionSnapshot(db.pool, user);
    expect(unread.page.items.map(item => item.identity.source_id).sort()).toEqual([sessionA, sessionB].sort());
    expect(attentionFrame(unread, 3, resumed)).toMatchObject({ type: 'attention.invalidation', notices: [] });
  });

  it('keeps an archived conversation\'s read reply read and silent', async () => {
    const id = await seedAttentionRun(db.pool, { space, owner: user });
    const session = await directSession([id]), message = randomUUID();
    const { agent_id: agent } = (await db.pool.query('SELECT agent_id FROM runs WHERE id=$1', [id])).rows[0]!;
    await db.pool.query(`UPDATE sessions SET agent_id=$2 WHERE id=$1`, [session,agent]);
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,sender_agent_id,role,content,metadata_json,path_depth,branch_path,run_id,created_at)
      VALUES($1,$2,$3,$4,'assistant','Done.','{}',1,'/',$5,now())`, [message,space,session,agent,id]);
    await db.pool.query('UPDATE sessions SET head_message_id=$2 WHERE id=$1', [session,message]);
    expect((await readAttentionSnapshot(db.pool, user)).unread_count).toBe(1);
    expect((await recordViews(db.pool, user, { space_id: space, session_id: session, message_ids: [message] })).read_count).toBe(1);
    const read = await readAttentionSnapshot(db.pool, user);
    expect(read.unread_count).toBe(0);
    await db.pool.query(`UPDATE sessions SET status='archived' WHERE id=$1`, [session]);
    const archived = await readAttentionSnapshot(db.pool, user);
    // The reply falls back to a Run result under a `run` identity; it is the same, already-read reply.
    const [work] = await loadWorks(db.pool, user);
    expect(work).toMatchObject({ identity: { kind: 'run', source_id: id }, unread: false, read_states: [{ subject: { kind: 'run_result', run_id: id }, unread: false }] });
    expect(archived.unread_count).toBe(0); expect(archived.page.counts.recently_finished).toBe(0);
    expect(attentionFrame(archived, 2, read).notices).toEqual([]);
  });

});
