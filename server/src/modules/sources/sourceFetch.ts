import { extname } from "node:path";
import { decodeTruncatedUtf8 } from "@rainver/outbound-guard";
import { HttpError } from "../routeUtils/common.js";
import { fetchGuarded, type OutboundGuard } from "./outboundUrlSafety.js";

export interface SourceFetchResult {
  status: number;
  ok: boolean;
  notModified: boolean;
  headers: Headers;
  contentType: string | null;
  isText: boolean;
  isPdf: boolean;
  text: string | null;
  bytes: Uint8Array | null;
}

export interface SourceFetchOptions {
  /** Sent on every hop, including after a redirect to another origin. */
  headers?: Record<string, string>;
  /**
   * Dropped as soon as a redirect leaves the first origin: a provider API key,
   * a bearer. Separate from `headers` so a credential cannot reach a redirect
   * target because a caller forgot to name it.
   */
  credentialHeaders?: Record<string, string>;
  maxDownloadBytes: number;
  /** Budget for the whole chain — resolution, every hop, and the body. */
  timeoutMs?: number;
  /**
   * The outbound boundary. Production leaves it out and gets the instance's
   * guard; a test supplies one pinned at its own fixture server.
   */
  guard?: OutboundGuard;
}

export async function fetchSource(url: string, options: SourceFetchOptions): Promise<SourceFetchResult> {
  const result = await fetchGuarded({
    url,
    headers: {
      ...options.headers,
      // Source bodies are consumed by the server. Keep the representation
      // uncompressed so an intermediary cannot return a body whose encoding
      // metadata no longer matches what the server reads.
      "accept-encoding": "identity",
    },
    ...(options.credentialHeaders ? { credentialHeaders: options.credentialHeaders } : {}),
    maxDownloadBytes: options.maxDownloadBytes,
    ...(options.timeoutMs ? { deadlineMs: options.timeoutMs } : {}),
  }, options.guard);

  const contentType = normalizeContentType(result.headers.get("content-type"));
  if (result.status === 304 || !result.ok) {
    return {
      status: result.status,
      ok: result.ok,
      notModified: result.status === 304,
      headers: result.headers,
      contentType,
      isText: false,
      isPdf: false,
      text: null,
      bytes: null,
    };
  }
  if (result.truncated) throw maxSizeError(options.maxDownloadBytes);

  const bytes = result.bytes;
  const isPdf = isPdfContent(contentType, result.url, bytes);
  const isText = !isPdf && isTextContent(contentType, result.url);
  return {
    status: result.status,
    ok: result.ok,
    notModified: false,
    headers: result.headers,
    contentType,
    isText,
    isPdf,
    text: isText ? decodeTruncatedUtf8(bytes) : null,
    bytes: isText ? null : bytes,
  };
}

function normalizeContentType(value: string | null): string | null {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type || null;
}

function isTextContent(contentType: string | null, url: string): boolean {
  if (!contentType) return textUrlExtension(url);
  if (contentType.startsWith("text/")) return true;
  if (contentType === "application/json") return true;
  if (contentType === "application/xml") return true;
  if (contentType === "application/xhtml+xml") return true;
  if (contentType.endsWith("+xml")) return true;
  if (contentType.endsWith("+json")) return true;
  if (contentType === "application/octet-stream") return textUrlExtension(url);
  return false;
}

function isPdfContent(contentType: string | null, url: string, bytes: Uint8Array): boolean {
  if (contentType === "application/pdf") return true;
  if (hasPdfMagic(bytes)) return true;
  if (!contentType || contentType === "application/octet-stream") return pdfUrlExtension(url);
  return false;
}

function pdfUrlExtension(value: string): boolean {
  return urlExtension(value) === ".pdf";
}

function textUrlExtension(value: string): boolean {
  return [".atom", ".htm", ".html", ".json", ".rss", ".txt", ".xhtml", ".xml"].includes(urlExtension(value));
}

function urlExtension(value: string): string {
  try {
    return extname(new URL(value).pathname).toLowerCase();
  } catch {
    return extname(value.split("?")[0] ?? "").toLowerCase();
  }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function maxSizeError(maxDownloadBytes: number): HttpError {
  return new HttpError(413, `Downloaded source exceeds max size (${formatBytes(maxDownloadBytes)})`);
}
