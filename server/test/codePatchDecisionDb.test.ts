import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {tryWithDedicatedSessionAdvisoryLock} from '../src/db/advisoryLock.js';
import { SYSTEM_ACTION_REGISTRY } from '@rainver/protocol';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedServerHost,seedSpaceMember } from './support/domainSeeds.js';
import {lockProposalTransitions} from '../src/modules/systemActions/operations/proposalTransitions.js';
import { linkProposalOperation } from './support/linkedProposalOperation.js';
import { insertProposalRow } from '../src/modules/proposals/reviewPackets.js';
import { PgProposalApplyService } from '../src/modules/proposals/applyService.js';
import { operationProposalService } from '../src/modules/systemActions/operations/approvals.js';
import { createDefaultProposalApplierRegistry } from '../src/modules/proposals/applierRegistry.js';
import type { OperationRegistration } from '../src/modules/systemActions/operations/types.js';
import { executeCodePatchDecision, recoverCodePatchDecisions,registerCodePatchDecisionHandler } from '../src/modules/projectFolders/codePatchDecision.js';
import { CodePatchFileTransaction } from '../src/modules/projectFolders/codePatch.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {PgProposalRepository} from '../src/modules/proposals/repository.js';
import { loadConfig } from '../src/config.js';
const db = useTestDatabase(import.meta.filename);
const space = randomUUID(),
  owner = randomUUID(),
  project = randomUUID(),
  folder = randomUUID(),
  host = randomUUID();
