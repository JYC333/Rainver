import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type { Pool } from "../../db/pool.js";
import type {
  RuntimeContextPolicyResolveRequest,
  RuntimeContextPolicyScope,
  RuntimeContextPolicyVersion,
  RuntimeContextPolicyWriteRequest,
  RuntimeContextResolvedPolicy,
} from "@rainver/protocol";
import { withTransaction } from "../../db/tx.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { canReadProject } from "../projects/access.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import {
  assertPolicyDoesNotWiden,
  assertPolicyPreferencesWithinConstraints,
  policyTypedDiff,
  resolveRuntimeContextPolicies,
} from "./runtimeContextPolicyResolver.js";

export interface RuntimeContextPolicyIdentity {
  spaceId: string;
  userId: string;
}

interface VersionRow {
  id: string;
  space_id: string;
  scope_type: string;
  scope_id: string;
  version: number;
  policy_json: unknown;
  base_version_id: string | null;
  typed_diff_json: unknown;
  reason: string;
  created_by_user_id: string;
  created_at: string | Date;
}

interface ScopeRef {
  scopeType: RuntimeContextPolicyScope;
  scopeId: string;
}

export interface RuntimeContextPolicyExecutionInput {
  spaceId: string;
  projectId?: string | null;
  projectFolderId?: string | null;
  agentId?: string | null;
  userId?: string | null;
}

export class RuntimeContextPolicyRepository {
  constructor(private readonly pool: Pool) {}

  async getActive(
    identity: RuntimeContextPolicyIdentity,
    scopeType: RuntimeContextPolicyScope,
    scopeId: string,
  ): Promise<RuntimeContextPolicyVersion | null> {
    await assertScopeReadable(this.pool, identity, scopeType, scopeId);
    return loadActiveVersion(this.pool, identity.spaceId, { scopeType, scopeId });
  }

  async listVersions(
    identity: RuntimeContextPolicyIdentity,
    scopeType: RuntimeContextPolicyScope,
    scopeId: string,
  ): Promise<RuntimeContextPolicyVersion[]> {
    await assertScopeReadable(this.pool, identity, scopeType, scopeId);
    const result = await this.pool.query<VersionRow>(
      `SELECT id, space_id, scope_type, scope_id, version, policy_json,
              base_version_id, typed_diff_json, reason, created_by_user_id, created_at
         FROM runtime_context_policy_versions
        WHERE space_id = $1 AND scope_type = $2 AND scope_id = $3
        ORDER BY version DESC`,
      [identity.spaceId, scopeType, scopeId],
    );
    return result.rows.map(versionOut);
  }

  async resolve(
    identity: RuntimeContextPolicyIdentity,
    input: RuntimeContextPolicyResolveRequest,
  ): Promise<RuntimeContextResolvedPolicy> {
    const scopes = await resolutionScopes(this.pool, identity, input);
    const versions: RuntimeContextPolicyVersion[] = [];
    for (const scope of scopes) {
      const version = await loadActiveVersion(this.pool, identity.spaceId, scope);
      if (version) versions.push(version);
    }
    return resolveRuntimeContextPolicies(versions);
  }

  async resolveForExecution(input: RuntimeContextPolicyExecutionInput): Promise<RuntimeContextResolvedPolicy> {
    return resolveRuntimeContextPolicyForExecution(this.pool, input);
  }

