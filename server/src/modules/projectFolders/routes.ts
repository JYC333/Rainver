import { registerProjectFolderIoRoutes } from './ioOperationRoutes.js';
import { registerProjectFolderOperationRoutes } from './operationRoutes.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stateChangingReadAllowed } from "../../gateway/csrfOrigin.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  params,
  parsePage,
  query,
  resolveIdentity,
  sendRouteError,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { assertProjectReadable } from "../projects/access.js";
import { PgProjectFolderRepository } from "./repository.js";
import { AgentWorkspaceGroupListQuerySchema, AgentWorkspaceListQuerySchema, WorkspaceChangePageQuerySchema } from "@rainver/protocol";
import { agentWorkspaceDetail, listAgentWorkspaces } from "./workspaceOverview.js";
import { listAgentWorkspaceGroups } from "./workspaceOverviewGroups.js";
import { conversationWorkspaceChangesForViewer } from "./workspaceReadModel.js";

interface ProjectFolderServices {
  repository: Pick<
    PgProjectFolderRepository,
    | "list"
    | "scanCandidates"
    | "get"
    | "update"
    | "archive"
    | "unregister"
    | "activateLocation"
    | "getTree"
    | "getFile"
    | "getGitStatus"
    | "getGitDiff"
  > & Partial<Pick<PgProjectFolderRepository, "listLocations" | "listHostExecutionTargets" | "listFileRevisions" | "getDraft" | "upsertDraft" | "discardDraft" | "draftQuota" | "previewRevision">>;
}

type ProjectFolderServicesFactory = (context: ModuleContext) => ProjectFolderServices;
type ProjectFolderIdentityOverride =
  | SpaceUserIdentity
  | ((request: FastifyRequest) => Promise<SpaceUserIdentity | null> | SpaceUserIdentity | null);

let servicesFactoryOverride: ProjectFolderServicesFactory | null = null;
let identityOverride: ProjectFolderIdentityOverride | null = null;

export function __setProjectFolderServicesFactoryForTests(
  factory: ProjectFolderServicesFactory | null,
): void {
  servicesFactoryOverride = factory;
}

export function __setProjectFolderIdentityForTests(identity: ProjectFolderIdentityOverride | null): void {
  identityOverride = identity;
}

function services(context: ModuleContext): ProjectFolderServices {
  if (servicesFactoryOverride) return servicesFactoryOverride(context);
  return {
    repository: PgProjectFolderRepository.fromConfig(context.config),
  };
}

async function identity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SpaceUserIdentity | null> {
  if (identityOverride) {
    return typeof identityOverride === "function" ? identityOverride(request) : identityOverride;
  }
  return resolveIdentity(context.config, request, reply);
}

function projectId(request: FastifyRequest): string {
  const id = params(request).projectId;
  if (!id) throw new HttpError(422, "projectId is required");
  return id;
}

