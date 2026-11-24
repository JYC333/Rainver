import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(new URL('../../packages/protocol/package.json', import.meta.url));
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');

test('incremental preparation validates content, lock identity and missing outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'rainver-incremental-'));
  try {
    const packageRoot = join(root, 'packages/protocol');
    const helper = join(root, 'tools/typescript/prepareIncremental.mjs');
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    mkdirSync(join(root, 'tools/typescript'), { recursive: true });
    copyFileSync(new URL('./prepareIncremental.mjs', import.meta.url), helper);
    const lock = join(root, 'pnpm-lock.yaml');
    writeFileSync(lock, 'lockfileVersion: 9\n');
    const config = join(packageRoot, 'tsconfig.build.json');
    const options = { target: 'ES2022', declaration: true, incremental: true, rootDir: 'src', outDir: 'dist', tsBuildInfoFile: 'dist/.tsbuildinfo' };
    writeFileSync(config, JSON.stringify({ compilerOptions: options, include: ['src'] }));
    const source = join(packageRoot, 'src/index.ts');
    writeFileSync(source, 'export const value = 1;');
    const compile = () => {
      for (const args of [[helper], [tsc, '-p', config, '--listEmittedFiles']]) {
        const result = spawnSync(process.execPath, args, { cwd: packageRoot, encoding: 'utf8' });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        if (args[0] === tsc) return result.stdout;
      }
    };
    assert.match(compile(), /index\.js/);
    assert.equal(compile(), '');
    const time = statSync(source);
    writeFileSync(source, 'export const value = 2;');
    utimesSync(source, time.atime, time.mtime);
    compile();
    assert.match(readFileSync(join(packageRoot, 'dist/index.js'), 'utf8'), /value = 2/);
    const newSource = join(packageRoot, 'src/new.ts');
    writeFileSync(newSource, 'export const added = 3;');
    utimesSync(newSource, 1, 1);
    assert.match(compile(), /new\.js/);
    const retained = join(packageRoot, 'dist/asset.js');
    writeFileSync(retained, '// unpaired build asset');
    rmSync(newSource);
    compile();
    assert.equal(existsSync(join(packageRoot, 'dist/new.js')), false);
    assert.equal(existsSync(join(packageRoot, 'dist/new.d.ts')), false);
    assert.ok(existsSync(retained));
    const configTime = statSync(config);
    writeFileSync(config, JSON.stringify({ compilerOptions: { ...options, target: 'ES2020' }, include: ['src'] }));
    utimesSync(config, configTime.atime, configTime.mtime);
    assert.notEqual(compile(), '');
    for (const extension of ['js', 'd.ts']) {
      const artifact = join(packageRoot, `dist/index.${extension}`);
      rmSync(artifact);
      compile();
      assert.ok(existsSync(artifact));
    }
    const lockTime = statSync(lock);
    writeFileSync(lock, 'lockfileVersion: 9\n# changed\n');
    utimesSync(lock, lockTime.atime, lockTime.mtime);
    assert.match(compile(), /index\.js/);
    assert.equal(compile(), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
