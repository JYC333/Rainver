import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../../..");
export const webRoot = join(repoRoot, "apps/web");

const REBUILD = "build the web app and the packages it imports (pnpm --filter @rainver/protocol --filter @rainver/reader-document build && pnpm --filter @rainver/web build)";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * A browser case that serves `apps/web/dist` through `vite preview` tests
 * whatever was built last, not the checkout. A missing build answers every
 * route with nothing to wait for, and one built from other sources renders a
 * different UI. Either surfaces as a locator timeout far from its cause, or as
 * a pass against stale code. This refuses both before a browser starts; it
 * never builds.
 *
 * The build records what it read by content (`dist/build-inputs.json`, written
 * by apps/web/buildInputs.ts): each file in its module graph, including the
 * protocol and reader-document `dist` it bundled, plus config, public assets
 * and the lockfile, and the entry names of the directories above them. A build
 * is current only when every recorded file still has the same bytes and every
 * recorded directory the same entries. Modification times are never compared,
 * so neither a `tsc` rebuild with identical output nor a copy that keeps old
 * times changes the answer.
 */
export async function requireCurrentWebDist(root = repoRoot): Promise<void> {
  const dist = join(root, "apps/web/dist");
  const index = await readFile(join(dist, "index.html")).catch(() => null);
  if (index === null) throw new Error(`apps/web/dist is missing: ${REBUILD} before this browser case.`);
  const raw = await readFile(join(dist, "build-inputs.json"), "utf8").catch(() => null);
  if (raw === null) throw new Error(`apps/web/dist has no build-inputs.json, so what it was built from is unknown: ${REBUILD} before this browser case.`);
  const record = JSON.parse(raw) as { version?: unknown; files?: Record<string, string>; dirs?: Record<string, string> };
  if (record.version !== 1 || !record.files || !record.dirs || Object.keys(record.files).length === 0) {
    throw new Error(`apps/web/dist/build-inputs.json is not a version 1 record: ${REBUILD} before this browser case.`);
  }
  for (const [path, hash] of Object.entries(record.files)) {
    const bytes = await readFile(join(root, path)).catch(() => null);
    if (bytes === null) throw new Error(`apps/web/dist was built from ${path}, which is gone: ${REBUILD} before this browser case.`);
    if (sha256(bytes) !== hash) throw new Error(`apps/web/dist was built from a different ${path}: ${REBUILD} before this browser case.`);
  }
  for (const [path, hash] of Object.entries(record.dirs)) {
    const names = await readdir(join(root, path)).catch(() => null);
    if (names === null || sha256(names.sort().join("\n")) !== hash) {
      throw new Error(`apps/web/dist was built when ${path} held other entries: ${REBUILD} before this browser case.`);
    }
  }
}
