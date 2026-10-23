import { HttpError, optionalObject, optionalString, type SpaceUserIdentity } from "../routeUtils/common.js";
import { getBuiltInCapabilityPack, listBuiltInCapabilityPacks } from "./packRegistry.js";
import { getBuiltInCapabilityDefinition, listBuiltInCapabilityDefinitions } from "./registry.js";
import { previewSkillImport, previewSkillFiles, type SkillFetcher, type SkillImportOptions } from "./skillImporter.js";
import { SkillImportPreviewRequestSchema, SkillImportRequestSchema, SkillReviewProposalRequestSchema } from "@rainver/protocol";
import { readSkillArchive } from "./skillArchive.js";
import { previewHostSkillSource } from "./skillHostImport.js";
import type { ServerConfig } from "../../config.js";
import type { PgCapabilitiesRepository } from "./repository.js";
import type { CapabilityDefinition } from "./types.js";

export class CapabilitiesService {
  constructor(
    private readonly repository: PgCapabilitiesRepository,
    private readonly importOptions?: SkillFetcher | SkillImportOptions,
    private readonly config?: ServerConfig,
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

  async previewSkillImport(body: Record<string, unknown>, identity?: SpaceUserIdentity) {
    return resolveSkillImportPreview(body, this.importOptions, identity, this.config);
  }

  /**
   * Import re-fetches the source. The commit names the package hash the
   * person previewed, and the snapshot is saved only when the bytes fetched
   * now hash to it: approval of one preview never carries over to content
   * that changed upstream in between.
   */
  async importSkill(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const parsed = SkillImportRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, "Invalid Skill import request");
    const { package_hash: previewedHash, ...source } = parsed.data;
    const preview = await this.previewSkillImport(source, identity);
    if (preview.package_hash !== previewedHash) {
      const detail = "The skill package changed since it was previewed; preview it again before importing";
      throw new HttpError(409, detail, { detail, code: "skill_package_changed" });
    }
    return this.repository.saveImportedSkill(identity, preview);
  }

  async createSkillReviewProposal(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    body: Record<string, unknown> = {},
  ) {
    const parsed = SkillReviewProposalRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, "Invalid Skill review request");
    return this.repository.createSkillImportApprovalProposal({
      identity,
      skillPackageId,
      binding: parsed.data.binding,
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
  const stack: unknown[] = [record];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    // Arrays are walked too: a key inside an array element is as embedded
    // as one at the top of the object.
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (/^(api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token)$/i.test(key)) {
        throw new HttpError(422, "skill overlay must reference credentials instead of embedding secrets");
      }
      if (item && typeof item === "object") stack.push(item);
    }
  }
}

export async function resolveSkillImportPreview(body: Record<string, unknown>, importOptions?: SkillFetcher | SkillImportOptions,
  identity?: SpaceUserIdentity, config?: ServerConfig) {
    const parsed = SkillImportPreviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, "Invalid Skill import source");
    const source = parsed.data;
    if (source.source_type === "local_workspace") {
      if (!identity || !config) throw new HttpError(503, "Global Skill import is unavailable");
      return previewHostSkillSource(config, identity, source);
    }
    if (source.source_type === "upload") {
      return previewSkillFiles({ files: "files" in source ? source.files : readSkillArchive(source.archive_base64) });
    }
    return previewSkillImport(source, importOptions);
}
