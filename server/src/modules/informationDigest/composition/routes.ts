import {projectReadingDay} from './day.js';
import {z} from 'zod';
import {readArchivedTheme} from './analysis.js';
import {readReadingHistory} from './history.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,resolveIdentity,params,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {canWriteProject} from '../../projects/access.js';
import {BriefingSchema,ProjectReadingResponseSchema,ProjectReadingHistoryQuerySchema,ProjectReadingHistorySchema} from '@rainver/protocol';
import {readProjectComposition,queueProjectComposition} from './service.js';
export function registerCompositionRoutes(app:FastifyInstance,context:ModuleContext){
 const base='/api/v1/spaces/:spaceId/projects/:projectId/reading-compositions';
 app.get(base+'/analyses/:briefingId',async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const p=params(req);if(p.spaceId!==identity.spaceId)throw new HttpError(404,'Analysis not found');return reply.send(BriefingSchema.parse(await readArchivedTheme(dbPool(context.config),identity,String(p.projectId),String(p.briefingId))));}catch(e){return sendRouteError(reply,e);}
 });
 app.get(base+'/history',async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const p=params(req);if(p.spaceId!==identity.spaceId)throw new HttpError(404,'Project Reading not found');const query=ProjectReadingHistoryQuerySchema.parse(req.query);return reply.send(ProjectReadingHistorySchema.parse(await readReadingHistory(dbPool(context.config),identity,String(p.projectId),query)));}catch(e){return sendRouteError(reply,e);}
 });
 for(const suffix of ['', '/:compositionId/export'])app.get(base+suffix,async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const p=params(req);if(p.spaceId!==identity.spaceId)throw new HttpError(404,'Project Reading not found');const query=z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict().parse(req.query);return reply.send(ProjectReadingResponseSchema.parse(await readProjectComposition(dbPool(context.config),identity,String(p.projectId),suffix?String(p.compositionId):undefined,query.date)));}catch(e){return sendRouteError(reply,e);}
 });
 app.post(base+'/retry',async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const p=params(req),db=dbPool(context.config);if(p.spaceId!==identity.spaceId||!await canWriteProject(db,identity.spaceId,String(p.projectId),identity.userId))throw new HttpError(404,'Project Reading not found');
   const state=await readProjectComposition(db,identity,String(p.projectId));
   if(state.composition_status==='queued'||state.composition_status==='running')return reply.send({status:'queued'});
   if(state.composition_status!=='failed')throw new HttpError(409,'Composition retry is only available for a failed composition. Resolve analysis in its Topic first.',{code:'composition_not_failed'});
   const day=await projectReadingDay(db,identity.spaceId,String(p.projectId));
   const rounds=(await db.query<{id:string}>("SELECT r.id FROM project_reading_rounds r JOIN information_briefings b ON b.id=r.briefing_id AND b.space_id=r.space_id WHERE r.space_id=$1 AND r.project_id=$2 AND r.execution_json->'edition'->>'date'=$3 AND r.status='complete' AND b.status='ready' AND b.result_json ? 'topic' ORDER BY r.sequence,r.id LIMIT 100",[identity.spaceId,p.projectId,day.date])).rows;
   for(const r of rounds)await queueProjectComposition(db,identity.spaceId,String(p.projectId),r.id);
   if(!rounds.length)throw new HttpError(409,'No analysis round is available for publication');
   return reply.send({status:'queued'});
  }catch(e){return sendRouteError(reply,e);}
 });
}