function folderId(request: FastifyRequest): string {
  const id = params(request).folderId;
  if (!id) throw new HttpError(422, "folderId is required");
  return id;
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerProjectFolderOperationRoutes(app, context);
  registerProjectFolderIoRoutes(app, context);
  // Agent workspace overview: the same read authorities as Run workspace progress.
  app.get("/api/v1/projects/:projectId/agent-workspaces", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const parsed = AgentWorkspaceListQuerySchema.safeParse(query(request));
      if (!parsed.success) return reply.code(422).send({ detail: "Expected view=current|history|all (all with group), an opaque cursor and limit 1-50" });
      return reply.send(await listAgentWorkspaces(dbPool(context.config), id, projectId(request), parsed.data));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  // Default overview: one entry per conversation × repository (workspaceOverviewGroups).
  app.get("/api/v1/projects/:projectId/agent-workspace-groups", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const parsed = AgentWorkspaceGroupListQuerySchema.safeParse(query(request));
      if (!parsed.success) return reply.code(422).send({ detail: "Expected view=current|history, an opaque cursor and limit 1-50" });
      return reply.send(await listAgentWorkspaceGroups(dbPool(context.config), id, projectId(request), parsed.data));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  app.get("/api/v1/projects/:projectId/agent-workspaces/:workspaceId", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const workspaceId = params(request).workspaceId ?? "";
      const page = WorkspaceChangePageQuerySchema.safeParse(query(request));
      if (!page.success) return reply.code(422).send({ detail: "Expected an opaque cursor and limit 1-100" });
      return reply.send(await agentWorkspaceDetail(dbPool(context.config), id, projectId(request), workspaceId, page.data));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  // Pending workspace work of one conversation, independent of which turns are loaded.
  app.get("/api/v1/sessions/:sessionId/workspace-changes", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const page = WorkspaceChangePageQuerySchema.safeParse(query(request));
      if (!page.success) return reply.code(422).send({ detail: "Expected an opaque cursor and limit 1-100" });
      const result = await conversationWorkspaceChangesForViewer(dbPool(context.config), id.spaceId, params(request).sessionId ?? "", id.userId, page.data);
      if (result === null) return reply.code(404).send({ detail: "Conversation not found" });
      return reply.send({ items: result.entries, next_cursor: result.next_cursor });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
  app.get("/api/v1/projects/:projectId/host-execution-targets", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      const listTargets = repository.listHostExecutionTargets;
      if (!listTargets) return reply.code(501).send({ detail: "Host execution target listing is unavailable" });
      const selectedProjectId = projectId(request);
      await assertProjectReadable(dbPool(context.config), id.spaceId, selectedProjectId, id.userId);
      return reply.send({ targets: await listTargets.call(repository, id, selectedProjectId) });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const q = query(request);
      const page = parsePage(q);
      return reply.send(await services(context).repository.list(id, projectId(request), {
        status: q.status ?? null,
        limit: page.limit,
        offset: page.offset,
      }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const folder = await services(context).repository.get(id, projectId(request), folderId(request));
      if (!folder) return reply.code(404).send({ detail: "Project Folder not found" });
      return reply.send(folder);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/locations", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const service = services(context).repository;
      const listLocations = service.listLocations;
      if (!listLocations) return reply.code(501).send({ detail: "Workspace Location listing is unavailable" });
      return reply.send(await listLocations.call(service, id, projectId(request), folderId(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/tree", async (request, reply) => {
    // A read whose effects reach past the response: it spawns `git` on the
    // owner's machine and writes a policy record naming the requested path.
    if (!stateChangingReadAllowed(request, context.config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-site request refused" });
    }
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const q = query(request);
      const offset = q.offset === undefined ? 0 : Number(q.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(422, "Invalid directory offset");
      return reply.send(await services(context).repository.getTree(id, projectId(request), folderId(request), { path: q.path || ".", offset }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/file", async (request, reply) => {
    // A read whose effects reach past the response: it spawns `git` on the
    // owner's machine and writes a policy record naming the requested path.
    if (!stateChangingReadAllowed(request, context.config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-site request refused" });
    }
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const requestedPath = query(request).path;
      if (!requestedPath) throw new HttpError(422, "path is required");
      return reply.send(await services(context).repository.getFile(
        id,
        projectId(request),
        folderId(request),
        requestedPath,
        { includeUtf16Preview: query(request).convert === "utf8",workspaceLocationId:query(request).workspace_location_id },
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get('/api/v1/projects/:projectId/folders/:folderId/file/drafts/:draftId',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    try{const id=await identity(context,request,reply);if(!id)return reply;
      const draft=await PgProjectFolderRepository.fromConfig(context.config).getDraftById(id,projectId(request),folderId(request),params(request).draftId!);
      if(!draft)return reply.code(404).send({detail:'Draft not found or expired'});
      return reply.send(draft);
    }catch(error){return sendRouteError(reply,error);}
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/file/draft", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const path = query(request).path;
      if (!path) throw new HttpError(422, "path is required");
      const repository = services(context).repository;
      if (!repository.getDraft) return reply.code(501).send({ detail: "Project Folder drafts are unavailable" });
      return reply.send(await repository.getDraft(id, projectId(request), folderId(request), path,query(request).workspace_location_id));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/drafts/quota", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      if (!repository.draftQuota) return reply.code(501).send({ detail: "Project Folder drafts are unavailable" });
      return reply.send(await repository.draftQuota(id, projectId(request), folderId(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/file/revisions", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const requestedPath = query(request).path;
      if (!requestedPath) throw new HttpError(422, "path is required");
      const repository = services(context).repository;
      if (!repository.listFileRevisions) return reply.code(501).send({ detail: "Project Folder file revisions are unavailable" });
      return reply.send(await repository.listFileRevisions(
        id,
        projectId(request),
        folderId(request),
        requestedPath,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/file/revisions/:revisionId/preview", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      if (!repository.previewRevision) return reply.code(501).send({ detail: "Revision preview is unavailable" });
      const revisionId = params(request).revisionId;
      if (!revisionId) throw new HttpError(422, "revisionId is required");
      return reply.send(await repository.previewRevision(id, projectId(request), folderId(request), revisionId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/git/status", async (request, reply) => {
    // A read whose effects reach past the response: it spawns `git` on the
    // owner's machine and writes a policy record naming the requested path.
    if (!stateChangingReadAllowed(request, context.config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-site request refused" });
    }
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      return reply.send(await services(context).repository.getGitStatus(id, projectId(request), folderId(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/git/diff", async (request, reply) => {
    // A read whose effects reach past the response: it spawns `git` on the
    // owner's machine and writes a policy record naming the requested path.
    if (!stateChangingReadAllowed(request, context.config.frontendUrl)) {
      return reply.code(403).send({ detail: "Cross-site request refused" });
    }
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      return reply.send(await services(context).repository.getGitDiff(
        id,
        projectId(request),
        folderId(request),
        query(request).path ?? null,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
