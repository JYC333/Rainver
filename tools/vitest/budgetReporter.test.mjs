import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import BudgetReporter, { warnTimeBudget } from './budgetReporter.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const vitestRoot = dirname(require.resolve('vitest/package.json'));
const reporter = new URL('./budgetReporter.mjs', import.meta.url).pathname;
const budget = { maxFileImportMs: -1, maxTestMs: -1, tolerance: 2,
  baseline: { files: 1, importMs: -1, testMs: -1 } };

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'rainver-budget-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function runVitest(assertion, { slow = false, cancel = false } = {}) {
  return fixture(root => {
    writeFileSync(join(root, 'budget.json'), JSON.stringify(budget));
    writeFileSync(join(root, 'slow.mjs'), 'const start = performance.now(); while (performance.now() - start < 5) {}');
    writeFileSync(join(root, 'budget.test.mjs'), `
      import './slow.mjs';
      import { test, expect, beforeAll } from ${JSON.stringify(pathToFileURL(join(vitestRoot, 'dist/index.js')).href)};
      beforeAll(async () => { ${slow ? 'await new Promise(r => setTimeout(r, 5200));' : ''} });
      test('real assertion', async () => {
        console.log('FIXTURE STARTED', process.pid);
        ${slow || cancel ? `await new Promise(r => setTimeout(r, ${cancel ? 60_000 : 5_200}));` : ''}
        expect(1).toBe(${assertion});
      });
    `);
    writeFileSync(join(root, 'vitest.config.mjs'), `export default { test: {
      include: ['*.test.mjs'],
      testTimeout: 0, hookTimeout: 0,
      experimental: { importDurations: { print: 'on-warn', failOnDanger: false, thresholds: { warn: 0, danger: 0 } } },
      reporters: ['default', [${JSON.stringify(reporter)}, { budgetPath: ${JSON.stringify(join(root, 'budget.json'))} }]]
    } };`);
    const result = spawnSync(process.execPath, [join(vitestRoot, 'vitest.mjs'), 'run', '--root', root,
      '--config', join(root, 'vitest.config.mjs')], {
      encoding: 'utf8', ...(cancel ? { timeout: 8_000, killSignal: 'SIGKILL' } : {}),
      // The timeout kills the coordinator, not its fork workers. Give this
      // intentional cancellation fixture its own process group on POSIX.
      detached: cancel && process.platform !== 'win32',
      env: { ...process.env, NO_COLOR: '1' },
    });
    if (cancel) {
      if (process.platform !== 'win32' && result.pid) {
        try { process.kill(-result.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      assert.equal(result.error?.code, 'ETIMEDOUT');
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(result.status, null);
      return { status: result.status, output: result.stdout + result.stderr };
    }
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return { status: result.status, output: result.stdout + result.stderr };
  });
}

test('over-budget completed run and danger imports warn with exit 0', () => {
  const result = runVitest(1);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /WARNING: TEST TIME BUDGET EXCEEDED/);
  assert.match(result.output, /module import took/);
  assert.match(result.output, /real assertion.*limit/);
  assert.match(result.output, /suite total importMs/);
  assert.match(result.output, /suite total testMs/);
  assert.match(result.output, /Import Duration Breakdown/);
  assert.match(result.output, /slow\.mjs/);
});

test('test and hook past 5s complete with warnings and exit 0', () => {
  const result = runVitest(1, { slow: true });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /WARNING: test .*completed in .*5s runtime budget; advisory/);
  assert.match(result.output, /WARNING: .*tests and hooks took .*5s runtime budget; advisory/);
});

