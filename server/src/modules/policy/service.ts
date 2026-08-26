/**
 * Policy enforcement service. The orchestration lives here; decision logic
 * lives in `gateway.ts` / `decisionCore.ts`.
 *
 * The internal port writes the durable audit itself and returns a structured
 * `PolicyEnforceResult`
 * (`allow` | `blocked` | `error`). "Exactly one durable audit per blocking
 * decision" is preserved: the service writes it here and nothing else does.
 */

import {
  buildAuditEnvelope,
  checkProposalApplyPolicy,
  computeDecision,
  isDurableAuditRequired,
  resolveFailureMode,
  type ProposalApplyInput,
  type Registry,
} from "./gateway.js";
import { checkHardInvariants } from "./decisionCore.js";
import { sanitizePolicyMetadata } from "./sanitizer.js";
import { writePolicyAudit } from "./auditWriter.js";
import type { PolicyDecision } from "./decisions.js";
import type { ServerConfig } from "../../config.js";

import type { PolicyCheckRequest } from "@rainver/protocol";

/**
 * Service-side result shape. Validated against the wire
 * `PolicyEnforceResultSchema` at the route boundary before it leaves the
 * process, so this stays a plain the server interface (the wire type is a strict
 * passthrough that a fixed interface cannot structurally satisfy).
 */
export interface EnforceResult {
  status: "allow" | "blocked" | "error";
  decision?: PolicyDecision;
  policy_decision_record_id?: string | null;
  error_code?:
    | "policy_denied"
    | "policy_requires_approval"
    | "policy_audit_persist_failed";
  message?: string;
}

type PolicyEnforcementConfig = Pick<ServerConfig, "databaseUrl">;

function blockedErrorCode(
  decision: PolicyDecision,
): "policy_denied" | "policy_requires_approval" {
  return decision.decision === "deny"
    ? "policy_denied"
    : "policy_requires_approval";
}

async function persistAudit(
  config: PolicyEnforcementConfig,
  envelope: ReturnType<typeof buildAuditEnvelope>,
): Promise<string> {
  if (!config.databaseUrl) {
    throw new Error("policy enforcement requires SERVER_DATABASE_URL");
  }
  return writePolicyAudit(config.databaseUrl, envelope);
}

/**
 * Enforce a sensitive action. Returns `allow` (with the decision) when the
 * action may proceed, `blocked` for DENY / REQUIRE_APPROVAL, and `error` when a
 * fail-closed ALLOW could not write its durable audit (the action must not
 * proceed).
 */
export async function enforce(
  config: PolicyEnforcementConfig,
  registry: Registry,
  req: PolicyCheckRequest,
): Promise<EnforceResult> {
  const { defn, decision } = computeDecision(registry, req);
  const nowIso = new Date().toISOString();

  if (decision.decision === "deny" || decision.decision === "require_approval") {
    // Blocking decisions always require durable audit. Write exactly once; a
    // failed write does not grant access (the action is already denied), so we
    // log-and-continue rather than fail open.
    const envelope = buildAuditEnvelope(req, decision, defn, nowIso);
    let policyDecisionRecordId: string | null = null;
    try {
      policyDecisionRecordId = await persistAudit(config, envelope);
    } catch {
      // best-effort: the denial stands regardless of audit-write outcome.
    }
    return {
      status: "blocked",
      decision,
      policy_decision_record_id: policyDecisionRecordId,
      error_code: blockedErrorCode(decision),
      message: decision.message,
    };
  }

  // ALLOW — write durable audit if required, honoring the failure mode.
  if (isDurableAuditRequired(defn, decision, req)) {
    const envelope = buildAuditEnvelope(req, decision, defn, nowIso);
    const failureMode = resolveFailureMode(defn, decision, req);
    let policyDecisionRecordId: string | null = null;
    try {
      policyDecisionRecordId = await persistAudit(config, envelope);
    } catch {
      if (failureMode === "fail_closed") {
        return {
          status: "error",
          error_code: "policy_audit_persist_failed",
          message: `Durable audit write failed (fail_closed) for ${req.action}`,
        };
      }
      // best-effort: continue.
    }
    return { status: "allow", decision, policy_decision_record_id: policyDecisionRecordId };
  }

  return { status: "allow", decision };
}

