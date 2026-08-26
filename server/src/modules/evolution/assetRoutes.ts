import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  jsonBody,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { EvolvableAssetRepository } from "./assetRepository.js";
import { EvolvableAssetEvaluationRepository } from "./assetEvaluationRepository.js";
import { resolveEvolvableAssetVersion } from "./assetResolutionService.js";
import { EvaluationHarnessService } from "./evaluationHarnessService.js";

let repositoryFactoryOverride: ((context: ModuleContext) => EvolvableAssetRepository) | null = null;
let evaluationRepositoryFactoryOverride: ((context: ModuleContext) => EvolvableAssetEvaluationRepository) | null = null;

export function __setEvolvableAssetRepositoryFactoryForTests(
  factory: ((context: ModuleContext) => EvolvableAssetRepository) | null,
): void {
  repositoryFactoryOverride = factory;
}

export function __setEvolvableAssetEvaluationRepositoryFactoryForTests(
  factory: ((context: ModuleContext) => EvolvableAssetEvaluationRepository) | null,
): void {
  evaluationRepositoryFactoryOverride = factory;
}

function repository(context: ModuleContext): EvolvableAssetRepository {
  if (repositoryFactoryOverride) return repositoryFactoryOverride(context);
  return new EvolvableAssetRepository(dbPool(context.config));
}

function evaluationRepository(context: ModuleContext): EvolvableAssetEvaluationRepository {
  if (evaluationRepositoryFactoryOverride) return evaluationRepositoryFactoryOverride(context);
  return new EvolvableAssetEvaluationRepository(dbPool(context.config));
}

function evaluationHarness(context: ModuleContext): EvaluationHarnessService {
  return new EvaluationHarnessService(dbPool(context.config));
}

function requireParam(request: Parameters<typeof params>[0], name: string): string {
  const value = params(request)[name];
  if (!value) throw new HttpError(422, `${name} is required`);
  return value;
}

export function registerEvolvableAssetRoutes(app: FastifyInstance, context: ModuleContext): void {
  const base = "/api/v1/evolution/assets";

  app.get(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const q = query(request);
      return reply.send(await repository(context).listAssets(identity, { assetType: optionalString(q.asset_type) }));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(base, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(await repository(context).createAsset(identity, jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:assetId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).getAsset(identity, requireParam(request, "assetId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:assetId/versions`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).listVersions(identity, requireParam(request, "assetId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/versions`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(await repository(context).createVersion(identity, requireParam(request, "assetId"), jsonBody(request)));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch(`${base}/:assetId/versions/:versionId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).updateVersionContent(
          identity,
          requireParam(request, "assetId"),
          requireParam(request, "versionId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/versions/:versionId/transition`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).transitionVersionStatus(
          identity,
          requireParam(request, "assetId"),
          requireParam(request, "versionId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:assetId/pins`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).listPins(identity, requireParam(request, "assetId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.put(`${base}/:assetId/pins/:scopeType/:scopeId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(
        await repository(context).setPin(
          identity,
          requireParam(request, "assetId"),
          requireParam(request, "scopeType"),
          requireParam(request, "scopeId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete(`${base}/:assetId/pins/:scopeType/:scopeId`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      await repository(context).archivePin(
        identity,
        requireParam(request, "assetId"),
        requireParam(request, "scopeType"),
        requireParam(request, "scopeId"),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/resolve`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const asset = await repository(context).getAsset(identity, requireParam(request, "assetId"));
      const body = jsonBody(request);
      const result = await resolveEvolvableAssetVersion(dbPool(context.config), {
        assetId: asset.id as string,
        spaceId: identity.spaceId,
        assetKey: asset.asset_key as string,
        assetType: asset.asset_type as string,
        projectId: optionalString(body.project_id),
        userId: identity.userId,
        agentId: optionalString(body.agent_id),
        explicitVersionId: optionalString(body.explicit_version_id),
        allowUserPin: body.allow_user_pin === true,
      });
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:assetId/evaluation-runs`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await evaluationRepository(context).listEvaluationRuns(identity, requireParam(request, "assetId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get(`${base}/:assetId/evaluation-cases`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await evaluationHarness(context).listCases(identity, requireParam(request, "assetId")));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/evaluation-cases`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(201).send(
        await evaluationHarness(context).createCase(
          identity,
          requireParam(request, "assetId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/evaluation-cases/from-run`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      const body = jsonBody(request);
      const sourceRunId = optionalString(body.source_run_id);
      if (!sourceRunId) throw new HttpError(422, "source_run_id is required");
      return reply.code(201).send(
        await evaluationHarness(context).createCaseFromRun(identity, requireParam(request, "assetId"), {
          ...body,
          source_run_id: sourceRunId,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/versions/:versionId/evaluation-cases/:caseId/execute`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.code(202).send(
        await evaluationHarness(context).startEvaluation(
          identity,
          requireParam(request, "assetId"),
          requireParam(request, "versionId"),
          requireParam(request, "caseId"),
          jsonBody(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/versions/:versionId/evaluate`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(
          await evaluationRepository(context).recordEvaluationRun(
            identity,
            requireParam(request, "assetId"),
            requireParam(request, "versionId"),
            jsonBody(request),
          ),
        );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post(`${base}/:assetId/versions/:versionId/promote-proposal`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply
        .code(201)
        .send(
          await evaluationRepository(context).createPromotionProposal(
            identity,
            requireParam(request, "assetId"),
            requireParam(request, "versionId"),
            jsonBody(request),
          ),
        );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
