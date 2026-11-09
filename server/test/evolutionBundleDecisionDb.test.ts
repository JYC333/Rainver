import { z } from 'zod';
import { SYSTEM_ACTION_REGISTRY } from '@rainver/protocol';
import { operationProposalService } from '../src/modules/systemActions/operations/approvals.js';
import { createDefaultProposalApplierRegistry } from '../src/modules/proposals/applierRegistry.js';
import type { OperationRegistration } from '../src/modules/systemActions/operations/types.js';
import { linkProposalOperation } from './support/linkedProposalOperation.js';
import { buildModuleServer } from './support/moduleServer.js';
import { registerEvolutionBundleRoutes } from '../src/modules/evolution/bundleRoutes.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedServerHost } from './support/domainSeeds.js';
import { insertProposalRow } from '../src/modules/proposals/reviewPackets.js';
import { PgProposalApplyService } from '../src/modules/proposals/applyService.js';
import { EvolutionBundleRepository } from '../src/modules/evolution/bundleRepository.js';
import { registerBundleDecisionHandler, executeBundleDecision, recoverBundleDecisionJobs } from '../src/modules/evolution/bundleDecisionJob.js';
import { EVOLUTION_BUNDLE_DECISION_JOB, type BundleDecisionRow } from '../src/modules/evolution/bundleDecisionTypes.js';
import { CodePatchFileTransaction } from '../src/modules/projectFolders/codePatch.js';
import { JobHandlerRegistry } from '../src/modules/jobs/handlerRegistry.js';
import { JobWorker } from '../src/modules/jobs/worker.js';
import { PgJobQueueRepository } from '../src/modules/jobs/repository.js';
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
  root = await mkdtemp(join(tmpdir(), 'bundle-effects-'));
  await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,status,kind,protected,system_managed,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'Effects','active','code',false,false,$4,now(),now())", [folder, space, project, owner]);
  await db.pool.query("INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,root_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'server',$5,true,'active',now(),now())", [randomUUID(), space, folder, host, root]);
});
afterEach(async () => {
  if (root) await rm(root, {
    recursive: true,
    force: true
  });
  root = '';
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function config() {
  return loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_WORKSPACE_ROOT: root
  });
}
function service() {
  return PgProposalApplyService.fromConfig(config());
}
function bundles() {
  return new EvolutionBundleRepository(db.pool);
}
function worker() {
  const registry = new JobHandlerRegistry();
  registerBundleDecisionHandler(registry, config());
  return new JobWorker(new PgJobQueueRepository(db.pool), registry, 'bundle-test', [EVOLUTION_BUNDLE_DECISION_JOB]);
}
async function fixture(secondPatch = false) {
  await writeFile(join(root, 'one.txt'), 'before');
  const patch = await insertProposalRow(db.pool, {
    spaceId: space,
    projectId: project,
    projectFolderId: folder,
    proposalType: 'code_patch',
    title: 'Patch one',
    payload: {
      patch: {
        operations: [{
          type: 'replace_file',
          path: 'one.txt',
          content: 'after',
          preimage_exists: true,
          preimage_sha256: hash('before')
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
  const memory = await insertProposalRow(db.pool, {
    spaceId: space,
    proposalType: 'memory_create',
    title: 'Bundle memory',
    payload: {
      proposed_content: 'Canonical B10 memory',
      provenance_entries: [{
        source_type: 'user_confirmation',
        source_id: owner,
        source_trust: 'user_confirmed'
      }]
    },
    rationale: 'test',
    createdByUserId: owner,
    visibility: 'private',
    riskLevel: 'low'
  });
  const ids = [patch.id, memory.id];
  if (secondPatch) {
    await writeFile(join(root, 'two.txt'), 'second before');
    const p = await insertProposalRow(db.pool, {
      spaceId: space,
      projectId: project,
      projectFolderId: folder,
      proposalType: 'code_patch',
      title: 'Patch two',
      payload: {
        patch: {
          operations: [{
            type: 'replace_file',
            path: 'two.txt',
            content: 'second after',
            preimage_exists: true,
            preimage_sha256: hash('second before')
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
    ids.push(p.id);
  }
  const bundle = await bundles().create(identity, {
    title: 'Mixed decision',
    proposalIds: ids
  });
  const decisions = ids.map(proposalId => ({
    proposalId,
    decision: 'approve' as const
  }));
  return {
    bundle: String(bundle.id),
    patch: patch.id,
    memory: memory.id,
    ids,
    decisions
  };
}
async function intent(bundle: string) {
  return (await db.pool.query<BundleDecisionRow>('SELECT * FROM evolution_bundle_decisions WHERE bundle_id=$1', [bundle])).rows[0]!;
}
async function pending(ids: string[]) {
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=ANY($1::varchar[])', [ids])).rows.map(r => r.status)).toEqual(ids.map(() => 'pending'));
  expect((await db.pool.query('SELECT id FROM memory_entries WHERE space_id=$1', [space])).rows).toHaveLength(0);
}
describe('durable mixed bundle intent and canonical commit', () => {
  it('queues without IO, commits mixed members once and replays the retained receipt', async () => {
    if (!db.available) return;
    const f = await fixture();
    const queued = await bundles().decide(identity, f.bundle, f.decisions, service());
    expect(queued.decision).toMatchObject({
      status: 'pending'
    });
    await pending(f.ids);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    const original = CodePatchFileTransaction.prototype.applyPrepared;
    const effect = vi.spyOn(CodePatchFileTransaction.prototype, 'applyPrepared').mockImplementation(async function (this: CodePatchFileTransaction, ...args) {
      const transactions = (await db.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows;
      expect(transactions).toHaveLength(0);
      return original.apply(this, args);
    });
    const legacy = vi.spyOn(CodePatchFileTransaction.prototype, 'apply');
    try {
      const outcome = await worker().processOne();
      expect(outcome, (await intent(f.bundle)).error ?? 'bundle outcome').toMatchObject({
        status: 'completed'
      });
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      effect.mockRestore();
      legacy.mockRestore();
    }
    const first = await intent(f.bundle);
    expect(first.status).toBe('succeeded');
    expect(first.result_json).toMatchObject({
      status: 'succeeded',
      bundle_id: f.bundle
    });
    expect((await bundles().get(identity, f.bundle))?.status).toBe('applied');
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('after');
    const inode = (await stat(join(root, 'one.txt'))).ino;
    expect((await db.pool.query('SELECT id FROM memory_entries WHERE space_id=$1', [space])).rows).toHaveLength(1);
    await bundles().decide(identity, f.bundle, f.decisions, service());
    await executeBundleDecision(config(), first.id, space);
    expect((await stat(join(root, 'one.txt'))).ino).toBe(inode);
    expect((await db.pool.query('SELECT id FROM evolution_bundle_decisions')).rows).toHaveLength(1);
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type=$1", [EVOLUTION_BUNDLE_DECISION_JOB])).rows).toHaveLength(1);
    expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM code_patch_snapshots WHERE proposal_id=$1', [f.patch])).rows).toHaveLength(1);
  });
  it('formal HTTP decision returns 202 with safe pending receipt, then GET returns the committed receipt', async () => {
    if (!db.available) return;
    const f = await fixture();
    __setAuthIdentityForTests({
      spaceId: space,
      userId: owner
    });
    const app = buildModuleServer(config(), [{
      name: 'evolution',
      registerRoutes: registerEvolutionBundleRoutes
    }]);
    try {
      const queued = await app.inject({
        method: 'POST',
        url: `/api/v1/evolution/bundles/${f.bundle}/decide`,
        payload: {
          decisions: f.decisions.map(d => ({
            proposal_id: d.proposalId,
            decision: d.decision
          }))
        }
      });
      expect(queued.statusCode).toBe(202);
      expect(queued.json().decision).toMatchObject({
        status: 'pending',
        member_ids: f.ids
      });
      expect(JSON.stringify(queued.json())).not.toContain(root);
      expect(await worker().processOne()).toMatchObject({
        status: 'completed'
      });
      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/evolution/bundles/${f.bundle}`
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().decision).toMatchObject({
        status: 'succeeded'
      });
    } finally {
      await app.close();
      __setAuthIdentityForTests(null);
    }
  });
  it.each([{
    refuse: false,
    linkedPatch: false
  }, {
    refuse: true,
    linkedPatch: false
  }, {
    refuse: false,
    linkedPatch: true
  }, {
    refuse: true,
    linkedPatch: true
  }])('mixed worker keeps linked requests/results atomic (receipt refusal=$refuse, linked patch=$linkedPatch)', async ({
    refuse,
    linkedPatch
  }) => {
    if (!db.available) return;
    const f = await fixture();
    const linkedId = linkedPatch ? f.patch : f.memory,
      linkedProject = linkedPatch ? project : null;
    const request = await linkProposalOperation(db.pool, identity, linkedId);
    // Test-only mapping using the P1 transition port and real canonical Memory
    // applier. No production flag, writer, role or durable dependency is mocked.
    const base = SYSTEM_ACTION_REGISTRY.find(d => d.id === 'project.propose_definition')!;
    const registration: OperationRegistration = {
      definition: {
        ...base,
        id: 'fixture.proposal',
        version: 1,
        policy_action: base.policy_action,
        input_schema: z.record(z.unknown()),
        output_schema: z.record(z.unknown())
      },
      resolve: async () => ({
        authority: linkedProject ? `project:${project}` : `space:${space}`,
        targets: {
          project_id: linkedProject
        },
        resourceType: 'proposal',
        resourceId: linkedId
      }),
      authorize: async () => {},
      execute: async () => {
        throw new Error('no second executor');
      },
      approval: {
        mode: 'proposal_submission',
        proposalType: linkedPatch ? 'code_patch' : 'memory_create',
        gate: {
          kind: 'hard_gate',
          gate_class: 'direction'
        },
        atomicStatusWritersVerified: true,
        create: async () => {
          throw new Error('no copied approval');
        },
        preconditions: async () => ({})
      }
    };
    const mapped = operationProposalService(config(), createDefaultProposalApplierRegistry(), new Map([['fixture.proposal', registration]]));
    await bundles().decide(identity, f.bundle, f.decisions, mapped);
    if (refuse) {
      await db.pool.query("CREATE FUNCTION refuse_bundle_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'receipt refused'; END IF; RETURN NEW; END $$");
      await db.pool.query('CREATE TRIGGER refuse_bundle_receipt BEFORE UPDATE ON evolution_bundle_decisions FOR EACH ROW EXECUTE FUNCTION refuse_bundle_receipt()');
    }
    const factory = vi.spyOn(PgProposalApplyService, 'fromConfig').mockReturnValue(mapped);
    try {
      const outcome = await worker().processOne();
      expect(outcome, (await intent(f.bundle)).error ?? 'mapped outcome').toMatchObject({
        status: refuse ? 'failed' : 'completed'
      });
      const row = (await db.pool.query('SELECT state,result_json FROM operation_idempotency WHERE id=$1', [request])).rows[0];
      expect(row.state).toBe(refuse ? 'pending_approval' : 'succeeded');
      if (refuse) {
        await pending(f.ids);
        expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
      } else {
        expect(row.result_json).toMatchObject({
          status: 'succeeded'
        });
        if (!linkedPatch) expect(row.result_json.data).toMatchObject({
          memory: {
            content: 'Canonical B10 memory'
          }
        });
        expect((await intent(f.bundle)).status).toBe('succeeded');
      }
    } finally {
      factory.mockRestore();
      if (refuse) {
        await db.pool.query('DROP TRIGGER refuse_bundle_receipt ON evolution_bundle_decisions');
        await db.pool.query('DROP FUNCTION refuse_bundle_receipt()');
      }
    }
  });
  it('uses the existing bounded Job retry after compensated commit failure without creating another approval/intent', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    const first = await intent(f.bundle);
    await db.pool.query("CREATE FUNCTION refuse_first_bundle_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'first commit refused'; END IF; RETURN NEW; END $$");
    await db.pool.query('CREATE TRIGGER refuse_first_bundle_commit BEFORE UPDATE ON evolution_bundle_decisions FOR EACH ROW EXECUTE FUNCTION refuse_first_bundle_commit()');
    try {
      expect(await worker().processOne()).toMatchObject({
        status: 'failed'
      });
      await pending(f.ids);
      expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    } finally {
      await db.pool.query('DROP TRIGGER refuse_first_bundle_commit ON evolution_bundle_decisions');
      await db.pool.query('DROP FUNCTION refuse_first_bundle_commit()');
    }
    expect((await db.pool.query('SELECT status,attempts FROM jobs WHERE id=$1', [first.job_id])).rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1
    });
    await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 minute' WHERE id=$1", [first.job_id]);
    expect(await worker().processOne()).toMatchObject({
      status: 'completed'
    });
    expect(await intent(f.bundle)).toMatchObject({
      id: first.id,
      status: 'succeeded',
      job_id: first.job_id
    });
    expect((await db.pool.query('SELECT attempts FROM jobs WHERE id=$1', [first.job_id])).rows[0].attempts).toBe(2);
    expect((await db.pool.query('SELECT id FROM evolution_bundle_decisions')).rows).toHaveLength(1);
    expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(0);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('after');
  });
  it('explicit resubmission after Job exhaustion reuses the frozen intent and canonical permission checks', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    const first = await intent(f.bundle);
    await db.pool.query("CREATE FUNCTION refuse_all_bundle_commits() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'commit unavailable'; END IF; RETURN NEW; END $$");
    await db.pool.query('CREATE TRIGGER refuse_all_bundle_commits BEFORE UPDATE ON evolution_bundle_decisions FOR EACH ROW EXECUTE FUNCTION refuse_all_bundle_commits()');
    try {
      for (let attempt = 0; attempt < 5; attempt++) expect(await worker().processOne()).toMatchObject({
        status: 'failed'
      });
    } finally {
      await db.pool.query('DROP TRIGGER refuse_all_bundle_commits ON evolution_bundle_decisions');
      await db.pool.query('DROP FUNCTION refuse_all_bundle_commits()');
    }
    expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1', [first.job_id])).rows[0].status).toBe('failed');
    expect((await bundles().decide(identity, f.bundle, f.decisions, service())).decision).toMatchObject({
      id: first.id,
      status: 'pending'
    });
    await bundles().decide(identity, f.bundle, f.decisions, service());
    expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1', [EVOLUTION_BUNDLE_DECISION_JOB])).rows).toHaveLength(2);
    expect(await worker().processOne()).toMatchObject({
      status: 'completed'
    });
    expect((await intent(f.bundle)).id).toBe(first.id);
    expect((await db.pool.query('SELECT id FROM proposal_approvals')).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM memory_entries WHERE space_id=$1', [space])).rows).toHaveLength(1);
  });
  it('revoked decision authority fails before external IO and cannot approve any member', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2", [space, owner]);
    expect(await worker().processOne()).toMatchObject({
      status: 'failed'
    });
    await pending(f.ids);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    expect((await intent(f.bundle)).status).toBe('failed');
  });
  it('recovers lost effect receipt without rewriting already applied content', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    const row = await intent(f.bundle),
      effect = row.effects_json[f.patch]!;
    const files = new CodePatchFileTransaction(effect.root, effect.protectedFolder);
    effect.before = await files.prepare(effect.operations);
    await db.pool.query("UPDATE evolution_bundle_decisions SET status='applying',effects_json=$2::jsonb WHERE id=$1", [row.id, JSON.stringify(row.effects_json)]);
    await files.applyPrepared(effect.operations, effect.before);
    const inode = (await stat(join(root, 'one.txt'))).ino;
    // Durable boundary is real PG + file IO, emulating death before receipt storage.
    const outcome = await worker().processOne();
    expect(outcome, (await intent(f.bundle)).error ?? 'bundle outcome').toMatchObject({
      status: 'completed'
    });
    expect((await intent(f.bundle)).status).toBe('succeeded');
    expect((await stat(join(root, 'one.txt'))).ino).toBe(inode);
  });
  it('compensates earlier effects when a later member cannot apply, without approving any DB member', async () => {
    if (!db.available) return;
    const f = await fixture(true);
    await bundles().decide(identity, f.bundle, f.decisions, service());
    await writeFile(join(root, 'two.txt'), 'independent edit');
    await expect(worker().processOne()).resolves.toMatchObject({
      status: 'failed'
    });
    expect((await intent(f.bundle)).status).toBe('failed');
    await pending(f.ids);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    expect(await readFile(join(root, 'two.txt'), 'utf8')).toBe('independent edit');
  });
  it('rolls back final member/audit/receipt DB changes and compensates IO on final storage refusal', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    await db.pool.query("CREATE FUNCTION refuse_bundle_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'member storage refused'; END $$");
    await db.pool.query('CREATE TRIGGER refuse_bundle_member BEFORE UPDATE ON evolution_bundle_members FOR EACH ROW EXECUTE FUNCTION refuse_bundle_member()');
    try {
      await expect(worker().processOne()).resolves.toMatchObject({
        status: 'failed'
      });
      await pending(f.ids);
      expect((await intent(f.bundle)).status).toBe('failed');
      expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
      const audits = (await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE proposal_id=$1 AND action='proposal.apply' AND metadata_json->>'operation_outcome'='failed'", [f.patch])).rows;
      expect(audits).toHaveLength(1);
      expect((await db.pool.query('SELECT id FROM code_patch_snapshots WHERE proposal_id=$1', [f.patch])).rows).toHaveLength(0);
    } finally {
      await db.pool.query('DROP TRIGGER refuse_bundle_member ON evolution_bundle_members');
      await db.pool.query('DROP FUNCTION refuse_bundle_member()');
    }
  });
  it.each(['job', 'audit'] as const)('fails closed before IO if required %s storage refuses intent creation', async target => {
    if (!db.available) return;
    const f = await fixture();
    const table = target === 'job' ? 'jobs' : 'policy_decision_records';
    await db.pool.query("CREATE FUNCTION refuse_bundle_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intent storage refused'; END $$");
    await db.pool.query(`CREATE TRIGGER refuse_bundle_intent BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_bundle_intent()`);
    try {
      await expect(bundles().decide(identity, f.bundle, f.decisions, service())).rejects.toThrow();
      await pending(f.ids);
      expect((await db.pool.query('SELECT id FROM evolution_bundle_decisions')).rows).toHaveLength(0);
      expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    } finally {
      await db.pool.query(`DROP TRIGGER refuse_bundle_intent ON ${table}`);
      await db.pool.query('DROP FUNCTION refuse_bundle_intent()');
    }
  });
  it('refuses frozen-payload drift and never copies an approval to new content', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    const old = await intent(f.bundle);
    await db.pool.query("UPDATE proposals SET payload_json=jsonb_set(payload_json,'{proposed_content}','\"Different content\"'::jsonb) WHERE id=$1", [f.memory]);
    await expect(worker().processOne()).resolves.toMatchObject({
      status: 'failed'
    });
    expect((await intent(f.bundle)).frozen_json).toEqual(old.frozen_json);
    await pending(f.ids);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
    await bundles().decide(identity, f.bundle, f.decisions, service());
    expect((await db.pool.query('SELECT id FROM evolution_bundle_decisions')).rows).toHaveLength(1);
  });
  it('recovers a cancelled partial-effect Job through one durable cleanup handoff', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    const row = await intent(f.bundle),
      effect = row.effects_json[f.patch]!,
      files = new CodePatchFileTransaction(root, false);
    effect.before = await files.prepare(effect.operations);
    await db.pool.query("UPDATE evolution_bundle_decisions SET status='applying',effects_json=$2::jsonb WHERE id=$1", [row.id, JSON.stringify(row.effects_json)]);
    await files.applyPrepared(effect.operations, effect.before);
    await new PgJobQueueRepository(db.pool).cancelJob(row.job_id!, null);
    await recoverBundleDecisionJobs(config());
    expect((await intent(f.bundle)).status).toBe('compensating');
    await worker().processOne();
    expect((await intent(f.bundle)).status).toBe('failed');
    await pending(f.ids);
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('before');
  });
  it('retains explicit compensation failure rather than clobbering an unrelated edit', async () => {
    if (!db.available) return;
    const f = await fixture();
    await bundles().decide(identity, f.bundle, f.decisions, service());
    const row = await intent(f.bundle),
      effect = row.effects_json[f.patch]!,
      files = new CodePatchFileTransaction(root, false);
    effect.before = await files.prepare(effect.operations);
    await db.pool.query("UPDATE evolution_bundle_decisions SET status='compensating',effects_json=$2::jsonb WHERE id=$1", [row.id, JSON.stringify(row.effects_json)]);
    await writeFile(join(root, 'one.txt'), 'independent edit');
    await expect(worker().processOne()).resolves.toMatchObject({
      status: 'failed'
    });
    expect((await intent(f.bundle)).status).toBe('compensation_failed');
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('independent edit');
    await pending(f.ids);
  });
});
