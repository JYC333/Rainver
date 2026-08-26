import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Patterns that made this suite slow once and must not come back.
 *
 * Each rule below is a cost that scales with the size of the system rather
 * than with the test: truncating cascades across the whole schema, building
 * the whole server to test one module's routes, re-running migrations on a
 * cloned database, waiting on real time. A test using one of them looks fine
 * on the day it is written and gets slower with every table and module added.
 * Exemptions are listed here, by file, so adding one is a visible decision.
 */

const testDir = import.meta.dirname;
const files = readdirSync(testDir).filter((name) => name.endsWith(".test.ts") && name !== "testHygiene.test.ts");
const source = new Map(files.map((name) => [name, readFileSync(join(testDir, name), "utf8")]));

function offenders(matches: (name: string, text: string) => boolean, exempt: readonly string[] = []): string[] {
  return files.filter((name) => !exempt.includes(name) && matches(name, source.get(name)!)).sort();
}

describe("test hygiene", () => {
  it("clears rows with resetTables, never TRUNCATE", () => {
    expect(offenders((_, text) => /\bTRUNCATE\b(?![^\n]*\/\/)/.test(text.replace(/\/\/[^\n]*/g, "")))).toEqual([]);
  });

  it("builds only the module under test, not the whole server", () => {
    expect(offenders((_, text) => /from "\.\.\/src\/server"/.test(text), [
      // The gateway and the registry as a whole are what these test.
      "gateway.test.ts",
      "health.test.ts",
      "registryOwnership.test.ts",
      // automations' onReady checks every module's automation-target handler is registered.
      "automationsAutonomyEnableDb.test.ts",
    ])).toEqual([]);
  });

  it("does not migrate a database cloned from the migrated template", () => {
    expect(offenders(
      (_, text) => /\bmigrate\(/.test(text) && !/empty:\s*true/.test(text),
      ["migrator.test.ts"],
    )).toEqual([]);
  });

  it("declares its database with useTestDatabase, never its own container or pool", () => {
    expect(offenders((_, text) => /\bgetTestPostgres\(/.test(text))).toEqual([]);
    expect(offenders((_, text) => /\bnew Pool\(/.test(text), [
      // Deliberately small pools, to prove the code under test survives saturation.
      "coreVersionIntegrityDb.test.ts",
      "runSupervisorDb.test.ts",
    ])).toEqual([]);
  });

  it("does not mock the global pool module in new files", () => {
    // Mocking src/db/pool.js reaches a module-level seam instead of injecting a
    // Queryable, and a file that does it cannot share a module graph with any
    // other. The list below is the existing debt; it must only shrink.
    expect(offenders((_, text) => /vi\.mock\("\.\.\/src\/db\/pool\.js"/.test(text), [
      "agentsCrudRoutes.test.ts", "automationsProjectDb.test.ts", "claimReviewLoopRoutes.test.ts",
      "claimSourcesSourcePolicy.test.ts", "cliCredentialStatus.test.ts", "contextOpsRoutes.test.ts",
      "evolutionRoutes.test.ts", "jobsSchedulers.test.ts", "knowledgeRetrievalEvalRoutes.test.ts",
      "knowledgeRetrievalExplainRoutes.test.ts", "knowledgeRetrievalRoutes.test.ts", "memoryMaintenanceRoutes.test.ts",
      "objectProfileRegistry.test.ts", "publicationsRoutes.test.ts", "runManagedApiAdapter.test.ts", "runtimeToolsRoutes.test.ts",
    ])).toEqual([]);
  });

  it("imports a module's barrel only for its ServerModule object", () => {
    // A barrel re-exports the module's routes, jobs, and services together, so
    // importing one service through it loads the whole module. Deep paths keep
    // a file's import graph the size of what it tests; the barrel is for the
    // `xModule` object that buildModuleServer needs.
    // A file that vi.mock()s a barrel must import through that same barrel,
    // or the mock would not be what it calls.
    const barrelImport = /^import\s+\{([^}]*)\}\s+from\s+"(\.\.\/src\/modules\/[a-zA-Z_]+\/index\.js)";/gm;
    expect(offenders((_, text) => [...text.matchAll(barrelImport)].some((m) =>
      !text.includes(`vi.mock("${m[2]}"`)
        && m[1].split(",").map((n) => n.trim().replace(/^type\s+/, "")).filter(Boolean).some((n) => !/Module$/.test(n)),
    ))).toEqual([]);
  });

  it("adds small tests to the family's group file instead of opening a new one", () => {
    // Every file pays the module graph once; a two-test file pays it for two
    // tests. Families that already have a *Group file take new small tests
    // there. The list below is the existing debt; it must only shrink.
    const groups = files.filter((name) => /Group\.test\.ts$/.test(name));
    const family = (name: string) => name.replace(/\.test\.ts$/, "").replace(/([a-z0-9])([A-Z].*)$/, "$1");
    expect(offenders((name, text) => {
      const tests = (text.match(/^\s*(?:it|test)(?:\.each\([^)]*\))?\(/gm) ?? []).length;
      return tests > 0 && tests < 3 && !/Group\.test\.ts$/.test(name) && groups.some((g) => g.startsWith(family(name)));
    }, [
      "claimSourcesSourcePolicy.test.ts", "contentAccessEquivalence.test.ts", "evolutionRoutes.test.ts",
      "knowledgeRetrievalExplainRoutes.test.ts", "projectBriefConversationProjection.test.ts", "projectCorpusGraph.test.ts",
      "projectExecutionModeAdapters.test.ts", "projectOverviewPlaceholders.test.ts", "projectResearchExecutionProfileDb.test.ts",
      "projectResearchInitialIntakeCoordinator.test.ts", "projectResearchQuestionRefineRoutesDb.test.ts", "projectResearchReconcileNudge.test.ts",
      "projectResearchRetryService.test.ts", "projectResearchUsageDb.test.ts", "retrievalDiagnosticsPacket.test.ts",
      "retrievalExplainArtifacts.test.ts", "retrievalReindexIsolationDb.test.ts", "retrievalRelationalIntent.test.ts",
      "retrievalSourcePolicy.test.ts", "runWorkflowServiceDb.test.ts", "sourceRetrievalAccess.test.ts",
      "sourceScanSchedule.test.ts", "sourceServiceBoundaries.test.ts", "usageOversight.test.ts",
    ])).toEqual([]);
  });

  // Files in the "shared" vitest project run one after another in the same
  // worker, so anything left in module-level state leaks into the next file.
  it("resets every src test seam it sets", () => {
    expect(offenders((_, text) => {
      const seams = new Set([...text.matchAll(/(__set[A-Za-z]+ForTests)\(/g)].map((m) => m[1]));
      const hasAfter = /^\s*after(Each|All)\(/m.test(text);
      return [...seams].some((seam) => !hasAfter || !new RegExp(`${seam}\\((null|undefined|\\{\\})\\)`).test(text));
    })).toEqual([]);
  });

  it("restores real timers in an afterEach when it fakes them", () => {
    expect(offenders((_, text) => /useFakeTimers/.test(text) && !/afterEach\([^]*?useRealTimers/.test(text))).toEqual([]);
  });

  it("does not add files to the isolated project (vi.mock)", () => {
    // Each of these costs a full module-graph evaluation; move a file off
    // the list by replacing vi.mock with a src test seam or a real fake.
    expect(offenders((_, text) => text.includes("vi.mock("), [
      "agentsCrudRoutes.test.ts",
      "automationsProjectDb.test.ts",
      "claimReviewLoopRoutes.test.ts",
      "claimSourcesSourcePolicy.test.ts",
      "cliCredentialStatus.test.ts",
      "contextOpsReviewCycle.test.ts",
      "contextOpsRoutes.test.ts",
      "evolutionRoutes.test.ts",
      "jobsSchedulers.test.ts",
      "knowledgeRetrievalEvalRoutes.test.ts",
      "knowledgeRetrievalExplainRoutes.test.ts",
      "knowledgeRetrievalRoutes.test.ts",
      "memoryMaintenanceRoutes.test.ts",
      "objectProfileRegistry.test.ts",
      "publicationsRoutes.test.ts",
      "retrievalReranker.test.ts",
      "runManagedApiAdapter.test.ts",
      "runtimeToolsRoutes.test.ts",
      "systemActionDispatcher.test.ts",
      "systemActionRegistry.test.ts",
    ])).toEqual([]);
  });

  it("does not wait on real time for more than 100ms", () => {
    // Guards that reject on a timeout are fine; resolving after a sleep is not.
    const sleep = /setTimeout\(\s*(?:\(\)\s*=>\s*)?(?:resolve|r|res|done)\b[^,)]*,\s*(\d[\d_]*)\s*\)/g;
    expect(offenders((_, text) => {
      for (const match of text.matchAll(sleep)) {
        if (Number(match[1].replaceAll("_", "")) > 100) return true;
      }
      return false;
    })).toEqual([]);
  });
});
