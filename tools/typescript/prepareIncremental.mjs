// Narrow repair for the five workspace libraries' existing src -> dist build.
// TypeScript owns source/config/dependency invalidation. Always invoke -p,
// rather than -b's mtime shortcut; it checks content even with preserved mtimes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = process.cwd();
const allowed = ['protocol', 'agent-cli', 'folder-read', 'outbound-guard', 'reader-document']
  .map(name => join(root, 'packages', name));
if (!allowed.includes(packageRoot)) throw new Error('Expected a workspace library package root');
const dist = join(packageRoot, 'dist');
const info = join(dist, '.tsbuildinfo');
const stamp = join(dist, '.lock-sha256');
const lock = createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex');

function missingOutput(directory, relative = '') {
  return readdirSync(directory, { withFileTypes: true }).some(entry => {
    const path = join(directory, entry.name);
    const name = join(relative, entry.name);
    if (entry.isDirectory()) return missingOutput(path, name);
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) return false;
    return ['.js', '.d.ts'].some(extension => !existsSync(join(dist, name.slice(0, -3) + extension)));
  });
}

// Incremental tsc does not recreate deleted outputs recorded in its metadata.
// Discard only compiler metadata when an expected artifact or lock identity is
// missing; do not remove dist or maintain another source/config cache.
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== lock || missingOutput(join(packageRoot, 'src'))) {
  rmSync(info, { force: true });
}
mkdirSync(dist, { recursive: true });
writeFileSync(stamp, lock);
