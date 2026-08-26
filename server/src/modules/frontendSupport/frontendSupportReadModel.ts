import { HttpError, intQuery } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import type { HomeSummaryOut } from "./frontendSupportTypes.js";

export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_for_review"];
export const DONE_TASK_STATUSES = ["done", "completed", "cancelled", "archived"];
export const REVIEW_TASK_STATUSES = ["needs_review", "review", "in_review"];

export function boundedQueryInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = intQuery(value, fallback);
  if (parsed === null || parsed < min || parsed > max) {
    throw new HttpError(422, `limit must be between ${min} and ${max}`);
  }
  return parsed;
}

export function runReadSql(userParam: string): string {
  return contentReadSql("run", "r", userParam);
}

export function proposalReadSql(userParam: string): string {
  return contentReadSql("proposal", "p", userParam);
}

export function artifactReadSql(userParam: string): string {
  return contentReadSql("artifact", "a", userParam);
}

export function taskReadSql(userParam: string): string {
  return contentReadSql("task", "t", userParam);
}

export function proposalVisibleSelect(): string {
  return `SELECT p.id, p.space_id, p.proposal_type, p.status, p.urgency,
                 p.title, p.visibility, p.created_by_user_id,
                 p.created_at, p.updated_at
            FROM proposals p
            JOIN space_memberships sm
              ON sm.space_id = p.space_id
             AND sm.status = 'active'
            LEFT JOIN runs run_for_instructed
              ON run_for_instructed.id = p.created_by_run_id
             AND run_for_instructed.space_id = p.space_id`;
}

export function suggestedActions(input: {
  pendingCount: number;
  retryableJobs: number;
  missingModelProvider: boolean;
}): HomeSummaryOut["suggested_actions"] {
  const actions: HomeSummaryOut["suggested_actions"] = [];
  if (input.pendingCount > 0) {
    actions.push({
      id: "review_pending_proposals",
      label: "Review pending proposals",
      reason: `${input.pendingCount} proposal(s) are waiting for review.`,
      target_path: "/proposals?status=pending",
      priority: input.pendingCount >= 5 ? "high" : "normal",
    });
  }
  if (input.retryableJobs > 0) {
    actions.push({
      id: "retry_failed_jobs",
      label: "Review failed jobs",
      reason: `${input.retryableJobs} failed job(s) can be retried.`,
      target_path: "/jobs?status=failed",
      priority: "normal",
    });
  }
  if (input.missingModelProvider) {
    actions.push({
      id: "configure_model_provider",
      label: "Configure model provider",
      reason: "No enabled model provider is configured for this space.",
      target_path: "/providers",
      priority: "high",
    });
  }
  return actions;
}

export function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function iso(value: unknown): string {
  return isoOrNull(value) ?? new Date(0).toISOString();
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}
