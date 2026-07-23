import { randomUUID } from "node:crypto";
import {
  MEMORY_COLUMNS,
  serializeMemoryRow,
  type MemoryRow,
} from "../memory/repository";
import type { ServerConfig } from "../../config";
import { registerCapabilityProposalAppliers } from "../capabilities/proposalApplier";
import { registerKnowledgeProposalAppliers } from "../knowledge/proposalApplier";
import { registerTaskProposalAppliers } from "../tasks/proposalApplier";
import { registerWorkspaceProposalAppliers } from "../workspaces";
import { registerRetrievalDiagnosticsProposalAppliers } from "../retrieval/artifacts/diagnostics";
import { registerRetrievalMaintenanceProposalAppliers } from "../retrieval/maintenance/artifacts";
import { registerMemoryMaintenanceProposalAppliers } from "../memory/maintenanceArtifacts";
import { registerClaimCandidatePacketProposalAppliers } from "../knowledge/claimCandidatePackets";
import { registerRelationDiscoveryProposalAppliers } from "../knowledge/relationDiscoveryArtifacts";
import { registerCustomSourceProposalAppliers } from "../sources/customSources/customSourceProposalApplier";
import { registerSourceRecipeProposalAppliers } from "../sources/sourceRecipes/recipeProposalApplier";
import { registerSourceChannelProposalAppliers } from "../sources/sourceChannelProposalApplier";
import { registerSourceBackfillProposalAppliers } from "../sources/sourceBackfillProposalApplier";
import { registerProjectSourceProposalAppliers } from "../projects/projectSourceProposalApplier";
import { registerEvolvableAssetPromotionProposalApplier } from "../evolution/assetPromotionProposalApplier";
import { registerWorkflowSaveProposalApplier } from "../evolution/workflowSaveProposalApplier";
import { registerPlanProposalAppliers } from "../plans/proposalApplier";
import { registerWorkflowExecutionProposalAppliers } from "../automations/workflowExecutionProposalApplier";
import { registerEvolutionBundleProposalApplier } from "../evolution/bundleProposalApplier";
import { registerResearchProposalAppliers } from "../research/proposalApplier";
import {
  PgMemoryApplyRepository,
  type ApplyProposal,
  type MemoryDigestTarget,
} from "../memory/memoryApplyRepository";
import type { Queryable } from "./repository";
import {
  markPolicyBundleDirty,
  markWorkspaceBundleDirty,
  markAgentBundleDirty,
} from "../context/digestService";
import { PgJobQueueRepository } from "../jobs/repository";
import { enqueueRetrievalEmbeddingBackfillWithQueue } from "../retrieval/embedding/job";
import type { ProposalAcceptResultType } from "@agent-space/protocol" with {
  "resolution-mode": "import",
};
import { validateProposalPayload } from "./payloadSchemas";
export { ProposalPayloadValidationError } from "./payloadSchemas";

export interface ProposalApplyContext {
  config: ServerConfig;
  db: Queryable;
  proposal: ApplyProposal;
  userId: string;
}

export interface ProposalApplyResult {
  result_type: ProposalAcceptResultType;
  result: Record<string, unknown>;
  rollback?: () => Promise<void>;
  /** Updated proposal payload to persist on accept (e.g., memory resulting_memory_id). */
  proposalPayloadPatch?: Record<string, unknown>;
  /** Supersede a proposal that is valid but no longer applies (for example an optimistic-lock miss). */
  finalStatus?: "accepted" | "superseded";
}

export class UnknownProposalApplierError extends Error {
  readonly statusCode = 422;

  constructor(readonly proposalType: string) {
    super(`unsupported proposal type: ${JSON.stringify(proposalType)}`);
    this.name = "UnknownProposalApplierError";
  }
}

export type ProposalApplier = (context: ProposalApplyContext) => Promise<ProposalApplyResult>;

export class ProposalApplierRegistry {
  private readonly appliers = new Map<string, ProposalApplier>();

  register(proposalType: string, applier: ProposalApplier): void {
    if (!proposalType) throw new Error("proposalType must be non-empty");
    if (this.appliers.has(proposalType)) {
      throw new Error(`an applier is already registered for proposal type ${proposalType}`);
    }
    this.appliers.set(proposalType, applier);
  }

  get(proposalType: string): ProposalApplier | null {
    return this.appliers.get(proposalType) ?? null;
  }

