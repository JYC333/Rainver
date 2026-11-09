import {applyPreparedCodePatchEffect,compensateCodePatchEffect} from '../projectFolders/codePatchEffects.js';
import { EvolutionBundleDecisionReceiptSchema } from '@rainver/protocol';
import { randomUUID } from 'node:crypto';
import type { Pool } from '../../db/pool.js';
import { getDbPool } from '../../db/pool.js';
import type { ServerConfig } from '../../config.js';
import { withQueryableTransaction, HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { withBundleDecisionOwner } from '../systemActions/operations/proposalTransitions.js';
import { withPolicyAuditRecovery } from '../policy/auditWriter.js';
import { tryWithDedicatedSessionAdvisoryLock } from '../../db/advisoryLock.js';
import { PgJobQueueRepository } from '../jobs/repository.js';
import { JobDeferredError, type JobHandlerRegistry } from '../jobs/handlerRegistry.js';
import { PgProposalApplyService } from '../proposals/applyService.js';
import { prepareCodePatchPlan } from '../projectFolders/codePatch.js';
import { withCodePatchEffectReceipts, type CodePatchEffectReceipt } from '../projectFolders/codePatchEffectContext.js';
import { EvolutionBundleRepository, lockBundleDecision, type EvolutionBundleDecision, type ProposalDecisionPort } from './bundleRepository.js';
import { sha256Json } from './hash.js';
import { EVOLUTION_BUNDLE_DECISION_JOB, type BundleDecisionRow, type FrozenBundleMember } from './bundleDecisionTypes.js';
const active = ['pending', 'applying', 'compensating', 'compensation_failed'];
export async function decisionReceipt(db: Queryable, space: string, bundle: string, id: string | null = null) {
  const row = (await db.query<BundleDecisionRow>('SELECT * FROM evolution_bundle_decisions WHERE space_id=$1 AND bundle_id=$2 AND ($3::text IS NULL OR id=$3) ORDER BY created_at DESC,id DESC LIMIT 1', [space, bundle, id])).rows[0];
  return row ? EvolutionBundleDecisionReceiptSchema.parse({
    id: row.id,
    status: row.status,
    job_id: row.job_id,
    error: row.error ? 'bundle_decision_' + (row.status === 'compensation_failed' ? 'compensation_failed' : 'failed') : null,
    member_ids: row.frozen_json.map(m => m.proposalId)
  }) : null;
}
export async function assertNoActiveBundleDecision(db: Queryable, space: string, bundle: string) {
  if ((await db.query('SELECT id FROM evolution_bundle_decisions WHERE space_id=$1 AND bundle_id=$2 AND status=ANY($3::text[])', [space, bundle, active])).rows.length) throw new HttpError(409, 'Evolution bundle has a durable decision in progress');
}
async function frozenMembers(db: Queryable, identity: SpaceUserIdentity, bundle: string, decisions: EvolutionBundleDecision[]): Promise<FrozenBundleMember[]> {
  const unique = new Map(decisions.map(d => [d.proposalId, d]));
  if (!unique.size) throw new HttpError(422, 'decisions must not be empty');
  const rows = (await db.query<{
    id: string;
    payload_json: Record<string, unknown>;
    proposal_type: string;
  }>(`SELECT p.id,p.payload_json,p.proposal_type FROM evolution_bundle_members m JOIN proposals p ON p.id=m.proposal_id AND p.space_id=$1 WHERE m.bundle_id=$2 AND m.proposal_id=ANY($3::varchar[]) ORDER BY m.position`, [identity.spaceId, bundle, [...unique.keys()]])).rows;
  if (rows.length !== unique.size) throw new HttpError(404, 'Evolution bundle member not found');
  return rows.map(p => {
    const d = unique.get(p.id)!;
    if (!['approve', 'reject'].includes(d.decision)) throw new HttpError(422, 'Invalid decision');
    return {
      proposalId: p.id,
      decision: d.decision,
      note: d.note ?? null,
      payload: p.payload_json,
      payloadHash: sha256Json(p.payload_json),
      proposalType: p.proposal_type
    };
  });
}
async function preflight(client: Queryable, identity: SpaceUserIdentity, frozen: FrozenBundleMember[], service: ProposalDecisionPort) {
  if (!service.prepareBundleDecisionInTransaction) throw new HttpError(503, 'Canonical bundle preparation unavailable');
  const proposals = new Map<string, Awaited<ReturnType<NonNullable<ProposalDecisionPort['prepareBundleDecisionInTransaction']>>>>();
  for (const m of frozen) {
    const p = await service.prepareBundleDecisionInTransaction(client, m.proposalId, identity, m.decision);
    if (sha256Json(p.payload_json) !== m.payloadHash || p.proposal_type !== m.proposalType) throw new HttpError(409, 'Frozen bundle payload changed');
    proposals.set(m.proposalId, p);
  }
  return proposals;
}
export async function queueBundleDecision(pool: Pool, identity: SpaceUserIdentity, bundle: string, decisions: EvolutionBundleDecision[], service: ProposalDecisionPort) {
  if (!pool.options.connectionString) throw new HttpError(503, 'Bundle decisions require configured audit recovery');
  const repository = new EvolutionBundleRepository(pool);
  if (!(await repository.get(identity, bundle))) throw new HttpError(404, 'Evolution bundle not found');
  const previous = (await pool.query<BundleDecisionRow>('SELECT * FROM evolution_bundle_decisions WHERE space_id=$1 AND bundle_id=$2 AND user_id=$3 ORDER BY created_at DESC', [identity.spaceId, bundle, identity.userId])).rows;
  const request = decisions.map(d => [d.proposalId, d.decision, d.note ?? null]).sort();
  const replay = previous.find(row => sha256Json(row.frozen_json.map(d => [d.proposalId, d.decision, d.note]).sort()) === sha256Json(request));
  if (replay) {
    // A failed, fully compensated attempt may be explicitly submitted again.
    // Keep its frozen approval/intent identity; only an exhausted/stopped backing
    // Job is replaced. Concurrent/lost-response replays see the same live Job.
    if (replay.status === 'failed') await resumeFailedDecision(pool, identity, replay, service);
    return {
      ...(await repository.get(identity, bundle))!,
      decision: await decisionReceipt(pool, identity.spaceId, bundle, replay.id)
    };
  }
  let intentId: string | undefined;
  const frozen = await frozenMembers(pool, identity, bundle, decisions),
    fingerprint = sha256Json({
      user: identity.userId,
      frozen
    });
  await withPolicyAuditRecovery(pool.options.connectionString, () => withQueryableTransaction(pool, async db => {
    await withBundleDecisionOwner(db, identity.spaceId, frozen.map(m => m.proposalId), async () => {
      await lockBundleDecision(db, bundle);
      // Replay consults retained intent before pending-state validation, not approvals.
      const old = (await db.query<BundleDecisionRow>('SELECT * FROM evolution_bundle_decisions WHERE space_id=$1 AND bundle_id=$2 AND fingerprint=$3', [identity.spaceId, bundle, fingerprint])).rows[0];
      if (old) {
        intentId = old.id;
        return;
      }
      await assertNoActiveBundleDecision(db, identity.spaceId, bundle);
      const current = await frozenMembers(db, identity, bundle, decisions);
      if (sha256Json(current) !== sha256Json(frozen)) throw new HttpError(409, 'Frozen bundle membership changed');
      await preflight(db, identity, frozen, service);
      const effects: BundleDecisionRow['effects_json'] = {};
      for (const m of frozen.filter(m => m.decision === 'approve' && m.proposalType === 'code_patch')) {
        if (!service.prepareBundlePatchInTransaction) throw new HttpError(503, 'Canonical patch preparation unavailable');
        const plan = await service.prepareBundlePatchInTransaction(db, m.proposalId, identity);
        effects[m.proposalId] = {
          root: plan.root,
          protectedFolder: plan.folder.protected,
          folderId: plan.folderId,
          operations: plan.operations,
          before: []
        };
      }
      const id = randomUUID();
      intentId = id;
      await db.query("INSERT INTO evolution_bundle_decisions(id,space_id,bundle_id,user_id,fingerprint,status,frozen_json,effects_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb,$7::jsonb,now(),now())", [id, identity.spaceId, bundle, identity.userId, fingerprint, JSON.stringify(frozen), JSON.stringify(effects)]);
      const job = await new PgJobQueueRepository(db).enqueue({
        job_type: EVOLUTION_BUNDLE_DECISION_JOB,
        space_id: identity.spaceId,
        user_id: identity.userId,
        payload: {
          decision_id: id
        },
        max_attempts: 5
      });
      await db.query('UPDATE evolution_bundle_decisions SET job_id=$2 WHERE id=$1', [id, job.id]);
    }, identity.userId);
  }));
  return {
    ...(await repository.get(identity, bundle))!,
    decision: await decisionReceipt(pool, identity.spaceId, bundle, intentId ?? null)
  };
}
async function resumeFailedDecision(pool: Pool, identity: SpaceUserIdentity, retained: BundleDecisionRow, service: ProposalDecisionPort) {
  await withPolicyAuditRecovery(pool.options.connectionString, () => withQueryableTransaction(pool, async db => {
    await withBundleDecisionOwner(db, identity.spaceId, retained.frozen_json.map(m => m.proposalId), async () => {
      await lockBundleDecision(db, retained.bundle_id);
      const row = (await db.query<BundleDecisionRow>("SELECT * FROM evolution_bundle_decisions WHERE id=$1 AND space_id=$2 AND user_id=$3 FOR UPDATE", [retained.id, identity.spaceId, identity.userId])).rows[0];
      if (!row || row.status !== 'failed') return;
      const job = (await db.query<{
        status: string;
      }>("SELECT status FROM jobs WHERE id=$1", [row.job_id])).rows[0];
      if (job && !['failed', 'cancelled', 'completed'].includes(job.status)) return;
      await assertNoActiveBundleDecision(db, identity.spaceId, row.bundle_id);
      await preflight(db, identity, row.frozen_json, service);
      for (const effect of Object.values(row.effects_json)) {
        effect.compensated = false;
        delete effect.receipt;
      }
      const next = await new PgJobQueueRepository(db).enqueue({
        job_type: EVOLUTION_BUNDLE_DECISION_JOB,
        space_id: identity.spaceId,
        user_id: identity.userId,
        payload: {
          decision_id: row.id
        },
        max_attempts: 5
      });
      await db.query("UPDATE evolution_bundle_decisions SET status='pending',job_id=$2,effects_json=$3::jsonb,result_json=NULL,error=NULL,updated_at=now() WHERE id=$1", [row.id, next.id, JSON.stringify(row.effects_json)]);
    }, identity.userId);
  }));
}
async function load(pool: Pool, id: string, space: string) {
  const row = (await pool.query<BundleDecisionRow>('SELECT * FROM evolution_bundle_decisions WHERE id=$1 AND space_id=$2', [id, space])).rows[0];
  if (!row) throw new HttpError(404, 'Bundle decision not found');
  return row;
}
async function saveEffects(pool: Pool, row: BundleDecisionRow) {
  await pool.query('UPDATE evolution_bundle_decisions SET effects_json=$2::jsonb,updated_at=now() WHERE id=$1', [row.id, JSON.stringify(row.effects_json)]);
}

/** Existing Job worker owns external execution. No DB transaction spans IO. */
export async function executeBundleDecision(config: ServerConfig, id: string, space: string, lease?: {
  jobId: string;
  workerId: string;
  userId: string | null;
}) {
  if (!config.databaseUrl) throw new Error('Bundle decisions require database');
  const pool = getDbPool(config.databaseUrl);
  const gate = await tryWithDedicatedSessionAdvisoryLock(pool, `evolution-decision-worker:${id}`, async () => {
    const row = await load(pool, id, space);
    if (lease && (lease.jobId !== row.job_id || lease.userId !== row.user_id)) throw new HttpError(409, 'Stale decision Job');
    const assertLease = async (db: Queryable = pool, lock = false) => {
      if (!lease) return;
      const job = (await db.query("SELECT id FROM jobs WHERE id=$1 AND claimed_by=$2 AND status='running'" + (lock ? ' FOR SHARE' : ''), [lease.jobId, lease.workerId])).rows[0];
      if (!job) throw new HttpError(409, 'Decision Job no longer owns execution');
    };
    if (row.status === 'succeeded') return row.result_json;
    if (row.status === 'failed' && !lease) throw new Error(row.error ?? 'Bundle decision failed');
    const identity = {
        spaceId: row.space_id,
        userId: row.user_id
      },
      service = PgProposalApplyService.fromConfig(config);
    if (row.status === 'compensating' || row.status === 'compensation_failed') {
      await compensate(pool, row);
      return {
        decision_id: id,
        status: 'failed'
      };
    }
    try {
      // Authority and frozen inputs are checked before any external write.
      await assertLease();
      // Only a real queue claim may retry a compensated failed attempt. The
      // existing Job attempt cap owns retry; frozen approval/receipt identity stays.
      if (row.status === 'failed') for (const effect of Object.values(row.effects_json)) {
        effect.compensated = false;
        delete effect.receipt;
      }
      const plans = await withPolicyAuditRecovery(config.databaseUrl, () => withQueryableTransaction(pool, async db => {
        const plans = new Map<string, Awaited<ReturnType<typeof prepareCodePatchPlan>>>();
        await withBundleDecisionOwner(db, row.space_id, row.frozen_json.map(m => m.proposalId), async () => {
          await lockBundleDecision(db, row.bundle_id);
          await preflight(db, identity, row.frozen_json, service);
          for (const m of row.frozen_json.filter(m => m.decision === 'approve' && m.proposalType === 'code_patch')) {
            plans.set(m.proposalId, await service.prepareBundlePatchInTransaction(db, m.proposalId, identity));
          }
          await db.query("UPDATE evolution_bundle_decisions SET status='applying',effects_json=$2::jsonb,error=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(row.effects_json)]);
        }, row.user_id);
        return plans;
      }));
      for (const [proposalId, plan] of plans) {
        const locked = await tryWithDedicatedSessionAdvisoryLock(pool, `code-patch-folder:${plan.folderId}`, async () => {
          let effect = row.effects_json[proposalId];
          if (effect && (effect.root !== plan.root || effect.protectedFolder !== plan.folder.protected || sha256Json(effect.operations) !== sha256Json(plan.operations))) throw new HttpError(409, 'Code patch target changed');
          if (!effect) {
            effect = {
              root: plan.root,
              protectedFolder: plan.folder.protected,
              folderId: plan.folderId,
              operations: plan.operations,
              before: []
            };
            row.effects_json[proposalId] = effect;
          }
          await applyPreparedCodePatchEffect(effect,sha256Json(plan.payload),()=>saveEffects(pool,row),()=>assertLease());
        });
        if (!locked.acquired) throw new JobDeferredError('Code patch Folder is busy', 1000);
      }
      const receipts = new Map<string, CodePatchEffectReceipt>();
      for (const [proposalId, effect] of Object.entries(row.effects_json)) {
        if (!effect.receipt) throw new Error('Missing external effect receipt');
        receipts.set(proposalId, effect.receipt);
      }
      const repository = new EvolutionBundleRepository(pool);
      await withCodePatchEffectReceipts(receipts, () => repository.decideAtomic(identity, row.bundle_id, row.frozen_json, service, async client => {
        await assertLease(client, true);
        // Must still match at commit; the canonical appliers performed live authority.
        for (const m of row.frozen_json) {
          const p = (await client.query<{
            payload_json: Record<string, unknown>;
          }>('SELECT payload_json FROM proposals WHERE id=$1 AND space_id=$2', [m.proposalId, space])).rows[0];
          // Accepted appliers may add result fields; the pre-apply frozen check is
          // inside the canonical preparation immediately before each decision.
          if (!p) throw new HttpError(409, 'Bundle member disappeared');
        }
        await client.query("UPDATE evolution_bundle_decisions SET status='succeeded',result_json=$2::jsonb,error=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify({
          decision_id: id,
          bundle_id: row.bundle_id,
          member_ids: row.frozen_json.map(m => m.proposalId),
          status: 'succeeded'
        })]);
      }, row.frozen_json));
      return (await load(pool, id, space)).result_json;
    } catch (error) {
      if (error instanceof JobDeferredError) throw error;
      const committed = await load(pool, id, space);
      if (committed.status === 'succeeded') return committed.result_json;
      row.error = error instanceof Error ? error.message : String(error);
      await pool.query("UPDATE evolution_bundle_decisions SET status='compensating',error=$2,updated_at=now() WHERE id=$1", [id, row.error]);
      await compensate(pool, row);
      throw error;
    }
  });
  if (!gate.acquired) throw new JobDeferredError('Evolution decision worker is busy', 1000);
  return gate.value;
}
async function compensate(pool: Pool, row: BundleDecisionRow) {
  try {
    for (const effect of Object.values(row.effects_json).reverse()) {
      if (effect.compensated || !effect.before.length) continue;
      const lock = await tryWithDedicatedSessionAdvisoryLock(pool, `code-patch-folder:${effect.folderId}`, async () => {
        await compensateCodePatchEffect(effect,()=>saveEffects(pool,row));
      });
      if (!lock.acquired) throw new JobDeferredError('Code patch compensation is busy', 1000);
    }
    await pool.query("UPDATE evolution_bundle_decisions SET status='failed',updated_at=now() WHERE id=$1", [row.id]);
  } catch (error) {
    await pool.query("UPDATE evolution_bundle_decisions SET status='compensation_failed',error=$2,updated_at=now() WHERE id=$1", [row.id, error instanceof Error ? error.message : String(error)]);
    throw error;
  }
}
export function registerBundleDecisionHandler(registry: JobHandlerRegistry, config: ServerConfig) {
  registry.register(EVOLUTION_BUNDLE_DECISION_JOB, job => {
    if (typeof job.payload.decision_id !== 'string') throw new Error('decision_id required');
    return executeBundleDecision(config, job.payload.decision_id, job.space_id, {
      jobId: job.job_id,
      workerId: job.worker_id,
      userId: job.user_id
    }).catch(error => {
      if (error instanceof JobDeferredError) throw error;
      throw new Error('bundle_decision_failed');
    });
  });
}

