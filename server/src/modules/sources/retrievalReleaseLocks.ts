import {HttpError,type Queryable} from '../routeUtils/common.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {lockActivePeople} from '../access/activePerson.js';
import {lockActiveProjectForMutation,lockProjectAudience} from '../projects/access.js';
import type {RetrievalObjectType} from '@rainver/protocol';

type Ref={object_type:RetrievalObjectType|'source_snapshot'|'source_connection'|'space_object'|'memory'|'activity'|'artifact'|'proposal'|'run'|'agent'|'task';object_id:string};
type Resource={type:string;id:string;project:string|null;folder:string|null;shares:string[];dependencies:{type:string;id:string}[]};
/** Authority-free discovery of the Source read closure of `refs`. */
async function discoverSourceRelease(db:Queryable,spaceId:string,refs:readonly Ref[],additionalFolders:readonly string[],viewers:readonly string[]=[]){
 const resources=new Map<string,Resource>();
 const queue=refs.filter(r=>['source_item','extracted_evidence','source_snapshot','source_connection','space_object','memory','activity','artifact','proposal','run','agent','task'].includes(r.object_type)).map(r=>({type:r.object_type as string,id:r.object_id}));
 for(let index=0;index<queue.length;index++){
  const ref=queue[index]!,key=ref.type+':'+ref.id;if(resources.has(key))continue;
  const d=contentResourceDefinition(ref.type);if(!d)throw new HttpError(409,'Source retrieval authority is not registered');
  const extra=ref.type==='extracted_evidence'?'COALESCE(source_item_id,origin_source_item_id) AS item,source_snapshot_id AS snapshot,source_object_id AS object':ref.type==='source_snapshot'?'connection_id AS connection,source_item_id AS item':ref.type==='source_item'?'connection_id AS connection':'NULL AS connection';
  const row=(await db.query<{project:string|null;folder:string|null;item?:string;snapshot?:string;object?:string;connection?:string}>(`SELECT ${d.projectColumn??'NULL'} AS project,${d.projectFolderColumn??'NULL'} AS folder,${extra} FROM ${d.tableName} WHERE space_id=$1 AND id=$2`,[spaceId,ref.id])).rows[0];
  const dependencies=[...(row?.item?[{type:'source_item',id:row.item}]:[]),...(row?.snapshot?[{type:'source_snapshot',id:row.snapshot}]:[]),...(row?.object?[{type:'space_object',id:row.object}]:[]),...(row?.connection?[{type:'source_connection',id:row.connection}]:[])];
  const shares=d.projectShare?(await db.query<{project:string}>(`SELECT ${d.projectShare.projectColumn} AS project FROM ${d.projectShare.tableName} WHERE space_id=$1 AND ${d.projectShare.resourceColumn}=$2 AND ${d.projectShare.revokedColumn} IS NULL ORDER BY ${d.projectShare.projectColumn}`,[spaceId,ref.id])).rows.map(r=>r.project):[];
  resources.set(key,{...ref,project:row?.project??null,folder:row?.folder??null,shares,dependencies});queue.push(...dependencies);
 }
 // Folder membership is also a read dependency of ontology provenance.
 const folders=[...new Set([...additionalFolders,...[...resources.values()].flatMap(r=>r.folder?[r.folder]:[])])].sort();
 const folderProjects=folders.length?(await db.query<{id:string;project_id:string|null}>(`SELECT id,project_id FROM project_folders WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id`,[spaceId,folders])).rows:[];
 const grants=[];
 if(viewers.length)for(const r of resources.values())grants.push(...(await db.query<{id:string;granted_by_user_id:string;revoked_at:unknown}>(
  'SELECT id,granted_by_user_id,revoked_at FROM content_access_grants WHERE space_id=$1 AND resource_type=$2 AND resource_id=$3 AND grantee_user_id=ANY($4::varchar[]) ORDER BY id',[spaceId,r.type,r.id,viewers])).rows);
 return {grants,resources:[...resources.values()].sort((a,b)=>(a.type+':'+a.id).localeCompare(b.type+':'+b.id)),folders,folderProjects};
}

