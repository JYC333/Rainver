import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import type { ServerConfig } from "../src/config.js";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository.js";
import { EvolvableAssetEvaluationRepository } from "../src/modules/evolution/assetEvaluationRepository.js";
import { ProposalApplierRegistry, type ProposalApplyContext } from "../src/modules/proposals/applierRegistry.js";
import { registerEvolvableAssetPromotionProposalApplier } from "../src/modules/evolution/assetPromotionProposalApplier.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";

// Real-Postgres coverage for evaluation-run metadata and the
// evolvable_asset_version_promote proposal applier: approval is
// evaluation-gated, deprecates the previous approved version on request,
// optionally pins, records an EvolutionExperience, and enforces scope
// authority (project writer / space owner-admin), matching setPin.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSIDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["evolution_experiences", "evolvable_asset_evaluation_runs", "evolvable_asset_pins", "prompt_deployment_refs", "evolvable_asset_versions", "evolvable_assets", "proposals", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OUTSIDER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4), ($5,$2,$6,'member','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now, randomUUID(), OUTSIDER],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
});

function repo(): EvolvableAssetRepository {
  return new EvolvableAssetRepository(db.pool);
}

function evalRepo(): EvolvableAssetEvaluationRepository {
  return new EvolvableAssetEvaluationRepository(db.pool);
}

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

async function createCandidateVersion(): Promise<{ assetId: string; versionId: string; assetKey: string }> {
  const asset = await repo().createAsset(identity, {
    asset_type: "prompt_template",
    asset_key: `academic.paper_screening_assistant.${randomUUID()}`,
    display_name: "Paper Screening Assistant",
  });
  const version = await repo().createVersion(identity, asset.id as string, {
    scope_type: "project",
    scope_id: PROJECT,
    content_json: { system_prompt: "v2" },
  });
  await repo().transitionVersionStatus(identity, asset.id as string, version.id as string, { status: "candidate" });
  return { assetId: asset.id as string, versionId: version.id as string, assetKey: asset.asset_key as string };
}

async function passEvaluation(assetId: string, versionId: string): Promise<string> {
  const run = await evalRepo().recordEvaluationRun(identity, assetId, versionId, {
    eval_suite_ref: { kind: "local_private_benchmark", name: "academic.paper_screening" },
    evaluator_version: "v1",
    status: "passed",
    metrics: { precision: 0.9 },
  });
  return run.id as string;
}

function registry(): ProposalApplierRegistry {
  const r = new ProposalApplierRegistry();
  registerEvolvableAssetPromotionProposalApplier(r);
  return r;
}

async function applyProposal(proposalId: string, userId: string): Promise<ReturnType<ProposalApplierRegistry["apply"]>> {
  const row = await db.pool.query<{
    id: string;
    space_id: string;
    proposal_type: string;
    title: string | null;
    payload_json: Record<string, unknown> | null;
    project_folder_id: string | null;
    created_by_user_id: string | null;
    project_id: string | null;
  }>(
    `SELECT id, space_id, proposal_type, title, payload_json, project_folder_id, created_by_user_id, project_id
       FROM proposals WHERE id = $1`,
    [proposalId],
  );
  const proposal = row.rows[0];
  if (!proposal) throw new Error("proposal not found");
  const context: ProposalApplyContext = {
    config: {} as ServerConfig,
    db: db.pool as unknown as ProposalApplyContext["db"],
    proposal: proposal as ApplyProposal,
    userId,
  };
  return registry().apply(context);
}

