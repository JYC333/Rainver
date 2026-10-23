import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  jsonBody,
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity as resolveRouteIdentity,
  sendRouteError,
  HttpError,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { getBuiltInCapabilityPack, listBuiltInCapabilityPacks } from "./packRegistry.js";
import { PgCapabilitiesRepository } from "./repository.js";
import { CapabilitiesService, resolveSkillImportPreview } from "./service.js";
import { scanHostSkillSource } from "./skillHostImport.js";
import { type SkillFetcher, type SkillImportOptions } from "./skillImporter.js";

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
  return new CapabilitiesService(repository(context), importOptionsOverride ?? undefined, context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  app.get("/api/v1/capabilities/skills/available", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      // Room menus name their addressed Agents: comma-separated or repeated.
      const recipients = [q.recipient_agent_ids].flat().flatMap(value => typeof value === "string" ? value.split(",") : [])
        .map(value => value.trim()).filter(Boolean);
      return reply.send(await repository(context).listAvailableSkills(identity, {
        session_id: optionalString(q.session_id) ?? undefined, project_id: optionalString(q.project_id) ?? undefined,
        agent_id: optionalString(q.agent_id) ?? undefined, recipient_agent_ids: recipients,
      }));
    } catch (error) { return sendRouteError(reply, error); }
  });
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

  app.post("/api/v1/skill-sources/hosts/:hostId/scan", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try { return reply.send(await scanHostSkillSource(context.config, identity, params(request).hostId ?? "")); }
    catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/api/v1/skill-sources/import-preview", { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const preview = await resolveSkillImportPreview(body, importOptionsOverride ?? undefined, identity, context.config);
      const { raw_content: _rawContent, package_contents: _contents, ...responseBody } = preview;
      return reply.send(responseBody);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/skill-sources/import", { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
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

  app.get("/api/v1/skill-packages/:skillPackageId/content", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(protocol.SkillPackageContentSchema.parse(await repository(context)
        .getSkillPackageContent(identity, params(request).skillPackageId ?? "")));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.get("/api/v1/skill-packages/:skillPackageId/bindings", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const bindings = await repository(context).listSkillBindings(identity, params(request).skillPackageId ?? "");
      return reply.send(bindings.map(binding => protocol.SkillBindingSchema.parse(binding)));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/api/v1/skill-packages/:skillPackageId/binding-proposal", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository(context).createSkillBindingProposal(
        identity, params(request).skillPackageId ?? "", jsonBody(request)));
    } catch (error) { return sendRouteError(reply, error); }
  });

  app.post("/api/v1/skill-packages/:skillPackageId/review-proposal", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const result = await service(context).createSkillReviewProposal(
        identity,
        params(request).skillPackageId ?? "",
        jsonBody(request),
      );
      // 200 when the caller's pending proposal for this snapshot is returned.
      return reply.code(result.created ? 201 : 200).send(result.proposal);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/api/v1/skill-packages/:skillPackageId/convert-to-capability", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const result = await service(context).convertSkillToCapability(
        identity,
        params(request).skillPackageId ?? "",
        jsonBody(request),
      );
      return reply.code(result.created ? 201 : 200).send(result.proposal);
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
