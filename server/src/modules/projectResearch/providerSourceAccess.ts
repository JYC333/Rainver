import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import type {ServerConfig} from '../../config.js';
import {loadRunProvider,classifyRunDestination} from '../runtimeContext/runDestination.js';
import {ProjectResearchExecutionProfileService} from './executionProfileService.js';
import {loadSourceConnectionIdsForTargets} from '../retrieval/sourcePolicy.js';
import {assertSourceEgressAllowedForDestination} from '../sources/sourcePromptEgress.js';
import type {SourceConnectionRow} from '../sources/sourceRepositoryRows.js';
import {sourceItemReadableClause} from '../sources/sourceItemAccess.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {projectReaderIds} from '../projects/access.js';
import {isProviderEligibleForUser,providerCredentialEligibilitySql,type ProviderEligibilityRow} from '../providers/eligibility.js';

/** Source consent uses the exact admitted ProviderTask destination, never a default Agent/profile. */
export async function assertResearchProviderSourceEgress(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,provider:{providerId:string;modelName:string|null},sourceItemIds:readonly string[],noteIds:readonly string[]=[]):Promise<void>{
 const selected=await new ProjectResearchExecutionProfileService(db,config).resolveProvider(identity,{modelProviderId:provider.providerId,modelName:provider.modelName});
 const facts=(await db.query<ProviderEligibilityRow>(`SELECT p.provider_type,p.enabled AS provider_enabled,g.enabled AS provider_grant_enabled,p.owner_user_id AS provider_owner_user_id,c.credential_type AS provider_credential_type,${providerCredentialEligibilitySql('p.id','p.credential_id','c')} AS provider_has_eligible_credential FROM model_providers p JOIN model_provider_space_grants g ON g.provider_id=p.id LEFT JOIN credentials c ON c.id=p.credential_id WHERE p.id=$1 AND g.space_id=$2 FOR SHARE OF p,g`,[selected.modelProviderId,identity.spaceId])).rows[0];
 if(!facts||!isProviderEligibleForUser(facts,identity.userId))throw new HttpError(403,'Research ProviderTask authorization is no longer available');
 const destination=classifyRunDestination({model_provider_id:selected.modelProviderId,model_override_json:{model:selected.modelName}},await loadRunProvider(db,identity.spaceId,selected.modelProviderId),identity.spaceId);
 const ids=[...new Set(sourceItemIds)];
 const sources=ids.length?(await db.query<{connection_id:string|null}>(`SELECT connection_id FROM source_items item WHERE item.space_id=$1 AND item.id=ANY($2::varchar[]) AND item.deleted_at IS NULL AND ${sourceItemReadableClause('item','$3',false)}`,[identity.spaceId,ids,identity.userId])).rows:[];
 if(sources.length!==ids.length)throw new HttpError(404,'Research source material is no longer readable');
 const connections=new Set(sources.flatMap(source=>source.connection_id?[source.connection_id]:[]));
 for(const group of (await loadSourceConnectionIdsForTargets(db,identity.spaceId,'note',noteIds)).values())for(const id of group)connections.add(id);
 for(const id of [...connections].sort()){
  const source=(await db.query<SourceConnectionRow>("SELECT * FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL AND status<>'archived' FOR SHARE",[id,identity.spaceId])).rows[0];
  if(!source)throw new HttpError(404,'Research Source is no longer available');
  await assertSourceEgressAllowedForDestination(db,source,destination);
 }
}

/** A direct co-edit may copy selected excerpts only to a Note's current full-content readers. */
export async function assertResearchNoteSourceAudience(db:Queryable,identity:SpaceUserIdentity,noteId:string,sourceItemIds:readonly string[],contextNoteIds:readonly string[]=[]):Promise<void>{
 const ids=[...new Set(sourceItemIds)],notes=[...new Set(contextNoteIds)];if(!ids.length&&!notes.length)return;
 const readers=(await db.query<{user_id:string}>(`SELECT member.user_id FROM space_memberships member JOIN users person ON person.id=member.user_id JOIN space_objects note ON note.space_id=member.space_id AND note.id=$2 WHERE member.space_id=$1 AND member.status='active' AND person.status='active' AND ${contentReadSql('space_object','note','member.user_id',{includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition('space_object')!,alias:'note',userExpr:'member.user_id',includeOversight:false})}='full' ORDER BY member.user_id`,[identity.spaceId,noteId])).rows.map(row=>row.user_id);
 await assertResearchAudience(db,identity,readers,ids,notes);
}

/** Publication to a new ordinary Project Note has the Project's complete current audience. */
export async function assertResearchProjectSourceAudience(db:Queryable,identity:SpaceUserIdentity,projectId:string,sourceItemIds:readonly string[],contextNoteIds:readonly string[]=[]):Promise<void>{
 const ids=[...new Set(sourceItemIds)],notes=[...new Set(contextNoteIds)];if(!ids.length&&!notes.length)return;
 await assertResearchAudience(db,identity,await projectReaderIds(db,identity.spaceId,projectId),ids,notes);
}

async function assertResearchAudience(db:Queryable,identity:SpaceUserIdentity,readers:readonly string[],ids:readonly string[],notes:readonly string[]){
 if(!readers.length)throw new HttpError(404,'Research Note is no longer readable');
 const allowed=await db.query(`SELECT item.id FROM source_items item WHERE item.space_id=$1 AND item.id=ANY($2::varchar[]) AND item.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM unnest($3::varchar[]) audience(user_id) WHERE NOT ${sourceItemReadableClause('item','audience.user_id',false)})`,[identity.spaceId,ids,readers]);
 if(allowed.rows.length!==ids.length)throw new HttpError(403,'Selected research material is not available to the Note audience');
 if(notes.length){
  const shared=await db.query(`SELECT context_note.id FROM space_objects context_note WHERE context_note.space_id=$1 AND context_note.id=ANY($2::varchar[]) AND context_note.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM unnest($3::varchar[]) audience(user_id) WHERE NOT ${contentReadSql('space_object','context_note','audience.user_id',{includeOversight:false})} OR ${contentAccessLevelSql({definition:contentResourceDefinition('space_object')!,alias:'context_note',userExpr:'audience.user_id',includeOversight:false})}<>'full')`,[identity.spaceId,notes,readers]);
  if(shared.rows.length!==notes.length)throw new HttpError(403,'Research context Notes are not available to the edited Note audience');
 }
}
