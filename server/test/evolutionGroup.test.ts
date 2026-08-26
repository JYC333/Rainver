import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { EvolvableAssetEvaluationRepository } from "../src/modules/evolution/assetEvaluationRepository.js";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository.js";
import { EvolutionBundleRepository } from "../src/modules/evolution/bundleRepository.js";
import { buildEvolutionPlanPrompt, EVOLUTION_PLAN_PROMPT_VERSION, EVOLUTION_PLAN_REVIEW_SCHEMA } from "../src/modules/evolution/prompt.js";
import { EvolutionRepository } from "../src/modules/evolution/repository.js";
import { EvolutionSelector } from "../src/modules/evolution/selector.js";
import { EvolutionSolidifier } from "../src/modules/evolution/solidifier.js";
import type { EvolutionExperienceRow, EvolutionSelection, EvolutionSignalRow, EvolutionStrategyAssetRow, EvolutionTargetRow } from "../src/modules/evolution/types.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import type { Queryable, QueryResult, SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("evolutionBundlesDb", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";


  const sharedPostgres = inject("sharedPostgres");
  const describeWithPostgres = describe.skipIf(
    !sharedPostgres.available || !sharedPostgres.adminUri || !sharedPostgres.templateDatabase || !sharedPostgres.runId,
  );

  const identity: SpaceUserIdentity = { spaceId: SPACE, userId: USER };

  async function waitForAdvisoryWait(expected: number): Promise<void> {
    if (!db.pool) throw new Error("PostgreSQL pool is unavailable");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'`,
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${expected} advisory-lock waiter(s)`);
  }

  const db = useTestDatabase(`${import.meta.filename}#evolutionBundlesDb`, { max: 10 });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["evolution_bundle_members", "evolution_bundles", "evolution_experiences", "evolution_signals", "evolution_targets", "evolvable_asset_pins", "evolvable_asset_evaluation_runs", "prompt_deployment_refs", "evolvable_asset_versions", "evolvable_assets", "proposals", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Bundle Owner', 'active', $2, $2)`,
      [USER, now],
    );
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Bundle Member', 'active', $2, $2)`,
      [OTHER_USER, now],
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Bundle Space', 'team', $2, $3, $3)`,
      [SPACE, USER, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
      [randomUUID(), SPACE, USER, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
      [randomUUID(), SPACE, OTHER_USER, now],
    );
  });

  describeWithPostgres("evolution bundles against real PostgreSQL", () => {
    it("rejects incomplete patches and granting-user egress proposals at the server boundary", async () => {
      if (!db.available) return;
      const now = new Date().toISOString();
      const incompletePatchId = randomUUID();
      const egressId = randomUUID();
      await db.pool.query(
        `INSERT INTO proposals (
           id, space_id, proposal_type, status, risk_level, urgency, preview, title,
           summary, payload_json, created_at, updated_at, rationale, created_by_user_id,
           owner_user_id, visibility, access_level
         ) VALUES
           ($1, $3, 'code_patch', 'pending', 'high', 'normal', false, 'Partial patch',
            'Partial patch', '{"incomplete_patch": true}'::jsonb, $4, $4, 'test', $2, $2, 'space_shared', 'full'),
           ($5, $3, 'egress_review', 'pending', 'high', 'normal', false, 'Egress review',
            'Egress review', $6::jsonb, $4, $4, 'test', $2, $2, 'space_shared', 'full')`,
        [incompletePatchId, USER, SPACE, now, egressId, JSON.stringify({ grant_id: randomUUID(), requires_approval_type: "egress_granting_user" })],
      );
      const bundles = new EvolutionBundleRepository(db.pool);
      await expect(bundles.create(identity, { title: "Invalid patch bundle", proposalIds: [incompletePatchId] })).rejects.toMatchObject({
        statusCode: 422,
        message: expect.stringContaining("incomplete code patch"),
      });
      await expect(bundles.create(identity, { title: "Invalid egress bundle", proposalIds: [egressId] })).rejects.toMatchObject({
        statusCode: 422,
        message: expect.stringContaining("granting-user egress approval"),
      });
      const created = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM evolution_bundles WHERE space_id = $1`,
        [SPACE],
      );
      expect(created.rows[0]?.count).toBe("0");
    });

    it("supports partial approval and restores the recorded version set on rollback", async () => {
      if (!db.available) {
        throw new Error("evolution bundle integration test requires the shared PostgreSQL Testcontainer");
      }
      const assets = new EvolvableAssetRepository(db.pool);
      const evaluations = new EvolvableAssetEvaluationRepository(db.pool);
      const bundles = new EvolutionBundleRepository(db.pool);
      const asset = await assets.createAsset(identity, {
        asset_type: "prompt_template",
        asset_key: `bundle.asset.${randomUUID()}`,
        display_name: "Bundle asset",
      });
      const first = await assets.createVersion(identity, asset.id as string, {
        scope_type: "space",
        scope_id: SPACE,
        content_json: { value: "first" },
      });
      const second = await assets.createVersion(identity, asset.id as string, {
        scope_type: "space",
        scope_id: SPACE,
        content_json: { value: "second" },
      });
      await assets.transitionVersionStatus(identity, asset.id as string, first.id as string, { status: "candidate" });
      await assets.transitionVersionStatus(identity, asset.id as string, second.id as string, { status: "candidate" });
      const firstEval = await evaluations.createPromotionProposal(identity, asset.id as string, first.id as string, {
        target_scope_type: "space",
        target_scope_id: SPACE,
        pin_after_approval: true,
      });
      const secondEval = await evaluations.createPromotionProposal(identity, asset.id as string, second.id as string, {
        target_scope_type: "space",
        target_scope_id: SPACE,
        pin_after_approval: true,
        deprecate_previous: true,
      });

      const created = await bundles.create(identity, {
        title: "Screening prompt release",
        description: "Approve a coherent prompt release as a reviewable group.",
        proposalIds: [firstEval.proposal_id as string, secondEval.proposal_id as string],
      });
      expect(created).toMatchObject({
        status: "pending_review",
        member_count: 2,
        pending_count: 2,
        risk_level: "medium",
        rollbackable: false,
      });

      const proposalTargetId = randomUUID();
      await db.pool.query(
        `INSERT INTO evolution_targets (
           id, space_id, target_type, target_ref_type, target_ref_id, risk_level,
           status, enabled, engine_policy_json, metadata_json, created_at, updated_at
         ) VALUES ($1, $2, 'workflow_asset', 'proposal', $3, 'medium', 'active', true, '{}'::jsonb, '{}'::jsonb, $4, $4)`,
        [proposalTargetId, SPACE, secondEval.proposal_id, new Date().toISOString()],
      );

      const config = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri,
        SERVER_INTERNAL_TOKEN: "test-internal-token",
      });
      const apply = PgProposalApplyService.fromConfig(config);
      await expect(apply.accept(secondEval.proposal_id as string, identity)).rejects.toMatchObject({
        statusCode: 409,
        detail: expect.objectContaining({ code: "proposal_bundled" }),
      });
      const partiallyApproved = await bundles.decide(
        identity,
        created.id as string,
        [{ proposalId: firstEval.proposal_id as string, decision: "approve" }],
        apply,
      );
      expect(partiallyApproved).toMatchObject({ status: "partially_approved", approved_count: 1, pending_count: 1 });
      expect((await assets.listVersions(identity, asset.id as string)).find((row) => row.id === first.id)).toMatchObject({ status: "approved" });

      const applied = await bundles.decide(
        identity,
        created.id as string,
        [{ proposalId: secondEval.proposal_id as string, decision: "reject" }],
        apply,
      );
      expect(applied).toMatchObject({ status: "applied", approved_count: 1, pending_count: 0 });
      expect(applied).toMatchObject({ rollbackable: true, rollback_blockers: [] });

      await expect(bundles.requestRollback(
        { spaceId: SPACE, userId: OTHER_USER },
        created.id as string,
        apply,
      )).rejects.toMatchObject({ statusCode: 403 });
      const unauthorizedRollbackProposals = await db.pool.query(
        `SELECT id FROM proposals
          WHERE proposal_type = 'evolution_bundle_rollback'
            AND payload_json->>'bundle_id' = $1`,
        [created.id],
      );
      expect(unauthorizedRollbackProposals.rows).toHaveLength(0);

      const rolledBack = await bundles.requestRollback(identity, created.id as string, apply);
      expect(rolledBack).toMatchObject({ status: "rolled_back", rollback_error: null });
      const versions = await assets.listVersions(identity, asset.id as string);
      expect(versions.find((row) => row.id === first.id)).toMatchObject({ status: "candidate" });
      expect(versions.find((row) => row.id === second.id)).toMatchObject({ status: "candidate" });
      expect(await assets.listPins(identity, asset.id as string)).toEqual([]);
      const rollbackProposal = await db.pool.query<{ status: string; proposal_type: string }>(
        `SELECT status, proposal_type FROM proposals WHERE proposal_type = 'evolution_bundle_rollback' AND payload_json->>'bundle_id' = $1`,
        [created.id],
      );
      expect(rollbackProposal.rows).toEqual([{ status: "accepted", proposal_type: "evolution_bundle_rollback" }]);
      const rollbackActivity = await db.pool.query<{ activity_type: string }>(
        `SELECT activity_type FROM activity_records WHERE activity_type = 'evolution.bundle.rolled_back' AND payload_json->>'bundle_id' = $1`,
        [created.id],
      );
      expect(rollbackActivity.rows).toHaveLength(1);
      const rejectedSignals = await db.pool.query<{ signal_type: string }>(
        `SELECT signal_type FROM evolution_signals WHERE source_type = 'proposal' AND source_id = $1`,
        [secondEval.proposal_id],
      );
      expect(rejectedSignals.rows).toEqual([{ signal_type: "proposal_rejected" }]);

      const unsupportedProposalId = randomUUID();
      await db.pool.query(
        `INSERT INTO proposals (
           id, space_id, proposal_type, status, risk_level, urgency, preview, title,
           summary, payload_json, created_at, updated_at, rationale, created_by_user_id,
           owner_user_id, visibility, access_level
         ) VALUES ($1, $2, 'memory_create', 'pending', 'low', 'normal', false, 'Unsupported rollback member',
           'Unsupported rollback member', '{}'::jsonb, $3, $3, 'test', $4, $4, 'space_shared', 'full')`,
        [unsupportedProposalId, SPACE, new Date().toISOString(), USER],
      );
      const unsupported = await bundles.create(identity, {
        title: "Unsupported rollback bundle",
        proposalIds: [unsupportedProposalId],
      });
      await db.pool.query(
        `UPDATE proposals SET status = 'accepted', reviewed_at = now(), reviewed_by = $2 WHERE id = $1`,
        [unsupportedProposalId, USER],
      );
      await db.pool.query(
        `UPDATE evolution_bundle_members
            SET status = 'approved',
                before_snapshot_json = '{"kind":"unsupported"}'::jsonb,
                after_snapshot_json = '{"kind":"unsupported"}'::jsonb
          WHERE bundle_id = $1`,
        [unsupported.id],
      );
      await db.pool.query(`UPDATE evolution_bundles SET status = 'applied' WHERE id = $1`, [unsupported.id]);
      const unsupportedDetail = await bundles.get(identity, unsupported.id as string);
      expect(unsupportedDetail).toMatchObject({
        rollbackable: false,
        rollback_blockers: [expect.stringContaining("no supported promotion rollback adapter")],
      });
      await expect(bundles.requestRollback(identity, unsupported.id as string, apply)).rejects.toMatchObject({
        statusCode: 409,
      });
      const unsupportedRollbackProposals = await db.pool.query(
        `SELECT id FROM proposals
          WHERE proposal_type = 'evolution_bundle_rollback'
            AND payload_json->>'bundle_id' = $1`,
        [unsupported.id],
      );
      expect(unsupportedRollbackProposals.rows).toHaveLength(0);
    });

    it("serializes same-asset approvals and refuses rollback over a later promotion", async () => {
      if (!db.available) {
        throw new Error("evolution bundle concurrency test requires the shared PostgreSQL Testcontainer");
      }
      const assets = new EvolvableAssetRepository(db.pool);
      const evaluations = new EvolvableAssetEvaluationRepository(db.pool);
      const bundles = new EvolutionBundleRepository(db.pool);
      const asset = await assets.createAsset(identity, {
        asset_type: "prompt_template",
        asset_key: `bundle.concurrent.${randomUUID()}`,
        display_name: "Concurrent bundle asset",
      });
      const config = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri,
        SERVER_INTERNAL_TOKEN: "test-internal-token",
      });
      const apply = PgProposalApplyService.fromConfig(config);

      const candidateProposal = async (value: string, deprecatePrevious: boolean) => {
        const version = await assets.createVersion(identity, asset.id as string, {
          scope_type: "space",
          scope_id: SPACE,
          content_json: { value },
        });
        await assets.transitionVersionStatus(identity, asset.id as string, version.id as string, { status: "candidate" });
        const proposal = await evaluations.createPromotionProposal(identity, asset.id as string, version.id as string, {
          target_scope_type: "space",
          target_scope_id: SPACE,
          deprecate_previous: deprecatePrevious,
        });
        return { version, proposalId: proposal.proposal_id as string };
      };

      const first = await candidateProposal("bundle-first", false);
      const second = await candidateProposal("bundle-second", true);
      const firstBundle = await bundles.create(identity, { title: "First concurrent bundle", proposalIds: [first.proposalId] });
      const secondBundle = await bundles.create(identity, { title: "Second concurrent bundle", proposalIds: [second.proposalId] });

      const blocker = await db.pool.connect();
      let blockerCommitted = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`evolution_asset:${asset.id}`],
        );
        const firstApproval = bundles.decide(
          identity,
          firstBundle.id as string,
          [{ proposalId: first.proposalId, decision: "approve" }],
          apply,
        );
        await waitForAdvisoryWait(1);
        const secondApproval = bundles.decide(
          identity,
          secondBundle.id as string,
          [{ proposalId: second.proposalId, decision: "approve" }],
          apply,
        );
        await waitForAdvisoryWait(2);
        await blocker.query("COMMIT");
        blockerCommitted = true;
        await Promise.all([firstApproval, secondApproval]);
      } finally {
        if (!blockerCommitted) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }

      const afterBoth = await assets.listVersions(identity, asset.id as string);
      expect(afterBoth.find((row) => row.id === first.version.id)).toMatchObject({ status: "deprecated" });
      expect(afterBoth.find((row) => row.id === second.version.id)).toMatchObject({ status: "approved" });

      await bundles.requestRollback(identity, secondBundle.id as string, apply);
      const afterSecondRollback = await assets.listVersions(identity, asset.id as string);
      expect(afterSecondRollback.find((row) => row.id === first.version.id)).toMatchObject({ status: "approved" });
      expect(afterSecondRollback.find((row) => row.id === second.version.id)).toMatchObject({ status: "candidate" });

      const ordinary = await candidateProposal("ordinary-promotion", true);
      const bundled = await candidateProposal("bundle-promotion", true);
      const bundledPromotion = await bundles.create(identity, {
        title: "Bundle versus ordinary promotion",
        proposalIds: [bundled.proposalId],
      });

      const secondBlocker = await db.pool.connect();
      let secondBlockerCommitted = false;
      try {
        await secondBlocker.query("BEGIN");
        await secondBlocker.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`evolution_asset:${asset.id}`],
        );
        const bundledApproval = bundles.decide(
          identity,
          bundledPromotion.id as string,
          [{ proposalId: bundled.proposalId, decision: "approve" }],
          apply,
        );
        await waitForAdvisoryWait(1);
        const ordinaryApproval = apply.accept(ordinary.proposalId, identity);
        await waitForAdvisoryWait(2);
        await secondBlocker.query("COMMIT");
        secondBlockerCommitted = true;
        await Promise.all([bundledApproval, ordinaryApproval]);
      } finally {
        if (!secondBlockerCommitted) await secondBlocker.query("ROLLBACK").catch(() => undefined);
        secondBlocker.release();
      }

      await expect(bundles.requestRollback(identity, bundledPromotion.id as string, apply)).rejects.toMatchObject({
        statusCode: 409,
      });
      const afterOrdinaryPromotion = await assets.listVersions(identity, asset.id as string);
      expect(afterOrdinaryPromotion.find((row) => row.id === ordinary.version.id)).toMatchObject({ status: "approved" });
      const rollbackProposals = await db.pool.query(
        `SELECT id FROM proposals
          WHERE proposal_type = 'evolution_bundle_rollback'
            AND payload_json->>'bundle_id' = $1`,
        [bundledPromotion.id],
      );
      expect(rollbackProposals.rows).toHaveLength(0);
    }, 20_000);
  });
});

describe("evolutionPrompt", () => {
  describe("buildEvolutionPlanPrompt", () => {
    it("builds an agent-space prompt with proposal and evidence boundaries", () => {
      const prompt = buildEvolutionPlanPrompt({
        target: target(),
        selectedStrategy: strategy(),
        recentSignals: [signal()],
        selection: selection(),
        runId: "run-1",
        selectorDecisionId: "decision-1",
        requestSignalId: "signal-review",
      });

      expect(prompt.prompt_version).toBe(EVOLUTION_PLAN_PROMPT_VERSION);
      expect(prompt.system).toContain("agent-space Evolution planner");
      expect(prompt.system).toContain("ProposalApplierRegistry");
      expect(prompt.system).toContain("Do not apply changes");
      expect(prompt.user).toContain(EVOLUTION_PLAN_REVIEW_SCHEMA);
      expect(prompt.user).toContain("repair.runtime_failure");
      expect(prompt.user).toContain("signal-runtime_failure");
      expect(prompt.user).toContain("signal-review");
      expect(prompt.user).toContain("agent_id");
      expect(prompt.user).toContain("memory_create");
      expect(prompt.user).toContain("prompt_update");
    });
  });

  function target(): EvolutionTargetRow {
    return {
      id: "target-1",
      space_id: "space-1",
      target_type: "system",
      target_ref_type: null,
      target_ref_id: null,
      capability_key: null,
      current_version_id: null,
      risk_level: "medium",
      status: "active",
      enabled: true,
      engine_policy_json: { max_strategy_risk: "medium" },
      metadata_json: { target_name: "Runtime repair target", agent_id: "agent-1" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  function signal(): EvolutionSignalRow {
    return {
      id: "signal-runtime_failure",
      space_id: "space-1",
      target_id: "target-1",
      target_name: "Runtime repair target",
      target_type: "system",
      capability_key: null,
      signal_type: "runtime_failure",
      source_type: "run",
      source_id: "run-failed",
      severity: "medium",
      summary: "Runtime failed before producing an artifact.",
      payload_json: { error_code: "runtime_error" },
      created_at: "2026-01-01T00:00:00Z",
    };
  }

  function strategy(): EvolutionStrategyAssetRow {
    return {
      id: "strategy-1",
      space_id: null,
      strategy_key: "repair.runtime_failure",
      name: "Runtime failure repair",
      description: "Diagnose a failed run and produce a reviewable repair plan.",
      category: "repair",
      target_type: "system",
      status: "active",
      risk_level: "medium",
      signals_match_json: ["runtime_failure"],
      preconditions_json: { requires_agent_id: true },
      strategy_steps_json: ["inspect evidence", "draft repair", "define validation"],
      constraints_json: ["no direct apply"],
      validation_policy_json: { required_checks: ["typecheck"] },
      tool_policy_json: { allow: ["read"] },
      routing_hint_json: { proposal_type: null },
      provenance_type: "built_in",
      source_ref_json: {},
      success_count: 1,
      failure_count: 0,
      confidence_score: 0.6,
      last_selected_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  function selection(): EvolutionSelection {
    return {
      selectedStrategy: strategy(),
      candidateStrategyIds: ["strategy-1"],
      inputSignalIds: ["signal-runtime_failure", "signal-review"],
      decisionReason: "Selected repair.runtime_failure for matching runtime failure evidence.",
      scoreTrace: { selected_score: 0.82 },
      rejectedReasons: [],
    };
  }
});

describe("evolutionSelector", () => {
  describe("EvolutionSelector", () => {
    it("selects an active matching strategy and excludes disabled strategies", () => {
      const selector = new EvolutionSelector();
      const selected = selector.select({
        target: target({ target_type: "system", risk_level: "medium" }),
        signals: [signal("runtime_failure")],
        strategies: [
          strategy("disabled", {
            status: "disabled",
            signals_match_json: ["runtime_failure"],
            confidence_score: 0.99,
          }),
          strategy("repair.runtime_failure", {
            signals_match_json: ["runtime_failure"],
            confidence_score: 0.55,
          }),
        ],
      });

      expect(selected.selectedStrategy?.strategy_key).toBe("repair.runtime_failure");
      expect(selected.candidateStrategyIds).toEqual(["strategy-repair.runtime_failure"]);
      expect(selected.rejectedReasons).toContainEqual(expect.objectContaining({
        strategy_key: "disabled",
        reason: "strategy_disabled",
      }));
    });

    it("blocks strategies above the target risk policy ceiling", () => {
      const selector = new EvolutionSelector();
      const selected = selector.select({
        target: target({
          target_type: "capability",
          risk_level: "medium",
          engine_policy_json: { max_strategy_risk: "medium" },
        }),
        signals: [signal("capability_gap")],
        strategies: [
          strategy("improve.capability_gap", {
            target_type: "capability",
            risk_level: "high",
            signals_match_json: ["capability_gap"],
          }),
        ],
      });

      expect(selected.selectedStrategy).toBeNull();
      expect(selected.rejectedReasons).toContainEqual(expect.objectContaining({
        strategy_key: "improve.capability_gap",
        reason: "strategy_risk_exceeds_target_policy",
      }));
    });

  });

  function target(overrides: Partial<EvolutionTargetRow> = {}): EvolutionTargetRow {
    return {
      id: "target-1",
      space_id: "space-1",
      target_type: "system",
      target_ref_type: null,
      target_ref_id: null,
      capability_key: null,
      current_version_id: null,
      risk_level: "medium",
      status: "active",
      enabled: true,
      engine_policy_json: {},
      metadata_json: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  function signal(signalType: string): EvolutionSignalRow {
    return {
      id: `signal-${signalType}`,
      space_id: "space-1",
      target_id: "target-1",
      target_name: "Target",
      target_type: "system",
      capability_key: null,
      signal_type: signalType,
      source_type: "manual",
      source_id: null,
      severity: "medium",
      summary: null,
      payload_json: {},
      created_at: "2026-01-01T00:00:00Z",
    };
  }

  function strategy(
    strategyKey: string,
    overrides: Partial<EvolutionStrategyAssetRow> = {},
  ): EvolutionStrategyAssetRow {
    return {
      id: `strategy-${strategyKey}`,
      space_id: null,
      strategy_key: strategyKey,
      name: strategyKey,
      description: null,
      category: "repair",
      target_type: "system",
      status: "active",
      risk_level: "medium",
      signals_match_json: [],
      preconditions_json: {},
      strategy_steps_json: [],
      constraints_json: [],
      validation_policy_json: {},
      tool_policy_json: {},
      routing_hint_json: {},
      provenance_type: "built_in",
      source_ref_json: {},
      success_count: 0,
      failure_count: 0,
      confidence_score: 0.5,
      last_selected_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }
});

describe("evolutionSignalTriage", () => {
  class TriageDb implements Queryable {
    readonly calls: string[] = [];
    private status = "new";
    private note: string | null = null;

    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
      this.calls.push(sql);
      if (sql.startsWith("UPDATE evolution_signals")) {
        this.status = String(params[2]);
        this.note = params[6] === null ? this.note : String(params[6]);
        return { rows: [], rowCount: 1 };
      }
      return {
        rows: [{
          id: "signal-1",
          space_id: "space-1",
          target_id: "target-1",
          target_name: "Task task-1",
          target_type: "project_folder",
          capability_key: null,
          signal_type: "run_finalization_failed",
          source_type: "run",
          source_id: "run-1",
          severity: "error",
          summary: "Run failed.",
          payload_json: {},
          triage_status: this.status,
          triaged_at: "2026-07-11T00:00:00.000Z",
          triaged_by_user_id: "user-1",
          triage_note: this.note,
          created_at: "2026-07-11T00:00:00.000Z",
        } as Row],
        rowCount: 1,
      };
    }
  }

  describe("evolution signal triage", () => {
    it("updates and dismisses a space-owned signal without touching system signals", async () => {
      const db = new TriageDb();
      const repo = new EvolutionRepository(db);
      const identity = { spaceId: "space-1", userId: "user-1" };

      const acknowledged = await repo.updateSignalTriage(identity, "signal-1", {
        triage_status: "acknowledged",
        triage_note: "Investigate in the next review.",
      });
      expect(acknowledged).toMatchObject({ triage_status: "acknowledged", triaged_by_user_id: "user-1" });

      const dismissed = await repo.dismissSignal(identity, "signal-1", { triage_note: "Not actionable." });
      expect(dismissed).toMatchObject({ triage_status: "dismissed", triage_note: "Not actionable." });
      expect(db.calls.filter((sql) => sql.startsWith("UPDATE evolution_signals"))).toHaveLength(2);
      expect(db.calls.every((sql) => !sql.includes("es.space_id IS NULL"))).toBe(true);
    });
  });
});

describe("evolutionSolidifier", () => {
  describe("EvolutionSolidifier", () => {
    it("persists an experience and updates selected strategy counters", async () => {
      const experience = experienceRow();
      const repository = {
        createExperience: vi.fn().mockResolvedValue(experience),
        updateStrategyExperienceStats: vi.fn().mockResolvedValue(undefined),
      };
      const solidifier = new EvolutionSolidifier(repository);

      await expect(solidifier.solidifyExperience({
        spaceId: "space-1",
        strategyAssetId: "strategy-1",
        targetId: "target-1",
        sourceRunId: "run-1",
        experienceKey: "repair.runtime_failure/run-1",
        summary: "Validated repair experience.",
        outcomeStatus: "success",
        provenanceType: "run_observed",
      })).resolves.toBe(experience);

      expect(repository.createExperience).toHaveBeenCalledWith(expect.objectContaining({
        strategyAssetId: "strategy-1",
        outcomeStatus: "success",
      }));
      expect(repository.updateStrategyExperienceStats).toHaveBeenCalledWith("strategy-1", "success");
    });

    it("does not update strategy counters when no strategy is linked", async () => {
      const repository = {
        createExperience: vi.fn().mockResolvedValue(experienceRow({ strategy_asset_id: null })),
        updateStrategyExperienceStats: vi.fn().mockResolvedValue(undefined),
      };
      const solidifier = new EvolutionSolidifier(repository);

      await solidifier.solidifyExperience({
        spaceId: "space-1",
        experienceKey: "manual/no-strategy",
        summary: "Manual observation.",
        outcomeStatus: "unknown",
        provenanceType: "user_authored",
      });

      expect(repository.updateStrategyExperienceStats).not.toHaveBeenCalled();
    });

    it("solidifies a run evaluation through the selected evolution decision", async () => {
      const experience = experienceRow({ outcome_status: "success" });
      const repository = {
        getRunExperienceContext: vi.fn().mockResolvedValue({
          spaceId: "space-1",
          runId: "run-1",
          targetId: "target-1",
          targetName: "Runtime target",
          strategyAssetId: "strategy-1",
          strategyKey: "repair.runtime_failure",
          strategyName: "Repair runtime failure",
          inputSignalIds: ["signal-1"],
          decisionReason: "matched runtime failure",
        }),
        getExperienceByKey: vi.fn().mockResolvedValue(null),
        createExperience: vi.fn().mockResolvedValue(experience),
        updateStrategyExperienceStats: vi.fn().mockResolvedValue(undefined),
      };
      const solidifier = new EvolutionSolidifier(repository);

      await expect(solidifier.solidifyFromRunEvaluation({
        id: "evaluation-1",
        space_id: "space-1",
        run_id: "run-1",
        evaluator_version: "post_run_finalization.v1",
        outcome_status: "passed",
        trajectory_status: "acceptable",
        evidence_json: { run_status: "succeeded" },
        rule_trace_json: [{ rule: "test" }],
      })).resolves.toBe(experience);

      expect(repository.createExperience).toHaveBeenCalledWith(expect.objectContaining({
        spaceId: "space-1",
        strategyAssetId: "strategy-1",
        sourceRunId: "run-1",
        experienceKey: "repair.runtime_failure/run/run-1/post_run_finalization.v1",
        outcomeStatus: "success",
        triggerSignals: ["signal-1"],
        provenanceType: "run_observed",
      }));
      expect(repository.updateStrategyExperienceStats).toHaveBeenCalledWith("strategy-1", "success");
    });

    it("does not duplicate an existing experience key", async () => {
      const experience = experienceRow();
      const repository = {
        getExperienceByKey: vi.fn().mockResolvedValue(experience),
        createExperience: vi.fn(),
        updateStrategyExperienceStats: vi.fn(),
      };
      const solidifier = new EvolutionSolidifier(repository);

      await expect(solidifier.solidifyExperience({
        spaceId: "space-1",
        strategyAssetId: "strategy-1",
        experienceKey: "repair.runtime_failure/run/run-1/post_run_finalization.v1",
        summary: "Existing experience.",
        outcomeStatus: "success",
        provenanceType: "run_observed",
      })).resolves.toBe(experience);

      expect(repository.createExperience).not.toHaveBeenCalled();
      expect(repository.updateStrategyExperienceStats).not.toHaveBeenCalled();
    });
  });

  function experienceRow(overrides: Partial<EvolutionExperienceRow> = {}): EvolutionExperienceRow {
    return {
      id: "experience-1",
      space_id: "space-1",
      strategy_asset_id: "strategy-1",
      strategy_key: "repair.runtime_failure",
      strategy_name: "Repair runtime failure",
      target_id: "target-1",
      target_name: "Target",
      source_run_id: "run-1",
      source_proposal_id: null,
      experience_key: "repair.runtime_failure/run-1",
      summary: "Validated repair experience.",
      trigger_signals_json: [],
      outcome_status: "success",
      confidence_score: 0.7,
      blast_radius_json: {},
      validation_trace_json: {},
      execution_trace_json: {},
      lessons_json: [],
      anti_patterns_json: [],
      environment_fingerprint_json: {},
      provenance_type: "run_observed",
      created_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }
});
