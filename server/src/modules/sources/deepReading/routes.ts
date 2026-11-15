import {registerOperationAdapters} from '../../systemActions/operations/routeAdapter.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {ProjectDeepReadListSchema} from '@rainver/protocol';
import {resolveIdentity,params,dbPool,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {favoriteList,readDeepOperations,deepReadingPurposes,favoriteStatus} from './service.js';
export function registerDeepReadingRoutes(app:FastifyInstance,context:ModuleContext){
 registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/spaces/:spaceId/projects/:projectId/reading/items/:itemId/deep-reads',operation:'reading.deep_read.start',spaceParam:'spaceId',params:{projectId:'project_id',itemId:'item_id'}},{method:'POST',url:'/api/v1/spaces/:spaceId/projects/:projectId/reading/deep-reads/:operationId/cancel',operation:'reading.deep_read.cancel',spaceParam:'spaceId',params:{projectId:'project_id',operationId:'operation_id'}},{method:'POST',url:'/api/v1/spaces/:spaceId/projects/:projectId/reading/items/:itemId/favorite',operation:'reading.favorite.set',spaceParam:'spaceId',params:{projectId:'project_id',itemId:'item_id'}}]);
 const base='/api/v1/spaces/:spaceId/projects/:projectId/reading';
 for(const [method,path,operation] of [['GET','/items/:itemId/favorite','favoriteStatus'],['GET','/items/:itemId/purposes','purposes'],['GET','/favorites','favorites'],['GET','/deep-reads','list'],['GET','/deep-reads/:operationId','read']] as const){
  app.route({method,url:base+path,handler:async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{
   const p=params(req);if(p.spaceId!==identity.spaceId)throw new HttpError(404,'Project reading not found');const db=dbPool(context.config),projectId=String(p.projectId),offset=Number((req.query as {offset?:string})?.offset??0);
   if(operation==='favoriteStatus')return reply.send(await favoriteStatus(db,identity,projectId,String(p.itemId)));
   if(operation==='purposes')return reply.send(await deepReadingPurposes(db,identity,projectId,String(p.itemId)));
   if(operation==='favorites')return reply.send(await favoriteList(db,identity,projectId,offset));
   return reply.send(ProjectDeepReadListSchema.parse(await readDeepOperations(db,identity,projectId,operation==='read'?String(p.operationId):undefined,offset)));
  }catch(e){return sendRouteError(reply,e);}}});
 }
}
