import {registerOperationAdapters} from '../../systemActions/operations/routeAdapter.js';
import {z} from 'zod';
import {readArchivedTheme} from './analysis.js';
import {readReadingHistory} from './history.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,resolveIdentity,params,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {BriefingSchema,ProjectReadingResponseSchema,ProjectReadingHistoryQuerySchema,ProjectReadingHistorySchema} from '@rainver/protocol';
import {readProjectComposition} from './service.js';
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
 registerOperationAdapters(app,context.config,[{method:'POST',url:base+'/retry',operation:'reading.composition.retry',spaceParam:'spaceId',params:{projectId:'project_id'}}]);
}
