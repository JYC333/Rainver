import {resolveUserActorId} from '../../db/actorResolver.js';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {appendProjectWorkEvent} from './eventWriter.js';
/** The person's account joins the canonical append-only work stream. */
export async function reportProjectUpdate(db:Queryable,identity:SpaceUserIdentity,projectId:string,summary:string){
 await lockActiveProjectForMutation(db,identity.spaceId,projectId);
 await assertProjectWriterForMutation(db,identity.spaceId,projectId,identity.userId);
 const actorId=await resolveUserActorId(db,identity.spaceId,identity.userId);
 return appendProjectWorkEvent(db,{spaceId:identity.spaceId,projectId,eventKind:'project.reported',subjectType:'project',subjectId:projectId,actorId,data:{summary,via:'user'}});
}
