import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const roots = [
  "server/src",
  "server/test",
  "server/migrations",
  "server/drizzle",
  "packages/protocol/src",
  "packages/protocol/test",
  "apps/web/src",
  ".agent/architecture",
  ".agent/modules",
];
const self = "server/test/legacyRuntimeContextAbsence.test.ts";
const textExtensions = new Set([".ts", ".tsx", ".sql", ".json", ".md"]);

const retired = [
  ["context", "snapshots"].join("_"),
  ["context", "snapshot", "items"].join("_"),
  ["context", "digests"].join("_"),
  ["context", "profiles"].join("_"),
  ["context", "pack", "json"].join("_"),
  ["routing", "manifest", "json"].join("_"),
  ["DEFAULT", "CONTEXT", "ROUTING", "MANIFEST"].join("_"),
  ["session", "summaries"].join("_"),
  ["compiled", "prefix"].join("_"),
  ["compiled", "tail"].join("_"),
  ["rendered", "context", "text"].join("_"),
  ["context", "file", "type"].join("_"),
  ["writes", "vendor", "context", "file"].join("_"),
  ["context", "target", "format"].join("_"),
  ["Context", "Prepare", "Service"].join(""),
  ["Context", "Compiler"].join(""),
  ["context", "snapshot"].join("_"),
  ["prepare", "Service.ts"].join(""),
  ["Context", "Digest"].join(""),
  ["context", "build"].join("."),
  ["Context", "Builder"].join(""),
  ["context", "artifact"].join("_"),
  ["context", "prepared"].join("_"),
  ["context", "prepare", "failed"].join("_"),
];

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

describe("legacy Runtime Context absence", () => {
  it("keeps retired authorities out of production, schema, protocol, and active tests", () => {
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of filesUnder(join(repoRoot, root))) {
        const repoPath = relative(repoRoot, file);
        if (repoPath === self || !textExtensions.has(extname(file))) continue;
        const content = readFileSync(file, "utf8");
        for (const token of retired) {
          if (repoPath.includes(token) || content.includes(token)) {
            violations.push(`${repoPath}: ${token}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
