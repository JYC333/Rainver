import { HttpError, optionalObject, optionalString, requiredString, type SpaceUserIdentity } from "../routeUtils/common.js";
import { getBuiltInCapabilityPack, listBuiltInCapabilityPacks } from "./packRegistry.js";
import { getBuiltInCapabilityDefinition, listBuiltInCapabilityDefinitions } from "./registry.js";
import { previewSkillImport, type SkillFetcher, type SkillImportOptions } from "./skillImporter.js";
import type { PgCapabilitiesRepository } from "./repository.js";
import type { CapabilityDefinition } from "./types.js";

export class CapabilitiesService {
  constructor(
    private readonly repository: PgCapabilitiesRepository,
    private readonly importOptions?: SkillFetcher | SkillImportOptions,
  ) {}

  async listCapabilityDefinitions(identity: SpaceUserIdentity): Promise<CapabilityDefinition[]> {
    const imported = await this.repository.listConvertedCapabilityDefinitions(identity);
    return [...listBuiltInCapabilityDefinitions(), ...imported].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  async getCapabilityDefinition(
    identity: SpaceUserIdentity,
    capabilityId: string,
  ): Promise<CapabilityDefinition | null> {
    return (
      getBuiltInCapabilityDefinition(capabilityId) ??
      (await this.repository.listConvertedCapabilityDefinitions(identity)).find(
        (capability) => capability.id === capabilityId,
      ) ??
      null
    );
  }

  listCapabilityPacks() {
    return listBuiltInCapabilityPacks();
  }

  getCapabilityPack(packId: string) {
    return getBuiltInCapabilityPack(packId);
  }

  async previewSkillImport(body: Record<string, unknown>) {
    return previewSkillImport(
      {
        url: requiredString(body.url, "url"),
        source_type: optionalString(body.source_type) as never,
      },
      this.importOptions,
    );
  }

  async importSkill(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const preview = await this.previewSkillImport(body);
    return this.repository.saveImportedSkill(identity, preview);
  }

  async createSkillReviewProposal(
    identity: SpaceUserIdentity,
    skillPackageId: string,
  ) {
    return this.repository.createSkillImportApprovalProposal({
      identity,
      skillPackageId,
    });
  }

  async convertSkillToCapability(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    body: Record<string, unknown>,
  ) {
    // Enablement mutates active runtime behavior and must go through proposal
    // review (ADR 0009). Conversion only ever produces a disabled draft.
    if (optionalString(body.enable_for_project_id)) {
      throw new HttpError(422, "capability_enablement_requires_proposal_review");
    }
    return this.repository.createSkillConversionProposal({
      identity,
      skillPackageId,
      body,
    });
  }

  async createCapabilityEnableProposal(
    identity: SpaceUserIdentity,
    capabilityId: string,
    body: Record<string, unknown>,
  ) {
    return this.repository.createCapabilityEnablementProposal({
      identity,
      capabilityKey: capabilityId,
      enabled: true,
      body,
    });
  }

  async createCapabilityDisableProposal(
    identity: SpaceUserIdentity,
    capabilityId: string,
    body: Record<string, unknown>,
  ) {
    return this.repository.createCapabilityEnablementProposal({
      identity,
      capabilityKey: capabilityId,
      enabled: false,
      body,
    });
  }

  listSkillPackages(identity: SpaceUserIdentity, filters: { limit: number; offset: number }) {
    return this.repository.listSkillPackages(identity, filters);
  }

  getSkillPackage(identity: SpaceUserIdentity, skillPackageId: string) {
    return this.repository.getSkillPackage(identity, skillPackageId);
  }

  listSkillLibraryIndex(identity: SpaceUserIdentity) {
    return this.repository.listSkillLibraryIndex(identity);
  }

  getSkillLocalOverlay(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    query: Record<string, unknown>,
  ) {
    return this.repository.getSkillLocalOverlay(identity, skillPackageId, {
      scope_type: optionalString(query.scope_type),
      scope_id: optionalString(query.scope_id),
    });
  }

  upsertSkillLocalOverlay(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    body: Record<string, unknown>,
  ) {
    assertNoEmbeddedOverlaySecrets(body.overlay_json);
    return this.repository.upsertSkillLocalOverlay(identity, skillPackageId, body as never);
  }
}

function assertNoEmbeddedOverlaySecrets(value: unknown): void {
  const record = optionalObject(value);
  if (!record) return;
  const stack: Record<string, unknown>[] = [record];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const [key, item] of Object.entries(current)) {
      if (/^(api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token)$/i.test(key)) {
        throw new HttpError(422, "skill overlay must reference credentials instead of embedding secrets");
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        stack.push(item as Record<string, unknown>);
      }
    }
  }
}