test('outer cancellation leaves the unfinished run without a passed result or live worker', async () => {
  const result = runVitest(1, { cancel: true });
  assert.match(result.output, /FIXTURE STARTED/);
  assert.doesNotMatch(result.output, /Test Files\s+1 passed|Tests\s+1 passed/);
  assert.doesNotMatch(result.output, /AssertionError/);
  if (process.platform === 'linux') {
    const pid = /FIXTURE STARTED\s+(\d+)/.exec(result.output)?.[1];
    assert.ok(pid, 'the fixture reports its worker');
    const live = () => {
      try { return !/[ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    for (let attempt = 0; attempt < 20 && live(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(live(), false, 'cancelled fixture must not leave a live fork');
  }
});

test('real assertion still produces nonzero exit alongside budget warnings', () => {
  const result = runVitest(2);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /WARNING: TEST TIME BUDGET EXCEEDED/);
  assert.match(result.output, /AssertionError/);
});

test('partial run keeps threshold details and skips cumulative comparisons', () => fixture(root => {
  const path = join(root, 'budget.json');
  writeFileSync(path, JSON.stringify({ ...budget, baseline: { ...budget.baseline, files: 100 } }));
  const chunks = [];
  const write = process.stderr.write;
  process.stderr.write = chunk => { chunks.push(chunk); return true; };
  try {
    new BudgetReporter({ budgetPath: path }).onTestRunEnd([{
      moduleId: resolve('slow.test.ts'), diagnostic: () => ({ collectDuration: 42 }),
      children: { allTests: () => [{ fullName: 'slow assertion', diagnostic: () => ({ duration: 43 }) }] },
    }]);
  } finally { process.stderr.write = write; }
  const output = chunks.join('');
  assert.match(output, /partial run: totals not checked/);
  assert.match(output, /slow\.test\.ts: module import took 42ms/);
  assert.match(output, /slow assertion: 43ms/);
  assert.doesNotMatch(output, /suite total/);
  assert.match(output, /slowest imports/);
}));

test('invalid budget is an error, not a performance warning', () => fixture(root => {
  const path = join(root, 'budget.json');
  writeFileSync(path, '{invalid');
  assert.throws(() => new BudgetReporter({ budgetPath: path }), SyntaxError);
}));

test('browser timing warnings retain measured value and threshold', () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    warnTimeBudget('Reader open', 3001, 3000);
    warnTimeBudget('Reader open', 3000, 3000);
  } finally { console.warn = warn; }
  assert.deepEqual(warnings, ['WARNING: Reader open took 3001ms (budget 3000ms; advisory)']);
  assert.throws(() => warnTimeBudget('Reader open', NaN, 3000), TypeError);
  assert.throws(() => warnTimeBudget('Reader open', 3001, undefined), TypeError);
});

// Load each owning configuration; fixture-local timeouts cannot guard these.
test('actual package and browser configs retain unlimited runtime and budget reporting', async () => {
  const { loadConfigFromFile } = await import(pathToFileURL(createRequire(join(vitestRoot, 'package.json')).resolve('vite')).href);
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const configs = [
    'server/vitest.config.ts', 'apps/web/vitest.config.ts',
    ...['agent-cli', 'folder-read', 'host-daemon', 'outbound-guard', 'protocol', 'reader-document']
      .map(name => `packages/${name}/vitest.config.ts`),
    ...['problem-workspace', 'reading', 'source-goal', 'task-work']
      .map(name => `server/vitest.${name}-browser.config.ts`),
  ];
  const previous = process.cwd();
  try {
    for (const file of configs) {
      const configFile = join(root, file);
      process.chdir(dirname(configFile)); // server discovers test projects relative to its package
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configFile);
      assert.ok(loaded, file);
      const config = loaded.config.test;
      if (file.includes('-browser.config.ts')) {
        assert.deepEqual(config.globalSetup, ['./test/setupIntegration.ts'], `${file}: integration setup`);
        assert.deepEqual(config.setupFiles, ['./test/support/sqlCapture.ts'], `${file}: SQL capture`);
      }
      if (file === 'server/vitest.config.ts' || file === 'apps/web/vitest.config.ts') {
        // Slow imports stay visible without turning machine load into failure.
        assert.equal(config.experimental?.importDurations?.print, 'on-warn', `${file}: import durations visible`);
        assert.equal(config.experimental?.importDurations?.failOnDanger, false, `${file}: import danger advisory`);
      }
      if (file === 'server/vitest.config.ts') {
        const filesBelow = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? filesBelow(path) : path.endsWith('.test.ts') ? [path] : [];
        });
        const expected = filesBelow('test').sort();
        const assignments = config.projects.flatMap(project => project.test.include);
        assert.deepEqual(assignments.sort(), expected, 'every test file belongs to exactly one project');
        assert.equal(new Set(assignments).size, assignments.length, 'no duplicate project assignments');
        assert.equal(config.globalSetup, undefined, 'pure runs have no root integration setup');
        for (const project of config.projects) {
          for (const file of project.test.include) {
            assert.equal(project.test.isolate, readFileSync(file, 'utf8').includes('vi.mock('), `${file}: mock isolation`);
          }
          if (project.test.name.startsWith('pure')) {
            assert.equal(project.test.globalSetup, undefined);
            assert.equal(project.test.setupFiles, undefined);
          }
        }
      }
      assert.equal(config.testTimeout, 0, `${file}: testTimeout`);
      assert.equal(config.hookTimeout, 0, `${file}: hookTimeout`);
      assert.ok(config.reporters.some(entry =>
        (Array.isArray(entry) ? entry[0] : entry).endsWith('/tools/vitest/budgetReporter.mjs')),
      `${file}: budget reporter`);
    }
  } finally { process.chdir(previous); }
});
