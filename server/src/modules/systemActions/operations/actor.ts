import type { OperationActor } from '@rainver/protocol';
import type { SpaceUserIdentity, Queryable } from '../../routeUtils/common.js';
import { HttpError } from '../../routeUtils/common.js';
import { lockActivePerson } from '../../access/activePerson.js';
import { effectiveRunTrigger } from '../effectiveRunTrigger.js';
import type { RunRecord } from '../../runs/repository.js';
import { hidden,OperationError } from './errors.js';
const origins = {
  manual: 'manual',
  automation: 'scheduled',
  autonomous: 'system_event',
  job: 'system_event',
  system: 'system_event',
  delegation: 'delegated',
  continuation: 'continuation'
} as const;
export function sessionActor(identity: SpaceUserIdentity): OperationActor {
  return {
    principal: {
      kind: 'user',
      id: identity.userId
    },
    on_behalf_of_user_id: identity.userId,
    space_id: identity.spaceId,
    agent_id: null,
    run_id: null,
    origin: 'manual',
    effective_origin: 'manual',
    root_run_id: null,
    continuation_hops: 0,
    surface: 'public_api'
  };
}
export function immediateOperationOrigin(origin: string): OperationActor['origin'] {
  const result = Object.hasOwn(origins, origin) ? origins[origin as keyof typeof origins] : undefined;
  if (!result) throw hidden();
  return result;
}
export async function runActor(db: Queryable, run: RunRecord): Promise<OperationActor> {
  const origin = immediateOperationOrigin(run.trigger_origin);
  const root = await effectiveRunTrigger(db, run);
  if (root.origin !== 'unverified' && !Object.hasOwn(origins, root.origin)) throw hidden();
  if (!root.instructedByUserId || run.instructed_by_user_id && run.instructed_by_user_id !== root.instructedByUserId) throw hidden();
  return {
    principal: {
      kind: 'agent',
      id: run.agent_id!
    },
    agent_id: run.agent_id,
    run_id: run.id,
    on_behalf_of_user_id: root.instructedByUserId,
    space_id: run.space_id,
    origin,
    effective_origin: root.origin,
    root_run_id: root.rootRunId,
    continuation_hops: root.continuationHops,
    surface: 'agent_tool'
  };
}
export async function assertCurrentActor(db: Queryable, actor: OperationActor, lock = false, allowTerminalRun = false): Promise<void> {
  const person = actor.on_behalf_of_user_id;
  if (!person) throw hidden();
  if (lock) {
    // A joined lock does not establish users -> memberships: invitation
    // acceptance takes the user FOR UPDATE before its membership upsert.
    // Stay at the caller's existing position after any Project/Source closure.
    try {
      await lockActivePerson(db, actor.space_id, person);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 403) throw hidden();
      throw error;
    }
  } else {
    const row = await db.query(`SELECT m.id FROM space_memberships m JOIN users u ON u.id=m.user_id WHERE m.space_id=$1 AND m.user_id=$2 AND m.status='active' AND u.status='active'`, [actor.space_id, person]);
    if (!row.rows[0]) throw hidden();
  }
  if (actor.principal.kind === 'user' && (actor.principal.id !== person || actor.agent_id || actor.run_id || actor.origin !== 'manual' || actor.effective_origin !== 'manual' || actor.root_run_id !== null || actor.continuation_hops !== 0)) throw hidden();
  // Agent grants/transport identities remain enforced by the Run adapter; never offer user metadata to an Agent by identity coercion.
  if (actor.principal.kind === 'agent') {
    if (!actor.run_id || !actor.agent_id || actor.principal.id !== actor.agent_id || actor.surface !== 'agent_tool') throw hidden();
    const current = (await db.query<RunRecord>(`SELECT r.* FROM runs r JOIN agents a ON a.id=r.agent_id AND a.space_id=r.space_id WHERE r.id=$1 AND r.space_id=$2 AND r.agent_id=$3 AND ($4::boolean OR r.status='running') AND a.status='active' ${lock ? 'FOR SHARE OF r,a' : ''}`, [actor.run_id, actor.space_id, actor.agent_id, allowTerminalRun])).rows[0];
    if (!current) throw hidden();
    const root = await effectiveRunTrigger(db, current);
    if (current.instructed_by_user_id && current.instructed_by_user_id !== person) throw hidden();
    if (root.instructedByUserId !== person || root.origin !== actor.effective_origin || root.rootRunId !== actor.root_run_id) throw hidden();
  }
  if (actor.principal.kind !== 'user' && actor.principal.kind !== 'agent') throw hidden();
}
export async function assertOperationGrant(db: Queryable, actor: OperationActor, operationId: string): Promise<void> {
  if (actor.principal.kind !== 'agent') return;
  const row = (await db.query<{
    permission_snapshot_json: unknown;
  }>('SELECT permission_snapshot_json FROM runs WHERE id=$1 AND space_id=$2', [actor.run_id, actor.space_id])).rows[0];
  const grants = (row?.permission_snapshot_json as {
    tool_grants?: {
      action_id: string;
    }[];
  } | null)?.tool_grants;
  if (!Array.isArray(grants) || !grants.some(g => g.action_id === operationId)) throw new OperationError('operation_not_granted',403);
}

/** Settings are a person's direct instruction, never inherited delegation authority. */
export async function assertDirectSettingsActor(db: Queryable, actor: OperationActor): Promise<void> {
  if(actor.principal.kind==='user')return;
  if(actor.origin!=='manual'||actor.effective_origin!=='manual'||actor.continuation_hops!==0)throw hidden();
  const run=(await db.query<RunRecord>('SELECT * FROM runs WHERE space_id=$1 AND id=$2',[actor.space_id,actor.run_id])).rows[0];
  if(!run||run.trigger_origin!=='manual'||run.delegation_id
    ||run.instructed_by_agent_id||run.agent_id!==actor.agent_id
    ||run.instructed_by_user_id!==actor.on_behalf_of_user_id)throw hidden();
  // Serial recipients of one human message can have manual parents; these
  // are direct instructions too. No delegated/continuation ancestor may lend
  // authority through such a chain. assertCurrentActor has verified its root.
  const inherited=(await db.query<{denied:boolean}>(`WITH RECURSIVE lineage AS (
    SELECT id,parent_run_id,trigger_origin,delegation_id,instructed_by_agent_id,0 AS depth FROM runs WHERE space_id=$1 AND id=$2
    UNION ALL
    SELECT p.id,p.parent_run_id,p.trigger_origin,p.delegation_id,p.instructed_by_agent_id,l.depth+1 FROM runs p JOIN lineage l ON p.id=l.parent_run_id WHERE p.space_id=$1 AND l.depth<32
  ) SELECT EXISTS(SELECT 1 FROM lineage WHERE trigger_origin<>'manual' OR delegation_id IS NOT NULL OR instructed_by_agent_id IS NOT NULL) AS denied`,[actor.space_id,actor.run_id])).rows[0];
  if(!inherited||inherited.denied)throw hidden();
}
