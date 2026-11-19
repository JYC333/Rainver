import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { RainverPlugin } from "@rainver/protocol";

interface OfficialPluginPackageManifest {
  id: string;
  name?: string;
  version: string;
  kind: "official_plugin";
  server: {
    main: string;
  };
  web?: {
    entry?: string;
  };
  migrations?: {
    dir?: string;
  };
}

interface LoadOfficialPluginPackagesOptions {
  /** Descriptor-registry ids; with it, only admitted directories are imported. */
  allowedPluginIds?: readonly string[];
  /** Also admit packages the build's `packages.json` records as operation packages. */
  includeOperationPlugins?:boolean;
}

/**
 * Written by `server/scripts/build-official-plugins.mjs` for packages it
 * compiled from `plugins/official/*`; its `operation_packages` names those it
 * found to be operation packages. An index without that list (an older build)
 * admits nothing on its own: rebuild to load its operation packages.
 */
export const OFFICIAL_PLUGIN_BUILD_INDEX = "packages.json";
const PACKAGE_ID = /^[a-z][a-z0-9_]*$/;

export function defaultOfficialPluginArtifactRoot(): string {
  return resolve(process.env.SERVER_OFFICIAL_PLUGINS_DIR ?? resolve(process.cwd(), "dist", "official-plugins"));
}

export async function loadOfficialPluginPackages(
  root = defaultOfficialPluginArtifactRoot(),
  options: LoadOfficialPluginPackagesOptions = {},
): Promise<readonly RainverPlugin[]> {
  if (!existsSync(root)) {
    throw new Error(
      `Official plugin artifacts not found at ${root}. Run server build:official-plugins first.`,
    );
  }

  const descriptorIds = options.allowedPluginIds ? new Set(options.allowedPluginIds) : null;
  // Admission comes from the descriptor registry and the trusted build index,
  // never from a package's own manifest, and is decided before any import.
  const admitted = descriptorIds
    ? new Set([...descriptorIds, ...(options.includeOperationPlugins ? readBuildIndex(root) : [])])
    : null;

  // Dirent.isDirectory() is false for symlinks, so a linked directory is never a package.
  const packages = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !admitted || admitted.has(name))
    .filter((name) => existsSync(join(root, name, "plugin.json")))
    .sort();

  const plugins: RainverPlugin[] = [];
  for (const name of packages) {
    const packageRoot = resolve(root, name);
    const manifest = parseManifest(packageRoot);
    if (manifest.id !== name) {
      throw new Error(`Official plugin manifest id ${manifest.id} does not match its directory ${name}`);
    }
    const plugin=await loadOfficialPluginPackage(packageRoot, manifest);
    // Defense in depth: the build index already admitted this one as an operation package.
    if(descriptorIds&&!descriptorIds.has(plugin.id)&&!plugin.operationManifest)continue;
    plugins.push(plugin);
  }
  return plugins;
}

function readBuildIndex(root: string): readonly string[] {
  const path = join(root, OFFICIAL_PLUGIN_BUILD_INDEX);
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown; operation_packages?: unknown };
  const ids = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((id) => typeof id === "string" && PACKAGE_ID.test(id));
  if (!ids(value.packages) || (value.operation_packages !== undefined && !ids(value.operation_packages))) {
    throw new Error(`Invalid official plugin build index at ${path}`);
  }
  const built = new Set(value.packages);
  // Only an operation package the build compiled is admitted by the index.
  return (value.operation_packages ?? []).filter((id) => built.has(id));
}

async function loadOfficialPluginPackage(
  packageRoot: string,
  manifest = parseManifest(packageRoot),
): Promise<RainverPlugin> {
  const modulePath = resolve(packageRoot, manifest.server.main);
  if (!existsSync(modulePath)) {
    throw new Error(
      `Official plugin ${manifest.id} server entry not found at ${modulePath}`,
    );
  }
  // The entry must resolve, after symlinks, to a file inside its own package.
  const realRoot = realpathSync(packageRoot);
  if (!realpathSync(modulePath).startsWith(realRoot + sep)) {
    throw new Error(`Official plugin ${manifest.id} server entry escapes its package`);
  }

  const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const plugin = resolvePluginExport(mod, manifest.id);
  if (!plugin) {
    throw new Error(
      `Official plugin ${manifest.id} did not export an RainverPlugin runtime`,
    );
  }
  if (plugin.id !== manifest.id) {
    throw new Error(
      `Official plugin ${manifest.id} runtime id mismatch: ${plugin.id}`,
    );
  }
  if (plugin.version !== manifest.version) {
    throw new Error(
      `Official plugin ${manifest.id} runtime version mismatch: ${plugin.version}`,
    );
  }
  return plugin;
}

function parseManifest(packageRoot: string): OfficialPluginPackageManifest {
  const value = JSON.parse(readFileSync(resolve(packageRoot, "plugin.json"), "utf8")) as Partial<OfficialPluginPackageManifest>;
  if (value.kind !== "official_plugin") {
    throw new Error(`Invalid official plugin manifest kind at ${packageRoot}`);
  }
  if (typeof value.id !== "string" || !PACKAGE_ID.test(value.id) || !value.version || typeof value.server?.main !== "string") {
    throw new Error(`Invalid official plugin manifest at ${packageRoot}`);
  }
  return value as OfficialPluginPackageManifest;
}

function resolvePluginExport(
  mod: Record<string, unknown>,
  pluginId: string,
): RainverPlugin | null {
  const exportName = `${toCamel(pluginId)}Plugin`;
  const candidates = [
    mod["default"],
    mod["plugin"],
    mod[exportName],
  ];
  for (const candidate of candidates) {
    if (isRainverPlugin(candidate)) return candidate;
  }
  return null;
}

function isRainverPlugin(value: unknown): value is RainverPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RainverPlugin).id === "string" &&
    typeof (value as RainverPlugin).version === "string" &&
    typeof (value as RainverPlugin).activate === "function"
  );
}

function toCamel(input: string): string {
  return input.replace(/[_-]([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}