describe("Evolvable asset evaluation runs + promotion applier (real Postgres)", () => {
  it("rejects recording an evaluation run against a draft version", async () => {
    if (!db.available) return;
    const asset = await repo().createAsset(identity, {
      asset_type: "prompt_template",
      asset_key: "academic.claim_integrity_checker",
      display_name: "Claim Integrity Checker",
    });
    const version = await repo().createVersion(identity, asset.id as string, { scope_type: "space", content_json: {} });
    await expect(
      evalRepo().recordEvaluationRun(identity, asset.id as string, version.id as string, {
        eval_suite_ref: { kind: "local_private_benchmark", name: "x" },
        evaluator_version: "v1",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("advances a candidate version to testing once an evaluation run is recorded", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    await passEvaluation(assetId, versionId);
    const versions = await repo().listVersions(identity, assetId);
    expect(versions.find((v) => v.id === versionId)).toMatchObject({ status: "testing" });
  });

  it("creates a promotion proposal and rejects promoting without target_scope_id for project scope", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    await expect(
      evalRepo().createPromotionProposal(identity, assetId, versionId, { target_scope_type: "project" }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const created = await evalRepo().createPromotionProposal(identity, assetId, versionId, {
      target_scope_type: "project",
      target_scope_id: PROJECT,
      pin_after_approval: true,
    });
    expect(created).toMatchObject({ proposal_type: "evolvable_asset_version_promote", status: "pending" });
  });

  it("rejects space promotion proposals whose target_scope_id is not the active space", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    await expect(
      evalRepo().createPromotionProposal(identity, assetId, versionId, {
        target_scope_type: "space",
        target_scope_id: PROJECT,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects system promotion proposals that include target_scope_id", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    await expect(
      evalRepo().createPromotionProposal(identity, assetId, versionId, {
        target_scope_type: "system",
        target_scope_id: SPACE,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("allows warn-only promotion without a passed evaluation and reports the warning", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    const proposal = await evalRepo().createPromotionProposal(identity, assetId, versionId, {
      target_scope_type: "project",
      target_scope_id: PROJECT,
    });
    const applied = await applyProposal(proposal.proposal_id as string, OWNER);
    expect(applied.result).toMatchObject({
      version_id: versionId,
      evaluation: { policy: "warn_only", passed: false, warning: expect.stringContaining("No passed evaluation") },
    });
  });

  it("blocks promotion when the proposal explicitly enables the evaluation hard gate", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    const proposal = await evalRepo().createPromotionProposal(identity, assetId, versionId, {
      target_scope_type: "project",
      target_scope_id: PROJECT,
      hard_gate: true,
    });
    await expect(applyProposal(proposal.proposal_id as string, OWNER)).rejects.toThrow(/hard gate/i);
  });

  it("applies promotion: approves the version, pins it, deprecates the previous approved version, and records an EvolutionExperience", async () => {
    if (!db.available) return;
    const { assetId } = await createCandidateVersion();
    // Establish an existing approved version for the same (project) scope.
    const firstVersion = await repo().createVersion(identity, assetId, { scope_type: "project", scope_id: PROJECT, content_json: { v: 1 } });
    await repo().transitionVersionStatus(identity, assetId, firstVersion.id as string, { status: "candidate" });
    await passEvaluation(assetId, firstVersion.id as string);
    const firstProposal = await evalRepo().createPromotionProposal(identity, assetId, firstVersion.id as string, {
      target_scope_type: "project",
      target_scope_id: PROJECT,
      pin_after_approval: true,
    });
    await applyProposal(firstProposal.proposal_id as string, OWNER);

    // Now promote a second version over it with deprecate_previous + pin.
    const secondVersion = await repo().createVersion(identity, assetId, { scope_type: "project", scope_id: PROJECT, content_json: { v: 2 } });
    await repo().transitionVersionStatus(identity, assetId, secondVersion.id as string, { status: "candidate" });
    await passEvaluation(assetId, secondVersion.id as string);
    const secondProposal = await evalRepo().createPromotionProposal(identity, assetId, secondVersion.id as string, {
      target_scope_type: "project",
      target_scope_id: PROJECT,
      pin_after_approval: true,
      deprecate_previous: true,
    });
    const applied = await applyProposal(secondProposal.proposal_id as string, OWNER);
    expect(applied.result).toMatchObject({ version_id: secondVersion.id, pinned: true });

    const versions = await repo().listVersions(identity, assetId);
    expect(versions.find((v) => v.id === secondVersion.id)).toMatchObject({ status: "approved" });
    expect(versions.find((v) => v.id === firstVersion.id)).toMatchObject({ status: "deprecated" });

    const pins = await repo().listPins(identity, assetId);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ version_id: secondVersion.id, scope_id: PROJECT });

    const experiences = await db.pool.query<{ experience_key: string }>(
      `SELECT experience_key FROM evolution_experiences WHERE space_id = $1`,
      [SPACE],
    );
    expect(experiences.rows.some((row) => row.experience_key === `evolvable_asset_promotion:${secondVersion.id}`)).toBe(true);
  });

  it("rejects promotion for a user without asset management authority", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    await passEvaluation(assetId, versionId);
    const proposal = await evalRepo().createPromotionProposal(identity, assetId, versionId, {
      target_scope_type: "project",
      target_scope_id: PROJECT,
    });
    await expect(applyProposal(proposal.proposal_id as string, OUTSIDER)).rejects.toThrow(/permission|writer|owner/i);
  });

  it("sets the asset's current_system_version_id when promoting to system scope", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    await passEvaluation(assetId, versionId);
    const proposal = await evalRepo().createPromotionProposal(identity, assetId, versionId, { target_scope_type: "system" });
    await applyProposal(proposal.proposal_id as string, OWNER);

    const asset = await repo().getAsset(identity, assetId);
    expect(asset.current_system_version_id).toBe(versionId);
  });

  it("writes a prompt deployment ref when an accepted promotion carries deployment_label", async () => {
    if (!db.available) return;
    const { assetId, versionId } = await createCandidateVersion();
    await passEvaluation(assetId, versionId);
    const proposal = await evalRepo().createPromotionProposal(identity, assetId, versionId, {
      target_scope_type: "project",
      target_scope_id: PROJECT,
      deployment_label: "production",
    });
    const applied = await applyProposal(proposal.proposal_id as string, OWNER);
    expect(applied.result).toMatchObject({ version_id: versionId, deployment_label: "production" });

    const refs = await db.pool.query<{ version_id: string; scope_type: string; scope_id: string; status: string; promoted_from_proposal_id: string }>(
      `SELECT version_id, scope_type, scope_id, status, promoted_from_proposal_id
         FROM prompt_deployment_refs
        WHERE asset_id = $1 AND label = 'production'`,
      [assetId],
    );
    expect(refs.rows).toEqual([
      {
        version_id: versionId,
        scope_type: "project",
        scope_id: PROJECT,
        status: "active",
        promoted_from_proposal_id: proposal.proposal_id,
      },
    ]);
  });
});
