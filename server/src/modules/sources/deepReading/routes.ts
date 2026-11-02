import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {ProjectFavoriteRequestSchema,ProjectDeepReadListSchema} from '@rainver/protocol';
import {resolveIdentity,params,jsonBody,dbPool,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {favoriteMaterial,favoriteList,startDeepReading,readDeepOperations,cancelDeepReading,deepReadingPurposes,favoriteStatus} from './service.js';
export function registerDeepReadingRoutes(app:FastifyInstance,context:ModuleContext){
 const base='/api/v1/spaces/:spaceId/projects/:projectId/reading';
 for(const [method,path,operation] of [['GET','/items/:itemId/favorite','favoriteStatus'],['GET','/items/:itemId/purposes','purposes'],['GET','/favorites','favorites'],['POST','/items/:itemId/favorite','favorite'],['POST','/items/:itemId/deep-reads','start'],['GET','/deep-reads','list'],['GET','/deep-reads/:operationId','read'],['POST','/deep-reads/:operationId/cancel','cancel']] as const){
  app.route({method,url:base+path,handler:async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{
   const p=params(req);if(p.spaceId!==identity.spaceId)throw new HttpError(404,'Project reading not found');const db=dbPool(context.config),projectId=String(p.projectId),offset=Number((req.query as {offset?:string})?.offset??0);
   if(operation==='favoriteStatus')return reply.send(await favoriteStatus(db,identity,projectId,String(p.itemId)));
   if(operation==='purposes')return reply.send(await deepReadingPurposes(db,identity,projectId,String(p.itemId)));
   if(operation==='favorite')return reply.send(await favoriteMaterial(db,identity,projectId,String(p.itemId),ProjectFavoriteRequestSchema.parse(jsonBody(req)).favorite));
   if(operation==='favorites')return reply.send(await favoriteList(db,identity,projectId,offset));
   if(operation==='start')return reply.send(await startDeepReading(db,context.config,identity,projectId,String(p.itemId),jsonBody(req)));
   if(operation==='cancel')return reply.send(await cancelDeepReading(db,context.config,identity,projectId,String(p.operationId)));
   return reply.send(ProjectDeepReadListSchema.parse(await readDeepOperations(db,identity,projectId,operation==='read'?String(p.operationId):undefined,offset)));
  }catch(e){return sendRouteError(reply,e);}}});
 }
}
