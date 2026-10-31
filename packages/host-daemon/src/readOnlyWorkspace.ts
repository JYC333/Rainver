import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import {readOnlyIpcFilter} from './readOnlyIpc.js';
import { execFile, spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { StrictBind } from './strictNamespace.js';
export const readOnlyBinary = () => process.env.RAINVER_HOST_BWRAP ?? '/usr/bin/bwrap';
let cached: {
  at: number;
  result: {
    supported: boolean;
    mechanism: 'bwrap-v1';
    reason: string | null;
  };
} | undefined;
let pending: Promise<{
  supported: boolean;
  mechanism: 'bwrap-v1';
  reason: string | null;
}> | undefined;
export function probeReadOnlyWorkspace() {
  if (cached && Date.now() - cached.at < 60000) return Promise.resolve(cached.result);
  if (pending) return pending;
  pending = new Promise<{
    supported: boolean;
    mechanism: 'bwrap-v1';
    reason: string | null;
  }>(done => {
    const finish = (supported: boolean) => {
      const result = {
        supported,
        mechanism: 'bwrap-v1' as const,
        reason: supported ? null : 'Requires Linux x64/arm64, bubblewrap with seccomp and permitted mount/PID namespaces; configure this Host, then reconnect.'
      };
      cached = {
        at: Date.now(),
        result
      };
      done(result);
    };
    if (process.platform !== 'linux'||!['x64','arm64'].includes(process.arch)) {
      finish(false);
      return;
    }
    const child = spawn(readOnlyBinary(), ['--seccomp','4','--die-with-parent', '--new-session', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'], {
      stdio: ['ignore','ignore','ignore','ignore','pipe'],
      env: {
        PATH: '/usr/bin:/bin'
      }
    });
    const filter=child.stdio[4] as import('node:stream').Writable;filter.on('error',()=>{});filter.end(readOnlyIpcFilter());
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.once('close', code => {
      clearTimeout(timer);
      finish(code === 0);
    });
  }).finally(() => {
    pending = undefined;
  });
  return pending;
}
export function canonicalPath(path: string, depth = 0): string {
  if (depth > 32) throw new Error('Too many path aliases for read-only workspace');
  let root = resolve(path),
    tail: string[] = [];
  while (true) {
    try {
      const stat = lstatSync(root);
      const physical = stat.isSymbolicLink() ? canonicalPath(resolve(dirname(root), readlinkSync(root)), depth + 1) : realpathSync(root);
      return join(physical, ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      tail.unshift(basename(root));
      const parent = dirname(root);
      if (parent === root) throw new Error('Cannot resolve workspace protection path');
      root = parent;
    }
  }
}
const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
/** Reject writable shadows and preexisting inode aliases; new links across RO mounts fail EXDEV. */
export function assertReadOnlyBinds(protectedPaths: string[], binds: StrictBind[]) {
  const protectedRoots = protectedPaths.map(canonicalPath);
  for (const bind of binds.filter(b => b.access === 'read_write')) {
    const root = canonicalPath(bind.path);
    if (protectedRoots.some(p => inside(root, p) || inside(p, root))) throw new Error('Read-only workspace overlaps writable runtime/profile/output. Choose a non-overlapping configured directory.');
    let left = 100000;
    const visit = (path: string) => {
      if (--left < 0) throw new Error('Writable runtime state too large to verify safely for read-only execution');
      let stat;try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      if (stat.isSymbolicLink()) {
        const target = canonicalPath(path);
        if (protectedRoots.some(p => inside(target, p) || inside(p, target))) throw new Error('Writable runtime symlink reaches protected workspace');
        return;
      }
      if (stat.isFile() && stat.nlink > 1) throw new Error('Writable runtime state contains hard links; read-only execution refused');
      if (stat.isSocket()) return; // Named Unix clients are denied by the per-process seccomp filter.
      if (stat.isDirectory()){let names:string[];try{names=readdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}for(const name of names)visit(join(path,name));}
    };
    if (existsSync(root)) visit(root);
  }
}
/** Include configured overlapping roots so aliases/nested Locations and managed cwd share the same lock. */
export function workspacePathLeaseKeys(cwd: string, roots: string[]) {
  const path = canonicalPath(cwd);
  return [...new Set([path, ...roots.map(canonicalPath).filter(p => inside(path, p) || inside(p, path))])].map(p => 'workspace-path:' + p);
}
export function workspaceGitDirectory(cwd: string): Promise<string | null> {
  return new Promise(done => execFile('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    timeout: 4000,
    maxBuffer: 8192,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0'
    }
  }, (error, out) => {try{done(error?null:canonicalPath(out.trim()));}catch{done(null);}}));
}
/** Resolve installed executable packages through Node's existing dependency lookup.
 * Never bind a HOME/ancestor as an executable root, including through aliases.
 */
