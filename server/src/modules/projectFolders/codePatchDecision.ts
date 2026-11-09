import {CodePatchDecisionRefusal} from './codePatchDecisionErrors.js';
import { randomUUID } from 'node:crypto';
import { CodePatchDecisionReceiptSchema, type ProposalAcceptOut, type CodePatchDecisionReceipt } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import { getDbPool } from '../../db/pool.js';
import { tryWithDedicatedSessionAdvisoryLock } from '../../db/advisoryLock.js';
import { withQueryableTransaction, HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { withCheckpointDecisionOwner } from '../systemActions/operations/proposalTransitions.js';
import { withPolicyAuditRecovery } from '../policy/auditWriter.js';
import { PgJobQueueRepository } from '../jobs/repository.js';
import { JobDeferredError, type JobHandlerRegistry } from '../jobs/handlerRegistry.js';
import { PgProposalApplyService } from '../proposals/applyService.js';
import { assertCurrentActor, sessionActor } from '../systemActions/operations/actor.js';
import { PgProposalRepository } from '../proposals/repository.js';
import { sha256Json } from '../evolution/hash.js';
import { applyPreparedCodePatchEffect, compensateCodePatchEffect, type PreparedCodePatchEffect } from './codePatchEffects.js';
import { withCodePatchDecisionAudit,withCodePatchEffectReceipts } from './codePatchEffectContext.js';
const jobType = 'code_patch_decision';
interface Row {
  id: string;
  space_id: string;
  proposal_id: string;
  user_id: string;
  phase: 'apply' | 'rollback';
  fingerprint: string;
  status: string;
  job_id: string | null;
  frozen_json: {
    payload: Record<string, unknown>;
    snapshotId: string | null;
    options: {
      confirmIncompletePatch?: boolean;
    };
  };
  effect_json: PreparedCodePatchEffect;
  result_json: Record<string, unknown> | null;
  error: string | null;
}
const receipt = (r: Row) => CodePatchDecisionReceiptSchema.parse({
  id: r.id,
  proposal_id: r.proposal_id,
  phase: r.phase,
  status: r.status,
  job_id: r.job_id,
  error: r.error ? 'code_patch_decision_' + r.status : null
});
async function load(db: Queryable, id: string, space: string) {
  const r = (await db.query<Row>('SELECT * FROM code_patch_decisions WHERE id=$1 AND space_id=$2', [id, space])).rows[0];
  if (!r) throw new HttpError(404, 'Code patch decision not found');
  return r;
}
async function save(db: Queryable, r: Row) {
  await db.query('UPDATE code_patch_decisions SET effect_json=$2::jsonb,updated_at=now() WHERE id=$1', [r.id, JSON.stringify(r.effect_json)]);
}
async function queue(config: ServerConfig, service: PgProposalApplyService, id: string, identity: SpaceUserIdentity, phase: 'apply' | 'rollback', options: {
  confirmIncompletePatch?: boolean;
} = {}) {
  if(!config.databaseUrl)throw new Error("Code patch decisions require SERVER_DATABASE_URL");
  const pool = getDbPool(config.databaseUrl);
  const candidate=await new PgProposalRepository(pool).getVisible(identity.spaceId,identity.userId,id);
  if(!candidate||candidate.proposal_type!=='code_patch')return null;
  let selected: Row | null = null;
  await withPolicyAuditRecovery(config.databaseUrl, () => withQueryableTransaction(pool, db => withCheckpointDecisionOwner(db, identity.spaceId, [id], async () => {
    const previous = (await db.query<Row>('SELECT * FROM code_patch_decisions WHERE space_id=$1 AND proposal_id=$2 AND phase=$3 ORDER BY created_at DESC,id DESC LIMIT 1', [identity.spaceId, id, phase])).rows[0];
    const current = previous?.status === 'succeeded' ? await service.authorizeCodePatchReceipt(db, id, identity) : null;
    if (previous && previous.user_id === identity.userId && previous.status === 'succeeded' && current?.status === (phase === 'apply' ? 'accepted' : 'rolled_back')) {
      selected = previous;
      return;
    }
    const decisionId=randomUUID();
    const plan = await service.prepareCodePatchDecisionInTransaction(db, id, identity, phase, options);
    const frozen = {
        payload: plan.payload,
        snapshotId: plan.snapshotId,
        options: {
          confirmIncompletePatch: options.confirmIncompletePatch === true
        }
      },
      fingerprint = sha256Json({
        phase,
        user: identity.userId,
        ...frozen
      });
    const old = (await db.query<Row>('SELECT * FROM code_patch_decisions WHERE space_id=$1 AND proposal_id=$2 AND phase=$3 AND fingerprint=$4', [identity.spaceId, id, phase, fingerprint])).rows[0];
    const active=(await db.query<{id:string}>("SELECT id FROM code_patch_decisions WHERE space_id=$1 AND proposal_id=$2 AND status IN ('pending','applying','compensating','compensation_failed')",[identity.spaceId,id])).rows[0];
    if(active&&active.id!==old?.id)throw new HttpError(409,'Code patch has an active decision');
    if (old) {
      if (old.status === 'failed') {
        const job = (await db.query<{
          status: string;
        }>('SELECT status FROM jobs WHERE id=$1', [old.job_id])).rows[0];
        if (!job || ['failed', 'cancelled', 'completed'].includes(job.status)) {
          old.effect_json.compensated = false;
          delete old.effect_json.receipt;
          const next = await new PgJobQueueRepository(db).enqueue({
            job_type: jobType,
            space_id: identity.spaceId,
            user_id: identity.userId,
            payload: {
              decision_id: old.id
            },
            max_attempts: 5
          });
          await db.query("UPDATE code_patch_decisions SET status='pending',job_id=$2,effect_json=$3::jsonb,error=NULL,result_json=NULL,updated_at=now() WHERE id=$1", [old.id, next.id, JSON.stringify(old.effect_json)]);
          selected = await load(db, old.id, identity.spaceId);
          return;
        }
      }
      selected = old;
      return;
    }
    if ((await db.query("SELECT id FROM code_patch_decisions WHERE space_id=$1 AND proposal_id=$2 AND status IN ('pending','applying','compensating','compensation_failed')", [identity.spaceId, id])).rows.length) throw new HttpError(409, 'Code patch has an active decision');
    const effect: PreparedCodePatchEffect = {
        folderId: plan.folderId,
        root: plan.root,
        protectedFolder: plan.folder.protected,
        operations: plan.operations,
        before: []
      };
    await db.query("INSERT INTO code_patch_decisions(id,space_id,proposal_id,user_id,phase,fingerprint,status,frozen_json,effect_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7::jsonb,$8::jsonb,now(),now())", [decisionId, identity.spaceId, id, identity.userId, phase, fingerprint, JSON.stringify(frozen), JSON.stringify(effect)]);
    const j = await new PgJobQueueRepository(db).enqueue({
      job_type: jobType,
      space_id: identity.spaceId,
      user_id: identity.userId,
      payload: {
        decision_id: decisionId
      },
      max_attempts: 5
    });
    await db.query('UPDATE code_patch_decisions SET job_id=$2 WHERE id=$1', [decisionId, j.id]);
    selected = await load(db, decisionId, identity.spaceId);
  }, identity.userId)));
  return selected as Row | null;
}
export async function queueCodePatchDecision(config: ServerConfig, service: PgProposalApplyService, id: string, identity: SpaceUserIdentity, phase: 'apply', options: {
  confirmIncompletePatch?: boolean;
} = {}): Promise<ProposalAcceptOut | null> {
  const r = await queue(config, service, id, identity, phase, options);
  if (!r) return null;
  if (r.status === 'succeeded') return r.result_json as ProposalAcceptOut;
  const p = await new PgProposalRepository(getDbPool(config.databaseUrl!)).getVisible(identity.spaceId, identity.userId, id);
  if (!p) return null;
  return {
    proposal: p,
    result_type: 'code_patch_pending',
    result: receipt(r)
  };
}
export async function queueCodePatchRollback(config: ServerConfig, service: PgProposalApplyService, id: string, identity: SpaceUserIdentity): Promise<CodePatchDecisionReceipt | null> {
  const r = await queue(config, service, id, identity, 'rollback');
  return r ? receipt(r) : null;
}
async function compensate(db: Queryable, r: Row) {
  await db.query("UPDATE code_patch_decisions SET status='compensating',updated_at=now() WHERE id=$1", [r.id]);
  try {
    const lock = await tryWithDedicatedSessionAdvisoryLock(db, `code-patch-folder:${r.effect_json.folderId}`, () => compensateCodePatchEffect(r.effect_json, () => save(db, r)));
    if (!lock.acquired) throw new JobDeferredError('Code patch compensation busy', 1000);
    await db.query("UPDATE code_patch_decisions SET status='failed',updated_at=now() WHERE id=$1", [r.id]);
  } catch (e) {
    if(e instanceof JobDeferredError)throw e;
    await db.query("UPDATE code_patch_decisions SET status='compensation_failed',updated_at=now() WHERE id=$1", [r.id]);
    throw e;
  }
}
export async function executeCodePatchDecision(config: ServerConfig, id: string, space: string, lease?: {
  jobId: string;
  workerId: string;
  userId: string | null;
}, service = PgProposalApplyService.fromConfig(config)) {
  const pool = getDbPool(config.databaseUrl!);
  const gate = await tryWithDedicatedSessionAdvisoryLock(pool, `code-patch-decision:${id}`, async () => {
    const r = await load(pool, id, space),
      identity = {
        spaceId: space,
        userId: r.user_id
      };
    if (lease && (r.job_id !== lease.jobId || r.user_id !== lease.userId)) throw new HttpError(409, 'Stale code patch Job');
    const assertLease = async (db: Queryable = pool, lock = false) => {
      if (lease && !(await db.query("SELECT id FROM jobs WHERE id=$1 AND claimed_by=$2 AND status='running'" + (lock ? ' FOR SHARE' : ''), [lease.jobId, lease.workerId])).rows.length) throw new HttpError(409, 'Code patch Job no longer owns execution');
    };
    if (r.status === 'succeeded') return r.result_json;
    if (r.status === 'compensating' || r.status === 'compensation_failed') {
      await compensate(pool, r);
      return {
        status: 'failed',
        decision_id: id
      };
    }
    if(r.status==='failed'&&r.result_json?.terminal_refusal===true)return {status:'failed',decision_id:id};
    if (r.status === 'failed' && !lease) throw new HttpError(409, 'Code patch decision failed');
    try {
      await withCodePatchDecisionAudit(id,'worker_prepare',()=>withPolicyAuditRecovery(config.databaseUrl, () => withQueryableTransaction(pool, db => withCheckpointDecisionOwner(db, space, [r.proposal_id], async () => {
        await assertLease(db);
        const plan = await service.prepareCodePatchDecisionInTransaction(db, r.proposal_id, identity, r.phase, r.frozen_json.options);
        if (sha256Json(plan.payload) !== sha256Json(r.frozen_json.payload) || plan.snapshotId !== r.frozen_json.snapshotId || plan.root !== r.effect_json.root || plan.folder.protected !== r.effect_json.protectedFolder || sha256Json(plan.operations) !== sha256Json(r.effect_json.operations)) throw new CodePatchDecisionRefusal(409, 'Frozen code patch changed');
        if (r.status === 'failed') {
          r.effect_json.compensated = false;
          delete r.effect_json.receipt;
        }
        await db.query("UPDATE code_patch_decisions SET status='applying',effect_json=$2::jsonb,error=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(r.effect_json)]);
      }, identity.userId))));
      const folder = await tryWithDedicatedSessionAdvisoryLock(pool, `code-patch-folder:${r.effect_json.folderId}`, () => applyPreparedCodePatchEffect(r.effect_json, sha256Json(r.frozen_json.payload), () => save(pool, r), () => assertLease()));
      if (!folder.acquired) throw new JobDeferredError('Code patch Folder busy', 1000);
      await withCodePatchDecisionAudit(id,'worker_commit',()=>withCodePatchEffectReceipts(new Map([[r.proposal_id, r.effect_json.receipt!]]), () => withPolicyAuditRecovery(config.databaseUrl, () => withQueryableTransaction(pool, db => withCheckpointDecisionOwner(db, space, [r.proposal_id], async () => {
        await assertLease(db, true);
        await assertCurrentActor(db, sessionActor(identity));
        const current = (await db.query<{
          payload_json: Record<string, unknown>;
        }>('SELECT payload_json FROM proposals WHERE id=$1 AND space_id=$2', [r.proposal_id, space])).rows[0];
        if (!current || sha256Json(current.payload_json) !== sha256Json(r.frozen_json.payload)) throw new CodePatchDecisionRefusal(409, 'Frozen code patch changed before commit');
        const outcome = r.phase === 'apply' ? (await service.acceptInTransaction(db, r.proposal_id, identity, r.frozen_json.options))?.outcome : await service.commitCodePatchRollbackInTransaction(db, r.proposal_id, identity, r.frozen_json.snapshotId!, r.effect_json.operations.map(o => o.path));
        if (!outcome) throw new CodePatchDecisionRefusal(409, 'Proposal no longer pending');
        if (r.phase === 'apply' && 'proposal' in outcome) (outcome as ProposalAcceptOut).proposal.code_patch_decision = receipt({
          ...r,
          status: 'succeeded',
          error: null
        });
        await db.query("UPDATE code_patch_decisions SET status='succeeded',result_json=$2::jsonb,error=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(outcome)]);
      }, identity.userId)))));
      return (await load(pool, id, space)).result_json;
    } catch (e) {
      if (e instanceof JobDeferredError) throw e;
      const current = await load(pool, id, space);
      if (current.status === 'succeeded') return current.result_json;
      await pool.query('UPDATE code_patch_decisions SET error=$2 WHERE id=$1', [id, e instanceof Error ? e.message : String(e)]);
      if(e instanceof CodePatchDecisionRefusal)await pool.query("UPDATE code_patch_decisions SET status='compensating',result_json='{\"terminal_refusal\":true}'::jsonb WHERE id=$1",[id]);
      await compensate(pool, r);
      if(e instanceof CodePatchDecisionRefusal)return {status:'failed',decision_id:id};
      throw e;
    }
  });
  if (!gate.acquired) throw new JobDeferredError('Code patch decision busy', 1000);
  return gate.value;
}
export function registerCodePatchDecisionHandler(registry: JobHandlerRegistry, config: ServerConfig) {
  registry.register(jobType, async j => {
    if (typeof j.payload.decision_id !== 'string') throw new Error('decision_id required');
    await executeCodePatchDecision(config, j.payload.decision_id, j.space_id, {
      jobId: j.job_id,
      workerId: j.worker_id,
      userId: j.user_id
    });
    return {
      decision_id: j.payload.decision_id,
      status: (await load(getDbPool(config.databaseUrl!), j.payload.decision_id, j.space_id)).status
    };
  });
}
export async function recoverCodePatchDecisions(config: ServerConfig) {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  const rows = (await pool.query<Row>(`SELECT d.* FROM code_patch_decisions d LEFT JOIN jobs j ON j.id=d.job_id
  WHERE d.status IN ('pending','applying','compensating') AND (j.id IS NULL OR j.status IN ('failed','cancelled','completed')) ORDER BY d.id`)).rows;
  for (const candidate of rows) await tryWithDedicatedSessionAdvisoryLock(pool, `code-patch-decision:${candidate.id}`, () => withQueryableTransaction(pool, async db => {
    const row = (await db.query<Row>(`SELECT d.* FROM code_patch_decisions d LEFT JOIN jobs j ON j.id=d.job_id
   WHERE d.id=$1 AND d.status IN ('pending','applying','compensating')
   AND (j.id IS NULL OR j.status IN ('failed','cancelled','completed')) FOR UPDATE OF d SKIP LOCKED`, [candidate.id])).rows[0];
    if (!row) return;
    if (!row.effect_json.before.length || row.effect_json.compensated) {
      await db.query("UPDATE code_patch_decisions SET status='failed',error=COALESCE(error,'Decision Job stopped'),updated_at=now() WHERE id=$1", [row.id]);
      return;
    }
    if (row.result_json?.cleanup_requested === true) {
      await db.query("UPDATE code_patch_decisions SET status='compensation_failed',error='Cleanup Job stopped; operator repair required',updated_at=now() WHERE id=$1", [row.id]);
      return;
    }
    const job = await new PgJobQueueRepository(db).enqueue({
      job_type: jobType,
      space_id: row.space_id,
      user_id: row.user_id,
      payload: {
        decision_id: row.id
      },
      max_attempts: 3
    });
    await db.query(`UPDATE code_patch_decisions SET status='compensating',job_id=$2,result_json='{"cleanup_requested":true}'::jsonb,updated_at=now() WHERE id=$1`, [row.id, job.id]);
  }));
}