/**
 * Proposal-apply gate. `role` is the actor's raw active membership role (or
 * null), and `supportedTypes` is the live registered-applier ∩ risk-table set.
 * The caller resolves both inputs; this function stays DB-free. proposal.apply
 * is FAIL_CLOSED + audit_required, so an ALLOW whose audit write fails returns
 * `error`.
 */
export async function enforceProposalApply(
  config: PolicyEnforcementConfig,
  input: ProposalApplyInput,
  role: string | null,
  supportedTypes: ReadonlySet<string>,
): Promise<EnforceResult> {
  const nowIso = new Date().toISOString();

  // Hard-invariant guard on the proposal payload (approval-proof flags etc.).
  const guardCtx = {
    action: "proposal.apply",
    space_id: input.space_id,
    payload: input.proposal_payload ?? {},
  };
  const invariantDenial = checkHardInvariants(guardCtx);
  if (invariantDenial !== null) {
    invariantDenial.actor_type ??= "user";
    invariantDenial.actor_id ??= input.user_id;
    invariantDenial.space_id ??= input.space_id;
    invariantDenial.resource_type ??= "proposal";
    invariantDenial.resource_id ??= input.proposal_id;
    invariantDenial.proposal_type ??= input.proposal_type;
    invariantDenial.metadata_json = sanitizePolicyMetadata({
      ...(input.metadata_json ?? {}),
      proposal_type: input.proposal_type,
      decision_source: "hard_invariant_guard",
    });
    try {
      await writeProposalAudit(config, invariantDenial, input, nowIso);
    } catch {
      // The denial stands regardless of audit-write outcome.
    }
    return {
      status: "blocked",
      decision: invariantDenial,
      error_code: blockedErrorCode(invariantDenial),
      message: invariantDenial.message,
    };
  }

  const decision = checkProposalApplyPolicy(input, role, supportedTypes);
  decision.metadata_json = sanitizePolicyMetadata({
    ...(input.metadata_json ?? {}),
    ...(decision.metadata_json ?? {}),
    decision_source: "check_proposal_apply_policy",
  });

  if (decision.decision !== "allow") {
    try {
      await writeProposalAudit(config, decision, input, nowIso);
    } catch {
      // The denial stands regardless of audit-write outcome.
    }
    return {
      status: "blocked",
      decision,
      error_code: blockedErrorCode(decision),
      message: decision.message,
    };
  }

  // ALLOW — proposal.apply is FAIL_CLOSED: a failed audit write blocks the apply.
  try {
    await writeProposalAudit(config, decision, input, nowIso);
  } catch {
    return {
      status: "error",
      error_code: "policy_audit_persist_failed",
      message: `Durable audit write failed (fail_closed) for proposal.apply`,
    };
  }
  return { status: "allow", decision };
}

async function writeProposalAudit(
  config: PolicyEnforcementConfig,
  decision: PolicyDecision,
  input: ProposalApplyInput,
  nowIso: string,
): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error("policy enforcement requires SERVER_DATABASE_URL");
  }
  await writePolicyAudit(config.databaseUrl, {
    space_id: input.space_id,
    actor_type: "user",
    actor_id: input.user_id,
    actor_ref_json: null,
    action: "proposal.apply",
    resource_type: "proposal",
    resource_id: input.proposal_id,
    decision: decision.decision,
    risk_level: decision.risk_level,
    required_approver_role: decision.required_approver_role ?? null,
    approval_capability: decision.approval_capability ?? null,
    policy_rule_id: decision.policy_rule_id ?? null,
    policy_source: decision.policy_source ?? null,
    policy_id: decision.policy_id ?? null,
    audit_code: decision.audit_code ?? null,
    run_id: null,
    proposal_id: input.proposal_id,
    metadata_json: decision.metadata_json ?? null,
    created_at: nowIso,
  });
}
