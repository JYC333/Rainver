import { decodeTruncatedUtf8 } from "@rainver/outbound-guard";
import type { SourcePolicyEnvelope } from "@rainver/protocol";
import { HttpError } from "../../routeUtils/common.js";
import {
  fetchGuarded,
  outboundGuard,
  type GuardedResponse,
  type OutboundGuard,
} from "../outboundUrlSafety.js";
import { effectiveCustomSourceLimits, type CustomSourceRunnerSettings } from "./customSourceRunner.js";

/**
 * Shared by the create-flow test path and the scan worker's live path — both
 * need trusted server code to fetch `endpoint_url` and hand the HTML to the
 * sandboxed handler via `input.json` (the sandbox bootstrap blocks the
 * handler process's own network access unconditionally).
 *
 * Two checks run on every hop, the initial request and each redirect alike:
 * the handler policy envelope's `allowed_network_origins`, and the instance's
 * outbound boundary, which refuses an address inside this instance's own
 * network and then connects to the address it checked. They compose as one
 * guard rather than as a check followed by a fetch, so no caller can reach the
 * network having satisfied only one of them.
 */
export interface CustomSourceFetchCredential {
  header_name: string;
  header_value: string;
}

export interface CustomSourceFetchOptions {
  signal?: AbortSignal;
  credential?: CustomSourceFetchCredential | null;
  /** Hard ceiling on the body; the rest is cancelled rather than buffered. */
  maxDownloadBytes: number;
  /** The outbound boundary; a test supplies one pinned at its fixture server. */
  guard?: OutboundGuard;
}

export async function fetchCustomSourceEndpointHtml(
  endpointUrl: string | null,
  settings: CustomSourceRunnerSettings,
  /** Shared envelope fields — both the Level 3 handler envelope and the Level 2 recipe envelope satisfy this. */
  policyEnvelope: SourcePolicyEnvelope,
  credential: CustomSourceFetchCredential | null = null,
  guard?: OutboundGuard,
): Promise<string> {
  if (!endpointUrl) return "";
  const maxBytes = effectiveCustomSourceLimits(settings, policyEnvelope.limits).max_download_bytes;
  const response = await fetchAllowedOriginResponse(endpointUrl, policyEnvelope.allowed_network_origins, {
    credential,
    maxDownloadBytes: maxBytes,
    ...(guard ? { guard } : {}),
  });
  if (!response.ok) throw new HttpError(502, `Failed to fetch source endpoint (${response.status})`);
  return guardedResponseText(response);
}

/**
 * Shared by every Custom Source code path that ever performs a live fetch —
 * the code-template mode's single pre-fetch (`fetchCustomSourceEndpointHtml`
 * above) and the declarative pipeline interpreter's `fetch_page`/
 * `follow_link`/`download_asset`/`paginate` steps
 * (`customSourcePipelineInterpreter.ts`), plus the Recipe interpreter.
 */
export async function fetchAllowedOriginResponse(
  url: string,
  allowedNetworkOrigins: string[],
  options: CustomSourceFetchOptions,
): Promise<GuardedResponse> {
  return fetchGuarded({
    url,
    ...(options.credential
      ? { credentialHeaders: { [options.credential.header_name]: options.credential.header_value } }
      : {}),
    maxDownloadBytes: options.maxDownloadBytes,
    ...(options.signal ? { signal: options.signal } : {}),
  }, allowedOriginGuard(allowedNetworkOrigins, options.guard ?? outboundGuard));
}

/**
 * The envelope's origin allowlist, expressed as an outbound guard.
 *
 * A guard is consulted once per hop, which is exactly where this check belongs:
 * wrapping it here means a redirect cannot land on an origin the handler was
 * never allowed to reach, and there is no second code path where one of the two
 * checks could be forgotten.
 */
function allowedOriginGuard(allowedNetworkOrigins: string[], inner: OutboundGuard): OutboundGuard {
  return {
    pin: async (url, signal) => {
      assertAllowedOrigin(url.toString(), allowedNetworkOrigins);
      return inner.pin(url, signal);
    },
  };
}

/** The body as text, already cut to the ceiling the fetch was given. */
export function guardedResponseText(response: GuardedResponse): string {
  return decodeTruncatedUtf8(response.bytes);
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
