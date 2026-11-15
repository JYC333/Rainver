import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {stateChangingReadAllowed} from '../../../gateway/csrfOrigin.js';
import {dbPool,params,resolveIdentity,sendRouteError} from '../../routeUtils/common.js';
import {registerOperationAdapters} from '../../systemActions/operations/routeAdapter.js';
import {MaterialItemProcessingService} from './items.js';
export function registerMaterialProcessingRoutes(app:FastifyInstance,context:ModuleContext){
 // Keep the historical cross-site guard; settlement belongs to the Run finalizer, not this read.
 app.get('/api/v1/sources/items/:itemId/processing',async(req,reply)=>{
  if(!stateChangingReadAllowed(req,context.config.frontendUrl))return reply.code(403).send({detail:'Cross-site request refused'});
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{return reply.send(await new MaterialItemProcessingService(dbPool(context.config),context.config).read(identity,params(req).itemId??''));}
  catch(error){return sendRouteError(reply,error);}
 });
 registerOperationAdapters(app,context.config,[
  {method:'POST',url:'/api/v1/sources/items/:itemId/processing/start',operation:'source.material.start',params:{itemId:'source_item_id'}},
  {method:'POST',url:'/api/v1/sources/items/:itemId/processing/cancel',operation:'source.material.cancel',params:{itemId:'source_item_id'}},
  {method:'POST',url:'/api/v1/sources/items/:itemId/processing/request_storage',operation:'source.material.request_storage',params:{itemId:'source_item_id'}},
  // Explicit, single material and version: show literal Agent text as Markdown (see syntax.ts).
  {method:'POST',url:'/api/v1/sources/items/:itemId/reading-syntax',operation:'source.material.show_markdown',params:{itemId:'source_item_id'}},
 ]);
}