function releaseProjects(before:Awaited<ReturnType<typeof discoverSourceRelease>>,additionalProjects:readonly string[]):string[]{
 return [...new Set([...additionalProjects,...before.resources.flatMap(r=>[...(r.project?[r.project]:[]),...r.shares]),...before.folderProjects.flatMap(f=>f.project_id?[f.project_id]:[])])].sort();
}

/** The Projects `lockSourceRetrievalRelease` would lock for these refs, discovered
 * without locks, for a caller that must take them before a lock it already
 * holds (the Delivery gate takes every Project before its Run). */
export async function sourceRetrievalReleaseProjects(db:Queryable,spaceId:string,refs:readonly Ref[],additionalProjects:readonly string[]=[],additionalFolders:readonly string[]=[]):Promise<string[]>{
 return releaseProjects(await discoverSourceRelease(db,spaceId,refs,additionalFolders),additionalProjects);
}

/** Pin the complete Source read closure before the canonical adapter/read-policy
 * checks and B11 write. Discovery is authority-free. Changed lineage/scope after
 * waiting is a conflict, never authority to acquire a new, unsorted closure.
 * Shared across all hits: Projects/audiences, person, spaces, folders, roots,
 * grants, channels, subscriptions and historical windows, each in stable order.
 * Missing/deleted/archived objects are left for the canonical gate to withhold.
 * `beforeContent` runs after Folders and before the first content row, for a
 * caller whose own closure must sit between them in the global order.
 * `additionalFolders` are Folders of rows the caller locks itself (a Task's),
 * taken in the same Folder phase with their owning Projects' audiences.
 * `additionalPeople` pins every responsible/granting person before domain roots;
 * it grants no read authority to any of them. `writtenProjects` upgrades only
 * discovered destinations in this initial Project phase, before other locks.
 */
export async function lockSourceRetrievalRelease(db:Queryable,spaceId:string,userId:string,refs:readonly Ref[],additionalProjects:readonly string[]=[],beforeContent?:()=>Promise<void>,additionalFolders:readonly string[]=[],additionalPeople:readonly string[]=[],exclusiveRefs:readonly Ref[]=[],writtenProjects:readonly string[]=[]):Promise<void>{
 await lockSourceRetrievalReleaseBatch(db,[{spaceId,userId,refs,additionalProjects,beforeContent,additionalFolders,additionalPeople,exclusiveRefs,writtenProjects}]);
}

export interface SourceReleaseScope {
 spaceId:string; userId:string; refs:readonly Ref[]; allowInactiveViewer?:true; additionalProjects?:readonly string[];
 beforeContent?:()=>Promise<void>; additionalFolders?:readonly string[];
 additionalPeople?:readonly string[]; exclusiveRefs?:readonly Ref[]; writtenProjects?:readonly string[];
 /** The only Projects this release may reach (a caller already holding them). A closure that
  * reaches any other refuses (409) at discovery, before this release takes any lock. */
 confineProjects?:readonly string[];
}
/** One phase order across every contributing Space. The one-Space entry delegates
 * here too, so cross-Space release cannot fork Source authority or lock rules. */