const identity = {
  spaceId: space,
  userId: owner
};
let root = '';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const config = () => loadConfig({
  SERVER_DATABASE_URL: db.connectionUri,
  SERVER_WORKSPACE_ROOT: root
});
const service = () => PgProposalApplyService.fromConfig(config());
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users', 'hosts'], {
    cascade: true
  });
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner,
    project
  });
  await seedServerHost(db.pool, {
    id: host
  });
  root = await mkdtemp(join(tmpdir(), 'standalone-effects-'));
  await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,status,kind,protected,system_managed,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'Effects','active','code',false,false,$4,now(),now())", [folder, space, project, owner]);
  await db.pool.query("INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,root_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'server',$5,true,'active',now(),now())", [randomUUID(), space, folder, host, root]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, {
    recursive: true,
    force: true
  });
  root = '';
});
async function fixture() {
  await writeFile(join(root, 'one.txt'), 'before');
  return insertProposalRow(db.pool, {
    spaceId: space,
    projectId: project,
    projectFolderId: folder,
    proposalType: 'code_patch',
    title: 'Standalone patch',
    payload: {
      patch: {
        operations: [{
          type: 'replace_file',
          path: 'one.txt',
          content: 'after',
          preimage_exists: true,
          preimage_sha256: hash('before')
        }, {
          type: 'replace_file',
          path: 'new.txt',
          content: 'new',
          preimage_exists: false,
          preimage_sha256: null
        }]
      },
      incomplete_patch: false
    },
    rationale: 'test',
    createdByUserId: owner,
    visibility: 'private',
    riskLevel: 'high',
    requiredApproverRole: 'owner'
  });
}
async function enqueue(s = service()) {
  const p = await fixture(),
    out = await s.accept(p.id, identity);
  expect(out?.result_type).toBe('code_patch_pending');
  if (out?.result_type !== 'code_patch_pending') throw Error('pending required');
  return {
    p,
    out,
    id: out.result.id,
    s
  };
}
async function state(id: string) {
  return (await db.pool.query('SELECT * FROM code_patch_decisions WHERE id=$1', [id])).rows[0];
}
async function failTrigger(table: string, condition: string) {
  await db.pool.query(`CREATE OR REPLACE FUNCTION refuse_patch_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'write refused'; END IF; RETURN NEW; END $$`);
  await db.pool.query(`CREATE TRIGGER refuse_patch_write BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_patch_write()`);
}
async function clearTrigger(table: string) {
  await db.pool.query(`DROP TRIGGER IF EXISTS refuse_patch_write ON ${table}`);
  await db.pool.query('DROP FUNCTION IF EXISTS refuse_patch_write()');
}
function mapped(id: string) {
  const base = SYSTEM_ACTION_REGISTRY.find(d => d.id === 'project.propose_definition')!;
  const r: OperationRegistration = {
    definition: {
      ...base,
      id: 'fixture.proposal',
      version: 1,
      input_schema: z.record(z.unknown()),
      output_schema: z.record(z.unknown())
    },
    resolve: async () => ({
      authority: `project:${project}`,
      targets: {
        project_id: project
      },
      resourceType: 'proposal',
      resourceId: id
    }),
    authorize: async () => {},
    execute: async () => {
      throw Error('no duplicate executor');
    },
    approval: {
      mode: 'proposal_submission',
      proposalType: 'code_patch',
      gate: {
        kind: 'hard_gate',
        gate_class: 'direction'
      },
      atomicStatusWritersVerified: true,
      create: async () => {
        throw Error('no copied approval');
      },
      preconditions: async () => ({})
    }
  };
  return operationProposalService(config(), createDefaultProposalApplierRegistry(), new Map([['fixture.proposal', r]]));
}
describe('standalone code patch durable decision boundary', () => {
  it('queues without file IO, applies once with an actual receipt, then durably restores original and absent files', async () => {
    if (!db.available) return;
    const f = await enqueue();
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    expect(f.out.proposal.status).toBe('pending');
    expect((await f.s.accept(f.p.id, identity))?.result_type).toBe('code_patch_pending');
    expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1', ['code_patch_decision'])).rows).toHaveLength(1);
    await executeCodePatchDecision(config(), f.id, space);
    await executeCodePatchDecision(config(), f.id, space);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('after');
    expect((await state(f.id)).status).toBe('succeeded');
    expect((await f.s.accept(f.p.id, identity))?.result_type).toBe('code_patch_apply');
    const rollback = await f.s.rollback(f.p.id, identity);
    expect(rollback?.status).toBe('pending');
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('after');
    await executeCodePatchDecision(config(), rollback!.id, space);
    await executeCodePatchDecision(config(), rollback!.id, space);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    await expect(readFile(join(root, 'new.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect((await f.s.rollback(f.p.id, identity))?.status).toBe('succeeded');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [f.p.id])).rows[0].status).toBe('rolled_back');
    expect((await db.pool.query("SELECT id FROM activity_records WHERE payload_json->>'proposal_id'=$1 AND activity_type='proposal.code_patch.applied'", [f.p.id])).rows).toHaveLength(1);
  });
  it.each(['jobs', 'policy_decision_records'])('rolls back the required intent when %s storage fails', async table => {
    if (!db.available) return;
    const p = await fixture();
    await failTrigger(table, 'true');
    try {
      await expect(service().accept(p.id, identity)).rejects.toThrow();
    } finally {
      await clearTrigger(table);
    }
    expect((await db.pool.query('SELECT id FROM code_patch_decisions')).rows).toHaveLength(0);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
  });
  it.each(['code_patch_decisions', 'operation_idempotency'])('keeps linked request pending and compensates files when %s final storage fails', async table => {
    if (!db.available) return;
    const p = await fixture(),
      request = await linkProposalOperation(db.pool, identity, p.id),
      s = mapped(p.id),
      out = await s.accept(p.id, identity);
    if (out?.result_type !== 'code_patch_pending') throw Error('pending');
    await failTrigger(table, table === 'code_patch_decisions' ? "NEW.status='succeeded'" : "NEW.state='succeeded'");
    try {
      await expect(executeCodePatchDecision(config(), out.result.id, space, undefined, s)).rejects.toThrow();
    } finally {
      await clearTrigger(table);
    }
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [p.id])).rows[0].status).toBe('pending');
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1', [request])).rows[0].state).toBe('pending_approval');
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    expect((await state(out.result.id)).status).toBe('failed');
    expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE metadata_json->>'operation_outcome'='failed'")).rows.length).toBeGreaterThan(0);
  });
  it('atomically publishes linked success only after real effects, preserving the same receipt on replay', async () => {
    if (!db.available) return;
    const p = await fixture(),
      request = await linkProposalOperation(db.pool, identity, p.id),
      s = mapped(p.id),
      out = await s.accept(p.id, identity);
    if (out?.result_type !== 'code_patch_pending') throw Error('pending');
    await executeCodePatchDecision(config(), out.result.id, space, undefined, s);
    const first = (await db.pool.query('SELECT * FROM operation_idempotency WHERE id=$1', [request])).rows[0];
    expect(first.state).toBe('succeeded');
    const rollback = await s.rollback(p.id, identity);
    await executeCodePatchDecision(config(), rollback!.id, space, undefined, s);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    await executeCodePatchDecision(config(), out.result.id, space, undefined, s);
    expect((await db.pool.query('SELECT * FROM operation_idempotency WHERE id=$1', [request])).rows[0].result_json).toEqual(first.result_json);
    expect((await state(out.result.id)).result_json.result_type).toBe('code_patch_apply');
  });
  it('rechecks current authority before effects and rejects foreign Space without revealing a decision', async () => {
    if (!db.available) return;
    const f = await enqueue();
    await expect(f.s.accept(f.p.id, {
      ...identity,
      spaceId: randomUUID()
    })).resolves.toBeNull();
    await db.pool.query('DELETE FROM space_memberships WHERE space_id=$1 AND user_id=$2', [space, owner]);
    await expect(executeCodePatchDecision(config(), f.id, space)).rejects.toThrow();
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    expect((await state(f.id)).status).toBe('failed');
  });
  it('recovers a lost effect receipt exactly, and performs no filesystem effects in a DB transaction', async () => {
    if (!db.available) return;
    const f = await enqueue();
    const original = CodePatchFileTransaction.prototype.applyPrepared;
    let interrupted = true;
    vi.spyOn(CodePatchFileTransaction.prototype, 'applyPrepared').mockImplementation(async function (this: CodePatchFileTransaction, ...args) {
      const active = await db.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%code_patch_decisions%'");
      expect(active.rows).toHaveLength(0);
      const result = await original.apply(this, args);
      if (interrupted) {
        interrupted = false;
        throw Error('lost receipt');
      }
      return result;
    });
    await expect(executeCodePatchDecision(config(), f.id, space)).rejects.toThrow('lost receipt');
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    // Explicit user retry is a new Job on the same frozen intent, never copied approval.
    await db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [f.out.result.job_id]);
    expect((await f.s.accept(f.p.id, identity))?.result_type).toBe('code_patch_pending');
    await executeCodePatchDecision(config(), f.id, space);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('after');
  });
  it('hides a private same-Space target before trying its busy linked keys for either decision phase',async()=>{if(!db.available)return;
    const p=await fixture(),visitor=randomUUID();await seedSpaceMember(db.pool,{space,user:visitor});await linkProposalOperation(db.pool,identity,p.id);
    const holder=await db.pool.connect();await holder.query('BEGIN');await lockProposalTransitions(holder,space,[p.id],true);
    try{
      const outsider={spaceId:space,userId:visitor};
      await expect(service().accept(p.id,outsider)).resolves.toBeNull();
      await expect(service().rollback(p.id,outsider)).resolves.toBeNull();
      expect((await db.pool.query('SELECT id FROM code_patch_decisions')).rows).toHaveLength(0);
    }finally{await holder.query('ROLLBACK');holder.release();}
  });
  it('runs the production Job consumer and exposes only the deciding user receipt on the existing Proposal read',async()=>{if(!db.available)return;
    const f=await enqueue(),registry=new JobHandlerRegistry();registerCodePatchDecisionHandler(registry,config());
    expect((await new JobWorker(new PgJobQueueRepository(db.pool),registry,'patch-worker',['code_patch_decision']).processOne()).status).toBe('completed');
    const p=await new PgProposalRepository(db.pool).getVisible(space,owner,f.p.id);
    expect(p?.status).toBe('accepted');expect(p?.code_patch_decision?.status).toBe('succeeded');
    expect((await state(f.id)).result_json.proposal.code_patch_decision.status).toBe('succeeded');
  });
  it('compensates if current authority is revoked between the external effect and final decision',async()=>{if(!db.available)return;
    const f=await enqueue(),original=CodePatchFileTransaction.prototype.applyPrepared;
    vi.spyOn(CodePatchFileTransaction.prototype,'applyPrepared').mockImplementation(async function(this:CodePatchFileTransaction,...args){const result=await original.apply(this,args);await db.pool.query('DELETE FROM space_memberships WHERE space_id=$1 AND user_id=$2',[space,owner]);return result;});
    await expect(executeCodePatchDecision(config(),f.id,space)).rejects.toThrow();
    expect(await readFile(join(root,'one.txt'),'utf8')).toBe('before');expect((await state(f.id)).status).toBe('failed');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[f.p.id])).rows[0].status).toBe('pending');
  });
  it('serializes overlapping workers on the durable decision gate without duplicate effects or receipts', async () => {
    if (!db.available) return;
    const f = await enqueue(),
      original = CodePatchFileTransaction.prototype.applyPrepared;
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(r => release = r),
      started = new Promise<void>(r => entered = r);
    let calls = 0;
    vi.spyOn(CodePatchFileTransaction.prototype, 'applyPrepared').mockImplementation(async function (this: CodePatchFileTransaction, ...args) {
      calls++;
      entered();
      await blocked;
      return original.apply(this, args);
    });
    const first = executeCodePatchDecision(config(), f.id, space);
    await started;
    await expect(executeCodePatchDecision(config(), f.id, space)).rejects.toMatchObject({
      name: 'JobDeferredError'
    });
    release();
    await first;
    expect(calls).toBe(1);
    await executeCodePatchDecision(config(), f.id, space);
    expect(calls).toBe(1);
    expect((await db.pool.query('SELECT id FROM code_patch_snapshots WHERE proposal_id=$1', [f.p.id])).rows).toHaveLength(1);
  });
  it('does not redirect a frozen intent after a pending payload revision', async () => {
    if (!db.available) return;
    const f = await enqueue();
    await db.pool.query(`UPDATE proposals SET payload_json=jsonb_set(payload_json,'{patch,operations,0,content}','"different"'::jsonb) WHERE id=$1`, [f.p.id]);
    expect(await executeCodePatchDecision(config(), f.id, space)).toMatchObject({status:'failed'});
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    expect((await state(f.id)).status).toBe('failed');
  });
  it.each(['frozen','policy'])('settles a definitive final %s refusal after one write/compensation, including repeated handler delivery',async(kind)=>{
    if(!db.available)return;
    const f=await enqueue(),original=CodePatchFileTransaction.prototype.applyPrepared;
    const writes=vi.spyOn(CodePatchFileTransaction.prototype,'applyPrepared').mockImplementation(async function(this:CodePatchFileTransaction,...args){const result=await original.apply(this,args);
      if(kind==='frozen')await db.pool.query(`UPDATE proposals SET payload_json=jsonb_set(payload_json,'{patch,operations,0,content}','"different"'::jsonb) WHERE id=$1`,[f.p.id]);
      else {const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,other]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);}
      return result;
    });
    const registry=new JobHandlerRegistry();registerCodePatchDecisionHandler(registry,config());
    const worker=new JobWorker(new PgJobQueueRepository(db.pool),registry,'refusal-worker',['code_patch_decision']);
    expect((await worker.processOne()).status).toBe('completed');
    expect((await state(f.id)).status).toBe('failed');expect(await readFile(join(root,'one.txt'),'utf8')).toBe('before');
    expect((await worker.processOne()).status).toBe('idle');
    await registry.dispatch({job_id:f.out.result.job_id!,space_id:space,user_id:owner,job_type:'code_patch_decision',attempts:2,max_attempts:5,worker_id:'refusal-worker',payload:{decision_id:f.id}});
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await db.pool.query('SELECT id FROM proposal_approvals WHERE proposal_id=$1',[f.p.id])).rows).toHaveLength(0);
    const audits=(await db.pool.query("SELECT id,metadata_json FROM policy_decision_records WHERE proposal_id=$1 AND metadata_json->>'decision_phase'='worker_commit'",[f.p.id])).rows;
    if(kind==='policy')expect(audits).toHaveLength(1);
    for(const audit of audits)expect(audit.metadata_json).toMatchObject({decision_id:f.id,operation_outcome:'failed'});
    expect(new Set(audits.map(a=>a.id)).size).toBe(audits.length);
  });
  it('refuses failed fingerprint A while B is active before enqueue or state change',async()=>{if(!db.available)return;
    const f=await enqueue();await db.pool.query("UPDATE code_patch_decisions SET status='failed' WHERE id=$1",[f.id]);await db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1",[f.out.result.job_id]);
    const b=await f.s.accept(f.p.id,identity,{confirmIncompletePatch:true});if(b?.result_type!=='code_patch_pending')throw Error('pending');
    const before=(await db.pool.query('SELECT id,status,job_id FROM code_patch_decisions ORDER BY id')).rows;
    const outcomes=await Promise.allSettled([f.s.accept(f.p.id,identity),f.s.accept(f.p.id,identity)]);
    for(const result of outcomes){expect(result.status).toBe('rejected');if(result.status==='rejected')expect(result.reason).toMatchObject({statusCode:409});}
    expect((await db.pool.query('SELECT id,status,job_id FROM code_patch_decisions ORDER BY id')).rows).toEqual(before);
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='code_patch_decision'")).rows).toHaveLength(2);
  });
  it('defers busy-folder cleanup without consuming attempts or claiming operator repair',async()=>{if(!db.available)return;
    const f=await enqueue(),row=await state(f.id),effect=row.effect_json;
    effect.before=await new CodePatchFileTransaction(root,false).prepare(effect.operations);await new CodePatchFileTransaction(root,false).applyPrepared(effect.operations,effect.before);
    await db.pool.query("UPDATE code_patch_decisions SET status='compensating',effect_json=$2::jsonb WHERE id=$1",[f.id,JSON.stringify(effect)]);
    const registry=new JobHandlerRegistry();registerCodePatchDecisionHandler(registry,config());const worker=new JobWorker(new PgJobQueueRepository(db.pool),registry,'cleanup-worker',['code_patch_decision']);
    await tryWithDedicatedSessionAdvisoryLock(db.pool,`code-patch-folder:${folder}`,async()=>{
      expect((await worker.processOne()).status).toBe('deferred');expect((await state(f.id)).status).toBe('compensating');
      expect((await db.pool.query('SELECT attempts FROM jobs WHERE id=$1',[f.out.result.job_id])).rows[0].attempts).toBe(0);
      await recoverCodePatchDecisions(config());expect((await state(f.id)).status).toBe('compensating');
      expect(await readFile(join(root,'one.txt'),'utf8')).toBe('after');
    });
    await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[f.out.result.job_id]);
    expect((await worker.processOne()).status).toBe('completed');expect((await state(f.id)).status).toBe('failed');expect(await readFile(join(root,'one.txt'),'utf8')).toBe('before');
  });
  it('recovers orphan effects via a required cleanup Job; cleanup never overwrites an unrelated edit', async () => {
    if (!db.available) return;
    const f = await enqueue();
    const row = await state(f.id),
      effect = row.effect_json;
    effect.before = await new CodePatchFileTransaction(root, false).prepare(effect.operations);
    await new CodePatchFileTransaction(root, false).applyPrepared(effect.operations, effect.before);
    await db.pool.query("UPDATE code_patch_decisions SET status='applying',effect_json=$2::jsonb WHERE id=$1", [f.id, JSON.stringify(effect)]);
    await db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [f.out.result.job_id]);
    await recoverCodePatchDecisions(config());
    const pending = await state(f.id);
    expect(pending.status).toBe('compensating');
    expect(pending.job_id).not.toBe(f.out.result.job_id);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('after');
    await writeFile(join(root, 'one.txt'), 'unrelated');
    await expect(executeCodePatchDecision(config(), f.id, space)).rejects.toThrow();
    expect((await state(f.id)).status).toBe('compensation_failed');
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('unrelated');
  });
});
