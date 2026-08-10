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
});
