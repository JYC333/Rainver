import { createHash, randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type { Pool } from "../../db/pool.js";
import type { RuntimeContextResolvedPolicy, WorkContextSetupWriteRequest } from "@rainver/protocol";
import { HttpError, dateIso, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectReadable, assertProjectReadableLocked } from "../projects/access.js";
import { contentReadSql, projectReadAccessSql } from "../access/contentAccessSql.js";
import { projectFolderReadAccessSql } from "../projectFolders/access.js";
import { resolveRuntimeContextPolicyForExecution } from "../policy/runtimeContextPolicyRepository.js";

interface SetupRow { [key: string]: unknown; id: string; space_id: string; work_context_scope_id: string; scope_kind: string; version: number; user_id: string; project_id: string | null; project_folder_id: string | null; agent_id: string | null; runtime_ref_json: unknown; pinned_refs_json: unknown; excluded_refs_json: unknown; retrieval_preferences_json: unknown; continuity_preferences_json: unknown; project_brief_version_id: string | null; project_instruction_version_id: string | null; project_instruction_enabled: boolean; governing_policy_refs_json: unknown; setup_fingerprint: string; base_version: number | null; typed_diff_json: unknown; reason: string; policy_decision_record_id: string; created_by_user_id: string; created_at: unknown; }

export class WorkContextService {
  constructor(private readonly db: Pool) {}

  async getActive(identity: SpaceUserIdentity, scopeId: string): Promise<Record<string, unknown> | null> {
    return readActiveWorkContext(this.db, identity, scopeId, false);
  }

  async ensureRootTask(identity: SpaceUserIdentity, scopeId: string): Promise<Record<string, unknown>> {
    return this.ensureForScope(identity, scopeId);
  }

  async ensureForScope(identity: SpaceUserIdentity, scopeId: string): Promise<Record<string, unknown>> {
    const active = await this.getActive(identity, scopeId);
    if (active) return active;
    const scopeKind = await inferWorkContextScopeKind(this.db, identity, scopeId);
    try {
      return await this.create(identity, {
        work_context_scope_id: scopeId,
        scope_kind: scopeKind,
        project_id: null,
        project_folder_id: null,
        agent_id: null,
        runtime_ref: null,
        pinned_refs: [],
        excluded_refs: [],
        retrieval_preferences: {},
        continuity_preferences: {},
        base_version: null,
        reason: "Bootstrap managed Runtime Context",
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 409) throw error;
      const raced = await this.getActive(identity, scopeId);
      if (!raced) throw error;
      return raced;
    }
  }

  async ensureForInvocation(
    identity: SpaceUserIdentity,
    scopeId: string,
    invocation: { agentId: string; runtimeProfileId: string | null },
  ): Promise<Record<string, unknown>> {
    const current = (await this.db.query<SetupRow>(
      `SELECT * FROM work_context_setups
        WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3
        ORDER BY version DESC LIMIT 1`,
      [identity.spaceId, scopeId, identity.userId],
    )).rows[0] ?? null;
    if (current) {
      const bindings = await resolveWorkContextScopeBindings(
        this.db,
        identity,
        current.scope_kind as WorkContextSetupWriteRequest["scope_kind"],
        scopeId,
      );
      assertStoredSetupMatchesScope(current, bindings);
      const projectId = current.project_id ?? bindings.project_id;
      if (projectId) {
        await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
      }
    }
    const scopeKind = current?.scope_kind as WorkContextSetupWriteRequest["scope_kind"] | undefined
      ?? await inferWorkContextScopeKind(this.db, identity, scopeId);
    const runtimeRef = invocation.runtimeProfileId
      ? { type: "runtime_profile" as const, id: invocation.runtimeProfileId }
      : null;
    if (current
      && current.agent_id === invocation.agentId
      && runtimeProfileId(current.runtime_ref_json) === invocation.runtimeProfileId) {
      return toOut(current);
    }
    try {
      return await this.create(identity, {
        work_context_scope_id: scopeId,
        scope_kind: scopeKind,
        project_id: current?.project_id ?? null,
        project_folder_id: current?.project_folder_id ?? null,
        agent_id: invocation.agentId,
        runtime_ref: runtimeRef,
        pinned_refs: current?.pinned_refs_json ?? [],
        excluded_refs: current?.excluded_refs_json ?? [],
        retrieval_preferences: current?.retrieval_preferences_json ?? {},
        continuity_preferences: current?.continuity_preferences_json ?? {},
        base_version: current?.version ?? null,
        reason: current
          ? "Bind managed invocation to the selected Agent/runtime"
          : "Bootstrap managed Runtime Context",
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 409) throw error;
      const raced = (await this.db.query<SetupRow>(
        `SELECT * FROM work_context_setups
          WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3
          ORDER BY version DESC LIMIT 1`,
        [identity.spaceId, scopeId, identity.userId],
      )).rows[0];
      if (raced
        && raced.agent_id === invocation.agentId
        && runtimeProfileId(raced.runtime_ref_json) === invocation.runtimeProfileId) {
        return toOut(raced);
      }
      throw error;
    }
  }

  async create(identity: SpaceUserIdentity, raw: unknown): Promise<Record<string, unknown>> {
    const parsed = protocol.WorkContextSetupWriteRequestSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(422, "Invalid Work Context Setup: only typed object references and preferences are accepted");
    const requested = parsed.data;
    const scopeBindings = await resolveWorkContextScopeBindings(this.db, identity, requested.scope_kind, requested.work_context_scope_id);
    const input = bindSetupToScope(requested, scopeBindings);
    await assertSetupReferences(this.db, identity, input);
    return withQueryableTransaction(this.db, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`work-context:${identity.spaceId}:${input.work_context_scope_id}`]);
      const lockedBindings = await resolveWorkContextScopeBindings(db, identity, input.scope_kind, input.work_context_scope_id);
      if (lockedBindings.project_id !== scopeBindings.project_id
        || lockedBindings.project_folder_id !== scopeBindings.project_folder_id
        || lockedBindings.agent_id !== scopeBindings.agent_id) {
        throw new HttpError(409, "Work Context scope bindings changed during setup creation");
      }
      assertStoredSetupMatchesScope(input, lockedBindings);
      // Revalidate every referenced resource after serializing setup creation.
      // The preflight checks above provide early errors; these transactional
      // checks are the authority for what is actually persisted.
      await assertSetupReferences(db, identity, input);
      const current = await db.query<SetupRow>(`SELECT * FROM work_context_setups WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3 ORDER BY version DESC LIMIT 1`, [identity.spaceId, input.work_context_scope_id, identity.userId]);
      const currentRow = current.rows[0] ?? null;
      const currentVersion = currentRow?.version ?? null;
      if (input.base_version !== currentVersion) {
        throw new HttpError(409, "Work Context Setup base version is stale");
      }
      const resolvedPolicy = await resolveRuntimeContextPolicyForExecution(db, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectId: input.project_id,
        projectFolderId: input.project_folder_id,
        agentId: input.agent_id,
      });
      assertSetupWithinPolicy(input, resolvedPolicy);
      const selected = await selectPublishedProjectContext(db, identity.spaceId, input.project_id, resolvedPolicy);
      const policyRefs = resolvedPolicy.contributing_versions;
      const canonical = { ...setupContent(input), project_brief_version_id: selected.briefId, project_instruction_version_id: selected.instructionId, project_instruction_enabled: selected.instructionEnabled, governing_policy_refs: policyRefs };
      const fingerprint = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      const typedDiff = setupTypedDiff(currentRow, canonical);
      const setupId = randomUUID();
      const policyDecisionId = randomUUID();
      const createdAt = new Date().toISOString();
      await db.query(
        `INSERT INTO policy_decision_records (
           id,space_id,actor_type,actor_id,action,resource_type,resource_id,
           decision,risk_level,policy_rule_id,policy_source,metadata_json,created_at
         ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                   'allow','medium','work_context_scope_authority','runtime_context_acl',$5::jsonb,$6)`,
        [policyDecisionId, identity.spaceId, identity.userId, setupId, JSON.stringify({
          work_context_scope_id: input.work_context_scope_id,
          base_version: input.base_version,
          reason: input.reason,
        }), createdAt],
      );
      const result = await db.query<SetupRow>(`INSERT INTO work_context_setups (id,space_id,work_context_scope_id,scope_kind,version,user_id,project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,project_brief_version_id,project_instruction_version_id,project_instruction_enabled,governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,created_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18::jsonb,$19,$20,$21::jsonb,$22,$23,$6,$24) RETURNING *`, [setupId, identity.spaceId, input.work_context_scope_id, input.scope_kind, (currentVersion ?? 0) + 1, identity.userId, input.project_id, input.project_folder_id, input.agent_id, JSON.stringify(input.runtime_ref), JSON.stringify(input.pinned_refs), JSON.stringify(input.excluded_refs), JSON.stringify(input.retrieval_preferences), JSON.stringify(input.continuity_preferences), selected.briefId, selected.instructionId, selected.instructionEnabled, JSON.stringify(policyRefs), fingerprint, input.base_version, JSON.stringify(typedDiff), input.reason, policyDecisionId, createdAt]);
      return toOut(result.rows[0]!);
    });
  }

  async resolveExplicit(
    identity: SpaceUserIdentity,
    projectId: string | null,
    refs: WorkContextSetupWriteRequest["pinned_refs"],
  ): Promise<Record<string, unknown>[]> {
    return resolveExplicitReferences(this.db, identity, refs, projectId);
  }
}

