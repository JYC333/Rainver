import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const srcDir = join(__dirname, "..", "src");
const officialPluginsDir = join(__dirname, "..", "..", "plugins", "official");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Bare module specifiers the server is allowed to import. Relative imports
 * (`./`, `../`), `node:` builtins, and `@agent-space/protocol` are allowed.
 * Anything else (frontend, ORM packages, migration tooling, sandbox/deployer
 * internals, local-host) must not appear.
 */
const ALLOWED_BARE = new Set(["fastify", "fast-xml-parser", "undici", "yaml", "zod", "@agent-space/protocol"]);

/**
 * Packages allowed only from a specific file or directory. `pg` is the raw DB
 * driver (deliberately not an ORM) and must stay confined to the `src/db/`
 * data-access layer (pool, transaction helper, migration runner) so database
 * access cannot spread into feature modules without showing up here. `node-pty`
 * is the CLI login PTY host and must stay confined to the login engine. A value
 * ending in `.ts` matches that exact file; a directory value matches any file
 * beneath it.
 */
const ALLOWED_BARE_BY_FILE = new Map<string, string>([
  ["pg", join("src", "db")],
  ["@earendil-works/pi-ai", join("src", "modules", "providers", "invocation", "piAiChat.ts")],
  ["@earendil-works/pi-agent-core", join("src", "modules", "runs", "piManagedAgentLoop.ts")],
  ["node-pty", join("src", "modules", "providers", "cli", "loginEngine.ts")],
  ["unpdf", join("src", "modules", "sources", "pdfExtract.ts")],
  // drizzle-orm is schema-declaration only (server/src/db/schema/), never a
  // query layer — repositories keep writing hand-written SQL through `pg`.
  // See .agent/architecture/DATABASE_AND_TRANSACTIONS.md, "Schema Authoring".
  ["drizzle-orm", join("src", "db", "schema")],
]);

/** Substrings that must never appear in any import specifier. */
const FORBIDDEN_SUBSTRINGS = [
  "../apps/web", // frontend app
  "../../apps/web",
  "../sandbox/", // first-level sandbox subsystem internals
  "../../sandbox/",
  "../deployer", // first-level deployer subsystem internals
  "../../deployer",
  "../ops", // compose/env/script tree
  "../../ops",
  "apps/web/src",
  "sandbox/",
  "deployer/",
  "ops/compose",
  "local-host",
  "src-tauri",
  "alembic",
  "migrations",
  "sqlalchemy",
  "psycopg",
  "knex",
  "typeorm",
];

const importRe = /\b(?:from|import)\s+["']([^"']+)["']/g;
/**
 * `import("pkg")` and the inline type form `typeof import("pkg", { with: … })`.
 * Both are invisible to `importRe`, which requires whitespace before the quote,
 * and both are how an ESM-only package is actually reached from this CJS
 * server — `@earendil-works/pi-agent-core` has no other form anywhere in `src`.
 * Without this pattern the file-scoped allowances below cannot fire for it at
 * all, and a boundary violation lands with every assertion green.
 */
const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']/g;

function importSpecifiers(text: string): string[] {
  return [
    ...[...text.matchAll(importRe)].map((match) => match[1]),
    ...[...text.matchAll(dynamicImportRe)].map((match) => match[1]),
  ];
}