export async function lockSourceRetrievalReleaseBatch(db:Queryable,scopes:readonly SourceReleaseScope[]):Promise<void>{
 const plans=[];
 for(const scope of [...scopes].sort((a,b)=>a.spaceId.localeCompare(b.spaceId))){
  const {spaceId,userId,refs,allowInactiveViewer,additionalProjects=[],beforeContent,additionalFolders=[],additionalPeople=[],exclusiveRefs=[],writtenProjects=[],confineProjects}=scope;
  const discover=()=>discoverSourceRelease(db,spaceId,refs,additionalFolders,[userId,...additionalPeople]);
  const before=await discover();
  const projects=releaseProjects(before,additionalProjects);
  // Never wait on a Project outside the caller's held scope: the closure can change between a
  // caller's own discovery and this one (an unplaced Task moved into another Project).
  if(confineProjects&&projects.some(id=>!confineProjects.includes(id)))throw new HttpError(409,'Source release reaches another Project');
  if(writtenProjects.some(id=>!projects.includes(id)))throw new HttpError(409,'Source release write scope changed');
  plans.push({spaceId,userId,allowInactiveViewer,beforeContent,additionalPeople,writtenProjects,discover,before,projects,exclusive:new Set(exclusiveRefs.map(r=>r.object_type+':'+r.object_id))});
 }
 for(const {spaceId,projects,writtenProjects} of plans)for(const id of projects){
  if(writtenProjects.includes(id))await lockActiveProjectForMutation(db,spaceId,id);
  await lockProjectAudience(db,spaceId,id);
 }
 // Every user root precedes every Space membership, including cross-Space scopes.
 const people=[...new Set(plans.flatMap(p=>[p.userId,...p.additionalPeople,...p.before.grants.map(g=>g.granted_by_user_id)]))].sort();
 if(people.length)await db.query('SELECT id FROM users WHERE id=ANY($1::varchar[]) ORDER BY id FOR SHARE',[people]);
 for(const {spaceId,userId,additionalPeople,allowInactiveViewer} of plans){
  if(!allowInactiveViewer)await lockActivePeople(db,spaceId,[userId,...additionalPeople]);
  else{
   // A person pointer resolver pins a revoked membership so the canonical gate
   // can mark that pointer unresolved; it never grants membership authority.
   if(!(await db.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE",[userId])).rows.length)throw new HttpError(403,'Active user required');
   await db.query('SELECT id FROM space_memberships WHERE space_id=$1 AND user_id=$2 ORDER BY id FOR SHARE',[spaceId,userId]);
   if(additionalPeople.length)await lockActivePeople(db,spaceId,additionalPeople);
  }
 }
 for(const {spaceId,before} of plans){
  const grantors=[...new Set(before.grants.map(g=>g.granted_by_user_id))].sort();
  if(grantors.length)await db.query('SELECT id FROM space_memberships WHERE space_id=$1 AND user_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[spaceId,grantors]);
 }
 for(const {spaceId} of plans)await db.query('SELECT id FROM spaces WHERE id=$1 FOR SHARE',[spaceId]);
 for(const {spaceId,before} of plans)if(before.folders.length)await db.query('SELECT id FROM project_folders WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[spaceId,before.folders]);
 for(const {beforeContent} of plans)await beforeContent?.();
 for(const {spaceId,userId,additionalPeople,before,exclusive} of plans){
 for(const r of before.resources){
  const d=contentResourceDefinition(r.type)!;
  await db.query(`SELECT id FROM ${d.tableName} WHERE space_id=$1 AND id=$2 FOR ${exclusive.has(r.type+':'+r.id)?'UPDATE':'SHARE'}`,[spaceId,r.id]);
  if(d.projectShare)await db.query(`SELECT ${d.projectShare.projectColumn} FROM ${d.projectShare.tableName} WHERE space_id=$1 AND ${d.projectShare.resourceColumn}=$2 ORDER BY ${d.projectShare.projectColumn} FOR SHARE`,[spaceId,r.id]);
  await db.query(`SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type=$2 AND resource_id=$3 AND grantee_user_id=ANY($4::varchar[]) ORDER BY id FOR SHARE`,[spaceId,r.type,r.id,[...new Set([userId,...additionalPeople])].sort()]);
 }
 const connections=before.resources.filter(r=>r.type==='source_connection').map(r=>r.id);
 if(connections.length){
  await db.query(`SELECT id FROM source_channels WHERE space_id=$1 AND source_connection_id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[spaceId,connections]);
  await db.query(`SELECT s.id FROM source_channel_user_subscriptions s JOIN source_channels c ON c.id=s.source_channel_id AND c.space_id=s.space_id WHERE s.space_id=$1 AND c.source_connection_id=ANY($2::varchar[]) AND s.user_id=ANY($3::varchar[]) ORDER BY s.id FOR SHARE OF s`,[spaceId,connections,[...new Set([userId,...additionalPeople])].sort()]);
  await db.query(`SELECT w.id FROM source_channel_subscription_windows w JOIN source_channels c ON c.id=w.source_channel_id AND c.space_id=w.space_id WHERE w.space_id=$1 AND c.source_connection_id=ANY($2::varchar[]) AND w.user_id=ANY($3::varchar[]) ORDER BY w.id FOR SHARE OF w`,[spaceId,connections,[...new Set([userId,...additionalPeople])].sort()]);
 }
 }
 for(const {before,discover} of plans)if(JSON.stringify(before)!==JSON.stringify(await discover()))throw new HttpError(409,'Source retrieval lineage changed; read again');
}
