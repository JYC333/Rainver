// Explicit Linux acceptance; build first. Requires working bwrap; never skips.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildStrictNamespaceCommand } from '../dist/strictNamespace.js';
const root = await mkdtemp(join(tmpdir(), 'rainver-readonly-'));
try {
  const cwd = join(root, 'source'), home = join(root, 'profile'), outputs = join(root, 'outputs');
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(outputs)]);
  await mkdir(join(cwd, '.git'));
  await writeFile(join(cwd, 'source.txt'), 'original');
  await writeFile(join(cwd, '.git/index'), 'synthetic-index');
  await writeFile(join(home, 'permission.json'), '{"mode":"write"}');
  function launch(mode, body) {
    const command = buildStrictNamespaceCommand({ command: process.execPath,
      args: ['--input-type=module', '-e', body], cwd, home,
      binds: [{ path: outputs, access: 'read_write' }],
      isolation: { sandbox_mode: mode, egress_profile: 'default' },
      env: { RAINVER_OUTPUT_DIR: outputs },
    });
    const child = spawnSync(command.command, command.args, { encoding: 'utf8', timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.output[3], 'ready\n');
  }
  launch('read_write', `import fs from 'node:fs'; fs.writeFileSync('source.txt','writable turn');`);
  launch('read_only', `
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    import {join} from 'node:path';
    assert.equal(JSON.parse(fs.readFileSync(join(process.env.HOME,'permission.json'))).mode,'write');
    assert.equal(fs.readFileSync('source.txt','utf8'),'writable turn');
    for (const attempt of [() => fs.writeFileSync('source.txt','bad'), () => fs.writeFileSync('new.txt','bad'),
      () => fs.unlinkSync('source.txt'), () => fs.renameSync('source.txt','renamed.txt'),
      () => fs.writeFileSync('.git/index','bad')]) assert.throws(attempt, {code:'EROFS'});
    fs.writeFileSync(join(process.env.RAINVER_OUTPUT_DIR,'report.txt'),'review complete');
    fs.writeFileSync(join(process.env.HOME,'cache.txt'),'cache');
    fs.writeFileSync('/tmp/review-scratch','scratch');
  `);
  assert.equal(await readFile(join(cwd, 'source.txt'), 'utf8'), 'writable turn');
  assert.equal(await readFile(join(cwd, '.git/index'), 'utf8'), 'synthetic-index');
  assert.equal(await readFile(join(outputs, 'report.txt'), 'utf8'), 'review complete');
  console.log('PASS: writable turn → same-profile read-only resume; write/create/delete/rename/index denied; report/cache/tmp writable. Synthetic process, no vendor/model.');
} finally { await rm(root, { recursive: true, force: true }); }
