import type { SourcePolicyEnvelope } from "@rainver/protocol";
import { HttpError } from "../../routeUtils/common.js";
import { effectiveCustomSourceLimits, type CustomSourceRunnerSettings } from "./customSourceRunner.js";

/**
 * Shared by the create-flow test path and the scan worker's live path — both
 * need trusted server code to fetch `endpoint_url` and hand the HTML to the
 * sandboxed handler via `input.json` (the sandbox bootstrap blocks the
 * handler process's own network access unconditionally). Mirrors the
 * existing built-in connector fetch in extractionWorker.ts, with one
 * Custom-Source-specific addition: the trusted fetch enforces the handler
 * policy envelope's `allowed_network_origins` before every request and
 * before following a redirect, because the handler process itself has no
 * network access.
 */
export interface CustomSourceFetchCredential {
  header_name: string;
  header_value: string;
}

export async function fetchCustomSourceEndpointHtml(
  endpointUrl: string | null,
  settings: CustomSourceRunnerSettings,
  /** Shared envelope fields — both the Level 3 handler envelope and the Level 2 recipe envelope satisfy this. */
  policyEnvelope: SourcePolicyEnvelope,
  credential: CustomSourceFetchCredential | null = null,
): Promise<string> {
  if (!endpointUrl) return "";
  const response = await fetchAllowedOriginResponse(endpointUrl, policyEnvelope.allowed_network_origins, { credential });
  if (!response.ok) throw new HttpError(502, `Failed to fetch source endpoint (${response.status})`);
  const text = await response.text();
  const maxBytes = effectiveCustomSourceLimits(settings, policyEnvelope.limits).max_download_bytes;
  return truncateToByteLimit(text, maxBytes);
}

/**
 * Shared by every Custom Source code path that ever performs a live fetch —
 * the code-template mode's single pre-fetch (`fetchCustomSourceEndpointHtml`
 * above) and the declarative pipeline interpreter's `fetch_page`/
 * `follow_link`/`download_asset`/`paginate` steps
 * (`customSourcePipelineInterpreter.ts`). Enforces the handler policy
 * envelope's `allowed_network_origins` before every request and before
 * following each redirect, so no caller can accidentally skip that check by
 * re-implementing its own fetch.
 */
export async function fetchAllowedOriginResponse(
  url: string,
  allowedNetworkOrigins: string[],
  options: { signal?: AbortSignal; credential?: CustomSourceFetchCredential | null } = {},
): Promise<Response> {
  let currentUrl = url;
  const headers = options.credential ? { [options.credential.header_name]: options.credential.header_value } : undefined;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    assertAllowedOrigin(currentUrl, allowedNetworkOrigins);
    const response = await fetch(currentUrl, { redirect: "manual", signal: options.signal, headers });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new HttpError(502, "Failed to fetch source endpoint (too many redirects)");
}

export function assertAllowedOrigin(url: string, allowedNetworkOrigins: string[]): void {
  let origin: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
    origin = parsed.origin;
  } catch {
    throw new HttpError(422, "endpoint_url must be a valid HTTP(S) URL");
  }

  const allowed = new Set(
    allowedNetworkOrigins.flatMap((candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? [parsed.origin] : [];
      } catch {
        return [];
      }
    }),
  );
  if (!allowed.has(origin)) {
    throw new HttpError(403, `Source endpoint origin is not allowed by the handler policy envelope: ${origin}`);
  }
}

/** Truncates by UTF-8 byte length, not UTF-16 code units — `.slice(0, maxBytes)` on a JS string would truncate at the wrong point for any multi-byte content and could leave the result larger than `maxBytes` once re-encoded. */
export function truncateToByteLimit(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return trimIncompleteUtf8Tail(buf.subarray(0, maxBytes)).toString("utf8");
}

function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  const len = buf.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const byte = buf[len - back]!;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    let sequenceLength = 1;
    if ((byte & 0b1110_0000) === 0b1100_0000) sequenceLength = 2;
    else if ((byte & 0b1111_0000) === 0b1110_0000) sequenceLength = 3;
    else if ((byte & 0b1111_1000) === 0b1111_0000) sequenceLength = 4;
    return sequenceLength > back ? buf.subarray(0, len - back) : buf;
  }
  return buf;
}
