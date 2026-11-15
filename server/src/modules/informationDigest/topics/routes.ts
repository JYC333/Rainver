import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,resolveIdentity,params,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {registerOperationAdapters} from '../../systemActions/operations/routeAdapter.js';
import {readThemeRounds} from './service.js';
import {ProjectThemeRoundsResponseSchema} from '@rainver/protocol';
export function registerThemeRoutes(app:FastifyInstance,context:ModuleContext){
 const db=()=>dbPool(context.config);
 app.get('/api/v1/sources/goals/:goalId/theme-rounds',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(ProjectThemeRoundsResponseSchema.parse(await readThemeRounds(db(),identity,String(params(req).goalId))));}catch(e){return sendRouteError(reply,e);}});
 app.get('/api/v1/sources/goals/:goalId/theme-rounds/:roundId/export',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{const result=ProjectThemeRoundsResponseSchema.parse(await readThemeRounds(db(),identity,String(params(req).goalId)));const round=result.rounds.find(r=>r.id===String(params(req).roundId));if(!round)throw new HttpError(404,'Theme round not found');reply.header('content-type','application/json');return reply.send(round);}catch(e){return sendRouteError(reply,e);}});
 // Retained command URLs: formal adapters onto the core Goal theme operations (sources/goals/operations.ts).
 registerOperationAdapters(app,context.config,[
  {method:'POST',url:'/api/v1/sources/goals/:goalId/theme-analysis',operation:'source.goal.theme.configure',params:{goalId:'goal_id'}},
  {method:'POST',url:'/api/v1/sources/goals/:goalId/theme-rounds/retry',operation:'source.goal.theme.retry',params:{goalId:'goal_id'}},
  {method:'POST',url:'/api/v1/sources/goals/:goalId/theme-rounds/:roundId/cancel',operation:'source.goal.theme.cancel',params:{goalId:'goal_id',roundId:'round_id'}},
 ]);
}
