import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import * as poolModule from "../src/db/pool";
import { migrate } from "../src/db/migrator";
import { runBuiltInSeeds } from "../src/db/seeds";
import { loadConfig } from "../src/config";
import { buildServer } from "../src/server";
import { __setAuthIdentityForTests } from "../src/modules/auth";
import {
  EVOLUTION_PLAN_REVIEW_SCHEMA,
} from "../src/modules/evolution/prompt";
import { EvolutionRepository } from "../src/modules/evolution/repository";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const CATALOG_ROOT = join(process.cwd(), "..", "catalog");

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    // Built-in evolution strategy assets (e.g. "repair.runtime_failure") are
    // seeded at runtime, not embedded in the migration — see
    // server/src/db/seeds.ts. Tests below select strategies by key and need
    // them present.
    await runBuiltInSeeds(pool, { info: () => {} }, CATALOG_ROOT);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[evolution-repository] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("EvolutionRepository core", () => {
  it("creates a queued evolution run with selector decision and prompt", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const identity = await seedIdentity();
    const agentId = await seedAgent(identity);
    const targetId = await seedTarget(identity, { agentId, maxStrategyRisk: "medium" });
    await seedSignal(identity, targetId, "runtime_failure");
    const repository = new EvolutionRepository(pool);

    const result = await repository.recordRunSetup(identity, targetId, agentId, {});

    expect(result).toMatchObject({
      targetId,
      agentId,
      selectedStrategyKey: "repair.runtime_failure",
    });
    expect(result.runId).toBeTruthy();
    expect(result.selectorDecisionId).toBeTruthy();

    const run = await pool.query<{
      status: string;
      run_type: string;
      agent_id: string;
      prompt: string | null;
      instruction: string | null;
    }>(
      "SELECT status, run_type, agent_id, prompt, instruction FROM runs WHERE id = $1 AND space_id = $2",
      [result.runId, identity.spaceId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "queued",
      run_type: "evolution",
      agent_id: agentId,
    });
    expect(run.rows[0]!.prompt).toContain(EVOLUTION_PLAN_REVIEW_SCHEMA);
    expect(run.rows[0]!.prompt).toContain(result.selectorDecisionId);
    expect(run.rows[0]!.instruction).toContain("agent-space Evolution planner");

    const decision = await pool.query<{ run_id: string; selected_strategy_asset_id: string | null }>(
      "SELECT run_id, selected_strategy_asset_id FROM evolution_selector_decisions WHERE id = $1 AND space_id = $2",
      [result.selectorDecisionId, identity.spaceId],
    );
    expect(decision.rows[0]).toMatchObject({
      run_id: result.runId,
      selected_strategy_asset_id: result.selectedStrategyAssetId,
    });
  });

  it("rejects runs with no signals unless allow_no_signal is set", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const identity = await seedIdentity();
    const agentId = await seedAgent(identity);
    const targetId = await seedTarget(identity, { agentId, maxStrategyRisk: "medium" });
    const repository = new EvolutionRepository(pool);

    await expect(repository.recordRunSetup(identity, targetId, agentId, {})).rejects.toThrow(
      "Evolution target has no recent signals",
    );
  });

  it("rejects live evolution mode in v1", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const identity = await seedIdentity();
    const agentId = await seedAgent(identity);
    const targetId = await seedTarget(identity, { agentId, maxStrategyRisk: "medium" });
    await seedSignal(identity, targetId, "runtime_failure");
    const repository = new EvolutionRepository(pool);

    await expect(repository.recordRunSetup(identity, targetId, agentId, { mode: "live" })).rejects.toThrow(
      "live evolution execution is not supported in v1; use dry_run",
    );
  });

  it("lists system and current-space strategies without leaking other spaces", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const identity = await seedIdentity();
    const other = await seedIdentity();
    await seedStrategy(identity.spaceId, "space.only");
    await seedStrategy(other.spaceId, "other.only");
    const repository = new EvolutionRepository(pool);

    const strategies = await repository.listStrategies(identity, {
      status: "active",
      targetType: null,
      limit: 200,
      offset: 0,
    });
    const keys = strategies.map((strategy) => strategy.strategy_key);

    expect(keys).toContain("repair.runtime_failure");
    expect(keys).toContain("space.only");
    expect(keys).not.toContain("other.only");
  });

  it("serves seeded strategies through the HTTP route after fresh migration", async (ctx) => {
    if (!available || !pool || !container) return ctx.skip();
    const identity = await seedIdentity();
    __setAuthIdentityForTests({ spaceId: identity.spaceId, userId: identity.userId });
    const poolSpy = vi.spyOn(poolModule, "getDbPool").mockReturnValue(pool);
    let app: FastifyInstance | undefined;
    try {
      app = buildServer(loadConfig({ SERVER_DATABASE_URL: container.getConnectionUri() }), { logger: false });
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/evolution/strategies?status=active&limit=100",
      });

      expect(response.statusCode).toBe(200);
      const keys = (response.json() as Array<{ strategy_key: string }>).map((strategy) => strategy.strategy_key);
      expect(keys).toEqual(expect.arrayContaining([
        "repair.runtime_failure",
        "repair.validation_failure",
        "optimize.prompt_asset",
        "optimize.tool_usage",
        "harden.policy_boundary",
        "improve.capability_gap",
        "review.open_skill_import",
        "maintain.memory_health",
        "maintain.knowledge_retrieval",
        "solidifyExperience.successful_run",
      ]));
    } finally {
      await app?.close();
      poolSpy.mockRestore();
      __setAuthIdentityForTests(null);
    }
  });

  it("requires an explicit Agent instead of creating a system evolver fallback", async (ctx) => {
    if (!available || !pool || !container) return ctx.skip();
    const identity = await seedIdentity();
    const targetId = await seedTarget(identity, {
      agentId: null,
      maxStrategyRisk: "medium",
    });
    __setAuthIdentityForTests({ spaceId: identity.spaceId, userId: identity.userId });
    const poolSpy = vi.spyOn(poolModule, "getDbPool").mockReturnValue(pool);
    let app: FastifyInstance | undefined;
    try {
      app = buildServer(loadConfig({ SERVER_DATABASE_URL: container.getConnectionUri() }), {
        logger: false,
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/evolution/targets/${targetId}/run`,
        payload: { mode: "dry_run" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        detail: "agent_id is required in the request or target metadata",
      });
      const agents = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM agents WHERE space_id = $1",
        [identity.spaceId],
      );
      expect(agents.rows[0]?.count).toBe("0");
    } finally {
      await app?.close();
      poolSpy.mockRestore();
      __setAuthIdentityForTests(null);
    }
  });

  it("returns deterministic validation results from target metadata", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const identity = await seedIdentity();
    const targetId = await seedTarget(identity, {
      agentId: null,
      maxStrategyRisk: "medium",
      validation: {
        window: "14d",
        metrics: [{
          id: "target_signal_count",
          label: "Target signal count",
          evaluator: "count_signals",
          source: "signals",
          signal_type: "run_validation_failed",
          goal: { direction: "decrease", threshold: 0 },
        }],
      },
    });
    await seedSignal(identity, targetId, "run_validation_failed");
    const repository = new EvolutionRepository(pool);

    const results = await repository.listValidationResults(identity);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric_id: "target_signal_count",
        evaluator: "count_signals",
        target_id: targetId,
        value: 1,
        status: "failed",
        sample_size: 1,
        numerator_count: 1,
      }),
    ]));
  });
});

async function seedIdentity(): Promise<SpaceUserIdentity> {
  const userId = randomUUID();
  const spaceId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'User', 'active', $2, $2)`,
    [userId, now],
  );
  await pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Space', 'team', $2, $3, $3)`,
    [spaceId, userId, now],
  );
  return { spaceId, userId };
}

async function seedAgent(identity: SpaceUserIdentity): Promise<string> {
  const agentId = randomUUID();
  const versionId = randomUUID();
  const runtimeProfileId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, current_version_id,
       created_at, updated_at, visibility
     ) VALUES ($1, $2, $3, 'Evolution Agent', 'active', NULL, $4, $4, 'space_shared')`,
    [agentId, identity.spaceId, identity.userId, now],
  );
  await pool!.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'Review evolution plans.',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [versionId, agentId, identity.spaceId, now],
  );
  await pool!.query(
    "UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE id = $1 AND space_id = $2",
    [agentId, identity.spaceId, versionId, now],
  );
  await pool!.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Default', 'capability',
       '{"adapter_type":"capability"}'::jsonb, '{}'::jsonb, true, true, $4, $4)`,
    [runtimeProfileId, identity.spaceId, agentId, now],
  );
  return agentId;
}

