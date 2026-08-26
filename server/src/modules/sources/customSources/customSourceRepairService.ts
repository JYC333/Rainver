import type { CustomSourcePolicyEnvelope } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { HttpError, optionalString, withDbTransaction, type Pool, type SpaceUserIdentity } from "../../routeUtils/common.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import {
  HANDLER_VERSION_COLUMNS,
  PgCustomSourceHandlerRepository,
  handlerVersionOut,
  type HandlerVersionRow,
} from "./customSourceHandlerRepository.js";
import {
  CustomSourceCreateFlowService,
  activateCustomSourceHandlerVersion,
  customSourceProposalPayload,
  customSourceProposalReviewText,
  customSourceProposalRisk,
  customSourceProposalTypeForEnvelope,
  evaluateCustomSourceActivation,
} from "./customSourceCreateFlowService.js";

interface RepairableConnection {
  id: string;
  active_handler_version_id: string;
  repair_status: string;
}

/**
 * Phase 9: repair (regenerate + retest + auto-activate-or-propose) and
 * rollback. Repair never mutates the active version in place — it always
 * produces a new draft version through the same `generateHandler`/
 * `testHandler` path `CustomSourceCreateFlowService` already exposes, then
 * decides how to activate it. Reused rather than duplicated:
 * `evaluateCustomSourceActivation` (envelope-delta comparison),
 * `customSourceProposalTypeForEnvelope`/`customSourceProposalPayload`/
 * `customSourceProposalReviewText` (identical proposal routing to a fresh
 * activation's policy-delta branch), and `activateCustomSourceHandlerVersion`
 * (the same DB writes `activateHandler`'s inside-envelope branch performs).
 *
 * `custom_source_repair_activation` proposals (applied by
 * `customSourceProposalApplier.ts`) are only ever created for the
 * envelope-unchanged-but-Space-policy-requires-review case — the applier
 * itself rejects `envelope_unchanged !== true`. A repair whose envelope
 * actually broadens permissions goes through the same
 * `custom_source_policy_delta`/`custom_source_credentialed_source` proposal
 * types a fresh activation would use, not `custom_source_repair_activation`.
 */
export class CustomSourceRepairService {
  private readonly createFlow: CustomSourceCreateFlowService;

  constructor(
    private readonly pool: Pool,
    private readonly config: ServerConfig,
  ) {
    this.createFlow = new CustomSourceCreateFlowService(pool, config);
  }

