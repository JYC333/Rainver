import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "../..");
const protocolRoot = join(appRoot, "packages/protocol");
const folderReadRoot = join(appRoot, "packages/folder-read");
const serverRoot = join(appRoot, "server");
const pluginsRoot = join(appRoot, "plugins");
const watchedPaths = [
  join(protocolRoot, "src"),
  join(protocolRoot, "tsconfig.json"),
  join(protocolRoot, "tsconfig.build.json"),
  join(folderReadRoot, "src"),
  join(folderReadRoot, "tsconfig.json"),
  join(folderReadRoot, "tsconfig.build.json"),
  join(serverRoot, "src"),
  join(serverRoot, "tsconfig.json"),
  pluginsRoot,
];
const pollIntervalMs = 750;

let previousFingerprint = "";
let buildRunning = false;
let buildPending = false;
let stopped = false;
let activeChild = null;

async function fingerprintPath(path) {
  const info = await stat(path);
  if (info.isFile()) return `${path}:${info.mtimeMs}:${info.size}`;
  const entries = await readdir(path, { withFileTypes: true });
  const children = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    children.push(await fingerprintPath(join(path, entry.name)));
  }
  return children.join("|");
}

async function fingerprint() {
  return (await Promise.all(watchedPaths.map(fingerprintPath))).join("||");
}

function run(command, args, cwd) {
  return new Promise(resolveBuild => {
    activeChild = spawn(command, args, { cwd, stdio: "inherit" });
    activeChild.once("exit", code => {
      activeChild = null;
      resolveBuild(code ?? 1);
    });
  });
}

async function build() {
  if (buildRunning) {
    buildPending = true;
    return;
  }
  buildRunning = true;
  do {
    buildPending = false;
    console.log("[typescript-watch] compiling folder-read, protocol, server, and official plugins");
    const folderReadCode = await run(
      join(folderReadRoot, "node_modules/.bin/tsc"),
      ["-p", "tsconfig.build.json"],
      folderReadRoot,
    );
    const protocolCode = folderReadCode === 0
      ? await run(
      join(protocolRoot, "node_modules/.bin/tsc"),
      ["-p", "tsconfig.build.json"],
      protocolRoot,
    )
      : folderReadCode;
    const serverCode = protocolCode === 0
      ? await run(join(serverRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], serverRoot)
      : protocolCode;
    const pluginsCode = serverCode === 0
      ? await run(process.execPath, [join(serverRoot, "scripts/build-official-plugins.mjs")], serverRoot)
      : serverCode;
    if (pluginsCode === 0) console.log("[typescript-watch] compilation complete");
    else console.error(`[typescript-watch] compilation failed (exit ${pluginsCode}); continuing to watch`);
  } while (buildPending && !stopped);
  buildRunning = false;
}

async function poll() {
  try {
    const nextFingerprint = await fingerprint();
    if (nextFingerprint === previousFingerprint) return;
    previousFingerprint = nextFingerprint;
    await build();
  } catch (error) {
    console.error(`[typescript-watch] polling failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stop(signal) {
  stopped = true;
  clearInterval(timer);
  activeChild?.kill(signal);
  process.exit(0);
}

previousFingerprint = await fingerprint();
await build();
const timer = setInterval(() => void poll(), pollIntervalMs);
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
