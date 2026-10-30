import { createHash } from 'node:crypto';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../../routeUtils/common.js';
import { canReadProject, projectReaderIds } from '../../projects/access.js';
import { sourceItemFullContentReadClause, sourceConnectionReaderConsentClause } from '../sourceItemAccess.js';
import { contentAccessLevelSql } from '../../access/contentAccessSql.js';
import { contentResourceDefinition } from '../../access/contentAccessRegistry.js';
import { requireProcessingItem, materialAuthority } from '../materialProcessing/items.js';
import { assertSourcePromptEgressAllowed, assertSourceEgressAllowedForDestination } from '../sourcePromptEgress.js';
import { runDestination } from '../../runtimeContext/runDestination.js';
import type {SourceConnectionRow} from '../sourceRepositoryRows.js';
import type { RunRecord } from '../../runs/repository.js';

export async function readingProjectContext(db:Queryable, identity:SpaceUserIdentity, projectId:string|null) {
  if(!projectId) return null;
  if(!await canReadProject(db,identity.spaceId,projectId,identity.userId)) throw new HttpError(404,'Project not found');
  const row=(await db.query(`SELECT p.id,p.name,p.active_instruction_version_id AS instruction_version_id,b.id AS brief_id,b.goal,b.constraints,b.success_definition,b.scope_included,b.scope_excluded FROM projects p LEFT JOIN project_brief_versions b ON b.id=p.active_brief_version_id AND b.project_id=p.id WHERE p.id=$1 AND p.space_id=$2 AND p.deleted_at IS NULL`,[projectId,identity.spaceId])).rows[0];
  if(!row)throw new HttpError(404,'Project not found');return row;
}
/** Text going into project investigation is available to its complete current audience, never oversight. */
export async function assertReadingAudience(db:Queryable, identity:SpaceUserIdentity, projectId:string|null, itemId:string|null, connectionId:string|null) {
  const readers=projectId?await projectReaderIds(db,identity.spaceId,projectId):[identity.userId];
  if(!readers.length)throw new HttpError(403,'No reading audience');
  for(const user of readers){
    if(itemId && !(await db.query(`SELECT i.id FROM source_items i WHERE i.space_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND ${sourceItemFullContentReadClause('i','$3')}`,[identity.spaceId,itemId,user])).rows.length)throw new HttpError(403,'Material is not shared with the whole reading audience');
    if(connectionId && !(await db.query(`SELECT c.id FROM source_connections c WHERE c.space_id=$1 AND c.id=$2 AND c.deleted_at IS NULL AND c.status<>'archived' AND ${sourceConnectionReaderConsentClause('c','$3','now()', {includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition('source_connection')!,alias:'c',userExpr:'$3',includeOversight:false})}='full'`,[identity.spaceId,connectionId,user])).rows.length)throw new HttpError(403,'Source is not shared with the whole reading audience');
  }
}
export async function readingItemContext(db:Queryable,identity:SpaceUserIdentity,itemId:string,projectId?:string|null) {
  const {item,source}=await requireProcessingItem(db,identity,itemId,false);
  const scope=projectId??item.project_id;
  if(item.project_id && scope!==item.project_id) throw new HttpError(403,'Material scope mismatch');
  const context=await readingProjectContext(db,identity,scope);
  await assertReadingAudience(db,identity,scope,item.id,source?.id??null);
  return {item,source,projectId:scope,context,authority:createHash('sha256').update(JSON.stringify([materialAuthority(item,source),item.extracted_artifact_id,item.raw_artifact_id])).digest('hex'),contextHash:createHash('sha256').update(JSON.stringify(context)).digest('hex')};
}
export async function assertReadingRunEgress(db:Queryable,run:RunRecord,connectionId:string|null) {
  if(!connectionId)return;
  const source=(await db.query<SourceConnectionRow>(`SELECT * FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL AND status<>'archived'`,[connectionId,run.space_id])).rows[0];
  if(!source)throw new HttpError(403,'Source unavailable');
  if(run.runtime_key) await assertSourceEgressAllowedForDestination(db,source,await runDestination(db,run.space_id,run));
  else if(run.agent_id&&run.requested_runtime_profile_id)await assertSourcePromptEgressAllowed(db,source,run.agent_id,run.requested_runtime_profile_id);
}

/** New Project context may influence only material whose canonical owner is that Project. */
export async function collectionReadingContext(db:Queryable,identity:SpaceUserIdentity,projectId:string|null,sourceProjectId:string|null){
 const bound=sourceProjectId===projectId?projectId:null;
 return {projectId:bound,context:await readingProjectContext(db,identity,bound)};
}
