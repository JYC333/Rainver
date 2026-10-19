import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { POLICY_ACTION_REGISTRY } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { engineCheck } from "../src/modules/policy/decisionCore.js";
import { authorizeCredentialSpend, CredentialSpendDeniedError } from "../src/modules/policy/credentialSpend.js";
import {
  effectiveRunTrigger,
  UNVERIFIED_LINEAGE_ORIGIN,
} from "../src/modules/systemActions/effectiveRunTrigger.js";

// The one lineage every origin gate reads (plan P05 / D3): a turn's authority
// is its verified root's. A continuation the system started inherits from its
// cause only while inside its budget; anything unverifiable is unattended and
// never falls back to `manual`.

const SPACE = "d3d3d3d3-0000-4000-8000-000000000001";
const OWNER = "d3d3d3d3-0000-4000-8000-000000000002";
const PROJECT = "d3d3d3d3-0000-4000-8000-000000000003";
const AGENT = "d3d3d3d3-0000-4000-8000-000000000004";
const VERSION = "d3d3d3d3-0000-4000-8000-000000000005";

const db = useTestDatabase(import.meta.filename);
const registry = new Map(POLICY_ACTION_REGISTRY.map((definition) => [definition.action, definition]));

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["policy_decision_records", "runs", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER });
});

interface SeededRun {
  id: string;
  space_id: string;
  trigger_origin: string;
  instructed_by_user_id: string | null;
  parent_run_id: string | null;
  contract_snapshot_json: null;
}

async function run(origin: string, links: { parent?: string; cause?: string | null } = {}): Promise<SeededRun> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       owner_user_id, instructed_by_user_id, parent_run_id, root_run_id, cause_run_id, created_at, updated_at, execution_kind)
     VALUES ($1,$2,$3,$4,'agent',$5,'queued','live',$6,$6,$7,$7,$8,now(),now(),'agent')`,
    [id, SPACE, AGENT, VERSION, origin, OWNER, links.parent ?? null, links.cause ?? null],
  );
  return { id, space_id: SPACE, trigger_origin: origin, instructed_by_user_id: OWNER, parent_run_id: links.parent ?? null, contract_snapshot_json: null };
}

/** What the unattended-write gate decides for a Project write from this Run. */
async function taskCreateDecision(target: SeededRun): Promise<string> {
  const { origin } = await effectiveRunTrigger(db.pool, target);
  return engineCheck(registry, { action: "task.create", space_id: SPACE, trigger_origin: origin }).decision;
}

describe("Run lineage (real Postgres)", () => {
  it("lets a bounded continuation of a person's turn carry that turn's authority", async () => {
    if (!db.available) return;
    const turn = await run("manual");
    const recipient = await run("manual", { parent: turn.id });
    const delegated = await run("delegation", { parent: recipient.id });
    const report = await run("continuation", { cause: delegated.id });
    const nextWave = await run("continuation", { cause: report.id });

    for (const target of [recipient, delegated, report, nextWave]) {
      await expect(effectiveRunTrigger(db.pool, target)).resolves.toMatchObject({
        origin: "manual", instructedByUserId: OWNER, rootRunId: turn.id,
      });
      expect(await taskCreateDecision(target)).toBe("allow");
    }
    // The hops stay visible for audit even though they grant nothing new.
    await expect(effectiveRunTrigger(db.pool, nextWave)).resolves.toMatchObject({ continuationHops: 2 });
  });

  it("keeps scheduled and mixed chains unattended, however many hops a person's Room adds", async () => {
    if (!db.available) return;
    const scheduled = await run("automation");
    const delegated = await run("delegation", { parent: scheduled.id });
    const report = await run("continuation", { cause: delegated.id });

    for (const target of [delegated, report]) {
      await expect(effectiveRunTrigger(db.pool, target)).resolves.toMatchObject({ origin: "automation", rootRunId: scheduled.id });
      expect(await taskCreateDecision(target)).toBe("require_approval");
    }
  });

  it("treats a continuation past its budget, or with a chain that cannot be verified, as nobody's instruction", async () => {
    if (!db.available) return;
    // Recorded with no cause: over budget, or no originating turn to name.
    const unattributed = await run("continuation", { cause: null });
    await expect(effectiveRunTrigger(db.pool, unattributed)).resolves.toMatchObject({
      origin: "continuation", instructedByUserId: null, rootRunId: null,
    });
    expect(await taskCreateDecision(unattributed)).toBe("require_approval");

    // A forged loop: two continuations naming each other never reach a root.
    const a = await run("continuation", { cause: null });
    const b = await run("continuation", { cause: a.id });
    await db.pool.query(`UPDATE runs SET cause_run_id = $2 WHERE id = $1`, [a.id, b.id]);
    await expect(effectiveRunTrigger(db.pool, b)).resolves.toMatchObject({
      origin: UNVERIFIED_LINEAGE_ORIGIN, instructedByUserId: null, rootRunId: null,
    });
    expect(await taskCreateDecision(b)).toBe("require_approval");

    // A delegated child that names no delegating Run is not a chain at all.
    const orphanChild = await run("delegation");
    await expect(effectiveRunTrigger(db.pool, orphanChild)).resolves.toMatchObject({ origin: UNVERIFIED_LINEAGE_ORIGIN, instructedByUserId: null });

    // Only a continuation may name a cause: a person's turn cannot be given one.
    const turn = await run("manual");
    await expect(db.pool.query(`UPDATE runs SET cause_run_id = $2 WHERE id = $1`, [turn.id, a.id]))
      .rejects.toMatchObject({ constraint: "ck_runs_cause_run_continuation" });
  });

  it("spends credentials on the same lineage the write gates read", async () => {
    if (!db.available) return;
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const turn = await run("manual");
    const report = await run("continuation", { cause: (await run("delegation", { parent: turn.id })).id });
    const spent = await authorizeCredentialSpend(config, { space_id: SPACE, provider_id: null, basis: { kind: "run", run: report } });
    expect(spent.trigger_origin).toBe("manual");

    const unattributed = await run("continuation", { cause: null });
    await expect(authorizeCredentialSpend(config, { space_id: SPACE, provider_id: null, basis: { kind: "run", run: unattributed } }))
      .rejects.toBeInstanceOf(CredentialSpendDeniedError);
  });
});
