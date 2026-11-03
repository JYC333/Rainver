import type {Queryable,SpaceUserIdentity} from '../../routeUtils/common.js';
import {HttpError} from '../../routeUtils/common.js';
import {canReadProject} from '../../projects/access.js';
import {PgBriefingRepository} from '../briefing/repository.js';
import {projectBriefing} from '../briefing/projection.js';
import {goalOfKey,topicScope} from '../topics/scope.js';
/** Published theme history has an exact read even if a composition Job never
 * attached it. Same Project and the original full permission closure apply. */
export async function readArchivedTheme(db:Queryable,identity:SpaceUserIdentity,projectId:string,id:string){
 if(!await canReadProject(db,identity.spaceId,projectId,identity.userId))throw new HttpError(404,'Analysis not found');
 const repository=new PgBriefingRepository(db),row=await repository.get(identity.spaceId,id),goal=row?goalOfKey(row.scope_key):null;
 if(!row||row.project_id!==projectId||!goal)throw new HttpError(404,'Analysis not found');
 return projectBriefing(db,repository,topicScope(identity.spaceId,projectId,goal),row);
}
