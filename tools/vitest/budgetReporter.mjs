import { readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * Advisory time budgets for a Vitest run. Measurements and the ten slowest
 * files remain visible on every run; exceeding a budget never changes the
 * result. Test assertions, collection errors and reporter errors still fail.
 * Totals are per-file sums, not wall clock, and vary with machine load.
 */
export default class BudgetReporter {
  constructor(options = {}) {
    this.budgetPath = options.budgetPath;
    this.budget = this.budgetPath ? JSON.parse(readFileSync(this.budgetPath, "utf8")) : null;
  }

  onTestCaseResult(test) {
    // Worker events can be buffered. Use Vitest's completed measurement instead
    // of treating reporter event arrival times as the test's runtime.
    const duration = test.diagnostic()?.duration ?? 0;
    if (duration > 5_000) {
      process.stderr.write(`WARNING: test ${test.fullName} completed in ${fmt(duration)} (5s runtime budget; advisory)\n`);
    }
  }

  onTestModuleEnd(module) {
    const duration = module.diagnostic().duration;
    if (duration > 5_000) {
      process.stderr.write(`WARNING: ${relative(process.cwd(), module.moduleId)} tests and hooks took ${fmt(duration)} (5s runtime budget; advisory)\n`);
    }
  }

  onTestRunEnd(testModules = [], _errors, reason) {
    if (reason === "interrupted") {
      process.stderr.write("INCOMPLETE: test run interrupted; unfinished work is not a pass.\n");
    }
    if (!this.budget) return;
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
      lines.push("", "  WARNING: TEST TIME BUDGET EXCEEDED (advisory):", ...violations.map((v) => `    - ${v}`), "",
        "  Investigate slow imports/tests; machine contention can also increase these measurements.",
        `  Baselines and warning thresholds: ${relative(process.cwd(), this.budgetPath)}.`);
    }
    process.stderr.write(lines.join("\n") + "\n");
  }
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// Also used by browser performance checks; functional assertions stay separate.
export function warnTimeBudget(label, measuredMs, limitMs) {
  if (!Number.isFinite(measuredMs) || !Number.isFinite(limitMs)) {
    throw new TypeError(`Invalid timing measurement or budget for ${label}`);
  }
  if (measuredMs > limitMs) {
    console.warn(`WARNING: ${label} took ${measuredMs}ms (budget ${limitMs}ms; advisory)`);
  }
}
