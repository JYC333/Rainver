import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import type {ServerConfig} from '../../config.js';
import {loadRunProvider,classifyRunDestination} from '../runtimeContext/runDestination.js';
import {ProjectResearchExecutionProfileService} from './executionProfileService.js';
import {loadSourceConnectionIdsForTargets,readableSourceConnectionIds,sourceLineageReadableTargets} from '../retrieval/sourcePolicy.js';
import {assertSourceEgressAllowedForDestination} from '../sources/sourcePromptEgress.js';
import type {SourceConnectionRow} from '../sources/sourceRepositoryRows.js';
import {sourceItemFullContentReadClause} from '../sources/sourceItemAccess.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {projectReaderIds} from '../projects/access.js';
import {isProviderEligibleForUser,providerCredentialEligibilitySql,type ProviderEligibilityRow} from '../providers/eligibility.js';

/**
 * Source consent uses the exact admitted ProviderTask destination, never a default Agent/profile.
 * `pinnedConnectionIds` are the Sources the frozen prompt was built under (see
 * `frozenResearchSourcePins`): they answer beside the live lineage, so a rebind after
 * the prompt was frozen never drops the original Source's consent.
 */
export async function assertResearchProviderSourceEgress(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,provider:{providerId:string;modelName:string|null},sourceItemIds:readonly string[],noteIds:readonly string[]=[],pinnedConnectionIds:readonly string[]=[]):Promise<void>{
 const selected=await new ProjectResearchExecutionProfileService(db,config).resolveProvider(identity,{modelProviderId:provider.providerId,modelName:provider.modelName});
 const facts=(await db.query<ProviderEligibilityRow>(`SELECT p.provider_type,p.enabled AS provider_enabled,g.enabled AS provider_grant_enabled,p.owner_user_id AS provider_owner_user_id,c.credential_type AS provider_credential_type,${providerCredentialEligibilitySql('p.id','p.credential_id','c')} AS provider_has_eligible_credential FROM model_providers p JOIN model_provider_space_grants g ON g.provider_id=p.id LEFT JOIN credentials c ON c.id=p.credential_id WHERE p.id=$1 AND g.space_id=$2 FOR SHARE OF p,g`,[selected.modelProviderId,identity.spaceId])).rows[0];
 if(!facts||!isProviderEligibleForUser(facts,identity.userId))throw new HttpError(403,'Research ProviderTask authorization is no longer available');
 const destination=classifyRunDestination({model_provider_id:selected.modelProviderId,model_override_json:{model:selected.modelName}},await loadRunProvider(db,identity.spaceId,selected.modelProviderId),identity.spaceId);
 const ids=[...new Set(sourceItemIds)];
 const sources=ids.length?(await db.query<{connection_id:string|null}>(`SELECT connection_id FROM source_items item WHERE item.space_id=$1 AND item.id=ANY($2::varchar[]) AND item.deleted_at IS NULL AND ${sourceItemFullContentReadClause('item','$3')}`,[identity.spaceId,ids,identity.userId])).rows:[];
 if(sources.length!==ids.length)throw new HttpError(404,'Research source material is no longer readable');
 const connections=new Set(sources.flatMap(source=>source.connection_id?[source.connection_id]:[]));
 for(const group of (await loadSourceConnectionIdsForTargets(db,identity.spaceId,'note',noteIds)).values())for(const id of group)connections.add(id);
 for(const id of pinnedConnectionIds)connections.add(id);
 for(const id of [...connections].sort()){
  const source=(await db.query<SourceConnectionRow>("SELECT * FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL AND status<>'archived' FOR SHARE",[id,identity.spaceId])).rows[0];
  if(!source)throw new HttpError(404,'Research Source is no longer available');
  await assertSourceEgressAllowedForDestination(db,source,destination);
 }
}

/** A direct co-edit may copy selected excerpts only to a Note's current full-content readers. */
export async function assertResearchNoteSourceAudience(db:Queryable,identity:SpaceUserIdentity,noteId:string,sourceItemIds:readonly string[],contextNoteIds:readonly string[]=[],pinnedConnectionIds:readonly string[]=[]):Promise<void>{
 const ids=[...new Set(sourceItemIds)],notes=[...new Set(contextNoteIds)];if(!ids.length&&!notes.length&&!pinnedConnectionIds.length)return;
 const readers=(await db.query<{user_id:string}>(`SELECT member.user_id FROM space_memberships member JOIN users person ON person.id=member.user_id JOIN space_objects note ON note.space_id=member.space_id AND note.id=$2 WHERE member.space_id=$1 AND member.status='active' AND person.status='active' AND ${contentReadSql('space_object','note','member.user_id',{includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition('space_object')!,alias:'note',userExpr:'member.user_id',includeOversight:false})}='full' ORDER BY member.user_id`,[identity.spaceId,noteId])).rows.map(row=>row.user_id);
 await assertResearchAudience(db,identity,readers,ids,notes,pinnedConnectionIds);
}

/** Publication to a new ordinary Project Note has the Project's complete current audience. */
export async function assertResearchProjectSourceAudience(db:Queryable,identity:SpaceUserIdentity,projectId:string,sourceItemIds:readonly string[],contextNoteIds:readonly string[]=[],pinnedConnectionIds:readonly string[]=[]):Promise<void>{
 const ids=[...new Set(sourceItemIds)],notes=[...new Set(contextNoteIds)];if(!ids.length&&!notes.length&&!pinnedConnectionIds.length)return;
 await assertResearchAudience(db,identity,await projectReaderIds(db,identity.spaceId,projectId),ids,notes,pinnedConnectionIds);
}

