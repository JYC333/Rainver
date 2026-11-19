import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOfficialPluginPackages } from "../src/modules/plugins/packageLoader.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete (globalThis as Record<string, unknown>).__loaderProbe;
});

function runtime(id: string, operation: boolean): string {
  return `(globalThis.__loaderProbe ??= []).push(${JSON.stringify(id)});
export default { id: ${JSON.stringify(id)}, version: "0.1.0", activate() {}${operation ? ", operationManifest: {}" : ""} };\n`;
}

async function pkg(root: string, id: string, options: { operation?: boolean; main?: string } = {}) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "runtime.mjs"), runtime(id, options.operation ?? false));
  await writeFile(join(dir, "plugin.json"), JSON.stringify({
    id, version: "0.1.0", kind: "official_plugin", server: { main: options.main ?? "runtime.mjs" },
  }));
  return dir;
}

async function artifactRoot() {
  const root = await mkdtemp(join(tmpdir(), "plugin-loader-"));
  dirs.push(root);
  return root;
}

const imported = () => ((globalThis as Record<string, unknown>).__loaderProbe as string[] | undefined) ?? [];

describe("official plugin package loader admission", () => {
  it("imports only descriptor or build-index packages, never one that admits itself", async () => {
    const root = await artifactRoot();
    await pkg(root, "legacy_known");
    await pkg(root, "built_operation", { operation: true });
    await pkg(root, "stray_operation", { operation: true });
    await writeFile(join(root, "packages.json"), JSON.stringify({
      packages: ["built_operation", "legacy_known"], operation_packages: ["built_operation"],
    }));

    const plugins = await loadOfficialPluginPackages(root, {
      allowedPluginIds: ["legacy_known"], includeOperationPlugins: true,
    });

    expect(plugins.map((plugin) => plugin.id)).toEqual(["built_operation", "legacy_known"]);
    expect(imported()).not.toContain("stray_operation");
  });

  it("never imports a build-index package the build did not record as an operation package", async () => {
    const root = await artifactRoot();
    await pkg(root, "legacy_known");
    await pkg(root, "built_legacy");
    await pkg(root, "built_operation", { operation: true });
    await writeFile(join(root, "packages.json"), JSON.stringify({
      packages: ["built_legacy", "built_operation"], operation_packages: ["built_operation", "not_built"],
    }));

    const plugins = await loadOfficialPluginPackages(root, {
      allowedPluginIds: ["legacy_known"], includeOperationPlugins: true,
    });

    expect(plugins.map((plugin) => plugin.id)).toEqual(["built_operation", "legacy_known"]);
    expect(imported().sort()).toEqual(["built_operation", "legacy_known"]);
  });

  it("admits nothing from an older build index that records no categories", async () => {
    const root = await artifactRoot();
    await pkg(root, "legacy_known");
    await pkg(root, "built_operation", { operation: true });
    await writeFile(join(root, "packages.json"), JSON.stringify({ packages: ["built_operation", "legacy_known"] }));

    const plugins = await loadOfficialPluginPackages(root, {
      allowedPluginIds: ["legacy_known"], includeOperationPlugins: true,
    });

    expect(plugins.map((plugin) => plugin.id)).toEqual(["legacy_known"]);
    expect(imported()).toEqual(["legacy_known"]);
  });

  it("admits no operation package without a build index", async () => {
    const root = await artifactRoot();
    await pkg(root, "legacy_known");
    await pkg(root, "stray_operation", { operation: true });

    const plugins = await loadOfficialPluginPackages(root, {
      allowedPluginIds: ["legacy_known"], includeOperationPlugins: true,
    });

    expect(plugins.map((plugin) => plugin.id)).toEqual(["legacy_known"]);
    expect(imported()).toEqual(["legacy_known"]);
  });

  it("refuses a server entry outside its package, directly or through a symlink", async () => {
    const outside = await artifactRoot();
    await writeFile(join(outside, "runtime.mjs"), runtime("escaped", false));

    const relative = await artifactRoot();
    await pkg(relative, "escaped", { main: `../../${outside.split("/").pop()}/runtime.mjs` });
    await expect(loadOfficialPluginPackages(relative, { allowedPluginIds: ["escaped"] }))
      .rejects.toThrow(/escapes its package/);

    const linked = await artifactRoot();
    const dir = await pkg(linked, "escaped", { main: "linked.mjs" });
    await symlink(join(outside, "runtime.mjs"), join(dir, "linked.mjs"));
    await expect(loadOfficialPluginPackages(linked, { allowedPluginIds: ["escaped"] }))
      .rejects.toThrow(/escapes its package/);
    expect(imported()).toEqual([]);
  });

  it("refuses a manifest id that differs from its directory", async () => {
    const root = await artifactRoot();
    const dir = await pkg(root, "known");
    await writeFile(join(dir, "plugin.json"), JSON.stringify({
      id: "other", version: "0.1.0", kind: "official_plugin", server: { main: "runtime.mjs" },
    }));
    await expect(loadOfficialPluginPackages(root, { allowedPluginIds: ["known"] }))
      .rejects.toThrow(/does not match its directory/);
    expect(imported()).toEqual([]);
  });
});
