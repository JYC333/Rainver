import {registerSkillSourceResultRoute} from './sourceRequests.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as protocol from "@rainver/protocol";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  optionalString,
  parsePage,
  params,
  query,
  resolveIdentity as resolveRouteIdentity,
  sendRouteError,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { PgSkillsRepository } from "./repository.js";
import { SkillsService } from "./service.js";

function repository(context: ModuleContext): PgSkillsRepository {
  return PgSkillsRepository.fromConfig(context.config);
}
function service(context: ModuleContext): SkillsService {
  return new SkillsService(repository(context),undefined,context.config);
}

export function registerRoutes(app: FastifyInstance, context: ModuleContext): void {
  registerSkillSourceResultRoute(app,context);
  registerOperationAdapters(app,context.config,[
    {method:'POST',url:'/api/v1/skill-sources/hosts/:hostId/scan',operation:'skill.source.scan',params:{hostId:'host_id'}},
    {method:'POST',url:'/api/v1/skill-sources/import-preview',operation:'skill.source.preview',bodyLimit:5*1024*1024},
    {method:'POST',url:'/api/v1/skill-sources/import',operation:'skill.source.import',bodyLimit:5*1024*1024},
    {method:'PUT',url:'/api/v1/skills/:skillPackageId/local-overlay',operation:'skill.overlay.upsert',params:{skillPackageId:'skill_package_id'}},
    {method:'POST',url:'/api/v1/skill-packages/:skillPackageId/binding-proposal',operation:'skill.binding.propose',params:{skillPackageId:'skill_package_id'}},
    {method:'POST',url:'/api/v1/skill-packages/:skillPackageId/review-proposal',operation:'skill.review.propose',params:{skillPackageId:'skill_package_id'}},
  ]);
  app.get("/api/v1/skills/available", async (request, reply) => {
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
  app.get("/api/v1/skills/index", async (request, reply) => {
    const identity = await resolveIdentity(context, request, reply);
    if (!identity) return reply;
    try {
      const result = await service(context).listSkillLibraryIndex(identity);
      return reply.send(protocol.SkillLibraryIndexResponseSchema.parse(result));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get("/api/v1/skills/:skillPackageId/local-overlay", async (request, reply) => {
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


}

async function resolveIdentity(
  context: ModuleContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SpaceUserIdentity | null> {
  return resolveRouteIdentity(context.config, request, reply);
}