  async repairHandler(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const connection = await this.requireRepairableConnection(identity, connectionId);
    if (connection.repair_status === "repair_pending") {
      throw new HttpError(409, "A repair is already in progress for this Custom Source");
    }
    const activeVersion = await this.requireHandlerVersion(identity, connectionId, connection.active_handler_version_id);
    const activeEnvelope = envelopeOf(activeVersion);
    const manifest = (activeVersion.manifest_json ?? {}) as { list_selector?: string | null; pipeline?: unknown };

    await this.setRepairStatus(identity, connectionId, "repair_pending");

    // capture_policy/retention_policy fall back to the active version's own
    // envelope, not the connection row — generateHandler's own fallback
    // (connection.capture_policy / connection.policy_json.retention_policy)
    // can be stale relative to the active version if an earlier activation
    // used an overridden value that was never written back to the
    // connection row. Falling back to the connection here would silently
    // regenerate a different envelope than the one actually active.
    const generateBody: Record<string, unknown> = {
      generation_mode: activeVersion.language === "declarative_pipeline_v1" ? "pipeline" : "code_template",
      capture_policy: optionalString(body.capture_policy) ?? activeEnvelope.capture_policy,
      retention_policy: optionalString(body.retention_policy) ?? activeEnvelope.retention_policy,
    };
    if (activeVersion.language === "declarative_pipeline_v1") {
      generateBody.pipeline = body.pipeline ?? manifest.pipeline;
    } else {
      generateBody.list_selector = optionalString(body.list_selector) ?? manifest.list_selector ?? null;
    }

    let newVersion;
    try {
      newVersion = await this.createFlow.generateHandler(identity, connectionId, generateBody);
    } catch (error) {
      await this.resetRepairStatusAfterFailure(identity, connectionId, connection.repair_status, error);
      throw error;
    }

    let testOutcome;
    try {
      testOutcome = await this.createFlow.testHandler(identity, connectionId, {
        handler_version_id: newVersion.id,
        fixture_html: optionalString(body.fixture_html),
      });
    } catch (error) {
      // testHandler can throw uncaught (e.g. recordTestOutcome's "no longer
      // testable" guard, or a raw DB error) — without this catch,
      // repair_status would be left at repair_pending forever, since the
      // automatic scan-worker trigger deliberately never touches
      // repair_pending.
      await this.resetRepairStatusAfterFailure(identity, connectionId, connection.repair_status, error);
      throw error;
    }
    if (testOutcome.run.status !== "succeeded") {
      await this.setRepairStatus(identity, connectionId, "repair_required");
      return {
        status: "test_failed" as const,
        handler_version: testOutcome.version,
        test_result: testOutcome.test_result,
      };
    }

    try {
      return await this.decideAndActivateOrPropose(identity, connectionId, {
        newVersion,
        activeVersion,
        activeEnvelope,
        testOutcome,
      });
    } catch (error) {
      // Anything failing after generate+test succeeded (envelope evaluation,
      // auto-activation, or the proposal-creation transaction itself) must
      // still release repair_pending — otherwise, like the testHandler catch
      // above, it would be stuck forever.
      await this.resetRepairStatusAfterFailure(identity, connectionId, connection.repair_status, error);
      throw error;
    }
  }

  /**
   * A 429 from the Phase 12 generate-rate-limit is a transient throttle, not
   * a real generation/test/activation failure — flipping repair_status to
   * `repair_required` for it would mislead `getHandlerSummary`'s
   * `repair_status` field (and any operator/dashboard reading it) into
   * showing "needs repair" for a connection that was never actually broken.
   * Restores whatever repair_status this repair attempt started from
   * instead.
   */
  private async resetRepairStatusAfterFailure(
    identity: SpaceUserIdentity,
    connectionId: string,
    originalRepairStatus: string,
    error: unknown,
  ): Promise<void> {
    const isRateLimited = error instanceof HttpError && error.statusCode === 429;
    await this.setRepairStatus(identity, connectionId, isRateLimited ? originalRepairStatus : "repair_required");
  }

