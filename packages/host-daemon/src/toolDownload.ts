import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostEgressTransport } from "@rainver/protocol";
import { shouldBypassUpstreamProxy } from "./egressProxy.js";
import {
  createOutboundGuard,
  createUndiciProxyFetch,
  guardedFetch,
  undiciPinnedFetch,
  type AddressLookup,
  type OutboundGuard,
  type PinnedFetch,
} from "@rainver/outbound-guard";

/** Bounds memory and transfer time for a single runtime artifact download. */
export const MAX_RUNTIME_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const RUNTIME_ARTIFACT_DOWNLOAD_DEADLINE_MS = 15 * 60_000;
export const RUNTIME_ARTIFACT_BODY_IDLE_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_RETRIES = 6;

export interface RuntimeArtifactDownloadDependencies {
  guard?: OutboundGuard;
  fetch?: PinnedFetch;
  lookup?: AddressLookup;
}

export async function downloadRuntimeArtifact(
  url: string,
  destination: string,
  sha256: string | null,
  log: (line: string) => void,
  dependencies: RuntimeArtifactDownloadDependencies = {},
  transport: HostEgressTransport = { mode: "direct" },
): Promise<void> {
  const safeUrl = safeArtifactUrl(url);
  log(`downloading ${safeUrl}`);
  if (transport.mode !== "direct" && !sha256) {
    throw new Error("A non-direct runtime artifact download requires a pinned SHA-256");
  }
  const useProxy = (hop: URL): boolean => transport.mode === "http_proxy"
    && !shouldBypassUpstreamProxy(hop.hostname, Number(hop.port || "443"), transport.no_proxy);
  const guard = dependencies.guard ?? createOutboundGuard({
    lookup: dependencies.lookup,
    allowSyntheticDnsHostname: (hop) => transport.mode === "system_tun" || useProxy(hop),
  });
  const proxy = transport.mode === "http_proxy" && !dependencies.fetch
    ? createUndiciProxyFetch(transport.proxy_url)
    : null;
  const fetch: PinnedFetch = dependencies.fetch ?? ((hop, init, pinned) =>
    useProxy(new URL(hop))
      ? proxy!.fetch(hop, init, pinned)
      : undiciPinnedFetch(hop, init, pinned));
  try {
    await transferArtifact(url, destination, sha256, safeUrl, log, { guard, fetch });
  } finally {
    await proxy?.close();
  }
}

function safeArtifactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
  } catch {
    return "[invalid URL]";
  }
}

