/**
 * Tests for the catalog module, a server-owned read of on-disk manifests,
 * separate from the system descriptors. Uses a temp-dir catalog fixture;
 * never reads the repo's real catalog so assertions stay stable as built-in
 * definitions evolve.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { systemModule } from "../src/modules/system/index.js";
import { catalogModule } from "../src/modules/catalog/index.js";
import { loadConfig } from "../src/config.js";
import { CATALOG_MANIFEST_MAX_BYTES, catalogSummary, listCapabilities } from "../src/modules/catalog/service.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests } from "../src/modules/auth/identity.js";
import { deniedAuthRepository } from "./support/routeFakes.js";

let fixtureRoot: string;
let app: FastifyInstance;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cp-catalog-"));

  const capDir = join(fixtureRoot, "capabilities", "alpha-cap");
  await mkdir(capDir, { recursive: true });
  await writeFile(
    join(capDir, "capability.yaml"),
    [
      "id: alpha-cap",
      "name: Alpha Capability",
      'version: "0.1.0"',
      "description: >",
      "  Extracts things.",
      "enabled: true",
    ].join("\n"),
  );

  const brokenDir = join(fixtureRoot, "capabilities", "broken-cap");
  await mkdir(brokenDir, { recursive: true });
  await writeFile(join(brokenDir, "capability.yaml"), "{{{ not yaml ::::");

  // Noise that must be skipped: a plain file and a dir without a manifest.
  await writeFile(join(fixtureRoot, "capabilities", "__init__.py"), "");
  await mkdir(join(fixtureRoot, "capabilities", "__pycache__"), { recursive: true });

  const tmplDir = join(fixtureRoot, "agent_roles", "beta_tmpl");
  await mkdir(tmplDir, { recursive: true });
  await writeFile(
    join(tmplDir, "role.yaml"),
    [
      "key: beta_tmpl",
      "name: Beta Role",
      "category: assistant",
      "visibility: system_internal",
      "description: A role.",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  await app?.close();
});

function buildApp(catalogRoot: string): FastifyInstance {
  return buildModuleServer(loadConfig({ SERVER_CATALOG_ROOT: catalogRoot }), [catalogModule, systemModule], {
    logger: false,
  });
}

describe("catalog feature descriptor", () => {
  it("advertises catalog reads through the public features endpoint", async () => {
    app = buildApp(fixtureRoot);
    const res = await app.inject({ method: "GET", url: "/api/v1/server/features" });
    expect((res.json() as { features: string[] }).features).toContain("catalog_read");
  });
});

describe("catalog summary", () => {
  it("requires authentication", async () => {
    __setAuthRepositoryForTests(deniedAuthRepository());
    app = buildApp(fixtureRoot);
    const res = await app.inject({ method: "GET", url: "/api/v1/server/catalog" });
    expect(res.statusCode).toBe(401);
  });

  it("reports availability and entry counts", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildApp(fixtureRoot);
    const res = await app.inject({ method: "GET", url: "/api/v1/server/catalog" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      catalog_available: true,
      capabilities_count: 2,
      agent_roles_count: 1,
    });
  });

  it("degrades to catalog_available=false (HTTP 200) when the root is missing", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildApp(join(fixtureRoot, "does-not-exist"));
    const res = await app.inject({ method: "GET", url: "/api/v1/server/catalog" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      catalog_available: false,
      capabilities_count: 0,
      agent_roles_count: 0,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/server/catalog/capabilities",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ catalog_available: false, items: [] });
  });
});

describe("catalog capabilities listing", () => {
  it("lists manifest summaries sorted by directory, flags parse errors, skips noise", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildApp(fixtureRoot);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/server/catalog/capabilities",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      catalog_available: boolean;
      items: Array<Record<string, unknown>>;
    };
    expect(body.catalog_available).toBe(true);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      id: "alpha-cap",
      name: "Alpha Capability",
      version: "0.1.0",
      description: "Extracts things.",
      enabled: true,
    });
    expect(body.items[1]).toMatchObject({ id: "broken-cap", parse_error: true });
  });
});

describe("catalog agent roles listing", () => {
  it("lists role summaries with declared visibility passed through verbatim", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildApp(fixtureRoot);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/server/catalog/agent-roles",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([
      {
        key: "beta_tmpl",
        name: "Beta Role",
        category: "assistant",
        visibility: "system_internal",
        description: "A role.",
      },
    ]);
  });
});

const manifestDirs: string[] = [];
afterEach(async () => {
  for (const dir of manifestDirs.splice(0)) {
    await chmod(join(dir, "catalog", "capabilities"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function manifestCatalog() {
  const dir = await mkdtemp(join(tmpdir(), "catalog-"));
  manifestDirs.push(dir);
  const root = join(dir, "catalog");
  await mkdir(join(root, "capabilities"), { recursive: true });
  return { dir, root };
}

async function capability(root: string, name: string, body: string) {
  await mkdir(join(root, "capabilities", name), { recursive: true });
  await writeFile(join(root, "capabilities", name, "capability.yaml"), body);
}

describe("catalog manifest reads", () => {
  it("reads regular manifests, skips a symlinked manifest and lists an oversized one as a parse error", async () => {
    const { dir, root } = await manifestCatalog();
    await capability(root, "plain", "id: plain\nname: Plain\n");
    await capability(root, "huge", `id: huge\ndescription: "${"x".repeat(CATALOG_MANIFEST_MAX_BYTES)}"\n`);
    await writeFile(join(dir, "outside.yaml"), "id: outside\nname: Outside\n");
    await mkdir(join(root, "capabilities", "linked"));
    await symlink(join(dir, "outside.yaml"), join(root, "capabilities", "linked", "capability.yaml"));

    const listed = await listCapabilities(root);
    expect(listed.items).toEqual([
      { id: "huge", name: null, version: null, description: null, enabled: null, parse_error: true },
      { id: "plain", name: "Plain", version: null, description: null, enabled: null },
    ]);
    await expect(catalogSummary(root)).resolves.toEqual({ catalog_available: true, capabilities_count: 2, agent_roles_count: 0 });
  });

  it("reports a missing catalog as unavailable but an unreadable one as an error", async () => {
    const { dir, root } = await manifestCatalog();
    await expect(listCapabilities(join(dir, "absent"))).resolves.toEqual({ catalog_available: false, items: [] });
    if (process.getuid?.() === 0) return; // root reads through mode bits
    await chmod(join(root, "capabilities"), 0o000);
    await expect(listCapabilities(root)).rejects.toMatchObject({ code: "EACCES" });
  });
});
