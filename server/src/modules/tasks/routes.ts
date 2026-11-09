import {OperationError} from '../systemActions/operations/errors.js';
import {resolveRequestId} from '../../gateway/requestContext.js';
import { InquiryTaskAssociationService } from "../inquiry/taskAssociations.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  boolQuery,
  dbPool,
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  requiredString,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import {introspectIdentity} from '../auth/identity.js';
import {sessionActor} from '../systemActions/operations/actor.js';
import {operationRuntime} from '../systemActions/operations/runtime.js';
import { PgTaskRepository, ProjectTaskPlacementRequiresCore, TaskStatusRequiresCore } from "./repository.js";
import { PgPlanRepository } from "../plans/repository.js";
import {
  applyContentCreationContext,
  resolveContentCreationContext,
} from "../access/creationContext.js";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgTaskRepository(dbPool(context.config));

  app.get("/api/v1/tasks/:taskId/inquiry-threads",async(request,reply)=>{
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try{return reply.send(await new InquiryTaskAssociationService(dbPool(context.config)).threads(identity,requiredString(params(request).taskId,"task_id"),optionalString(query(request).after_thread_id)??undefined));}catch(error){return sendRouteError(reply,error);}
  });
  app.get("/api/v1/boards", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listBoards(identity, {
        projectFolderId: optionalString(q.project_folder_id),
        projectId: optionalString(q.project_id),
        status: optionalString(q.status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/boards", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(201).send(await repository().createBoard(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/boards/:boardId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const board = await repository().getBoard(identity, params(request).boardId ?? "");
      if (!board) return reply.code(404).send({ detail: "Board not found" });
      return reply.send(board);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/boards/:boardId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().updateBoard(identity, params(request).boardId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/boards/:boardId/tasks", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await repository().listBoardTasks(identity, params(request).boardId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/tasks", taskListHandler(context, repository));
  app.get("/api/v1/tasks/", taskListHandler(context, repository));

  app.post("/api/v1/tasks", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      // Run provenance is server-owned (Agent executors pass the trusted Run).
      // A request body naming a Run would attribute this Task, its link events
      // and that Run's creation ceiling to work the caller did not do.
      const { source_run_id: _untrustedRun, ...body } = jsonBody(request);
      const creation = await resolveContentCreationContext(dbPool(context.config), {
        userId: identity.userId,
        requestSpaceId: identity.spaceId,
        projectId: optionalString(body.project_id),
      });
      return reply.code(201).send(await repository().createTask(
        { spaceId: creation.spaceId, userId: identity.userId },
        applyContentCreationContext(body, creation),
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });


  app.get("/api/v1/me/tasks", myTasksHandler(context, repository));
  app.get("/api/v1/me/tasks/", myTasksHandler(context, repository));

  app.get("/api/v1/tasks/:taskId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const task = await repository().getTask(identity, params(request).taskId ?? "");
      if (!task) return reply.code(404).send({ detail: "Task not found" });
      return reply.send(task);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  for(const [method,url,id] of [
    ['DELETE','/api/v1/tasks/:taskId','task.delete'],
    ['POST','/api/v1/tasks/:taskId/status','task.set_status'],
    ['POST','/api/v1/tasks/:taskId/space-board-placement','task.place_in_space_board'],
  ] as const) app.route({method,url,config:{operation:id},handler:async(request,reply)=>{
    const requestId=resolveRequestId(request);
    reply.header('cache-control','private, no-store');
    const resolved=await introspectIdentity(context.config,request,reply);
    if(!resolved.ok){
      const error=resolved.reason==='denied'
        ?new OperationError(resolved.statusCode===401?'authentication_required':'operation_not_found',resolved.statusCode===401?401:404)
        :new OperationError('operation_temporarily_unavailable',503,true);
      return reply.code(error.httpStatus).send(error.body(requestId));
    }
    let body:Record<string,unknown>;
    try{body=request.body===undefined?{}:jsonBody(request);}
    catch{return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));}
    if(Object.hasOwn(body,'task_id'))return reply.code(422).send(new OperationError('operation_invalid_input',422).body(requestId));
    const key=request.headers['idempotency-key'];
    const result=await(await operationRuntime(context.config)).execute(id,{...body,task_id:params(request).taskId},
      sessionActor({spaceId:resolved.spaceId,userId:resolved.userId}),requestId,typeof key==='string'?key:undefined);
    return reply.code(result.http_status).send(result.body);
  }});

  app.patch("/api/v1/tasks/:taskId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      // The body is free-form for the many optional columns, but the two
      // structured fields reach code that indexes into them: an unshaped
      // `links[]` entry would arrive at the entity registry as `undefined`.
      const body = jsonBody(request);
      const structured = protocol.TaskPatchStructuredFieldsSchema.safeParse(body);
      if (!structured.success) throw new HttpError(422, structured.error.message);
      return reply.send(await repository().updateTaskFromPublicPatch(identity, params(request).taskId ?? "", body));
    } catch (error) {
      if(error instanceof ProjectTaskPlacementRequiresCore || error instanceof TaskStatusRequiresCore)
        return reply.code(422).send(new OperationError('operation_invalid_input',422).body(resolveRequestId(request)));
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/tasks/:taskId/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await repository().listTaskRuns(identity, params(request).taskId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/tasks/:taskId/plan-requests", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(202).send(await repository().requestPlanningRun(identity, params(request).taskId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/tasks/:taskId/plan", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const plan = await new PgPlanRepository(dbPool(context.config), context.config).getPlanForTask(identity, params(request).taskId ?? "");
      return reply.send(plan);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/tasks/:taskId/runs", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository().createTaskRun(identity, params(request).taskId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/tasks/:taskId/artifacts", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await repository().listTaskArtifacts(identity, params(request).taskId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/tasks/:taskId/proposals", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await repository().listTaskProposals(identity, params(request).taskId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/tasks/:taskId/evaluations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request));
      return reply.send(await repository().listTaskEvaluations(identity, params(request).taskId ?? "", limit, offset));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/tasks/:taskId/evaluations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository().createTaskEvaluation(identity, params(request).taskId ?? "", jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function taskListHandler(context: ModuleContext, repository: () => PgTaskRepository) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listTasks(identity, {
        boardId: optionalString(q.board_id),
        projectFolderId: optionalString(q.project_folder_id),
        projectId: optionalString(q.project_id),
        status: optionalString(q.status),
        assignedToMe: boolQuery(q.assigned_to_me, false),
        q: optionalString(q.q),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  };
}

function myTasksHandler(context: ModuleContext, repository: () => PgTaskRepository) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const { limit, offset } = parsePage(q);
      return reply.send(await repository().listMyTasks(identity, {
        status: optionalString(q.status),
        limit,
        offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  };
}
