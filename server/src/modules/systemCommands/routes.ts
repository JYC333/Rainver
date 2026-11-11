import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {withQueryableTransaction,dbPool,params,resolveIdentity,sendRouteError} from '../routeUtils/common.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {assertCurrentActor,sessionActor} from '../systemActions/operations/actor.js';
import {SystemCommandNotVisible,loadSystemCommand,settleStaleSystemCommand,systemCommandStatusView} from './intents.js';
import {systemCommandHandler} from './handlers.js';

/**
 * `GET /api/v1/system/commands/:commandId` — the only release of a system
 * command's outcome: the issuing person, in the same Space, while they still
 * hold the authority it was admitted under (its kind's own check). A command
 * whose Job can no longer run settles here as it would anywhere.
 */
export function registerRoutes(app:FastifyInstance,context:ModuleContext):void{
  app.get('/api/v1/system/commands/:commandId',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{
      const view=await withQueryableTransaction(dbPool(context.config),async db=>{
        let intent=await loadSystemCommand(db,params(request).commandId??'',true);
        if(!intent||intent.space_id!==identity.spaceId||intent.user_id!==identity.userId)throw new SystemCommandNotVisible();
        // Share-locked like the worker's checks: a release is ordered against a concurrent revocation.
        await assertCurrentActor(db,sessionActor({spaceId:identity.spaceId,userId:identity.userId}),true);
        await systemCommandHandler(intent.kind).authorize(db,context.config,intent);
        intent=await settleStaleSystemCommand(db,intent);
        return systemCommandStatusView(intent);
      });
      return reply.send(view);
    }catch(error){
      if(error instanceof SystemCommandNotVisible||[403,404].includes((error as {statusCode?:number})?.statusCode??0))return reply.code(404).send(new OperationError('operation_not_found',404).body(resolveRequestId(request)));
      return sendRouteError(reply,error);
    }
  });
}