/** Recovery is one bounded cleanup handoff on the existing worker sweep.
 * Cancelled/exhausted/missing Jobs never leave an active effect intent orphaned.
 * A failed cleanup remains explicit for operator repair; no unbounded requeue. */
export async function recoverBundleDecisionJobs(config: ServerConfig) {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  const candidates = (await pool.query<BundleDecisionRow>(`SELECT d.* FROM evolution_bundle_decisions d
 LEFT JOIN jobs j ON j.id=d.job_id WHERE d.status IN ('pending','applying','compensating')
 AND (j.id IS NULL OR j.status IN ('failed','cancelled','completed')) ORDER BY d.id`)).rows;
  for (const candidate of candidates) {
    await tryWithDedicatedSessionAdvisoryLock(pool, `evolution-decision-worker:${candidate.id}`, () => withQueryableTransaction(pool, async db => {
      const row = (await db.query<BundleDecisionRow>(`SELECT d.* FROM evolution_bundle_decisions d LEFT JOIN jobs j ON j.id=d.job_id
     WHERE d.id=$1 AND d.status IN ('pending','applying','compensating') AND (j.id IS NULL OR j.status IN ('failed','cancelled','completed')) FOR UPDATE OF d SKIP LOCKED`, [candidate.id])).rows[0];
      if (!row) return;
      const needsCleanup = Object.values(row.effects_json).some(effect => effect.before.length && !effect.compensated);
      if (!needsCleanup) {
        await db.query("UPDATE evolution_bundle_decisions SET status='failed',error=COALESCE(error,'Decision Job stopped'),updated_at=now() WHERE id=$1", [row.id]);
        return;
      }
      if (row.result_json?.cleanup_requested === true) {
        await db.query("UPDATE evolution_bundle_decisions SET status='compensation_failed',error='Cleanup Job stopped; operator repair required',updated_at=now() WHERE id=$1", [row.id]);
        return;
      }
      const job = await new PgJobQueueRepository(db).enqueue({
        job_type: EVOLUTION_BUNDLE_DECISION_JOB,
        space_id: row.space_id,
        user_id: row.user_id,
        payload: {
          decision_id: row.id
        },
        max_attempts: 3
      });
      await db.query("UPDATE evolution_bundle_decisions SET status='compensating',job_id=$2,result_json='{\"cleanup_requested\":true}'::jsonb,updated_at=now() WHERE id=$1", [row.id, job.id]);
    }));
  }
}