  async write(
    identity: RuntimeContextPolicyIdentity,
    scopeType: RuntimeContextPolicyScope,
    scopeId: string,
    request: RuntimeContextPolicyWriteRequest,
  ): Promise<RuntimeContextPolicyVersion> {
    const policy = protocol.RuntimeContextPolicyDocumentSchema.parse(request.policy);
    if (scopeType === "user" && Object.keys(policy.constraints).length > 0) {
      throw new HttpError(422, "User Runtime Context Policy may contain preferences only");
    }
    return withTransaction(this.pool, async (client) => {
      await assertScopeMutable(client, identity, scopeType, scopeId);
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`runtime-context-policy:${identity.spaceId}:${scopeType}:${scopeId}`],
      );
      const binding = await client.query<{ active_version_id: string }>(
        `SELECT active_version_id
           FROM runtime_context_policy_bindings
          WHERE space_id = $1 AND scope_type = $2 AND scope_id = $3
          FOR UPDATE`,
        [identity.spaceId, scopeType, scopeId],
      );
      const activeVersionId = binding.rows[0]?.active_version_id ?? null;
      if (activeVersionId !== request.base_version_id) {
        throw new HttpError(409, "Runtime Context Policy base version is stale");
      }
      const previous = activeVersionId
        ? await loadVersionById(client, identity.spaceId, activeVersionId)
        : null;
      const parents = await parentScopes(client, identity, scopeType, scopeId);
      const parentVersions: RuntimeContextPolicyVersion[] = [];
      for (const parent of parents) {
        const version = await loadActiveVersion(client, identity.spaceId, parent);
        if (version) parentVersions.push(version);
      }
      if (parentVersions.length > 0) {
        assertPolicyDoesNotWiden(resolveRuntimeContextPolicies(parentVersions).policy, policy);
      }
      assertPolicyPreferencesWithinConstraints(resolveRuntimeContextPolicies([
        ...parentVersions,
        {
          id: "candidate",
          space_id: identity.spaceId,
          scope_type: scopeType,
          scope_id: scopeId,
          version: (previous?.version ?? 0) + 1,
          policy,
          base_version_id: activeVersionId,
          typed_diff: {},
          reason: request.reason,
          created_by_user_id: identity.userId,
          created_at: new Date().toISOString(),
        },
      ], { preferenceConflicts: "reject" }).policy);

      const nextNumber = (previous?.version ?? 0) + 1;
      const versionId = randomUUID();
      const auditId = randomUUID();
      const policyDecisionRecordId = randomUUID();
      const createdAt = new Date().toISOString();
      const typedDiff = policyTypedDiff(previous?.policy ?? null, policy);
      await insertMutationDecision(client, {
        id: policyDecisionRecordId,
        identity,
        scopeType,
        scopeId,
        createdAt,
      });
      await client.query(
        `INSERT INTO runtime_context_policy_versions (
           id, space_id, scope_type, scope_id, version, policy_json,
           base_version_id, typed_diff_json, reason, created_by_user_id, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11)`,
        [versionId, identity.spaceId, scopeType, scopeId, nextNumber, JSON.stringify(policy),
          activeVersionId, JSON.stringify(typedDiff), request.reason, identity.userId, createdAt],
      );
      await client.query(
        `INSERT INTO runtime_context_policy_bindings (
           space_id, scope_type, scope_id, active_version_id, updated_by_user_id, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (space_id, scope_type, scope_id) DO UPDATE SET
           active_version_id = EXCLUDED.active_version_id,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = EXCLUDED.updated_at`,
        [identity.spaceId, scopeType, scopeId, versionId, identity.userId, createdAt],
      );
      await client.query(
        `INSERT INTO runtime_context_policy_audits (
         id, space_id, scope_type, scope_id, actor_user_id, base_version_id,
           new_version_id, policy_decision_record_id, typed_diff_json, reason, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [auditId, identity.spaceId, scopeType, scopeId, identity.userId, activeVersionId,
          versionId, policyDecisionRecordId, JSON.stringify(typedDiff), request.reason, createdAt],
      );
      return protocol.RuntimeContextPolicyVersionSchema.parse({
        id: versionId,
        space_id: identity.spaceId,
        scope_type: scopeType,
        scope_id: scopeId,
        version: nextNumber,
        policy,
        base_version_id: activeVersionId,
        typed_diff: typedDiff,
        reason: request.reason,
        created_by_user_id: identity.userId,
        created_at: createdAt,
      });
    });
  }
}

export async function resolveRuntimeContextPolicyForExecution(
  db: Queryable,
  input: RuntimeContextPolicyExecutionInput,
): Promise<RuntimeContextResolvedPolicy> {
  const scopes: ScopeRef[] = [{ scopeType: "space", scopeId: input.spaceId }];
  let projectId = input.projectId ?? null;
  if (input.projectFolderId) {
    const folderProjectId = await folderProject(db, input.spaceId, input.projectFolderId);
    if (!folderProjectId) throw new HttpError(404, "Project Folder not found");
    if (projectId && projectId !== folderProjectId) throw new HttpError(422, "Project Folder scope mismatch");
    projectId = folderProjectId;
  }
  if (input.agentId) {
    const agent = await agentRecord(db, input.spaceId, input.agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    if (projectId && agent.project_id && projectId !== agent.project_id) {
      throw new HttpError(422, "Agent Project scope mismatch");
    }
    projectId ??= agent.project_id;
  }
  if (projectId) scopes.push({ scopeType: "project", scopeId: projectId });
  if (input.projectFolderId) scopes.push({ scopeType: "project_folder", scopeId: input.projectFolderId });
  if (input.agentId) scopes.push({ scopeType: "agent", scopeId: input.agentId });
  if (input.userId) scopes.push({ scopeType: "user", scopeId: input.userId });
  const versions: RuntimeContextPolicyVersion[] = [];
  for (const scope of scopes) {
    const version = await loadActiveVersion(db, input.spaceId, scope);
    if (version) versions.push(version);
  }
  return resolveRuntimeContextPolicies(versions);
}

async function resolutionScopes(
  db: Queryable,
  identity: RuntimeContextPolicyIdentity,
  input: RuntimeContextPolicyResolveRequest,
): Promise<ScopeRef[]> {
  const role = await assertSpaceMember(db, identity);
  const scopes: ScopeRef[] = [{ scopeType: "space", scopeId: identity.spaceId }];
  let projectId = input.project_id ?? null;
  if (input.project_folder_id) {
    const folder = await folderProject(db, identity.spaceId, input.project_folder_id);
    if (!folder) throw new HttpError(404, "Project Folder not found");
    if (projectId && folder !== projectId) throw new HttpError(422, "Project Folder scope mismatch");
    projectId = folder;
  }
  if (input.agent_id) {
    const agent = await agentRecord(db, identity.spaceId, input.agent_id);
    if (!agent) throw new HttpError(404, "Agent not found");
    if (projectId && agent.project_id && agent.project_id !== projectId) throw new HttpError(422, "Agent Project scope mismatch");
    projectId ??= agent.project_id;
  }
  if (projectId) {
    const readable = isSpaceOwnerOrAdmin(role)
      ? await projectExists(db, identity.spaceId, projectId)
      : await canReadProject(db, identity.spaceId, projectId, identity.userId);
    if (!readable) {
      throw new HttpError(404, "Project not found");
    }
    scopes.push({ scopeType: "project", scopeId: projectId });
  }
  if (input.project_folder_id) {
    scopes.push({ scopeType: "project_folder", scopeId: input.project_folder_id });
  }
  if (input.agent_id) {
    await assertScopeReadable(db, identity, "agent", input.agent_id);
    scopes.push({ scopeType: "agent", scopeId: input.agent_id });
  }
  if (input.include_user_policy) scopes.push({ scopeType: "user", scopeId: identity.userId });
  return scopes;
}

async function parentScopes(
  db: Queryable,
  identity: RuntimeContextPolicyIdentity,
  scopeType: RuntimeContextPolicyScope,
  scopeId: string,
): Promise<ScopeRef[]> {
  if (scopeType === "space") return [];
  const parents: ScopeRef[] = [{ scopeType: "space", scopeId: identity.spaceId }];
  if (scopeType === "project_folder") {
    const projectId = await folderProject(db, identity.spaceId, scopeId);
    if (!projectId) throw new HttpError(404, "Project Folder not found");
    parents.push({ scopeType: "project", scopeId: projectId });
  } else if (scopeType === "agent") {
    const agent = await agentRecord(db, identity.spaceId, scopeId);
    if (!agent) throw new HttpError(404, "Agent not found");
    if (agent.project_id) parents.push({ scopeType: "project", scopeId: agent.project_id });
  }
  return parents;
}

async function assertScopeReadable(
  db: Queryable,
  identity: RuntimeContextPolicyIdentity,
  scopeType: RuntimeContextPolicyScope,
  scopeId: string,
): Promise<void> {
  const role = await assertSpaceMember(db, identity);
  if (scopeType === "space") {
    if (scopeId !== identity.spaceId) throw new HttpError(404, "Runtime Context Policy not found");
    return;
  }
  if (scopeType === "user") {
    if (scopeId !== identity.userId) throw new HttpError(404, "Runtime Context Policy not found");
    return;
  }
  if (isSpaceOwnerOrAdmin(role)) {
    await assertScopeExists(db, identity.spaceId, scopeType, scopeId);
    return;
  }
  if (scopeType === "project") {
    if (!(await canReadProject(db, identity.spaceId, scopeId, identity.userId))) throw new HttpError(404, "Project not found");
    return;
  }
  if (scopeType === "project_folder") {
    const projectId = await folderProject(db, identity.spaceId, scopeId);
    if (!projectId || !(await canReadProject(db, identity.spaceId, projectId, identity.userId))) {
      throw new HttpError(404, "Project Folder not found");
    }
    return;
  }
  const agent = await agentRecord(db, identity.spaceId, scopeId);
  if (!agent) throw new HttpError(404, "Agent not found");
  if (agent.project_id && await isProjectOwner(db, identity, agent.project_id)) return;
  const visible = await db.query(
    `SELECT 1
       FROM agents a
      WHERE a.id = $1 AND a.space_id = $2 AND a.status <> 'archived'
        AND ${contentReadSql("agent", "a", "$3")}
      LIMIT 1`,
    [scopeId, identity.spaceId, identity.userId],
  );
  if (visible.rows.length === 0) throw new HttpError(404, "Agent not found");
}

async function insertMutationDecision(
  db: Queryable,
  input: {
    id: string;
    identity: RuntimeContextPolicyIdentity;
    scopeType: RuntimeContextPolicyScope;
    scopeId: string;
    createdAt: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO policy_decision_records (
       id, space_id, actor_type, actor_id, action, resource_type, resource_id,
       decision, risk_level, policy_rule_id, policy_source, metadata_json, created_at
     ) VALUES ($1,$2,'user',$3,'runtime_context_policy.change',
       'runtime_context_policy',$4,'allow','high','runtime_context_scope_authority',
       'runtime_context_acl',$5::jsonb,$6)`,
    [
      input.id,
      input.identity.spaceId,
      input.identity.userId,
      `${input.scopeType}:${input.scopeId}`,
      JSON.stringify({ scope_type: input.scopeType, scope_id: input.scopeId }),
      input.createdAt,
    ],
  );
}

async function assertScopeMutable(
  db: Queryable,
  identity: RuntimeContextPolicyIdentity,
  scopeType: RuntimeContextPolicyScope,
  scopeId: string,
): Promise<void> {
  const role = await assertSpaceMember(db, identity, true);
  if (scopeType === "space") {
    if (scopeId !== identity.spaceId) throw new HttpError(404, "Space not found");
    if (!isSpaceOwnerOrAdmin(role)) throw new HttpError(403, "Requires Space owner/admin role");
    return;
  }
  if (scopeType === "user") {
    if (scopeId !== identity.userId) throw new HttpError(403, "User policy belongs to the current user only");
    return;
  }
  if (isSpaceOwnerOrAdmin(role)) {
    await assertScopeExists(db, identity.spaceId, scopeType, scopeId);
    return;
  }
  if (scopeType === "project") {
    if (!(await isProjectOwner(db, identity, scopeId, true))) throw new HttpError(403, "Requires Project owner role");
    return;
  }
  if (scopeType === "project_folder") {
    const projectId = await folderProject(db, identity.spaceId, scopeId);
    if (!projectId) throw new HttpError(404, "Project Folder not found");
    if (!(await isProjectOwner(db, identity, projectId, true))) throw new HttpError(403, "Requires Project owner role");
    return;
  }
  const agent = await agentRecord(db, identity.spaceId, scopeId);
  if (!agent) throw new HttpError(404, "Agent not found");
  if (agent.owner_user_id === identity.userId) return;
  if (agent.project_id && await isProjectOwner(db, identity, agent.project_id, true)) return;
  throw new HttpError(403, "Requires Agent or Project owner role");
}

async function assertScopeExists(
  db: Queryable,
  spaceId: string,
  scopeType: RuntimeContextPolicyScope,
  scopeId: string,
): Promise<void> {
  if (scopeType === "project") {
    const result = await db.query(`SELECT 1 FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL`, [scopeId, spaceId]);
    if (result.rows.length === 0) throw new HttpError(404, "Project not found");
    return;
  }
  if (scopeType === "project_folder") {
    if (!(await folderProject(db, spaceId, scopeId))) throw new HttpError(404, "Project Folder not found");
    return;
  }
  if (scopeType === "agent") {
    if (!(await agentRecord(db, spaceId, scopeId))) throw new HttpError(404, "Agent not found");
    return;
  }
  if (scopeType === "space" && scopeId !== spaceId) throw new HttpError(404, "Space not found");
}

async function assertSpaceMember(
  db: Queryable,
  identity: RuntimeContextPolicyIdentity,
  lock = false,
): Promise<string> {
  const result = await db.query<{ role: string }>(
    `SELECT role FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1${lock ? " FOR SHARE" : ""}`,
    [identity.spaceId, identity.userId],
  );
  const role = result.rows[0]?.role;
  if (!role) throw new HttpError(403, "Requires active Space membership");
  return role;
}

async function isProjectOwner(
  db: Queryable,
  identity: RuntimeContextPolicyIdentity,
  projectId: string,
  lockAuthority = false,
): Promise<boolean> {
  const project = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id FROM projects
      WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL
      LIMIT 1${lockAuthority ? " FOR SHARE" : ""}`,
    [projectId, identity.spaceId],
  );
  if (!project.rows[0]) return false;
  if (project.rows[0].owner_user_id === identity.userId) return true;
  const membership = await db.query(
    `SELECT 1 FROM project_members
      WHERE space_id=$1 AND project_id=$2 AND user_id=$3
        AND status='active' AND role='owner'
      LIMIT 1${lockAuthority ? " FOR SHARE" : ""}`,
    [identity.spaceId, projectId, identity.userId],
  );
  return membership.rows.length > 0;
}

async function folderProject(db: Queryable, spaceId: string, folderId: string): Promise<string | null> {
  const result = await db.query<{ project_id: string }>(
    `SELECT project_id FROM project_folders
      WHERE id = $1 AND space_id = $2`,
    [folderId, spaceId],
  );
  return result.rows[0]?.project_id ?? null;
}

async function projectExists(db: Queryable, spaceId: string, projectId: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM projects
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
     ) AS exists`,
    [projectId, spaceId],
  );
  return result.rows[0]?.exists === true;
}

