import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireCurrentWebDist, webRoot } from "./support/webDist.js";

// The real record writer the web build runs (apps/web/buildInputs.ts), so the
// writer and this checker are proven to agree on the format.
const { collectBuildInputs, BUILD_INPUTS_FILE } = await import(pathToFileURL(join(webRoot, "buildInputs.ts")).href);

// Every file is dated OLD, so a case that rewrites one with the same date shows
// the check reads bytes, and one that only moves dates shows it ignores them.
const OLD = new Date("2026-01-01T12:00:00Z");
const NEW = new Date("2026-06-01T12:00:00Z");
const GRAPH = [
  "apps/web/src/main.tsx",
  "apps/web/src/i18n/zh-CN.ts",
  "apps/web/index.html",
  "plugins/official/diary/web/src/operationViews.tsx",
  "packages/protocol/dist/index.js",
  "packages/reader-document/dist/index.js",
];
let root: string;

async function put(path: string, content = path, at = OLD): Promise<void> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, at, at);
}

async function build(): Promise<void> {
  const moduleIds = [...GRAPH.map((path) => join(root, path)), `${join(root, "apps/web/src/main.tsx")}?inline`, "\0virtual:pwa-register", join(root, "apps/web/node_modules/react/index.js")];
  const record = collectBuildInputs(root, join(root, "apps/web"), moduleIds);
  await put("apps/web/dist/index.html", "<html>");
  await put(`apps/web/dist/${BUILD_INPUTS_FILE}`, JSON.stringify(record));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-dist-"));
  for (const path of [...GRAPH, "apps/web/vite.config.ts", "apps/web/package.json", "apps/web/public/icons/icon-192.png", "apps/web/node_modules/react/index.js", "plugins/official/diary/server/index.ts", "pnpm-lock.yaml"]) await put(path);
  await build();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("records the module graph outside node_modules plus config, public assets and the lockfile", async () => {
  const { readFile } = await import("node:fs/promises");
  const record = JSON.parse(await readFile(join(root, "apps/web/dist", BUILD_INPUTS_FILE), "utf8"));
  expect(Object.keys(record.files).sort()).toEqual([...GRAPH, "apps/web/package.json", "apps/web/public/icons/icon-192.png", "apps/web/vite.config.ts", "pnpm-lock.yaml"].sort());
  expect(Object.keys(record.dirs)).toEqual(expect.arrayContaining(["plugins/official", "plugins/official/diary", "apps/web/src", "packages/protocol/dist"]));
  expect(Object.keys(record.dirs)).not.toContain("apps/web");
});

it("accepts a current build whatever the dates say, including a package dist rewritten with the same bytes", async () => {
  await expect(requireCurrentWebDist(root)).resolves.toBeUndefined();
  await put("packages/protocol/dist/index.js", "packages/protocol/dist/index.js", NEW);
  await put("apps/web/src/main.tsx", "apps/web/src/main.tsx", NEW);
  await utimes(join(root, "apps/web/dist/index.html"), OLD, OLD);
  await expect(requireCurrentWebDist(root)).resolves.toBeUndefined();
});

it("refuses a missing build, and a build without a record", async () => {
  await rm(join(root, "apps/web/dist", BUILD_INPUTS_FILE));
  await expect(requireCurrentWebDist(root)).rejects.toThrow("apps/web/dist has no build-inputs.json");
  await rm(join(root, "apps/web/dist"), { recursive: true });
  await expect(requireCurrentWebDist(root)).rejects.toThrow("apps/web/dist is missing");
});

it("refuses a build whose source, locale, plugin view, bundled package dist, asset or lockfile changed, even with the old date kept", async () => {
  for (const path of ["apps/web/src/main.tsx", "apps/web/src/i18n/zh-CN.ts", "plugins/official/diary/web/src/operationViews.tsx", "packages/protocol/dist/index.js", "apps/web/public/icons/icon-192.png", "pnpm-lock.yaml", "apps/web/vite.config.ts"]) {
    await put(path, `${path} edited`, OLD);
    await expect(requireCurrentWebDist(root)).rejects.toThrow(`apps/web/dist was built from a different ${path}`);
    await put(path, path, OLD);
    await expect(requireCurrentWebDist(root)).resolves.toBeUndefined();
  }
});

it("refuses a build after a source is removed or a plugin a glob would now find is added, but ignores files the build never read", async () => {
  await put("plugins/official/diary/server/index.ts", "server edited", NEW);
  await put("apps/web/node_modules/react/index.js", "dependency edited", NEW);
  await expect(requireCurrentWebDist(root)).resolves.toBeUndefined();

  await put("plugins/official/ledger/web/src/operationViews.tsx");
  await expect(requireCurrentWebDist(root)).rejects.toThrow("apps/web/dist was built when plugins/official held other entries");
  await rm(join(root, "plugins/official/ledger"), { recursive: true });
  await expect(requireCurrentWebDist(root)).resolves.toBeUndefined();

  await rm(join(root, "apps/web/src/i18n/zh-CN.ts"));
  await expect(requireCurrentWebDist(root)).rejects.toThrow("apps/web/dist was built from apps/web/src/i18n/zh-CN.ts, which is gone");
});
