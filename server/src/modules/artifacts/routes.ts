import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext";
import { introspectIdentity } from "../auth/identity";
import {
  ArtifactNotExportableError,
  ArtifactValidationError,
  PgArtifactRepository,
} from "./repository";

type ArtifactIdentity = { spaceId: string; userId: string };
type ArtifactIdentityOverride =
  | ArtifactIdentity
  | ((request: FastifyRequest) => Promise<ArtifactIdentity | null> | ArtifactIdentity | null);

type ArtifactRepository = Pick<PgArtifactRepository, "listVisible" | "getVisible" | "exportVisible">;
type ArtifactRepositoryFactory = (context: ModuleContext) => ArtifactRepository;

let repositoryFactoryOverride: ArtifactRepositoryFactory | null = null;
let identityOverride: ArtifactIdentityOverride | null = null;

export function __setArtifactRepositoryFactoryForTests(
  factory: ArtifactRepositoryFactory | null,
): void {
  repositoryFactoryOverride = factory;
}

export function __setArtifactIdentityForTests(identity: ArtifactIdentityOverride | null): void {
  identityOverride = identity;
}

function repository(context: ModuleContext): ArtifactRepository {
  return repositoryFactoryOverride?.(context) ?? PgArtifactRepository.fromConfig(context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/artifacts", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const parsed = parseListFilters(request);
    if ("error" in parsed) return reply.code(422).send({ detail: parsed.error });
    try {
      return reply.send(
        await repository(context).listVisible(identity.spaceId, identity.userId, parsed.filters),
      );
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.get("/api/v1/artifacts/:artifactId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const artifactId = params(request).artifactId ?? "";
    const artifact = await repository(context).getVisible(
      identity.spaceId,
      identity.userId,
      artifactId,
      true,
      query(request).project_folder_id ?? null,
    );
    if (!artifact) return reply.code(404).send({ detail: "Artifact not found" });
    return reply.send(artifact);
  });

  app.get("/api/v1/artifacts/:artifactId/export", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const artifactId = params(request).artifactId ?? "";
    try {
      const exported = await repository(context).exportVisible(
        identity.spaceId,
        identity.userId,
        artifactId,
        query(request).project_folder_id ?? null,
      );
      if (!exported) return reply.code(404).send({ detail: "Artifact not found" });
      reply.header("content-type", exported.mediaType);
      reply.header("content-disposition", `attachment; filename="${exported.filename}"`);
      if (exported.body) return reply.send(exported.body);
      return reply.send(exported.stream);
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ArtifactIdentity | null> {
  if (identityOverride) {
    return typeof identityOverride === "function"
      ? identityOverride(request)
      : identityOverride;
  }
  const requestId = resolveRequestId(request);
  reply.header(REQUEST_ID_HEADER, requestId);
  const identity = await introspectIdentity(context.config, request);
  if (identity.ok) return { spaceId: identity.spaceId, userId: identity.userId };
  if (identity.reason === "denied") {
    reply.code(identity.statusCode);
    reply.header("content-type", "application/json");
    reply.send(identity.body);
    return null;
  }
  await sendErrorEnvelope(
    reply,
    502,
    errorEnvelope(
      identity.reason === "contract_violation"
        ? "introspect_contract_violation"
        : "identity_unavailable",
      "Identity introspection failed",
      requestId,
    ),
  );
  return null;
}

function parseListFilters(request: FastifyRequest):
  | {
      filters: {
        artifactType: string | null;
        runId: string | null;
        projectId: string | null;
        projectFolderId: string | null;
        includeSystemArchives: boolean;
        limit: number;
        offset: number;
      };
    }
  | { error: string } {
  const q = query(request);
  const limit = intQuery(q.limit, 50);
  const offset = intQuery(q.offset, 0);
  if (limit === null || limit < 0 || limit > 200) {
    return { error: "limit must be between 0 and 200" };
  }
  if (offset === null || offset < 0) return { error: "offset must be non-negative" };
  return {
    filters: {
      artifactType: q.artifact_type ?? null,
      runId: q.run_id ?? null,
      projectId: q.project_id ?? null,
      projectFolderId: q.project_folder_id ?? null,
      includeSystemArchives: q.include_system_archives === "true",
      limit,
      offset,
    },
  };
}

function sendArtifactError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ArtifactValidationError || error instanceof ArtifactNotExportableError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  throw error;
}

function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

function query(request: FastifyRequest): Record<string, string | undefined> {
  return request.query as Record<string, string | undefined>;
}

function intQuery(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