describe("server import boundaries", () => {
  it("imports only approved runtime packages, node: builtins and relative modules", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(text)) {
        for (const bad of FORBIDDEN_SUBSTRINGS) {
          if (spec.includes(bad)) offenders.push(`${file}: ${spec} (forbidden: ${bad})`);
        }
        if (spec.startsWith(".")) continue;
        if (spec.startsWith("node:")) continue;
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        const scopedAllowance = ALLOWED_BARE_BY_FILE.get(pkg);
        if (scopedAllowance) {
          // `.ts` value → exact file; directory value → any file beneath it.
          const allowed = scopedAllowance.endsWith(".ts")
            ? file.endsWith(scopedAllowance)
            : file.includes(scopedAllowance + sep);
          if (!allowed) {
            offenders.push(`${file}: ${spec} (allowed only from ${scopedAllowance})`);
          }
          continue;
        }
        if (!ALLOWED_BARE.has(pkg)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders, `unexpected imports:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the managed agent loop port declares a contract and never an implementation", () => {
    // The port exists so that replacing the loop implementation is not an edit
    // to the module every caller imports. A port that reaches for the
    // implementation — or for a vendor loop package — has given that back.
    const port = join(srcDir, "modules", "runs", "managedAgentLoopPort.ts");
    const portSpecs = importSpecifiers(readFileSync(port, "utf8"));
    expect(portSpecs.filter((spec) => spec.includes("pi-agent-core") || spec.includes("pi-ai"))).toEqual([]);

    // Only the binding chooses an implementation; production callers go
    // through it rather than naming the implementation themselves. This sweep
    // covers the port too, so no separate assertion for it is needed.
    const offenders: string[] = [];
    const binding = join(srcDir, "modules", "runs", "managedAgentLoopBinding.ts");
    for (const file of tsFiles(srcDir)) {
      if (file === binding || file.endsWith(join("runs", "piManagedAgentLoop.ts"))) continue;
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (spec.includes("piManagedAgentLoop")) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders, `direct implementation imports:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the generic managed tool loop is owned by no tool family", () => {
    // The loop used to live inside the Retrieval domain. A run carrying only
    // delegation or a proposal action had to fabricate an empty retrieval
    // binding to reach it, and every tool summary it produced was filed as a
    // retrieval call. Neither direction of that dependency may come back.
    const loop = join(srcDir, "modules", "runs", "managedToolLoop.ts");
    const loopSpecs = importSpecifiers(readFileSync(loop, "utf8"));
    expect(
      loopSpecs.filter((spec) => spec.includes("retrieval") || spec.includes("Retrieval")),
      "the generic tool loop must not depend on any tool family",
    ).toEqual([]);

    // Retrieval may name the loop's *contract* — it has to, to describe what it
    // contributes — but must never import a value from it. A `managedToolLoop`
    // specifier is therefore permanently present and cannot itself be the
    // assertion; the ownership inversion this gate exists to prevent is
    // Retrieval calling `executeManagedToolLoop`.
    const retrievalText = readFileSync(join(srcDir, "modules", "runs", "managedRetrievalTools.ts"), "utf8");
    const valueImports = [...retrievalText.matchAll(/^import\s+(?!type\s)[\s\S]*?from\s+["']([^"']+)["']/gm)]
      .map((match) => match[1]);
    expect(
      valueImports.filter((spec) => spec.includes("managedToolLoop") || spec.includes("managedAgentLoop")),
      "Retrieval contributes tools; it does not drive the loop",
    ).toEqual([]);

    // The fabricated carrier itself. `{} as never` in a resolved binding is how
    // a run with no retrieval tool used to reach the loop at all.
    const offenders = tsFiles(srcDir)
      .filter((file) => /service:\s*\{\}\s*as\s+never/.test(readFileSync(file, "utf8")));
    expect(offenders, "no module may fabricate an empty tool-family binding").toEqual([]);
  });

  it("the managed Pi loop never enables Pi-owned compaction", () => {
    const loop = join(srcDir, "modules", "runs", "piManagedAgentLoop.ts");
    const text = readFileSync(loop, "utf8");
    expect(text).toContain("new Agent({");
    expect(
      text.match(/\b(?:compact|compaction|shouldCompact|prepareCompaction|DEFAULT_COMPACTION_SETTINGS)\b/gi) ?? [],
      "Runtime Context owns model-visible windowing; the Pi loop must not configure or import a second compactor",
    ).toEqual([]);

    const offenders = tsFiles(srcDir).filter((file) => {
      const source = readFileSync(file, "utf8");
      return importSpecifiers(source).some((specifier) => specifier.includes("pi-agent-core"))
        && /\b(?:compact|compaction|shouldCompact|prepareCompaction|DEFAULT_COMPACTION_SETTINGS)\b/i.test(source);
    });
    expect(offenders, "no server Pi import site may import a compaction export").toEqual([]);
  });

  it("plugin files do not import from server modules", () => {
    const pluginsDir = join(srcDir, "plugins");
    const offenders: string[] = [];
    for (const file of tsFiles(pluginsDir)) {
      const text = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(text)) {
        // Relative imports that traverse into src/modules/ are forbidden from src/plugins/
        if (spec.startsWith(".") && spec.includes("/modules/")) {
          offenders.push(`${file}: ${spec} (plugins must not import server modules)`);
        }
      }
    }
    expect(offenders, `plugin → server-module violations:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("official plugin package files do not import server internals", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(officialPluginsDir)) {
      const text = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(text)) {
        if (
          spec.includes("server/src/") ||
          spec.includes("apps/web/src/") ||
          spec.includes("/modules/")
        ) {
          offenders.push(`${file}: ${spec} (official plugin packages must use host ports)`);
        }
      }
    }
    expect(offenders, `official plugin package violations:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not reference web or subsystem internals anywhere in src", () => {
    const dataReferenceAllowlist = new Set([
      // This is the fixed HOME path inside the dedicated one-shot Docker
      // image, not a repository subsystem import or host path.
      join(srcDir, "modules", "runs", "localCliExecution.ts"),
    ]);
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      if (dataReferenceAllowlist.has(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const bad of [
        "../apps/web",
        "../../apps/web",
        "apps/web/src",
        "../sandbox/",
        "../../sandbox/",
        "../deployer",
        "../../deployer",
        "deployer/",
        "local-host",
      ]) {
        if (text.includes(bad)) offenders.push(`${file}: contains "${bad}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
