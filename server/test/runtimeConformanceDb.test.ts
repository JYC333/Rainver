import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import {
  CONFORMANCE_CHECKS,
  RuntimeConformanceService,
  type ConformanceCheck,
} from "../src/modules/runtimeConformance";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[runtime-conformance-db] skipped — Docker/Postgres unavailable: ${String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE runtime_conformance_results");
});

function allChecks(passed: boolean) {
  return Object.fromEntries(CONFORMANCE_CHECKS.map((check) => [check, { passed }])) as Record<ConformanceCheck, { passed: boolean }>;
}

describe("runtime conformance persistence (real Postgres)", () => {
  it("persists a failed result fail-closed, then replaces it with a complete pass", async () => {
    if (!available || !pool) return;
    const service = new RuntimeConformanceService(pool);
    const failed = await service.record({
      runtime_adapter_type: "opencode",
      runtime_version: "1.0.0",
      checks: { ...allChecks(true), credential_leakage: { passed: false, evidence: { leak: "detected" } } },
    });
    expect(failed).toMatchObject({ status: "partial", passed_checks: 4, failed_checks: 1, trust_level: "low" });

    const passed = await service.record({
      runtime_adapter_type: "opencode",
      runtime_version: "1.0.0",
      checks: allChecks(true),
    });
    expect(passed).toMatchObject({ status: "passed", passed_checks: 5, failed_checks: 0, trust_level: "low" });
    expect(await service.list("opencode")).toHaveLength(1);
  });

  it("records runner exceptions as failed checks instead of granting trust", async () => {
    if (!available || !pool) return;
    const result = await new RuntimeConformanceService(pool).run({
      runtime_adapter_type: "opencode",
      runtime_version: "1.0.0",
      runner: {
        async runCheck(check) {
          if (check === "file_scope_obedience") throw new Error("probe unavailable");
          return { passed: true };
        },
      },
    });
    expect(result).toMatchObject({ status: "partial", passed_checks: 4, failed_checks: 1, trust_level: "low" });
    expect(result.checks.file_scope_obedience).toMatchObject({ passed: false });
  });
});