/** Transactional authority check for mutations against an active Work Context. */
export async function assertActiveWorkContextReadable(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeId: string,
): Promise<Record<string, unknown>> {
  // Serialize authority-sensitive mutations with Work Context version writes.
  // A row lock on the currently latest setup cannot prevent create() from
  // inserting a newer version after this check.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `work-context:${identity.spaceId}:${scopeId}`,
  ]);
  const active = await readActiveWorkContext(db, identity, scopeId, true);
  if (!active) throw new HttpError(404, "Work Context is not readable");
  return active;
}

async function readActiveWorkContext(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeId: string,
  lock: boolean,
): Promise<Record<string, unknown> | null> {
  const result = await db.query<SetupRow>(
    `SELECT * FROM work_context_setups
      WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3
      ORDER BY version DESC LIMIT 1${lock ? " FOR SHARE" : ""}`,
    [identity.spaceId, scopeId, identity.userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (lock) {
    await lockWorkContextScopeAuthority(
      db,
      identity,
      row.scope_kind as WorkContextSetupWriteRequest["scope_kind"],
      scopeId,
    );
  }
  const scopeBindings = await resolveWorkContextScopeBindings(
    db,
    identity,
    row.scope_kind as WorkContextSetupWriteRequest["scope_kind"],
    scopeId,
  );
  assertStoredSetupMatchesScope(row, scopeBindings);
  const effectiveProjectId = row.project_id ?? scopeBindings.project_id;
  if (effectiveProjectId) {
    if (lock) {
      await assertProjectReadableLocked(db, identity.spaceId, effectiveProjectId, identity.userId);
    } else {
      await assertProjectReadable(db, identity.spaceId, effectiveProjectId, identity.userId);
    }
  }
  return toOut(row);
}

async function lockWorkContextScopeAuthority(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeKind: WorkContextSetupWriteRequest["scope_kind"],
  scopeId: string,
): Promise<void> {
  if (scopeKind === "direct_session") {
    const result = await db.query(
      `SELECT 1 FROM sessions
        WHERE id=$1 AND space_id=$2 AND user_id=$3 AND room_id IS NULL
        FOR SHARE`,
      [scopeId, identity.spaceId, identity.userId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Work Context scope not found");
    return;
  }
  if (scopeKind === "room_recipient") {
    const result = await db.query(
      `SELECT 1
         FROM room_agent_members recipient
         JOIN rooms room ON room.id=recipient.room_id AND room.space_id=recipient.space_id
         JOIN agents recipient_agent
           ON recipient_agent.id=recipient.agent_id AND recipient_agent.space_id=recipient.space_id
         JOIN sessions session ON session.room_id=room.id AND session.space_id=room.space_id
         JOIN room_user_members member
           ON member.room_id=room.id AND member.space_id=room.space_id
          AND member.user_id=$3 AND member.status='active'
        WHERE recipient.id=$1 AND recipient.space_id=$2
          AND recipient.status='active' AND recipient_agent.status='active'
          AND room.status='active' AND session.room_id IS NOT NULL
          AND (
            recipient_agent.visibility = 'space_shared'
            OR recipient_agent.owner_user_id = $3
            OR EXISTS (
              SELECT 1 FROM room_agent_access_grants room_grant
               WHERE room_grant.space_id = recipient.space_id
                 AND room_grant.room_id = recipient.room_id
                 AND room_grant.agent_id = recipient.agent_id
                 AND room_grant.grantee_user_id = $3
                 AND room_grant.revoked_at IS NULL
            )
          )
        FOR SHARE OF recipient,room,session,member`,
      [scopeId, identity.spaceId, identity.userId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Work Context scope not found");
    return;
  }
  if (scopeKind === "root_task") {
    const result = await db.query(
      `SELECT 1 FROM runs
        WHERE id=$1 AND space_id=$2 AND (root_run_id IS NULL OR root_run_id=id)
          AND (owner_user_id=$3 OR instructed_by_user_id=$3)
        FOR SHARE`,
      [scopeId, identity.spaceId, identity.userId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Work Context scope not found");
    return;
  }
  const execution = await db.query<{ root_run_id: string | null }>(
    `SELECT root_run_id FROM workflow_executions
      WHERE id=$1 AND space_id=$2 FOR SHARE`,
    [scopeId, identity.spaceId],
  );
  const rootRunId = execution.rows[0]?.root_run_id;
  if (!execution.rows[0]) throw new HttpError(404, "Work Context scope not found");
  const automation = await db.query(
    `SELECT 1 FROM automation_runs
      WHERE workflow_execution_id=$1 AND triggered_by_user_id=$2 FOR SHARE`,
    [scopeId, identity.userId],
  );
  if (automation.rows[0]) return;
  if (rootRunId) {
    const root = await db.query(
      `SELECT 1 FROM runs
        WHERE id=$1 AND space_id=$2 AND (owner_user_id=$3 OR instructed_by_user_id=$3)
        FOR SHARE`,
      [rootRunId, identity.spaceId, identity.userId],
    );
    if (root.rows[0]) return;
  }
  throw new HttpError(404, "Work Context scope not found");
}

async function inferWorkContextScopeKind(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeId: string,
): Promise<WorkContextSetupWriteRequest["scope_kind"]> {
  const workflow = await db.query(
    `SELECT 1 FROM workflow_executions execution
      LEFT JOIN automation_runs automation_run ON automation_run.workflow_execution_id=execution.id
      LEFT JOIN runs root ON root.id=execution.root_run_id AND root.space_id=execution.space_id
     WHERE execution.id=$1 AND execution.space_id=$2
       AND (automation_run.triggered_by_user_id=$3 OR root.owner_user_id=$3 OR root.instructed_by_user_id=$3)
     LIMIT 1`,
    [scopeId, identity.spaceId, identity.userId],
  );
  if (workflow.rows[0]) return "workflow_execution";
  const roomRecipient = await db.query(
    `SELECT 1
       FROM room_agent_members recipient
       JOIN rooms room
         ON room.id=recipient.room_id AND room.space_id=recipient.space_id
       JOIN agents recipient_agent
         ON recipient_agent.id=recipient.agent_id AND recipient_agent.space_id=recipient.space_id
       JOIN room_user_members member
         ON member.room_id=room.id AND member.space_id=room.space_id
        AND member.user_id=$3 AND member.status='active'
      WHERE recipient.id=$1 AND recipient.space_id=$2
        AND recipient.status='active' AND recipient_agent.status='active'
        AND room.status='active'
        AND (
          recipient_agent.visibility = 'space_shared'
          OR recipient_agent.owner_user_id = $3
          OR EXISTS (
            SELECT 1 FROM room_agent_access_grants room_grant
             WHERE room_grant.space_id = recipient.space_id
               AND room_grant.room_id = recipient.room_id
               AND room_grant.agent_id = recipient.agent_id
               AND room_grant.grantee_user_id = $3
               AND room_grant.revoked_at IS NULL
          )
        )
      LIMIT 1`,
    [scopeId, identity.spaceId, identity.userId],
  );
  if (roomRecipient.rows[0]) return "room_recipient";
  const session = await db.query<{ room_id: string | null }>(
    `SELECT room_id FROM sessions WHERE id=$1 AND space_id=$2 AND user_id=$3 LIMIT 1`,
    [scopeId, identity.spaceId, identity.userId],
  );
  if (session.rows[0] && session.rows[0].room_id === null) return "direct_session";
  return "root_task";
}

async function assertSetupReferences(
  db: Queryable,
  identity: SpaceUserIdentity,
  input: WorkContextSetupWriteRequest,
): Promise<void> {
  if (input.excluded_refs.some((ref) => ref.type === "project_instruction_version")) {
    throw new HttpError(422, "Work Context exclusions cannot suppress approved Project Instructions");
  }
  if (input.runtime_ref) {
    if (input.runtime_ref.type !== "runtime_profile" || !input.agent_id) {
      throw new HttpError(422, "Work Context runtime_ref must identify a runtime profile for the selected Agent");
    }
    const runtime = await db.query(
      `SELECT 1 FROM agent_runtime_profiles
        WHERE id=$1 AND space_id=$2 AND agent_id=$3 AND enabled=TRUE`,
      [input.runtime_ref.id, identity.spaceId, input.agent_id],
    );
    if (!runtime.rows[0]) throw new HttpError(404, "Work Context runtime profile not found");
  }
  if (input.project_id) await assertProjectReadable(db, identity.spaceId, input.project_id, identity.userId);
  if (input.project_folder_id) {
    const folder = await db.query(
      `SELECT 1
         FROM project_folders f
        WHERE f.id=$1
          AND f.space_id=$2
          AND f.project_id IS NOT DISTINCT FROM $3
          AND f.status='active'
          AND ${projectFolderReadAccessSql({ spaceExpr: "f.space_id", projectFolderExpr: "f.id", userExpr: "$4" })}`,
      [input.project_folder_id, identity.spaceId, input.project_id, identity.userId],
    );
    if (!folder.rows[0]) throw new HttpError(404, "Project Folder not found in Work Context Project");
  }
  if (input.agent_id) {
    const agent = await db.query(
      `SELECT 1 FROM agents a
        WHERE a.id=$1 AND a.space_id=$2
          AND (a.project_id IS NULL OR a.project_id IS NOT DISTINCT FROM $3)
          AND a.status='active'
          AND (
            ${contentReadSql("agent", "a", "$4")}
            OR (
              $5::varchar = 'room_recipient'
              AND ${roomScopedAgentReadSql("a", "$4", "$6")}
            )
          )`,
      [input.agent_id, identity.spaceId, input.project_id, identity.userId, input.scope_kind, input.work_context_scope_id],
    );
    if (!agent.rows[0]) throw new HttpError(404, "Agent not found");
  }
  await resolveExplicitReferences(db, identity, input.pinned_refs, input.project_id);
}

/** Room-only Agent grants are valid only for the recipient scope that owns the setup. */
export function roomScopedAgentReadSql(agentAlias: string, userExpr: string, scopeExpr: string): string {
  return `EXISTS (
    SELECT 1
      FROM room_agent_members recipient
      JOIN rooms room_scope
        ON room_scope.id=recipient.room_id AND room_scope.space_id=recipient.space_id
      JOIN room_user_members room_member
        ON room_member.space_id=recipient.space_id
       AND room_member.room_id=recipient.room_id
       AND room_member.user_id=${userExpr}
       AND room_member.status='active'
     WHERE recipient.id=${scopeExpr}
       AND recipient.space_id=${agentAlias}.space_id
       AND recipient.agent_id=${agentAlias}.id
       AND recipient.status='active'
       AND room_scope.status='active'
       AND (${agentAlias}.project_id IS NULL OR ${agentAlias}.project_id=room_scope.project_id)
       AND ${projectReadAccessSql("room_scope.space_id", "room_scope.project_id", userExpr)}
       AND (
         ${agentAlias}.visibility='space_shared'
         OR ${agentAlias}.owner_user_id=${userExpr}
         OR EXISTS (
           SELECT 1 FROM room_agent_access_grants room_grant
            WHERE room_grant.space_id=recipient.space_id
              AND room_grant.room_id=recipient.room_id
              AND room_grant.agent_id=${agentAlias}.id
              AND room_grant.grantee_user_id=${userExpr}
              AND room_grant.revoked_at IS NULL
         )
       )
  )`;
}

/**
 * Every explicit reference type, in one place.
 *
 * Three sites used to enumerate these independently — this resolver, the
 * context-authority read's filter, and the delivery re-authorization — and
 * adding a member to one of them left the other two silently disagreeing: a
 * pinned reference the resolver accepted was dropped by the filter and
 * rejected at delivery.
 */
const EXPLICIT_REFERENCE_TYPES = [
  "project_brief_version",
  "project_instruction_version",
] as const;
export type ExplicitReferenceType = (typeof EXPLICIT_REFERENCE_TYPES)[number];

export function isExplicitReferenceType(value: unknown): value is ExplicitReferenceType {
  return typeof value === "string"
    && (EXPLICIT_REFERENCE_TYPES as readonly string[]).includes(value);
}

/**
 * Reached only for a type outside the list — which the type system says is
 * impossible, so this fires when a caller hands over unvalidated input.
 */
function assertNoUnhandledReferenceType(type: never): never {
  throw new HttpError(422, `Unsupported explicit reference type: ${String(type)}`);
}

export async function resolveExplicitReferences(
  db: Queryable,
  identity: SpaceUserIdentity,
  refs: WorkContextSetupWriteRequest["pinned_refs"],
  expectedProjectId: string | null = null,
): Promise<Record<string, unknown>[]> {
    if (refs.length > 1000) throw new HttpError(422, "Too many explicit references");
    const items: Record<string, unknown>[] = [];
    for (const ref of refs) {
      // Narrowed against the shared list before dispatch, so the branches
      // below are exhaustive over it and the compiler refuses a new member
      // that nobody resolved.
      if (!isExplicitReferenceType(ref.type)) {
        throw new HttpError(422, `Unsupported explicit reference type: ${ref.type}`);
      }
      const type: ExplicitReferenceType = ref.type;
      if (type === "project_brief_version") {
        const result = await db.query(`SELECT bv.* FROM project_brief_versions bv JOIN projects p ON p.id=bv.project_id AND p.space_id=bv.space_id WHERE bv.id=$1 AND bv.space_id=$2 AND bv.status IN ('published','archived') AND bv.published_at IS NOT NULL AND p.deleted_at IS NULL`, [ref.id, identity.spaceId]);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw new HttpError(404, "Published Project Brief reference not found");
        await assertProjectReadable(db, identity.spaceId, String(row.project_id), identity.userId);
        items.push(projectBriefReference(row));
      } else if (type === "project_instruction_version") {
        const result = await db.query(`SELECT iv.* FROM project_instruction_versions iv JOIN projects p ON p.id=iv.project_id AND p.space_id=iv.space_id WHERE iv.id=$1 AND iv.space_id=$2 AND iv.status='published' AND iv.published_at IS NOT NULL AND p.deleted_at IS NULL`, [ref.id, identity.spaceId]);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw new HttpError(404, "Published Project Instruction reference not found");
        if (!expectedProjectId || row.project_id !== expectedProjectId) {
          throw new HttpError(422, "Project Instruction reference must belong to the Work Context Project");
        }
        await assertProjectReadable(db, identity.spaceId, String(row.project_id), identity.userId); items.push(row);
      } else {
        // Exhaustive over `EXPLICIT_REFERENCE_TYPES`: adding a member to that
        // list without a branch here is a compile error, which is what stops
        // the three sites from drifting apart again.
        assertNoUnhandledReferenceType(type);
      }
    }
    return items;
}

function projectBriefReference(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    version: row.version,
    goal: row.goal,
    scope_included: row.scope_included,
    scope_excluded: row.scope_excluded,
    success_definition: row.success_definition,
    constraints: row.constraints,
    assumptions: row.assumptions,
    project_status: row.project_status,
    current_focus: row.current_focus,
    confirmed_decisions: row.confirmed_decisions_json,
    primary_mode: row.primary_mode,
    workspace_identity: row.workspace_identity_json,
    workspace_boundary: row.workspace_boundary_json,
    source_refs: row.source_refs_json,
    status: row.status,
    reviewed_by_user_id: row.reviewed_by_user_id,
    reviewed_at: dateIso(row.reviewed_at),
    published_by_user_id: row.published_by_user_id,
    published_at: dateIso(row.published_at),
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at),
  };
}

export async function resolveWorkContextScopeProject(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeKind: WorkContextSetupWriteRequest["scope_kind"],
  scopeId: string,
): Promise<string | null> {
  return (await resolveWorkContextScopeBindings(db, identity, scopeKind, scopeId)).project_id;
}

export interface WorkContextScopeBindings {
  project_id: string | null;
  project_folder_id: string | null;
  agent_id: string | null;
}

export async function resolveWorkContextScopeBindings(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeKind: WorkContextSetupWriteRequest["scope_kind"],
  scopeId: string,
): Promise<WorkContextScopeBindings> {
  let result: { rows: WorkContextScopeBindings[] };
  if (scopeKind === "direct_session") {
    result = await db.query(
      `SELECT project_id, project_folder_id, agent_id FROM sessions
        WHERE id=$1 AND space_id=$2 AND user_id=$3 AND room_id IS NULL`,
      [scopeId, identity.spaceId, identity.userId],
    );
  } else if (scopeKind === "room_recipient") {
    result = await db.query(
      `SELECT COALESCE(s.project_id, room.project_id) AS project_id,
              COALESCE(s.project_folder_id, room.project_folder_id) AS project_folder_id,
              recipient.agent_id
         FROM room_agent_members recipient
         JOIN rooms room
           ON room.id=recipient.room_id AND room.space_id=recipient.space_id
         JOIN agents recipient_agent
           ON recipient_agent.id=recipient.agent_id AND recipient_agent.space_id=recipient.space_id
         JOIN sessions s
           ON s.room_id=room.id AND s.space_id=room.space_id
         JOIN room_user_members member
           ON member.room_id=s.room_id AND member.space_id=s.space_id
          AND member.user_id=$3 AND member.status='active'
        WHERE recipient.id=$1 AND recipient.space_id=$2
          AND recipient.status='active' AND recipient_agent.status='active'
          AND room.status='active' AND s.room_id IS NOT NULL
          AND (
            recipient_agent.visibility = 'space_shared'
            OR recipient_agent.owner_user_id = $3
            OR EXISTS (
              SELECT 1 FROM room_agent_access_grants room_grant
               WHERE room_grant.space_id = recipient.space_id
                 AND room_grant.room_id = recipient.room_id
                 AND room_grant.agent_id = recipient.agent_id
                 AND room_grant.grantee_user_id = $3
                 AND room_grant.revoked_at IS NULL
            )
          )`,
      [scopeId, identity.spaceId, identity.userId],
    );
  } else if (scopeKind === "root_task") {
    result = await db.query(
      `SELECT project_id, project_folder_id, agent_id FROM runs
        WHERE id=$1 AND space_id=$2
          AND (root_run_id IS NULL OR root_run_id=id)
          AND (owner_user_id=$3 OR instructed_by_user_id=$3)`,
      [scopeId, identity.spaceId, identity.userId],
    );
  } else {
    result = await db.query(
      `SELECT root.project_id, root.project_folder_id, root.agent_id
         FROM workflow_executions execution
         LEFT JOIN automation_runs automation_run
           ON automation_run.workflow_execution_id=execution.id
         LEFT JOIN runs root
           ON root.id=execution.root_run_id AND root.space_id=execution.space_id
        WHERE execution.id=$1 AND execution.space_id=$2
          AND (automation_run.triggered_by_user_id=$3
            OR root.owner_user_id=$3 OR root.instructed_by_user_id=$3)`,
      [scopeId, identity.spaceId, identity.userId],
    );
  }
  if (!result.rows[0]) throw new HttpError(404, "Work Context scope not found");
  return result.rows[0];
}

function bindSetupToScope(
  requested: WorkContextSetupWriteRequest,
  bindings: WorkContextScopeBindings,
): WorkContextSetupWriteRequest {
  assertStoredSetupMatchesScope(requested, bindings);
  return {
    ...requested,
    project_id: bindings.project_id ?? requested.project_id,
    project_folder_id: bindings.project_folder_id ?? requested.project_folder_id,
    agent_id: bindings.agent_id ?? requested.agent_id,
  };
}

function assertStoredSetupMatchesScope(
  setup: Pick<WorkContextSetupWriteRequest, "project_id" | "project_folder_id" | "agent_id">,
  bindings: WorkContextScopeBindings,
): void {
  for (const [key, label] of [
    ["project_id", "Project"],
    ["project_folder_id", "Project Folder"],
    ["agent_id", "Agent"],
  ] as const) {
    if (bindings[key] !== null && setup[key] !== null && setup[key] !== bindings[key]) {
      throw new HttpError(422, `Work Context ${label} must match the ${label} owned by its scope`);
    }
  }
}

async function selectPublishedProjectContext(
  db: Queryable,
  spaceId: string,
  projectId: string | null,
  policy: RuntimeContextResolvedPolicy,
) {
  const instructionEnabled = policy.policy.constraints.allow_project_instructions !== false
    && policy.policy.preferences.include_project_instructions !== false;
  if (!projectId) return { briefId: null, instructionId: null, instructionEnabled };
  const result = await db.query<{ brief_id: string | null; instruction_id: string | null }>(`SELECT bv.id brief_id, iv.id instruction_id FROM projects p LEFT JOIN project_brief_versions bv ON bv.id=p.active_brief_version_id AND bv.status='published' LEFT JOIN project_instruction_versions iv ON iv.id=p.active_instruction_version_id AND iv.status='published' WHERE p.id=$1 AND p.space_id=$2 AND p.deleted_at IS NULL`, [projectId, spaceId]);
  if (!result.rows[0]) throw new HttpError(404, "Project not found");
  return {
    briefId: policy.policy.constraints.allow_project_brief === false
      || policy.policy.preferences.include_project_brief === false ? null : result.rows[0].brief_id,
    instructionId: policy.policy.constraints.allow_project_instructions === false
      || policy.policy.preferences.include_project_instructions === false ? null : result.rows[0].instruction_id,
    instructionEnabled,
  };
}

function assertSetupWithinPolicy(
  input: WorkContextSetupWriteRequest,
  resolved: RuntimeContextResolvedPolicy,
): void {
  const constraints = resolved.policy.constraints;
  const preferences = resolved.policy.preferences;
  if (constraints.pinned_reference_max !== undefined
    && input.pinned_refs.length > constraints.pinned_reference_max) {
    throw new HttpError(422, "Work Context pinned references exceed governing policy");
  }
  if (constraints.explicit_reference_max !== undefined
    && input.pinned_refs.length > constraints.explicit_reference_max) {
    throw new HttpError(422, "Work Context explicit references exceed governing policy");
  }
  if (constraints.pinned_reference_types) {
    const allowed = new Set(constraints.pinned_reference_types);
    if (input.pinned_refs.some((ref) => !allowed.has(ref.type))) {
      throw new HttpError(422, "Work Context pinned reference type is prohibited by governing policy");
    }
  }
  if (constraints.explicit_reference_types) {
    const allowed = new Set(constraints.explicit_reference_types);
    if (input.pinned_refs.some((ref) => !allowed.has(ref.type))) {
      throw new HttpError(422, "Work Context explicit reference type is prohibited by governing policy");
    }
  }
  if (constraints.allow_project_brief === false
    || preferences.include_project_brief === false) {
    if (input.pinned_refs.some((ref) => ref.type === "project_brief_version")) {
      throw new HttpError(422, "Project Brief context is prohibited by governing policy");
    }
  }
  if (constraints.allow_project_instructions === false
    || preferences.include_project_instructions === false) {
    if (input.pinned_refs.some((ref) => ref.type === "project_instruction_version")) {
      throw new HttpError(422, "Project Instruction context is prohibited by governing policy");
    }
  }
  if (input.retrieval_preferences.enabled === true && preferences.retrieval_enabled === false) {
    throw new HttpError(422, "Retrieval is disabled by governing policy");
  }
  if (constraints.retrieval_max_candidates !== undefined
    && (input.retrieval_preferences.max_candidates ?? 0) > constraints.retrieval_max_candidates) {
    throw new HttpError(422, "Retrieval candidate limit exceeds governing policy");
  }
  if (constraints.retrieval_domains && input.retrieval_preferences.preferred_domains) {
    const allowed = new Set(constraints.retrieval_domains);
    if (input.retrieval_preferences.preferred_domains.some((domain) => !allowed.has(domain))) {
      throw new HttpError(422, "Retrieval domain is prohibited by governing policy");
    }
  }
  if (constraints.continuity_modes) {
    const allowed = new Set(constraints.continuity_modes);
    if (input.continuity_preferences.strategy && !allowed.has(input.continuity_preferences.strategy)) {
      throw new HttpError(422, "Continuity strategy is prohibited by governing policy");
    }
    if (input.continuity_preferences.continue_vendor_session === true && !allowed.has("stateful_cli")) {
      throw new HttpError(422, "Stateful CLI continuity is prohibited by governing policy");
    }
  }
}

function setupContent(input: WorkContextSetupWriteRequest): Omit<WorkContextSetupWriteRequest, "base_version" | "reason"> {
  const { base_version: _baseVersion, reason: _reason, ...content } = input;
  return content;
}

function setupTypedDiff(previous: SetupRow | null, next: Record<string, unknown>): Record<string, unknown> {
  const before = previous ? {
    work_context_scope_id: previous.work_context_scope_id,
    scope_kind: previous.scope_kind,
    project_id: previous.project_id,
    project_folder_id: previous.project_folder_id,
    agent_id: previous.agent_id,
    runtime_ref: previous.runtime_ref_json,
    pinned_refs: previous.pinned_refs_json,
    excluded_refs: previous.excluded_refs_json,
    retrieval_preferences: previous.retrieval_preferences_json,
    continuity_preferences: previous.continuity_preferences_json,
    project_brief_version_id: previous.project_brief_version_id,
    project_instruction_version_id: previous.project_instruction_version_id,
    project_instruction_enabled: previous.project_instruction_enabled,
    governing_policy_refs: previous.governing_policy_refs_json,
  } : {};
  const diff: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    const oldValue = before[key as keyof typeof before] ?? null;
    const newValue = next[key] ?? null;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diff[key] = { before: oldValue, after: newValue };
    }
  }
  return diff;
}

function toOut(row: SetupRow): Record<string, unknown> { return { id: row.id, space_id: row.space_id, work_context_scope_id: row.work_context_scope_id, scope_kind: row.scope_kind, version: row.version, user_id: row.user_id, project_id: row.project_id, project_folder_id: row.project_folder_id, agent_id: row.agent_id, runtime_ref: row.runtime_ref_json, pinned_refs: row.pinned_refs_json, excluded_refs: row.excluded_refs_json, retrieval_preferences: row.retrieval_preferences_json, continuity_preferences: row.continuity_preferences_json, project_brief_version_id: row.project_brief_version_id, project_instruction_version_id: row.project_instruction_version_id, project_instruction_enabled: row.project_instruction_enabled, governing_policy_refs: row.governing_policy_refs_json, setup_fingerprint: row.setup_fingerprint, base_version: row.base_version, typed_diff: row.typed_diff_json, reason: row.reason, policy_decision_ref: { type: "policy_decision_record", id: row.policy_decision_record_id }, created_by_user_id: row.created_by_user_id, created_at: dateIso(row.created_at) ?? new Date(0).toISOString() }; }

function runtimeProfileId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.type === "runtime_profile" && typeof record.id === "string"
    ? record.id
    : null;
}
