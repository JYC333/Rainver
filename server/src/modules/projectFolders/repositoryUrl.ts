import { HttpError } from "../routeUtils/common.js";

/**
 * Transports a member-supplied clone source may use. git also accepts a local
 * path or `file://`, which would copy a repository from the server's own disk
 * into the Space, so only network transports are allowed.
 */
export const CLONE_PROTOCOLS = ["https", "http", "ssh", "git"] as const;

/** git's own allow-list for the clone, so a redirect or nested fetch cannot switch transport. */
export const CLONE_GIT_ALLOW_PROTOCOL = CLONE_PROTOCOLS.join(":");

/** scp-like ssh syntax, `user@host:path`, which git reads as ssh when no slash precedes the colon. */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;

export function assertRemoteRepositoryUrl(repoUrl: string): void {
  if (SCP_LIKE.test(repoUrl)) return;
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new HttpError(422, "repo_url must be a remote repository URL");
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (!(CLONE_PROTOCOLS as readonly string[]).includes(scheme) || !parsed.hostname) {
    throw new HttpError(422, "repo_url must be a remote repository URL");
  }
}