async function agentRecord(db: Queryable, spaceId: string, agentId: string) {
  const result = await db.query<{ project_id: string | null; owner_user_id: string | null; visibility: string }>(
    `SELECT project_id, owner_user_id, visibility FROM agents
      WHERE id = $1 AND space_id = $2 AND status <> 'archived'`,
    [agentId, spaceId],
  );
  return result.rows[0] ?? null;
}

async function loadActiveVersion(
  db: Queryable,
  spaceId: string,
  scope: ScopeRef,
): Promise<RuntimeContextPolicyVersion | null> {
  const result = await db.query<VersionRow>(
    `SELECT v.id, v.space_id, v.scope_type, v.scope_id, v.version, v.policy_json,
            v.base_version_id, v.typed_diff_json, v.reason, v.created_by_user_id, v.created_at
       FROM runtime_context_policy_bindings b
       JOIN runtime_context_policy_versions v ON v.id = b.active_version_id
      WHERE b.space_id = $1 AND b.scope_type = $2 AND b.scope_id = $3`,
    [spaceId, scope.scopeType, scope.scopeId],
  );
  return result.rows[0] ? versionOut(result.rows[0]) : null;
}

async function loadVersionById(db: Queryable, spaceId: string, id: string): Promise<RuntimeContextPolicyVersion> {
  const result = await db.query<VersionRow>(
    `SELECT id, space_id, scope_type, scope_id, version, policy_json,
            base_version_id, typed_diff_json, reason, created_by_user_id, created_at
       FROM runtime_context_policy_versions WHERE id = $1 AND space_id = $2`,
    [id, spaceId],
  );
  if (!result.rows[0]) throw new HttpError(409, "Active Runtime Context Policy version is missing");
  return versionOut(result.rows[0]);
}

function versionOut(row: VersionRow): RuntimeContextPolicyVersion {
  return {
    id: row.id,
    space_id: row.space_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    version: row.version,
    policy: row.policy_json,
    base_version_id: row.base_version_id,
    typed_diff: row.typed_diff_json,
    reason: row.reason,
    created_by_user_id: row.created_by_user_id,
    created_at: new Date(row.created_at).toISOString(),
  } as RuntimeContextPolicyVersion;
}
