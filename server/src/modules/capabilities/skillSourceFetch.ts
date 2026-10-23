import { HttpError } from "../routeUtils/common.js";
import { fetchGuarded, outboundGuard } from "../sources/outboundUrlSafety.js";

const SOURCE_HOSTS = new Set(["raw.githubusercontent.com", "api.github.com"]);

/** GitHub metadata describes the repository tree, not only the selected package. */
const MAX_SKILL_METADATA_BYTES = 8 * 1024 * 1024;

/**
 * Keep GitHub's host allowlist on every hop while reusing the shared address,
 * redirect, deadline and streaming body limits. A final-URL check is too late:
 * the redirect target would already have received the request.
 */
export async function fetchSkillSource(
  url: string,
  maxBytes: number,
  tooLargeMessage: string,
  headers?: Record<string, string>,
) {
  const sourceHost = new URL(url).hostname;
  if (!SOURCE_HOSTS.has(sourceHost)) throw new HttpError(422, "unsupported_skill_source");
  const response = await fetchGuarded(
    { url, requireHttps: true, maxDownloadBytes: maxBytes, headers },
    {
      async pin(target, signal) {
        if (target.protocol !== "https:" || target.hostname !== sourceHost) {
          throw new HttpError(422, "unsupported_skill_source");
        }
        return outboundGuard.pin(target, signal);
      },
    },
  );
  if (response.truncated) throw new HttpError(413, tooLargeMessage);
  return response;
}

export async function fetchSkillMetadata(url: string) {
  return fetchSkillSource(url, MAX_SKILL_METADATA_BYTES, "Skill repository metadata is too large", {
    accept: "application/vnd.github+json",
    "user-agent": "rainver-skill-import",
  });
}
