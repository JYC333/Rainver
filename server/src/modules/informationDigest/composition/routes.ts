import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,resolveIdentity,params,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {canWriteProject} from '../../projects/access.js';
import {ProjectReadingResponseSchema} from '@rainver/protocol';
import {readProjectComposition,queueProjectComposition} from './service.js';
export function registerCompositionRoutes(app:FastifyInstance,context:ModuleContext){
 const base='/api/v1/spaces/:spaceId/projects/:projectId/reading-compositions';
 for(const suffix of ['', '/:compositionId/export'])app.get(base+suffix,async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const p=params(req);if(p.spaceId!==identity.spaceId)throw new HttpError(404,'Project Reading not found');return reply.send(ProjectReadingResponseSchema.parse(await readProjectComposition(dbPool(context.config),identity,String(p.projectId),suffix?String(p.compositionId):undefined)));}catch(e){return sendRouteError(reply,e);}
 });
 app.post(base+'/retry',async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const p=params(req),db=dbPool(context.config);if(p.spaceId!==identity.spaceId||!await canWriteProject(db,identity.spaceId,String(p.projectId),identity.userId))throw new HttpError(404,'Project Reading not found');
   const rounds=(await db.query<{id:string}>('SELECT DISTINCT ON (goal_id) id FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 ORDER BY goal_id,sequence DESC LIMIT 100',[identity.spaceId,p.projectId])).rows;
   for(const r of rounds)await queueProjectComposition(db,identity.spaceId,String(p.projectId),r.id);
   return reply.send({status:'queued'});
  }catch(e){return sendRouteError(reply,e);}
 });
}