async function transferArtifact(
  url: string,
  destination: string,
  sha256: string | null,
  safeUrl: string,
  log: (line: string) => void,
  dependencies: { guard: OutboundGuard; fetch: PinnedFetch },
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const partialPath = `${destination}.${randomUUID()}.partial`;
  const file = await open(partialPath, "wx", 0o600);
  let fileOpen = true;
  let downloaded = 0;
  let total: number | null = null;
  let validator: string | null = null;
  let hash = createHash("sha256");
  const deadlineAt = Date.now() + RUNTIME_ARTIFACT_DOWNLOAD_DEADLINE_MS;

  try {
    for (let retry = 0; ; retry += 1) {
      // Without a checksum or validator, bytes from separate connections
      // cannot be safely joined. Retry that response from the beginning.
      if (downloaded > 0 && !sha256 && !validator) {
        await file.truncate(0);
        downloaded = 0;
        total = null;
        hash = createHash("sha256");
      }
      const resumeAt = downloaded;
      let responseEnd: number | null = null;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error(`Runtime artifact download deadline exceeded: ${safeUrl}`);

      const requestHeaders: Record<string, string> = { "accept-encoding": "identity" };
      if (resumeAt > 0) requestHeaders.range = `bytes=${resumeAt}-`;
      if (resumeAt > 0 && validator) requestHeaders["if-range"] = validator;
      try {
        const response = await guardedFetch({
          url,
          requireHttps: true,
          headers: requestHeaders,
          maxDownloadBytes: MAX_RUNTIME_ARTIFACT_BYTES,
          deadlineMs: remainingMs,
          bodyIdleTimeoutMs: RUNTIME_ARTIFACT_BODY_IDLE_TIMEOUT_MS,
        }, {
          guard: dependencies.guard,
          fetch: dependencies.fetch,
        }, {
          async onResponse({ status, headers }) {
            const encoding = headers.get("content-encoding");
            if (encoding && encoding !== "identity") {
              throw new Error("Runtime artifact response must use identity encoding");
            }
            const length = declaredLength(headers);
            if (status === 200) {
              // Range was ignored, or If-Range detected a changed artifact.
              if (resumeAt > 0) {
                await file.truncate(0);
                downloaded = 0;
                hash = createHash("sha256");
              }
              total = length;
              validator = responseValidator(headers);
              responseEnd = length;
            } else if (status === 206 && resumeAt > 0) {
              const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get("content-range") ?? "");
              if (!match) throw new Error("Runtime artifact resume response has no valid Content-Range");
              const start = Number(match[1]);
              const end = Number(match[2]);
              const size = Number(match[3]);
              if (![start, end, size].every(Number.isSafeInteger)
                || start !== resumeAt || end < start || end >= size
                || (total !== null && total !== size)
                || (length !== null && length !== end - start + 1)) {
                throw new Error("Runtime artifact resume response has an inconsistent Content-Range");
              }
              const currentValidator = responseValidator(headers);
              if (validator && currentValidator && currentValidator !== validator) {
                throw new Error("Runtime artifact changed during download");
              }
              if (!sha256 && validator && currentValidator !== validator) {
                throw new Error("Runtime artifact resume response lost its validator");
              }
              total = size;
              responseEnd = end + 1;
            } else {
              throw new Error(`Unexpected runtime artifact response: ${status}`);
            }
            if (total !== null && total > MAX_RUNTIME_ARTIFACT_BYTES) {
              throw new Error(`Runtime artifact exceeds the ${MAX_RUNTIME_ARTIFACT_BYTES}-byte download limit: ${safeUrl}`);
            }
          },
          async onChunk(chunk) {
            if (downloaded + chunk.length > MAX_RUNTIME_ARTIFACT_BYTES) {
              throw new Error(`Runtime artifact exceeds the ${MAX_RUNTIME_ARTIFACT_BYTES}-byte download limit: ${safeUrl}`);
            }
            if (responseEnd !== null && downloaded + chunk.length > responseEnd) {
              throw new Error("Runtime artifact response exceeded its declared length");
            }
            await writeChunk(file, chunk, downloaded);
            downloaded += chunk.length;
            hash.update(chunk);
          },
        });
        if (!response.ok) throw new Error(`Download failed: ${response.status} ${safeUrl}`);
        if (response.truncated) {
          throw new Error(`Runtime artifact exceeds the ${MAX_RUNTIME_ARTIFACT_BYTES}-byte download limit: ${safeUrl}`);
        }
        if (responseEnd !== null && downloaded !== responseEnd) throw new IncompleteDownloadError();
        if (total !== null && downloaded < total) throw new IncompleteDownloadError();
        break;
      } catch (error) {
        if (!retryableDownloadError(error) || retry >= MAX_DOWNLOAD_RETRIES || Date.now() >= deadlineAt) {
          throw error;
        }
        log(`download interrupted after ${downloaded} bytes; retrying (${retry + 1}/${MAX_DOWNLOAD_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(200 * 2 ** retry, 5_000)));
      }
    }

    if (sha256) {
      const actual = hash.digest("hex");
      if (actual !== sha256.toLowerCase()) {
        throw new Error(`sha256 mismatch for ${safeUrl}: expected ${sha256}, got ${actual}`);
      }
    }
    await file.truncate(downloaded);
    await file.sync();
    await file.close();
    fileOpen = false;
    await rename(partialPath, destination);
  } finally {
    if (fileOpen) await file.close().catch(() => undefined);
    await rm(partialPath, { force: true });
  }
}

class IncompleteDownloadError extends Error {
  constructor() {
    super("Runtime artifact download ended before all bytes arrived");
  }
}

function retryableDownloadError(error: unknown): boolean {
  return error instanceof IncompleteDownloadError
    || error instanceof TypeError
    || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));
}

function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new Error("Invalid runtime artifact Content-Length");
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw new Error("Invalid runtime artifact Content-Length");
  return length;
}

function responseValidator(headers: Headers): string | null {
  const etag = headers.get("etag");
  return etag?.startsWith('"') && etag.endsWith('"') ? etag : null;
}

async function writeChunk(file: FileHandle, chunk: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, position + offset);
    if (bytesWritten === 0) throw new Error("Runtime artifact file write made no progress");
    offset += bytesWritten;
  }
}
