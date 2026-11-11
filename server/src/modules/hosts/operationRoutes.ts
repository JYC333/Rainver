import type {FastifyInstance} from 'fastify';
import {repositoryAcpAdapter} from '@rainver/protocol';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {getDbPool} from '../../db/pool.js';
import {withQueryableTransaction,dbPool,params,resolveIdentity,sendRouteError,type Queryable} from '../routeUtils/common.js';
import {registerOperationAdapters,type OperationAdapterRoute} from '../systemActions/operations/routeAdapter.js';
import {OperationError} from '../systemActions/operations/errors.js';
import {assertCurrentActor,sessionActor} from '../systemActions/operations/actor.js';
import {AcpAgentService} from '../acpAgents/index.js';
import {HostNotVisible,assertHostCommandReadable,hostCommandStatusView,loadHostCommand,settleStaleHostCommand} from './hostCommands.js';

const HOST=':hostId',RUNTIME='/api/v1/hosts/:hostId/installations/:runtimeKey';
const host={hostId:'host_id'},runtime={hostId:'host_id',runtimeKey:'runtime_key'},tool={hostId:'host_id',toolId:'tool_id'};

/** The Host block's retained URLs, each bound to one core operation (`hosts/operations.ts`). */
export const HOST_OPERATION_ROUTES:readonly OperationAdapterRoute[]=[
  {method:'POST',url:`/api/v1/hosts/${HOST}/workspaces`,operation:'host.workspace.register',params:host},
  {method:'POST',url:RUNTIME,operation:'host.runtime.install',params:runtime},
  {method:'DELETE',url:`${RUNTIME}/:installation`,operation:'host.runtime.uninstall',params:{...runtime,installation:'installation'}},
  {method:'POST',url:`${RUNTIME}/own/update`,operation:'host.runtime.own_update',params:runtime},
  {method:'POST',url:`${RUNTIME}/managed/update`,operation:'host.runtime.managed_update',params:runtime},
  {method:'POST',url:`${RUNTIME}/rollback`,operation:'host.runtime.rollback',params:runtime},
  {method:'POST',url:`${RUNTIME}/:installation/usage`,operation:'host.runtime.usage.refresh',params:{...runtime,installation:'installation'}},
  {method:'POST',url:`/api/v1/hosts/${HOST}/runtime-provisioning/opencode/retry`,operation:'host.runtime.provisioning.retry',params:host},
  {method:'PUT',url:`/api/v1/hosts/${HOST}/provider-proxy-url`,operation:'host.provider_proxy.set',params:host},
  {method:'POST',url:`/api/v1/hosts/${HOST}/revoke`,operation:'host.revoke',params:host},
  {method:'POST',url:`/api/v1/hosts/${HOST}/ordinary-tools/:toolId/install`,operation:'host.ordinary_tool.install',params:tool},
  {method:'POST',url:`/api/v1/hosts/${HOST}/ordinary-tools/:toolId/register`,operation:'host.ordinary_tool.register',params:tool},
  {method:'DELETE',url:`/api/v1/hosts/${HOST}/ordinary-tools/:toolId`,operation:'host.ordinary_tool.remove',params:tool,query:{source:'source'}},
  {method:'POST',url:`/api/v1/hosts/${HOST}/ordinary-tools/:toolId/account/logout`,operation:'host.ordinary_tool.account.logout',params:tool},
  {method:'POST',url:'/api/v1/agents/:agentId/host-state/reset',operation:'agent.host_state.reset',params:{agentId:'agent_id'}},
];

/**
 * Release metadata for a registry adapter is refreshed before the install is
 * admitted, never inside its transaction; only for a Host the caller could
 * manage, so nobody else spends that fetch. The operation rechecks everything.
 */
async function refreshInstallableRelease(context:ModuleContext,identity:{userId:string},input:Record<string,unknown>):Promise<void>{
  const runtimeKey=String(input.runtime_key??'');
  if(!context.config.databaseUrl||repositoryAcpAdapter(runtimeKey))return;
  const pool=getDbPool(context.config.databaseUrl);
  const visible=(await pool.query(`SELECT 1 FROM hosts WHERE id=$1 AND status<>'revoked' AND (kind='server' OR owner_user_id=$2)`,[input.host_id,identity.userId])).rows[0];
  if(visible)await new AcpAgentService(pool).refreshRegistryCache();
}

/** Durable commands in flight, as the Host card's operation list reads them (`tool-operations`). */
const KIND_ACTION:Record<string,string>={runtime_install:'install_tool',runtime_uninstall:'uninstall_tool',runtime_own_update:'update_own_tool',runtime_managed_update:'managed_cli',runtime_rollback:'rollback_tool'};
export async function activeRuntimeCommands(db:Queryable,hostId:string):Promise<Array<{runtime_key:string;action:string}>>{
  const rows=(await db.query<{kind:string;runtime_key:string}>(
    `SELECT kind,frozen_json->>'runtime_key' AS runtime_key FROM host_command_intents WHERE host_id=$1 AND status IN ('pending','dispatched') AND kind LIKE 'runtime_%' AND kind<>'runtime_usage_refresh'`,[hostId])).rows;
  return rows.map(row=>({runtime_key:row.runtime_key,action:KIND_ACTION[row.kind]!}));
}
export async function activeOrdinaryToolCommands(db:Queryable,hostId:string):Promise<Array<{tool_id:string;action:string}>>{
  return (await db.query<{tool_id:string;action:string}>(
    `SELECT frozen_json->'operation'->>'tool_id' AS tool_id,frozen_json->'operation'->>'action' AS action FROM host_command_intents
      WHERE host_id=$1 AND status IN ('pending','dispatched') AND kind LIKE 'ordinary_tool_%'`,[hostId])).rows;
}

export function registerHostOperationRoutes(app:FastifyInstance,context:ModuleContext):void{
  registerOperationAdapters(app,context.config,HOST_OPERATION_ROUTES.map(route=>route.operation==='host.runtime.install'
    ?{...route,prepare:(identity,input)=>refreshInstallableRelease(context,identity,input)}:route));

  /**
   * The only release of a Host command's outcome: the issuing person, in the
   * same Space, while they still hold the authority it was admitted under. A
   * command whose Job can no longer run settles here as it would anywhere.
   */
  app.get('/api/v1/hosts/:hostId/commands/:commandId',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{
      const p=params(request);
      const view=await withQueryableTransaction(dbPool(context.config),async db=>{
        let intent=await loadHostCommand(db,p.commandId??'',true);
        if(!intent||intent.host_id!==p.hostId)throw new HostNotVisible();
        // The reader is still an active member and user, as a new command's actor would have to be.
        await assertCurrentActor(db,sessionActor({spaceId:identity.spaceId,userId:identity.userId}));
        await assertHostCommandReadable(db,context.config,intent,identity.spaceId,identity.userId);
        intent=await settleStaleHostCommand(db,intent);
        return hostCommandStatusView(intent);
      });
      return reply.send(view);
    }catch(error){
      if(error instanceof HostNotVisible||(error as {statusCode?:number})?.statusCode===404)return reply.code(404).send(new OperationError('operation_not_found',404).body(resolveRequestId(request)));
      return sendRouteError(reply,error);
    }
  });
}
