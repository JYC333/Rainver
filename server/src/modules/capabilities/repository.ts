import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import {
  HttpError,
  countFromRow,
  dateIso,
  objectValue,
  optionalObject,
  optionalString,
  page,
  requiredString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { proposalToOut } from "../proposals/repository";
import { insertProposalRow } from "../proposals/reviewPackets";
import { assertProjectWriter } from "../projects/access";
import { getBuiltInCapabilityDefinition } from "./registry";
import type {
  CapabilityDefinition,
  CapabilityRuntimeBinding,
  NormalizedSkill,
  ProjectWorkflowProfile,
  SkillImportPreview,
  SkillPackage,
  SkillPackageFilePreview,
  SkillRiskLevel,
} from "./types";
import type {
  ProposalOut,
  SkillLibraryIndexResponse,
  SkillLocalOverlay,
  SkillLocalOverlayConfig,
  SkillLocalOverlayScope,
  SkillLocalOverlayStatus,
} from "@agent-space/protocol" with { "resolution-mode": "import" };

interface SkillPackageRow {
  id: string;
  source_id: string;
  package_name: string;
  version: string | null;
  license: string | null;
  raw_storage_ref: string | null;
  manifest_json: unknown;
  normalized_json: unknown;
  risk_level: SkillRiskLevel;
  status: string;
  created_at: unknown;
  updated_at: unknown;
}

interface WorkflowProfileRow {
  id: string;
  space_id: string;
  project_id: string;
  workflow_template_id: string;
  name: string;
  enabled: boolean;
  config_json: unknown;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface CapabilityVersionRow {
  id: string;
  capability_key: string;
  version: string;
  source: string;
  status: string;
  metadata_json: unknown;
}

interface SkillPackageWithSourceRow extends SkillPackageRow {
  source_type: string;
  url: string | null;
  repo: string | null;
  path: string | null;
  ref: string | null;
  commit_sha: string | null;
  content_hash: string;
  fetched_at: unknown;
  source_metadata_json: unknown;
}

interface SkillPackageFileRow {
  id: string;
  skill_package_id: string;
  path: string;
  kind: string;
  content_hash: string | null;
  content_type: string | null;
  byte_length: number | null;
  storage_ref: string | null;
  included: boolean;
  executable: boolean;
  risk_flags_json: unknown;
  created_at: unknown;
}

interface SkillLocalOverlayRow {
  id: string;
  space_id: string;
  skill_package_id: string;
  scope_type: SkillLocalOverlayScope;
  scope_id: string | null;
  overlay_json: unknown;
  status: SkillLocalOverlayStatus;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const SKILL_PACKAGE_COLUMNS = `
  id, source_id, package_name, version, license, raw_storage_ref,
  manifest_json, normalized_json, risk_level, status, created_at, updated_at
`;

const SKILL_PACKAGE_COLUMNS_SP = prefixedColumns(SKILL_PACKAGE_COLUMNS, "sp");

const SKILL_PACKAGE_FILE_COLUMNS = `
  id, skill_package_id, path, kind, content_hash, content_type, byte_length,
  storage_ref, included, executable, risk_flags_json, created_at
`;

const SKILL_LOCAL_OVERLAY_COLUMNS = `
  id, space_id, skill_package_id, scope_type, scope_id, overlay_json, status,
  created_by_user_id, created_at, updated_at
`;

const WORKFLOW_PROFILE_COLUMNS = `
  id, space_id, project_id, workflow_template_id, name, enabled,
  config_json, created_by_user_id, created_at, updated_at
`;

export class PgCapabilitiesRepository {
  constructor(private readonly db: Pool) {}

  static fromConfig(config: ServerConfig): PgCapabilitiesRepository {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new PgCapabilitiesRepository(getDbPool(config.databaseUrl));
  }

  queryable(): Queryable {
    return this.db;
  }

  async listConvertedCapabilityDefinitions(
    identity: SpaceUserIdentity,
  ): Promise<CapabilityDefinition[]> {
    const rows = await this.db.query<CapabilityVersionRow>(
      `SELECT id, capability_key, version, source, status, metadata_json
         FROM capability_versions
        WHERE space_id = $1
          AND source = 'imported_skill'
          AND status <> 'archived'
        ORDER BY capability_key ASC, created_at DESC`,
      [identity.spaceId],
    );
    // Rows are ordered newest-first per capability_key; keep one definition per
    // id so a re-converted skill cannot surface duplicate entries.
    const byId = new Map<string, CapabilityDefinition>();
    for (const row of rows.rows) {
      const definition = objectValue(row.metadata_json).capability_definition;
      if (isCapabilityDefinition(definition) && !byId.has(definition.id)) {
        byId.set(definition.id, definition);
      }
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async listSkillPackages(
    identity: SpaceUserIdentity,
    filters: { limit: number; offset: number },
  ): Promise<Record<string, unknown>> {
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(id)::text AS total
         FROM skill_packages
        WHERE space_id = $1`,
      [identity.spaceId],
    );
    const rows = await this.db.query<SkillPackageRow>(
      `SELECT ${SKILL_PACKAGE_COLUMNS}
         FROM skill_packages
        WHERE space_id = $1
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [identity.spaceId, filters.limit, filters.offset],
    );
    return page(rows.rows.map(skillPackageOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async getSkillPackage(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    db: Queryable = this.db,
  ): Promise<Record<string, unknown> | null> {
    const rows = await db.query<SkillPackageWithSourceRow>(
      `SELECT sp.id, sp.source_id, sp.package_name, sp.version, sp.license,
              sp.raw_storage_ref, sp.manifest_json, sp.normalized_json,
              sp.risk_level, sp.status, sp.created_at, sp.updated_at,
              ss.id AS source_row_id, ss.source_type, ss.url, ss.repo, ss.path,
              ss.ref, ss.commit_sha, ss.content_hash, ss.fetched_at,
              ss.metadata_json AS source_metadata_json, ss.created_at AS source_created_at
         FROM skill_packages sp
         JOIN skill_sources ss ON ss.id = sp.source_id
        WHERE sp.id = $1 AND sp.space_id = $2`,
      [skillPackageId, identity.spaceId],
    );
    const row = rows.rows[0];
    if (!row) return null;
    const pkg = skillPackageOut(row);
    const packageFiles = await listSkillPackageFilesWithDb(db, skillPackageId);
    return {
      ...pkg,
      package_files: packageFiles,
      source: {
        id: row.source_id,
        source_type: row.source_type,
        url: row.url,
        repo: row.repo,
        path: row.path,
        ref: row.ref,
        commit_sha: row.commit_sha,
        content_hash: row.content_hash,
        fetched_at: dateIso(row.fetched_at),
        metadata_json: objectValue(row.source_metadata_json),
      },
    };
  }

  async listSkillLibraryIndex(identity: SpaceUserIdentity): Promise<SkillLibraryIndexResponse> {
    const rows = await this.db.query<SkillPackageRow & { overlay_json: unknown; overlay_id: string | null }>(
      `SELECT ${SKILL_PACKAGE_COLUMNS_SP},
              slo.id AS overlay_id,
              slo.overlay_json
         FROM skill_packages sp
         LEFT JOIN skill_local_overlays slo
           ON slo.skill_package_id = sp.id
          AND slo.space_id = sp.space_id
          AND slo.scope_type = 'space'
          AND slo.scope_id IS NULL
          AND slo.status = 'active'
        WHERE sp.space_id = $1
        ORDER BY sp.updated_at DESC, sp.created_at DESC, sp.id DESC
        LIMIT 200`,
      [identity.spaceId],
    );
    const items = await Promise.all(rows.rows.map(async (row) => {
      const pkg = skillPackageOut(row) as SkillLibraryIndexResponse["items"][number]["skill_package"];
      const overlay = row.overlay_id
        ? await this.getSkillLocalOverlay(identity, row.id, { scope_type: "space", scope_id: null })
        : null;
      const normalized = objectValue(row.normalized_json);
      const overlayConfig: Record<string, unknown> = overlay?.overlay_json ?? {};
      const displayName = optionalString(overlayConfig.display_name) ?? optionalString(normalized.name) ?? pkg.package_name;
      const alias = optionalString(overlayConfig.alias);
      return {
        skill_package: pkg,
        overlay,
        effective_name: displayName,
        effective_alias: alias,
        requested_permissions: Array.isArray(normalized.requested_permissions)
          ? normalized.requested_permissions.filter((item): item is string => typeof item === "string")
          : [],
      };
    }));
    return { items };
  }

  async getSkillLocalOverlay(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    input: { scope_type?: string | null; scope_id?: string | null } = {},
  ): Promise<SkillLocalOverlay | null> {
    await this.requireSkillPackage(identity, skillPackageId);
    const scopeType = ensureOverlayScope(input.scope_type ?? "space");
    const scopeId = normalizeOverlayScopeId(scopeType, input.scope_id ?? null, identity.userId);
    await this.ensureOverlayScopeExists(identity, scopeType, scopeId);
    const row = await this.db.query<SkillLocalOverlayRow>(
      `SELECT ${SKILL_LOCAL_OVERLAY_COLUMNS}
         FROM skill_local_overlays
        WHERE space_id = $1
          AND skill_package_id = $2
          AND scope_type = $3
          AND COALESCE(scope_id, '') = COALESCE($4::varchar, '')
          AND status = 'active'
        LIMIT 1`,
      [identity.spaceId, skillPackageId, scopeType, scopeId],
    );
    return row.rows[0] ? skillLocalOverlayOut(row.rows[0]) : null;
  }

  async upsertSkillLocalOverlay(
    identity: SpaceUserIdentity,
    skillPackageId: string,
    body: {
      scope_type: SkillLocalOverlayScope;
      scope_id?: string | null;
      status: SkillLocalOverlayStatus;
      overlay_json: SkillLocalOverlayConfig;
    },
  ): Promise<SkillLocalOverlay> {
    await this.requireSkillPackage(identity, skillPackageId);
    const scopeType = ensureOverlayScope(body.scope_type);
    const scopeId = normalizeOverlayScopeId(scopeType, body.scope_id ?? null, identity.userId);
    await this.ensureOverlayScopeExists(identity, scopeType, scopeId);
    const status = ensureOverlayStatus(body.status);
    const now = new Date().toISOString();
    if (status === "archived") {
      const archived = await this.db.query<SkillLocalOverlayRow>(
        `UPDATE skill_local_overlays
            SET status = 'archived', updated_at = $5
          WHERE space_id = $1 AND skill_package_id = $2 AND scope_type = $3
            AND COALESCE(scope_id, '') = COALESCE($4::varchar, '')
            AND status = 'active'
          RETURNING ${SKILL_LOCAL_OVERLAY_COLUMNS}`,
        [identity.spaceId, skillPackageId, scopeType, scopeId, now],
      );
      if (!archived.rows[0]) throw new HttpError(404, "Active skill overlay not found");
      return skillLocalOverlayOut(archived.rows[0]);
    }
    const updated = await this.db.query<SkillLocalOverlayRow>(
      `UPDATE skill_local_overlays
          SET overlay_json = $5::jsonb,
              updated_at = $6
        WHERE space_id = $1 AND skill_package_id = $2 AND scope_type = $3
          AND COALESCE(scope_id, '') = COALESCE($4::varchar, '')
          AND status = 'active'
        RETURNING ${SKILL_LOCAL_OVERLAY_COLUMNS}`,
      [identity.spaceId, skillPackageId, scopeType, scopeId, JSON.stringify(body.overlay_json ?? {}), now],
    );
    if (updated.rows[0]) return skillLocalOverlayOut(updated.rows[0]);
    const inserted = await this.db.query<SkillLocalOverlayRow>(
      `INSERT INTO skill_local_overlays (
         id, space_id, skill_package_id, scope_type, scope_id, overlay_json,
         status, created_by_user_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb,
         'active', $7, $8, $8
       )
       RETURNING ${SKILL_LOCAL_OVERLAY_COLUMNS}`,
      [
        randomUUID(),
        identity.spaceId,
        skillPackageId,
        scopeType,
        scopeId,
        JSON.stringify(body.overlay_json ?? {}),
        identity.userId,
        now,
      ],
    );
    return skillLocalOverlayOut(inserted.rows[0]!);
  }

  async saveImportedSkill(
    identity: SpaceUserIdentity,
    preview: SkillImportPreview,
  ): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const sourceId = randomUUID();
    const packageId = randomUUID();
    // Source row + package row are one unit of work: a failed package insert must
    // not leave an orphaned skill_sources row behind.
    return withTransaction(this.db, async (client) => {
      await client.query(
        `INSERT INTO skill_sources (
           id, space_id, source_type, url, repo, path, ref, commit_sha,
           content_hash, fetched_at, created_by_user_id, metadata_json, created_at
         ) VALUES ($1, $2, 'github', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
        [
          sourceId,
          identity.spaceId,
          preview.source.url,
          preview.source.repo,
          preview.source.path,
          preview.source.ref,
          preview.source.commit_sha,
          preview.source.content_hash,
          now,
          identity.userId,
          JSON.stringify(preview.source.metadata_json),
          now,
        ],
      );
      const rows = await client.query<SkillPackageRow>(
        `INSERT INTO skill_packages (
           id, space_id, source_id, package_name, version, license, raw_storage_ref,
           manifest_json, normalized_json, risk_level, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::jsonb, $8::jsonb, $9, 'imported', $10, $10)
         RETURNING ${SKILL_PACKAGE_COLUMNS}`,
        [
          packageId,
          identity.spaceId,
          sourceId,
          preview.normalized_skill.name,
          preview.normalized_skill.version,
          preview.normalized_skill.license,
          JSON.stringify({
            source: preview.source,
            package_root: preview.package_root,
            package_hash: preview.package_hash,
            package_file_count: preview.package_files.length,
            files_detected: preview.files_detected,
            warnings: preview.warnings,
          }),
          JSON.stringify(preview.normalized_skill),
          preview.risk_level,
          now,
        ],
      );
      await insertSkillPackageFiles({
        db: client,
        packageId,
        files: preview.package_files,
        now,
      });
      return {
        ...skillPackageOut(rows.rows[0]!),
        package_files: preview.package_files,
      };
    });
  }

  async createSkillImportApprovalProposal(input: {
    identity: SpaceUserIdentity;
    skillPackageId: string;
  }): Promise<ProposalOut> {
    const packageRecord = await this.getSkillPackage(input.identity, input.skillPackageId);
    if (!packageRecord) throw new HttpError(404, "Skill package not found");
    if (packageRecord.status !== "imported") {
      throw new HttpError(409, "Skill package is not awaiting import review");
    }
    return this.insertProposal(input.identity, {
      proposal_type: "skill_import_approve",
      title: `Review imported skill: ${packageRecord.package_name}`,
      summary: "Approve this imported Open Skill package as reviewed source material.",
      rationale: "External skills are untrusted until explicitly reviewed.",
      risk_level: skillRiskForProposal(packageRecord.risk_level as SkillRiskLevel),
      urgency: "normal",
      payload_json: {
        operation: "skill_import_approve",
        skill_package_id: input.skillPackageId,
        package_name: packageRecord.package_name,
        risk_level: packageRecord.risk_level,
        source_id: packageRecord.source_id,
        package_root: optionalString(objectValue(packageRecord.manifest_json).package_root),
        package_hash: optionalString(objectValue(packageRecord.manifest_json).package_hash),
        file_count: Array.isArray(packageRecord.package_files)
          ? packageRecord.package_files.length
          : undefined,
        package_files: packageFileSummary(packageRecord.package_files),
      },
    });
  }

  async createSkillConversionProposal(input: {
    identity: SpaceUserIdentity;
    skillPackageId: string;
    body: Record<string, unknown>;
  }): Promise<ProposalOut> {
    if (optionalString(input.body.enable_for_project_id)) {
      throw new HttpError(422, "capability_enablement_requires_proposal_review");
    }
    const namespace = optionalString(input.body.namespace) ?? "imported";
    const capabilityIdOverride = optionalString(input.body.capability_id);
    const createRuntimeBindings =
      input.body.create_runtime_bindings === undefined
        ? true
        : input.body.create_runtime_bindings === true;
    const packageRecord = await this.getSkillPackage(input.identity, input.skillPackageId);
    if (!packageRecord) throw new HttpError(404, "Skill package not found");
    if (packageRecord.status !== "reviewed") {
      throw new HttpError(409, "Skill package must be reviewed before conversion");
    }
    const normalized = normalizedFromPackage(packageRecord);
    const capabilityId =
      capabilityIdOverride ?? `${namespace}.${slugify(normalized.name)}`;
    if (getBuiltInCapabilityDefinition(capabilityId)) {
      throw new HttpError(409, "Imported capability id conflicts with a built-in capability");
    }
    return this.insertProposal(input.identity, {
      proposal_type: "capability_install",
      title: `Install capability: ${capabilityId}`,
      summary: "Convert a reviewed Open Skill package into a disabled draft capability.",
      rationale: "Capability installation changes the trusted capability catalog and requires proposal review.",
      risk_level: skillRiskForProposal(packageRecord.risk_level as SkillRiskLevel),
      urgency: packageRecord.risk_level === "critical" ? "critical" : "normal",
      payload_json: {
        operation: "install_from_skill_package",
        skill_package_id: input.skillPackageId,
        capability_id: capabilityId,
        namespace,
        create_runtime_bindings: createRuntimeBindings,
        package_name: packageRecord.package_name,
        risk_level: packageRecord.risk_level,
        package_hash: optionalString(objectValue(packageRecord.manifest_json).package_hash),
      },
    });
  }

  async createCapabilityEnablementProposal(input: {
    identity: SpaceUserIdentity;
    capabilityKey: string;
    enabled: boolean;
    body: Record<string, unknown>;
  }): Promise<ProposalOut> {
    const capabilityKey = input.capabilityKey.trim();
    if (!capabilityKey) throw new HttpError(422, "capability id is required");
    const capabilityVersionId = optionalString(input.body.capability_version_id);
    const scope = parseEnablementScopeInput(input.body);
    if (scope.projectId) await this.requireProject(input.identity.spaceId, scope.projectId);
    const target = await this.resolveCapabilityForEnablement(
      input.identity,
      capabilityKey,
      capabilityVersionId,
    );
    const operation = input.enabled ? "capability_enable" : "capability_disable";
    // Reflect the capability's own scanned risk so a critical capability surfaces
    // a critical enablement proposal. The proposal-type floor (capability_enable
    // defaults to high in the gateway) still forces owner review regardless.
    const riskLevel = target.risk_level ?? (input.enabled ? "high" : "medium");
    return this.insertProposal(input.identity, {
      proposal_type: operation,
      title: `${input.enabled ? "Enable" : "Disable"} capability: ${target.capability_key}`,
      summary: input.enabled
        ? "Enable a reviewed capability for agent runs in this space."
        : "Disable a capability for agent runs in this space.",
      rationale:
        "Capability enablement changes active runtime behavior; an owner must review and decide before runs can render it.",
      risk_level: riskLevel,
      urgency: riskLevel === "critical" ? "critical" : "normal",
      payload_json: {
        operation,
        capability_key: target.capability_key,
        capability_version_id: target.capability_version_id ?? undefined,
        project_id: scope.projectId ?? undefined,
        agent_id: scope.agentId ?? undefined,
        user_id: scope.userId ?? undefined,
        config_json: optionalObject(input.body.config_json) ?? {},
        risk_level: target.risk_level,
      },
      project_id: scope.projectId ?? undefined,
    });
  }

  private async resolveCapabilityForEnablement(
    identity: SpaceUserIdentity,
    capabilityKey: string,
    capabilityVersionId: string | null,
  ): Promise<{
    capability_key: string;
    capability_version_id: string | null;
    risk_level: SkillRiskLevel | null;
  }> {
    if (capabilityVersionId) {
      const rows = await this.db.query<{ capability_key: string; metadata_json: unknown }>(
        `SELECT capability_key, metadata_json
           FROM capability_versions
          WHERE id = $1 AND space_id = $2 AND status <> 'archived'`,
        [capabilityVersionId, identity.spaceId],
      );
      const row = rows.rows[0];
      if (!row) throw new HttpError(404, "Capability version not found");
      if (row.capability_key !== capabilityKey) {
        throw new HttpError(422, "capability_version_id does not match capability id");
      }
      return {
        capability_key: row.capability_key,
        capability_version_id: capabilityVersionId,
        risk_level: capabilityRiskFromMetadata(objectValue(row.metadata_json)),
      };
    }
    const builtIn = getBuiltInCapabilityDefinition(capabilityKey);
    if (builtIn) {
      return {
        capability_key: capabilityKey,
        capability_version_id: null,
        risk_level: riskLevelFromPermissions(objectValue(builtIn.permissions)),
      };
    }
    const rows = await this.db.query<{ id: string; metadata_json: unknown }>(
      `SELECT id, metadata_json
         FROM capability_versions
        WHERE capability_key = $1 AND space_id = $2 AND status <> 'archived'
        ORDER BY created_at DESC
        LIMIT 1`,
      [capabilityKey, identity.spaceId],
    );
    const row = rows.rows[0];
    if (!row) throw new HttpError(404, "Capability definition not found");
    return {
      capability_key: capabilityKey,
      capability_version_id: row.id,
      risk_level: capabilityRiskFromMetadata(objectValue(row.metadata_json)),
    };
  }

  async listWorkflowProfiles(
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ProjectWorkflowProfile[]> {
    await this.requireProject(identity.spaceId, projectId);
    const rows = await this.db.query<WorkflowProfileRow>(
      `SELECT ${WORKFLOW_PROFILE_COLUMNS}
         FROM project_workflow_profiles
        WHERE space_id = $1 AND project_id = $2
        ORDER BY enabled DESC, updated_at DESC, name ASC`,
      [identity.spaceId, projectId],
    );
    return rows.rows.map(workflowProfileOut);
  }

  async requireWorkflowProject(identity: SpaceUserIdentity, projectId: string): Promise<void> {
    await this.requireProject(identity.spaceId, projectId);
  }

  async getWorkflowProfile(
    identity: SpaceUserIdentity,
    projectId: string,
    profileId: string,
  ): Promise<ProjectWorkflowProfile | null> {
    await this.requireProject(identity.spaceId, projectId);
    const row = await this.getWorkflowProfileRow(identity.spaceId, projectId, profileId);
    return row ? workflowProfileOut(row) : null;
  }

  async createWorkflowProfile(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<ProjectWorkflowProfile> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();
    const rows = await this.db.query<WorkflowProfileRow>(
      `INSERT INTO project_workflow_profiles (
         id, space_id, project_id, workflow_template_id, name, enabled,
         config_json, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)
       RETURNING ${WORKFLOW_PROFILE_COLUMNS}`,
      [
        randomUUID(),
        identity.spaceId,
        projectId,
        requiredString(body.workflow_template_id, "workflow_template_id"),
        requiredString(body.name, "name"),
        body.enabled === undefined ? true : body.enabled === true,
        JSON.stringify(optionalObject(body.config_json) ?? {}),
        identity.userId,
        now,
      ],
    );
    return workflowProfileOut(rows.rows[0]!);
  }

  async updateWorkflowProfile(
    identity: SpaceUserIdentity,
    projectId: string,
    profileId: string,
    body: Record<string, unknown>,
  ): Promise<ProjectWorkflowProfile> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const current = await this.getWorkflowProfileRow(identity.spaceId, projectId, profileId);
    if (!current) throw new HttpError(404, "Workflow profile not found");
    const now = new Date().toISOString();
    const rows = await this.db.query<WorkflowProfileRow>(
      `UPDATE project_workflow_profiles
          SET name = $4,
              enabled = $5,
              config_json = $6::jsonb,
              updated_at = $7
        WHERE space_id = $1 AND project_id = $2 AND id = $3
        RETURNING ${WORKFLOW_PROFILE_COLUMNS}`,
      [
        identity.spaceId,
        projectId,
        profileId,
        optionalString(body.name) ?? current.name,
        typeof body.enabled === "boolean" ? body.enabled : current.enabled,
        JSON.stringify(optionalObject(body.config_json) ?? objectValue(current.config_json)),
        now,
      ],
    );
    return workflowProfileOut(rows.rows[0]!);
  }

  async disableWorkflowProfile(
    identity: SpaceUserIdentity,
    projectId: string,
    profileId: string,
  ): Promise<ProjectWorkflowProfile> {
    return this.updateWorkflowProfile(identity, projectId, profileId, { enabled: false });
  }

  private async insertProposal(
    identity: SpaceUserIdentity,
    input: {
      proposal_type: string;
      title: string;
      summary: string;
      rationale: string;
      risk_level: "low" | "medium" | "high" | "critical";
      urgency: "low" | "normal" | "high" | "critical";
      payload_json: Record<string, unknown>;
      project_id?: string | null;
    },
  ): Promise<ProposalOut> {
    const now = new Date();
    const row = await insertProposalRow(this.db, {
      spaceId: identity.spaceId,
      proposalType: input.proposal_type,
      title: input.title,
      summary: input.summary,
      payload: input.payload_json,
      rationale: input.rationale,
      riskLevel: input.risk_level,
      urgency: input.urgency,
      projectId: input.project_id ?? null,
      createdByUserId: identity.userId,
      visibility: "space_shared",
      requiredApproverRole: "owner",
    });
    return proposalToOut(row, now);
  }

  private async requireProject(spaceId: string, projectId: string): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM projects WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [spaceId, projectId],
    );
    if (!rows.rows[0]) throw new HttpError(404, "Project not found");
  }

  private async requireSkillPackage(identity: SpaceUserIdentity, skillPackageId: string): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM skill_packages WHERE id = $1 AND space_id = $2 LIMIT 1`,
      [skillPackageId, identity.spaceId],
    );
    if (!rows.rows[0]) throw new HttpError(404, "Skill package not found");
  }

  private async ensureOverlayScopeExists(
    identity: SpaceUserIdentity,
    scopeType: SkillLocalOverlayScope,
    scopeId: string | null,
  ): Promise<void> {
    if (scopeType === "space") return;
    if (!scopeId) throw new HttpError(422, "scope_id is required for this scope_type");
    if (scopeType === "user") {
      if (scopeId !== identity.userId) throw new HttpError(403, "skill overlay user scope must be the current user");
      return;
    }
    const table =
      scopeType === "project_folder"
        ? "project_folders"
        : scopeType === "project"
          ? "projects"
          : scopeType === "agent"
            ? "agents"
            : null;
    if (!table) throw new HttpError(422, "unsupported scope_type");
    const found = await this.db.query<{ id: string }>(
      `SELECT id FROM ${table}
        WHERE id = $1 AND space_id = $2
        LIMIT 1`,
      [scopeId, identity.spaceId],
    );
    if (!found.rows[0]) throw new HttpError(404, `${scopeType} not found`);
  }

  private async getWorkflowProfileRow(
    spaceId: string,
    projectId: string,
    profileId: string,
  ): Promise<WorkflowProfileRow | null> {
    const rows = await this.db.query<WorkflowProfileRow>(
      `SELECT ${WORKFLOW_PROFILE_COLUMNS}
         FROM project_workflow_profiles
        WHERE space_id = $1 AND project_id = $2 AND id = $3`,
      [spaceId, projectId, profileId],
    );
    return rows.rows[0] ?? null;
  }
}

export interface SkillConversionApplyResult {
  skill_package: SkillPackage;
  capability_definition: CapabilityDefinition;
  capability_version_id: string;
  runtime_bindings: CapabilityRuntimeBinding[];
  enabled: boolean;
  warnings: string[];
}

export async function approveSkillImportInTransaction(input: {
  db: Queryable;
  spaceId: string;
  userId: string;
  proposalId: string;
  skillPackageId: string;
}): Promise<SkillPackage> {
  const now = new Date().toISOString();
  const rows = await input.db.query<SkillPackageRow>(
    `UPDATE skill_packages
        SET status = 'reviewed',
            manifest_json = manifest_json || $5::jsonb,
            updated_at = $4
      WHERE id = $1
        AND space_id = $2
        AND status = 'imported'
      RETURNING ${SKILL_PACKAGE_COLUMNS}`,
    [
      input.skillPackageId,
      input.spaceId,
      input.userId,
      now,
      JSON.stringify({
        review: {
          reviewed_by_user_id: input.userId,
          reviewed_from_proposal_id: input.proposalId,
          reviewed_at: now,
        },
      }),
    ],
  );
  const row = rows.rows[0];
  if (!row) throw new HttpError(409, "Skill package is not awaiting import review");
  return skillPackageOut(row) as unknown as SkillPackage;
}

export async function convertSkillPackageToCapabilityInTransaction(input: {
  db: Queryable;
  identity: SpaceUserIdentity;
  skillPackageId: string;
  body: Record<string, unknown>;
  proposalId?: string | null;
}): Promise<SkillConversionApplyResult> {
  if (optionalString(input.body.enable_for_project_id)) {
    throw new HttpError(422, "capability_enablement_requires_proposal_review");
  }
  const namespace = optionalString(input.body.namespace) ?? "imported";
  const capabilityIdOverride = optionalString(input.body.capability_id);
  const createRuntimeBindings =
    input.body.create_runtime_bindings === undefined
      ? true
      : input.body.create_runtime_bindings === true;
  const packageRecord = await getSkillPackageForUpdate(
    input.db,
    input.identity,
    input.skillPackageId,
  );
  if (!packageRecord) throw new HttpError(404, "Skill package not found");
  if (packageRecord.status !== "reviewed") {
    throw new HttpError(409, "Skill package must be reviewed before conversion");
  }
  const normalized = normalizedFromPackage(packageRecord);
  const riskLevel = packageRecord.risk_level as SkillRiskLevel;
  const capabilityId =
    capabilityIdOverride ?? `${namespace}.${slugify(normalized.name)}`;
  if (getBuiltInCapabilityDefinition(capabilityId)) {
    throw new HttpError(409, "Imported capability id conflicts with a built-in capability");
  }
  const definition = capabilityDefinitionFromNormalized({
    capabilityId,
    namespace,
    normalized,
    riskLevel,
  });
  const now = new Date().toISOString();
  const versionId = randomUUID();
  await input.db.query(
    `INSERT INTO capability_versions (
       id, capability_key, space_id, parent_version_id, version,
       source, artifact_uri, content_ref, content_hash, status, proposal_id,
       metadata_json, created_at, updated_at
     ) VALUES ($1, $2, $3, NULL, $4, 'imported_skill', NULL, $5, $6,
               'draft', $7, $8::jsonb, $9, $9)`,
    [
      versionId,
      capabilityId,
      input.identity.spaceId,
      definition.version,
      input.skillPackageId,
      packageRecord.source && typeof packageRecord.source === "object"
        ? optionalString((packageRecord.source as Record<string, unknown>).content_hash)
        : null,
      input.proposalId ?? null,
      JSON.stringify({
        capability_definition: definition,
        skill_package_id: input.skillPackageId,
        normalized_skill: normalized,
        created_from_proposal_id: input.proposalId ?? null,
      }),
      now,
    ],
  );

  const runtimeBindings = createRuntimeBindings
    ? await insertRuntimeBindingsWithDb({
        spaceId: input.identity.spaceId,
        capabilityId,
        capabilityVersionId: versionId,
        now,
        db: input.db,
      })
    : [];

  const updated = await input.db.query<SkillPackageRow>(
    `UPDATE skill_packages
        SET status = 'converted',
            manifest_json = manifest_json || $4::jsonb,
            updated_at = $3
      WHERE id = $1 AND space_id = $2
      RETURNING ${SKILL_PACKAGE_COLUMNS}`,
    [
      input.skillPackageId,
      input.identity.spaceId,
      now,
      JSON.stringify({
        conversion: {
          capability_key: capabilityId,
          capability_version_id: versionId,
          converted_from_proposal_id: input.proposalId ?? null,
          converted_at: now,
        },
      }),
    ],
  );

  return {
    skill_package: skillPackageOut(updated.rows[0]!) as unknown as SkillPackage,
    capability_definition: definition,
    capability_version_id: versionId,
    runtime_bindings: runtimeBindings,
    enabled: false,
    warnings: ["converted_capability_is_disabled_by_default"],
  };
}

async function getSkillPackageForUpdate(
  db: Queryable,
  identity: SpaceUserIdentity,
  skillPackageId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.query<SkillPackageWithSourceRow>(
    `SELECT sp.id, sp.source_id, sp.package_name, sp.version, sp.license,
            sp.raw_storage_ref, sp.manifest_json, sp.normalized_json,
            sp.risk_level, sp.status, sp.created_at, sp.updated_at,
            ss.id AS source_row_id, ss.source_type, ss.url, ss.repo, ss.path,
            ss.ref, ss.commit_sha, ss.content_hash, ss.fetched_at,
            ss.metadata_json AS source_metadata_json
       FROM skill_packages sp
       JOIN skill_sources ss ON ss.id = sp.source_id
      WHERE sp.id = $1 AND sp.space_id = $2
      FOR UPDATE OF sp`,
    [skillPackageId, identity.spaceId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    ...skillPackageOut(row),
    source: {
      id: row.source_id,
      source_type: row.source_type,
      url: row.url,
      repo: row.repo,
      path: row.path,
      ref: row.ref,
      commit_sha: row.commit_sha,
      content_hash: row.content_hash,
      fetched_at: dateIso(row.fetched_at),
      metadata_json: objectValue(row.source_metadata_json),
    },
  };
}

async function insertRuntimeBindingsWithDb(input: {
  spaceId: string;
  capabilityId: string;
  capabilityVersionId: string;
  now: string;
  db: Queryable;
}): Promise<CapabilityRuntimeBinding[]> {
  const specs: Array<Pick<CapabilityRuntimeBinding, "runtime_adapter_type" | "render_mode" | "binding_json">> = [
    { runtime_adapter_type: "model_api", render_mode: "inline_prompt", binding_json: {} },
    { runtime_adapter_type: "claude_code", render_mode: "render_skill", binding_json: {} },
    { runtime_adapter_type: "codex_cli", render_mode: "render_skill", binding_json: {} },
  ];
  const bindings: CapabilityRuntimeBinding[] = [];
  for (const spec of specs) {
    await input.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `runtime-skill-authority:${input.spaceId}:${input.capabilityId}`,
    ]);
    const id = randomUUID();
    await input.db.query(
      `INSERT INTO capability_runtime_bindings (
         id, space_id, capability_key, capability_version_id,
         runtime_adapter_type, render_mode, binding_json, enabled, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, $8, $8)`,
      [
        id,
        input.spaceId,
        input.capabilityId,
        input.capabilityVersionId,
        spec.runtime_adapter_type,
        spec.render_mode,
        JSON.stringify(spec.binding_json),
        input.now,
      ],
    );
    bindings.push({
      id,
      capability_id: input.capabilityId,
      runtime_adapter_type: spec.runtime_adapter_type,
      render_mode: spec.render_mode,
      binding_json: spec.binding_json,
      enabled: false,
    });
  }
  return bindings;
}

function isSkillRiskLevel(value: string | null | undefined): value is SkillRiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function riskLevelFromPermissions(permissions: Record<string, unknown>): SkillRiskLevel | null {
  const risk = optionalString(permissions.risk_level);
  return isSkillRiskLevel(risk) ? risk : null;
}

function capabilityRiskFromMetadata(metadata: Record<string, unknown>): SkillRiskLevel | null {
  return riskLevelFromPermissions(objectValue(objectValue(metadata.capability_definition).permissions));
}

function parseEnablementScopeInput(body: Record<string, unknown>): {
  projectId: string | null;
  agentId: string | null;
  userId: string | null;
} {
  const scope = {
    projectId: optionalString(body.project_id),
    agentId: optionalString(body.agent_id),
    userId: optionalString(body.user_id),
  };
  if ([scope.projectId, scope.agentId, scope.userId].filter(Boolean).length > 1) {
    throw new HttpError(
      422,
      "capability enablement scope must include at most one project_id, agent_id, or user_id",
    );
  }
  return scope;
}

function skillRiskForProposal(riskLevel: SkillRiskLevel): "low" | "medium" | "high" | "critical" {
  if (riskLevel === "critical") return "critical";
  if (riskLevel === "high") return "high";
  // Reviewing/importing external source material should still be explicit even
  // when the deterministic scanner calls the source low or medium risk.
  return "medium";
}

async function insertSkillPackageFiles(input: {
  db: Queryable;
  packageId: string;
  files: SkillPackageFilePreview[];
  now: string;
}): Promise<void> {
  for (const file of input.files) {
    await input.db.query(
      `INSERT INTO skill_package_files (
         id, skill_package_id, path, kind, content_hash, content_type,
         byte_length, storage_ref, included, executable, risk_flags_json,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, NULL, $8, $9, $10::jsonb,
         $11
       )`,
      [
        randomUUID(),
        input.packageId,
        file.path,
        file.kind,
        file.content_hash ?? null,
        file.content_type ?? null,
        file.byte_length ?? null,
        file.included,
        file.executable,
        JSON.stringify(file.risk_flags_json ?? {}),
        input.now,
      ],
    );
  }
}

async function listSkillPackageFilesWithDb(
  db: Queryable,
  skillPackageId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db.query<SkillPackageFileRow>(
    `SELECT ${SKILL_PACKAGE_FILE_COLUMNS}
       FROM skill_package_files
      WHERE skill_package_id = $1
      ORDER BY path ASC, id ASC`,
    [skillPackageId],
  );
  return rows.rows.map(skillPackageFileOut);
}

function skillPackageFileOut(row: SkillPackageFileRow): Record<string, unknown> {
  return {
    id: row.id,
    skill_package_id: row.skill_package_id,
    path: row.path,
    kind: row.kind,
    content_hash: row.content_hash,
    content_type: row.content_type,
    byte_length: row.byte_length,
    storage_ref: row.storage_ref,
    included: row.included,
    executable: row.executable,
    risk_flags_json: objectValue(row.risk_flags_json),
    created_at: dateIso(row.created_at),
  };
}

function prefixedColumns(columns: string, tableAlias: string): string {
  return columns
    .split(",")
    .map((column) => `${tableAlias}.${column.trim()}`)
    .join(", ");
}

function packageFileSummary(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .slice(0, 50)
    .map((item) => ({
      path: optionalString(item.path),
      kind: optionalString(item.kind),
      byte_length: typeof item.byte_length === "number" ? item.byte_length : null,
      included: item.included === true,
      executable: item.executable === true,
      risk_flags_json: objectValue(item.risk_flags_json),
    }));
}

function skillPackageOut(row: SkillPackageRow): Record<string, unknown> {
  return {
    id: row.id,
    source_id: row.source_id,
    package_name: row.package_name,
    version: row.version,
    license: row.license,
    raw_storage_ref: row.raw_storage_ref,
    manifest_json: objectValue(row.manifest_json),
    normalized_json: objectValue(row.normalized_json),
    risk_level: row.risk_level,
    status: row.status,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

function skillLocalOverlayOut(row: SkillLocalOverlayRow): SkillLocalOverlay {
  return {
    id: row.id,
    space_id: row.space_id,
    skill_package_id: row.skill_package_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    overlay_json: objectValue(row.overlay_json) as SkillLocalOverlayConfig,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? "",
    updated_at: dateIso(row.updated_at) ?? "",
  };
}

function ensureOverlayScope(value: string): SkillLocalOverlayScope {
  if (["space", "project", "project_folder", "agent", "user"].includes(value)) {
    return value as SkillLocalOverlayScope;
  }
  throw new HttpError(422, "scope_type must be one of space, project, project_folder, agent, user");
}

function ensureOverlayStatus(value: string): SkillLocalOverlayStatus {
  if (value === "active" || value === "archived") return value;
  throw new HttpError(422, "status must be active or archived");
}

function normalizeOverlayScopeId(
  scopeType: SkillLocalOverlayScope,
  scopeId: string | null,
  userId: string,
): string | null {
  if (scopeType === "space") {
    if (scopeId) throw new HttpError(422, "space skill overlay must not include scope_id");
    return null;
  }
  if (scopeType === "user" && !scopeId) return userId;
  if (!scopeId) throw new HttpError(422, "scope_id is required for this scope_type");
  return scopeId;
}

function workflowProfileOut(row: WorkflowProfileRow): ProjectWorkflowProfile {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    workflow_template_id: row.workflow_template_id,
    name: row.name,
    enabled: row.enabled,
    config_json: objectValue(row.config_json),
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? "",
    updated_at: dateIso(row.updated_at) ?? "",
  };
}

function normalizedFromPackage(record: Record<string, unknown>): NormalizedSkill {
  const normalized = objectValue(record.normalized_json);
  const name = requiredString(normalized.name, "normalized_skill.name");
  const description = requiredString(normalized.description, "normalized_skill.description");
  return {
    name,
    description,
    version: optionalString(normalized.version) ?? "0.1.0",
    license: optionalString(normalized.license),
    instructions_markdown: optionalString(normalized.instructions_markdown) ?? "",
    resources: Array.isArray(normalized.resources)
      ? normalized.resources.filter((item): item is NormalizedSkill["resources"][number] =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
      : [],
    requested_permissions: Array.isArray(normalized.requested_permissions)
      ? normalized.requested_permissions.filter((item): item is string => typeof item === "string")
      : [],
    execution_profile: objectValue(normalized.execution_profile),
    vendor_extensions: objectValue(normalized.vendor_extensions),
    trust_analysis: objectValue(normalized.trust_analysis),
  };
}

function capabilityDefinitionFromNormalized(input: {
  capabilityId: string;
  namespace: string;
  normalized: NormalizedSkill;
  riskLevel: SkillRiskLevel;
}): CapabilityDefinition {
  return {
    id: input.capabilityId,
    namespace: input.namespace,
    name: input.normalized.name,
    description: input.normalized.description,
    version: input.normalized.version,
    source_kind: "imported_skill",
    input_schema_json: { type: "object", additionalProperties: true },
    output_artifact_types: ["imported_skill.output.v1"],
    permissions: {
      requested_permissions: input.normalized.requested_permissions,
      risk_level: input.riskLevel,
      memory_writes: "proposal_only",
    },
    supported_execution_modes: ["runtime_rendered"],
    default_runtime_bindings: [
      {
        id: `${input.capabilityId}:model_api:inline_prompt`,
        capability_id: input.capabilityId,
        runtime_adapter_type: "model_api",
        render_mode: "inline_prompt",
        binding_json: {},
        enabled: false,
      },
      {
        id: `${input.capabilityId}:claude_code:render_skill`,
        capability_id: input.capabilityId,
        runtime_adapter_type: "claude_code",
        render_mode: "render_skill",
        binding_json: {},
        enabled: false,
      },
      {
        id: `${input.capabilityId}:codex_cli:render_skill`,
        capability_id: input.capabilityId,
        runtime_adapter_type: "codex_cli",
        render_mode: "render_skill",
        binding_json: {},
        enabled: false,
      },
    ],
    status: "draft",
  };
}

function isCapabilityDefinition(value: unknown): value is CapabilityDefinition {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as CapabilityDefinition).id === "string" &&
      typeof (value as CapabilityDefinition).name === "string",
  );
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "skill";
}
