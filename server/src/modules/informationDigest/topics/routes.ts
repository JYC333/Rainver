import {assertGoalAnalysisManagement} from '../../sources/index.js';
import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../../gateway/routeRegistry.js';
import {dbPool,resolveIdentity,params,jsonBody,sendRouteError,HttpError} from '../../routeUtils/common.js';
import {configureThemeAnalysis,readThemeRounds,settleThemeRound,cancelThemeRound} from './service.js';
import {ProjectThemeRetrySchema,ProjectThemeRoundsResponseSchema} from '@rainver/protocol';
export function registerThemeRoutes(app:FastifyInstance,context:ModuleContext){
 const db=()=>dbPool(context.config);
 app.post('/api/v1/sources/goals/:goalId/theme-analysis',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(await configureThemeAnalysis(db(),context.config,identity,String(params(req).goalId),jsonBody(req)));}catch(e){return sendRouteError(reply,e);}});
 app.get('/api/v1/sources/goals/:goalId/theme-rounds',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(ProjectThemeRoundsResponseSchema.parse(await readThemeRounds(db(),identity,String(params(req).goalId))));}catch(e){return sendRouteError(reply,e);}});
 app.get('/api/v1/sources/goals/:goalId/theme-rounds/:roundId/export',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{const result=ProjectThemeRoundsResponseSchema.parse(await readThemeRounds(db(),identity,String(params(req).goalId)));const round=result.rounds.find(r=>r.id===String(params(req).roundId));if(!round)throw new HttpError(404,'Theme round not found');reply.header('content-type','application/json');return reply.send(round);}catch(e){return sendRouteError(reply,e);}});
 app.post('/api/v1/sources/goals/:goalId/theme-rounds/:roundId/cancel',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{return reply.send(ProjectThemeRoundsResponseSchema.parse(await cancelThemeRound(db(),context.config,identity,String(params(req).goalId),String(params(req).roundId))));}catch(e){return sendRouteError(reply,e);}});
 app.post('/api/v1/sources/goals/:goalId/theme-rounds/retry',async(req,reply)=>{const identity=await resolveIdentity(context.config,req,reply);if(!identity)return reply;try{
  const input=ProjectThemeRetrySchema.parse(jsonBody(req)),goalId=String(params(req).goalId);await readThemeRounds(db(),identity,goalId);await assertGoalAnalysisManagement(db(),context.config,identity,goalId);
  const row=(await db().query('SELECT r.id FROM project_reading_rounds r JOIN source_goals g ON g.id=r.goal_id AND g.space_id=r.space_id WHERE r.space_id=$1 AND r.goal_id=$2 AND r.id=$3 AND g.owner_user_id=$4',[identity.spaceId,goalId,input.round_id,identity.userId])).rows[0];if(!row)throw new HttpError(404,'Theme round not found');
  await settleThemeRound(db(),context.config,row.id,true);return reply.send(ProjectThemeRoundsResponseSchema.parse(await readThemeRounds(db(),identity,goalId)));
 }catch(e){return sendRouteError(reply,e);}});
}
