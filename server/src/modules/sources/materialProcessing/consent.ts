import {createHash} from 'node:crypto';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {insertProposalRow} from '../../proposals/reviewPackets.js';
import {requireProcessingItem} from './items.js';
import {agentReadingPolicy} from './policy.js';
import type {SourceConnectionRow} from '../sourceRepositoryRows.js';
export function materialSourcePolicyHash(source:SourceConnectionRow){return createHash('sha256').update(JSON.stringify([source.id,source.owner_user_id,source.capture_policy,source.policy_json,source.consent_json,source.status])).digest('hex');}
/** One Source-wide owner decision, not per-article exceptions or direct policy
 * writes. All changes still pass through the canonical proposal applier. */
export async function proposeMaterialStorage(db:Queryable,identity:SpaceUserIdentity,itemId:string){
 const {source}=await requireProcessingItem(db,identity,itemId);if(!source||source.owner_user_id!==identity.userId)throw new HttpError(403,'Only the Source owner can allow saved text');
 if(agentReadingPolicy(source).content)return {allowed:true};
 const expected=materialSourcePolicyHash(source);const pending=(await db.query("SELECT id FROM proposals WHERE space_id=$1 AND proposal_type='source_material_retention' AND status='pending' AND created_by_user_id=$2 AND payload_json->>'source_connection_id'=$3 AND payload_json->>'expected_policy_sha256'=$4",[identity.spaceId,identity.userId,source.id,expected])).rows[0];if(pending)return {proposal_id:pending.id,source_name:source.name};
 const p=await insertProposalRow(db,{spaceId:identity.spaceId,proposalType:'source_material_retention',title:`Allow reading content for ${source.name}`,summary:'Allow extracted text and Agent-prepared reading for this Source. No original-page archive, sharing, model-egress or credential permission is added.',payload:{proposal_type:'source_material_retention',source_connection_id:source.id,expected_policy_sha256:expected},rationale:'The Source owner explicitly requested readable saved material.',createdByUserId:identity.userId,ownerUserId:identity.userId,visibility:'private',projectId:source.project_id,riskLevel:'medium'});return {proposal_id:p.id,source_name:source.name};
}
