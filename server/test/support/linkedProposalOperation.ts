import {randomUUID} from 'node:crypto';
import {withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../../src/modules/routeUtils/common.js';
import {sessionActor} from '../../src/modules/systemActions/operations/actor.js';
import {fingerprint,record,requestScope,reserve} from '../../src/modules/systemActions/operations/repository.js';
/** Test-only mapping through the real P1 request writer. No production mappings. */
export async function linkProposalOperation(db:Queryable,identity:SpaceUserIdentity,id:string){
 const proposal=(await db.query('SELECT payload_json,proposal_type,project_id FROM proposals WHERE id=$1 AND space_id=$2',[id,identity.spaceId])).rows[0] as {payload_json:unknown;proposal_type:string;project_id:string|null};
 const actor=sessionActor(identity),input={proposal_id:id},targets={project_id:proposal.project_id};
 const scope=requestScope(actor,proposal.project_id?`project:${proposal.project_id}`:`space:${identity.spaceId}`,'fixture.proposal',randomUUID());
 return withQueryableTransaction(db,async tx=>{
  await reserve(tx,scope);
  return record(tx,scope,1,fingerprint(1,input,targets),'pending_approval',{status:'pending_approval',proposal_id:id},202,id,
   {actor,input,targets,payload:proposal.payload_json,preconditions:{},gate_rule:null,
    mapping:{mode:'proposal_submission',gate:{kind:'hard_gate',gate_class:'direction'},proposal_type:proposal.proposal_type,requires_live_run:false}});
 });
}
