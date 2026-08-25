import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { EvolvableAssetEvaluationRepository } from "../src/modules/evolution/assetEvaluationRepository";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository";
import { EvolutionBundleRepository } from "../src/modules/evolution/bundleRepository";
import { PgProposalApplyService } from "../src/modules/proposals/applyService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

const sharedPostgres = inject("sharedPostgres");
const describeWithPostgres = describe.skipIf(
  !sharedPostgres.available || !sharedPostgres.adminUri || !sharedPostgres.templateDatabase || !sharedPostgres.runId,
);

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: USER };

async function waitForAdvisoryWait(expected: number): Promise<void> {
  if (!pool) throw new Error("PostgreSQL pool is unavailable");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ count: string }>(
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

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[evolution-bundles-db] skipped — Docker/Postgres unavailable: ${String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["evolution_bundle_members", "evolution_bundles", "evolution_experiences", "evolution_signals", "evolution_targets", "evolvable_asset_pins", "evolvable_asset_evaluation_runs", "prompt_deployment_refs", "evolvable_asset_versions", "evolvable_assets", "proposals", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Bundle Owner', 'active', $2, $2)`,
    [USER, now],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Bundle Member', 'active', $2, $2)`,
    [OTHER_USER, now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Bundle Space', 'team', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
    [randomUUID(), SPACE, OTHER_USER, now],
  );
});

describeWithPostgres("evolution bundles against real PostgreSQL", () => {
  it("rejects incomplete patches and granting-user egress proposals at the server boundary", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    const incompletePatchId = randomUUID();
    const egressId = randomUUID();
    await pool.query(
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
    const bundles = new EvolutionBundleRepository(pool);
    await expect(bundles.create(identity, { title: "Invalid patch bundle", proposalIds: [incompletePatchId] })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("incomplete code patch"),
    });
    await expect(bundles.create(identity, { title: "Invalid egress bundle", proposalIds: [egressId] })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("granting-user egress approval"),
    });
    const created = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM evolution_bundles WHERE space_id = $1`,
      [SPACE],
    );
    expect(created.rows[0]?.count).toBe("0");
  });

  it("supports partial approval and restores the recorded version set on rollback", async () => {
    if (!available || !pool || !container) {
      throw new Error("evolution bundle integration test requires the shared PostgreSQL Testcontainer");
    }
    const assets = new EvolvableAssetRepository(pool);
    const evaluations = new EvolvableAssetEvaluationRepository(pool);
    const bundles = new EvolutionBundleRepository(pool);
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
    await pool.query(
      `INSERT INTO evolution_targets (
         id, space_id, target_type, target_ref_type, target_ref_id, risk_level,
         status, enabled, engine_policy_json, metadata_json, created_at, updated_at
       ) VALUES ($1, $2, 'workflow_asset', 'proposal', $3, 'medium', 'active', true, '{}'::jsonb, '{}'::jsonb, $4, $4)`,
      [proposalTargetId, SPACE, secondEval.proposal_id, new Date().toISOString()],
    );

    const config = loadConfig({
      SERVER_DATABASE_URL: container.getConnectionUri(),
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
    const unauthorizedRollbackProposals = await pool.query(
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
    const rollbackProposal = await pool.query<{ status: string; proposal_type: string }>(
      `SELECT status, proposal_type FROM proposals WHERE proposal_type = 'evolution_bundle_rollback' AND payload_json->>'bundle_id' = $1`,
      [created.id],
    );
    expect(rollbackProposal.rows).toEqual([{ status: "accepted", proposal_type: "evolution_bundle_rollback" }]);
    const rollbackActivity = await pool.query<{ activity_type: string }>(
      `SELECT activity_type FROM activity_records WHERE activity_type = 'evolution.bundle.rolled_back' AND payload_json->>'bundle_id' = $1`,
      [created.id],
    );
    expect(rollbackActivity.rows).toHaveLength(1);
    const rejectedSignals = await pool.query<{ signal_type: string }>(
      `SELECT signal_type FROM evolution_signals WHERE source_type = 'proposal' AND source_id = $1`,
      [secondEval.proposal_id],
    );
    expect(rejectedSignals.rows).toEqual([{ signal_type: "proposal_rejected" }]);

    const unsupportedProposalId = randomUUID();
    await pool.query(
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
    await pool.query(
      `UPDATE proposals SET status = 'accepted', reviewed_at = now(), reviewed_by = $2 WHERE id = $1`,
      [unsupportedProposalId, USER],
    );
    await pool.query(
      `UPDATE evolution_bundle_members
          SET status = 'approved',
              before_snapshot_json = '{"kind":"unsupported"}'::jsonb,
              after_snapshot_json = '{"kind":"unsupported"}'::jsonb
        WHERE bundle_id = $1`,
      [unsupported.id],
    );
    await pool.query(`UPDATE evolution_bundles SET status = 'applied' WHERE id = $1`, [unsupported.id]);
    const unsupportedDetail = await bundles.get(identity, unsupported.id as string);
    expect(unsupportedDetail).toMatchObject({
      rollbackable: false,
      rollback_blockers: [expect.stringContaining("no supported promotion rollback adapter")],
    });
    await expect(bundles.requestRollback(identity, unsupported.id as string, apply)).rejects.toMatchObject({
      statusCode: 409,
    });
    const unsupportedRollbackProposals = await pool.query(
      `SELECT id FROM proposals
        WHERE proposal_type = 'evolution_bundle_rollback'
          AND payload_json->>'bundle_id' = $1`,
      [unsupported.id],
    );
    expect(unsupportedRollbackProposals.rows).toHaveLength(0);
  });

  it("serializes same-asset approvals and refuses rollback over a later promotion", async () => {
    if (!available || !pool || !container) {
      throw new Error("evolution bundle concurrency test requires the shared PostgreSQL Testcontainer");
    }
    const assets = new EvolvableAssetRepository(pool);
    const evaluations = new EvolvableAssetEvaluationRepository(pool);
    const bundles = new EvolutionBundleRepository(pool);
    const asset = await assets.createAsset(identity, {
      asset_type: "prompt_template",
      asset_key: `bundle.concurrent.${randomUUID()}`,
      display_name: "Concurrent bundle asset",
    });
    const config = loadConfig({
      SERVER_DATABASE_URL: container.getConnectionUri(),
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

    const blocker = await pool.connect();
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

    const secondBlocker = await pool.connect();
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
    const rollbackProposals = await pool.query(
      `SELECT id FROM proposals
        WHERE proposal_type = 'evolution_bundle_rollback'
          AND payload_json->>'bundle_id' = $1`,
      [bundledPromotion.id],
    );
    expect(rollbackProposals.rows).toHaveLength(0);
  }, 20_000);
});
