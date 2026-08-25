import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import {
  CONFORMANCE_CHECKS,
  RuntimeConformanceService,
  type ConformanceCheck,
} from "../src/modules/runtimeConformance";


const db = useTestDatabase(__filename, { max: 2 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["runtime_conformance_results"]);
});

function allChecks(passed: boolean) {
  return Object.fromEntries(CONFORMANCE_CHECKS.map((check) => [check, { passed }])) as Record<ConformanceCheck, { passed: boolean }>;
}

describe("runtime conformance persistence (real Postgres)", () => {
  it("persists a failed result fail-closed, then replaces it with a complete pass", async () => {
    if (!db.available) return;
    const service = new RuntimeConformanceService(db.pool);
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
    if (!db.available) return;
    const result = await new RuntimeConformanceService(db.pool).run({
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

