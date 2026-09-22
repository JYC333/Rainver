import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createOutboundGuard,
  guardedFetch,
  undiciPinnedFetch,
  type OutboundGuard,
  type PinnedFetch,
} from "@rainver/outbound-guard";

/** Bounds memory and transfer time for a single runtime artifact download. */
export const MAX_RUNTIME_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface RuntimeArtifactDownloadDependencies {
  guard?: OutboundGuard;
  fetch?: PinnedFetch;
}

const outboundGuard = createOutboundGuard();

export async function downloadRuntimeArtifact(
  url: string,
  destination: string,
  sha256: string | null,
  log: (line: string) => void,
  dependencies: RuntimeArtifactDownloadDependencies = {},
): Promise<void> {
  const safeUrl = safeArtifactUrl(url);
  log(`downloading ${safeUrl}`);
  const response = await guardedFetch({
    url,
    requireHttps: true,
    maxDownloadBytes: MAX_RUNTIME_ARTIFACT_BYTES,
  }, {
    guard: dependencies.guard ?? outboundGuard,
    fetch: dependencies.fetch ?? undiciPinnedFetch,
  });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${safeUrl}`);
  if (response.truncated) {
    throw new Error(`Runtime artifact exceeds the ${MAX_RUNTIME_ARTIFACT_BYTES}-byte download limit: ${safeUrl}`);
  }
  if (sha256) {
    const actual = createHash("sha256").update(response.bytes).digest("hex");
    if (actual !== sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch for ${safeUrl}: expected ${sha256}, got ${actual}`);
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, response.bytes, { mode: 0o600 });
}

function safeArtifactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
  } catch {
    return "[invalid URL]";
  }
}
