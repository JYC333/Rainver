import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../../routeUtils/common.js';
import {hidden} from './errors.js';

/** Closed list of reviewed ADR 0013 person-scoped exceptions. Never plugin supplied. */
export const PERSON_OPERATIONS: ReadonlySet<string> = new Set(['auth.user.disable','auth.user.enable','personal.retrieval.search','personal.retrieval.resolve','personal.retrieval.summary.store','personal.retrieval.egress.disclose','personal.retrieval.fused.store','capture.file','attention.views.record','attention.read_state.change','personal_memory_grant.preview','personal_memory_grant.create','personal_memory_grant.revoke']);

/** The person themselves, directly: no Agent, Run, continuation or other surface acts or carries the call. */
export function isPersonActingDirectly(actor:OperationActor):boolean {
  return actor.principal.kind==='user'&&actor.principal.id===actor.on_behalf_of_user_id&&!actor.agent_id&&!actor.run_id&&!actor.root_run_id&&actor.continuation_hops===0
    &&actor.origin==='manual'&&actor.effective_origin==='manual'&&['public_api','web'].includes(actor.surface);
}

export async function assertCurrentPerson(db:Queryable, actor:OperationActor, lock=false):Promise<void> {
  if(!isPersonActingDirectly(actor))throw hidden();
  if(!(await db.query(`SELECT id FROM users WHERE id=$1 AND status='active' ${lock?'FOR SHARE':''}`,[actor.principal.id])).rows.length)throw hidden();
}

export {personalReceiptSpace} from '../../access/personalSpace.js';
