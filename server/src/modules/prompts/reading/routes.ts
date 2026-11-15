import {MethodTargetSchema} from '@rainver/protocol';
import {readReadingGeneration} from './generation.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,resolveIdentity,sendRouteError,query,params,HttpError} from '../../routeUtils/common.js';
import {readingWorkspace,readReadingSample,readingEntryScope,readingCliOptions} from './workspace.js';
import {readReadingTrial} from './trials.js';
import {registerReadingMethodOperationRoutes} from './operations.js';
export function registerReadingMethodRoutes(app:FastifyInstance,context:ModuleContext){
 const base='/api/v1/prompts/reading-method';const db=()=>dbPool(context.config);
 const register=(path:string,action:(identity:{spaceId:string;userId:string},r:Parameters<typeof query>[0])=>Promise<unknown>)=>app.get(base+path,async(r,reply)=>{const identity=await resolveIdentity(context.config,r,reply);if(!identity)return reply;try{return reply.send(await action(identity,r));}catch(e){return sendRouteError(reply,e);}});
 const target=(v:unknown)=>{const parsed=MethodTargetSchema.safeParse(v??'reading.project_investigation');if(!parsed.success)throw new HttpError(422,'Unknown method target');return parsed.data;};
 const id=(v:unknown)=>{if(typeof v!=='string'||!v)throw new HttpError(422,'item_id is required');return v;};
 const optionalItem=(v:unknown)=>v==null?null:id(v);
 register('',async(i,r)=>readingWorkspace(db(),i,optionalItem(query(r).item_id),typeof query(r).project_id==='string'?String(query(r).project_id):null,false,context.config,typeof query(r).artifact_id==='string'?String(query(r).artifact_id):undefined,target(query(r).target_key)));
 register('/entry',(i,r)=>readingEntryScope(db(),i,typeof query(r).project_id==='string'?String(query(r).project_id):null));
 register('/cli-options',(i,r)=>readingCliOptions(db(),i,typeof query(r).project_id==='string'?String(query(r).project_id):null));
 register('/generations/:id',(i,r)=>readReadingGeneration(db(),i,id(params(r).id)));
 register('/samples/:id',(i,r)=>readReadingSample(db(),i,id(params(r).id)));
 register('/trials/:id',(i,r)=>readReadingTrial(db(),i,id(params(r).id)));
 // Writers are core commands over the same owners.
 registerReadingMethodOperationRoutes(app,context.config);
}
