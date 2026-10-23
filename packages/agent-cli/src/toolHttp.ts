import { connectionError } from "./connectionError.ts";

export interface ToolIdentity { apiUrl: string; runId: string; token: string }
export interface ToolRequest { id: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }
export interface ToolResponse { status: number; text: string }
export const TOOL_REQUEST_LIMIT = 4 * 1024 * 1024;
export const TOOL_RESPONSE_LIMIT = 8 * 1024 * 1024;

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
    return !/[/\\]/.test(decoded) && !/^\.{1,2}$/.test(decoded);
  } catch {
    return false;
  }
}

/** The bridge accepts only the existing CLI verbs, never a URL or identity. */
export function parseToolRequest(value: unknown): ToolRequest {
  const v = value as Partial<ToolRequest> | null;
  if (!v || typeof v !== "object" || !/^[a-f0-9-]{36}$/.test(v.id ?? "")
    || !isToolPath(v.path)
    || (v.method !== "GET" && v.method !== "POST")
    || (v.method === "POST" && (v.path === "tools" || !v.body || typeof v.body !== "object" || Array.isArray(v.body)))
    || (v.method === "GET" && v.body !== undefined)) {
    throw new Error("Invalid Rainver tool request");
  }
  return { id: v.id!, method: v.method, path: v.path!, ...(v.body ? { body: v.body } : {}) };
}

/** Shared by direct CLI calls and the Host; authorization remains server-owned. */
export async function toolHttpRequest(identity: ToolIdentity, input: ToolRequest, signal?: AbortSignal): Promise<ToolResponse> {
  const request = parseToolRequest(input);
  const url = `${identity.apiUrl.replace(/\/+$/, "")}/api/v1/runs/${encodeURIComponent(identity.runId)}/${request.path}`;
  try {
    const response = await fetch(url, {
      method: request.method,
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      headers: {
        authorization: `Bearer ${identity.token}`,
        ...(request.body === undefined ? {} : { "content-type": "application/json", "idempotency-key": request.id }),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > TOOL_RESPONSE_LIMIT) throw new Error("Rainver tool response is too large");
        chunks.push(chunk);
      }
    }
    return { status: response.status, text: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    throw new Error(`Could not reach Rainver: ${connectionError(error)}`);
  }
}
