import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository";
import { ExperimentDefinitionService } from "../src/modules/experiments/definitionService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for domain-neutral Project Research integrity checks:
// project-level claim intent records (project_research_claim_links) linking
// to already-canonical `claims` rows, and the integrity gate's V1 checks
// (citation existence, claim evidence/gap, evidence visible in project
// corpus, experiment-provenance placeholder).

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAME_SPACE_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "55555555-5555-4555-8555-555555555555";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_research_claim_links", "project_research_reports", "project_research_checkpoints", "project_research_workflows", "experiment_definitions", "claim_sources", "claims", "academic_papers", "sources", "space_objects", "project_corpus_items", "artifacts", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

function repo(): ProjectResearchRepository {
  return new ProjectResearchRepository(db.pool);
}

function experimentDefinitions(): ExperimentDefinitionService {
  return new ExperimentDefinitionService(db.pool);
}

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

async function makeSharedSpace(): Promise<void> {
  await db.pool.query(`UPDATE spaces SET type = 'team' WHERE id = $1`, [SPACE]);
}

async function addSpaceMember(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [
    userId,
    now,
  ]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'member','active',$4,$4)`,
    [randomUUID(), SPACE, userId, now],
  );
}

async function seedWorkflow(): Promise<string> {
  const workflowId = randomUUID();
  const now = new Date().toISOString();
  await insertResearchWorkflowFixture(db.pool, {
    id: workflowId, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER, now,
  });
  return workflowId;
}

async function seedClaim(
  claimText = "Model X improves accuracy",
  options: { visibility?: string; ownerUserId?: string | null; createdByUserId?: string | null } = {},
): Promise<string> {
  const now = new Date().toISOString();
  const objectId = randomUUID();
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1,$2,'claim',$3,$4,$5,$6,$7,$7)`,
    [
      objectId,
      SPACE,
      claimText.slice(0, 100),
      options.visibility ?? "space_shared",
      options.ownerUserId ?? null,
      options.createdByUserId ?? null,
      now,
    ],
  );
  await db.pool.query(
    `INSERT INTO claims (
       object_id, space_id, subject_text, claim_kind, claim_text, normalized_claim_hash,
       confidence_method, resolution_state, metadata_json
     ) VALUES ($1,$2,'Model X','fact',$3,$4,'human_confirmed','unreviewed','{}'::jsonb)`,
    [objectId, SPACE, claimText, `hash-${objectId}`],
  );
  return objectId;
}

async function seedPaperObject(arxivId: string): Promise<string> {
  const now = new Date().toISOString();
  const objectId = randomUUID();
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at)
     VALUES ($1,$2,'source','Paper',$3,$3)`,
    [objectId, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
     VALUES ($1,$2,'paper',$3,'{}'::jsonb)`,
    [objectId, SPACE, `https://arxiv.org/abs/${arxivId}`],
  );
  await db.pool.query(
    `INSERT INTO academic_papers (object_id, space_id, arxiv_id, paper_type, created_at, updated_at)
     VALUES ($1,$2,$3,'preprint',$4,$4)`,
    [objectId, SPACE, arxivId, now],
  );
  return objectId;
}

