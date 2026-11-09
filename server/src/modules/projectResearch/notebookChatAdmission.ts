import {loadSourceConnectionIdsForTargets} from '../retrieval/sourcePolicy.js';
import type {ServerConfig} from '../../config.js';
import {assertResearchProviderSourceEgress} from './providerSourceAccess.js';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {sourceItemReadableClause} from '../sources/sourceItemAccess.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {canonical} from '../systemActions/operations/repository.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {PgSessionRepository} from '../sessions/repository.js';
const strings=(value:unknown)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
export async function discoverNotebookChat(db:Queryable,identity:SpaceUserIdentity,projectId:string,sourceIds:string[],pinnedNotes?:string[]){
 const notes=(await db.query<{id:string;primary_project_id:string|null}>(`SELECT so.id,so.primary_project_id FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id WHERE so.space_id=$1 AND so.primary_project_id=$2 AND n.status='active' AND so.deleted_at IS NULL AND ($4::varchar[] IS NULL OR so.id=ANY($4::varchar[])) AND ${contentReadSql('space_object','so','$3')} AND ${contentAccessLevelSql({definition:contentResourceDefinition('space_object')!,alias:'so',userExpr:'$3'})}='full' ORDER BY so.id`,[identity.spaceId,projectId,identity.userId,pinnedNotes??null])).rows;
 const sources=(await db.query<{id:string;project_id:string|null;connection_id:string|null;parent_project_id:string|null}>(`SELECT DISTINCT si.id,si.project_id,si.connection_id,sc.project_id AS parent_project_id FROM project_corpus_items pci JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id LEFT JOIN source_connections sc ON sc.id=si.connection_id AND sc.space_id=si.space_id WHERE pci.space_id=$1 AND pci.project_id=$2 AND pci.status='active' AND si.id=ANY($3::varchar[]) AND si.deleted_at IS NULL AND ${sourceItemReadableClause('si','$4',false)} ORDER BY si.id`,[identity.spaceId,projectId,sourceIds,identity.userId])).rows;
 const derived=new Set<string>();for(const refs of (await loadSourceConnectionIdsForTargets(db,identity.spaceId,'note',notes.map(note=>note.id))).values())for(const id of refs)derived.add(id);
 const noteConnections=(await db.query<{id:string;project_id:string|null}>('SELECT id,project_id FROM source_connections WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[identity.spaceId,[...derived]])).rows;
 return {notes,sources,noteConnections};
}
export async function authorizeNotebookChat(db:Queryable,identity:SpaceUserIdentity,projectId:string,sourceIds:string[],before:Awaited<ReturnType<typeof discoverNotebookChat>>,sessionId?:string|null,pinnedNotes?:string[]){
 await assertProjectWriter(db,identity.spaceId,projectId,identity.userId,{allowArchived:true});
 const projects=[...new Set([projectId,...before.notes.map(n=>n.primary_project_id),...before.noteConnections.map(c=>c.project_id),...before.sources.flatMap(s=>[s.project_id,s.parent_project_id])].filter((id):id is string=>!!id))].sort();
 for(const project of projects){if(project===projectId){await lockActiveProjectForMutation(db,identity.spaceId,project);await assertProjectWriterForMutation(db,identity.spaceId,project,identity.userId);}else await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[project,identity.spaceId]);}
 await db.query('SELECT id FROM project_members WHERE space_id=$1 AND project_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE',[identity.spaceId,projects,identity.userId]);
 const connections=[...new Set([...before.noteConnections.map(c=>c.id),...before.sources.flatMap(s=>s.connection_id?[s.connection_id]:[])])].sort();
 await db.query('SELECT id FROM source_connections WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[identity.spaceId,connections]);
 const channels=(await db.query<{id:string}>('SELECT id FROM source_channels WHERE space_id=$1 AND source_connection_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[identity.spaceId,connections])).rows.map(r=>r.id);
 for(const table of ['source_channel_user_subscriptions','source_channel_subscription_windows'])await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND source_channel_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE`,[identity.spaceId,channels,identity.userId]);
 await db.query('SELECT id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[identity.spaceId,before.sources.map(s=>s.id)]);
 await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[identity.spaceId,before.notes.map(n=>n.id)]);
 await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[identity.spaceId,[...connections,...before.sources.map(s=>s.id),...before.notes.map(n=>n.id)]]);
 if(sessionId){await db.query('SELECT id FROM sessions WHERE id=$1 AND space_id=$2 FOR UPDATE',[sessionId,identity.spaceId]);const session=await new PgSessionRepository(db).getSession(identity.spaceId,identity.userId,sessionId);if(!session)throw new HttpError(404,'Session not found');if(session.project_id!==projectId)throw new NotebookSessionProjectError(409,'Session belongs to a different Project');}
 if(canonical(await discoverNotebookChat(db,identity,projectId,sourceIds,pinnedNotes))!==canonical(before))throw new OperationError('operation_conflict',409,false,'projectResearch');
 if(pinnedNotes&&before.notes.length!==new Set(pinnedNotes).size||pinnedNotes&&before.sources.length!==new Set(sourceIds).size)throw new HttpError(404,'Notebook context is no longer readable');
}
export class NotebookSessionProjectError extends HttpError {}
/** Revalidates the frozen context inside canonical provider attempt admission and again at publication. */
export async function authorizeNotebookChatAttempt(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,projectId:string,contract:Record<string,unknown>){
 const sourceIds=strings(contract.source_item_ids),notes=Array.isArray(contract.note_refs)?contract.note_refs.flatMap(r=>r&&typeof r==='object'&&typeof r.id==='string'?[r.id]:[]):[];
 const before=await discoverNotebookChat(db,identity,projectId,sourceIds,notes);
 await authorizeNotebookChat(db,identity,projectId,sourceIds,before,typeof contract.session_id==='string'?contract.session_id:null,notes);
 await assertResearchProviderSourceEgress(db,config,identity,{providerId:String(contract.provider_id),modelName:typeof contract.model_name==='string'?contract.model_name:null},sourceIds,notes);
}