  registeredTypes(): ReadonlySet<string> {
    return new Set(this.appliers.keys());
  }

  async apply(context: ProposalApplyContext): Promise<ProposalApplyResult> {
    const applier = this.get(context.proposal.proposal_type);
    if (!applier) throw new UnknownProposalApplierError(context.proposal.proposal_type);
    validateProposalPayload(context.proposal.proposal_type, context.proposal.payload_json);
    return applier(context);
  }
}

export interface ProposalApplierContributor {
  applyProposalAppliers(registry: ProposalApplierRegistry): void;
}

export function createDefaultProposalApplierRegistry(
  contributor?: ProposalApplierContributor,
): ProposalApplierRegistry {
  const registry = new ProposalApplierRegistry();
  for (const proposalType of ["memory_create", "memory_update", "memory_archive"]) {
    registry.register(proposalType, applyMemoryProposal);
  }
  registry.register("policy_change", applyPolicyChangeProposal);
  registerCapabilityProposalAppliers(registry);
  registerKnowledgeProposalAppliers(registry);
  registerClaimCandidatePacketProposalAppliers(registry);
  registerRelationDiscoveryProposalAppliers(registry);
  registerRetrievalDiagnosticsProposalAppliers(registry);
  registerRetrievalMaintenanceProposalAppliers(registry);
  registerMemoryMaintenanceProposalAppliers(registry);
  registerTaskProposalAppliers(registry);
  registerWorkspaceProposalAppliers(registry);
  registerCustomSourceProposalAppliers(registry);
  registerSourceRecipeProposalAppliers(registry);
  registerSourceChannelProposalAppliers(registry);
  registerSourceBackfillProposalAppliers(registry);
  registerProjectSourceProposalAppliers(registry);
  registerEvolvableAssetPromotionProposalApplier(registry);
  registerWorkflowSaveProposalApplier(registry);
  registerPlanProposalAppliers(registry);
  registerWorkflowExecutionProposalAppliers(registry);
  registerEvolutionBundleProposalApplier(registry);
  registerResearchProposalAppliers(registry);
  contributor?.applyProposalAppliers(registry);
  return registry;
}

