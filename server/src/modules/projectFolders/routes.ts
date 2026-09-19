import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stateChangingReadAllowed } from "../../gateway/csrfOrigin.js";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  jsonBody,
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
import { sharedHostConnectionRegistry } from "../hosts/connectionRegistry.js";
import { PgWorkspaceLocationRepository } from "./workspaceLocations.js";

interface ProjectFolderServices {
  repository: Pick<
    PgProjectFolderRepository,
    | "list"
    | "create"
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
  > & Partial<Pick<PgProjectFolderRepository, "listLocations" | "listHostExecutionTargets" | "listFileRevisions" | "getDraft" | "upsertDraft" | "discardDraft" | "draftQuota" | "saveDraft" | "restoreRevisionAsDraft" | "previewRevision">>;
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

  app.post("/api/v1/projects/:projectId/folders", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const folder = await services(context).repository.create(id, projectId(request), jsonBody(request));
      return reply.code(201).send(folder);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/folders/scan", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      return reply.send({
        items: await services(context).repository.scanCandidates(id, projectId(request)),
      });
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

  app.post("/api/v1/projects/:projectId/folders/:folderId/locations/:locationId/activate", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const locationId = params(request).locationId;
      if (!locationId) throw new HttpError(422, "locationId is required");
      return reply.send(await services(context).repository.activateLocation(
        id,
        projectId(request),
        folderId(request),
        locationId,
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch("/api/v1/projects/:projectId/folders/:folderId", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const folder = await services(context).repository.update(
        id,
        projectId(request),
        folderId(request),
        jsonBody(request),
      );
      if (!folder) return reply.code(404).send({ detail: "Project Folder not found" });
      return reply.send(folder);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/projects/:projectId/folders/:folderId", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const archived = await services(context).repository.archive(id, projectId(request), folderId(request));
      if (!archived) return reply.code(404).send({ detail: "Project Folder not found" });
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/folders/:folderId/unregister", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      // Captured before the rows disappear: after a successful unregister the
      // daemon should drop its local path mapping too (best effort — an
      // offline daemon keeps it, and `workspace list` shows the divergence).
      const remoteLocations = (await new PgWorkspaceLocationRepository(dbPool(context.config)).listForFolder(id, folderId(request)))
        .filter((location) => location.execution_host_kind === "remote");
      const removed = await services(context).repository.unregister(
        id,
        projectId(request),
        folderId(request),
        { confirm: jsonBody(request).confirm === true },
      );
      if (!removed) return reply.code(404).send({ detail: "Project Folder not found" });
      for (const location of remoteLocations) {
        void sharedHostConnectionRegistry.forgetHostWorkspace(location.execution_host_id, location.id);
      }
      return reply.code(204).send();
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
      return reply.send(await services(context).repository.getTree(id, projectId(request), folderId(request)));
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
        { includeUtf16Preview: query(request).convert === "utf8" },
      ));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/folders/:folderId/file/draft", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const path = query(request).path;
      if (!path) throw new HttpError(422, "path is required");
      const repository = services(context).repository;
      if (!repository.getDraft) return reply.code(501).send({ detail: "Project Folder drafts are unavailable" });
      return reply.send(await repository.getDraft(id, projectId(request), folderId(request), path));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/projects/:projectId/folders/:folderId/file/draft", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      if (!repository.upsertDraft) return reply.code(501).send({ detail: "Project Folder drafts are unavailable" });
      return reply.send(await repository.upsertDraft(id, projectId(request), folderId(request), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/folders/:folderId/file/draft/rebase", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      if (!repository.upsertDraft) return reply.code(501).send({ detail: "Project Folder drafts are unavailable" });
      return reply.send(await repository.upsertDraft(id, projectId(request), folderId(request), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/folders/:folderId/file/draft/discard", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      if (!repository.discardDraft) return reply.code(501).send({ detail: "Project Folder drafts are unavailable" });
      return reply.send(await repository.discardDraft(id, projectId(request), folderId(request), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/folders/:folderId/file/draft/save", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      if (!repository.saveDraft) return reply.code(501).send({ detail: "Project Folder draft saving is unavailable" });
      return reply.send(await repository.saveDraft(id, projectId(request), folderId(request), jsonBody(request)));
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

  app.post("/api/v1/projects/:projectId/folders/:folderId/file/revisions/restore-as-draft", async (request, reply) => {
    try {
      const id = await identity(context, request, reply);
      if (!id) return reply;
      const repository = services(context).repository;
      if (!repository.restoreRevisionAsDraft) return reply.code(501).send({ detail: "Restore as draft is unavailable" });
      return reply.send(await repository.restoreRevisionAsDraft(id, projectId(request), folderId(request), jsonBody(request)));
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
