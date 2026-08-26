import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

export interface LoadOfficialPluginPackagesOptions {
  allowedPluginIds?: readonly string[];
}

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

  const packages = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name))
    .filter((packageRoot) => existsSync(join(packageRoot, "plugin.json")))
    .sort();

  const allowedPluginIds = options.allowedPluginIds
    ? new Set(options.allowedPluginIds)
    : null;

  const plugins: RainverPlugin[] = [];
  for (const packageRoot of packages) {
    const manifest = parseManifest(packageRoot);
    if (allowedPluginIds && !allowedPluginIds.has(manifest.id)) continue;
    plugins.push(await loadOfficialPluginPackage(packageRoot, manifest));
  }
  return plugins;
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
  if (!value.id || !value.version || !value.server?.main) {
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
