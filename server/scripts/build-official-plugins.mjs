import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(serverRoot, "..");
const officialPluginsRoot = resolve(repoRoot, "plugins", "official");
const artifactRoot = resolve(serverRoot, "dist", "official-plugins");
const tscBin = process.platform === "win32"
  ? resolve(serverRoot, "node_modules", ".bin", "tsc.cmd")
  : resolve(serverRoot, "node_modules", ".bin", "tsc");
const watch = process.argv.includes("--watch");
const ifStale = process.argv.includes("--if-stale");
const protocolDist = resolve(repoRoot, "packages", "protocol", "dist");
const protocolTypes = join(protocolDist, "index.d.ts");
const buildStamp = join(artifactRoot, ".build-inputs.json");

if (!existsSync(officialPluginsRoot)) {
  process.exit(0);
}

// The supported Linux build and test environments share the same output.
// Resolve cache validity under the kernel lock as well as publishing under it.
if (!watch && process.platform === "linux" && !process.argv.includes("--build-lock-held")) {
  mkdirSync(dirname(artifactRoot), { recursive: true });
  const child = spawnSync("flock", [
    "--exclusive", join(dirname(artifactRoot), ".official-plugins-build.lock"),
    process.execPath, fileURLToPath(import.meta.url), "--build-lock-held", ...process.argv.slice(2),
  ], { cwd: process.cwd(), stdio: "inherit" });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

if (!existsSync(protocolTypes)) {
  execFileSync(tscBin, [
    "-p",
    resolve(repoRoot, "packages", "protocol", "tsconfig.build.json"),
  ], { cwd: repoRoot, stdio: "inherit" });
}

function addTree(hash, directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".build-inputs.json" || entry.name === ".tsbuildinfo") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) addTree(hash, path);
    else if (entry.isFile()) addFile(hash, path);
  }
}

function addFile(hash, path) {
  const contents = readFileSync(path);
  hash.update(JSON.stringify([relative(repoRoot, path), contents.length]));
  hash.update(contents);
}

const inputHash = createHash("sha256");
addTree(inputHash, officialPluginsRoot);
addTree(inputHash, protocolDist);
addFile(inputHash, fileURLToPath(import.meta.url));
addFile(inputHash, join(repoRoot, "pnpm-lock.yaml"));
const inputs = inputHash.digest("hex");

function buildIdentity() {
  const hash = createHash("sha256");
  addTree(hash, artifactRoot);
  return JSON.stringify({ inputs, outputs: hash.digest("hex") });
}

if (ifStale && existsSync(buildStamp) && readFileSync(buildStamp, "utf8") === buildIdentity()) {
  process.exit(0);
}

const packages = readdirSync(officialPluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(officialPluginsRoot, entry.name))
  .filter((dir) => existsSync(resolve(dir, "plugin.json")))
  .sort();

mkdirSync(dirname(artifactRoot), { recursive: true });
const buildRoot = watch ? artifactRoot : mkdtempSync(join(dirname(artifactRoot), ".official-plugins-stage-"));
if (!watch) process.on("exit", () => rmSync(buildRoot, { recursive: true, force: true }));
else mkdirSync(buildRoot, { recursive: true });

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
  execFileSync(tscBin, ["-p", tsconfig, "--outDir", join(buildRoot, manifest.id)], { cwd: repoRoot, stdio: "inherit" });
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
writeFileSync(resolve(buildRoot, "packages.json"), `${JSON.stringify({
  packages: builtIds.sort(),
  operation_packages: operationIds.sort(),
}, null, 2)}\n`);
if (!watch) {
  const alreadyPublished = existsSync(artifactRoot);
  // mkdtemp creates a private stage. The published tree must be readable by
  // the unprivileged runtime user when Docker copies it from the root build.
  chmodSync(alreadyPublished ? artifactRoot : buildRoot, 0o755);
  if (!alreadyPublished) {
    renameSync(buildRoot, artifactRoot);
  } else {
    // Keep readers' existing paths present while publishing the fully
    // compiled staging tree. Publish the registration index last.
    publishTree(buildRoot, artifactRoot);
    renameSync(join(buildRoot, "packages.json"), join(artifactRoot, "packages.json"));
  }
  writeFileSync(buildStamp, buildIdentity());
}

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
  const manifest = JSON.parse(readFileSync(resolve(buildRoot, id, "plugin.json"), "utf8"));
  const mod = await import(pathToFileURL(resolve(buildRoot, id, manifest.server.main)).href);
  const exportName = `${id.replace(/[_-]([a-z0-9])/g, (_, ch) => ch.toUpperCase())}Plugin`;
  const plugin = [mod.default, mod.plugin, mod[exportName]].find((candidate) =>
    candidate && typeof candidate === "object" && typeof candidate.id === "string"
    && typeof candidate.version === "string" && typeof candidate.activate === "function");
  if (!plugin) throw new Error(`Official plugin ${id} did not export an RainverPlugin runtime`);
  if (plugin.id !== id) throw new Error(`Official plugin ${id} runtime id mismatch: ${plugin.id}`);
  if (plugin.version !== manifest.version) {
    throw new Error(`Official plugin ${id} runtime version mismatch: ${plugin.version}`);
  }
  return Boolean(plugin.operationManifest);
}

function readManifest(packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "plugin.json"), "utf8"));
  if (manifest?.kind !== "official_plugin" || typeof manifest.id !== "string"
    || !/^[a-z][a-z0-9_]*$/.test(manifest.id) || typeof manifest.version !== "string" || !manifest.version) {
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
  const target = resolve(buildRoot, manifest.id);
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

function publishTree(source, target, packageRoot = true) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (packageRoot && entry.name === "packages.json") continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) publishTree(from, to, false);
    else renameSync(from, to);
  }
}
