import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry";
import {
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  requiredString,
  resolveIdentity as resolveRouteIdentity,
  sendRouteError,
  HttpError,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { loadProtocol } from "../providers/protocolRuntime";
import { getBuiltInCapabilityPack, listBuiltInCapabilityPacks } from "./packRegistry";
import { PgCapabilitiesRepository } from "./repository";
import { CapabilitiesService } from "./service";
import { previewSkillImport, type SkillFetcher, type SkillImportOptions } from "./skillImporter";

type CapabilitiesRepositoryFactory = (context: ModuleContext) => PgCapabilitiesRepository;
type CapabilitiesIdentityOverride =
  | SpaceUserIdentity
  | ((request: FastifyRequest) => Promise<SpaceUserIdentity | null> | SpaceUserIdentity | null);

let repositoryFactoryOverride: CapabilitiesRepositoryFactory | null = null;
let identityOverride: CapabilitiesIdentityOverride | null = null;
let importOptionsOverride: SkillFetcher | SkillImportOptions | null = null;

export function __setCapabilitiesRepositoryFactoryForTests(
  factory: CapabilitiesRepositoryFactory | null,
): void {
  repositoryFactoryOverride = factory;
}

export function __setCapabilitiesIdentityForTests(
  identity: CapabilitiesIdentityOverride | null,
): void {
  identityOverride = identity;
}

export function __setCapabilitiesSkillFetcherForTests(
  importOptions: SkillFetcher | SkillImportOptions | null,
): void {
  importOptionsOverride = importOptions;
}

function repository(context: ModuleContext): PgCapabilitiesRepository {
  return repositoryFactoryOverride?.(context) ?? PgCapabilitiesRepository.fromConfig(context.config);
}

function service(context: ModuleContext): CapabilitiesService {
  return new CapabilitiesService(repository(context), importOptionsOverride ?? undefined);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/capability-definitions", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await service(context).listCapabilityDefinitions(identity));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/capability-definitions/:capabilityId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const found = await service(context).getCapabilityDefinition(
        identity,
        params(request).capabilityId ?? "",
      );
      if (!found) return reply.code(404).send({ detail: "Capability definition not found" });
      return reply.send(found);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/capability-definitions/:capabilityId/enable-proposal", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await service(context).createCapabilityEnableProposal(
          identity,
          params(request).capabilityId ?? "",
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/capability-definitions/:capabilityId/disable-proposal", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await service(context).createCapabilityDisableProposal(
          identity,
          params(request).capabilityId ?? "",
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/capability-packs", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    return reply.send(listBuiltInCapabilityPacks());
  });

  app.get("/api/v1/capability-packs/:packId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    const found = getBuiltInCapabilityPack(params(request).packId ?? "");
    if (!found) return reply.code(404).send({ detail: "Capability pack not found" });
    return reply.send(found);
  });

  app.get("/api/v1/capabilities/skills/index", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const result = await service(context).listSkillLibraryIndex(identity);
      return reply.send(protocol.SkillLibraryIndexResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/capabilities/skills/:skillPackageId/local-overlay", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const overlay = await service(context).getSkillLocalOverlay(
        identity,
        params(request).skillPackageId ?? "",
        query(request),
      );
      if (!overlay) return reply.code(404).send({ detail: "Skill local overlay not found" });
      return reply.send(protocol.SkillLocalOverlaySchema.parse(overlay));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put("/api/v1/capabilities/skills/:skillPackageId/local-overlay", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const protocol = await loadProtocol();
      const parsed = protocol.SkillLocalOverlayUpsertRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) {
        throw new HttpError(422, parsed.error.issues[0]?.message ?? "invalid skill overlay request");
      }
      const overlay = await service(context).upsertSkillLocalOverlay(
        identity,
        params(request).skillPackageId ?? "",
        parsed.data,
      );
      return reply.send(protocol.SkillLocalOverlaySchema.parse(overlay));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/skill-sources/import-preview", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const preview = await previewSkillImport(
        {
          url: requiredString(body.url, "url"),
          source_type: optionalString(body.source_type) as never,
        },
        importOptionsOverride ?? undefined,
      );
      const { raw_content: _rawContent, ...responseBody } = preview;
      return reply.send(responseBody);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/skill-sources/import", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await service(context).importSkill(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/skill-packages", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const { limit, offset } = parsePage(query(request), 50);
      return reply.send(await service(context).listSkillPackages(identity, { limit, offset }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/skill-packages/:skillPackageId", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const found = await service(context).getSkillPackage(
        identity,
        params(request).skillPackageId ?? "",
      );
      if (!found) return reply.code(404).send({ detail: "Skill package not found" });
      return reply.send(found);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/skill-packages/:skillPackageId/review-proposal", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await service(context).createSkillReviewProposal(
          identity,
          params(request).skillPackageId ?? "",
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/skill-packages/:skillPackageId/convert-to-capability", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await service(context).convertSkillToCapability(
          identity,
          params(request).skillPackageId ?? "",
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SpaceUserIdentity | null> {
  if (identityOverride) {
    return typeof identityOverride === "function"
      ? identityOverride(request)
      : identityOverride;
  }
  return resolveRouteIdentity(context.config, request, reply);
}
