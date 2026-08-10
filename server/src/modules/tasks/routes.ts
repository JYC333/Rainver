import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  boolQuery,
  dbPool,
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common";
import { PgTaskRepository } from "./repository";
import { PgPlanRepository } from "../plans/repository.js";
import {
  applyContentCreationContext,
  resolveContentCreationContext,
} from "../access/creationContext";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  const repository = () => new PgTaskRepository(dbPool(context.config));

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
      const body = jsonBody(request);
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

  app.patch("/api/v1/tasks/:taskId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository().updateTask(identity, params(request).taskId ?? "", jsonBody(request)));
    } catch (error) {
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
      const plan = await new PgPlanRepository(dbPool(context.config)).getPlanForTask(identity, params(request).taskId ?? "");
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
