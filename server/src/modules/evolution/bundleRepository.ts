import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "../../db/pool.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { HttpError, optionalString, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import type { ProposalTransactionResult } from "../proposals/applyService.js";
import { lockEvolutionAssets } from "./assetLocks.js";
import { stableJsonStringify } from "./hash.js";

const RISK_ORDER = ["low", "medium", "high", "critical"] as const;

type BundleRisk = typeof RISK_ORDER[number];
type BundleMemberDecision = "approve" | "reject";

export interface EvolutionBundleDecision {
  proposalId: string;
  decision: BundleMemberDecision;
  note?: string | null;
}

export interface ProposalDecisionPort {
  acceptInTransaction(
    client: PoolClient,
    proposalId: string,
    identity: SpaceUserIdentity,
    options?: { allowBundleMemberDecision?: boolean },
    afterApply?: () => Promise<void>,
  ): Promise<ProposalTransactionResult<unknown> | null>;
  rejectInTransaction(
    client: PoolClient,
    proposalId: string,
    identity: SpaceUserIdentity,
    afterReject: () => Promise<void>,
  ): Promise<ProposalTransactionResult<unknown> | null>;
}

interface BundleRow {
  id: string;
  space_id: string;
  title: string;
  description: string | null;
  status: string;
  risk_level: string;
  created_by_user_id: string;
  created_at: unknown;
  updated_at: unknown;
  decided_at: unknown;
  rolled_back_at: unknown;
  rollback_error: string | null;
}

interface BundleMemberRow {
  id: string;
  bundle_id: string;
  proposal_id: string;
  position: number;
  status: string;
  decision_note: string | null;
  decided_by_user_id: string | null;
  decided_at: unknown;
  before_snapshot_json: unknown;
  after_snapshot_json: unknown;
  created_at: unknown;
  proposal_type: string;
  proposal_status: string;
  proposal_risk_level: string;
  proposal_title: string;
  proposal_summary: string | null;
  proposal_created_at: unknown;
}

interface ProposalSelectionRow {
  id: string;
  proposal_type: string;
  status: string;
  risk_level: string;
  title: string;
  summary: string | null;
  payload_json: unknown;
}

interface PromotionVersionSnapshot {
  id: string;
  status: string;
  scope_type: string;
  scope_id: string | null;
  promotion_proposal_id: string | null;
  approved_by_user_id: string | null;
}

interface PromotionPinSnapshot {
  id: string;
  space_id: string;
  asset_id: string;
  scope_type: string;
  scope_id: string;
  version_id: string;
  pinned_by_user_id: string | null;
  reason: string | null;
}

interface PromotionDeploymentSnapshot {
  id: string;
  space_id: string | null;
  asset_id: string;
  scope_type: string;
  scope_id: string | null;
  label: string;
  version_id: string;
  promoted_by_user_id: string | null;
  promoted_from_proposal_id: string | null;
}

interface PromotionSnapshot {
  kind: "evolvable_asset_promotion";
  space_id: string;
  asset_id: string;
  current_system_version_id: string | null;
  versions: PromotionVersionSnapshot[];
  active_pins: PromotionPinSnapshot[];
  active_deployment_refs: PromotionDeploymentSnapshot[];
}

interface UnsupportedSnapshot {
  kind: "unsupported";
  proposal_type: string;
  reason: string;
}

function dateOut(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  return null;
}

function riskValue(value: string | null | undefined): BundleRisk {
  return RISK_ORDER.includes(value as BundleRisk) ? value as BundleRisk : "low";
}

