import { randomUUID } from "node:crypto";
import { SkillBindingRequestSchema, type SkillBindingRequest, type SkillBinding } from "@rainver/protocol";
import type { ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import { proposalToOut, type ProposalRow } from "../proposals/repository.js";
import { HttpError, objectValue, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { canChangeAgent, canConfigureAssistant } from "../agents/agentAccess.js";
import { loadSkillPackageContent } from "./skillPackageContent.js";

/**
 * Who approves a Skill scope decision. Space-scope Skill writes are a Space
 * owner's or admin's (the overlay authority), so both the review (with or
 * without its first binding) and a standalone binding proposal require at
 * least an admin; a Project-scoped binding is also its Project owner's
 * (`effectiveApproverRole`). The proposal-type risk ceiling still applies, so
 * a critical-risk package needs the Space owner.
 */
export const SKILL_SCOPE_APPROVER_ROLE = "admin";

export async function createSkillBindingProposal(
  db: Queryable, identity: SpaceUserIdentity, packageId: string, binding: SkillBindingRequest,
) {
  const pkg = await loadSkillPackageContent(db, identity.spaceId, packageId);
  const key = `skill-binding:${packageId}:${binding.scope_type}:${binding.scope_id ?? ""}:${binding.enabled}:${identity.userId}`;
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  const existing = (await db.query<ProposalRow>(`SELECT * FROM proposals WHERE space_id=$1
    AND proposal_type='runtime_skill_binding_update' AND status='pending' AND pending_operation_key=$2`, [identity.spaceId, key])).rows[0];
  if (existing) return proposalToOut(existing, new Date());
  const proposal = await insertProposalRow(db, {
    spaceId: identity.spaceId, proposalType: "runtime_skill_binding_update",
    title: `${binding.enabled ? "Enable" : "Disable"} Skill: ${pkg.package_name}`,
    rationale: "Approve a pinned original Skill package for this scope. No additional execution permissions are granted.",
    createdByUserId: identity.userId, visibility: "space_shared",
    requiredApproverRole: SKILL_SCOPE_APPROVER_ROLE,
    projectId: binding.scope_type === "project" ? binding.scope_id : null,
    pendingOperationKey: key,
    payload: { operation: "skill_package_binding_update", skill_package_id: packageId,
      package_hash: pkg.package_hash, ...binding },
  });
  return proposalToOut(proposal, new Date());
}

export async function applySkillPackageBinding(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = objectValue(context.proposal.payload_json);
  const parsed = SkillBindingRequestSchema.safeParse({ scope_type: payload.scope_type, scope_id: payload.scope_id, enabled: payload.enabled });
  if (!parsed.success || typeof payload.skill_package_id !== "string") throw new HttpError(422, "Invalid Skill binding proposal");
  const row = await applySkillBindingRequest(context, payload.skill_package_id, payload.package_hash, parsed.data);
  return { result_type: "capability_overlay", result: { action: "skill_package_binding_update", skill_binding: row } };
}

/**
 * Writes one pinned binding inside an accepted proposal. The binding scope
 * must be the scope the proposal was approved under, and the package must
 * still be the reviewed snapshot the proposal named. An Agent binding is
 * re-checked at apply: the Agent must still exist and not be archived, and
 * its proposer must still manage it (`canChangeAgent`, or
 * `canConfigureAssistant` for a managed Assistant), as when it was filed.
 */
export async function applySkillBindingRequest(
  context: ProposalApplyContext, skillPackageId: string, packageHash: unknown, binding: SkillBindingRequest,
): Promise<SkillBinding> {
  const projectId = binding.scope_type === "project" ? binding.scope_id! : null;
  if (projectId !== (context.proposal.project_id ?? null)) throw new HttpError(422, "Skill binding approval scope mismatch");
  if (binding.scope_type === "user" && binding.scope_id !== context.proposal.created_by_user_id) {
    throw new HttpError(422, "Skill user binding must belong to the proposer");
  }
  if (binding.scope_type === "agent") await assertAgentBindingTarget(context, binding.scope_id!);
  await lockSkillPackage(context.db, context.proposal.space_id, skillPackageId);
  const pkg = await loadSkillPackageContent(context.db, context.proposal.space_id, skillPackageId);
  if (pkg.package_hash !== packageHash) throw new HttpError(409, "Skill package changed after binding proposal");
  const now = new Date().toISOString();
  return (await context.db.query<SkillBinding>(`INSERT INTO skill_bindings
    (id,space_id,skill_package_id,project_id,agent_id,user_id,enabled,proposal_id,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
    ON CONFLICT (space_id,skill_package_id,(COALESCE(project_id,'')),(COALESCE(agent_id,'')),(COALESCE(user_id,'')))
    DO UPDATE SET enabled=EXCLUDED.enabled,proposal_id=EXCLUDED.proposal_id,updated_at=EXCLUDED.updated_at
    RETURNING *`, [randomUUID(), context.proposal.space_id, pkg.skill_package_id, projectId,
    binding.scope_type === "agent" ? binding.scope_id : null,
    binding.scope_type === "user" ? binding.scope_id : null, binding.enabled, context.proposal.id, now])).rows[0]!;
}

async function assertAgentBindingTarget(context: ProposalApplyContext, agentId: string): Promise<void> {
  const spaceId = context.proposal.space_id;
  const agent = (await context.db.query<{ agent_kind: string; project_id: string | null; status: string }>(
    "SELECT agent_kind, project_id, status FROM agents WHERE id=$1 AND space_id=$2", [agentId, spaceId],
  )).rows[0];
  if (!agent || agent.status === "archived") throw new HttpError(409, "The Agent for this Skill binding is no longer available");
  const proposer = context.proposal.created_by_user_id;
  const identity = { spaceId, userId: proposer ?? "" };
  const allowed = Boolean(proposer) && (agent.agent_kind === "system_assistant"
    ? await canConfigureAssistant(context.db, identity, { projectId: agent.project_id })
    : await canChangeAgent(context.db, identity, agentId));
  if (!allowed) throw new HttpError(403, "The proposer no longer manages the Agent for this Skill binding");
}

/**
 * The package-wide transaction lock. Review, binding and turn selection take
 * it before they lock the package row (`loadSkillPackageContent` shares it,
 * a review updates it), so every path orders the two locks the same way.
 */
export async function lockSkillPackage(db: Queryable, spaceId: string, packageId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`skill-package:${spaceId}:${packageId}`]);
}

