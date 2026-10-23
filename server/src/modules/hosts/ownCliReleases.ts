import { isOwnCliUpdateRuntimeKey, OWN_CLI_UPDATE_PACKAGES } from "@rainver/protocol";
import { fetchGuarded } from "../sources/outboundUrlSafety.js";

const FRESH_MS = 15 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

/**
 * Vendor CLI releases, independent of the ACP adapter registry.
 *
 * Read stale-while-revalidate: `peek` answers from memory at once and starts
 * at most one background lookup when the answer is missing or old, so a
 * request never waits on npmjs.org. An offline control plane keeps answering
 * the last version it knew (or `null`) instead of adding a network timeout
 * to every page that lists runtimes.
 */
export class OwnCliReleases {
  private readonly cache = new Map<string, { value: string | null; until: number }>();
  private readonly pending = new Map<string, Promise<string | null>>();
  constructor(private readonly fetchMetadata = fetchGuarded) {}

  /** The last known release, never blocking; refreshes in the background when due. */
  peek(runtimeKey: string): string | null {
    if (!isOwnCliUpdateRuntimeKey(runtimeKey)) return null;
    const cached = this.cache.get(runtimeKey);
    if (!cached || cached.until <= Date.now()) void this.refresh(runtimeKey);
    return cached?.value ?? null;
  }

  private refresh(runtimeKey: keyof typeof OWN_CLI_UPDATE_PACKAGES): Promise<string | null> {
    const pending = this.pending.get(runtimeKey);
    if (pending) return pending;
    const packageName = OWN_CLI_UPDATE_PACKAGES[runtimeKey];
    const request = this.fetchMetadata({
      url: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      requireHttps: true, deadlineMs: 3000, maxDownloadBytes: 256 * 1024,
    }).then(response => {
      if (!response.ok || response.truncated) return null;
      const metadata = JSON.parse(new TextDecoder().decode(response.bytes)) as { version?: unknown };
      return typeof metadata.version === "string" && /^\d+\.\d+\.\d+$/.test(metadata.version)
        ? metadata.version : null;
    }).catch(() => null).then(value => {
      // A failed lookup keeps the last good answer and retries a minute later.
      const previous = this.cache.get(runtimeKey)?.value ?? null;
      this.cache.set(runtimeKey, value
        ? { value, until: Date.now() + FRESH_MS }
        : { value: previous, until: Date.now() + RETRY_AFTER_FAILURE_MS });
      this.pending.delete(runtimeKey);
      return value ?? previous;
    });
    this.pending.set(runtimeKey, request);
    return request;
  }
}

export const ownCliReleases = new OwnCliReleases();
