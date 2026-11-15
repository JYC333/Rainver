import type { FastifyInstance } from "fastify";
import type { ModuleContext } from "../../gateway/routeRegistry.js";
import {
  HttpError,
  dbPool,
  optionalString,
  params,
  query,
  resolveIdentity,
  sendRouteError,
} from "../routeUtils/common.js";
import { EvolvableAssetRepository } from "./assetRepository.js";
import { EvolvableAssetEvaluationRepository } from "./assetEvaluationRepository.js";
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




  app.get(`${base}/:assetId/pins`, async (request, reply) => {
    const identity = await resolveIdentity(context.config, request, reply);
    if (!identity) return reply;
    try {
      return reply.send(await repository(context).listPins(identity, requireParam(request, "assetId")));
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





}
