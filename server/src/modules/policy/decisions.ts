/**
 * Policy decision value objects and risk-rank helpers.
 *
 * `PolicyDecision` mirrors the wire schema (`@agent-space/protocol` `policy.ts`)
 * field-for-field (snake_case) so a decision serializes directly to the
 * `PolicyDecisionSchema` contract.
 */

import type {
  PolicyDecisionValue,
  PolicyRiskLevel,
} from "@agent-space/protocol";

export type Decision = PolicyDecisionValue; // "allow" | "deny" | "require_approval"
export type RiskLevel = PolicyRiskLevel; // "low" | "medium" | "high" | "critical"

export interface PolicyDecision {
  decision: Decision;
  message: string;
  risk_level: RiskLevel;
  reason_code?: string | null;
  required_approver_role?: string | null;
  policy_rule_id?: string | null;
  policy_source: string;
  policy_id?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
  actor_ref?: Record<string, unknown> | null;
  space_id?: string | null;
  action?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  audit_code?: string | null;
  approval_capability?: string | null;
  proposal_type?: string | null;
  metadata_json?: Record<string, unknown> | null;
  created_at?: string | null;
}

/**
 * Build a `PolicyDecision` with the public contract defaults
 * (`risk_level=low`, `policy_source=builtin`). Only `decision` and `message`
 * are required; everything else is optional.
 */
export function makeDecision(
  fields: Partial<PolicyDecision> & {
    decision: Decision;
    message: string;
  },
): PolicyDecision {
  return {
    risk_level: "low",
    policy_source: "builtin",
    ...fields,
  };
}

export function isAllowed(d: PolicyDecision): boolean {
  return d.decision === "allow";
}
export function isDenied(d: PolicyDecision): boolean {
  return d.decision === "deny";
}
export function requiresApproval(d: PolicyDecision): boolean {
  return d.decision === "require_approval";
}

export const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const VALID_RISK_LEVELS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "critical",
]);

/**
 * Stable single-value repr for policy messages: single quotes by default,
 * double quotes when the value contains a single quote but no double quote,
 * with backslash/quote escaping. Compatibility fixtures pin this format.
 */
export function pyRepr(value: string): string {
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  const body = value
    .replace(/\\/g, "\\\\")
    .split(quote)
    .join("\\" + quote);
  return quote + body + quote;
}