/** A narrower scope can explicitly disable a broader binding for the same pinned package. */
export async function resolveSkillBindings(db: Queryable, scope: {
  space_id: string; project_id: string | null; agent_id: string | null; user_id: string | null;
}): Promise<SkillBinding[]> {
  return (await resolveSkillBindingsForScopes(db, scope.space_id, scope.user_id, [scope]))[0]!;
}

/**
 * Effective bindings for several Project/Agent scopes of one person in one
 * query, in the order given: Project > Agent > user > Space, where a
 * narrower disabled binding suppresses a broader enabled one.
 */
export async function resolveSkillBindingsForScopes(
  db: Queryable, spaceId: string, userId: string | null,
  scopes: ReadonlyArray<{ project_id: string | null; agent_id: string | null }>,
): Promise<SkillBinding[][]> {
  const result: SkillBinding[][] = scopes.map(() => []);
  if (!scopes.length) return result;
  const rows = (await db.query<SkillBinding & { scope_index: number }>(`SELECT * FROM (
    SELECT DISTINCT ON (scope.ordinality, binding.skill_package_id) scope.ordinality::int AS scope_index, binding.*
      FROM unnest($2::varchar[], $3::varchar[]) WITH ORDINALITY AS scope(project_id, agent_id, ordinality)
      JOIN skill_bindings binding ON binding.space_id=$1
       AND (binding.project_id IS NULL OR binding.project_id=scope.project_id)
       AND (binding.agent_id IS NULL OR binding.agent_id=scope.agent_id)
       AND (binding.user_id IS NULL OR binding.user_id=$4)
     ORDER BY scope.ordinality, binding.skill_package_id, CASE WHEN binding.project_id IS NOT NULL THEN 4
       WHEN binding.agent_id IS NOT NULL THEN 3 WHEN binding.user_id IS NOT NULL THEN 2 ELSE 1 END DESC
    ) effective WHERE enabled ORDER BY scope_index, skill_package_id`,
  [spaceId, scopes.map(scope => scope.project_id), scopes.map(scope => scope.agent_id), userId])).rows;
  for (const { scope_index: index, ...binding } of rows) result[index - 1]!.push(binding);
  return result;
}
