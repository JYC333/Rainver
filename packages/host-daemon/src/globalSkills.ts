import { createHash } from "node:crypto";
import { readdir, realpath, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listFolderDirectory, readFolderFile } from "@rainver/folder-read";
import type { HostSkillCandidate, HostSkillScan } from "@rainver/protocol";
import { installedTools, type ToolManifest } from "./tools.js";

type Root = { path: string; display: string; runtime: HostSkillCandidate["runtime_key"]; installation: string };
type Options = { home?: string; env?: NodeJS.ProcessEnv; managed?: Map<string, ToolManifest[]> };
type Located = { candidate: HostSkillCandidate; path: string };

async function roots(options: Options): Promise<Root[]> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const all: Root[] = [];
  const add = (base: string, runtime: Root["runtime"], installation: string, overrides: NodeJS.ProcessEnv) => {
    const append = (path: string, display: string) => all.push({ path: resolve(path), display, runtime, installation });
    if (runtime === "claude_code") append(join(overrides.CLAUDE_CONFIG_DIR || join(base, ".claude"), "skills"), overrides.CLAUDE_CONFIG_DIR ? "$CLAUDE_CONFIG_DIR/skills" : "~/.claude/skills");
    if (runtime === "codex_cli") {
      append(join(base, ".agents", "skills"), "~/.agents/skills");
      append(join(overrides.CODEX_HOME || join(base, ".codex"), "skills"), overrides.CODEX_HOME ? "$CODEX_HOME/skills" : "~/.codex/skills");
    }
    if (runtime === "opencode") append(join(overrides.XDG_CONFIG_HOME || join(base, ".config"), "opencode", "skills"), "~/.config/opencode/skills");
  };
  for (const runtime of ["claude_code", "codex_cli", "opencode"] as const) add(home, runtime, "own", env);
  for (const [runtime, manifests] of options.managed ?? await installedTools()) {
    if (runtime !== "claude_code" && runtime !== "codex_cli" && runtime !== "opencode") continue;
    for (const manifest of manifests) add(manifest.home, runtime, `managed:${manifest.version}`, manifest.env);
  }
  return all.filter((root, index) => all.findIndex(other => other.path === root.path && other.runtime === root.runtime && other.installation === root.installation) === index);
}

/** Fixed CLI roots only; the control plane cannot submit a filesystem path. */
async function discover(options: Options): Promise<{ located: Located[]; truncated: boolean; warnings: string[] }> {
  const located: Located[] = [];
  const warnings: string[] = [];
  let truncated = false;
  let visited = 0;
  for (const root of await roots(options)) {
    const pending = [{ path: root.path, relative: "", depth: 0 }];
    const seen = new Set<string>();
    while (pending.length) {
      if (++visited > 1000 || located.length >= 200) { truncated = true; break; }
      const entry = pending.shift()!;
      try {
        const canonical = await realpath(entry.path);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        if (entry.relative) {
          const skill = await lstat(join(canonical, "SKILL.md")).catch(() => null);
          if (skill?.isFile() && skill.size <= 256 * 1024) {
            const display_path = `${root.display}/${entry.relative}`;
            const id = createHash("sha256").update(`${root.runtime}\0${root.installation}\0${display_path}\0${canonical}`).digest("hex");
            located.push({ path: canonical, candidate: { id, name: entry.relative.split("/").at(-1)!,
              runtime_key: root.runtime, installation: root.installation, display_path } });
            continue;
          }
        }
        if (entry.depth >= 5) { truncated = true; continue; }
        const children = await readdir(canonical, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if ([".git", "node_modules", ".trash"].includes(child.name)) continue;
          // CLI installers commonly link a top-level Skill folder to a shared library.
          if (!child.isDirectory() && !(child.isSymbolicLink() && entry.depth === 0)) continue;
          if (pending.length + visited >= 1000) { truncated = true; break; }
          pending.push({ path: join(canonical, child.name), relative: entry.relative ? `${entry.relative}/${child.name}` : child.name, depth: entry.depth + 1 });
        }
      } catch (error) {
        const warning = `${root.runtime}: ${root.display} unavailable`;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && warnings.length < 100 && !warnings.includes(warning)) warnings.push(warning);
      }
    }
    if (visited > 1000 || located.length >= 200) break;
  }
  return { located, truncated, warnings };
}

export async function scanGlobalSkills(options: Options = {}): Promise<HostSkillScan> {
  const { located, ...summary } = await discover(options);
  return { items: located.map(item => item.candidate), ...summary };
}

export async function readGlobalSkill(id: string, options: Options = {}) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Skill id");
  const located = (await discover(options)).located.find(item => item.candidate.id === id);
  if (!located) throw new Error("Skill is no longer available; scan again");
  const pending = ["."];
  const files: Array<{ path: string; content_base64: string }> = [];
  let directories = 0;
  let total = 0;
  while (pending.length) {
    if (++directories > 200) throw new Error("Skill has too many directories");
    const path = pending.shift()!;
    let offset = 0;
    do {
      const tree = await listFolderDirectory(located.path, path, { offset });
      for (const entry of tree.children ?? []) {
        if (entry.type === "dir") { pending.push(entry.path); continue; }
        if (files.length >= 200 || (entry.size ?? 0) > 256 * 1024) throw new Error("Skill exceeds package limits");
        const file = await readFolderFile(located.path, entry.path, { includeOriginalBytes: true });
        total += file.size;
        if (total > 2 * 1024 * 1024 || file.size > 256 * 1024) throw new Error("Skill exceeds package limits");
        files.push({ path: entry.path, content_base64: file.content_base64! });
      }
      if (tree.next_offset === undefined) break;
      if (tree.next_offset <= offset) throw new Error("Skill listing did not advance");
      offset = tree.next_offset;
    } while (true);
  }
  if (!files.some(file => file.path === "SKILL.md")) throw new Error("Skill entrypoint is not readable");
  return { candidate: located.candidate, files };
}
