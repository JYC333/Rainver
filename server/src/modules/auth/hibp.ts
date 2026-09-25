import { createHash } from "node:crypto";
import { fetchGuarded, type OutboundGuard } from "../sources/outboundUrlSafety.js";

const HIBP_ORIGIN = "https://api.pwnedpasswords.com";
const HIBP_RANGE_MAX_BYTES = 1_048_576;

export interface HibpRangeTransport {
  fetchRange(prefix: string): Promise<string>;
}
function sha1Hex(value: string): string {
  return createHash("sha1").update(value).digest("hex").toUpperCase();
}

function parseRangeBody(body: string, suffix: string): boolean {
  const expected = `${suffix.toUpperCase()}:`;
  for (const line of body.split(/\r?\n/)) {
    if (!line.toUpperCase().startsWith(expected)) continue;
    const countText = line.slice(expected.length);
    const count = Number(countText);
    if (!Number.isSafeInteger(count) || count < 0 || String(count) !== countText) {
      throw new Error("invalid_hibp_count");
    }
    return count > 0;
  }
  return false;
}

/** Checks the HIBP range API without ever sending the full password hash. */
export async function isPasswordCompromised(
  password: string,
  transport: HibpRangeTransport,
): Promise<boolean> {
  const digest = sha1Hex(password);
  return parseRangeBody(await transport.fetchRange(digest.slice(0, 5)), digest.slice(5));
}

/** The fixed HIBP endpoint still goes through Rainver's canonical egress guard. */
export function guardedHibpRangeTransport(guard?: OutboundGuard): HibpRangeTransport {
  return {
    async fetchRange(prefix: string): Promise<string> {
      if (!/^[0-9A-F]{5}$/i.test(prefix)) throw new Error("invalid_hibp_prefix");
      const response = await fetchGuarded({
        url: `${HIBP_ORIGIN}/range/${prefix.toUpperCase()}`,
        requireHttps: true,
        headers: {
          "add-padding": "true",
          "user-agent": "Rainver Password Checker",
        },
        maxDownloadBytes: HIBP_RANGE_MAX_BYTES,
      }, guard);
      if (!response.ok) throw new Error("hibp_unavailable");
      return new TextDecoder().decode(response.bytes);
    },
  };
}