async function applyMemoryProposal(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const applied = await new PgMemoryApplyRepository(context.db).applyOnly(
    context.proposal,
    context.userId,
  );

  const dirtyReason = {
    triggered_by: "memory_apply",
    proposal_id: context.proposal.id,
    memory_id: applied.memoryId,
    proposal_type: context.proposal.proposal_type,
  };

  await markAndEnqueueMemoryDigestRefreshes(
    context,
    applied.affectedDigestTargets,
    dirtyReason,
  );
  if (context.proposal.proposal_type !== "memory_archive") {
    await enqueueMemoryRetrievalEmbeddingBackfill(context);
  }

  const row = await context.db.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE id = $1`,
    [applied.memoryId],
  );
  const memory = row.rows[0];
  if (!memory) throw new Error("applied memory row not found after applyOnly");
  return {
    result_type: "memory_entry",
    result: { memory: serializeMemoryRow(memory, context.userId) },
    proposalPayloadPatch: applied.finalPayload,
  };
}

async function enqueueMemoryRetrievalEmbeddingBackfill(
  context: ProposalApplyContext,
): Promise<void> {
  let savepointStarted = false;
  try {
    await context.db.query("SAVEPOINT retrieval_embedding_enqueue");
    savepointStarted = true;
    await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(context.db), {
      spaceId: context.proposal.space_id,
      userId: context.userId,
      trigger: "memory_proposal_apply",
      proposalId: context.proposal.id,
    });
    await context.db.query("RELEASE SAVEPOINT retrieval_embedding_enqueue");
    savepointStarted = false;
  } catch (error) {
    if (savepointStarted) {
      await context.db.query("ROLLBACK TO SAVEPOINT retrieval_embedding_enqueue").catch(() => undefined);
      await context.db.query("RELEASE SAVEPOINT retrieval_embedding_enqueue").catch(() => undefined);
    }
    process.stderr.write(
      `[memory.retrieval] embedding backfill enqueue failed during proposal apply: ${String((error as Error)?.message ?? error)}\n`,
    );
  }
}

async function applyPolicyChangeProposal(context: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = context.proposal.payload_json ?? {};

  const name = strFromPayload(payload, "name");
  const domain = strFromPayload(payload, "domain");
  if (!name) throw new Error("policy_change payload missing required field 'name'");
  if (!domain) throw new Error("policy_change payload missing required field 'domain'");

  const policyJson = objFromPayload(payload, "policy_json") ?? {};
  const ruleJson = objFromPayload(payload, "rule_json");
  const appliesToJson = jsonValueFromPayload(payload, "applies_to_json");
  const policyKey = strFromPayload(payload, "policy_key");
  const enforcementMode = strFromPayload(payload, "enforcement_mode");
  const supersedePolicyId = strFromPayload(payload, "supersedes_policy_id");
  const priority = typeof payload.priority === "number" ? payload.priority : 0;

  const now = new Date().toISOString();
  const policyId = randomUUID();
  const spaceId = context.proposal.space_id;

  if (supersedePolicyId) {
    await context.db.query(
      `UPDATE policies SET status = 'superseded', updated_at = $1 WHERE id = $2 AND space_id = $3 AND status = 'active'`,
      [now, supersedePolicyId, spaceId],
    );
  }

  await context.db.query(
    `INSERT INTO policies
       (id, space_id, name, domain, policy_json, enabled, policy_key,
        enforcement_mode, priority, policy_version, status,
        rule_json, applies_to_json, supersedes_policy_id,
        created_from_proposal_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6, $7, $8, 1, 'active',
             $9::jsonb, $10::jsonb, $11, $12, $13, $13)`,
    [
      policyId, spaceId, name, domain, JSON.stringify(policyJson),
      policyKey ?? null, enforcementMode ?? null, priority,
      ruleJson ? JSON.stringify(ruleJson) : null,
      appliesToJson ? JSON.stringify(appliesToJson) : null,
      supersedePolicyId ?? null,
      context.proposal.id, now,
    ],
  );

  await markPolicyBundleDirty(context.db, spaceId, {
    triggered_by: "policy_change",
    proposal_id: context.proposal.id,
    policy_id: policyId,
  });
  await new PgJobQueueRepository(context.db).enqueue({
    job_type: "context_digest_refresh",
    space_id: spaceId,
    user_id: context.userId,
    payload: { space_id: spaceId, digest_type: "policy_bundle" },
  });
  // Policies live only in the space-level policy_bundle digest; workspace/agent
  // digests are memory-only and never embed policy content. Invalidating them on
  // a policy change would just recompute an identical memory hash (no-op refresh),
  // so a policy change marks the policy_bundle dirty and nothing else. Scoped
  // policies are still surfaced per-run at consumption time (loadDigestBundle
  // assembles policy_bundle + workspace + agent for the run).

  return {
    result_type: "policy_version",
    result: { policy_id: policyId, space_id: spaceId, domain, name },
    proposalPayloadPatch: { ...payload, resulting_policy_id: policyId },
  };
}

async function markAndEnqueueMemoryDigestRefreshes(
  context: ProposalApplyContext,
  targets: readonly MemoryDigestTarget[],
  dirtyReason: Record<string, unknown>,
): Promise<void> {
  const queue = new PgJobQueueRepository(context.db);
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.scopeType === "workspace" && target.workspaceId) {
      const key = `workspace:${target.workspaceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await markWorkspaceBundleDirty(
        context.db,
        context.proposal.space_id,
        target.workspaceId,
        dirtyReason,
      );
      await queue.enqueue({
        job_type: "context_digest_refresh",
        space_id: context.proposal.space_id,
        user_id: context.userId,
        payload: {
          space_id: context.proposal.space_id,
          digest_type: "workspace",
          scope_id: target.workspaceId,
        },
      });
    } else if (target.scopeType === "agent" && target.agentId) {
      const key = `agent:${target.agentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await markAgentBundleDirty(
        context.db,
        context.proposal.space_id,
        target.agentId,
        dirtyReason,
      );
      await queue.enqueue({
        job_type: "context_digest_refresh",
        space_id: context.proposal.space_id,
        user_id: context.userId,
        payload: {
          space_id: context.proposal.space_id,
          digest_type: "agent",
          scope_id: target.agentId,
        },
      });
    }
  }
}

function strFromPayload(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function objFromPayload(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = payload[key];
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function jsonValueFromPayload(payload: Record<string, unknown>, key: string): unknown | null {
  const v = payload[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  return null;
}
