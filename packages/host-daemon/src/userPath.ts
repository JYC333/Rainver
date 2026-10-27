import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * Where people install command-line tools that a service's PATH does not
 * cover.
 *
 * The daemon runs as a systemd user service, a launchd agent, or a Windows
 * service, none of which inherit the owner's shell profile: `~/.local/bin`,
 * a version manager's node, the Rust and Go toolchains' bin directories are
 * all invisible to it, so a CLI the owner installed in the ordinary way was
 * not found. Each directory is added only if it exists, after the inherited
 * PATH, so nothing on the service's own PATH is shadowed.
 */
export function userToolDirectories(home: string = homedir()): string[] {
  const candidates = [
    join(home, ".local", "bin"),
    join(home, "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, "go", "bin"),
    join(home, ".local", "share", "pnpm"),
    ...versionManagerBinDirectories(home),
  ];
  return candidates.filter((directory) => existsSync(directory));
}

/**
 * Global npm package roots a machine may have: the node on PATH's own, a
 * version manager's, and the common prefixes. A registry agent distributed
 * through npm has its command names in its package's `bin` field, which is
 * read from one of these when the package is installed globally.
 */
export function npmGlobalRoots(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    // `<prefix>/bin/node` → `<prefix>/lib/node_modules`
    if (existsSync(join(directory, "node")) || existsSync(join(directory, "node.exe"))) {
      roots.add(join(dirname(directory), "lib", "node_modules"));
      roots.add(join(directory, "node_modules"));
    }
  }
  for (const directory of versionManagerBinDirectories(home)) roots.add(join(dirname(directory), "lib", "node_modules"));
  roots.add(join(home, ".npm-global", "lib", "node_modules"));
  roots.add("/usr/local/lib/node_modules");
  roots.add("/usr/lib/node_modules");
  roots.add(join(home, ".local", "share", "pnpm", "global", "5", "node_modules"));
  roots.add(join(home, ".bun", "install", "global", "node_modules"));
  return [...roots].filter((root) => existsSync(root));
}

/** nvm, fnm and volta keep each node's bin under their own tree. */
function versionManagerBinDirectories(home: string): string[] {
  const directories: string[] = [];
  const nvm = join(home, ".nvm", "versions", "node");
  if (existsSync(nvm)) {
    for (const version of readdirSync(nvm).sort().reverse()) directories.push(join(nvm, version, "bin"));
  }
  const fnm = join(home, ".local", "share", "fnm", "node-versions");
  if (existsSync(fnm)) {
    for (const version of readdirSync(fnm).sort().reverse()) directories.push(join(fnm, version, "installation", "bin"));
  }
  directories.push(join(home, ".volta", "bin"));
  return directories;
}

/** Extends this process's PATH with the owner's tool directories, once. */
export function augmentProcessPath(env: NodeJS.ProcessEnv = process.env): void {
  const current = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const present = new Set(current);
  const extra = userToolDirectories().filter((directory) => !present.has(directory));
  if (extra.length === 0) return;
  env.PATH = [...current, ...extra].join(delimiter);
}
