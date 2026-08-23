import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = join(__dirname, "..", "..");
const agentRoot = join(repoRoot, ".agent");

type ContextBundle = {
  docs?: unknown;
  code_roots?: unknown;
};

function filesBelow(root: string, extension: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return filesBelow(path, extension);
    return entry.name.endsWith(extension) ? [path] : [];
  });
}

function markdownSection(text: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`Missing Markdown section: ${heading}`);
  const bodyStart = start + marker.length;
  const next = text.indexOf("\n## ", bodyStart);
  return text.slice(bodyStart, next < 0 ? undefined : next).trim();
}

function localMarkdownTargets(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^(?:https?:|mailto:)/.test(target));
}

describe("repository agent guide invariants", () => {
  it("keeps every context bundle target valid and out of temporary reports", () => {
    const manifest = parse(
      readFileSync(join(agentRoot, "context-bundles.yaml"), "utf8"),
    ) as Record<string, ContextBundle>;
    const problems: string[] = [];

    for (const [bundleName, bundle] of Object.entries(manifest)) {
      for (const field of ["docs", "code_roots"] as const) {
        const targets = bundle[field];
        if (targets === undefined) continue;
        if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string")) {
          problems.push(`${bundleName}.${field} must be a string array`);
          continue;
        }
        for (const target of targets as string[]) {
          if (target.startsWith("/") || target.split("/").includes("..")) {
            problems.push(`${bundleName}.${field}: unsafe path ${target}`);
            continue;
          }
          if (target.startsWith(".agent/reports/")) {
            problems.push(`${bundleName}.${field}: temporary report ${target}`);
          }
          if (!existsSync(join(repoRoot, target))) {
            problems.push(`${bundleName}.${field}: missing ${target}`);
          }
        }
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("keeps local links in canonical agent guides resolvable", () => {
    const guides = [
      join(repoRoot, "AGENTS.md"),
      join(repoRoot, "CLAUDE.md"),
      ...filesBelow(agentRoot, ".md"),
    ];
    const broken: string[] = [];

    for (const guide of guides) {
      for (const target of localMarkdownTargets(guide)) {
        if (!existsSync(resolve(dirname(guide), target))) {
          broken.push(`${relative(repoRoot, guide)} -> ${target}`);
        }
      }
    }

    expect(broken, broken.join("\n")).toEqual([]);
  });

  it("makes every architecture and module guide discoverable from the index", () => {
    const index = readFileSync(join(agentRoot, "INDEX.md"), "utf8");
    const missing = ["architecture", "modules"].flatMap((directory) =>
      readdirSync(join(agentRoot, directory), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => `${directory}/${entry.name}`)
        .filter((path) => !index.includes(`(${path})`)),
    );

    expect(missing, `Not discoverable from .agent/INDEX.md:\n${missing.join("\n")}`).toEqual([]);
  });

  it("keeps the Codex and Claude adapters on the same canonical core", () => {
    const codex = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const claude = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    const index = readFileSync(join(agentRoot, "INDEX.md"), "utf8");

    expect(markdownSection(claude, "Start Here")).toBe(
      markdownSection(codex, "Required Context"),
    );
    expect(markdownSection(claude, "Source Of Truth")).toBe(
      markdownSection(codex, "Source Of Truth"),
    );
    expect(markdownSection(claude, "Repo Rules")).toBe(markdownSection(codex, "Repo Rules"));
    expect(markdownSection(claude, "Working Pattern")).toBe(
      markdownSection(codex, "Working Pattern"),
    );

    for (const requiredPath of [
      ".agent/INDEX.md",
      ".agent/context-bundles.yaml",
      ".agent/BOUNDARIES.md",
      ".agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md",
      ".agent/architecture/TESTING_STRATEGY.md",
      ".agent/COMMANDS.md",
    ]) {
      expect(codex).toContain(requiredPath);
      expect(claude).toContain(requiredPath);
    }

    const authorityOrder = [
      "`server/src/db/schema/`",
      "`server/migrations/`",
      "`server/src/`",
      "`packages/protocol/src/`",
      "`apps/web/src/modules/registry.ts`",
    ];
    for (const guide of [codex, claude, index]) {
      const positions = authorityOrder.map((marker) => guide.indexOf(marker));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });

  it("records every server runtime dependency in the canonical mechanism index", () => {
    // The reuse policy's index is only useful if it stays complete: an agent
    // that reads it and finds nothing for a concern concludes the repository
    // has no canonical mechanism, and hand-writes a second one. Server runtime
    // dependencies are the set worth pinning this way — each is a
    // cross-cutting choice, and the list is short enough that recording one
    // costs a single table row. Workspace packages are excluded (they are this
    // repo's own code), and dev dependencies are covered by the index's testing
    // section rather than by this gate.
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "server", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const policy = readFileSync(
      join(agentRoot, "architecture", "REUSE_AND_DEPENDENCY_POLICY.md"),
      "utf8",
    );

    const missing = Object.keys(manifest.dependencies ?? {})
      .filter((name) => !name.startsWith("@agent-space/"))
      .filter((name) => !policy.includes(name));

    expect(
      missing,
      `Server dependencies missing from .agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});

describe("repository agent hook invariants", () => {
  const hookPairs = ["check-docs-sync.sh", "check-dependency-policy.sh"];

  it("keeps the Claude and Codex hook scripts byte-identical", () => {
    // Both harnesses run the same rules; a fix applied to one side only is the
    // failure mode this catches, and it is silent otherwise.
    for (const name of hookPairs) {
      const claude = readFileSync(join(repoRoot, ".claude", "hooks", name), "utf8");
      const codex = readFileSync(join(repoRoot, ".codex", "hooks", name), "utf8");
      expect(codex, `${name} drifted between .claude/hooks and .codex/hooks`).toBe(claude);
    }
  });

  it("keeps every document a hook points at real", () => {
    // The docs-sync map previously named three deleted documents — one of them a
    // "current focus" file INDEX.md forbids reintroducing — on nearly every edit.
    // Stale hook output trains agents to ignore hook output, so this is a gate.
    const script = readFileSync(join(repoRoot, ".claude", "hooks", "check-docs-sync.sh"), "utf8");
    const missing = [...script.matchAll(/relevant_docs="([^"]+)"/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((entry) => entry.trim())
      .filter((entry) => entry && !existsSync(join(agentRoot, entry)));

    expect(missing, `Hook points at missing .agent/ docs:\n${missing.join("\n")}`).toEqual([]);
  });

  it("keeps every repository path a hook matches on real", () => {
    // Six of the mapped module directories had been renamed or deleted. Only
    // unambiguous patterns are checked: `*<dir>/*` and `*<file>.ts(x)`.
    const script = readFileSync(join(repoRoot, ".claude", "hooks", "check-docs-sync.sh"), "utf8");
    const targets = new Set<string>();
    for (const match of script.matchAll(/\*((?:server|apps|packages|plugins)\/[\w/.-]*?)(\/\*|\.tsx?)(?=[|)])/g)) {
      targets.add(match[2] === "/*" ? match[1]! : match[1]! + match[2]!);
    }

    expect(targets.size, "path patterns should be extractable from the hook").toBeGreaterThan(10);
    const missing = [...targets].filter((target) => !existsSync(join(repoRoot, target))).sort();

    expect(missing, `Hook matches paths that no longer exist:\n${missing.join("\n")}`).toEqual([]);
  });
});
