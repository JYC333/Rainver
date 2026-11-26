export interface ToolRequest { id: string; idempotency_key?: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }
export interface ToolResponse { status: number; text: string; acknowledge?: () => void }
export const TOOL_REQUEST_LIMIT = 4 * 1024 * 1024;
export const TOOL_RESPONSE_LIMIT = 8 * 1024 * 1024;

/**
 * Gmail reads: an on-demand page has a 60-second server deadline, and a digest read one 55-second budget for
 * its model-proof wait, page and release together (`GMAIL_DIGEST_READ_BUDGET_MS`), plus time to release the
 * result.
 */
export function toolRequestTimeoutMs(request: ToolRequest): number {
  const action = decodeURIComponent(request.path);
  return request.method === "POST" && (action === "tools/source.gmail.mail.read" || action === "tools/source.gmail.digest.read")
    ? 65_000 : 30_000;
}

/**
 * `tools` or `tools/<one action segment>`. A dot segment (`.`, `..`, or a
 * percent-encoded `%2e`) or an encoded separator would be normalized by the
 * URL parser into a different Run route still carrying the Run bearer.
 */
function isToolPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const match = /^tools(?:\/([A-Za-z0-9_.%!-]+))?$/.exec(path);
  if (!match) return false;
  const segment = match[1];
  if (segment === undefined) return true;
  if (/%(?:2e|2f|5c)/i.test(segment) || /^\.{1,2}$/.test(segment)) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length <= 256 && !/[/\\\x00-\x1f\x7f]/.test(decoded) && !/^\.{1,2}$/.test(decoded);
  } catch {
    return false;
  }
}

/** The bridge accepts only the existing CLI verbs, never a URL or identity. */
export function parseToolRequest(value: unknown): ToolRequest {
  const v = value as Partial<ToolRequest> | null;
  if (!v || typeof v !== "object" || !/^[a-f0-9-]{36}$/.test(v.id ?? "")
    || (v.idempotency_key !== undefined && (typeof v.idempotency_key !== "string" || !/^[\x21-\x7e]{1,256}$/.test(v.idempotency_key)))
    || !isToolPath(v.path)
    || (v.method !== "GET" && v.method !== "POST")
    || (v.method === "POST" && (v.path === "tools" || !v.body || typeof v.body !== "object" || Array.isArray(v.body)))
    || (v.method === "GET" && v.body !== undefined)) {
    throw new Error("Invalid Rainver tool request");
  }
  return { id: v.id!, ...(v.idempotency_key === undefined ? {} : {idempotency_key:v.idempotency_key}), method: v.method, path: v.path!, ...(v.body ? { body: v.body } : {}) };
}