  private async decideAndActivateOrPropose(
    identity: SpaceUserIdentity,
    connectionId: string,
    input: {
      newVersion: { id: string };
      activeVersion: HandlerVersionRow;
      activeEnvelope: CustomSourcePolicyEnvelope;
      testOutcome: { version: { policy_envelope_json: unknown }; test_result: Record<string, unknown> };
    },
  ) {
    const { newVersion, activeVersion, activeEnvelope, testOutcome } = input;
    const settings = await new PgCustomSourceHandlerRepository(this.pool, this.config).getSettings(identity);
    const newEnvelope = testOutcome.version.policy_envelope_json as CustomSourcePolicyEnvelope;
    const evaluation = evaluateCustomSourceActivation(newEnvelope, {
      activeEnvelope,
      spaceAllowedDomains: settings.space.allowed_domains,
      credentialedSourcesAllowed: settings.space.credentialed_sources_allowed,
      spaceDefaultCapturePolicy: settings.space.default_capture_policy,
      spaceDefaultRetentionPolicy: settings.space.default_retention_policy,
    });

    if (evaluation.withinEnvelope && settings.space.same_envelope_repair_auto_apply) {
      await activateCustomSourceHandlerVersion(this.pool, identity, connectionId, newVersion.id, activeVersion.id);
      const activated = await new PgCustomSourceHandlerRepository(this.pool, this.config).getHandlerVersion(
        identity,
        connectionId,
        newVersion.id,
      );
      if (!activated) throw new HttpError(500, "Handler version disappeared immediately after repair activation");
      return {
        status: "active" as const,
        deltas: evaluation.deltas,
        proposal_id: null,
        handler_version: activated,
        previous_handler_version_id: activeVersion.id,
      };
    }

    const fixtureComparison = { deltas: evaluation.deltas, test_result: testOutcome.test_result };
    const created = await withDbTransaction(this.pool, async (client) => {
      let proposalType: string;
      let payload: Record<string, unknown>;
      let summary: string;
      let riskLevel: "medium" | "high";

      if (evaluation.withinEnvelope) {
        // Envelope unchanged, but Space policy does not allow silent
        // same-envelope repair auto-apply — custom_source_repair_activation
        // is the only proposal type whose applier accepts this case.
        proposalType = "custom_source_repair_activation";
        payload = {
          proposal_type: proposalType,
          source_connection_id: connectionId,
          previous_handler_version_id: activeVersion.id,
          new_handler_version_id: newVersion.id,
          envelope_unchanged: true,
          fixture_comparison_json: fixtureComparison,
        };
        summary = "Custom Source repair produced an unchanged-envelope handler version awaiting approval";
        riskLevel = "medium";
      } else {
        // Envelope broadened — routes through the same proposal types a
        // fresh (non-repair) activation would use; custom_source_repair_activation's
        // applier explicitly rejects envelope_unchanged !== true.
        proposalType = customSourceProposalTypeForEnvelope(newEnvelope, {
          credentialedSourcesAllowed: settings.space.credentialed_sources_allowed,
        });
        const basePayload = customSourceProposalPayload({
          proposalType: proposalType as "custom_source_policy_delta" | "custom_source_credentialed_source",
          connectionId,
          handlerVersionId: newVersion.id,
          currentHandlerVersionId: activeVersion.id,
          currentEnvelope: activeEnvelope,
          proposedEnvelope: newEnvelope,
          deltas: evaluation.deltas,
          requestedByUserId: identity.userId,
        });
        const reviewText = customSourceProposalReviewText({
          proposalType: proposalType as "custom_source_policy_delta" | "custom_source_credentialed_source",
          connectionId,
          handlerVersionId: newVersion.id,
          activeHandlerVersionId: activeVersion.id,
          deltas: evaluation.deltas,
          proposedEnvelope: newEnvelope,
        });
        payload = { ...basePayload, proposed_content: reviewText.proposedContent, repair: true, fixture_comparison_json: fixtureComparison };
        summary = reviewText.summary;
        riskLevel = customSourceProposalRisk(
          proposalType as "custom_source_policy_delta" | "custom_source_credentialed_source",
        );
      }

      const proposal = await insertProposalRow(client, {
        spaceId: identity.spaceId,
        proposalType,
        title: "Approve Custom Source repair activation",
        summary,
        payload,
        rationale: "A Custom Source repair produced a new handler version that requires review before activation.",
        createdByUserId: identity.userId,
        visibility: "space_shared",
        riskLevel,
        requiredApproverRole: "owner",
      });
      const updatedVersion = await client.query<HandlerVersionRow>(
        `UPDATE source_handler_versions
            SET status = 'pending_approval', proposal_id = $3
          WHERE id = $1
            AND space_id = $2
            AND status = 'draft'
          RETURNING ${HANDLER_VERSION_COLUMNS}`,
        [newVersion.id, identity.spaceId, proposal.id],
      );
      const row = updatedVersion.rows[0];
      if (!row) throw new HttpError(409, "Handler version is no longer eligible for repair approval");
      return { proposal, version: row };
    });

    return {
      status: "pending_approval" as const,
      deltas: evaluation.deltas,
      proposal_id: created.proposal.id,
      handler_version: handlerVersionOut(created.version),
    };
  }