async function assertResearchAudience(db:Queryable,identity:SpaceUserIdentity,readers:readonly string[],ids:readonly string[],notes:readonly string[],pinned:readonly string[]){
 if(!readers.length)throw new HttpError(404,'Research Note is no longer readable');
 // The Sources the frozen prompt was built under answer for the written Note (its lineage pins
 // them), so every reader of the Note must read each of them too, however items are bound now.
 const pins=[...new Set(pinned)];
 if(pins.length)for(const reader of readers)if((await readableSourceConnectionIds(db,identity.spaceId,pins,{viewerUserId:reader})).size!==pins.length)throw new HttpError(403,'Research Sources are not available to the edited Note audience');
 const allowed=await db.query(`SELECT item.id FROM source_items item WHERE item.space_id=$1 AND item.id=ANY($2::varchar[]) AND item.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM unnest($3::varchar[]) audience(user_id) WHERE NOT ${sourceItemFullContentReadClause('item','audience.user_id')})`,[identity.spaceId,ids,readers]);
 if(allowed.rows.length!==ids.length)throw new HttpError(403,'Selected research material is not available to the Note audience');
 if(notes.length){
  const shared=await db.query(`SELECT context_note.id FROM space_objects context_note WHERE context_note.space_id=$1 AND context_note.id=ANY($2::varchar[]) AND context_note.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM unnest($3::varchar[]) audience(user_id) WHERE NOT ${contentReadSql('space_object','context_note','audience.user_id',{includeOversight:false})} OR ${contentAccessLevelSql({definition:contentResourceDefinition('space_object')!,alias:'context_note',userExpr:'audience.user_id',includeOversight:false})}<>'full')`,[identity.spaceId,notes,readers]);
  if(shared.rows.length!==notes.length)throw new HttpError(403,'Research context Notes are not available to the edited Note audience');
  // The written Note inherits the context Notes' Source lineage (inheritNoteSourceLineage), so
  // its audience must already read those Sources: otherwise the write would either reach a reader
  // the Sources do not admit or silently withhold the Note from one. Either way it is refused.
  for(const reader of readers)if((await sourceLineageReadableTargets(db,identity.spaceId,'note',notes,{viewerUserId:reader})).size!==notes.length)throw new HttpError(403,'Research context Note Sources are not available to the edited Note audience');
 }
}

/** Each selected Source item's connection when a research prompt is frozen (none for an unbound item). */
export async function freezeSourceItemConnections(db:Queryable,spaceId:string,itemIds:readonly string[],prior:Readonly<Record<string,readonly string[]>>={}):Promise<Record<string,string[]>>{
 const ids=[...new Set(itemIds)].sort();if(!ids.length)return {};
 const rows=(await db.query<{id:string;connection_id:string|null}>('SELECT id,connection_id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[])',[spaceId,ids])).rows;
 const byId=new Map(rows.map(row=>[row.id,row.connection_id]));
 return Object.fromEntries(ids.map(id=>[id,[...new Set([...(prior[id]??[]),...(byId.get(id)?[byId.get(id)!]:[])])].sort()]));
}

/**
 * What a queued research Run froze about its Sources: each selected item's connections
 * (`source_item_connections`) and, for a notebook chat, its context Notes' lineage
 * connections (`note_source_connection_ids`). `pins` is every frozen connection; every
 * send and write-back checks them beside the live lineage. `null` when the Run predates
 * the freeze (an item it selected, or its Notes' connections, were not frozen): it cannot
 * prove which Sources its prompt copied, so it is refused rather than sent or written back.
 */
export function frozenResearchSourcePins(frozen:Record<string,unknown>,sourceItemIds:readonly string[],opts:{noteConnections:boolean}):{items:Record<string,string[]>;pins:string[]}|null{
 const items=parseSourceItemConnections(frozen.source_item_connections);
 if(sourceItemIds.some(id=>!(id in items)))return null;
 const notes=frozen.note_source_connection_ids;
 if(opts.noteConnections&&!Array.isArray(notes))return null;
 const noteIds=Array.isArray(notes)?notes.filter((id):id is string=>typeof id==='string'):[];
 return {items,pins:[...new Set([...noteIds,...sourceItemIds.flatMap(id=>items[id]??[])])].sort()};
}
export function parseSourceItemConnections(raw:unknown):Record<string,string[]>{
 const items:Record<string,string[]>={};
 if(raw&&typeof raw==='object'&&!Array.isArray(raw))for(const [id,value] of Object.entries(raw as Record<string,unknown>))items[id]=Array.isArray(value)?value.filter((c):c is string=>typeof c==='string'):[];
 return items;
}

/** The person still reads every frozen Source of the Run, by the lineage read rule. */
export async function assertFrozenSourcesReadable(db:Queryable,identity:SpaceUserIdentity,pins:readonly string[],message:string):Promise<void>{
 const ids=[...new Set(pins)];
 if(ids.length&&(await readableSourceConnectionIds(db,identity.spaceId,ids,{viewerUserId:identity.userId})).size!==ids.length)throw new HttpError(404,message);
}