async function seedGenericDocumentObject(): Promise<string> {
  const now = new Date().toISOString();
  const objectId = randomUUID();
  await db.pool.query(
    `INSERT INTO space_objects (
       id, space_id, object_type, title, primary_project_id, created_by_user_id, created_at, updated_at
     ) VALUES ($1,$2,'source','General web document',$3,$4,$5,$5)`,
    [objectId, SPACE, PROJECT, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO sources (object_id, space_id, source_type, uri, metadata_json)
     VALUES ($1,$2,'webpage','https://example.test/general','{}'::jsonb)`,
    [objectId, SPACE],
  );
  return objectId;
}

async function addEvidence(claimId: string, sourceObjectId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO claim_sources (
       id, space_id, claim_id, source_object_id, evidence_role, created_at
     ) VALUES ($1,$2,$3,$4,'supports',$5)`,
    [randomUUID(), SPACE, claimId, sourceObjectId, now],
  );
}

async function addToCorpus(objectId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO project_corpus_items (
       id, space_id, project_id, object_id, role, status, triage_status, read_status, metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'candidate','active','included','unread','{}'::jsonb,$5,$5)`,
    [randomUUID(), SPACE, PROJECT, objectId, now],
  );
}

describe("Project Research claim links + integrity gate (real Postgres)", () => {
  it("creates a claim link only against an existing claim, and rejects an unknown claim_id", async () => {
    if (!db.available) return;
    const claimId = await seedClaim();
    const link = await repo().createClaimLink(identity, PROJECT, { claim_id: claimId, support_status: "supported" });
    expect(link).toMatchObject({ claim_id: claimId, support_status: "supported" });

    await expect(repo().createClaimLink(identity, PROJECT, { claim_id: randomUUID() })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects linking a claim that is not readable by the project writer", async () => {
    if (!db.available) return;
    await makeSharedSpace();
    await addSpaceMember(SAME_SPACE_MEMBER);
    const hiddenClaimId = await seedClaim("Private claim", {
      visibility: "private",
      ownerUserId: SAME_SPACE_MEMBER,
      createdByUserId: SAME_SPACE_MEMBER,
    });

    await expect(repo().createClaimLink(identity, PROJECT, { claim_id: hiddenClaimId })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects linking the same claim to the project twice", async () => {
    if (!db.available) return;
    const claimId = await seedClaim();
    await repo().createClaimLink(identity, PROJECT, { claim_id: claimId });
    await expect(repo().createClaimLink(identity, PROJECT, { claim_id: claimId })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("flags a claim with no evidence and no declared gap as a high-severity finding", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();
    const claimId = await seedClaim();
    await repo().createClaimLink(identity, PROJECT, { claim_id: claimId, workflow_id: workflowId });

    const checkpoint = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const report = checkpoint as { blocking: boolean; findings: Array<{ code: string; severity: string }> };
    expect(report.blocking).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "no_evidence_no_gap", severity: "high" }));
  });

  it("does not let an unrelated workflow claim link block the current workflow integrity gate", async () => {
    if (!db.available) return;
    const currentWorkflowId = await seedWorkflow();
    const otherWorkflowId = await seedWorkflow();
    const claimId = await seedClaim();
    await repo().createClaimLink(identity, PROJECT, { claim_id: claimId, workflow_id: otherWorkflowId });

    const checkpoint = await repo().evaluateWorkflowIntegrity(identity, PROJECT, currentWorkflowId);
    const report = checkpoint as { blocking: boolean; findings: Array<{ code: string }> };
    expect(report.blocking).toBe(false);
    expect(report.findings.some((f) => f.code === "no_evidence_no_gap")).toBe(false);
  });

  it("does not flag a claim with an explicit gap even without evidence", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();
    const claimId = await seedClaim();
    await repo().createClaimLink(identity, PROJECT, {
      claim_id: claimId,
      workflow_id: workflowId,
      unresolved_gap: true,
      gap_reason: "no dataset available yet",
    });

    const checkpoint = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const report = checkpoint as { blocking: boolean; findings: unknown[] };
    expect(report.blocking).toBe(false);
    expect(report.findings).toHaveLength(0);
  });

  it("flags a citation anchor that is not a readable object in the Project corpus", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();
    const claimId = await seedClaim();
    const paperObjectId = await seedPaperObject("2401.00001");
    await addEvidence(claimId, paperObjectId);
    await addToCorpus(paperObjectId);
    await repo().createClaimLink(identity, PROJECT, {
      claim_id: claimId,
      workflow_id: workflowId,
      citation_anchors: [paperObjectId, randomUUID()],
    });

    const checkpoint = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const report = checkpoint as { blocking: boolean; findings: Array<{ code: string }> };
    expect(report.blocking).toBe(true);
    expect(report.findings.filter((f) => f.code === "citation_not_found")).toHaveLength(1);
  });

  it("accepts a generic document object as a citation anchor", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();
    const claimId = await seedClaim("A policy page documents the current rule");
    const documentObjectId = await seedGenericDocumentObject();
    await addEvidence(claimId, documentObjectId);
    await addToCorpus(documentObjectId);
    await repo().createClaimLink(identity, PROJECT, {
      claim_id: claimId,
      workflow_id: workflowId,
      citation_anchors: [documentObjectId],
    });

    const result = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const report = result as { blocking: boolean; findings: Array<{ code: string }> };
    expect(report.findings.some((finding) => finding.code === "citation_not_found")).toBe(false);
    expect(report.blocking).toBe(false);
  });

  it("flags evidence whose source object is not in the project corpus, and passes once it is added", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();
    const claimId = await seedClaim();
    const paperObjectId = await seedPaperObject("2401.00002");
    await addEvidence(claimId, paperObjectId);
    await repo().createClaimLink(identity, PROJECT, { claim_id: claimId, workflow_id: workflowId });

    const before = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const beforeReport = before as { findings: Array<{ code: string }> };
    expect(beforeReport.findings.some((f) => f.code === "evidence_not_in_project_corpus")).toBe(true);

    await addToCorpus(paperObjectId);
    const after = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const afterReport = after as { blocking: boolean; findings: Array<{ code: string }> };
    expect(afterReport.findings.some((f) => f.code === "evidence_not_in_project_corpus")).toBe(false);
    expect(afterReport.blocking).toBe(false);
  });

  it("flags an experiment-backed claim with no Experiment Definition, and passes once the planned Experiment is declared", async () => {
    if (!db.available) return;
    const workflowId = await seedWorkflow();
    const claimId = await seedClaim();
    const paperObjectId = await seedPaperObject("2401.00003");
    await addEvidence(claimId, paperObjectId);
    await addToCorpus(paperObjectId);
    const notYetDefinedId = randomUUID();
    const link = await repo().createClaimLink(identity, PROJECT, {
      claim_id: claimId,
      workflow_id: workflowId,
      planned_experiment_ids: [notYetDefinedId],
    }) as { id: string };

    const before = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const beforeReport = before as { blocking: boolean; findings: Array<{ code: string; severity: string }> };
    expect(beforeReport.blocking).toBe(true);
    expect(beforeReport.findings).toContainEqual(expect.objectContaining({ code: "experiment_provenance_not_found", severity: "high" }));

    const definition = await experimentDefinitions().createDefinition(identity, PROJECT, { name: "Ablate module X" });
    await repo().updateClaimLink(identity, PROJECT, link.id, { planned_experiment_ids: [definition.id] });
    const after = await repo().evaluateWorkflowIntegrity(identity, PROJECT, workflowId);
    const afterReport = after as { blocking: boolean; findings: Array<{ code: string }> };
    expect(afterReport.findings.some((f) => f.code === "experiment_provenance_not_found")).toBe(false);
    expect(afterReport.blocking).toBe(false);
  });

  it("updates a claim link's support status and gap fields", async () => {
    if (!db.available) return;
    const claimId = await seedClaim();
    const link = await repo().createClaimLink(identity, PROJECT, { claim_id: claimId });
    const updated = await repo().updateClaimLink(identity, PROJECT, link.id as string, {
      support_status: "supported",
      unresolved_gap: false,
    });
    expect(updated).toMatchObject({ support_status: "supported", unresolved_gap: false });
  });
});