function maxRisk(left: string, right: string): BundleRisk {
  const a = RISK_ORDER.indexOf(riskValue(left));
  const b = RISK_ORDER.indexOf(riskValue(right));
  return RISK_ORDER[Math.max(a, b)] ?? "low";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function snapshotJson(value: unknown): Record<string, unknown> {
  return record(value);
}

function rollbackBlockerForMember(member: BundleMemberRow): string | null {
  if (member.status !== "approved") return null;
  const before = snapshotJson(member.before_snapshot_json);
  const after = snapshotJson(member.after_snapshot_json);
  if (before.kind !== "evolvable_asset_promotion" || after.kind !== "evolvable_asset_promotion") {
    return `Member ${member.proposal_id} has no supported promotion rollback adapter`;
  }
  if (typeof before.asset_id !== "string" || typeof after.asset_id !== "string" || before.asset_id !== after.asset_id) {
    return `Member ${member.proposal_id} has an invalid asset rollback snapshot`;
  }
  return null;
}

function rollbackSummary(
  status: string,
  approvedCount: number,
  blockerCount: number,
): { rollbackable: boolean; rollback_blockers: string[] } {
  if (!['applied', 'partially_approved'].includes(status)) {
    return { rollbackable: false, rollback_blockers: [`Bundle is not rollbackable while ${status}`] };
  }
  if (approvedCount === 0) {
    return { rollbackable: false, rollback_blockers: ["Bundle has no approved members to roll back"] };
  }
  if (blockerCount > 0) {
    return { rollbackable: false, rollback_blockers: ["One or more approved members do not support rollback"] };
  }
  return { rollbackable: true, rollback_blockers: [] };
}

function rollbackSummaryForMembers(
  status: string,
  members: BundleMemberRow[],
): { rollbackable: boolean; rollback_blockers: string[] } {
  const approved = members.filter((member) => member.status === "approved");
  const blockers = approved.map(rollbackBlockerForMember).filter((value): value is string => Boolean(value));
  if (!['applied', 'partially_approved'].includes(status)) {
    return rollbackSummary(status, approved.length, blockers.length);
  }
  if (approved.length === 0) return rollbackSummary(status, 0, 0);
  return { rollbackable: blockers.length === 0, rollback_blockers: blockers };
}

export class EvolutionBundleRepository {
  constructor(private readonly db: Pool) {}

  async create(
    identity: SpaceUserIdentity,
    input: { title: string; description?: string | null; proposalIds: string[] },
  ): Promise<Record<string, unknown>> {
    const title = input.title.trim();
    if (!title) throw new HttpError(422, "title is required");
    const proposalIds = [...new Set(input.proposalIds.map((id) => id.trim()).filter(Boolean))];
    if (proposalIds.length === 0) throw new HttpError(422, "proposal_ids must contain at least one proposal");
    if (proposalIds.length > 50) throw new HttpError(422, "A bundle cannot contain more than 50 proposals");

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<ProposalSelectionRow>(
        `SELECT p.id, p.proposal_type, p.status, p.risk_level, p.title, p.summary, p.payload_json
           FROM proposals p
          WHERE p.space_id = $1
            AND p.id = ANY($2::varchar[])
            AND p.status = 'pending'
            AND ${contentReadSql("proposal", "p", "$3")}
          FOR UPDATE`,
        [identity.spaceId, proposalIds, identity.userId],
      );
      if (selected.rows.length !== proposalIds.length) {
        throw new HttpError(409, "Every proposal must be visible, pending, and belong to the active space");
      }
      if (selected.rows.some((row) => row.proposal_type === "evolution_bundle_rollback")) {
        throw new HttpError(422, "Bundle rollback proposals cannot be nested in another evolution bundle");
      }
      const special = selected.rows
        .map((row) => ({ row, reason: bundleBlockedProposalReason(row) }))
        .find((item) => item.reason);
      if (special?.reason) {
        throw new HttpError(422, special.reason);
      }
      const existingMember = await client.query<{ proposal_id: string; bundle_id: string }>(
        `SELECT proposal_id, bundle_id
           FROM evolution_bundle_members
          WHERE proposal_id = ANY($1::varchar[])
          LIMIT 1
          FOR UPDATE`,
        [proposalIds],
      );
      if (existingMember.rows[0]) {
        throw new HttpError(409, `Proposal ${existingMember.rows[0].proposal_id} already belongs to evolution bundle ${existingMember.rows[0].bundle_id}`);
      }

      const bundleId = randomUUID();
      const now = new Date().toISOString();
      const risk = selected.rows.reduce<BundleRisk>((current, row) => maxRisk(current, row.risk_level), "low");
      await client.query(
        `INSERT INTO evolution_bundles (
           id, space_id, title, description, status, risk_level, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'pending_review', $5, $6, $7, $7)`,
        [bundleId, identity.spaceId, title, input.description?.trim() || null, risk, identity.userId, now],
      );
      for (const [index, proposalId] of proposalIds.entries()) {
        await client.query(
          `INSERT INTO evolution_bundle_members (
             id, bundle_id, proposal_id, position, status, before_snapshot_json, after_snapshot_json, created_at
           ) VALUES ($1, $2, $3, $4, 'pending', '{}'::jsonb, '{}'::jsonb, $5)`,
          [randomUUID(), bundleId, proposalId, index + 1, now],
        );
      }
      await client.query("COMMIT");
      const result = await this.get(identity, bundleId);
      if (!result) throw new HttpError(500, "Evolution bundle was not visible after creation");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(identity: SpaceUserIdentity, limit = 50, offset = 0): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<BundleRow & { member_count: string; pending_count: string; approved_count: string; rollback_blocker_count: string }>(
      `SELECT b.*,
              count(bm.id)::text AS member_count,
              count(*) FILTER (WHERE bm.status = 'pending')::text AS pending_count,
              count(*) FILTER (WHERE bm.status = 'approved')::text AS approved_count,
              count(*) FILTER (WHERE bm.status = 'approved' AND (
                (bm.before_snapshot_json->>'kind') IS DISTINCT FROM 'evolvable_asset_promotion'
                OR (bm.after_snapshot_json->>'kind') IS DISTINCT FROM 'evolvable_asset_promotion'
                OR (bm.before_snapshot_json->>'asset_id') IS NULL
                OR (bm.after_snapshot_json->>'asset_id') IS NULL
                OR (bm.before_snapshot_json->>'asset_id') IS DISTINCT FROM (bm.after_snapshot_json->>'asset_id')
              ))::text AS rollback_blocker_count
         FROM evolution_bundles b
         JOIN evolution_bundle_members bm ON bm.bundle_id = b.id
         JOIN proposals p ON p.id = bm.proposal_id AND p.space_id = b.space_id
        WHERE b.space_id = $1
          AND NOT EXISTS (
            SELECT 1
              FROM evolution_bundle_members hidden_bm
              JOIN proposals hidden_p ON hidden_p.id = hidden_bm.proposal_id
             WHERE hidden_bm.bundle_id = b.id
               AND NOT ${contentReadSql("proposal", "hidden_p", "$2")}
          )
        GROUP BY b.id
        ORDER BY b.updated_at DESC, b.id ASC
        LIMIT $3 OFFSET $4`,
      [identity.spaceId, identity.userId, limit, offset],
    );
    return result.rows.map((row) => this.bundleOut(row));
  }

  async get(identity: SpaceUserIdentity, bundleId: string): Promise<Record<string, unknown> | null> {
    const bundle = await this.db.query<BundleRow>(
      `SELECT b.*
         FROM evolution_bundles b
        WHERE b.id = $1
          AND b.space_id = $2
          AND NOT EXISTS (
            SELECT 1
              FROM evolution_bundle_members hidden_bm
              JOIN proposals hidden_p ON hidden_p.id = hidden_bm.proposal_id
             WHERE hidden_bm.bundle_id = b.id
               AND NOT ${contentReadSql("proposal", "hidden_p", "$3")}
          )
        LIMIT 1`,
      [bundleId, identity.spaceId, identity.userId],
    );
    const row = bundle.rows[0];
    if (!row) return null;
    const members = await this.memberRows(identity, bundleId);
    const counts = members.reduce(
      (out, member) => {
        out.member_count += 1;
        if (member.status === "pending") out.pending_count += 1;
        if (member.status === "approved") out.approved_count += 1;
        return out;
      },
      { member_count: 0, pending_count: 0, approved_count: 0 },
    );
    return {
      ...this.bundleOut({ ...row, ...counts }),
      members: members.map((member) => this.memberOut(member)),
      ...rollbackSummaryForMembers(row.status, members),
    };
  }

  async member(identity: SpaceUserIdentity, bundleId: string, proposalId: string): Promise<BundleMemberRow | null> {
    return this.memberFromDb(this.db, identity, bundleId, proposalId, false);
  }

  private async memberFromDb(
    db: Queryable,
    identity: SpaceUserIdentity,
    bundleId: string,
    proposalId: string,
    forUpdate: boolean,
  ): Promise<BundleMemberRow | null> {
    const result = await db.query<BundleMemberRow>(
      `SELECT bm.*, p.proposal_type, p.status AS proposal_status, p.risk_level AS proposal_risk_level,
              p.title AS proposal_title, p.summary AS proposal_summary, p.created_at AS proposal_created_at
         FROM evolution_bundle_members bm
         JOIN evolution_bundles b ON b.id = bm.bundle_id AND b.space_id = $1
         JOIN proposals p ON p.id = bm.proposal_id AND p.space_id = b.space_id
        WHERE bm.bundle_id = $2
          AND bm.proposal_id = $3
          AND ${contentReadSql("proposal", "p", "$4")}
        LIMIT 1${forUpdate ? " FOR UPDATE OF bm, p" : ""}`,
      [identity.spaceId, bundleId, proposalId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  async captureMemberSnapshot(
    identity: SpaceUserIdentity,
    bundleId: string,
    proposalId: string,
  ): Promise<Record<string, unknown>> {
    const member = await this.member(identity, bundleId, proposalId);
    if (!member) throw new HttpError(404, "Evolution bundle member not found");
    return this.captureSnapshotForProposal(this.db, identity.spaceId, proposalId, member.proposal_type);
  }

  private async recordMemberDecisionOnDb(
    db: Queryable,
    identity: SpaceUserIdentity,
    bundleId: string,
    proposalId: string,
    status: "approved" | "rejected",
    note: string | null,
    beforeSnapshot: Record<string, unknown> | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    const afterSnapshot = status === "approved"
      ? await this.captureSnapshotForProposal(db, identity.spaceId, proposalId, null)
      : {};
    const result = await db.query(
      `UPDATE evolution_bundle_members
          SET status = $4,
              decision_note = $5,
              decided_by_user_id = $6,
              decided_at = $7,
              before_snapshot_json = $8::jsonb,
              after_snapshot_json = $9::jsonb
        WHERE bundle_id = $1 AND proposal_id = $2 AND status = 'pending'
          AND EXISTS (SELECT 1 FROM evolution_bundles b WHERE b.id = $1 AND b.space_id = $3)`,
      [bundleId, proposalId, identity.spaceId, status, note, identity.userId, now, JSON.stringify(beforeSnapshot ?? {}), JSON.stringify(afterSnapshot)],
    );
    if ((result.rowCount ?? 0) !== 1) throw new HttpError(409, "Bundle member was already decided");
    await this.refreshBundleStatus(db, bundleId, identity.spaceId);
  }

  async decide(
    identity: SpaceUserIdentity,
    bundleId: string,
    decisions: EvolutionBundleDecision[],
    proposalService: ProposalDecisionPort,
  ): Promise<Record<string, unknown>> {
    const lock = await this.db.connect();
    const lockKey = `evolution_bundle:${bundleId}`;
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      return await this.decideUnlocked(identity, bundleId, decisions, proposalService);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
      lock.release();
    }
  }

  private async decideUnlocked(
    identity: SpaceUserIdentity,
    bundleId: string,
    decisions: EvolutionBundleDecision[],
    proposalService: ProposalDecisionPort,
  ): Promise<Record<string, unknown>> {
    const unique = new Map<string, EvolutionBundleDecision>();
    for (const decision of decisions) {
      if (!decision.proposalId || !["approve", "reject"].includes(decision.decision)) {
        throw new HttpError(422, "Each decision requires proposal_id and decision=approve|reject");
      }
      unique.set(decision.proposalId, decision);
    }
    if (unique.size === 0) throw new HttpError(422, "decisions must contain at least one member decision");
    const initial = await this.get(identity, bundleId);
    if (!initial) throw new HttpError(404, "Evolution bundle not found");
    if (["rolled_back", "rollback_failed", "applied", "rejected"].includes(String(initial.status))) {
      throw new HttpError(409, `Evolution bundle is already ${String(initial.status)}`);
    }

    const client = await this.db.connect();
    try {
      for (const decision of unique.values()) {
        await client.query("BEGIN");
        let transactionResult: ProposalTransactionResult<unknown> | null = null;
        try {
          const lockedBundle = await client.query<{ status: string }>(
            `SELECT status FROM evolution_bundles WHERE id = $1 AND space_id = $2 FOR UPDATE`,
            [bundleId, identity.spaceId],
          );
          if (!lockedBundle.rows[0]) throw new HttpError(404, "Evolution bundle not found");
          if (["rolled_back", "rollback_failed", "applied", "rejected"].includes(lockedBundle.rows[0].status)) {
            throw new HttpError(409, `Evolution bundle is already ${lockedBundle.rows[0].status}`);
          }
          const member = await this.memberFromDb(client, identity, bundleId, decision.proposalId, true);
          if (!member) throw new HttpError(404, "Evolution bundle member not found");
          if (member.status !== "pending") {
            await client.query("COMMIT");
            continue;
          }
          const before = decision.decision === "approve"
            ? await this.captureSnapshotForProposal(client, identity.spaceId, decision.proposalId, member.proposal_type)
            : {};
          const onDecision = async () => this.recordMemberDecisionOnDb(
            client,
            identity,
            bundleId,
            decision.proposalId,
            decision.decision === "approve" ? "approved" : "rejected",
            decision.note ?? null,
            before,
          );
          transactionResult = decision.decision === "approve"
            ? await proposalService.acceptInTransaction(
                client,
                decision.proposalId,
                identity,
                { allowBundleMemberDecision: true },
                onDecision,
              )
            : await proposalService.rejectInTransaction(client, decision.proposalId, identity, onDecision);
          if (!transactionResult) throw new HttpError(409, "Proposal was no longer pending or visible");
          await this.refreshBundleStatus(client, bundleId, identity.spaceId);
          await client.query("COMMIT");
          if (transactionResult.postCommit) await transactionResult.postCommit().catch(() => undefined);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          if (transactionResult?.rollback) await transactionResult.rollback().catch(() => undefined);
          throw error;
        }
      }
    } finally {
      client.release();
    }
    const updated = await this.get(identity, bundleId);
    if (!updated) throw new HttpError(500, "Evolution bundle disappeared after decision");
    return updated;
  }

  async requestRollback(
    identity: SpaceUserIdentity,
    bundleId: string,
    proposalService: ProposalDecisionPort,
  ): Promise<Record<string, unknown>> {
    const lock = await this.db.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext($1))", [`evolution_bundle:${bundleId}`]);
      const visible = await this.get(identity, bundleId);
      if (!visible) throw new HttpError(404, "Evolution bundle not found");
      if (visible.status === "rolled_back") return visible;
      const client = await this.db.connect();
      let transactionResult: ProposalTransactionResult<unknown> | null = null;
      try {
        await client.query("BEGIN");
        const bundle = await client.query<BundleRow>(
          `SELECT b.*
             FROM evolution_bundles b
            WHERE b.id = $1 AND b.space_id = $2
            FOR UPDATE`,
          [bundleId, identity.spaceId],
        );
        const row = bundle.rows[0];
        if (!row) throw new HttpError(404, "Evolution bundle not found");
        if (row.status === "rolled_back") {
          await client.query("COMMIT");
          const alreadyRolledBack = await this.get(identity, bundleId);
          if (!alreadyRolledBack) throw new HttpError(404, "Evolution bundle not found");
          return alreadyRolledBack;
        }

        const members = await this.memberRowsFromDb(client, identity, bundleId);
        const assessment = rollbackSummaryForMembers(row.status, members);
        if (!assessment.rollbackable) {
          const message = `Rollback preflight failed: ${assessment.rollback_blockers.join("; ")}`;
          throw new HttpError(409, message, {
            detail: message,
            rollbackable: false,
            rollback_blockers: assessment.rollback_blockers,
          });
        }

        const systemScoped = await this.hasSystemScopedPromotion(client, bundleId, identity.spaceId);
        const pending = await client.query<{ id: string }>(
          `SELECT id
             FROM proposals
            WHERE space_id = $1
              AND proposal_type = 'evolution_bundle_rollback'
              AND status = 'pending'
              AND payload_json->>'bundle_id' = $2
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            FOR UPDATE`,
          [identity.spaceId, bundleId],
        );
        const rollbackProposal = pending.rows[0]
          ? { id: pending.rows[0].id }
          : await insertProposalRow(client, {
              spaceId: identity.spaceId,
              proposalType: "evolution_bundle_rollback",
              title: `Roll back evolution bundle: ${String(row.title)}`,
              summary: "Restore the approved evolution bundle members to their recorded pre-apply version set.",
              payload: {
                proposal_type: "evolution_bundle_rollback",
                bundle_id: bundleId,
                approved_member_count: members.filter((member) => member.status === "approved").length,
              },
              rationale: "Bundle rollback requires the standard proposal.apply policy gate and durable audit trail.",
              createdByUserId: identity.userId,
              visibility: "space_shared",
              riskLevel: systemScoped ? "critical" : "high",
              requiredApproverRole: systemScoped ? "owner" : null,
            });
        transactionResult = await proposalService.acceptInTransaction(
          client,
          rollbackProposal.id,
          identity,
        );
        if (!transactionResult) throw new HttpError(409, "Rollback proposal was no longer pending or visible");
        await client.query("COMMIT");
        if (transactionResult.postCommit) await transactionResult.postCommit().catch(() => undefined);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (transactionResult?.rollback) await transactionResult.rollback().catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const result = await this.get(identity, bundleId);
      if (!result) throw new HttpError(500, "Evolution bundle disappeared after rollback proposal apply");
      return result;
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`evolution_bundle:${bundleId}`]).catch(() => undefined);
      lock.release();
    }
  }

  private async hasSystemScopedPromotion(db: Queryable, bundleId: string, spaceId: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM evolution_bundle_members bm
           JOIN proposals p ON p.id = bm.proposal_id AND p.space_id = $2
          WHERE bm.bundle_id = $1
            AND bm.status = 'approved'
            AND p.proposal_type = 'evolvable_asset_version_promote'
            AND p.payload_json->>'target_scope_type' = 'system'
       ) AS exists`,
      [bundleId, spaceId],
    );
    return result.rows[0]?.exists === true;
  }

  private async memberRows(identity: SpaceUserIdentity, bundleId: string): Promise<BundleMemberRow[]> {
    return this.memberRowsFromDb(this.db, identity, bundleId);
  }

  private async memberRowsFromDb(db: Queryable, identity: SpaceUserIdentity, bundleId: string): Promise<BundleMemberRow[]> {
    const result = await db.query<BundleMemberRow>(
      `SELECT bm.*, p.proposal_type, p.status AS proposal_status, p.risk_level AS proposal_risk_level,
              p.title AS proposal_title, p.summary AS proposal_summary, p.created_at AS proposal_created_at
         FROM evolution_bundle_members bm
         JOIN evolution_bundles b ON b.id = bm.bundle_id AND b.id = $1 AND b.space_id = $2
         JOIN proposals p ON p.id = bm.proposal_id AND p.space_id = b.space_id
        WHERE ${contentReadSql("proposal", "p", "$3")}
        ORDER BY bm.position ASC`,
      [bundleId, identity.spaceId, identity.userId],
    );
    return result.rows;
  }

  private async refreshBundleStatus(db: Queryable, bundleId: string, spaceId: string): Promise<void> {
    const result = await db.query<{ pending_count: string; approved_count: string; rejected_count: string }>(
      `SELECT count(*) FILTER (WHERE bm.status = 'pending')::text AS pending_count,
              count(*) FILTER (WHERE bm.status = 'approved')::text AS approved_count,
              count(*) FILTER (WHERE bm.status = 'rejected')::text AS rejected_count
         FROM evolution_bundle_members bm
         JOIN evolution_bundles b ON b.id = bm.bundle_id AND b.space_id = $1
        WHERE bm.bundle_id = $2`,
      [spaceId, bundleId],
    );
    const counts = result.rows[0];
    if (!counts) return;
    const pending = Number(counts.pending_count);
    const approved = Number(counts.approved_count);
    const rejected = Number(counts.rejected_count);
    const status = pending > 0
      ? approved > 0 ? "partially_approved" : "pending_review"
      : approved > 0 ? "applied" : rejected > 0 ? "rejected" : "pending_review";
    await db.query(
      `UPDATE evolution_bundles
          SET status = $3::varchar,
              decided_at = CASE WHEN $3::varchar IN ('applied','rejected')
                                THEN COALESCE(decided_at, $4::timestamptz)
                                ELSE decided_at END,
              updated_at = $4::timestamptz
        WHERE id = $1 AND space_id = $2`,
      [bundleId, spaceId, status, new Date().toISOString()],
    );
  }

  private async captureSnapshotForProposal(
    db: Queryable,
    spaceId: string,
    proposalId: string,
    expectedProposalType: string | null,
  ): Promise<Record<string, unknown>> {
    const proposal = await db.query<{ proposal_type: string; payload_json: unknown }>(
      `SELECT proposal_type, payload_json FROM proposals WHERE id = $1 AND space_id = $2 LIMIT 1`,
      [proposalId, spaceId],
    );
    const row = proposal.rows[0];
    if (!row) throw new HttpError(404, "Proposal not found in this space");
    if (expectedProposalType && expectedProposalType !== row.proposal_type) {
      throw new HttpError(409, "Proposal type changed while deciding the bundle");
    }
    if (row.proposal_type !== "evolvable_asset_version_promote") {
      return {
        kind: "unsupported",
        proposal_type: row.proposal_type,
        reason: "Only evolvable asset version promotions have a durable version-set rollback adapter.",
      } satisfies UnsupportedSnapshot;
    }
    const payload = record(row.payload_json);
    const assetId = optionalString(payload.asset_id);
    if (!assetId) throw new HttpError(422, "Promotion proposal is missing asset_id");
    // The snapshot is the rollback boundary. It must be captured while the
    // same asset-level lock used by promotion apply and rollback is held;
    // otherwise another promotion could commit between the snapshot read and
    // the applier's lock acquisition.
    await lockEvolutionAssets(db, [assetId]);
    const asset = await db.query<{ current_system_version_id: string | null }>(
      `SELECT current_system_version_id FROM evolvable_assets WHERE id = $1 AND (space_id = $2 OR space_id IS NULL) LIMIT 1`,
      [assetId, spaceId],
    );
    const assetRow = asset.rows[0];
    if (!assetRow) throw new HttpError(404, "Promotion asset not found in this space");
    const versions = await db.query<PromotionVersionSnapshot>(
      `SELECT id, status, scope_type, scope_id, promotion_proposal_id, approved_by_user_id
         FROM evolvable_asset_versions
        WHERE asset_id = $1
        ORDER BY version ASC, id ASC`,
      [assetId],
    );
    const pins = await db.query<PromotionPinSnapshot>(
      `SELECT id, space_id, asset_id, scope_type, scope_id, version_id, pinned_by_user_id, reason
         FROM evolvable_asset_pins
        WHERE asset_id = $1 AND space_id = $2 AND status = 'active'
        ORDER BY scope_type ASC, scope_id ASC, id ASC`,
      [assetId, spaceId],
    );
    const deployments = await db.query<PromotionDeploymentSnapshot>(
      `SELECT id, space_id, asset_id, scope_type, scope_id, label, version_id, promoted_by_user_id, promoted_from_proposal_id
         FROM prompt_deployment_refs
        WHERE asset_id = $1 AND status = 'active'
        ORDER BY label ASC, scope_type ASC, scope_id ASC NULLS FIRST, id ASC`,
      [assetId],
    );
    return {
      kind: "evolvable_asset_promotion",
      space_id: spaceId,
      asset_id: assetId,
      current_system_version_id: assetRow.current_system_version_id,
      versions: versions.rows,
      active_pins: pins.rows,
      active_deployment_refs: deployments.rows,
    } satisfies PromotionSnapshot;
  }

  private bundleOut(row: BundleRow & { member_count?: string | number; pending_count?: string | number; approved_count?: string | number; rollback_blocker_count?: string | number }): Record<string, unknown> {
    const rollback = rollbackSummary(
      row.status,
      Number(row.approved_count ?? 0),
      Number(row.rollback_blocker_count ?? 0),
    );
    return {
      id: row.id,
      space_id: row.space_id,
      title: row.title,
      description: row.description,
      status: row.status,
      risk_level: row.risk_level,
      created_by_user_id: row.created_by_user_id,
      created_at: dateOut(row.created_at),
      updated_at: dateOut(row.updated_at),
      decided_at: dateOut(row.decided_at),
      rolled_back_at: dateOut(row.rolled_back_at),
      rollback_error: row.rollback_error,
      member_count: Number(row.member_count ?? 0),
      pending_count: Number(row.pending_count ?? 0),
      approved_count: Number(row.approved_count ?? 0),
      rollbackable: rollback.rollbackable,
      rollback_blockers: rollback.rollback_blockers,
    };
  }

  private memberOut(row: BundleMemberRow): Record<string, unknown> {
    const rollbackBlocker = row.status === "approved" ? rollbackBlockerForMember(row) : null;
    return {
      id: row.id,
      bundle_id: row.bundle_id,
      proposal_id: row.proposal_id,
      position: row.position,
      status: row.status,
      decision_note: row.decision_note,
      decided_by_user_id: row.decided_by_user_id,
      decided_at: dateOut(row.decided_at),
      created_at: dateOut(row.created_at),
      before_snapshot_available: Object.keys(snapshotJson(row.before_snapshot_json)).length > 0,
      after_snapshot_available: Object.keys(snapshotJson(row.after_snapshot_json)).length > 0,
      rollback_supported: row.status === "approved" ? rollbackBlocker === null : null,
      rollback_blocker: rollbackBlocker,
      proposal: {
        id: row.proposal_id,
        proposal_type: row.proposal_type,
        status: row.proposal_status,
        risk_level: row.proposal_risk_level,
        title: row.proposal_title,
        summary: row.proposal_summary,
        created_at: dateOut(row.proposal_created_at),
      },
    };
  }
}

function bundleBlockedProposalReason(row: ProposalSelectionRow): string | null {
  const payload = row.payload_json && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)
    ? row.payload_json as Record<string, unknown>
    : {};
  if (row.proposal_type === "egress_review"
    || payload.requires_approval_type === "egress_granting_user"
    || typeof payload.grant_id === "string") {
    return `Proposal ${row.id} requires granting-user egress approval and cannot be placed in an evolution bundle`;
  }
  if (row.proposal_type === "code_patch" && payload.incomplete_patch === true) {
    return `Proposal ${row.id} is an incomplete code patch and requires explicit confirmation outside an evolution bundle`;
  }
  return null;
}

export async function applyEvolutionBundleRollback(
  db: Queryable,
  identity: SpaceUserIdentity,
  bundleId: string,
  rollbackProposalId: string,
): Promise<void> {
  const bundle = await db.query<{ title: string; status: string }>(
    `SELECT title, status
       FROM evolution_bundles
      WHERE id = $1 AND space_id = $2
      FOR UPDATE`,
    [bundleId, identity.spaceId],
  );
  const row = bundle.rows[0];
  if (!row) throw new HttpError(404, "Evolution bundle not found");
  if (row.status === "rolled_back") return;
  if (!["applied", "partially_approved"].includes(row.status)) {
    throw new HttpError(409, `Evolution bundle is not rollbackable while ${row.status}`);
  }

  const members = await db.query<BundleMemberRow>(
    `SELECT bm.*, p.proposal_type, p.status AS proposal_status, p.risk_level AS proposal_risk_level,
            p.title AS proposal_title, p.summary AS proposal_summary, p.created_at AS proposal_created_at
       FROM evolution_bundle_members bm
       JOIN proposals p ON p.id = bm.proposal_id AND p.space_id = $2
      WHERE bm.bundle_id = $1 AND bm.status = 'approved'
      ORDER BY bm.position DESC
      FOR UPDATE OF bm`,
    [bundleId, identity.spaceId],
  );
  if (members.rows.length === 0) throw new HttpError(409, "Evolution bundle has no approved members to roll back");
  const assetIds = new Set<string>();
  for (const member of members.rows) {
    const before = snapshotJson(member.before_snapshot_json);
    const after = snapshotJson(member.after_snapshot_json);
    if (before.kind !== "evolvable_asset_promotion" || after.kind !== "evolvable_asset_promotion") {
      throw new HttpError(409, `Proposal ${member.proposal_id} has no supported rollback snapshot`);
    }
    if (typeof after.asset_id !== "string" || !after.asset_id) {
      throw new HttpError(409, `Proposal ${member.proposal_id} has an invalid rollback snapshot`);
    }
    assetIds.add(after.asset_id);
  }
  await lockEvolutionAssets(db, assetIds);

  const now = new Date().toISOString();
  for (const member of members.rows) {
    await restorePromotionSnapshot(db, snapshotJson(member.before_snapshot_json), snapshotJson(member.after_snapshot_json));
    await db.query(
      `UPDATE evolution_bundle_members
          SET status = 'rolled_back', decided_at = COALESCE(decided_at, $2), decision_note = COALESCE(decision_note, 'rolled back')
        WHERE id = $1`,
      [member.id, now],
    );
  }
  await db.query(
    `UPDATE evolution_bundle_members
        SET status = 'released', decision_note = COALESCE(decision_note, 'released when bundle rollback completed'), decided_at = COALESCE(decided_at, $2)
      WHERE bundle_id = $1 AND status = 'pending'`,
    [bundleId, now],
  );
  await db.query(
    `UPDATE evolution_bundles
        SET status = 'rolled_back', rolled_back_at = $3, updated_at = $3, rollback_error = NULL
      WHERE id = $1 AND space_id = $2`,
    [bundleId, identity.spaceId, now],
  );
  await db.query(
    `INSERT INTO activity_records (
       id, space_id, source_run_id, user_id, activity_type, title, content,
       payload_json, occurred_at, created_at, status, updated_at,
       source_kind, source_trust, visibility, owner_user_id
     ) VALUES ($1, $2, NULL, $3, 'evolution.bundle.rolled_back', $4, $5,
       $6::jsonb, $7, $7, 'processed', $7, 'system_event', 'internal_system', 'space_shared', $3)`,
    [
      randomUUID(),
      identity.spaceId,
      identity.userId,
      `Rolled back evolution bundle: ${row.title}`,
      `Restored approved members from evolution bundle ${bundleId} in reverse order.`,
      JSON.stringify({
        bundle_id: bundleId,
        rollback_proposal_id: rollbackProposalId,
        member_ids: members.rows.map((member) => member.id),
        proposal_ids: members.rows.map((member) => member.proposal_id),
      }),
      now,
    ],
  );
}

async function restorePromotionSnapshot(
  client: Queryable,
  beforeValue: Record<string, unknown>,
  afterValue: Record<string, unknown>,
): Promise<void> {
  const before = beforeValue as unknown as PromotionSnapshot;
  const after = afterValue as unknown as PromotionSnapshot;
  if (before.kind !== "evolvable_asset_promotion" || after.kind !== "evolvable_asset_promotion") {
    throw new HttpError(409, "Bundle contains an unsupported rollback snapshot");
  }
  const current = await capturePromotionSnapshot(client, after.asset_id, after.space_id);
  if (stableJsonStringify(current) !== stableJsonStringify(after)) {
    throw new HttpError(409, `Asset ${after.asset_id} changed after bundle apply; refusing unsafe rollback`);
  }
  const now = new Date().toISOString();
  for (const version of before.versions) {
    await client.query(
      `UPDATE evolvable_asset_versions
          SET status = $2, scope_type = $3, scope_id = $4, promotion_proposal_id = $5,
              approved_by_user_id = $6, updated_at = $7
        WHERE id = $1 AND asset_id = $8`,
      [version.id, version.status, version.scope_type, version.scope_id, version.promotion_proposal_id, version.approved_by_user_id, now, before.asset_id],
    );
  }
  await client.query(`UPDATE evolvable_assets SET current_system_version_id = $2, updated_at = $3 WHERE id = $1`, [before.asset_id, before.current_system_version_id, now]);
  await client.query(`UPDATE evolvable_asset_pins SET status = 'archived', updated_at = $3 WHERE asset_id = $1 AND space_id = $2 AND status = 'active'`, [before.asset_id, before.space_id, now]);
  for (const pin of before.active_pins) {
    await client.query(
      `INSERT INTO evolvable_asset_pins (id, space_id, asset_id, scope_type, scope_id, version_id, status, pinned_by_user_id, reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$9)
       ON CONFLICT (id) DO UPDATE SET status='active', version_id=EXCLUDED.version_id, pinned_by_user_id=EXCLUDED.pinned_by_user_id, reason=EXCLUDED.reason, updated_at=EXCLUDED.updated_at`,
      [pin.id, pin.space_id, pin.asset_id, pin.scope_type, pin.scope_id, pin.version_id, pin.pinned_by_user_id, pin.reason, now],
    );
  }
  await client.query(`UPDATE prompt_deployment_refs SET status = 'archived', updated_at = $2 WHERE asset_id = $1 AND status = 'active'`, [before.asset_id, now]);
  for (const ref of before.active_deployment_refs) {
    await client.query(
      `INSERT INTO prompt_deployment_refs (id, space_id, asset_id, scope_type, scope_id, label, version_id, status, promoted_by_user_id, promoted_from_proposal_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$10)
       ON CONFLICT (id) DO UPDATE SET status='active', version_id=EXCLUDED.version_id, promoted_by_user_id=EXCLUDED.promoted_by_user_id, promoted_from_proposal_id=EXCLUDED.promoted_from_proposal_id, updated_at=EXCLUDED.updated_at`,
      [ref.id, ref.space_id, ref.asset_id, ref.scope_type, ref.scope_id, ref.label, ref.version_id, ref.promoted_by_user_id, ref.promoted_from_proposal_id, now],
    );
  }
}

async function capturePromotionSnapshot(client: Queryable, assetId: string, spaceId: string | null): Promise<PromotionSnapshot> {
  const asset = await client.query<{ current_system_version_id: string | null }>(`SELECT current_system_version_id FROM evolvable_assets WHERE id = $1`, [assetId]);
  const versions = await client.query<PromotionVersionSnapshot>(`SELECT id, status, scope_type, scope_id, promotion_proposal_id, approved_by_user_id FROM evolvable_asset_versions WHERE asset_id = $1 ORDER BY version ASC, id ASC`, [assetId]);
  const pins = spaceId
    ? await client.query<PromotionPinSnapshot>(`SELECT id, space_id, asset_id, scope_type, scope_id, version_id, pinned_by_user_id, reason FROM evolvable_asset_pins WHERE asset_id = $1 AND space_id = $2 AND status = 'active' ORDER BY scope_type ASC, scope_id ASC, id ASC`, [assetId, spaceId])
    : { rows: [] as PromotionPinSnapshot[] };
  const deployments = await client.query<PromotionDeploymentSnapshot>(`SELECT id, space_id, asset_id, scope_type, scope_id, label, version_id, promoted_by_user_id, promoted_from_proposal_id FROM prompt_deployment_refs WHERE asset_id = $1 AND status = 'active' ORDER BY label ASC, scope_type ASC, scope_id ASC NULLS FIRST, id ASC`, [assetId]);
  return {
    kind: "evolvable_asset_promotion",
    space_id: spaceId ?? "",
    asset_id: assetId,
    current_system_version_id: asset.rows[0]?.current_system_version_id ?? null,
    versions: versions.rows,
    active_pins: pins.rows,
    active_deployment_refs: deployments.rows,
  };
}
