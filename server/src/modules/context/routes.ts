import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  jsonBody,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
  HttpError,
} from "../routeUtils/common";
import { buildContextPackage } from "./contextPackage";
import { ContextDigestRefreshService } from "./digestService";
import { PgContextProfileRepository } from "./profiles";
import { PgRunContextRepository } from "./repository";
import { loadProtocol } from "../providers/protocolRuntime";

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/context/profiles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const repo = PgContextProfileRepository.fromConfig(context.config);
      const items = await repo.list(identity, {
        scopeType: optionalString(q.scope_type),
        scopeId: optionalString(q.scope_id),
        status: optionalString(q.status),
      });
      const protocol = await loadProtocol();
      return reply.send(protocol.ContextProfileListResponseSchema.parse({ items }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/context/profiles", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const parsed = protocol.ContextProfileUpsertRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) {
        throw new HttpError(422, parsed.error.issues[0]?.message ?? "invalid context profile request");
      }
      const repo = PgContextProfileRepository.fromConfig(context.config);
      const profile = await repo.upsert(identity, parsed.data);
      return reply.send(protocol.ContextProfileSchema.parse(profile));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/context/project-folders/:projectFolderId/routing", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectFolderId = optionalString(params(request).projectFolderId);
      if (!projectFolderId) throw new HttpError(422, "project_folder_id is required");
      const repo = PgContextProfileRepository.fromConfig(context.config);
      const result = await repo.getFolderRouting(identity, projectFolderId);
      const protocol = await loadProtocol();
      return reply.send(protocol.ContextEffectiveRoutingResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/context/project-folders/:projectFolderId/routing", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const projectFolderId = optionalString(params(request).projectFolderId);
      if (!projectFolderId) throw new HttpError(422, "project_folder_id is required");
      const protocol = await loadProtocol();
      const parsed = protocol.ContextRoutingUpdateRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) {
        throw new HttpError(422, parsed.error.issues[0]?.message ?? "invalid context routing request");
      }
      const repo = PgContextProfileRepository.fromConfig(context.config);
      await repo.upsert(identity, {
        scope_type: "project_folder",
        scope_id: projectFolderId,
        status: "active",
        version: parsed.data.routing_manifest_json.version,
        context_pack_json: parsed.data.context_pack_json,
        routing_manifest_json: parsed.data.routing_manifest_json,
      });
      const result = await repo.getFolderRouting(identity, projectFolderId);
      return reply.send(protocol.ContextEffectiveRoutingResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/context/artifact-revocations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const repo = PgRunContextRepository.fromConfig(context.config);
      const items = await repo.listArtifactRevocations({
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectFolderId: optionalString(q.project_folder_id),
        projectId: optionalString(q.project_id),
        artifactIds: artifactIdsQuery(q.artifact_ids),
      });
      return reply.send({ items });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/context/artifact-revocations", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const parsed = protocol.ContextArtifactRevocationCreateRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) {
        throw new HttpError(422, parsed.error.issues[0]?.message ?? "invalid artifact revocation request");
      }
      const repo = PgRunContextRepository.fromConfig(context.config);
      const item = await repo.createArtifactRevocation({
        spaceId: identity.spaceId,
        userId: identity.userId,
        artifactId: parsed.data.artifact_id,
        scopeType: parsed.data.scope_type,
        scopeId: parsed.data.scope_id,
        reason: parsed.data.reason,
      });
      return reply.code(201).send(item);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete("/api/v1/context/artifact-revocations/:artifactId", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      const p = params(request);
      const artifactId = optionalString(p.artifactId);
      if (!artifactId) throw new HttpError(422, "artifact_id is required");
      const scopeType = revocationScope(optionalString(q.scope_type));
      const scopeId = optionalString(q.scope_id);
      if (!scopeId) throw new HttpError(422, "scope_id is required");
      const repo = PgRunContextRepository.fromConfig(context.config);
      await repo.deleteArtifactRevocation({
        spaceId: identity.spaceId,
        userId: identity.userId,
        artifactId,
        scopeType,
        scopeId,
      });
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/context/build", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const q = query(request);
      const projectFolderId = optionalString(body.project_folder_id) ?? optionalString(q.project_folder_id);
      const projectId = optionalString(body.project_id) ?? optionalString(q.project_id);
      const agentId = optionalString(body.agent_id) ?? optionalString(q.agent_id);
      const capabilityId = optionalString(body.capability_id) ?? optionalString(q.capability_id);
      const sessionId = optionalString(body.session_id) ?? optionalString(q.session_id);
      const runId = optionalString(body.run_id) ?? optionalString(q.run_id);
      const contextArtifactIds = stringArrayBody(body.context_artifact_ids);
      const repo = PgRunContextRepository.fromConfig(context.config);
      const retrieval = await repo.retrieve({
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectFolderId,
        agentId,
        capabilityId,
        query: optionalString(body.query) ?? optionalString(q.query),
        agentMemoryPolicy: null,
        includeSystemScope: true,
        // null = project-free memories only; undefined = no filter (all space memories).
        // Omitting project_id yields project-free context, not an unfiltered dump.
        projectId: projectId ?? null,
      });
      const sessionSummary = await repo.loadLatestSessionSummary(identity.spaceId, sessionId);
      const evidenceSelections = await repo.selectEvidenceForContext({
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectFolderId,
        projectId,
        runId,
      });
      const artifactAttachments = await repo.selectArtifactAttachments({
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectFolderId,
        projectId,
        artifactIds: contextArtifactIds,
      });
      const pkg = buildContextPackage({
        memories: retrieval.memories,
        activePolicies: retrieval.activePolicies,
        sourceRefs: retrieval.sourceRefs,
        retrievalTrace: {
          ...retrieval.retrievalTrace,
          preview_request: {
            project_folder_id: projectFolderId,
            project_id: projectId,
            agent_id: agentId,
            capability_id: capabilityId,
            session_id: sessionId,
            run_id: runId,
          },
        },
        tokenBudget: retrieval.tokenBudget,
        userId: identity.userId,
        spaceId: identity.spaceId,
        projectFolderId,
        sessionSummary,
        evidenceSelections,
        artifactAttachments,
      });
      const protocol = await loadProtocol();
      return reply.send(protocol.ContextPackageSchema.parse(pkg));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/context/digests/refresh", async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const refresh = ContextDigestRefreshService.fromConfig(context.config);
      // Two modes:
      //  - empty body  → refreshAllDirty: incremental, only re-generates digests
      //    already marked dirty. It does NOT bootstrap a scope's first digest.
      //  - explicit body {scope_type, digest_type, scope_id?} → generates that one
      //    digest, creating the first version if none exists (use this to bootstrap).
      if (Object.keys(body).length === 0) {
        const digests = await refresh.refreshAllDirty(identity.spaceId);
        return reply.send({ refreshed_count: digests.length, digests });
      }
      const req = parseDigestRefreshRequest(body);
      const digest = await refresh.refresh(
        identity.spaceId,
        req.scope_type,
        req.scope_id,
        req.digest_type,
      );
      return reply.send({ refreshed_count: 1, digests: [digest] });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function stringArrayBody(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(422, "context_artifact_ids must be an array");
  }
  if (value.length > 8) {
    throw new HttpError(422, "context_artifact_ids must contain at most 8 items");
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new HttpError(422, "context_artifact_ids must contain non-empty strings");
    }
    return item.trim();
  });
}

