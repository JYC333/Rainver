import type { ServerConfig } from "../../config.js";
import type { Pool, SpaceUserIdentity } from "../routeUtils/common.js";
import { page } from "../routeUtils/common.js";
import { SourceRecipePipelineBridgeService } from "./sourceRecipes/pipelineBridgeService.js";
import { listSourceRecipePrimitives } from "./sourceRecipes/primitiveRegistry.js";
import { SourceRecipeCreateService } from "./sourceRecipes/recipeCreateService.js";
import { SourceRecipeDryRunService } from "./sourceRecipes/recipeDryRunService.js";
import {
  getSourceRecipeVersion,
  listSourceRecipeVersions,
  recipeVersionOut,
} from "./sourceRecipes/recipeVersionStore.js";

/** Single application-service entry point for the complete Source Recipe flow. */
export class SourceRecipeService {
  private readonly createService: SourceRecipeCreateService;
  private readonly dryRunService: SourceRecipeDryRunService;
  private readonly pipelineBridgeService: SourceRecipePipelineBridgeService;

  constructor(private readonly db: Pool, config: ServerConfig) {
    this.createService = new SourceRecipeCreateService(db, config);
    this.dryRunService = new SourceRecipeDryRunService(db, config);
    this.pipelineBridgeService = new SourceRecipePipelineBridgeService(db, config);
  }

  listPrimitives() {
    return { primitives: listSourceRecipePrimitives() };
  }

  planSource(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    return this.createService.planSource(identity, body);
  }

  createSource(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    return this.createService.createSource(identity, body);
  }

  activateRecipe(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    return this.createService.activateRecipe(identity, connectionId, body);
  }

  bridgePipelineHandler(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    return this.pipelineBridgeService.bridgePipelineHandler(identity, connectionId, body);
  }

  dryRunRecipeVersion(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    return this.dryRunService.dryRunRecipeVersion(identity, connectionId, body);
  }

  async listVersions(spaceId: string, connectionId: string, pagination: { limit: number; offset: number }) {
    const listed = await listSourceRecipeVersions(this.db, spaceId, connectionId, pagination);
    return page(listed.rows.map(recipeVersionOut), listed.total, pagination.limit, pagination.offset);
  }

  async getVersion(spaceId: string, connectionId: string, versionId: string) {
    const version = await getSourceRecipeVersion(this.db, spaceId, connectionId, versionId);
    return version ? recipeVersionOut(version) : null;
  }
}
