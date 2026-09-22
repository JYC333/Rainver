import { describe, it, expect } from "vitest";
import { listTsFiles } from "./support/sourceFiles.js";
import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const srcDir = join(import.meta.dirname, "..", "src");
const officialPluginsDir = join(import.meta.dirname, "..", "..", "plugins", "official");

/**
 * Bare module specifiers the server is allowed to import. Relative imports
 * (`./`, `../`), `node:` builtins, and `@rainver/protocol` are allowed.
 * Anything else (frontend, ORM packages, migration tooling, sandbox/deployer
 * internals, local-host) must not appear.
 */
const ALLOWED_BARE = new Set(["fastify", "fast-xml-parser", "undici", "yaml", "zod", "@rainver/protocol", "@rainver/folder-read", "@rainver/outbound-guard"]);

/**
 * Packages allowed only from a specific file or directory. `pg` is the raw DB
 * driver (deliberately not an ORM) and must stay confined to the `src/db/`
 * data-access layer (pool, transaction helper, migration runner) so database
 * access cannot spread into feature modules without showing up here. A value
 * ending in `.ts` matches that exact file; a directory value matches any file
 * beneath it.
 */
const ALLOWED_BARE_BY_FILE = new Map<string, string>([
  ["pg", join("src", "db")],
  ["@earendil-works/pi-ai", join("src", "modules", "providers", "invocation", "piAiChat.ts")],
  ["unpdf", join("src", "modules", "sources", "pdfExtract.ts")],
  // ADR 0016: the only WebSocket endpoint in the server, the hosts
  // hello/heartbeat channel — confined here so a second module cannot grow
  // its own ad hoc realtime transport.
  ["@fastify/websocket", join("src", "modules", "hosts", "routes.ts")],
  // Multipart parsing is installed once in the gateway shell; route modules
  // consume the shared parser rather than registering their own plugin.
  ["@fastify/multipart", join("src", "gateway", "appShell.ts")],
  // The official ACP SDK — confined to the one module that owns the
  // protocol lifecycle so a second hand-rolled implementation cannot grow
  // elsewhere. See REUSE_AND_DEPENDENCY_POLICY.md's canonical mechanism row.
  ["@agentclientprotocol/sdk", join("src", "modules", "runs", "cliConversationProtocol.ts")],
  // drizzle-orm is schema-declaration only (server/src/db/schema/), never a
  // query layer — repositories keep writing hand-written SQL through `pg`.
  // See .agent/architecture/DATABASE_AND_TRANSACTIONS.md, "Schema Authoring".
  ["drizzle-orm", join("src", "db", "schema")],
  // Cron expression parsing and next-run computation — confined to the
  // schedule façade so no second hand-rolled cron/DST implementation grows
  // elsewhere. See REUSE_AND_DEPENDENCY_POLICY.md's canonical mechanism row.
  ["cron-parser", join("src", "modules", "automations", "schedule.ts")],
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
 * `import("pkg")` and the inline type form `typeof import("pkg")`. Both are
 * invisible to `importRe`, which requires whitespace before the quote, and
 * lazily loaded packages such as `@earendil-works/pi-ai` appear in
 * `src` in no other form. Without this pattern the file-scoped allowances
 * below cannot fire for them at all, and a boundary violation lands with every
 * assertion green.
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
    for (const file of listTsFiles(srcDir)) {
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

  it("contains no in-server autonomous Agent loop implementation", () => {
    const retiredFiles = [
      "modules/runs/piManagedAgentLoop.ts",
      "modules/runs/managedAgentLoopBinding.ts",
      "modules/runs/managedAgentLoopPort.ts",
      "modules/runs/managedToolLoop.ts",
      "modules/runs/managedApiAdapter.ts",
      "modules/runtimeHost/service.ts",
      "modules/systemActions/managedAgentToolSurface.ts",
    ];
    expect(retiredFiles.filter((path) => existsSync(join(srcDir, path)))).toEqual([]);
    const offenders = listTsFiles(srcDir).filter((file) => {
      const source = readFileSync(file, "utf8");
      return importSpecifiers(source).some((specifier) => specifier.includes("pi-agent-core"))
        || /executeManagedToolLoop|executeManagedApiNoToolAdapter|executeRuntimeHost/.test(source);
    });
    expect(offenders, `legacy Agent execution paths remain:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("plugin files do not import from server modules", () => {
    const pluginsDir = join(srcDir, "plugins");
    const offenders: string[] = [];
    for (const file of listTsFiles(pluginsDir)) {
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
    for (const file of listTsFiles(officialPluginsDir)) {
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
    for (const file of listTsFiles(srcDir)) {
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
