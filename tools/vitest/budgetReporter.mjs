import { readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * Hard time budgets for a Vitest run.
 *
 * Documentation did not stop the suites from blowing up twice, because the
 * cost that blew up was never a single bad test: it was old, reasonable tests
 * whose per-call cost grew with the size of the schema and the module graph.
 * Only measurement catches that, so this reporter measures every run and
 * fails it when a number doubles rather than drifts:
 *
 * - any one file's module import time over `maxFileImportMs`;
 * - any one test over `maxTestMs`;
 * - the run's total import time or total test time over the committed
 *   baseline times `tolerance`.
 *
 * Totals are summed per file, not wall clock, so they do not depend on the
 * worker count or the machine. Raising a limit means editing the budget file
 * in the same change, where review can see it. The ten slowest files by
 * import and by test time are printed on every run so slow growth stays
 * visible between the times the gate fires.
 */
export default class BudgetReporter {
  constructor(options = {}) {
    this.budgetPath = options.budgetPath;
    this.budget = JSON.parse(readFileSync(this.budgetPath, "utf8"));
  }

  onTestRunEnd(testModules = []) {
    const budget = this.budget;
    const rows = testModules.map((module) => {
      const diagnostic = module.diagnostic();
      const tests = [...module.children.allTests()].map((test) => ({
        name: test.fullName,
        ms: test.diagnostic()?.duration ?? 0,
      }));
      return {
        file: relative(process.cwd(), module.moduleId),
        importMs: diagnostic.collectDuration ?? 0,
        testMs: tests.reduce((sum, test) => sum + test.ms, 0),
        tests,
      };
    });
    if (rows.length === 0) return;

    const totals = {
      importMs: Math.round(rows.reduce((sum, row) => sum + row.importMs, 0)),
      testMs: Math.round(rows.reduce((sum, row) => sum + row.testMs, 0)),
    };
    const violations = [];
    for (const row of rows) {
      if (row.importMs > budget.maxFileImportMs) {
        violations.push(`${row.file}: module import took ${fmt(row.importMs)} (limit ${fmt(budget.maxFileImportMs)})`);
      }
      for (const test of row.tests) {
        if (test.ms > budget.maxTestMs) {
          violations.push(`${row.file} > ${test.name}: ${fmt(test.ms)} (limit ${fmt(budget.maxTestMs)})`);
        }
      }
    }
    // Totals only make sense for the whole suite; a filtered run is not one.
    const wholeSuite = rows.length >= budget.baseline.files * 0.9;
    if (wholeSuite) {
      for (const key of ["importMs", "testMs"]) {
        const limit = budget.baseline[key] * budget.tolerance;
        if (totals[key] > limit) {
          violations.push(`suite total ${key} ${fmt(totals[key])} exceeds baseline ${fmt(budget.baseline[key])} x ${budget.tolerance} = ${fmt(limit)}`);
        }
      }
    }

    const top = (key) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, 10)
      .map((row) => `    ${fmt(row[key]).padStart(8)}  ${row.file}`).join("\n");
    const lines = [
      "",
      `Test budget (${relative(process.cwd(), this.budgetPath)}): files ${rows.length}, ` +
        `import total ${fmt(totals.importMs)}, test total ${fmt(totals.testMs)}` +
        (wholeSuite ? ` (baseline ${fmt(budget.baseline.importMs)} / ${fmt(budget.baseline.testMs)}, tolerance x${budget.tolerance})` : " (partial run: totals not checked)"),
      "  slowest imports:", top("importMs"),
      "  slowest test files:", top("testMs"),
    ];
    if (violations.length) {
      lines.push("", "  BUDGET EXCEEDED:", ...violations.map((v) => `    - ${v}`), "",
        "  A doubling like this is a structural cost, not noise: find what made every file or test pay more,",
        `  or raise the limit deliberately in ${relative(process.cwd(), this.budgetPath)}.`);
    }
    process.stderr.write(lines.join("\n") + "\n");
    if (violations.length) throw new Error(`test budget exceeded (${violations.length} violation${violations.length === 1 ? "" : "s"})`);
  }
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
