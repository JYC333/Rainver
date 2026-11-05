import { configureProjectBoard } from "./boardConfiguration.js";
import { readTaskHistory } from "./taskHistory.js";
import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import {
  dbPool, HttpError, jsonBody, params, query, optionalString, requiredString, resolveIdentity, sendRouteError,
  withDbTransaction, type Queryable,
} from "../routeUtils/common.js";
import { resolveUserActorId } from "../../db/actorResolver.js";
import { getProjectBoard, getTaskWorkView } from "./boardReadModel.js";
import { getProjectUpdates } from "./updatesReadModel.js";
import { undoProjectUpdate } from "./updateUndo.js";
import { appendProjectWorkEvent } from "./eventWriter.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access.js";

/**
 * Project read models and recorded updates.
 *
 * The Task routes live here rather than in `tasks` because what they return is
 * Project advancement — Board status, work events, why a Task cannot close — and
 * `tasks` owns the work item, not the advancement around it.
 */
export function registerRoutes(app: FastifyInstance, context: { config: ServerConfig }): void {
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

  app.put("/api/v1/projects/:projectId/board/columns", async (request, reply) => {
    const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
    try {
      const projectId=requiredString(params(request).projectId,"project_id");
      await configureProjectBoard(pool(),identity,projectId,jsonBody(request));
      return reply.send(await getProjectBoard(pool(),identity,projectId));
    } catch(error){return sendRouteError(reply,error);}
  });

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

  app.post("/api/v1/projects/:projectId/updates/:eventId/undo", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const eventId = requiredString(params(request).eventId, "event_id");
      // Writer authority: undoing changes the Project, and the domain command
      // it dispatches to re-checks that under its own lock.
      return reply.send(await undoProjectUpdate(pool(), identity, projectId, eventId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/updates", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectId = requiredString(params(request).projectId, "project_id");
      const parsed = protocol.ProjectUpdateRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) throw new HttpError(422, parsed.error.message);
      // A person's own account of where the Project stands. There is no Agent
      // writer for `project.reported`. This route is the only producer, and
      // Updates is a filter over the same stream rather than a second place
      // the story could be told.
      //
      // Writer authority, not read: this appends to the record the Project is
      // judged by. A `viewer` who can read the Project can read the Updates,
      // and that is a different permission from writing one.
      const event = await withDbTransaction(pool(), async (client: Queryable) => {
        await lockActiveProjectForMutation(client, identity.spaceId, projectId);
        await assertProjectWriterForMutation(client, identity.spaceId, projectId, identity.userId);
        const actorId = await resolveUserActorId(client, identity.spaceId, identity.userId);
        return appendProjectWorkEvent(client, {
          spaceId: identity.spaceId,
          projectId,
          eventKind: "project.reported",
          subjectType: "project",
          subjectId: projectId,
          actorId,
          data: { summary: parsed.data.summary, via: "user" },
        });
      });
      return reply.code(201).send({ id: event.id });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}