async function seedTarget(
  identity: SpaceUserIdentity,
  options: { agentId: string | null; maxStrategyRisk: string; validation?: Record<string, unknown> },
): Promise<string> {
  const targetId = randomUUID();
  const now = new Date().toISOString();
  const metadata = {
    target_name: "Runtime repair target",
    ...(options.agentId ? { agent_id: options.agentId } : {}),
    ...(options.validation ? { validation: options.validation } : {}),
  };
  await pool!.query(
    `INSERT INTO evolution_targets (
       id, space_id, target_type, risk_level, status, enabled,
       engine_policy_json, metadata_json, created_at, updated_at
     ) VALUES (
       $1, $2, 'system', 'medium', 'active', true,
       $3::jsonb, $4::jsonb, $5, $5
     )`,
    [
      targetId,
      identity.spaceId,
      JSON.stringify({ max_strategy_risk: options.maxStrategyRisk }),
      JSON.stringify(metadata),
      now,
    ],
  );
  return targetId;
}

async function seedSignal(
  identity: SpaceUserIdentity,
  targetId: string,
  signalType: string,
): Promise<void> {
  await pool!.query(
    `INSERT INTO evolution_signals (
       id, space_id, target_id, signal_type, source_type, severity,
       summary, payload_json, created_at
     ) VALUES ($1, $2, $3, $4, 'manual', 'medium', 'Runtime failed.', '{}'::jsonb, $5)`,
    [randomUUID(), identity.spaceId, targetId, signalType, new Date().toISOString()],
  );
}

async function seedStrategy(spaceId: string, strategyKey: string): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO evolution_strategy_assets (
       id, space_id, strategy_key, name, description, category, target_type,
       status, risk_level, signals_match_json, preconditions_json,
       strategy_steps_json, constraints_json, validation_policy_json,
       tool_policy_json, routing_hint_json, provenance_type, source_ref_json,
       success_count, failure_count, confidence_score, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $3, NULL, 'repair', 'system',
       'active', 'low', '[]'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, 'user_authored', '{}'::jsonb,
       0, 0, 0.5, $4, $4
     )`,
    [randomUUID(), spaceId, strategyKey, now],
  );
}
