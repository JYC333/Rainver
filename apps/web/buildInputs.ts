import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * What a web build read, by content: `dist/build-inputs.json`.
 *
 * `files` maps each repository file the bundle was built from (every module in
 * Rollup's graph outside node_modules — app and official-plugin sources, the
 * built `packages/*\/dist` it imports — plus the config, HTML, public assets
 * and lockfile) to the sha256 of its bytes. `dirs` maps each directory above
 * those files to the sha256 of its sorted entry names, so a file added where
 * an `import.meta.glob` or a directory import would now find it, or a removed
 * one, also changes the record. `apps/web` and `packages/<name>` themselves
 * are not listed: their dist, node_modules and caches change on every build.
 *
 * server/test/support/webDist.ts re-hashes the same paths to refuse serving a
 * build that no longer matches the checkout. It compares content, never
 * modification times.
 */
export const BUILD_INPUTS_FILE = 'build-inputs.json'

export type BuildInputs = { version: 1, files: Record<string, string>, dirs: Record<string, string> }

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
export const listingHash = (dir: string) => sha256(readdirSync(dir).sort().join('\n'))

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false

function walk(path: string, out: string[]): void {
  const info = statSync(path, { throwIfNoEntry: false })
  if (!info) return
  if (info.isFile()) { out.push(path); return }
  for (const entry of readdirSync(path)) walk(join(path, entry), out)
}

function listed(repoPath: string): boolean {
  const depth = repoPath.split('/').length
  return depth >= 3 || repoPath === 'plugins/official'
}

/** `moduleIds` is Rollup's graph; `webRoot` is apps/web. */
export function collectBuildInputs(repoRoot: string, webRoot: string, moduleIds: Iterable<string>): BuildInputs {
  const paths = new Set<string>()
  for (const id of moduleIds) {
    const path = id.split('?')[0]
    if (!isAbsolute(path) || path.includes(`${sep}node_modules${sep}`)) continue
    if (!path.startsWith(repoRoot + sep) || !isFile(path)) continue
    paths.add(path)
  }
  const explicit: string[] = []
  walk(join(webRoot, 'public'), explicit)
  for (const name of ['index.html', 'vite.config.ts', 'buildInputs.ts', 'package.json', 'tsconfig.json']) explicit.push(join(webRoot, name))
  explicit.push(join(repoRoot, 'pnpm-lock.yaml'))
  for (const path of explicit) if (isFile(path)) paths.add(path)

  const files: Record<string, string> = {}
  const dirs: Record<string, string> = {}
  const toRepo = (path: string) => relative(repoRoot, path).split(sep).join('/')
  for (const path of [...paths].sort()) {
    files[toRepo(path)] = sha256(readFileSync(path))
    for (let dir = dirname(path); dir.startsWith(repoRoot + sep); dir = dirname(dir)) {
      const key = toRepo(dir)
      if (key in dirs) break
      if (listed(key)) dirs[key] = listingHash(dir)
    }
  }
  return { version: 1, files, dirs }
}