function artifactIdsQuery(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
}

function revocationScope(value: string | null): "project_folder" | "project" {
  if (value === "project_folder" || value === "project") return value;
  throw new HttpError(422, "scope_type must be project_folder or project");
}

type DigestRefreshRequest = {
  scope_type: "space" | "project_folder" | "agent";
  scope_id: string | null;
  digest_type: "policy_bundle" | "project_folder" | "agent";
};

function parseDigestRefreshRequest(body: Record<string, unknown>): DigestRefreshRequest {
  const allowed = new Set(["scope_type", "scope_id", "digest_type"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HttpError(422, `unknown field: ${unknown[0]}`);
  }
  const scopeType = optionalString(body.scope_type);
  const digestType = optionalString(body.digest_type);
  if (!scopeType || !digestType) {
    throw new HttpError(422, "scope_type and digest_type must be provided together");
  }
  if (!["space", "project_folder", "agent"].includes(scopeType)) {
    throw new HttpError(422, "scope_type must be one of space, project_folder, agent");
  }
  if (!["policy_bundle", "project_folder", "agent"].includes(digestType)) {
    throw new HttpError(422, "digest_type must be one of policy_bundle, project_folder, agent");
  }
  const scopeId = optionalString(body.scope_id);
  if (digestType === "policy_bundle") {
    if (scopeType !== "space") {
      throw new HttpError(422, "policy_bundle refresh requires scope_type=space");
    }
    if (scopeId) {
      throw new HttpError(422, "policy_bundle refresh does not accept scope_id");
    }
    return { scope_type: "space", scope_id: null, digest_type: "policy_bundle" };
  }
  if (digestType === "project_folder") {
    if (scopeType !== "project_folder") {
      throw new HttpError(422, "project_folder digest refresh requires scope_type=project_folder");
    }
    if (!scopeId) throw new HttpError(422, "project_folder digest refresh requires scope_id");
    return { scope_type: "project_folder", scope_id: scopeId, digest_type: "project_folder" };
  }
  if (scopeType !== "agent") {
    throw new HttpError(422, "agent digest refresh requires scope_type=agent");
  }
  if (!scopeId) throw new HttpError(422, "agent digest refresh requires scope_id");
  return { scope_type: "agent", scope_id: scopeId, digest_type: "agent" };
}
