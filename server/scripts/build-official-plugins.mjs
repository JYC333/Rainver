import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(serverRoot, "..");
const officialPluginsRoot = resolve(repoRoot, "plugins", "official");
const artifactRoot = resolve(serverRoot, "dist", "official-plugins");
const tscBin = process.platform === "win32"
  ? resolve(serverRoot, "node_modules", ".bin", "tsc.cmd")
  : resolve(serverRoot, "node_modules", ".bin", "tsc");
const watch = process.argv.includes("--watch");
const protocolTypes = resolve(repoRoot, "packages", "protocol", "dist", "index.d.ts");

if (!existsSync(officialPluginsRoot)) {
  process.exit(0);
}

if (!existsSync(protocolTypes)) {
  execFileSync(tscBin, [
    "-p",
    resolve(repoRoot, "packages", "protocol", "tsconfig.build.json"),
  ], { cwd: repoRoot, stdio: "inherit" });
}

const packages = readdirSync(officialPluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(officialPluginsRoot, entry.name))
  .filter((dir) => existsSync(resolve(dir, "plugin.json")))
  .sort();

if (!watch) {
  rmSync(artifactRoot, { recursive: true, force: true });
}
mkdirSync(artifactRoot, { recursive: true });

const children = [];
const builtIds = [];
for (const packageRoot of packages) {
  const manifest = readManifest(packageRoot);
  builtIds.push(manifest.id);
  copyPackageAssets(packageRoot, manifest);
  const tsconfig = resolve(packageRoot, "server", "tsconfig.json");
  if (!existsSync(tsconfig)) {
    throw new Error(`Missing server tsconfig for official plugin ${manifest.id}`);
  }

  // Watch mode also compiles once first, so the index below can record what
  // each compiled package is before the watchers take over.
  execFileSync(tscBin, ["-p", tsconfig], { cwd: repoRoot, stdio: "inherit" });
  if (watch) {
    children.push(spawn(tscBin, ["-p", tsconfig, "--watch", "--preserveWatchOutput"], {
      cwd: repoRoot,
      stdio: "inherit",
    }));
  }
}

// The loader imports only packages this build compiled from in-repo source
// (plus registry descriptors); a package cannot admit itself by its manifest.
// `operation_packages` records, from this trusted build, which compiled
// packages are operation packages, so the server admits an index-only package
// by category before it imports anything.
const operationIds = [];
for (const id of builtIds) {
  if (await isOperationPackage(id)) operationIds.push(id);
}
writeFileSync(resolve(artifactRoot, "packages.json"), `${JSON.stringify({
  packages: builtIds.sort(),
  operation_packages: operationIds.sort(),
}, null, 2)}\n`);

if (watch && children.length > 0) {
  await new Promise((resolveExit, rejectExit) => {
    for (const child of children) {
      child.on("exit", (code) => {
        if (code === 0) resolveExit(undefined);
        else rejectExit(new Error(`official plugin watcher exited with code ${code}`));
      });
      child.on("error", rejectExit);
    }
  });
}

/** Mirrors the server loader's export resolution for the package this build just compiled. */
async function isOperationPackage(id) {
  const manifest = JSON.parse(readFileSync(resolve(artifactRoot, id, "plugin.json"), "utf8"));
  const mod = await import(pathToFileURL(resolve(artifactRoot, id, manifest.server.main)).href);
  const exportName = `${id.replace(/[_-]([a-z0-9])/g, (_, ch) => ch.toUpperCase())}Plugin`;
  const plugin = [mod.default, mod.plugin, mod[exportName]].find((candidate) =>
    candidate && typeof candidate === "object" && typeof candidate.id === "string"
    && typeof candidate.version === "string" && typeof candidate.activate === "function");
  return Boolean(plugin?.operationManifest);
}

function readManifest(packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "plugin.json"), "utf8"));
  if (!manifest || typeof manifest.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(manifest.id)) {
    throw new Error(`Invalid official plugin manifest at ${packageRoot}`);
  }
  if (!manifest.server || typeof manifest.server.main !== "string") {
    throw new Error(`Official plugin ${manifest.id} must declare server.main`);
  }
  if (manifest.web?.entry !== undefined && typeof manifest.web.entry !== "string") {
    throw new Error(`Official plugin ${manifest.id} web.entry must be a string`);
  }
  if (manifest.web?.entry && !existsSync(resolve(packageRoot, manifest.web.entry))) {
    throw new Error(`Official plugin ${manifest.id} web entry not found: ${manifest.web.entry}`);
  }
  return manifest;
}

function copyPackageAssets(packageRoot, manifest) {
  const target = resolve(artifactRoot, manifest.id);
  mkdirSync(target, { recursive: true });
  cpSync(resolve(packageRoot, "plugin.json"), resolve(target, "plugin.json"));

  const migrationsDir = resolve(packageRoot, manifest.migrations?.dir ?? "migrations");
  if (existsSync(migrationsDir)) {
    cpSync(migrationsDir, resolve(target, "migrations"), { recursive: true });
  }

  const webDir = resolve(packageRoot, "web");
  if (existsSync(webDir)) {
    cpSync(webDir, resolve(target, "web"), { recursive: true });
  }
}
