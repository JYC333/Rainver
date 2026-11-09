import {registerProjectManagementOperationRoutes} from '../projects/managementOperationRoutes.js';
import { introspectIdentity } from '../auth/identity.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
import {OperationError} from '../systemActions/operations/errors.js';
import { readTaskHistory } from "./taskHistory.js";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../config.js";
import {
  dbPool, jsonBody, params, query, optionalString, requiredString, resolveIdentity, sendRouteError,
} from "../routeUtils/common.js";
import { getProjectBoard, getTaskWorkView } from "./boardReadModel.js";
import { getProjectUpdates } from "./updatesReadModel.js";

/**
 * Project read models and recorded updates.
 *
 * The Task routes live here rather than in `tasks` because what they return is
 * Project advancement — Board status, work events, why a Task cannot close — and
 * `tasks` owns the work item, not the advancement around it.
 */
export function registerRoutes(app: FastifyInstance, context: { config: ServerConfig }): void {
  registerProjectManagementOperationRoutes(app,context,'projectWork');
  const pool = () => dbPool(context.config);

  app.get("/api/v1/projects/:projectId/board", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      return reply.send(await getProjectBoard(pool(), identity, projectId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  for(const [method,url,id] of [
    ['PUT','/api/v1/projects/:projectId/board/columns','board.configure'],
    ['POST','/api/v1/tasks/:taskId/move-to-column','task.move_to_column'],
  ] as const) app.route({method,url,config:{operation:id},handler:async(request,reply)=>{
    const requestId=resolveRequestId(request),resolved=await introspectIdentity(context.config,request,reply);
    if(!resolved.ok){const e=resolved.reason==='denied'?new OperationError(resolved.statusCode===401?'authentication_required':'operation_not_found',resolved.statusCode===401?401:404):new OperationError('operation_temporarily_unavailable',503,true);return reply.code(e.httpStatus).send(e.body(requestId));}
    let body:Record<string,unknown>;
    try{body=jsonBody(request);}catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    if(id==='board.configure'&&Object.hasOwn(body,'project_id')||id==='task.move_to_column'&&Object.hasOwn(body,'task_id'))return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));
    const input=id==='board.configure'?{...body,project_id:params(request).projectId}:{...body,task_id:params(request).taskId};
    const key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(context.config)).execute(id,input,sessionActor({spaceId:resolved.spaceId,userId:resolved.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  }});

  app.get("/api/v1/tasks/:taskId/work-history",async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{return reply.send(await readTaskHistory(pool(),identity,requiredString(params(request).taskId,"task_id"),optionalString(query(request).before_seq)??undefined));}catch(error){return sendRouteError(reply,error);}
  });
  app.get("/api/v1/tasks/:taskId/work", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const taskId = requiredString(params(request).taskId, "task_id");
      return reply.send(await getTaskWorkView(pool(), identity, taskId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/updates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const cursor = query(request).cursor;
      const limit = Number(query(request).limit);
      return reply.send(await getProjectUpdates(
        pool(),
        identity,
        projectId,
        typeof cursor === "string" && cursor ? cursor : null,
        Number.isFinite(limit) && limit > 0 ? limit : undefined,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });





}
