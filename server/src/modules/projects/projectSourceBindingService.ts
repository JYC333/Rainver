import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, optionalString, requiredString, withQueryableTransaction } from "../routeUtils/common.js";
import { ProjectSourceBindingRepository } from "./projectSourceBindingRepository.js";
import { defaultExtractionProfileRegistry } from "../extractionProfiles/registry.js";
import { assertProjectReadable } from "./access.js";
import { ProjectResearchAreaService } from "../projectResearch/areaService.js";

/**
 * Project-owned application boundary for source consumption CRUD (binding
 * lifecycle, health). Proposal-first flows (propose-bind, source setup,
 * propose-backfill) live in `ProjectSourceProposalService`.
 */
export class ProjectSourceBindingService {
  private readonly repository: ProjectSourceBindingRepository;

  constructor(private readonly db: Queryable) {
    this.repository = new ProjectSourceBindingRepository(db);
  }

  listBindings(identity: SpaceUserIdentity, filters: { projectId: string; sourceChannelId: string | null }) {
    return this.repository.listProjectSourceBindings(identity, filters);
  }

  async listExtractionProfiles(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const defaultKey = defaultExtractionProfileRegistry.defaultKey();
    return defaultExtractionProfileRegistry.entriesList().map((entry) => ({
      key: entry.key,
      display_name: entry.displayName,
      entity_type: entry.entityType,
      domain_criteria_keys: [...(entry.domainCriteriaKeys ?? [])],
      graph_lens_id: entry.graphLensId ?? null,
      is_default: entry.key === defaultKey,
    }));
  }

  createBinding(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const projectId = requiredString(body.project_id, "project_id");
    requiredString(body.source_channel_id, "source_channel_id");
    validateDeliveryScope(body.delivery_scope);
    const normalized = { ...body, extraction_policy: normalizedExtractionPolicy(body.extraction_policy) };
    const create = () => withQueryableTransaction(this.db, (db) =>
      new ProjectSourceBindingRepository(db).createProjectSourceBinding(identity, normalized));
    return body.standing_comparison_enabled === true
      ? new ProjectResearchAreaService(this.db).initializeArea(identity, projectId).then(create)
      : create();
  }

  async updateBinding(identity: SpaceUserIdentity, bindingId: string, body: Record<string, unknown>, expectedProjectId?: string) {
    requiredString(bindingId, "binding_id");
    validateBindingStatus(body.status);
    validateDeliveryScope(body.delivery_scope);
    const projectId = await this.bindingProjectId(identity.spaceId, bindingId, expectedProjectId);
    if (body.standing_comparison_enabled === true) {
      await new ProjectResearchAreaService(this.db).initializeArea(identity, projectId);
    }
    const normalized = body.extraction_policy === undefined
      ? body
      : { ...body, extraction_policy: normalizedExtractionPolicy(body.extraction_policy) };
    return withQueryableTransaction(this.db, (db) =>
      new ProjectSourceBindingRepository(db).updateProjectSourceBinding(identity, bindingId, normalized));
  }

  async deleteBinding(identity: SpaceUserIdentity, bindingId: string, expectedProjectId?: string) {
    await this.bindingProjectId(identity.spaceId, bindingId, expectedProjectId);
    return withQueryableTransaction(this.db, (db) =>
      new ProjectSourceBindingRepository(db).deleteProjectSourceBinding(identity, bindingId));
  }

  async backfillBinding(identity: SpaceUserIdentity, bindingId: string, expectedProjectId?: string) {
    await this.bindingProjectId(identity.spaceId, bindingId, expectedProjectId);
    return withQueryableTransaction(this.db, (db) =>
      new ProjectSourceBindingRepository(db).backfillProjectSourceBinding(identity, bindingId));
  }

  health(identity: SpaceUserIdentity, projectId: string) {
    return this.repository.projectSourceHealth(identity, projectId);
  }

  private async bindingProjectId(spaceId: string, bindingId: string, expectedProjectId?: string): Promise<string> {
    const result = await this.db.query<{ project_id: string }>(
      `SELECT project_id FROM project_source_bindings WHERE space_id = $1 AND id = $2`,
      [spaceId, bindingId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Project source binding not found");
    if (expectedProjectId && result.rows[0].project_id !== expectedProjectId) {
      throw new HttpError(404, "Project source binding not found");
    }
    return result.rows[0].project_id;
  }
}

function normalizedExtractionPolicy(value: unknown): Record<string, unknown> {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new HttpError(422, "extraction_policy must be an object");
  }
  const policy = value ? { ...(value as Record<string, unknown>) } : {};
  if (Object.hasOwn(policy, "profile_key") && !optionalString(policy.profile_key)) {
    throw new HttpError(422, "extraction_policy.profile_key must be a non-empty string");
  }
  const profileKey = optionalString(policy.profile_key) ?? defaultExtractionProfileRegistry.defaultKey();
  if (!defaultExtractionProfileRegistry.get(profileKey)) {
    throw new HttpError(422, `unknown extraction profile: ${profileKey}`);
  }
  return { ...policy, profile_key: profileKey };
}

function validateBindingStatus(value: unknown): void {
  const status = optionalString(value);
  if (status && !["active", "paused", "archived"].includes(status)) {
    throw new HttpError(422, "invalid project source binding status");
  }
}

function validateDeliveryScope(value: unknown): void {
  const scope = optionalString(value);
  if (scope && !["project_members", "source_subscribers"].includes(scope)) {
    throw new HttpError(422, "delivery_scope must be project_members or source_subscribers");
  }
}
