import type { FastifyInstance } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import {
  dbPool, HttpError, jsonBody, params, query, requiredString, resolveIdentity, sendRouteError,
  withDbTransaction, type Queryable,
} from "../routeUtils/common.js";
import { resolveUserActorId } from "../../db/actorResolver.js";
import { getProjectBoard, getTaskWorkView } from "./boardReadModel.js";
import { getProjectUpdates } from "./updatesReadModel.js";
import { undoProjectUpdate } from "./updateUndo.js";
import { appendProjectWorkEvent } from "./eventWriter.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access.js";
import { recordStageChange } from "./loopState.js";

/**
 * Read models and the person-facing stage control.
 *
 * The Task routes live here rather than in `tasks` because what they return is
 * Project advancement — Loop stage, work events, why a Task cannot close — and
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
      // A person's own account of where the Project stands. `project.reported`
      // has no Agent writer yet — the Steward that would post one is later —
      // so this is the only producer, and Updates is a filter over the same
      // stream rather than a second place the story could be told.
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

  app.post("/api/v1/tasks/:taskId/stage", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const taskId = requiredString(params(request).taskId, "task_id");
      const parsed = protocol.TaskStageChangeRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) throw new HttpError(422, parsed.error.message);
      const view = await withDbTransaction(pool(), async (client: Queryable) => {
        // Readability is rechecked here rather than trusted from the read
        // model: this is a write, and the view was fetched under a different
        // transaction.
        const current = await getTaskWorkView(client, identity, taskId);
        if (!current.task.project_id) {
          throw new HttpError(422, "A Task outside a Project has no Loop to advance");
        }
        // Reading the Task is not licence to move its Loop; a Project viewer
        // can read every shared Task.
        await assertProjectWriterForMutation(client, identity.spaceId, current.task.project_id, identity.userId);
        const actorId = await resolveUserActorId(client, identity.spaceId, identity.userId);
        await recordStageChange(client, {
          spaceId: identity.spaceId,
          projectId: current.task.project_id,
          taskId,
          toStage: parsed.data.to_stage,
          actorId,
          reason: parsed.data.reason,
          data: { via: "user" },
        });
        return getTaskWorkView(client, identity, taskId);
      });
      return reply.send(view);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

}