  async rollbackHandler(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const connection = await this.requireRepairableConnection(identity, connectionId);
    const targetVersionId = optionalString(body.target_version_id);
    const target = targetVersionId
      ? await this.requireHandlerVersion(identity, connectionId, targetVersionId)
      : await this.mostRecentlySupersededVersion(identity, connectionId);
    if (!target) throw new HttpError(404, "No previous handler version available to roll back to");
    if (target.status !== "superseded" || !target.activated_at) {
      throw new HttpError(409, "Rollback target must be a previously active (superseded) handler version");
    }

    await activateCustomSourceHandlerVersion(
      this.pool,
      identity,
      connectionId,
      target.id,
      connection.active_handler_version_id,
    );
    const activated = await new PgCustomSourceHandlerRepository(this.pool, this.config).getHandlerVersion(
      identity,
      connectionId,
      target.id,
    );
    if (!activated) throw new HttpError(500, "Handler version disappeared immediately after rollback");
    return {
      status: "active" as const,
      handler_version: activated,
      previous_handler_version_id: connection.active_handler_version_id,
    };
  }

  // --- internals ---

  private async requireRepairableConnection(
    identity: SpaceUserIdentity,
    connectionId: string,
  ): Promise<RepairableConnection> {
    const result = await this.pool.query<{
      id: string;
      handler_kind: string;
      active_handler_version_id: string | null;
      repair_status: string;
    }>(
      `SELECT id, handler_kind, active_handler_version_id, repair_status
         FROM source_connections
        WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [identity.spaceId, connectionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Source connection not found");
    if (row.handler_kind !== "generated_custom") throw new HttpError(422, "Source connection is not a Custom Source");
    if (!row.active_handler_version_id) {
      throw new HttpError(409, "Custom Source has no active handler version to repair or roll back");
    }
    return { id: row.id, active_handler_version_id: row.active_handler_version_id, repair_status: row.repair_status };
  }

  private async requireHandlerVersion(
    identity: SpaceUserIdentity,
    connectionId: string,
    versionId: string,
  ): Promise<HandlerVersionRow> {
    const result = await this.pool.query<HandlerVersionRow>(
      `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions
        WHERE space_id = $1 AND source_connection_id = $2 AND id = $3`,
      [identity.spaceId, connectionId, versionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Handler version not found");
    return row;
  }

  /**
   * The version most recently superseded is exactly the one that was active
   * immediately before the current one — only one version is ever
   * superseded per activation. `version_number DESC` is a deterministic
   * tiebreaker for the (rare, but possible — clock resolution) case where
   * two versions share the same `superseded_at`; kept consistent with the
   * same tiebreaker `customSourceArtifactRetention.ts` uses to decide which
   * version retention must never prune, so the two never disagree about
   * which version is "most recent."
   */
  private async mostRecentlySupersededVersion(
    identity: SpaceUserIdentity,
    connectionId: string,
  ): Promise<HandlerVersionRow | null> {
    const result = await this.pool.query<HandlerVersionRow>(
      `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions
        WHERE space_id = $1 AND source_connection_id = $2
          AND status = 'superseded' AND superseded_at IS NOT NULL
        ORDER BY superseded_at DESC, version_number DESC
        LIMIT 1`,
      [identity.spaceId, connectionId],
    );
    return result.rows[0] ?? null;
  }

  private async setRepairStatus(identity: SpaceUserIdentity, connectionId: string, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE source_connections SET repair_status = $3, updated_at = $4 WHERE id = $1 AND space_id = $2`,
      [connectionId, identity.spaceId, status, new Date().toISOString()],
    );
  }
}

function envelopeOf(version: HandlerVersionRow): CustomSourcePolicyEnvelope {
  return version.policy_envelope_json as CustomSourcePolicyEnvelope;
}
