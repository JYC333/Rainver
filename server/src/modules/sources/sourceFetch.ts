import { extname } from "node:path";
import { TextDecoder } from "node:util";
import { HttpError } from "../routeUtils/common.js";

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

export async function fetchSource(
  url: string,
  options: {
    headers?: Record<string, string>;
    maxDownloadBytes: number;
    /** Abort the request after this many ms; the fetch rejects with a TimeoutError. */
    timeoutMs?: number;
  },
): Promise<SourceFetchResult> {
  const init: Parameters<typeof fetch>[1] = { redirect: "follow" };
  if (options.timeoutMs) init.signal = AbortSignal.timeout(options.timeoutMs);
  const headers = new Headers(options.headers);
  // Source bodies are consumed by the server. Keep the representation
  // uncompressed so an intermediary cannot return a body whose encoding
  // metadata no longer matches what the server reads.
  headers.set("accept-encoding", "identity");
  init.headers = headers;
  const response = await fetch(url, init);
  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (response.status === 304 || !response.ok) {
    return {
      status: response.status,
      ok: response.ok,
      notModified: response.status === 304,
      headers: response.headers,
      contentType,
      isText: false,
      isPdf: false,
      text: null,
      bytes: null,
    };
  }

  const bytes = await readResponseBytes(response, options.maxDownloadBytes);
  const isPdf = isPdfContent(contentType, url, bytes);
  const isText = !isPdf && isTextContent(contentType, url);
  return {
    status: response.status,
    ok: response.ok,
    notModified: false,
    headers: response.headers,
    contentType,
    isText,
    isPdf,
    text: isText ? decodeUtf8(bytes) : null,
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

async function readResponseBytes(response: Response, maxDownloadBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxDownloadBytes) {
      throw maxSizeError(maxDownloadBytes);
    }
  }
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > maxDownloadBytes) {
      throw maxSizeError(maxDownloadBytes);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxDownloadBytes) {
      await reader.cancel().catch(() => undefined);
      throw maxSizeError(maxDownloadBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