export function readOnlyRootGuard(env: Record<string, string | undefined>) {
  const homes = [...new Set([homedir(), env.HOME].filter((p): p is string => !!p)
    .flatMap(p => [resolve(p), canonicalPath(p)]))];
  return (p: string) => !homes.some(home => inside(home, resolve(p)) || inside(home, canonicalPath(p)));
}
export function executableRoots(command: string, env: Record<string, string>): string[] {
  const roots = new Set<string>();
  const seen = new Set<string>();
  const safe = readOnlyRootGuard(env);
  const add = (p: string) => {
    if (!safe(p)) throw new Error('Executable binding would expose a login HOME; use a dedicated installation directory');
    roots.add(p);
  };
  const packageRoot = (file: string): string | null => {
    for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
      if (!safe(dir)) return null;
      if (existsSync(join(dir, 'package.json'))) return dir;
    }
    return null;
  };
  const addPackage = (root: string) => {
    add(root);
    const physical = realpathSync(root);
    add(physical);
    if (seen.has(physical)) return;
    if (seen.size >= 1024) throw new Error('Executable dependency closure exceeds read-only launch limit');
    seen.add(physical);
    const manifest = JSON.parse(readFileSync(join(physical, 'package.json'), 'utf8'));
    const lookup = createRequire(join(physical, 'package.json'));
    const names = new Set<string>([
      ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      if (!/^(@[^/]+\/)?[^/]+$/.test(name) || name === '..' || name === '.') continue;
      // Preserve the lexical Node lookup entry as well as the physical package:
      // pnpm's sibling links otherwise point outside the mounted package.
      const entry = (lookup.resolve.paths(name) ?? []).map(dir => join(dir, name))
        .find(path => existsSync(join(path, 'package.json')));
      if (entry) addPackage(entry);
    }
  };
  for (const binary of [command, process.execPath, env.CODEX_PATH, env.CLAUDE_CODE_EXECUTABLE].filter((p): p is string => !!p)) {
    const path = binary.startsWith('/') ? binary : (env.PATH ?? process.env.PATH ?? '').split(':').map(p => join(p, binary)).find(existsSync);
    if (!path || !existsSync(path)) continue;
    const executable = realpathSync(path);
    const pkg = packageRoot(executable);
    if (pkg) addPackage(pkg);
    else add(safe(dirname(executable)) ? dirname(executable) : executable);
    // Bind alias files rather than their parent directories (which can be HOME).
    add(path);
    let linkPath = path;
    for (let hops = 0; hops < 32 && lstatSync(linkPath).isSymbolicLink(); hops++) {
      linkPath = resolve(dirname(linkPath), readlinkSync(linkPath));
      add(linkPath);
    }
  }
  return [...roots];
}
/** Git filters also execute inside RO mounts; tree objects/index live only in disposable scratch. */
export async function captureReadOnlyBasis(cwd: string, gitCommon: string | null): Promise<string | null> {
  if (!gitCommon) return null;
  const {
    mkdtemp,
    mkdir,
    rm
  } = await import('node:fs/promises');
  const {
    tmpdir
  } = await import('node:os');
  const scratch = await mkdtemp(join(tmpdir(), 'rainver-read-basis-'));
  try {
    assertReadOnlyBinds([cwd, gitCommon], [{
      path: scratch,
      access: 'read_write'
    }]);
    await mkdir(join(scratch, 'objects'));
    await mkdir(join(scratch, 'home'));
    const {
      buildStrictNamespaceCommand
    } = await import('./strictNamespace.js');
    const plan = buildStrictNamespaceCommand({
      command: '/bin/sh',
      args: ['-c', 'set -e; git -c core.fsmonitor=false -c core.hooksPath=/dev/null read-tree HEAD; git -c core.fsmonitor=false -c core.hooksPath=/dev/null add --all; git write-tree'],
      cwd,
      home: join(scratch, 'home'),
      binds: [{
        path: scratch,
        access: 'read_write'
      }, {
        path: gitCommon,
        access: 'read_only'
      }],
      isolation: {
        sandbox_mode: 'read_only',
        egress_profile: 'none'
      },
      env: {
        PATH: '/usr/bin:/bin',
        GIT_INDEX_FILE: join(scratch, 'index'),
        GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(join(gitCommon, 'objects')),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0'
      }
    });
    return await new Promise(done => {
      const child = spawn(readOnlyBinary(), ['--seccomp','4',...plan.args], {
        stdio: ['ignore', 'pipe', 'ignore', 'pipe','pipe'],
        env: plan.env
      });
      const filter=child.stdio[4] as import('node:stream').Writable;filter.on('error',()=>{});filter.end(readOnlyIpcFilter());
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.stdout?.on('data', b => {
        out += String(b);
        if (out.length > 1024) child.kill('SIGKILL');
      });
      child.once('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.once('close', code => {
        clearTimeout(timer);
        done(code === 0 && /^[a-f0-9]{40,64}$/.test(out.trim()) ? out.trim() : null);
      });
    });
  } finally {
    await rm(scratch, {
      recursive: true,
      force: true
    });
  }
}
