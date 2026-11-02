import {RuntimeSessionConfigSelectionSchema} from '@rainver/protocol';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,jsonBody,params,resolveIdentity,sendRouteError} from '../../routeUtils/common.js';
import {enforceSources} from '../enforceSources.js';
import {MaterialItemProcessingService} from './items.js';
import {proposeMaterialStorage} from './consent.js';
import {showAgentTextAsMarkdown} from './syntax.js';
const request=z.object({investigation:z.boolean().optional(),agent_id:z.string().min(1).optional(),runtime_profile_id:z.string().min(1).optional(),session_config:z.array(RuntimeSessionConfigSelectionSchema).max(32).optional()}).strict().refine(v=>!!v.agent_id===!!v.runtime_profile_id,{message:'Select Agent and runtime profile together'});
export function registerMaterialProcessingRoutes(app:FastifyInstance,context:ModuleContext){
 for(const operation of ['read','start','cancel','request_storage'] as const){
  app.route({method:operation==='read'?'GET':'POST',url:`/api/v1/sources/items/:itemId/processing${operation==='read'?'':'/'+operation}`,handler:async(req,reply)=>{
   const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
   try{const id=params(req).itemId??'';if(operation!=='read'){const gate=await enforceSources(context,identity,'source.item_update','source_item',id);if(gate.blocked)return reply.code(403).send(gate.reply403);}
    const db=dbPool(context.config),service=new MaterialItemProcessingService(db,context.config);
    return reply.send(operation==='read'?await service.read(identity,id):operation==='start'?await service.start(identity,id,request.parse(jsonBody(req))):operation==='cancel'?await service.cancel(identity,id):await proposeMaterialStorage(db,identity,id));
   }catch(error){return sendRouteError(reply,error);}
  }});
 }
 // Explicit, single material and version: show literal Agent text as Markdown (see syntax.ts).
 app.post('/api/v1/sources/items/:itemId/reading-syntax',async(req,reply)=>{
  const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;
  try{const id=params(req).itemId??'';const body=z.object({syntax:z.literal('markdown'),artifact_id:z.string().min(1).max(64),source_snapshot_id:z.string().min(1).max(64).nullable()}).strict().parse(jsonBody(req));
   const gate=await enforceSources(context,identity,'source.item_update','source_item',id);if(gate.blocked)return reply.code(403).send(gate.reply403);
   return reply.send(await showAgentTextAsMarkdown(dbPool(context.config),context.config,identity,id,{artifact_id:body.artifact_id,source_snapshot_id:body.source_snapshot_id}));
  }catch(error){return sendRouteError(reply,error);}
 });
}
