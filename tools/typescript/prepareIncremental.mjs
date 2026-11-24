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

function* regularFiles(root, relative = '') {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) yield* regularFiles(root, name);
    else if (entry.isFile()) yield name;
  }
}

const outputExtensions = ['.js', '.d.ts'];
const sourceStems = new Set([...regularFiles(join(packageRoot, 'src'))]
  .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  .map(name => name.slice(0, -3)));
const missing = [...sourceStems].some(stem =>
  outputExtensions.some(extension => !existsSync(join(dist, stem + extension))));

// Remove only a paired compiler output for a source that disappeared. These
// five package builds emit a JS/declaration pair per TS source under dist.
const emitted = new Set(existsSync(dist) ? regularFiles(dist) : []);
for (const name of emitted) {
  if (!name.endsWith('.js')) continue;
  const stem = name.slice(0, -3);
  if (sourceStems.has(stem) || !emitted.has(stem + '.d.ts')) continue;
  for (const extension of outputExtensions) rmSync(join(dist, stem + extension), { force: true });
}

if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== lock || missing) {
  rmSync(info, { force: true });
}
mkdirSync(dist, { recursive: true });
writeFileSync(stamp, lock);
